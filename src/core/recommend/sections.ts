/**
 * 分组：把打分结果组装成「今日必看 / 分区板块 / 增长榜 / 每周必看精选」。
 *
 * 规则（与实施计划一致）：
 * - 今日必看 6 条：同一分区 ≤2 条、同一 UP ≤2 条
 * - 分区板块最多 5 个；每个板块 2–5 条（默认 3 条），同一 UP 每板块最多 1 条，
 *   且分数需达到 SECTION_MIN_SCORE
 * - 增长榜：有增长数据的视频，实测优先于估算
 * - 每周必看精选：来源含 weekly 的视频，最新一期优先
 * - 同一天、同一 mid 结果稳定；排除「不感兴趣」与「换一批」已展示的视频
 */
import { SECTION_MIN_SCORE } from '../../shared/constants';
import type { Profile, Recommendation, Section, Settings } from '../../shared/types';
import { sortScored, type ScoredCandidate } from './score';
import { toRecommendation, type RecommendationContext } from './reasons';

export const SECTION_CONFIG = {
  /** 今日必看条数 */
  todaySize: 6,
  /** 今日必看同一分区上限 */
  todayPerRegion: 2,
  /** 今日必看同一 UP 上限 */
  todayPerUp: 2,
  /** 最多几个一级分区板块 */
  maxRegionSections: 5,
  /** 分区板块内同一 UP 最多条数（硬约束：每板块每 UP 只放 1 条） */
  perUpPerSection: 1,
  /** 分区板块最少条数（不足则整个板块不展示） */
  minSectionItems: 2,
  /** 分区板块最多条数（设置上限也是 5） */
  maxSectionItems: 5,
  /** 增长榜条数 */
  growthSize: 6,
  /** 每周必看精选条数 */
  weeklySize: 6,
} as const;

export interface BuildSectionsInput {
  scored: ScoredCandidate[];
  profile: Profile | null;
  settings: Settings;
  nowMs: number;
  mode: 'full' | 'public';
  /** 稳定散列种子，建议 `${date}:${mid ?? 'anon'}` */
  seedKey: string;
  /** 排除的 bvid（不感兴趣 / 换一批已展示） */
  excluded?: ReadonlySet<string>;
  /** 推荐理由上下文（增长信息已挂在 scored 上，profile 用于兴趣文案） */
  context?: RecommendationContext;
}

interface PickLimits {
  /** 同一分区上限 */
  perRegion?: number;
  /** 同一 UP 上限 */
  perUp?: number;
  /** 该板块内已使用的 UP（每板块最多 1 个时直接跳过） */
  sectionUps?: ReadonlySet<number>;
  /** 最低分 */
  minScore?: number;
}

/** 按限制从池中挑选若干条（池需已排序） */
export function pickItems(
  pool: ScoredCandidate[],
  count: number,
  limits: PickLimits = {},
): ScoredCandidate[] {
  const picked: ScoredCandidate[] = [];
  const regionCount = new Map<string, number>();
  const upCount = new Map<number, number>();
  for (const item of pool) {
    if (picked.length >= count) break;
    if (limits.minScore !== undefined && item.score < limits.minScore) continue;
    const region = item.candidate.parentRegion;
    if (limits.perRegion !== undefined && (regionCount.get(region) ?? 0) >= limits.perRegion) {
      continue;
    }
    const mid = item.candidate.owner.mid;
    if (mid > 0) {
      if (limits.sectionUps?.has(mid)) continue;
      if (limits.perUp !== undefined && (upCount.get(mid) ?? 0) >= limits.perUp) continue;
    }
    picked.push(item);
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
    if (mid > 0) upCount.set(mid, (upCount.get(mid) ?? 0) + 1);
  }
  return picked;
}

function sectionOf(
  scoredItems: ScoredCandidate[],
  spec: Pick<Section, 'id' | 'title' | 'subtitle' | 'kind'>,
  context: RecommendationContext,
): Section {
  const items: Recommendation[] = scoredItems.map((scored) => toRecommendation(scored, context));
  return { ...spec, items };
}

/** 分区板块的展示顺序：画像亲和度优先，其次池内最好成绩 */
function orderRegions(
  candidatesByRegion: Map<string, ScoredCandidate[]>,
  profile: Profile | null,
): string[] {
  const affinity = new Map<string, number>();
  for (const row of profile?.regions ?? []) affinity.set(row.name, row.affinity);
  return [...candidatesByRegion.entries()]
    .map(([region, pool]) => ({
      region,
      affinity: affinity.get(region) ?? 0,
      best: pool[0]?.score ?? 0,
    }))
    .sort(
      (a, b) =>
        b.affinity - a.affinity || b.best - a.best || a.region.localeCompare(b.region, 'zh-CN'),
    )
    .map((row) => row.region);
}

/**
 * 组装全部板块。
 */
export function buildSections(input: BuildSectionsInput): Section[] {
  const { settings, profile, context } = input;
  const recommendationContext: RecommendationContext = context ?? { profile };
  const excluded = input.excluded ?? new Set<string>();
  const sorted = sortScored(
    input.scored.filter((item) => !excluded.has(item.candidate.bvid)),
    input.seedKey,
  );
  if (sorted.length === 0) return [];

  const sections: Section[] = [];
  const usedBvids = new Set<string>();

  /* ---------------- 今日必看 ---------------- */
  const todayPicks = pickItems(sorted, SECTION_CONFIG.todaySize, {
    perRegion: SECTION_CONFIG.todayPerRegion,
    perUp: SECTION_CONFIG.todayPerUp,
  });
  for (const item of todayPicks) usedBvids.add(item.candidate.bvid);
  const todaySubtitle =
    input.mode === 'public'
      ? '公开模式：热门 / 排行榜 / 每周必看'
      : '结合你的观看偏好，每天 6 条';
  sections.push(
    sectionOf(todayPicks, {
      id: 'today',
      title: '今日必看',
      subtitle: todaySubtitle,
      kind: 'global',
    }, recommendationContext),
  );

  /* ---------------- 分区板块 ---------------- */
  const byRegion = new Map<string, ScoredCandidate[]>();
  for (const item of sorted) {
    const region = item.candidate.parentRegion;
    if (region === '其他') continue;
    const pool = byRegion.get(region);
    if (pool) pool.push(item);
    else byRegion.set(region, [item]);
  }
  for (const pool of byRegion.values()) pool.sort((a, b) => b.score - a.score);

  const regionLimit = Math.min(
    SECTION_CONFIG.maxRegionSections,
    Math.max(2, settings.regionSections),
  );
  const sectionSize = Math.min(
    SECTION_CONFIG.maxSectionItems,
    Math.max(2, settings.perSection),
  );
  let regionSectionCount = 0;
  for (const region of orderRegions(byRegion, profile)) {
    if (regionSectionCount >= regionLimit) break;
    const pool = byRegion.get(region) ?? [];
    // 先排除今日必看已经出现的视频，保证板块内容有增量；
    // 同 UP 硬约束：每板块每 UP 最多 1 条（由 pickItems 的 perUp 统计本次已选列表）
    let picks = pickItems(
      pool.filter((item) => !usedBvids.has(item.candidate.bvid)),
      sectionSize,
      { perUp: SECTION_CONFIG.perUpPerSection, minScore: SECTION_MIN_SCORE },
    );
    if (picks.length < SECTION_CONFIG.minSectionItems) {
      // 候选不够时允许与今日必看重复，但同样每 UP 最多 1 条
      picks = pickItems(pool, sectionSize, {
        perUp: SECTION_CONFIG.perUpPerSection,
        minScore: SECTION_MIN_SCORE,
      });
    }
    if (picks.length < SECTION_CONFIG.minSectionItems) continue;
    for (const item of picks) usedBvids.add(item.candidate.bvid);
    const affinity = profile?.regions.find((row) => row.name === region)?.affinity ?? 0;
    const subtitle =
      affinity > 0 ? `你的偏好 ${Math.round(affinity * 100)}%` : '本周值得一看';
    sections.push(
      sectionOf(picks, {
        id: `region:${region}`,
        title: `${region}精选`,
        subtitle,
        kind: 'region',
      }, recommendationContext),
    );
    regionSectionCount += 1;
  }

  /* ---------------- 增长榜 ---------------- */
  const growthPool = sorted.filter(
    (item) => item.growth && item.growth.view > 0,
  );
  // 实测优先，其次按综合分
  growthPool.sort((a, b) => {
    const estimatedA = a.growth?.estimated ? 1 : 0;
    const estimatedB = b.growth?.estimated ? 1 : 0;
    if (estimatedA !== estimatedB) return estimatedA - estimatedB;
    return b.score - a.score;
  });
  let growthPicks = pickItems(
    growthPool.filter((item) => !usedBvids.has(item.candidate.bvid)),
    SECTION_CONFIG.growthSize,
  );
  if (growthPicks.length < SECTION_CONFIG.minSectionItems) {
    growthPicks = pickItems(growthPool, SECTION_CONFIG.growthSize);
  }
  if (growthPicks.length > 0) {
    for (const item of growthPicks) usedBvids.add(item.candidate.bvid);
    sections.push(
      sectionOf(growthPicks, {
        id: 'growth',
        title: '增长榜',
        subtitle: '近 24 小时播放增长（含估算）',
        kind: 'growth',
      }, recommendationContext),
    );
  }

  /* ---------------- 每周必看精选 ---------------- */
  const weeklyPool = sorted
    .filter((item) => item.candidate.sources.some((ref) => ref.kind === 'weekly'))
    .sort((a, b) => {
      const issueA = weeklyIssueOf(a);
      const issueB = weeklyIssueOf(b);
      if (issueA !== issueB) return issueB - issueA;
      const rankA = weeklyRankOf(a);
      const rankB = weeklyRankOf(b);
      if (rankA !== rankB) return rankA - rankB;
      return b.score - a.score;
    });
  let weeklyPicks = pickItems(
    weeklyPool.filter((item) => !usedBvids.has(item.candidate.bvid)),
    SECTION_CONFIG.weeklySize,
  );
  if (weeklyPicks.length < SECTION_CONFIG.minSectionItems) {
    weeklyPicks = pickItems(weeklyPool, SECTION_CONFIG.weeklySize);
  }
  if (weeklyPicks.length > 0) {
    const latestIssue = weeklyPicks.reduce((max, item) => Math.max(max, weeklyIssueOf(item)), 0);
    sections.push(
      sectionOf(weeklyPicks, {
        id: 'weekly',
        title: '每周必看精选',
        subtitle: latestIssue > 0 ? `B站第 ${latestIssue} 期 · 精选` : 'B站每周必看精选',
        kind: 'weekly',
      }, recommendationContext),
    );
  }

  return sections;
}

function weeklyIssueOf(item: ScoredCandidate): number {
  let issue = 0;
  for (const ref of item.candidate.sources) {
    if (ref.kind === 'weekly' && ref.issue !== undefined) issue = Math.max(issue, ref.issue);
  }
  return issue;
}

function weeklyRankOf(item: ScoredCandidate): number {
  let rank = Number.POSITIVE_INFINITY;
  for (const ref of item.candidate.sources) {
    if (ref.kind === 'weekly' && ref.rank !== undefined) rank = Math.min(rank, ref.rank);
  }
  return rank;
}

/** 当日结果涉及的全部 bvid（用于「换一批」排除已展示） */
export function collectSectionBvids(sections: Section[]): string[] {
  const bvids: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      if (seen.has(item.bvid)) continue;
      seen.add(item.bvid);
      bvids.push(item.bvid);
    }
  }
  return bvids;
}
