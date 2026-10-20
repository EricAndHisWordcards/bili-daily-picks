/**
 * 周报：每个自然周（周一 00:00 至下周一 00:00，本地时区）一份。
 *
 * 生成时机：周一的每日更新会产出「上一个完整自然周」的报告；之后任意一次每日更新
 * 都会补生成（已存在则跳过）。周报只读历史记录，不受推荐候选影响。
 *
 * 口径（与实施计划一致）：
 * - 标签：标题分词 × 长度权重 + 一级分区 × 1.2 + 叶子分区 × 0.6；
 *   当前周与上一周用同一个归一化基准（两周最大原始权重），便于比较涨跌；
 * - 涨跌阈值：标签 0.15、分区 0.10；状态 new/up/down/gone/steady；
 * - 展示：标签 Top12、分区 Top6、UP Top6、上升/下降各 5；
 * - 当前周没有观看记录时返回空态周报（数组为空 + 空态文案）。
 */
import { WEEKLY_CONFIG } from '../../shared/constants';
import { dateKey } from '../../shared/time';
import type {
  AffinityRow,
  HistoryRecord,
  TrendDirection,
  WeeklyReport,
} from '../../shared/types';
import type { Repository } from '../store/repository';
import { lengthWeight, tokenizeTitle } from '../profile/tags';

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 一个自然周窗口 */
export interface WeekWindow {
  /** 周一 00:00（毫秒） */
  weekStart: number;
  /** 下周一 00:00（毫秒，不含） */
  weekEnd: number;
  /** 周一日期 YYYY-MM-DD，周报主键 */
  weekKey: string;
  /** 展示用标签，如「10月13日 - 10月19日」 */
  label: string;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 本地时间当天 00:00（毫秒） */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周周一 00:00（本地时区） */
export function localWeekStart(ts: number): number {
  const d = new Date(startOfLocalDay(ts));
  const offset = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 在本地日历上平移若干天，避免夏令时/跨月误差 */
function shiftDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatWeekLabel(weekStart: number, weekEnd: number): string {
  const start = new Date(weekStart);
  const end = new Date(weekEnd - 1); // 周日 23:59:59
  const sameYear = start.getFullYear() === end.getFullYear();
  const format = (d: Date, withYear: boolean): string =>
    `${withYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日`;
  // 跨年时两端都带年份，避免「12月29日 - 1月4日」产生歧义
  return `${format(start, !sameYear)} - ${format(end, !sameYear)}`;
}

/** 由周一 00:00 构造完整周窗口 */
export function weekWindowFromStart(weekStart: number): WeekWindow {
  const start = startOfLocalDay(weekStart);
  const weekEnd = shiftDays(start, 7);
  return {
    weekStart: start,
    weekEnd,
    weekKey: dateKey(start),
    label: formatWeekLabel(start, weekEnd),
  };
}

/** 时间戳所属自然周的周键（周一日期） */
export function weekKeyOf(ts: number): string {
  return dateKey(localWeekStart(ts));
}

/**
 * 最近一个「已完整结束」的自然周：
 * 即 weekEnd <= now 的最近一周。周一 04:00 触发时正好是上一周（周一至周日）。
 */
export function previousCompletedWeek(nowMs: number): WeekWindow {
  const currentWeekStart = localWeekStart(nowMs);
  return weekWindowFromStart(shiftDays(currentWeekStart, -7));
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

interface WindowStats {
  watched: number;
  watchSeconds: number;
  activeDays: number;
  completionRate: number;
}

/** 观看秒数：有总时长时按进度截断，避免进度超过时长 */
function watchedSecondsOf(record: HistoryRecord): number {
  const progress = Math.max(0, record.progress);
  if (record.duration > 0) return Math.min(progress, record.duration);
  return progress;
}

function recordsInWindow(history: HistoryRecord[], start: number, end: number): HistoryRecord[] {
  return history.filter((record) => {
    const viewedMs = record.viewedAt * 1000;
    return viewedMs >= start && viewedMs < end;
  });
}

function statsOf(records: HistoryRecord[]): WindowStats {
  let watchSeconds = 0;
  let completionSum = 0;
  let completionCount = 0;
  const days = new Set<string>();
  for (const record of records) {
    watchSeconds += watchedSecondsOf(record);
    days.add(dateKey(record.viewedAt * 1000));
    if (record.duration > 0 && record.progress > 0) {
      completionSum += Math.min(1, record.progress / record.duration);
      completionCount += 1;
    }
  }
  return {
    watched: records.length,
    watchSeconds,
    activeDays: days.size,
    completionRate: completionCount > 0 ? round4(completionSum / completionCount) : 0,
  };
}

function dailyBreakdown(records: HistoryRecord[], weekStart: number): WeeklyReport['daily'] {
  const result: WeeklyReport['daily'] = [];
  for (let index = 0; index < 7; index += 1) {
    const dayStart = shiftDays(weekStart, index);
    const dayEnd = shiftDays(weekStart, index + 1);
    const rows = records.filter((record) => {
      const viewedMs = record.viewedAt * 1000;
      return viewedMs >= dayStart && viewedMs < dayEnd;
    });
    result.push({
      date: dateKey(dayStart),
      weekday: WEEKDAY_NAMES[index]!,
      watched: rows.length,
      watchSeconds: rows.reduce((sum, record) => sum + watchedSecondsOf(record), 0),
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 标签 / 分区 / UP 聚合                                                */
/* ------------------------------------------------------------------ */

interface RawTermRow {
  weight: number;
  count: number;
}

/** 标签原始权重：标题分词 × 长度权重 + 一级分区 1.2 + 叶子分区 0.6 */
function rawTermWeights(records: HistoryRecord[]): Map<string, RawTermRow> {
  const map = new Map<string, RawTermRow>();
  const add = (term: string, weight: number): void => {
    const key = term.trim();
    if (!key || weight <= 0) return;
    const prev = map.get(key);
    if (prev) {
      prev.weight += weight;
      prev.count += 1;
    } else {
      map.set(key, { weight, count: 1 });
    }
  };
  for (const record of records) {
    for (const term of tokenizeTitle(record.title)) add(term, lengthWeight(term));
    const parent = (record.parentRegion ?? '').trim();
    if (parent && parent !== '其他') add(parent, 1.2);
    const leaf = (record.tname ?? '').trim();
    if (leaf && leaf !== parent) add(leaf, 0.6);
  }
  return map;
}

function statusOf(
  delta: number,
  currentCount: number,
  previousCount: number,
  threshold: number,
): TrendDirection {
  if (currentCount > 0 && previousCount === 0) return 'new';
  if (currentCount === 0 && previousCount > 0) return 'gone';
  if (delta >= threshold) return 'up';
  if (delta <= -threshold) return 'down';
  return 'steady';
}

interface NormalizedTerm {
  term: string;
  weight: number;
  previousWeight: number;
  delta: number;
  count: number;
  previousCount: number;
  status: TrendDirection;
}

function buildTagTrends(
  current: HistoryRecord[],
  previous: HistoryRecord[],
): NormalizedTerm[] {
  const currentRaw = rawTermWeights(current);
  const previousRaw = rawTermWeights(previous);
  const maxRaw = Math.max(
    1e-6,
    ...[...currentRaw.values()].map((row) => row.weight),
    ...[...previousRaw.values()].map((row) => row.weight),
  );
  const terms = new Set<string>([...currentRaw.keys(), ...previousRaw.keys()]);
  const rows: NormalizedTerm[] = [];
  for (const term of terms) {
    const currentRow = currentRaw.get(term);
    const previousRow = previousRaw.get(term);
    const weight = round4(clamp01((currentRow?.weight ?? 0) / maxRaw));
    const previousWeight = round4(clamp01((previousRow?.weight ?? 0) / maxRaw));
    const delta = round4(weight - previousWeight);
    rows.push({
      term,
      weight,
      previousWeight,
      delta,
      count: currentRow?.count ?? 0,
      previousCount: previousRow?.count ?? 0,
      status: statusOf(delta, currentRow?.count ?? 0, previousRow?.count ?? 0, WEEKLY_CONFIG.tagDelta),
    });
  }
  return rows.sort(
    (a, b) =>
      Math.max(b.weight, b.previousWeight) - Math.max(a.weight, a.previousWeight) ||
      b.weight - a.weight ||
      a.term.localeCompare(b.term, 'zh-CN'),
  );
}

interface NormalizedRegion {
  name: string;
  weight: number;
  previousWeight: number;
  delta: number;
  count: number;
  previousCount: number;
  status: TrendDirection;
}

function buildRegionTrends(
  current: HistoryRecord[],
  previous: HistoryRecord[],
): NormalizedRegion[] {
  const countOf = (records: HistoryRecord[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const record of records) {
      const region = (record.parentRegion ?? '').trim();
      if (!region || region === '其他') continue;
      map.set(region, (map.get(region) ?? 0) + 1);
    }
    return map;
  };
  const currentCounts = countOf(current);
  const previousCounts = countOf(previous);
  const maxCount = Math.max(1, ...[...currentCounts.values()], ...[...previousCounts.values()]);
  const names = new Set<string>([...currentCounts.keys(), ...previousCounts.keys()]);
  const rows: NormalizedRegion[] = [];
  for (const name of names) {
    const weight = round4(clamp01((currentCounts.get(name) ?? 0) / maxCount));
    const previousWeight = round4(clamp01((previousCounts.get(name) ?? 0) / maxCount));
    const delta = round4(weight - previousWeight);
    rows.push({
      name,
      weight,
      previousWeight,
      delta,
      count: currentCounts.get(name) ?? 0,
      previousCount: previousCounts.get(name) ?? 0,
      status: statusOf(
        delta,
        currentCounts.get(name) ?? 0,
        previousCounts.get(name) ?? 0,
        WEEKLY_CONFIG.regionDelta,
      ),
    });
  }
  return rows.sort(
    (a, b) =>
      Math.max(b.weight, b.previousWeight) - Math.max(a.weight, a.previousWeight) ||
      b.weight - a.weight ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
}

interface UpCountRow {
  mid: number;
  name: string;
  count: number;
  previousCount: number;
  delta: number;
}

function buildUpTrends(current: HistoryRecord[], previous: HistoryRecord[]): UpCountRow[] {
  const countOf = (records: HistoryRecord[]): Map<number, { name: string; count: number }> => {
    const map = new Map<number, { name: string; count: number }>();
    for (const record of records) {
      const mid = record.authorMid;
      if (!mid || mid <= 0) continue;
      const prev = map.get(mid);
      if (prev) {
        prev.count += 1;
        if (!prev.name && record.authorName) prev.name = record.authorName;
      } else {
        map.set(mid, { name: record.authorName ?? '', count: 1 });
      }
    }
    return map;
  };
  const currentCounts = countOf(current);
  const previousCounts = countOf(previous);
  const mids = new Set<number>([...currentCounts.keys(), ...previousCounts.keys()]);
  const rows: UpCountRow[] = [];
  for (const mid of mids) {
    const name = currentCounts.get(mid)?.name ?? previousCounts.get(mid)?.name ?? '';
    const count = currentCounts.get(mid)?.count ?? 0;
    const previousCount = previousCounts.get(mid)?.count ?? 0;
    rows.push({ mid, name, count, previousCount, delta: count - previousCount });
  }
  return rows.sort(
    (a, b) =>
      Math.max(b.count, b.previousCount) - Math.max(a.count, a.previousCount) ||
      b.count - a.count ||
      a.mid - b.mid,
  );
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

function formatWatchSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  }
  if (total >= 60) return `${Math.round(total / 60)} 分钟`;
  return `${total} 秒`;
}

function buildSummary(
  currentTotal: number,
  stats: WindowStats,
  previousStats: WindowStats,
  tags: WeeklyReport['tags'],
  regions: WeeklyReport['regions'],
): string[] {
  if (currentTotal === 0) {
    return ['该周没有观看记录，下周再开始吧'];
  }
  const summary: string[] = [
    `该周观看 ${stats.watched} 个视频，累计 ${formatWatchSeconds(stats.watchSeconds)}`,
    `活跃 ${stats.activeDays} 天，平均完播率 ${Math.round(stats.completionRate * 100)}%`,
  ];
  if (regions.length > 0) summary.push(`最常看的分区是「${regions[0]!.name}」`);
  const rising = tags.find((row) => row.status === 'new' || row.status === 'up');
  if (rising) summary.push(`比上周更关注「${rising.term}」`);
  const watchedDelta = stats.watched - previousStats.watched;
  if (previousStats.watched > 0) {
    summary.push(`观看数较上周 ${watchedDelta >= 0 ? '+' : ''}${watchedDelta}`);
  }
  return summary.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成指定自然周的周报。
 * @param history 最近 90 天历史（内部按窗口过滤）
 * @param weekStart 该周周一 00:00（毫秒）
 * @param nowMs 生成时刻（毫秒）
 */
export function buildWeeklyReport(
  history: HistoryRecord[],
  weekStart: number,
  nowMs: number,
): WeeklyReport {
  const window = weekWindowFromStart(weekStart);
  const previousWindow = weekWindowFromStart(shiftDays(window.weekStart, -7));
  const current = recordsInWindow(history, window.weekStart, window.weekEnd);
  const previous = recordsInWindow(history, previousWindow.weekStart, previousWindow.weekEnd);

  const stats = statsOf(current);
  const previousStats = statsOf(previous);
  const tagRows = buildTagTrends(current, previous);
  const regionRows = buildRegionTrends(current, previous);
  const upRows = buildUpTrends(current, previous);

  const isEmpty = current.length === 0;
  const tags: WeeklyReport['tags'] = isEmpty ? [] : tagRows.slice(0, WEEKLY_CONFIG.tagLimit);
  const regions: WeeklyReport['regions'] = isEmpty
    ? []
    : regionRows.slice(0, WEEKLY_CONFIG.regionLimit);
  const ups: WeeklyReport['ups'] = isEmpty ? [] : upRows.slice(0, WEEKLY_CONFIG.upLimit);

  // 上升/下降榜基于完整词表（不局限于 Top12），便于发现长尾变化
  const rising = isEmpty
    ? []
    : tagRows
        .filter((row) => row.delta > 0)
        .sort((a, b) => b.delta - a.delta || b.weight - a.weight)
        .slice(0, WEEKLY_CONFIG.moverLimit)
        .map((row) => ({ term: row.term, delta: row.delta, weight: row.weight }));
  const falling = isEmpty
    ? []
    : tagRows
        .filter((row) => row.delta < 0)
        .sort((a, b) => a.delta - b.delta || b.previousWeight - a.previousWeight)
        .slice(0, WEEKLY_CONFIG.moverLimit)
        .map((row) => ({ term: row.term, delta: row.delta, weight: row.previousWeight }));

  return {
    weekKey: window.weekKey,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    label: window.label,
    generatedAt: nowMs,
    stats,
    previous: previousStats,
    daily: dailyBreakdown(current, window.weekStart),
    tags,
    rising,
    falling,
    regions,
    ups,
    summary: buildSummary(current.length, stats, previousStats, tagRows, regions),
    sample: { currentTotal: current.length, previousTotal: previous.length },
  };
}

export interface WeeklyGenerationInput {
  repo: Repository;
  history: HistoryRecord[];
  nowMs: number;
}

export interface WeeklyGenerationOutcome {
  report: WeeklyReport | null;
  /** 跳过原因：目标周已有报告 / 没有历史数据 */
  skipped: 'exists' | 'no-history' | null;
}

/**
 * 每日更新后补生成「上一个完整自然周」的周报：
 * - 已存在则跳过（幂等）；
 * - 没有历史记录则跳过；
 * - 生成后保存并只保留最近 12 份。
 */
export async function maybeGenerateWeeklyReport(
  input: WeeklyGenerationInput,
): Promise<WeeklyGenerationOutcome> {
  const target = previousCompletedWeek(input.nowMs);
  const existing = await input.repo.getWeeklyReport(target.weekKey);
  if (existing) return { report: null, skipped: 'exists' };
  if (!input.history || input.history.length === 0) {
    return { report: null, skipped: 'no-history' };
  }
  const report = buildWeeklyReport(input.history, target.weekStart, input.nowMs);
  await input.repo.saveWeeklyReport(report);
  await input.repo.pruneWeeklyReports(WEEKLY_CONFIG.keepReports);
  return { report, skipped: null };
}

/** 周报标签/分区转换为 AffinityRow（UI 复用） */
export function weeklyRegionsToAffinity(regions: WeeklyReport['regions']): AffinityRow[] {
  return regions.map((row) => ({ name: row.name, affinity: row.weight, count: row.count }));
}
