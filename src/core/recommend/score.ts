/**
 * 打分：兴趣 35% + 互动质量 25% + 增长 20% + 榜单 12% + 新鲜度 8%，再减去惩罚项。
 *
 * - quality / growth 都用「池内百分位」，避免不同日期绝对数值差异
 * - 兴趣分 = 分区亲和 × 0.55 + UP 亲和 × 0.25 + 标签匹配 × 0.20；公开模式取中性 0.5
 * - 惩罚：2 天/7 天内已推荐过、时长偏离偏好；「同一板块同 UP」不在这里扣分，
 *   而是在分组阶段（sections.ts）作为硬约束去重：每个分区板块每 UP 最多 1 条。
 */
import { PENALTIES, SCORE_WEIGHTS, SOURCE_LABELS, rankingBonus } from '../../shared/constants';
import { engagementRates } from '../../shared/stat';
import { DAY } from '../../shared/time';
import type { Candidate, GrowthInfo, Profile, SourceRef } from '../../shared/types';
import { seededFraction } from '../../shared/hash';
import { affinityOf, buildTagIndex, tagWeightOf, upAffinityOf } from '../profile/build';
import { tokenizeTitle } from '../profile/tags';
import { growthRateOf } from './growth';
import { buildPercentile, clamp01, round } from './percentile';

/** 打分上下文 */
export interface ScoreContext {
  profile: Profile | null;
  nowMs: number;
  /** bvid -> 增长信息 */
  growth?: Map<string, GrowthInfo>;
  /** bvid -> 最近一次被推荐的时间戳（毫秒） */
  pickedAt?: Map<string, number>;
}

/** 分项得分，便于 UI/测试展示 */
export interface ScoreParts {
  interest: number;
  quality: number;
  growth: number;
  curation: number;
  freshness: number;
}

export interface PenaltyDetail {
  /** 2/7 天内重复推荐的惩罚 */
  recentPicks: number;
  /** 时长偏离偏好的惩罚 */
  duration: number;
  total: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  /** 0..1 综合分 */
  score: number;
  parts: ScoreParts;
  penalties: PenaltyDetail;
  growth: GrowthInfo | null;
}

/** 分项权重（与 constants.SCORE_WEIGHTS 对齐，测试可引用） */
export const SCORE_PARTS_WEIGHTS = SCORE_WEIGHTS;

/** 质量分内部权重：播放 30%、收藏 25%、投币 20%、点赞 15%、评论 10% */
const QUALITY_METRIC_WEIGHTS = {
  view: 0.3,
  favorite: 0.25,
  coin: 0.2,
  like: 0.15,
  reply: 0.1,
} as const;

/** 来源基础分（榜单名次奖励另加） */
const CURATION_BASE: Record<SourceRef['kind'], number> = {
  weekly: 0.8,
  ranking: 0.15,
  regionRanking: 0.1,
  rcmd: 0.5,
  related: 0.4,
  popular: 0.35,
};

/** 榜单来源的排序：同一候选命中多个榜单时取最高奖励 */
function curationOfSources(sources: SourceRef[]): number {
  let best = 0;
  for (const ref of sources) {
    let value = CURATION_BASE[ref.kind];
    if (ref.kind === 'ranking' || ref.kind === 'regionRanking') {
      value += rankingBonus(ref.rank);
    }
    best = Math.max(best, value);
  }
  const multiSourceBonus = Math.min(0.1, 0.05 * Math.max(0, sources.length - 1));
  return clamp01(best + multiSourceBonus);
}

/** 榜单/策展分：每周必看最高，其次排行榜名次，多来源略加分 */
export function curationScore(candidate: Candidate): number {
  return curationOfSources(candidate.sources);
}

/** 新鲜度：1/(1+ageDays/7)，0 天=1，7 天=0.5，30 天≈0.19 */
export function freshnessScore(candidate: Candidate, nowMs: number): number {
  const ageDays = Math.max(0, nowMs / 1000 - candidate.pubdate) / (DAY / 1000);
  return clamp01(1 / (1 + ageDays / 7));
}

/** 最佳标签匹配词与权重（推荐理由用） */
export function bestTagMatch(
  candidate: Candidate,
  profile: Profile | null,
  tagIndex = buildTagIndex(profile),
): { term: string; weight: number } | null {
  if (!profile || tagIndex.size === 0) return null;
  const terms = new Set<string>();
  for (const term of tokenizeTitle(candidate.title)) terms.add(term);
  for (const tag of candidate.tags ?? []) terms.add(tag.trim().toLowerCase());
  let best: { term: string; weight: number } | null = null;
  for (const term of terms) {
    const weight = tagWeightOf(tagIndex, term);
    if (weight <= 0) continue;
    if (!best || weight > best.weight) best = { term, weight };
  }
  return best;
}

/** 标签匹配分：两个满权重标签命中即满分 */
export function tagMatchScore(candidate: Candidate, profile: Profile | null): number {
  if (!profile) return 0;
  const terms = new Set<string>();
  for (const term of tokenizeTitle(candidate.title)) terms.add(term);
  for (const tag of candidate.tags ?? []) terms.add(tag.trim().toLowerCase());
  const tagIndex = buildTagIndex(profile);
  let sum = 0;
  for (const term of terms) sum += tagWeightOf(tagIndex, term);
  return clamp01(sum / 2);
}

/** 兴趣分：公开模式（无画像）返回中性 0.5 */
export function interestScore(candidate: Candidate, profile: Profile | null): number {
  if (!profile) return 0.5;
  const region = affinityOf(profile, candidate.parentRegion);
  const up = upAffinityOf(profile, candidate.owner.mid);
  const tag = tagMatchScore(candidate, profile);
  return clamp01(0.55 * region + 0.25 * up + 0.2 * tag);
}

/** 已推荐惩罚：2 天内 0.2，7 天内 0.08 */
export function recentPicksPenalty(candidate: Candidate, ctx: ScoreContext): number {
  const pickedAt = ctx.pickedAt?.get(candidate.bvid);
  if (pickedAt === undefined) return 0;
  const ageDays = Math.max(0, ctx.nowMs - pickedAt) / DAY;
  if (ageDays <= 2) return PENALTIES.pickedWithin2Days;
  if (ageDays <= 7) return PENALTIES.pickedWithin7Days;
  return 0;
}

/** 时长偏离偏好惩罚：小于 p10 的一半或大于 p90 的 1.6 倍 */
export function durationPenalty(candidate: Candidate, profile: Profile | null): number {
  if (!profile || candidate.duration <= 0) return 0;
  const { p10, p90 } = profile.preferredDuration;
  if (p10 <= 0 || p90 <= 0) return 0;
  const low = p10 * 0.5;
  const high = p90 * 1.6;
  return candidate.duration < low || candidate.duration > high
    ? PENALTIES.durationOutOfRange
    : 0;
}

/** 计算惩罚合计 */
export function penaltyFor(candidate: Candidate, ctx: ScoreContext): PenaltyDetail {
  const recentPicks = recentPicksPenalty(candidate, ctx);
  const duration = durationPenalty(candidate, ctx.profile);
  return { recentPicks, duration, total: recentPicks + duration };
}

/** 池内百分位（quality/growth 用） */
interface ScorePercentiles {
  view: (value: number) => number;
  favorite: (value: number) => number;
  coin: (value: number) => number;
  like: (value: number) => number;
  reply: (value: number) => number;
  growth: (value: number) => number;
}

function buildPercentiles(candidates: Candidate[], growth?: Map<string, GrowthInfo>): ScorePercentiles {
  return {
    view: buildPercentile(candidates.map((candidate) => candidate.stat.view)),
    favorite: buildPercentile(candidates.map((c) => engagementRates(c.stat).favRate)),
    coin: buildPercentile(candidates.map((c) => engagementRates(c.stat).coinRate)),
    like: buildPercentile(candidates.map((c) => engagementRates(c.stat).likeRate)),
    reply: buildPercentile(candidates.map((c) => engagementRates(c.stat).replyRate)),
    growth: buildPercentile(
      candidates.map((candidate) => growthRateOf(growth?.get(candidate.bvid) ?? null)),
    ),
  };
}

function qualityScore(candidate: Candidate, percentiles: ScorePercentiles): number {
  const rates = engagementRates(candidate.stat);
  return clamp01(
    QUALITY_METRIC_WEIGHTS.view * percentiles.view(candidate.stat.view) +
      QUALITY_METRIC_WEIGHTS.favorite * percentiles.favorite(rates.favRate) +
      QUALITY_METRIC_WEIGHTS.coin * percentiles.coin(rates.coinRate) +
      QUALITY_METRIC_WEIGHTS.like * percentiles.like(rates.likeRate) +
      QUALITY_METRIC_WEIGHTS.reply * percentiles.reply(rates.replyRate),
  );
}

function growthScore(candidate: Candidate, ctx: ScoreContext, percentiles: ScorePercentiles): number {
  const info = ctx.growth?.get(candidate.bvid) ?? null;
  if (!info) return 0;
  return clamp01(percentiles.growth(growthRateOf(info)));
}

/** 对一批候选打分并排序（分数高在前，同分按稳定散列打散） */
export function scoreCandidates(candidates: Candidate[], ctx: ScoreContext): ScoredCandidate[] {
  const percentiles = buildPercentiles(candidates, ctx.growth);
  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const parts: ScoreParts = {
      interest: interestScore(candidate, ctx.profile),
      quality: qualityScore(candidate, percentiles),
      growth: growthScore(candidate, ctx, percentiles),
      curation: curationScore(candidate),
      freshness: freshnessScore(candidate, ctx.nowMs),
    };
    const penalties = penaltyFor(candidate, ctx);
    const weighted =
      SCORE_WEIGHTS.interest * parts.interest +
      SCORE_WEIGHTS.quality * parts.quality +
      SCORE_WEIGHTS.growth * parts.growth +
      SCORE_WEIGHTS.curation * parts.curation +
      SCORE_WEIGHTS.freshness * parts.freshness;
    return {
      candidate,
      score: round(clamp01(weighted - penalties.total), 4),
      parts,
      penalties,
      growth: ctx.growth?.get(candidate.bvid) ?? null,
    };
  });
  return sortScored(scored, `${ctx.nowMs}`);
}

/**
 * 稳定排序：分数降序；同分用 `${seedKey}|bvid` 的稳定散列升序，
 * 保证同一天、同一 mid 的结果可复现（seedKey 建议用 `${date}:${mid}`）。
 */
export function sortScored(scored: ScoredCandidate[], seedKey: string): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const hashA = seededFraction(`${seedKey}|${a.candidate.bvid}`);
    const hashB = seededFraction(`${seedKey}|${b.candidate.bvid}`);
    if (hashA !== hashB) return hashA - hashB;
    return a.candidate.bvid.localeCompare(b.candidate.bvid);
  });
}

/** 来源文案（推荐理由拼接用） */
export function sourceLabelOf(kind: SourceRef['kind']): string {
  return SOURCE_LABELS[kind];
}
