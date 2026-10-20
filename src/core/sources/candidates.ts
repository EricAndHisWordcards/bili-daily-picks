/**
 * 候选池：从六个来源汇总视频，统一映射成 Candidate，合并来源、去重、过滤。
 *
 * 来源（按抓取顺序，顺序决定分片流水线的 sourceIndex 语义）：
 * 1. 热门 2 页；2. 全站排行榜；3. 用户 Top3 一级分区榜；4. 每周必看最近 2 期；
 * 5. 个性化推荐 3 页；6. 相关推荐（最近 5 条高质量历史）。
 *
 * 公开模式（未登录）只抓 1–4 里的公开来源（不含个性化推荐与相关推荐）。
 * 抓取本身由流水线按任务分片执行，这里只提供「任务计划」与「纯映射/合并/过滤」逻辑。
 */
import {
  PARENT_REGIONS,
  SOURCE_LABELS,
  rankingBonus,
} from '../../shared/constants';
import type {
  Candidate,
  HistoryRecord,
  Profile,
  Settings,
  SourceKind,
  SourceRef,
  VideoStat,
} from '../../shared/types';
import type {
  PopularData,
  RankingData,
  RawVideo,
  RcmdData,
  RcmdItem,
  RelatedData,
  WeeklyListData,
  WeeklyOneData,
} from '../api/endpoints';
import { ageDays, DAY } from '../../shared/time';
import { normalizeStat } from '../../shared/stat';
import { UNKNOWN_REGION, isSectionRegion, resolveCandidateRegion, regionRidOf } from './region';
import { pickHighQualityHistory } from '../profile/weights';

/** 候选源接口（BiliApi 结构兼容，测试里可注入桩） */
export interface CandidateSourcesPort {
  popular(pn?: number, ps?: number): Promise<PopularData>;
  ranking(rid?: number): Promise<RankingData>;
  weeklyList(): Promise<WeeklyListData>;
  weeklyOne(number: number): Promise<WeeklyOneData>;
  rcmd(freshIdx?: number, ps?: number): Promise<RcmdData>;
  related(bvid: string): Promise<RelatedData>;
}

/** 默认参数 */
export const CANDIDATE_CONFIG = {
  popularPages: 2,
  popularPageSize: 50,
  regionRankingCount: 3,
  weeklyIssueCount: 2,
  rcmdPages: 3,
  rcmdPageSize: 6,
  relatedCount: 5,
  /** 一般来源的发布时间上限（天） */
  maxAgeDays: 60,
  /** 每周必看来源放宽到的发布时间上限（天） */
  weeklyMaxAgeDays: 365,
  /** 分区排行榜默认兜底分区（未登录/无画像时） */
  fallbackRegionNames: ['动画', '音乐', '游戏'],
} as const;

/** 过滤掉的视频类型（直播/番剧/课程/OGV 等长视频业务） */
const EXCLUDED_TNAMES: ReadonlySet<string> = new Set([
  '番剧',
  '国创',
  '课程',
  '直播',
  '电影',
  '电视剧',
  '电影相关',
  '动态漫',
]);

/** 原始视频里契约未声明、但过滤需要的字段 */
type RawVideoExtra = RawVideo & {
  is_ogv?: boolean;
  season_type?: number;
};/** 流水线分片任务：一次 tick 执行若干个 */
export type CandidateTask =
  | { kind: 'popular'; page: number }
  | { kind: 'ranking'; rid: number }
  | { kind: 'regionRanking'; rid: number; regionName: string }
  | { kind: 'weeklyList' }
  | { kind: 'weekly'; issue: number }
  | { kind: 'rcmd'; page: number }
  | { kind: 'related'; bvid: string };

export interface CandidatePlanInput {
  settings: Settings;
  /** 用户画像，用于选 Top3 分区榜；公开模式传 null */
  profile: Profile | null;
  history: HistoryRecord[];
  nowMs: number;
  mode: 'full' | 'public';
  /** 已从 weeklyList 接口拿到的期号（缓存），没有则只计划 weeklyList 任务 */
  weeklyIssues?: number[];
}

export interface CandidateTaskResult {
  candidates: Candidate[];
  /** weeklyList 任务会带回最新期号 */
  weeklyIssues?: number[];
}

/* ------------------------------------------------------------------ */
/* 任务计划                                                            */
/* ------------------------------------------------------------------ */

/** 从画像（或兜底列表）取 Top3 一级分区名 */
export function pickTopRegionNames(
  profile: Profile | null,
  count = CANDIDATE_CONFIG.regionRankingCount,
): string[] {
  const names: string[] = [];
  for (const row of profile?.regions ?? []) {
    if (!isSectionRegion(row.name)) continue;
    if (names.includes(row.name)) continue;
    names.push(row.name);
    if (names.length >= count) break;
  }
  for (const fallback of CANDIDATE_CONFIG.fallbackRegionNames) {
    if (names.length >= count) break;
    if (!names.includes(fallback)) names.push(fallback);
  }
  return names.slice(0, count);
}

/**
 * 生成候选抓取任务列表（纯函数，可重复调用且结果稳定）。
 *
 * 注意：`weeklyIssues` 未知时只生成 `weeklyList` 任务；流水线发现期号后会重新计划，
 * 重新计划只会在 weeklyList 之后插入 weekly 任务，因此已推进的 sourceIndex 仍然有效。
 */
export function buildCandidatePlan(input: CandidatePlanInput): CandidateTask[] {
  const { settings, mode } = input;
  const enabled = settings.enabledSources;
  const tasks: CandidateTask[] = [];

  if (enabled.popular) {
    for (let page = 1; page <= CANDIDATE_CONFIG.popularPages; page += 1) {
      tasks.push({ kind: 'popular', page });
    }
  }
  if (enabled.ranking) {
    tasks.push({ kind: 'ranking', rid: 0 });
  }
  if (enabled.regionRanking) {
    for (const name of pickTopRegionNames(input.profile)) {
      const rid = regionRidOf(name);
      if (rid === undefined) continue;
      tasks.push({ kind: 'regionRanking', rid, regionName: name });
    }
  }
  if (enabled.weekly) {
    tasks.push({ kind: 'weeklyList' });
    for (const issue of (input.weeklyIssues ?? []).slice(0, CANDIDATE_CONFIG.weeklyIssueCount)) {
      tasks.push({ kind: 'weekly', issue });
    }
  }
  if (mode === 'full' && enabled.rcmd) {
    for (let page = 1; page <= CANDIDATE_CONFIG.rcmdPages; page += 1) {
      tasks.push({ kind: 'rcmd', page });
    }
  }
  if (mode === 'full' && enabled.related) {
    for (const record of pickHighQualityHistory(
      input.history,
      input.nowMs,
      CANDIDATE_CONFIG.relatedCount,
    )) {
      tasks.push({ kind: 'related', bvid: record.bvid });
    }
  }
  return tasks;
}

/* ------------------------------------------------------------------ */
/* 映射                                                                */
/* ------------------------------------------------------------------ */

function isExcludedVideo(video: RawVideoExtra): boolean {
  const tname = (video.tname ?? '').trim();
  if (EXCLUDED_TNAMES.has(tname)) return true;
  if (video.is_ogv === true) return true;
  // 注意：season_type 在相关推荐等接口里对普通 UGC 也会给非 0 值（实测 fixture 中
  // 「短片」「日常」等 UGC 带 season_type=1），不能作为 OGV 判据，只认 is_ogv 与分区名。
  return false;
}

/** 原始视频 -> Candidate；类型不符（直播/番剧/OGV）或缺少 bvid 时返回 null */
export function candidateFromRawVideo(video: RawVideo, source: SourceRef): Candidate | null {
  if (!video) return null;
  const bvid = (video.bvid ?? '').trim();
  if (!bvid) return null;
  if (isExcludedVideo(video as RawVideoExtra)) return null;

  const tname = (video.tname ?? '').trim();
  const owner = video.owner ?? { mid: 0, name: '' };
  return {
    bvid,
    aid: typeof video.aid === 'number' ? video.aid : undefined,
    cid: typeof video.cid === 'number' ? video.cid : undefined,
    title: (video.title ?? '').trim(),
    cover: video.pic ?? '',
    duration: Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration)) : 0,
    pubdate: Number.isFinite(video.pubdate) ? Math.max(0, Math.round(video.pubdate)) : 0,
    tid: typeof video.tid === 'number' ? video.tid : undefined,
    tname,
    parentRegion: resolveCandidateRegion({
      tname,
      rid: source.rid,
      regionName: source.regionName,
    }),
    owner: {
      mid: typeof owner.mid === 'number' ? owner.mid : 0,
      name: owner.name ?? '',
      face: owner.face,
    },
    stat: normalizeStat(video.stat),
    sources: [source],
    rcmdReason: video.rcmd_reason ?? null,
  };
}

/** 个性化推荐条目 -> Candidate；非稿件（直播/番剧等 goto !== 'av'）返回 null */
export function candidateFromRcmd(item: RcmdItem, source: SourceRef): Candidate | null {
  if (!item) return null;
  if (item.goto !== 'av') return null;
  const bvid = (item.bvid ?? '').trim();
  if (!bvid) return null;
  return {
    bvid,
    aid: typeof item.id === 'number' ? item.id : undefined,
    cid: typeof item.cid === 'number' ? item.cid : undefined,
    title: (item.title ?? '').trim(),
    cover: item.pic ?? '',
    duration: Number.isFinite(item.duration) ? Math.max(0, Math.round(item.duration)) : 0,
    // 个性化为推荐流，发布时间可能缺失，交给 enrich 补全
    pubdate: Number.isFinite(item.pubdate) ? Math.max(0, Math.round(item.pubdate)) : 0,
    tname: '',
    parentRegion: UNKNOWN_REGION,
    owner: {
      mid: typeof item.owner?.mid === 'number' ? item.owner.mid : 0,
      name: item.owner?.name ?? '',
      face: item.owner?.face,
    },
    stat: normalizeStat({
      view: item.stat?.view,
      like: item.stat?.like,
      danmaku: item.stat?.danmaku,
    }),
    sources: [source],
    rcmdReason: item.rcmd_reason ?? null,
    isFollowed: Boolean(item.is_followed),
  };
}

/** 执行一个候选任务，返回映射后的候选与可能的期号 */
export async function runCandidateTask(
  api: CandidateSourcesPort,
  task: CandidateTask,
): Promise<CandidateTaskResult> {
  switch (task.kind) {
    case 'popular': {
      const data = await api.popular(task.page, CANDIDATE_CONFIG.popularPageSize);
      const source: SourceRef = { kind: 'popular' };
      return { candidates: mapRawList(data?.list, source) };
    }
    case 'ranking': {
      const data = await api.ranking(task.rid);
      return {
        candidates: mapRankedList(data?.list, (rank) => ({ kind: 'ranking', rank })),
      };
    }
    case 'regionRanking': {
      const data = await api.ranking(task.rid);
      return {
        candidates: mapRankedList(data?.list, (rank) => ({
          kind: 'regionRanking',
          rank,
          rid: task.rid,
          regionName: task.regionName,
        })),
      };
    }
    case 'weeklyList': {
      const data = await api.weeklyList();
      const issues = [...(data?.list ?? [])]
        .sort((a, b) => b.number - a.number)
        .slice(0, CANDIDATE_CONFIG.weeklyIssueCount)
        .map((issue) => issue.number);
      return { candidates: [], weeklyIssues: issues };
    }
    case 'weekly': {
      const data = await api.weeklyOne(task.issue);
      return {
        candidates: mapRankedList(data?.list, (rank) => ({
          kind: 'weekly',
          rank,
          issue: task.issue,
        })),
      };
    }
    case 'rcmd': {
      const data = await api.rcmd(task.page, CANDIDATE_CONFIG.rcmdPageSize);
      const source: SourceRef = { kind: 'rcmd' };
      const candidates: Candidate[] = [];
      for (const item of data?.item ?? []) {
        const candidate = candidateFromRcmd(item, source);
        if (candidate) candidates.push(candidate);
      }
      return { candidates };
    }
    case 'related': {
      const data = await api.related(task.bvid);
      const source: SourceRef = { kind: 'related' };
      return { candidates: mapRawList(data, source) };
    }
    default: {
      return { candidates: [] };
    }
  }
}

function mapRawList(list: RawVideo[] | undefined | null, source: SourceRef): Candidate[] {
  const candidates: Candidate[] = [];
  for (const video of list ?? []) {
    const candidate = candidateFromRawVideo(video, source);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function mapRankedList(
  list: RawVideo[] | undefined | null,
  sourceOf: (rank: number) => SourceRef,
): Candidate[] {
  const candidates: Candidate[] = [];
  (list ?? []).forEach((video, index) => {
    const candidate = candidateFromRawVideo(video, sourceOf(index + 1));
    if (candidate) candidates.push(candidate);
  });
  return candidates;
}

/* ------------------------------------------------------------------ */
/* 合并与去重                                                          */
/* ------------------------------------------------------------------ */

function sourceRefKey(ref: SourceRef): string {
  return `${ref.kind}|${ref.rid ?? ''}|${ref.issue ?? ''}|${ref.rank ?? ''}`;
}

/** 合并来源列表，按 (种类, rid, 期号, 名次) 去重 */
export function mergeSourceRefs(base: SourceRef[], extra: SourceRef[]): SourceRef[] {
  const map = new Map<string, SourceRef>();
  for (const ref of [...base, ...extra]) map.set(sourceRefKey(ref), ref);
  return [...map.values()];
}

function mergeStatMax(a: VideoStat, b: VideoStat): VideoStat {
  return {
    view: Math.max(a.view, b.view),
    like: Math.max(a.like, b.like),
    favorite: Math.max(a.favorite, b.favorite),
    coin: Math.max(a.coin, b.coin),
    reply: Math.max(a.reply, b.reply),
    danmaku: Math.max(a.danmaku, b.danmaku),
    share: Math.max(a.share, b.share),
  };
}

/** 把 extra 合并进 base（base 通常是先出现的来源） */
export function mergeCandidate(base: Candidate, extra: Candidate): Candidate {
  const knownRegion = base.parentRegion !== UNKNOWN_REGION;
  const tname = base.tname || extra.tname;
  const parentRegion = knownRegion
    ? base.parentRegion
    : extra.parentRegion !== UNKNOWN_REGION
      ? extra.parentRegion
      : UNKNOWN_REGION;
  return {
    bvid: base.bvid,
    aid: base.aid ?? extra.aid,
    cid: base.cid ?? extra.cid,
    title: base.title || extra.title,
    cover: base.cover || extra.cover,
    duration: base.duration || extra.duration,
    pubdate: base.pubdate || extra.pubdate,
    tid: base.tid ?? extra.tid,
    tname,
    parentRegion,
    owner: {
      mid: base.owner.mid || extra.owner.mid,
      name: base.owner.name || extra.owner.name,
      face: base.owner.face ?? extra.owner.face,
    },
    stat: mergeStatMax(base.stat, extra.stat),
    sources: mergeSourceRefs(base.sources, extra.sources),
    rcmdReason: base.rcmdReason ?? extra.rcmdReason,
    isFollowed: base.isFollowed || extra.isFollowed ? true : undefined,
    tags: base.tags && base.tags.length > 0 ? base.tags : extra.tags,
  };
}

/** 按 bvid 合并候选（保持首次出现的顺序） */
export function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const prev = map.get(candidate.bvid);
    map.set(candidate.bvid, prev ? mergeCandidate(prev, candidate) : candidate);
  }
  return [...map.values()];
}

/** 标题 + UP 主去重（同标题同 UP 视为重复），保留播放量更高的一条 */
export function dedupeByTitleAndUp(candidates: Candidate[]): Candidate[] {
  const normalizeTitle = (title: string): string =>
    title
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .slice(0, 80);
  const map = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${normalizeTitle(candidate.title)}|${candidate.owner.mid}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, candidate);
      continue;
    }
    const winner = candidate.stat.view > prev.stat.view ? candidate : prev;
    const loser = winner === candidate ? prev : candidate;
    map.set(key, mergeCandidate(winner, loser));
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ */
/* 过滤                                                                */
/* ------------------------------------------------------------------ */

export interface CandidateFilterOptions {
  nowMs: number;
  /** 已看过的 bvid（来自历史） */
  watched?: ReadonlySet<string>;
  /** 用户标记「不感兴趣」的 bvid */
  dismissed?: ReadonlySet<string>;
  maxAgeDays?: number;
  weeklyMaxAgeDays?: number;
}

/** 发布时间是否在允许范围内（每周必看来源放宽） */
export function isCandidateFreshEnough(
  candidate: Candidate,
  options: Pick<CandidateFilterOptions, 'nowMs' | 'maxAgeDays' | 'weeklyMaxAgeDays'>,
): boolean {
  const maxAge = options.maxAgeDays ?? CANDIDATE_CONFIG.maxAgeDays;
  const weeklyMaxAge = options.weeklyMaxAgeDays ?? CANDIDATE_CONFIG.weeklyMaxAgeDays;
  const hasWeekly = candidate.sources.some((ref) => ref.kind === 'weekly');
  const age = ageDays(candidate.pubdate, options.nowMs);
  return age <= (hasWeekly ? weeklyMaxAge : maxAge);
}

/**
 * 过滤候选池：已看过、不感兴趣、发布时间超限。
 * 标题+UP 去重与 bvid 合并由调用方在映射/汇总时完成。
 */
export function filterCandidates(
  candidates: Candidate[],
  options: CandidateFilterOptions,
): Candidate[] {
  const watched = options.watched ?? new Set<string>();
  const dismissed = options.dismissed ?? new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.bvid) return false;
    if (!candidate.title.trim()) return false;
    if (watched.has(candidate.bvid)) return false;
    if (dismissed.has(candidate.bvid)) return false;
    if (candidate.duration > 0 && candidate.duration > 4 * 60 * 60) return false;
    return isCandidateFreshEnough(candidate, options);
  });
}

/** 一步完成：合并 bvid -> 合并标题/UP -> 过滤 */
export function finalizeCandidates(
  candidates: Candidate[],
  options: CandidateFilterOptions,
): Candidate[] {
  return filterCandidates(dedupeByTitleAndUp(mergeCandidates(candidates)), options);
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

/** 候选来源种类（去重，按固定顺序），用于 RunMeta.sources */
export function collectSourceKinds(candidates: Candidate[]): SourceKind[] {
  const order: SourceKind[] = ['popular', 'ranking', 'regionRanking', 'weekly', 'rcmd', 'related'];
  const present = new Set<SourceKind>();
  for (const candidate of candidates) {
    for (const ref of candidate.sources) present.add(ref.kind);
  }
  return order.filter((kind) => present.has(kind));
}

/** 来源展示文案（如「热门」「每周必看」），推荐理由与 UI 角标共用 */
export function sourceLabelsOf(candidate: Candidate): string[] {
  return candidate.sources.map((ref) => SOURCE_LABELS[ref.kind]);
}

/** 榜单名次奖励的最大值，供打分使用 */
export function bestRankingBonus(candidate: Candidate): number {
  let best = 0;
  for (const ref of candidate.sources) {
    if (ref.rank === undefined) continue;
    best = Math.max(best, rankingBonus(ref.rank));
  }
  return best;
}

/** 一周内的天数常量，供推荐相关模块复用 */
export const SEVEN_DAYS = 7 * DAY;

/** 全部一级分区名（固定顺序），供 UI 与测试复用 */
export const ALL_PARENT_REGION_NAMES = PARENT_REGIONS.map((row) => row.name);
