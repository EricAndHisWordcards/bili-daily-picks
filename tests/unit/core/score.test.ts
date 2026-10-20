import { describe, expect, it } from 'vitest';
import { PENALTIES, SECTION_MIN_SCORE } from '../../../src/shared/constants';
import type { Candidate, GrowthInfo, InterestSignals, Profile } from '../../../src/shared/types';
import {
  bestTagMatch,
  curationScore,
  durationPenalty,
  freshnessScore,
  interestScore,
  penaltyFor,
  recentPicksPenalty,
  scoreCandidates,
  sortScored,
  type ScoredCandidate,
} from '../../../src/core/recommend/score';
import { buildReason, buildBadges, toRecommendation } from '../../../src/core/recommend/reasons';
import { buildPercentile, clamp01, percentileOf, round } from '../../../src/core/recommend/percentile';
import { buildProfile } from '../../../src/core/profile/build';
import { FIXTURE_NOW, makeCandidate, makeGrowth, makeProfile } from './helpers';

const NOW_SEC = Math.floor(FIXTURE_NOW / 1000);

describe('recommend/percentile', () => {
  it('百分位：最小 0、最大 1、中间线性', () => {
    const p = buildPercentile([10, 20, 30, 40]);
    expect(p(10)).toBeCloseTo(0, 6);
    expect(p(40)).toBeCloseTo(1, 6);
    expect(p(20)).toBeCloseTo(1 / 3, 6);
    expect(p(30)).toBeCloseTo(2 / 3, 6);
  });

  it('并列取平均名次；单值返回 1；空集返回 0', () => {
    const p = buildPercentile([5, 5, 5]);
    expect(p(5)).toBeCloseTo(0.5, 6);
    expect(buildPercentile([7])(7)).toBe(1);
    expect(buildPercentile([])(1)).toBe(0);
    expect(percentileOf([1, 2, 3], 3)).toBeCloseTo(1, 6);
  });

  it('clamp01 / round 工具', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(round(0.123456, 3)).toBe(0.123);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('recommend/score 分项', () => {
  it('兴趣分：公开模式中性，有画像时按分区/UP/标签加权', () => {
    const candidate = makeCandidate({ bvid: 'BVi1', parentRegion: '游戏' });
    expect(interestScore(candidate, null)).toBe(0.5);
    expect(interestScore(candidate, makeProfile())).toBeCloseTo(0.55, 4);

    const profile: Profile = {
      ...makeProfile(),
      tags: [{ term: 'minecraft', weight: 1, count: 2, kind: 'title' }],
      ups: [{ mid: 1000, name: 'UP主', affinity: 1, count: 3 }],
    };
    const rich = makeCandidate({
      bvid: 'BVi2',
      title: 'Minecraft 建筑教学',
      parentRegion: '游戏',
      owner: { mid: 1000, name: 'UP主' },
    });
    const score = interestScore(rich, profile);
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThanOrEqual(1);
    expect(bestTagMatch(rich, profile)?.term).toBe('minecraft');
    expect(bestTagMatch(rich, null)).toBeNull();
  });

  it('策展分：每周必看 > 热门，榜单名次越高分越高，多来源略加', () => {
    const weekly = makeCandidate({ bvid: 'BVc1', sources: [{ kind: 'weekly', issue: 395, rank: 5 }] });
    const popular = makeCandidate({ bvid: 'BVc2', sources: [{ kind: 'popular' }] });
    expect(curationScore(weekly)).toBeGreaterThan(curationScore(popular));

    const top = makeCandidate({ bvid: 'BVc3', sources: [{ kind: 'ranking', rank: 1 }] });
    const low = makeCandidate({ bvid: 'BVc4', sources: [{ kind: 'ranking', rank: 90 }] });
    expect(curationScore(top)).toBeGreaterThan(curationScore(low));

    const multi = makeCandidate({
      bvid: 'BVc5',
      sources: [{ kind: 'ranking', rank: 1 }, { kind: 'popular' }, { kind: 'rcmd' }],
    });
    expect(curationScore(multi)).toBeGreaterThan(curationScore(top));
    expect(curationScore(multi)).toBeLessThanOrEqual(1);
  });

  it('新鲜度随时长衰减，且限制在 0..1', () => {
    const fresh = makeCandidate({ bvid: 'BVf1', pubdate: NOW_SEC - 3600 });
    const old = makeCandidate({ bvid: 'BVf2', pubdate: NOW_SEC - 30 * 86400 });
    expect(freshnessScore(fresh, FIXTURE_NOW)).toBeGreaterThan(freshnessScore(old, FIXTURE_NOW));
    expect(freshnessScore(fresh, FIXTURE_NOW)).toBeLessThanOrEqual(1);
    expect(freshnessScore(old, FIXTURE_NOW)).toBeGreaterThanOrEqual(0);
  });

  it('时长惩罚：偏离画像 p10/p90 区间才扣分', () => {
    const profile = makeProfile();
    profile.preferredDuration = { p10: 60, p90: 1200 };
    expect(durationPenalty(makeCandidate({ bvid: 'BVd1', duration: 10 }), profile)).toBe(
      PENALTIES.durationOutOfRange,
    );
    expect(durationPenalty(makeCandidate({ bvid: 'BVd2', duration: 5000 }), profile)).toBe(
      PENALTIES.durationOutOfRange,
    );
    expect(durationPenalty(makeCandidate({ bvid: 'BVd3', duration: 300 }), profile)).toBe(0);
    expect(durationPenalty(makeCandidate({ bvid: 'BVd4', duration: 300 }), null)).toBe(0);
  });

  it('重复推荐惩罚：2 天内 > 7 天内 > 无', () => {
    const candidate = makeCandidate({ bvid: 'BVp' });
    const ctx = (pickedAt?: Map<string, number>) => ({
      profile: null,
      nowMs: FIXTURE_NOW,
      pickedAt,
    });
    expect(recentPicksPenalty(candidate, ctx())).toBe(0);
    expect(recentPicksPenalty(candidate, ctx(new Map([['BVp', FIXTURE_NOW - 86400 * 1000]])))).toBe(
      PENALTIES.pickedWithin2Days,
    );
    expect(recentPicksPenalty(candidate, ctx(new Map([['BVp', FIXTURE_NOW - 5 * 86400 * 1000]])))).toBe(
      PENALTIES.pickedWithin7Days,
    );
    expect(recentPicksPenalty(candidate, ctx(new Map([['BVp', FIXTURE_NOW - 20 * 86400 * 1000]])))).toBe(0);
    expect(penaltyFor(candidate, ctx()).total).toBe(0);
  });
});

describe('recommend/score 综合打分', () => {
  const candidates: Candidate[] = [
    makeCandidate({
      bvid: 'BVhot',
      parentRegion: '游戏',
      pubdate: NOW_SEC - 3600,
      stat: { view: 5_000_000, like: 400_000, favorite: 300_000, coin: 100_000, reply: 20_000, danmaku: 50_000, share: 10_000 },
      owner: { mid: 1, name: '大UP' },
      sources: [{ kind: 'weekly', issue: 395, rank: 1 }],
    }),
    makeCandidate({
      bvid: 'BVmid',
      parentRegion: '知识',
      pubdate: NOW_SEC - 5 * 86400,
      stat: { view: 500_000, like: 20_000, favorite: 10_000, coin: 4_000, reply: 1_000, danmaku: 500, share: 300 },
      owner: { mid: 2, name: '中UP' },
      sources: [{ kind: 'popular' }],
    }),
    makeCandidate({
      bvid: 'BVcold',
      parentRegion: '音乐',
      pubdate: NOW_SEC - 45 * 86400,
      stat: { view: 1_000, like: 10, favorite: 5, coin: 1, reply: 1, danmaku: 1, share: 1 },
      owner: { mid: 3, name: '小UP' },
      sources: [{ kind: 'related' }],
    }),
  ];
  const growth = new Map<string, GrowthInfo>([
    ['BVhot', makeGrowth(200_000)],
    ['BVmid', makeGrowth(5_000)],
  ]);

  it('分数在 0..1，且质量/新鲜度高的排前面', () => {
    const scored = scoreCandidates(candidates, { profile: null, nowMs: FIXTURE_NOW, growth });
    expect(scored).toHaveLength(3);
    expect(scored.every((row) => row.score >= 0 && row.score <= 1)).toBe(true);
    expect(scored[0]!.candidate.bvid).toBe('BVhot');
    const cold = scored.find((row) => row.candidate.bvid === 'BVcold')!;
    expect(cold.score).toBeLessThan(scored[0]!.score);
    // growth 分项：无增长数据为 0
    expect(cold.parts.growth).toBe(0);
    expect(cold.growth).toBeNull();
  });

  it('同输入两次打分完全一致（确定性）', () => {
    const first = scoreCandidates(candidates, { profile: null, nowMs: FIXTURE_NOW, growth });
    const second = scoreCandidates(candidates, { profile: null, nowMs: FIXTURE_NOW, growth });
    expect(first.map((row) => [row.candidate.bvid, row.score])).toEqual(
      second.map((row) => [row.candidate.bvid, row.score]),
    );
  });

  it('已推荐惩罚会降低综合分', () => {
    const base = scoreCandidates(candidates, { profile: null, nowMs: FIXTURE_NOW, growth });
    const penalized = scoreCandidates(candidates, {
      profile: null,
      nowMs: FIXTURE_NOW,
      growth,
      pickedAt: new Map([['BVhot', FIXTURE_NOW - 86400 * 1000]]),
    });
    const before = base.find((row) => row.candidate.bvid === 'BVhot')!;
    const after = penalized.find((row) => row.candidate.bvid === 'BVhot')!;
    expect(after.score).toBeCloseTo(before.score - PENALTIES.pickedWithin2Days, 4);
  });

  it('sortScored 同分用稳定散列打散，重复调用一致', () => {
    const scored: ScoredCandidate[] = ['BVx1', 'BVx2', 'BVx3', 'BVx4'].map((bvid) => ({
      candidate: makeCandidate({ bvid }),
      score: 0.5,
      parts: { interest: 0, quality: 0, growth: 0, curation: 0, freshness: 0 },
      penalties: { recentPicks: 0, duration: 0, total: 0 },
      growth: null,
    }));
    const once = sortScored(scored, '2026-10-20:12345').map((row) => row.candidate.bvid);
    const twice = sortScored(scored, '2026-10-20:12345').map((row) => row.candidate.bvid);
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(4);
  });
});

describe('recommend/reasons 推荐理由与角标', () => {
  const profile: Profile = {
    ...makeProfile(),
    ups: [{ mid: 1000, name: 'UP主', affinity: 1, count: 3 }],
    tags: [{ term: 'minecraft', weight: 1, count: 2, kind: 'title' }],
  };

  function scoredOf(candidate: Candidate, growth?: GrowthInfo | null): ScoredCandidate {
    const [scored] = scoreCandidates([candidate], { profile: null, nowMs: FIXTURE_NOW });
    return { ...scored!, growth: growth ?? null };
  }

  it('每周必看 + 实测增长的文案与角标', () => {
    const candidate = makeCandidate({
      bvid: 'BVr1',
      parentRegion: '游戏',
      owner: { mid: 1000, name: 'UP主' },
      sources: [{ kind: 'weekly', issue: 395, rank: 2 }],
    });
    const scored = scoredOf(candidate, makeGrowth(50_000));
    const ctx = { profile, growth: new Map([['BVr1', makeGrowth(50_000)]]) };
    const recommendation = toRecommendation(scored, ctx);
    expect(recommendation.reason).toContain('每周必看');
    expect(recommendation.reason).toContain('395');
    expect(recommendation.badges).toContain('每周必看');
    expect(recommendation.badges.some((badge) => badge.includes('实测'))).toBe(true);
    expect(recommendation.badges.length).toBeLessThanOrEqual(3);
    expect(recommendation.growth?.estimated).toBe(false);
    expect(recommendation.score).toBeCloseTo(scored.score, 4);
  });

  it('估算增长角标与兜底理由', () => {
    const estimated = makeCandidate({
      bvid: 'BVr2',
      sources: [{ kind: 'rcmd' }],
      parentRegion: '其他',
    });
    const scored = scoredOf(estimated, makeGrowth(1234, 24, true));
    const recommendation = toRecommendation(scored, { profile: null });
    expect(recommendation.badges.some((badge) => badge.startsWith('估算'))).toBe(true);
    expect(buildReason(scored, { profile: null })).toBeTruthy();

    const popular = makeCandidate({ bvid: 'BVr3', sources: [{ kind: 'popular' }], parentRegion: '其他' });
    expect(buildReason(scoredOf(popular), { profile: null })).toContain('热门');
    expect(buildBadges(scoredOf(popular), { profile: null }).length).toBeGreaterThan(0);
  });

  it('兴趣相关理由：常看 UP / 常看分区 / 标签', () => {
    const rich = makeCandidate({
      bvid: 'BVr4',
      title: 'Minecraft 建筑教学',
      parentRegion: '游戏',
      owner: { mid: 1000, name: 'UP主' },
      sources: [{ kind: 'ranking', rank: 30 }],
    });
    const scored = scoredOf(rich);
    const reason = buildReason(scored, { profile });
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain('UP主');
    const sectionMin = SECTION_MIN_SCORE;
    expect(sectionMin).toBeGreaterThan(0);
  });
});

describe('recommend/score 关注/收藏 UP 兴趣与理由（v0.2.0）', () => {
  const signals: InterestSignals = {
    fetchedAt: FIXTURE_NOW,
    mid: 12345,
    favoriteFolders: 1,
    favoriteCount: 20,
    favoriteSampled: 20,
    favoriteUps: [{ mid: 555, name: '收藏UP', count: 4 }],
    favoriteTags: [],
    followedTotal: 1,
    followed: [{ mid: 777, name: '关注UP' }],
    watchLaterCount: 0,
    watchLaterSampled: 0,
    watchLaterRegions: [],
    watchLaterTags: [],
  };
  const signalProfile = buildProfile({ history: [], nowMs: FIXTURE_NOW, signals });

  it('关注的 UP 兴趣分更高，且理由/角标体现关注', () => {
    const followed = makeCandidate({
      bvid: 'BVfollow',
      title: '普通视频标题',
      parentRegion: '其他',
      owner: { mid: 777, name: '关注UP' },
    });
    const stranger = makeCandidate({
      bvid: 'BVstranger',
      title: '普通视频标题',
      parentRegion: '其他',
      owner: { mid: 999, name: '陌生UP' },
    });
    expect(interestScore(followed, signalProfile)).toBeGreaterThan(
      interestScore(stranger, signalProfile),
    );
    const scored = scoreCandidates([followed], {
      profile: signalProfile,
      nowMs: FIXTURE_NOW,
    })[0]!;
    const recommendation = toRecommendation(scored, { profile: signalProfile });
    expect(recommendation.reason).toContain('你关注的 UP 主');
    expect(recommendation.reason).toContain('关注UP');
    expect(recommendation.badges).toContain('关注 UP');
  });

  it('收藏过的 UP 理由/角标体现收藏', () => {
    const favorite = makeCandidate({
      bvid: 'BVfavorite',
      title: '普通视频标题',
      parentRegion: '其他',
      owner: { mid: 555, name: '收藏UP' },
    });
    const scored = scoreCandidates([favorite], {
      profile: signalProfile,
      nowMs: FIXTURE_NOW,
    })[0]!;
    const reason = buildReason(scored, { profile: signalProfile });
    expect(reason).toContain('你收藏过');
    expect(reason).toContain('收藏UP');
    expect(buildBadges(scored, { profile: signalProfile })).toContain('收藏相关');
  });

  it('无 signals 的旧画像不会产生关注/收藏文案', () => {
    const legacyProfile = makeProfile();
    const candidate = makeCandidate({
      bvid: 'BVlegacy',
      parentRegion: '其他',
      owner: { mid: 777, name: '关注UP' },
      sources: [{ kind: 'popular' }],
    });
    const scored = scoreCandidates([candidate], {
      profile: legacyProfile,
      nowMs: FIXTURE_NOW,
    })[0]!;
    const reason = buildReason(scored, { profile: legacyProfile });
    expect(reason).not.toContain('你关注的 UP 主');
    expect(buildBadges(scored, { profile: legacyProfile })).not.toContain('关注 UP');
  });
});
