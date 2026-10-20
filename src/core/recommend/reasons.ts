/**
 * 推荐理由与角标：把打分结果翻译成中文文案，供 UI 直接展示。
 *
 * 理由优先级：每周必看/排行榜 > 增长 > 关注/收藏的 UP > 兴趣（分区/UP/标签）> 来源。
 * 角标最多 3 个，避免卡片过于拥挤。
 */
import { SOURCE_LABELS } from '../../shared/constants';
import { formatCount } from '../../shared/format';
import type { GrowthInfo, Profile, Recommendation, SourceRef } from '../../shared/types';
import { affinityOf, isFavoriteUp, isFollowedUp, upAffinityOf } from '../profile/build';
import { bestTagMatch, type ScoredCandidate } from './score';

export interface RecommendationContext {
  profile: Profile | null;
  growth?: Map<string, GrowthInfo>;
}

/** 取名次最好的某个来源 */
function bestRankedSource(
  sources: SourceRef[],
  kind: SourceRef['kind'],
): SourceRef | undefined {
  const matched = sources.filter((ref) => ref.kind === kind && ref.rank !== undefined);
  if (matched.length === 0) return undefined;
  return matched.reduce((best, ref) => (ref.rank! < best.rank! ? ref : best));
}

function weeklySource(sources: SourceRef[]): SourceRef | undefined {
  return sources.find((ref) => ref.kind === 'weekly' && ref.issue !== undefined);
}

function hoursText(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '近期';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  return `${Math.round(hours)} 小时`;
}

/** 推荐理由（一句中文，最多两个短句） */
export function buildReason(scored: ScoredCandidate, ctx: RecommendationContext): string {
  const { candidate } = scored;
  const growth = scored.growth ?? ctx.growth?.get(candidate.bvid) ?? null;
  const clauses: string[] = [];

  const weekly = weeklySource(candidate.sources);
  const ranking = bestRankedSource(candidate.sources, 'ranking');
  const regionRanking = bestRankedSource(candidate.sources, 'regionRanking');

  if (weekly) {
    clauses.push(`B站每周必看第 ${weekly.issue} 期`);
  } else if (ranking) {
    clauses.push(`全站排行榜第 ${ranking.rank} 名`);
  } else if (regionRanking) {
    const region = regionRanking.regionName ?? candidate.parentRegion;
    clauses.push(`${region}排行第 ${regionRanking.rank} 名`);
  }

  if (growth && growth.view > 0 && clauses.length < 2) {
    const amount = formatCount(growth.view);
    clauses.push(
      growth.estimated
        ? `发布以来日均 +${amount} 播放（估算）`
        : `近 ${hoursText(growth.hours)}播放 +${amount}`,
    );
  }

  const profile = ctx.profile;
  if (profile && clauses.length < 2) {
    const upAffinity = upAffinityOf(profile, candidate.owner.mid);
    const regionAffinity = affinityOf(profile, candidate.parentRegion);
    const tag = bestTagMatch(candidate, profile);
    if (isFollowedUp(profile, candidate.owner.mid) && candidate.owner.name) {
      clauses.push(`你关注的 UP 主「${candidate.owner.name}」`);
    } else if (isFavoriteUp(profile, candidate.owner.mid) && candidate.owner.name) {
      clauses.push(`你收藏过「${candidate.owner.name}」的视频`);
    } else if (upAffinity >= 0.5 && candidate.owner.name) {
      clauses.push(`你常看 UP 主「${candidate.owner.name}」`);
    } else if (regionAffinity >= 0.5 && candidate.parentRegion !== '其他') {
      clauses.push(`你常看「${candidate.parentRegion}」`);
    } else if (tag && tag.weight >= 0.6) {
      clauses.push(`和「${tag.term}」相关`);
    }
  }

  if (clauses.length === 0) {
    if (candidate.sources.some((ref) => ref.kind === 'rcmd')) {
      return '根据你的观看偏好推荐';
    }
    if (candidate.sources.some((ref) => ref.kind === 'related')) {
      return '因为你常看相似视频';
    }
    if (candidate.sources.some((ref) => ref.kind === 'popular')) {
      return `热门视频 · ${formatCount(candidate.stat.view)} 播放`;
    }
    return '为你精选';
  }
  return clauses.slice(0, 2).join('，');
}

/** 角标（最多 3 个） */
export function buildBadges(scored: ScoredCandidate, ctx: RecommendationContext): string[] {
  const { candidate } = scored;
  const growth = scored.growth ?? ctx.growth?.get(candidate.bvid) ?? null;
  const badges: string[] = [];

  const weekly = weeklySource(candidate.sources);
  if (weekly) badges.push(`每周必看`);

  const ranking = bestRankedSource(candidate.sources, 'ranking');
  if (ranking && ranking.rank !== undefined) {
    badges.push(ranking.rank <= 10 ? `全站 TOP${ranking.rank}` : '排行榜');
  }
  const regionRanking = bestRankedSource(candidate.sources, 'regionRanking');
  if (regionRanking && regionRanking.rank !== undefined && regionRanking.rank <= 10) {
    badges.push(`${regionRanking.regionName ?? candidate.parentRegion} TOP${regionRanking.rank}`);
  }

  if (growth && growth.view > 0) {
    const amount = formatCount(growth.view);
    badges.push(growth.estimated ? `估算 +${amount}` : `实测 +${amount}`);
  }

  if (ctx.profile) {
    if (isFollowedUp(ctx.profile, candidate.owner.mid)) {
      badges.push('关注 UP');
    } else if (isFavoriteUp(ctx.profile, candidate.owner.mid)) {
      badges.push('收藏相关');
    }
    const tag = bestTagMatch(candidate, ctx.profile);
    if (tag && tag.weight >= 0.6) {
      const label = tag.term.length > 8 ? `${tag.term.slice(0, 8)}…` : tag.term;
      badges.push(`#${label}`);
    }
    if (upAffinityOf(ctx.profile, candidate.owner.mid) >= 0.6) badges.push('常看 UP');
  }

  // 去重 + 截断；来源兜底保证角标非空
  const unique: string[] = [];
  for (const badge of badges) {
    if (!badge) continue;
    if (unique.includes(badge)) continue;
    unique.push(badge);
    if (unique.length >= 3) break;
  }
  if (unique.length === 0) {
    unique.push(SOURCE_LABELS[candidate.sources[0]?.kind ?? 'popular']);
  }
  return unique;
}

/** ScoredCandidate -> UI 使用的 Recommendation */
export function toRecommendation(
  scored: ScoredCandidate,
  ctx: RecommendationContext,
): Recommendation {
  const { candidate } = scored;
  return {
    bvid: candidate.bvid,
    title: candidate.title,
    cover: candidate.cover,
    duration: candidate.duration,
    pubdate: candidate.pubdate,
    owner: candidate.owner,
    stat: candidate.stat,
    tname: candidate.tname,
    parentRegion: candidate.parentRegion,
    score: scored.score,
    sources: candidate.sources,
    reason: buildReason(scored, ctx),
    badges: buildBadges(scored, ctx),
    growth: scored.growth ?? null,
  };
}
