/**
 * 增长数据：用运行时候选列表里的 stat 写快照（不额外发请求），据此计算 24 小时增长。
 *
 * 规则（与实施计划一致）：
 * - 每次运行把候选视频的统计写入快照表（同 bvid 同一秒幂等）
 * - 24 小时窗口内存在两次间隔 ≥12 小时的快照 -> 实测增量（estimated=false）
 * - 不足两次快照 -> 用「发布以来日均」估算 24 小时增量（estimated=true）
 * - 没有任何可用数据（无 stat / 无发布时间）-> null
 */
import type { Candidate, GrowthInfo, SnapshotRow, VideoStat } from '../../shared/types';
import { diffStat } from '../../shared/stat';
import type { Repository } from '../store/repository';
import { round } from './percentile';

export const GROWTH_CONFIG = {
  /** 观测窗口（小时） */
  windowHours: 24,
  /** 实测所需的最小快照间隔（小时） */
  minGapHours: 12,
  /** 估算值的折扣（用于打分，避免估算值压过实测值） */
  estimateDiscount: 0.6,
  /** 单次运行最多写入多少条快照 */
  maxSnapshotsPerRun: 500,
} as const;

const HOUR_SEC = 60 * 60;

/** 把候选统计写入快照表；只写有播放数据的候选（避免脏数据） */
export async function writeSnapshots(
  repo: Repository,
  candidates: Candidate[],
  nowMs: number,
): Promise<number> {
  const ts = Math.floor(nowMs / 1000);
  const seen = new Set<string>();
  const rows: SnapshotRow[] = [];
  for (const candidate of candidates) {
    if (rows.length >= GROWTH_CONFIG.maxSnapshotsPerRun) break;
    if (!candidate.bvid || seen.has(candidate.bvid)) continue;
    if (!candidate.stat || candidate.stat.view <= 0) continue;
    seen.add(candidate.bvid);
    rows.push({ bvid: candidate.bvid, ts, stat: { ...candidate.stat } });
  }
  if (rows.length > 0) await repo.putSnapshots(rows);
  return rows.length;
}

/** 从快照序列计算实测增长；不满足「24h 内两次且间隔≥12h」时返回 null */
export function measuredGrowth(
  snapshots: SnapshotRow[] | undefined,
  nowSec: number,
): GrowthInfo | null {
  if (!snapshots || snapshots.length < 2) return null;
  const windowStart = nowSec - GROWTH_CONFIG.windowHours * HOUR_SEC;
  const within = snapshots
    .filter((row) => row.ts >= windowStart && row.ts <= nowSec)
    .sort((a, b) => a.ts - b.ts);
  if (within.length < 2) return null;

  const latest = within[within.length - 1]!;
  const minGapSec = GROWTH_CONFIG.minGapHours * HOUR_SEC;
  // 取满足间隔的最早快照（窗口最长、样本最稳）
  const earliest = within.find((row) => latest.ts - row.ts >= minGapSec);
  if (!earliest) return null;

  const delta = diffStat(latest.stat, earliest.stat);
  const hours = (latest.ts - earliest.ts) / HOUR_SEC;
  return {
    hours: round(hours, 1),
    view: delta.view,
    favorite: delta.favorite,
    reply: delta.reply,
    estimated: false,
  };
}

/** 用「发布以来日均」估算窗口内增量；缺数据返回 null */
export function estimateGrowth(candidate: Candidate, nowSec: number): GrowthInfo | null {
  const stat: VideoStat | undefined = candidate.stat;
  if (!stat || stat.view <= 0) return null;
  if (!candidate.pubdate || candidate.pubdate >= nowSec) return null;

  const ageHours = Math.max(1, (nowSec - candidate.pubdate) / HOUR_SEC);
  const windowHours = Math.min(GROWTH_CONFIG.windowHours, ageHours);
  const scale = (total: number): number => Math.round((total / ageHours) * windowHours);
  return {
    hours: round(windowHours, 1),
    view: scale(stat.view),
    favorite: scale(stat.favorite),
    reply: scale(stat.reply),
    estimated: true,
  };
}

/**
 * 计算候选池的增长信息：实测优先，其次估算；两者都没有则不放进 Map（消费方按 null 处理）。
 */
export async function computeGrowth(
  repo: Repository,
  candidates: Candidate[],
  nowMs: number,
): Promise<Map<string, GrowthInfo>> {
  const nowSec = Math.floor(nowMs / 1000);
  const bvids = candidates.map((candidate) => candidate.bvid);
  const sinceTs = nowSec - GROWTH_CONFIG.windowHours * HOUR_SEC;
  const snapshotsByBvid = await repo.getSnapshotsFor(bvids, sinceTs);

  const result = new Map<string, GrowthInfo>();
  for (const candidate of candidates) {
    const measured = measuredGrowth(snapshotsByBvid.get(candidate.bvid), nowSec);
    if (measured) {
      result.set(candidate.bvid, measured);
      continue;
    }
    const estimated = estimateGrowth(candidate, nowSec);
    if (estimated) result.set(candidate.bvid, estimated);
  }
  return result;
}

/** 增长速率（播放/小时），供百分位打分使用；估算值打折 */
export function growthRateOf(info: GrowthInfo | null | undefined): number {
  if (!info || info.hours <= 0 || info.view <= 0) return 0;
  const rate = info.view / info.hours;
  return info.estimated ? rate * GROWTH_CONFIG.estimateDiscount : rate;
}

/** 增长信息的展示文案（推荐理由/角标共用） */
export function growthSummary(info: GrowthInfo | null | undefined): string {
  if (!info) return '';
  const hours = info.hours >= 1 ? `${Math.round(info.hours)} 小时` : `${Math.round(info.hours * 60)} 分钟`;
  return `${hours}播放 +${Math.round(info.view)}`;
}
