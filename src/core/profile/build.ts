/**
 * 用户画像：分区/UP/标签亲和、24 维观看时段、完播率、时长偏好。
 *
 * 输入是最近 90 天的 HistoryRecord（流水线 history 阶段产出），所有权重都来自
 * `weights.historyWeight`（recency × engagement），保证口径统一。
 *
 * v0.2.0 起额外接收只读兴趣信号（收藏 / 关注 / 稍后再看）：
 * - 收藏过的 UP：权重 + count × 1.5
 * - 关注的 UP：权重 + 3.0
 * - 稍后再看的分区：权重 + count × 1.2
 * - 收藏 / 稍后再看的标题标签：按 1.5 / 1.2 与历史标签合并后归一化
 * 合并后的画像同时用于推荐兴趣分与「我的标签」页，原始信号保留在 `Profile.signals`。
 */
import { SIGNAL_WEIGHTS } from '../../shared/constants';
import type {
  AffinityRow,
  HistoryRecord,
  InterestSignals,
  Profile,
  ProfileSignals,
  Settings,
  TagRow,
  UpRow,
} from '../../shared/types';
import { DAY } from '../../shared/time';
import { buildTagRows, mergeTagRows, tagRowsFromRaw } from './tags';
import { completionOf, historyWeight } from './weights';

export const PROFILE_CONFIG = {
  /** 采集窗口（天） */
  windowDays: 90,
  /** 近 7 天统计窗口 */
  recentDays: 7,
  /** 分区亲和最多保留多少个 */
  regionLimit: 20,
  /** 常看 UP 最多保留多少个 */
  upLimit: 20,
  /** 标签最多保留多少个 */
  tagLimit: 40,
  /** 画像里保留的收藏/关注/稍后再看条目上限 */
  signalUpLimit: 20,
  signalTagLimit: 30,
  signalRegionLimit: 20,
} as const;

export interface BuildProfileInput {
  history: HistoryRecord[];
  nowMs: number;
  mid?: number;
  uname?: string;
  avatar?: string;
  windowDays?: number;
  tagWindow?: Settings['tagWindow'];
  tagLimit?: number;
  upLimit?: number;
  regionLimit?: number;
  /** 只读兴趣信号（收藏/关注/稍后再看）；公开模式或获取失败时为 null/undefined */
  signals?: InterestSignals | null;
}

/** 过滤到采集窗口（默认 90 天） */
export function filterByWindow(
  history: HistoryRecord[],
  nowMs: number,
  windowDays: number = PROFILE_CONFIG.windowDays,
): HistoryRecord[] {
  const sinceSec = Math.floor(nowMs / 1000 - windowDays * (DAY / 1000));
  return history.filter((record) => record.viewedAt >= sinceSec);
}

/** 按「标签统计窗口」过滤：7d / 30d / all */
export function filterByTagWindow(
  history: HistoryRecord[],
  tagWindow: Settings['tagWindow'],
  nowMs: number,
): HistoryRecord[] {
  if (tagWindow === 'all') return [...history];
  const days = tagWindow === '7d' ? 7 : 30;
  return filterByWindow(history, nowMs, days);
}

/** 线性插值分位数（输入需升序） */
export function percentileOf(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  const position = clamped * (sortedAsc.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower]!;
  const fraction = position - lower;
  return sortedAsc[lower]! * (1 - fraction) + sortedAsc[upper]! * fraction;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function normalizeRows(rows: Array<{ name: string; weight: number; count: number }>): AffinityRow[] {
  if (rows.length === 0) return [];
  const max = Math.max(...rows.map((row) => row.weight));
  if (max <= 0) return [];
  return rows
    .map((row) => ({
      name: row.name,
      affinity: round4(row.weight / max),
      count: row.count,
    }))
    .sort((a, b) => b.affinity - a.affinity || b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

/** 由「mid + 名称 + 权重 + 次数」生成归一化 UpRow[] */
function normalizeUpRows(
  rows: Array<{ mid: number; name: string; weight: number; count: number }>,
  limit: number,
): UpRow[] {
  const valid = rows.filter((row) => row.mid > 0 && row.weight > 0);
  if (valid.length === 0) return [];
  const max = Math.max(...valid.map((row) => row.weight));
  if (max <= 0) return [];
  return valid
    .map((row) => ({
      mid: row.mid,
      name: row.name,
      affinity: round4(row.weight / max),
      count: row.count,
    }))
    .sort((a, b) => b.affinity - a.affinity || b.count - a.count || a.mid - b.mid)
    .slice(0, limit);
}

/** 把原始兴趣信号转为画像里展示/查询用的归一化结构 */
function toProfileSignals(signals: InterestSignals): ProfileSignals {
  return {
    fetchedAt: signals.fetchedAt,
    favoriteFolders: signals.favoriteFolders,
    favoriteCount: signals.favoriteCount,
    favoriteSampled: signals.favoriteSampled,
    favoriteUps: normalizeUpRows(
      signals.favoriteUps.map((row) => ({
        mid: row.mid,
        name: row.name,
        weight: row.count,
        count: row.count,
      })),
      PROFILE_CONFIG.signalUpLimit,
    ),
    favoriteTags: tagRowsFromRaw(signals.favoriteTags, PROFILE_CONFIG.signalTagLimit),
    followedTotal: signals.followedTotal,
    followedMids: signals.followed
      .map((row) => row.mid)
      .filter((mid) => mid > 0)
      .slice(0, 200),
    followedUps: normalizeUpRows(
      signals.followed.map((row) => ({
        mid: row.mid,
        name: row.name,
        weight: 1,
        count: 1,
      })),
      PROFILE_CONFIG.signalUpLimit,
    ),
    watchLaterCount: signals.watchLaterCount,
    watchLaterSampled: signals.watchLaterSampled,
    watchLaterRegions: normalizeRows(
      signals.watchLaterRegions.map((row) => ({
        name: row.name,
        weight: row.weight,
        count: row.count,
      })),
    ).slice(0, PROFILE_CONFIG.signalRegionLimit),
    watchLaterTags: tagRowsFromRaw(signals.watchLaterTags, PROFILE_CONFIG.signalTagLimit),
    ...(signals.favoriteFallback ? { favoriteFallback: true } : {}),
  };
}

/** 构造画像；历史与信号都为空时返回稳定空画像 */
export function buildProfile(input: BuildProfileInput): Profile {
  const windowDays = input.windowDays ?? PROFILE_CONFIG.windowDays;
  const history = filterByWindow(input.history ?? [], input.nowMs, windowDays);
  const signals = input.signals ?? null;

  const regionMap = new Map<string, { weight: number; count: number }>();
  const upMap = new Map<number, { name: string; weight: number; count: number }>();
  const hours = new Array<number>(24).fill(0);
  const completions: number[] = [];
  const durations: number[] = [];
  let last7d = 0;
  const recentCutoffSec = Math.floor(input.nowMs / 1000 - PROFILE_CONFIG.recentDays * (DAY / 1000));

  const addRegion = (name: string, weight: number, count = 1): void => {
    if (!name || name === '其他' || weight <= 0) return;
    const prev = regionMap.get(name);
    if (prev) {
      prev.weight += weight;
      prev.count += count;
    } else {
      regionMap.set(name, { weight, count });
    }
  };

  const addUp = (mid: number, name: string, weight: number, count = 1): void => {
    if (!mid || mid <= 0 || weight <= 0) return;
    const prev = upMap.get(mid);
    if (prev) {
      prev.weight += weight;
      prev.count += count;
      if (!prev.name && name) prev.name = name;
    } else {
      upMap.set(mid, { name, weight, count });
    }
  };

  for (const record of history) {
    const weight = historyWeight(record, input.nowMs);
    addRegion((record.parentRegion ?? '').trim(), weight);
    if (record.authorMid !== undefined && record.authorMid > 0) {
      addUp(record.authorMid, record.authorName ?? '', weight);
    }
    const completion = completionOf(record);
    if (completion !== null && record.progress > 0) completions.push(completion);
    if (record.duration > 0) durations.push(record.duration);
    const hour = new Date(record.viewedAt * 1000).getHours();
    hours[hour] = (hours[hour] ?? 0) + weight;
    if (record.viewedAt >= recentCutoffSec) last7d += 1;
  }

  /* ---- 合并只读兴趣信号 ---- */
  if (signals) {
    for (const row of signals.favoriteUps) {
      addUp(row.mid, row.name, row.count * SIGNAL_WEIGHTS.favoriteUp, row.count);
    }
    for (const row of signals.followed) {
      addUp(row.mid, row.name, SIGNAL_WEIGHTS.followedUp, 1);
    }
    for (const row of signals.watchLaterRegions) {
      addRegion(row.name, row.count * SIGNAL_WEIGHTS.watchLaterRegion, row.count);
    }
  }

  const maxHour = Math.max(...hours, 0);
  const normalizedHours =
    maxHour > 0 ? hours.map((value) => round4(value / maxHour)) : hours;

  const tagLimit = input.tagLimit ?? PROFILE_CONFIG.tagLimit;
  const historyTags = buildTagRows(
    filterByTagWindow(history, input.tagWindow ?? '7d', input.nowMs),
    input.nowMs,
    { limit: Math.max(tagLimit, 60) },
  );
  const tagSources: Array<{ rows: TagRow[]; weight: number }> = [
    { rows: historyTags, weight: 1 },
  ];
  if (signals) {
    tagSources.push({
      rows: tagRowsFromRaw(signals.favoriteTags, tagLimit),
      weight: SIGNAL_WEIGHTS.favoriteTag,
    });
    tagSources.push({
      rows: tagRowsFromRaw(signals.watchLaterTags, tagLimit),
      weight: SIGNAL_WEIGHTS.watchLaterTag,
    });
  }
  const tags = mergeTagRows(tagSources, tagLimit);

  const regionLimit = input.regionLimit ?? PROFILE_CONFIG.regionLimit;
  const upLimit = input.upLimit ?? PROFILE_CONFIG.upLimit;
  const regions = normalizeRows(
    [...regionMap.entries()].map(([name, row]) => ({ name, weight: row.weight, count: row.count })),
  ).slice(0, regionLimit);
  const ups = normalizeUpRows(
    [...upMap.entries()].map(([mid, row]) => ({
      mid,
      name: row.name,
      weight: row.weight,
      count: row.count,
    })),
    upLimit,
  );

  const completionRate =
    completions.length > 0 ? round4(completions.reduce((sum, value) => sum + value, 0) / completions.length) : 0;
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0;
  const durationsAsc = [...durations].sort((a, b) => a - b);

  return {
    mid: input.mid,
    uname: input.uname,
    avatar: input.avatar,
    generatedAt: input.nowMs,
    sample: {
      total: history.length,
      last7d,
      windowDays,
    },
    regions,
    tags,
    ups,
    hours: normalizedHours,
    completionRate,
    avgDuration,
    preferredDuration: {
      p10: Math.round(percentileOf(durationsAsc, 0.1)),
      p90: Math.round(percentileOf(durationsAsc, 0.9)),
    },
    ...(signals ? { signals: toProfileSignals(signals) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 查询辅助（打分/推荐理由使用）                                        */
/* ------------------------------------------------------------------ */

/** 一级分区亲和度；未知返回 0 */
export function affinityOf(profile: Profile | null, region: string): number {
  if (!profile) return 0;
  const row = profile.regions.find((item) => item.name === region);
  return row?.affinity ?? 0;
}

/** UP 主亲和度；未知返回 0 */
export function upAffinityOf(profile: Profile | null, mid: number | undefined): number {
  if (!profile || mid === undefined) return 0;
  const row = profile.ups.find((item) => item.mid === mid);
  return row?.affinity ?? 0;
}

/** 是否关注了该 UP 主（只读信号） */
export function isFollowedUp(profile: Profile | null, mid: number | undefined): boolean {
  if (!profile || !mid || !profile.signals) return false;
  return profile.signals.followedMids.includes(mid);
}

/** 是否收藏过该 UP 主的视频（只读信号） */
export function isFavoriteUp(profile: Profile | null, mid: number | undefined): boolean {
  if (!profile || !mid || !profile.signals) return false;
  return profile.signals.favoriteUps.some((row) => row.mid === mid);
}

/** 建立「标签词 -> 权重」索引，避免打分时反复 find */
export function buildTagIndex(profile: Profile | null): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of profile?.tags ?? []) index.set(row.term, row.weight);
  return index;
}

/** 查询标签权重（标签可能带大小写差异） */
export function tagWeightOf(index: Map<string, number>, term: string): number {
  return index.get(term.toLowerCase()) ?? 0;
}

/** 画像摘要：UI 顶部与每日结果的 profileSummary 共用 */
export function profileSummaryOf(profile: Profile | null): {
  topRegions: AffinityRow[];
  topTags: TagRow[];
} {
  return {
    topRegions: (profile?.regions ?? []).slice(0, 5),
    topTags: (profile?.tags ?? []).slice(0, 10),
  };
}
