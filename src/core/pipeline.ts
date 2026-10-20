/**
 * 每日推荐流水线：auth → signals → history → candidates → enrich → score。
 *
 * 设计要点（与实施计划一致）：
 * - 不在后台写长驻循环：后台每分钟调用一次 `tick()`，每次最多约 20 秒；
 * - 全部进度持久化在 Repository 的 PipelineState 里，Service Worker 被回收也能续跑；
 * - 未登录（nav.loggedIn = false）自动进入公开模式，只抓公开来源（跳过 signals）；
 * - 已登录时 signals 阶段读取收藏/关注/稍后再看（只读），并入画像；
 * - 单个来源失败（常见为风控 -352/-412）只降级跳过，并把说明写进 RunMeta.degraded；
 * - 请求总数受 REQUEST_BUDGET 约束，超预算后使用已有候选继续出结果；
 * - score 结束后补生成「上一个完整自然周」的周报（幂等）。
 */
import { HISTORY_MAX_PAGES, REQUEST_BUDGET } from '../shared/constants';
import { dateKey, DAY, todayAtHour } from '../shared/time';
import type {
  AccountInfo,
  BackupData,
  DashboardData,
  DailyResult,
  HistoryRecord,
  GrowthInfo,
  ImportSummary,
  PipelineStage,
  PipelineState,
  RunStatus,
  Settings,
  WeeklyReport,
  WeeklyReportMeta,
} from '../shared/types';
import { BiliApiError } from './api/http';
import type { PipelineController, PipelineDeps } from './pipeline-contract';
import {
  buildCandidatePlan,
  mergeCandidates,
  finalizeCandidates,
  runCandidateTask,
  type CandidateTask,
} from './sources/candidates';
import { ENRICH_CONFIG, enrichCandidate } from './sources/enrich';
import { dedupeHistory, fetchHistoryChunk } from './sources/history';
import { collectSignals } from './sources/signals';
import { buildProfile } from './profile/build';
import { buildDailyResult } from './recommend/daily';
import { computeGrowth, writeSnapshots } from './recommend/growth';
import { collectSectionBvids } from './recommend/sections';
import { maybeGenerateWeeklyReport } from './report/weekly';

/** 单次 tick 的时间预算（硬上限约 20 秒，留 2 秒余量处理持久化等） */
export const TICK_BUDGET_MS = 18_000;

/** 失败后自动重试的冷却时间，避免每分钟反复打风控接口 */
export const ERROR_RETRY_BACKOFF_MS = 30 * 60 * 1000;

const KV_REQUESTS_BASE = 'engine:requestsBase';
const KV_DEGRADED = 'engine:degraded';
const KV_WEEKLY_ISSUES = 'engine:weeklyIssues';
const KV_LAST_RUN = 'engine:lastRunAt';
const KV_SHOWN = 'engine:shown';
/** 最近一次成功登录过的账号（登录失效提示用） */
const KV_ACCOUNT_LAST = 'account:last';

/** 导入备份时需要清理的业务 KV，避免沿用导入前的「最近更新/降级/已展示」状态 */
const BUSINESS_KV_KEYS = [
  KV_REQUESTS_BASE,
  KV_DEGRADED,
  KV_WEEKLY_ISSUES,
  KV_LAST_RUN,
  KV_SHOWN,
] as const;

/** 每周必看期号缓存有效期 */
const WEEKLY_ISSUES_TTL_MS = 7 * DAY;

/** 最近一次成功登录的账号行 */
interface AccountLastRow {
  mid?: number;
  uname?: string;
  face?: string;
  /** 检测时间（毫秒） */
  at: number;
}

/** 来源任务的中文名（降级文案用） */
const TASK_LABELS: Record<CandidateTask['kind'], string> = {
  popular: '热门',
  ranking: '全站排行榜',
  regionRanking: '分区排行榜',
  weeklyList: '每周必看列表',
  weekly: '每周必看',
  rcmd: '个性化推荐',
  related: '相关推荐',
};

interface WeeklyIssuesRow {
  at: number;
  issues: number[];
}

/** date(YYYY-MM-DD) -> 当天已展示过的 bvid */
type ShownMap = Record<string, string[]>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 风控类错误：冷却后重试，当前运行降级 */
export function isRiskControlError(error: unknown): boolean {
  if (error instanceof BiliApiError) {
    return [-352, -412, -403, 412, 429, -509].includes(error.code);
  }
  if (error instanceof Error) {
    return /风控|412|429|-352|请求过于频繁/.test(error.message);
  }
  return false;
}

function emptyPipelineState(runId: string, t: number, force: boolean): PipelineState {
  return {
    runId,
    startedAt: t,
    updatedAt: t,
    stage: 'auth',
    dueAt: t,
    force,
    mode: 'public',
    signals: null,
    historyPages: 0,
    historyCursor: null,
    history: [],
    candidates: [],
    sourceIndex: 0,
    enrichIndex: 0,
    requests: 0,
  };
}

export function createPipeline(deps: PipelineDeps): PipelineController {
  /** 逻辑时间（测试可注入），用于日期、年龄、状态时间戳 */
  const now = (): number => deps.now?.() ?? Date.now();
  /** 真实时间，只用于 tick 的 20 秒预算 */
  const wallNow = (): number => Date.now();
  const log = (message: string, extra?: unknown): void => deps.logger?.(message, extra);
  let inflight: Promise<RunStatus> | null = null;

  /* ---------------- 请求计数与降级说明 ---------------- */

  const requestsBase = async (): Promise<number> => {
    const value = await deps.repo.getKv<number>(KV_REQUESTS_BASE);
    return typeof value === 'number' ? value : deps.http.requests;
  };

  const requestsUsed = async (): Promise<number> =>
    Math.max(0, deps.http.requests - (await requestsBase()));

  const requestBudgetLeft = async (): Promise<number> => REQUEST_BUDGET - (await requestsUsed());

  const readDegraded = async (): Promise<string[]> =>
    (await deps.repo.getKv<string[]>(KV_DEGRADED)) ?? [];

  const addDegraded = async (message: string): Promise<void> => {
    const text = (message ?? '').trim();
    if (!text) return;
    const list = await readDegraded();
    if (list.includes(text)) return;
    list.push(text);
    await deps.repo.setKv(KV_DEGRADED, list.slice(-8));
  };

  /* ---------------- 账号状态 ---------------- */

  const loadLastAccount = async (): Promise<AccountLastRow | undefined> =>
    deps.repo.getKv<AccountLastRow>(KV_ACCOUNT_LAST);

  const saveLastAccount = async (mid?: number, uname?: string, face?: string): Promise<void> => {
    if (!mid) return;
    const row: AccountLastRow = { mid, uname, face, at: now() };
    await deps.repo.setKv(KV_ACCOUNT_LAST, row);
  };

  /* ---------------- 每周必看期号缓存 ---------------- */

  const loadWeeklyIssues = async (): Promise<number[]> => {
    const row = await deps.repo.getKv<WeeklyIssuesRow>(KV_WEEKLY_ISSUES);
    if (!row) return [];
    if (now() - row.at > WEEKLY_ISSUES_TTL_MS) return [];
    return Array.isArray(row.issues) ? row.issues : [];
  };

  /* ---------------- 已展示记录（换一批排除用） ---------------- */

  const loadShownMap = async (): Promise<ShownMap> =>
    (await deps.repo.getKv<ShownMap>(KV_SHOWN)) ?? {};

  const shownBvidsOf = async (t: number): Promise<string[]> =>
    (await loadShownMap())[dateKey(t)] ?? [];

  const addShown = async (t: number, bvids: string[]): Promise<void> => {
    if (bvids.length === 0) return;
    const map = await loadShownMap();
    const today = dateKey(t);
    const merged = new Set([...(map[today] ?? []), ...bvids]);
    map[today] = [...merged];
    // 只保留最近 7 天，避免无限增长
    const cutoff = dateKey(t - 7 * DAY);
    for (const key of Object.keys(map)) {
      if (key < cutoff) delete map[key];
    }
    await deps.repo.setKv(KV_SHOWN, map);
  };

  /* ---------------- 状态与日程 ---------------- */

  const createState = async (force: boolean): Promise<PipelineState> => {
    const t = now();
    await deps.repo.setKv(KV_REQUESTS_BASE, deps.http.requests);
    await deps.repo.setKv(KV_DEGRADED, []);
    const dueAt = force ? t : ((await nextDueAtOf()) ?? t);
    const state = emptyPipelineState(`${dateKey(t)}-${t}`, t, force);
    state.dueAt = dueAt;
    await deps.repo.savePipeline(state);
    return state;
  };

  const latestDaily = async (): Promise<DailyResult | undefined> => deps.repo.getLatestDaily();

  /** 下一个计划运行时间（毫秒，始终是未来时刻）；autoUpdate 关闭时返回 undefined */
  const nextDueAtOf = async (): Promise<number | undefined> => {
    const settings = await deps.settings.get();
    if (!settings.autoUpdate) return undefined;
    const t = now();
    const todayAt = todayAtHour(settings.updateHour, t);
    return t < todayAt ? todayAt : todayAtHour(settings.updateHour, t + DAY);
  };

  const shouldStartRun = async (previous: PipelineState | undefined): Promise<boolean> => {
    const settings = await deps.settings.get();
    if (!settings.autoUpdate) return false;
    if (previous?.stage === 'error' && wallNow() - previous.updatedAt < ERROR_RETRY_BACKOFF_MS) {
      return false;
    }
    const latest = await latestDaily();
    const t = now();
    if (!latest) return true;
    if (latest.date === dateKey(t)) return false;
    return t >= todayAtHour(settings.updateHour, t);
  };

  /* ---------------- 各阶段 ---------------- */

  const save = async (state: PipelineState): Promise<PipelineState> => {
    state.updatedAt = now();
    state.requests = deps.http.requests;
    await deps.repo.savePipeline(state);
    return state;
  };

  /** 历史采集可用的历史记录：本 run 抓到优先，否则回退到本地缓存 */
  const effectiveHistory = async (state: PipelineState): Promise<HistoryRecord[]> => {
    if (state.historyPages > 0) return state.history;
    return deps.repo.getHistory();
  };

  const stageAuth = async (state: PipelineState): Promise<PipelineState> => {
    try {
      const nav = await deps.api.nav(true);
      state.mode = nav.loggedIn ? 'full' : 'public';
      state.mid = nav.mid;
      state.uname = nav.uname;
      if (nav.loggedIn && nav.mid) {
        // 落一份「最近成功登录的账号」，用于登录失效时的提示
        await saveLastAccount(nav.mid, nav.uname, nav.face);
      }
    } catch (error) {
      state.mode = 'public';
      await addDegraded(`登录态获取失败，已使用公开模式（${errorMessage(error)}）`);
    }
    state.stage = 'signals';
    return save(state);
  };

  /** signals 阶段：已登录时读取收藏/关注/稍后再看；公开模式跳过 */
  const stageSignals = async (state: PipelineState): Promise<PipelineState> => {
    state.signals = null;
    if (state.mode === 'public' || !state.mid) {
      state.stage = 'history';
      return save(state);
    }
    if ((await requestBudgetLeft()) <= 0) {
      await addDegraded('请求预算用尽，只读兴趣信号跳过');
      state.stage = 'history';
      return save(state);
    }
    try {
      const outcome = await collectSignals({
        api: deps.api,
        mid: state.mid,
        nowMs: now(),
        repo: deps.repo,
        logger: log,
      });
      state.signals = outcome.signals;
      if (outcome.degraded) await addDegraded(outcome.degraded);
      if (outcome.unauthorized) {
        // -101：登录已失效，本次按公开模式继续（不阻塞主流程）
        state.mode = 'public';
        state.signals = null;
        log('[signals] 登录态失效，本次使用公开模式');
      }
    } catch (error) {
      await addDegraded(`只读兴趣信号获取失败，已跳过（${errorMessage(error)}）`);
      state.signals = null;
    }
    state.stage = 'history';
    return save(state);
  };

  const stageHistory = async (
    state: PipelineState,
    deadline: number,
  ): Promise<PipelineState> => {
    if (state.mode === 'public') {
      state.stage = 'candidates';
      return save(state);
    }
    while (state.historyPages < HISTORY_MAX_PAGES) {
      if (wallNow() >= deadline) return state;
      if ((await requestBudgetLeft()) <= 0) {
        await addDegraded('请求预算用尽，历史记录提前结束');
        break;
      }
      try {
        const chunk = await fetchHistoryChunk({
          api: deps.api,
          page: state.historyPages,
          cursor: state.historyCursor,
          nowMs: now(),
        });
        state.history = dedupeHistory([...state.history, ...chunk.records]);
        state.historyPages += 1;
        state.historyCursor = chunk.nextCursor;
        await save(state);
        if (chunk.done) break;
      } catch (error) {
        await addDegraded(
          isRiskControlError(error)
            ? '历史记录接口触发风控，使用已采集部分'
            : `历史记录获取失败，使用已采集部分（${errorMessage(error)}）`,
        );
        state.historyCursor = null;
        break;
      }
    }
    await deps.repo.replaceHistory(state.history);
    if (state.mode === 'full') {
      // 提前生成画像：候选阶段要用 Top3 分区榜（含只读信号）
      const profile = buildProfile({
        history: state.history,
        nowMs: now(),
        mid: state.mid,
        uname: state.uname,
        signals: state.signals ?? null,
      });
      await deps.repo.saveProfile(profile);
    }
    state.stage = 'candidates';
    return save(state);
  };

  const stageCandidates = async (
    state: PipelineState,
    deadline: number,
  ): Promise<PipelineState> => {
    const settings = await deps.settings.get();
    const history = await effectiveHistory(state);
    const profile =
      state.mode === 'full'
        ? buildProfile({
            history,
            nowMs: now(),
            mid: state.mid,
            uname: state.uname,
            signals: state.signals ?? null,
          })
        : null;

    // 逐任务抓取，直到跑完或时间/预算用尽；进度（sourceIndex）已持久化，可续跑
    for (;;) {
      if (wallNow() >= deadline) return state;
      const weeklyIssues = await loadWeeklyIssues();
      const plan = buildCandidatePlan({
        settings,
        profile,
        history,
        nowMs: now(),
        mode: state.mode,
        weeklyIssues,
      });
      if (state.sourceIndex >= plan.length) break;
      if ((await requestBudgetLeft()) <= 0) {
        await addDegraded('请求预算用尽，候选源提前结束');
        break;
      }
      const task = plan[state.sourceIndex]!;
      try {
        const result = await runCandidateTask(deps.api, task);
        if (result.weeklyIssues && result.weeklyIssues.length > 0) {
          await deps.repo.setKv<WeeklyIssuesRow>(KV_WEEKLY_ISSUES, {
            at: now(),
            issues: result.weeklyIssues,
          });
        }
        if (result.candidates.length > 0) {
          state.candidates = mergeCandidates([...state.candidates, ...result.candidates]);
        }
      } catch (error) {
        await addDegraded(
          isRiskControlError(error)
            ? `${TASK_LABELS[task.kind]}触发风控，已跳过`
            : `${TASK_LABELS[task.kind]}获取失败（${errorMessage(error)}）`,
        );
      }
      state.sourceIndex += 1;
      await save(state);
    }

    // 全部来源尝试完毕：合并来源 + 标题/UP 去重 + 过滤已看/超龄
    const [watchedRows, dismissedRows] = await Promise.all([
      deps.repo.getHistory(),
      deps.repo.getDismissed(),
    ]);
    state.candidates = finalizeCandidates(state.candidates, {
      nowMs: now(),
      watched: new Set(watchedRows.map((row) => row.bvid)),
      dismissed: new Set(dismissedRows.map((row) => row.bvid)),
    });
    state.stage = 'enrich';
    state.enrichIndex = 0;
    return save(state);
  };

  const stageEnrich = async (
    state: PipelineState,
    deadline: number,
  ): Promise<PipelineState> => {
    while (state.enrichIndex < state.candidates.length) {
      if (wallNow() >= deadline) return state;
      if ((await requestBudgetLeft()) <= 0) {
        await addDegraded('请求预算用尽，视频详情补全提前结束');
        break;
      }
      const index = state.enrichIndex;
      const candidate = state.candidates[index]!;
      try {
        const result = await enrichCandidate(candidate, {
          repo: deps.repo,
          api: deps.api,
          nowMs: now(),
          index,
          maxView: ENRICH_CONFIG.maxView,
          maxTags: ENRICH_CONFIG.maxTags,
        });
        state.candidates[index] = result.candidate;
        if (result.degraded) await addDegraded(result.degraded);
      } catch (error) {
        await addDegraded(`视频详情补全失败，已跳过（${errorMessage(error)}）`);
      }
      state.enrichIndex += 1;
      await save(state);
    }
    state.stage = 'score';
    return save(state);
  };

  /** 最近 7 天每日结果里推荐过的视频 -> 最近推荐时间（不含今天，保证同日重跑稳定） */
  const loadPickedAt = async (t: number): Promise<Map<string, number>> => {
    const picked = new Map<string, number>();
    for (let i = 1; i < 7; i += 1) {
      const day = t - i * DAY;
      const daily = await deps.repo.getDaily(dateKey(day));
      if (!daily) continue;
      for (const bvid of collectSectionBvids(daily.sections)) {
        const prev = picked.get(bvid);
        if (prev === undefined || daily.generatedAt > prev) picked.set(bvid, daily.generatedAt);
      }
    }
    return picked;
  };

  const stageScore = async (state: PipelineState): Promise<PipelineState> => {
    try {
      const t = now();
      const settings = await deps.settings.get();
      const history = await effectiveHistory(state);
      const profile =
        state.mode === 'full'
          ? buildProfile({
              history,
              nowMs: t,
              mid: state.mid,
              uname: state.uname,
              tagWindow: settings.tagWindow,
              signals: state.signals ?? null,
            })
          : null;
      if (profile) await deps.repo.saveProfile(profile);

      // 增长数据：先用本轮的候选 stat 写快照，再计算（不额外发请求）
      await writeSnapshots(deps.repo, state.candidates, t);
      const growth: Map<string, GrowthInfo> = await computeGrowth(deps.repo, state.candidates, t);

      const [pickedAt, dismissedRows, previous] = await Promise.all([
        loadPickedAt(t),
        deps.repo.getDismissed(),
        deps.repo.getDaily(dateKey(t)),
      ]);
      const extraExcluded: string[] = [];
      if (state.force) {
        // 换一批：排除当天已展示过的视频（含旧版本 daily 里的）
        extraExcluded.push(...(await shownBvidsOf(t)));
        if (previous) extraExcluded.push(...collectSectionBvids(previous.sections));
      }

      const degradedList = await readDegraded();
      const { daily, bvids } = buildDailyResult({
        candidates: state.candidates,
        growth,
        settings,
        profile,
        nowMs: t,
        mode: state.mode,
        mid: state.mid,
        dismissed: dismissedRows.map((row) => row.bvid),
        extraExcluded,
        pickedAt,
        meta: {
          requests: await requestsUsed(),
          durationMs: t - state.startedAt,
          candidates: state.candidates.length,
          degraded: degradedList.length > 0 ? degradedList.join('；') : undefined,
        },
      });

      if (daily.sections.length === 0 && previous) {
        // 候选为空（多为风控/断网）时不覆盖上次的好结果
        await addDegraded('本次没有可用候选，已保留上一次结果');
        await deps.repo.setKv(KV_LAST_RUN, t);
        await deps.repo.prune(t);
      } else {
        await deps.repo.saveDaily(daily);
        await addShown(t, bvids);
        await deps.repo.setKv(KV_LAST_RUN, t);
        await deps.repo.prune(t);
      }

      // 周报：每日更新后补生成「上一个完整自然周」（已存在/无历史则跳过，失败只降级）。
      // 只在完整模式生成：公开模式没有账号历史，避免用旧缓存数据产出个人周报。
      if (state.mode === 'full') {
        try {
          const weekly = await maybeGenerateWeeklyReport({ repo: deps.repo, history, nowMs: t });
          if (weekly.report) {
            log('[weekly] 已生成周报', {
              weekKey: weekly.report.weekKey,
              watched: weekly.report.stats.watched,
            });
          }
        } catch (error) {
          await addDegraded(`周报生成失败（${errorMessage(error)}）`);
        }
      }

      state.requests = deps.http.requests;
      state.stage = 'done';
      state.updatedAt = now();
      await deps.repo.savePipeline(state);
      await deps.repo.clearPipeline();
      log('[pipeline] 完成', {
        runId: state.runId,
        candidates: state.candidates.length,
        sections: daily.sections.length,
        requests: state.requests,
      });
    } catch (error) {
      state.stage = 'error';
      state.error = errorMessage(error);
      state.updatedAt = now();
      await deps.repo.savePipeline(state);
      log('[pipeline] 失败', { runId: state.runId, error: state.error });
    }
    return state;
  };

  /** 推进一小段：不停留在同一阶段空转 */
  const advance = async (initial: PipelineState, deadline: number): Promise<PipelineState> => {
    let state = initial;
    for (let guard = 0; guard < 64; guard += 1) {
      const before: PipelineStage = state.stage;
      switch (state.stage) {
        case 'auth':
          state = await stageAuth(state);
          break;
        case 'signals':
          state = await stageSignals(state);
          break;
        case 'history':
          state = await stageHistory(state, deadline);
          break;
        case 'candidates':
          state = await stageCandidates(state, deadline);
          break;
        case 'enrich':
          state = await stageEnrich(state, deadline);
          break;
        case 'score':
          state = await stageScore(state);
          break;
        default:
          return state;
      }
      // 阶段没有推进（通常是时间预算用完）就交给下个 tick
      if (state.stage === before) break;
    }
    return state;
  };

  /* ---------------- 状态查询 ---------------- */

  const estimatePlanLength = (state: PipelineState, settings: Settings): number => {
    const enabled = settings.enabledSources;
    let count = 0;
    if (enabled.popular) count += 2;
    if (enabled.ranking) count += 1;
    if (enabled.regionRanking) count += 3;
    if (enabled.weekly) count += 3;
    if (state.mode === 'full' && enabled.rcmd) count += 3;
    if (state.mode === 'full' && enabled.related) count += 5;
    return Math.max(1, count);
  };

  const progressOf = (state: PipelineState, settings: Settings): number => {
    const order: PipelineStage[] = ['auth', 'signals', 'history', 'candidates', 'enrich', 'score'];
    const index = order.indexOf(state.stage);
    if (index < 0) return state.stage === 'done' ? 1 : 0;
    const stageBase = index / order.length;
    let fraction = 0;
    if (state.stage === 'history') {
      fraction = Math.min(0.95, state.historyPages / 3);
    } else if (state.stage === 'candidates') {
      fraction = Math.min(0.95, state.sourceIndex / estimatePlanLength(state, settings));
    } else if (state.stage === 'enrich') {
      fraction =
        state.candidates.length > 0
          ? Math.min(0.95, state.enrichIndex / state.candidates.length)
          : 0;
    } else if (state.stage === 'score') {
      fraction = 0.4;
    }
    return Math.min(1, Math.max(0, stageBase + fraction / order.length));
  };

  const buildStatus = async (): Promise<RunStatus> => {
    const settings = await deps.settings.get();
    const [state, latest, lastRunAtKv] = await Promise.all([
      deps.repo.getPipeline(),
      latestDaily(),
      deps.repo.getKv<number>(KV_LAST_RUN),
    ]);
    const stage: PipelineStage | 'idle' =
      state && state.stage !== 'done' && state.stage !== 'error'
        ? state.stage
        : state?.stage === 'error'
          ? 'error'
          : 'idle';
    const running = stage !== 'idle' && stage !== 'error';
    const lastRunAt = lastRunAtKv ?? latest?.generatedAt;
    const status: RunStatus = {
      running,
      stage,
      progress: running ? progressOf(state!, settings) : 0,
      startedAt: state?.startedAt,
      lastRunAt,
      lastError: state?.stage === 'error' ? state.error : undefined,
      requestCount: running ? await requestsUsed() : undefined,
      nextDueAt: await nextDueAtOf(),
      loggedOut: state ? state.mode === 'public' : latest?.mode === 'public',
    };
    return status;
  };

  /* ---------------- tick ---------------- */

  const doTick = async (): Promise<RunStatus> => {
    let state = await deps.repo.getPipeline();
    if (!state || state.stage === 'done' || state.stage === 'error') {
      if (!(await shouldStartRun(state))) return buildStatus();
      // 上一轮完成/失败：重新开始一轮（error 时不能复用旧状态，否则 advance 无法推进）
      state = await createState(state?.force ?? false);
    }
    const deadline = wallNow() + TICK_BUDGET_MS;
    try {
      await advance(state, deadline);
    } catch (error) {
      state.stage = 'error';
      state.error = errorMessage(error);
      state.updatedAt = now();
      await deps.repo.savePipeline(state);
      log('[pipeline] tick 异常', { error: state.error });
    }
    return buildStatus();
  };

  /* ---------------- 账号 / 周报 / 备份 ---------------- */

  /** 账号状态：nav 失败不抛错，返回 loggedIn:false + error + 最近成功登录信息 */
  const resolveAccount = async (force: boolean): Promise<AccountInfo> => {
    const checkedAt = now();
    const lastRow = await loadLastAccount();
    const last = lastRow
      ? { mid: lastRow.mid, uname: lastRow.uname, face: lastRow.face, at: lastRow.at }
      : undefined;
    try {
      const nav = await deps.api.nav(force);
      if (nav.loggedIn) {
        await saveLastAccount(nav.mid, nav.uname, nav.face);
        return {
          loggedIn: true,
          mid: nav.mid,
          uname: nav.uname,
          face: nav.face,
          checkedAt,
        };
      }
      return { loggedIn: false, checkedAt, ...(last ? { last } : {}) };
    } catch (error) {
      return {
        loggedIn: false,
        checkedAt,
        error: errorMessage(error),
        ...(last ? { last } : {}),
      };
    }
  };

  /** 导出全部本地数据（设置 + 历史/快照/每日/画像/拉黑/周报） */
  const exportAllData = async (): Promise<BackupData> => {
    const [settings, history, snapshots, daily, profile, dismissed, weeklyMetas] =
      await Promise.all([
        deps.settings.get(),
        deps.repo.getHistory(),
        deps.repo.getAllSnapshots(),
        deps.repo.getAllDaily(),
        deps.repo.getProfile(),
        deps.repo.getDismissed(),
        deps.repo.listWeeklyReports(),
      ]);
    const weeklyReports: WeeklyReport[] = [];
    for (const meta of weeklyMetas) {
      const report = await deps.repo.getWeeklyReport(meta.weekKey);
      if (report) weeklyReports.push(report);
    }
    return { settings, history, snapshots, daily, profile, dismissed, weeklyReports };
  };

  /** 导入备份：整体替换业务数据 + 设置，不触发运行 */
  const importAllData = async (data: BackupData): Promise<ImportSummary> => {
    await deps.repo.replaceAllData(data);
    // 旧运行状态/降级/已展示集合来自导入前，必须清理，避免「最近更新」显示旧时间
    for (const key of BUSINESS_KV_KEYS) await deps.repo.deleteKv(key);
    await deps.settings.set(data.settings);
    await deps.repo.clearPipeline();
    return {
      history: data.history.length,
      snapshots: data.snapshots.length,
      daily: data.daily.length,
      dismissed: data.dismissed.length,
      weekly: data.weeklyReports?.length ?? 0,
      hasProfile: Boolean(data.profile),
      dropped: 0,
    };
  };

  /* ---------------- 对外接口 ---------------- */

  return {
    async getStatus(): Promise<RunStatus> {
      return buildStatus();
    },

    async getDashboardData(): Promise<DashboardData> {
      const [daily, storedProfile, dismissed, settings, account] = await Promise.all([
        latestDaily(),
        deps.repo.getProfile(),
        deps.repo.getDismissed(),
        deps.settings.get(),
        resolveAccount(false),
      ]);
      const status = await buildStatus();
      return {
        daily: daily ?? null,
        // 公开模式不展示历史画像（未登录时「我的标签」不可用）
        profile: status.loggedOut ? null : storedProfile,
        status,
        settings,
        dismissed: dismissed.map((row) => row.bvid),
        account,
      };
    },

    async getDaily(): Promise<DailyResult | null> {
      return (await latestDaily()) ?? null;
    },

    async getAccount(force = false): Promise<AccountInfo> {
      return resolveAccount(force);
    },

    async getWeeklyReport(
      weekKey?: string,
    ): Promise<{ report: WeeklyReport | null; reports: WeeklyReportMeta[] }> {
      const reports = await deps.repo.listWeeklyReports();
      const targetKey =
        typeof weekKey === 'string' && weekKey.trim().length > 0
          ? weekKey.trim()
          : reports[0]?.weekKey;
      const report = targetKey ? (await deps.repo.getWeeklyReport(targetKey)) ?? null : null;
      return { report, reports };
    },

    async exportData(): Promise<BackupData> {
      return exportAllData();
    },

    async importData(data: BackupData): Promise<ImportSummary> {
      return importAllData(data);
    },

    async tick(): Promise<RunStatus> {
      if (inflight) return inflight;
      inflight = doTick().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async runNow(options?: { force?: boolean }): Promise<RunStatus> {
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* 上一轮失败不影响手动触发 */
        }
      }
      const state = await createState(Boolean(options?.force));
      const deadline = wallNow() + TICK_BUDGET_MS;
      try {
        await advance(state, deadline);
      } catch (error) {
        state.stage = 'error';
        state.error = errorMessage(error);
        state.updatedAt = now();
        await deps.repo.savePipeline(state);
      }
      return buildStatus();
    },

    async dismiss(bvid: string): Promise<void> {
      const target = (bvid ?? '').trim();
      if (!target) return;
      await deps.repo.addDismissed(target);
    },

    async clearData(): Promise<void> {
      await deps.repo.clearAll();
      await deps.settings.reset();
      // 清空后暂停自动更新，避免后台 tick 立刻重新采集历史；用户可在设置里重新开启
      await deps.settings.set({ autoUpdate: false });
    },
  };
}
