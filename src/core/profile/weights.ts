/**
 * 历史记录权重：recency × engagement。
 *
 * 公式（与实施计划一致）：
 * - 时间衰减：exp(-ageDays / 10)
 * - 近 7 天观看 ×2（近期兴趣更重要）
 * - 观看进度 < 15 秒 ×0.2（点开就走，视为低兴趣）
 * - 完播率参与 engagement：0.4 + 0.6 × 完播率；无时长信息时取 0.6
 *
 * 权重同时用于画像聚合与「相关推荐」的种子选择。
 */
import type { HistoryRecord } from '../../shared/types';
import { DAY } from '../../shared/time';

export const WEIGHT_CONFIG = {
  /** 时间衰减常数（天） */
  decayDays: 10,
  /** 近期加成窗口（天） */
  recentDays: 7,
  /** 近期加成倍数 */
  recentMultiplier: 2,
  /** 判定「点开就走」的观看秒数 */
  shortProgressSec: 15,
  /** 短片惩罚倍数 */
  shortProgressMultiplier: 0.2,
  /** engagement 下限（无时长信息时使用） */
  engagementFloor: 0.4,
  /** engagement 中完播率占比 */
  completionShare: 0.6,
} as const;

/** 时间衰减因子 exp(-ageDays/10) */
export function recencyFactor(viewedAtSec: number, nowMs: number): number {
  const age = Math.max(0, nowMs / 1000 - viewedAtSec) / (DAY / 1000);
  return Math.exp(-age / WEIGHT_CONFIG.decayDays);
}

/** 完播率；时长未知时返回 null */
export function completionOf(record: HistoryRecord): number | null {
  if (!Number.isFinite(record.duration) || record.duration <= 0) return null;
  const ratio = record.progress / record.duration;
  return Math.min(1, Math.max(0, ratio));
}

/** engagement 因子：完播率越高越有价值，点开就走的重罚 */
export function engagementFactor(record: HistoryRecord): number {
  const completion = completionOf(record);
  let engagement =
    completion === null
      ? 0.6
      : WEIGHT_CONFIG.engagementFloor + WEIGHT_CONFIG.completionShare * completion;
  if (record.progress < WEIGHT_CONFIG.shortProgressSec) {
    engagement *= WEIGHT_CONFIG.shortProgressMultiplier;
  }
  return engagement;
}

/** 单条历史记录的权重 */
export function historyWeight(record: HistoryRecord, nowMs: number): number {
  const recency = recencyFactor(record.viewedAt, nowMs);
  const ageDays = Math.max(0, nowMs / 1000 - record.viewedAt) / (DAY / 1000);
  const recentBoost = ageDays <= WEIGHT_CONFIG.recentDays ? WEIGHT_CONFIG.recentMultiplier : 1;
  return recency * engagementFactor(record) * recentBoost;
}

/**
 * 选「高质量历史」作为相关推荐的种子：按权重倒序，尽量来自不同 UP 主。
 * 只保留真正看过一点的记录（progress >= 15 秒）。
 */
export function pickHighQualityHistory(
  history: HistoryRecord[],
  nowMs: number,
  limit = 5,
): HistoryRecord[] {
  const scored = history
    .filter((record) => record.progress >= WEIGHT_CONFIG.shortProgressSec)
    .map((record) => ({ record, weight: historyWeight(record, nowMs) }))
    .filter((row) => row.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const picked: HistoryRecord[] = [];
  const usedAuthors = new Set<number>();
  for (const row of scored) {
    if (picked.length >= limit) break;
    const mid = row.record.authorMid;
    if (mid !== undefined && usedAuthors.has(mid)) continue;
    picked.push(row.record);
    if (mid !== undefined) usedAuthors.add(mid);
  }
  // 不同 UP 太少时允许重复作者补齐，保证相关推荐有足够种子
  for (const row of scored) {
    if (picked.length >= limit) break;
    if (picked.includes(row.record)) continue;
    picked.push(row.record);
  }
  return picked.slice(0, limit);
}
