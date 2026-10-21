import { describe, expect, it } from 'vitest';
import { DAY } from '../../../src/shared/time';
import type { InterestSignals } from '../../../src/shared/types';
import {
  buildProfile,
  buildTagIndex,
  filterByTagWindow,
  filterByWindow,
  isFavoriteUp,
  isFollowedUp,
  percentileOf,
  profileSummaryOf,
  upAffinityOf,
  affinityOf,
} from '../../../src/core/profile/build';
import {
  buildTagRows,
  cleanTitle,
  isUsableTerm,
  lengthWeight,
  tokenizeTitle,
  weightedTermsOfTitle,
} from '../../../src/core/profile/tags';
import {
  completionOf,
  engagementFactor,
  historyWeight,
  pickHighQualityHistory,
  recencyFactor,
} from '../../../src/core/profile/weights';
import { FIXTURE_NOW, makeHistoryRecord } from './helpers';

const NOW_SEC = Math.floor(FIXTURE_NOW / 1000);

describe('profile/weights 权重公式', () => {
  it('recency = exp(-ageDays/10)', () => {
    expect(recencyFactor(NOW_SEC, FIXTURE_NOW)).toBeCloseTo(1, 6);
    expect(recencyFactor(NOW_SEC - 10 * 86400, FIXTURE_NOW)).toBeCloseTo(Math.exp(-1), 6);
    expect(recencyFactor(NOW_SEC - 30 * 86400, FIXTURE_NOW)).toBeCloseTo(Math.exp(-3), 6);
  });

  it('近 7 天 ×2，progress < 15 秒 ×0.2', () => {
    const full = makeHistoryRecord({ viewedAt: NOW_SEC, duration: 100, progress: 100 });
    // recency=1，engagement=1，近期 ×2
    expect(historyWeight(full, FIXTURE_NOW)).toBeCloseTo(2, 6);

    const old = makeHistoryRecord({
      viewedAt: NOW_SEC - 10 * 86400,
      duration: 100,
      progress: 100,
    });
    expect(historyWeight(old, FIXTURE_NOW)).toBeCloseTo(Math.exp(-1), 6);

    const skipped = makeHistoryRecord({ viewedAt: NOW_SEC, duration: 10, progress: 10 });
    // 时长 10 秒看完：completion=1；progress<15 秒 ×0.2，engagement=0.2；近期 ×2
    expect(historyWeight(skipped, FIXTURE_NOW)).toBeCloseTo(0.4, 6);
  });

  it('完播率参与 engagement', () => {
    expect(completionOf(makeHistoryRecord({ duration: 0, progress: 0 }))).toBeNull();
    expect(completionOf(makeHistoryRecord({ duration: 100, progress: 50 }))).toBeCloseTo(0.5, 6);
    expect(completionOf(makeHistoryRecord({ duration: 100, progress: 200 }))).toBe(1);
    const half = makeHistoryRecord({ viewedAt: NOW_SEC, duration: 100, progress: 50 });
    // 0.4 + 0.6×0.5 = 0.7；×2
    expect(historyWeight(half, FIXTURE_NOW)).toBeCloseTo(1.4, 6);
    expect(engagementFactor(half)).toBeCloseTo(0.7, 6);
  });

  it('pickHighQualityHistory 优先近期高完播，并尽量不同 UP', () => {
    const records = [
      makeHistoryRecord({ bvid: 'BVq1', viewedAt: NOW_SEC - 3600, progress: 280, duration: 300, authorMid: 1 }),
      makeHistoryRecord({ bvid: 'BVq2', viewedAt: NOW_SEC - 7200, progress: 270, duration: 300, authorMid: 1 }),
      makeHistoryRecord({ bvid: 'BVq3', viewedAt: NOW_SEC - 3600, progress: 200, duration: 300, authorMid: 2 }),
      makeHistoryRecord({ bvid: 'BVq4', viewedAt: NOW_SEC - 40 * 86400, progress: 300, duration: 300, authorMid: 3 }),
      makeHistoryRecord({ bvid: 'BVq5', viewedAt: NOW_SEC - 3600, progress: 5, duration: 300, authorMid: 4 }),
    ];
    const picked = pickHighQualityHistory(records, FIXTURE_NOW, 2);
    expect(picked).toHaveLength(2);
    // 同 UP 的第二条让位给不同作者
    expect(picked.map((row) => row.bvid)).toEqual(['BVq1', 'BVq3']);
    // 点开就走的记录不会被选为种子
    expect(pickHighQualityHistory(records, FIXTURE_NOW, 5).some((row) => row.bvid === 'BVq5')).toBe(false);
  });
});

describe('profile/tags 分词与标签', () => {
  it('停用词、单字、纯数字会被过滤', () => {
    expect(isUsableTerm('的')).toBe(false);
    expect(isUsableTerm('视频')).toBe(false);
    expect(isUsableTerm('合集')).toBe(false);
    expect(isUsableTerm('12345')).toBe(false);
    expect(isUsableTerm('100万')).toBe(false);
    expect(isUsableTerm('游戏')).toBe(true);
    expect(isUsableTerm('minecraft')).toBe(true);
    expect(isUsableTerm('a')).toBe(false);
  });

  it('cleanTitle 去掉括号与链接噪声', () => {
    expect(cleanTitle('【中字】一个视频https://b23.tv/xx|第2期')).not.toContain('https');
    expect(cleanTitle('【中字】一个视频')).toContain('一个视频');
  });

  it('分词结果包含主题词、去掉噪声词并小写化', () => {
    const terms = tokenizeTitle('【中字】Minecraft 建筑教学：从零开始的视频合集');
    expect(terms).toContain('minecraft');
    expect(terms).toContain('建筑');
    expect(terms.some((term) => term === '视频' || term === '合集' || term === '中字')).toBe(false);
    expect(terms.every((term) => term === term.toLowerCase())).toBe(true);
  });

  it('长度权重随词长增加，最多到 1', () => {
    expect(lengthWeight('ab')).toBeLessThan(lengthWeight('abcd'));
    expect(lengthWeight('abcdef')).toBeCloseTo(1, 6);
    expect(lengthWeight('abcdefgh')).toBeCloseTo(1, 6);
  });

  it('weightedTermsOfTitle 返回词条与权重', () => {
    const weighted = weightedTermsOfTitle('Minecraft 建筑教学');
    expect(weighted.length).toBeGreaterThan(0);
    expect(weighted.every((row) => row.weight > 0)).toBe(true);
    expect(weighted.map((row) => row.term)).toContain('minecraft');
  });

  it('buildTagRows 归一化到 0..1 并按权重排序', () => {
    const history = [
      makeHistoryRecord({ bvid: 'BVt1', title: 'Minecraft 建筑教学', viewedAt: NOW_SEC }),
      makeHistoryRecord({ bvid: 'BVt2', title: 'Minecraft 红石教学', viewedAt: NOW_SEC - 3600 }),
      makeHistoryRecord({ bvid: 'BVt3', title: '单机游戏速通', viewedAt: NOW_SEC - 7200 }),
    ];
    const rows = buildTagRows(history, FIXTURE_NOW);
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows.map((row) => row.weight))).toBeCloseTo(1, 4);
    expect(rows.every((row) => row.weight > 0 && row.weight <= 1)).toBe(true);
    expect(rows.every((row) => Number.isInteger(row.count) && row.count >= 1)).toBe(true);
    expect(rows.map((row) => row.weight)).toEqual([...rows.map((row) => row.weight)].sort((a, b) => b - a));
    expect(new Set(rows.map((row) => row.kind)).size).toBeGreaterThan(0);
    expect(buildTagRows(history, FIXTURE_NOW, { limit: 2 })).toHaveLength(2);
    expect(buildTagRows([], FIXTURE_NOW)).toEqual([]);
  });
});

describe('profile/build 画像聚合', () => {
  const history = [
    makeHistoryRecord({
      bvid: 'BVp1',
      title: 'Minecraft 建筑教学',
      viewedAt: NOW_SEC - 3600,
      parentRegion: '游戏',
      tname: '单机游戏',
      authorMid: 11,
      authorName: 'UP甲',
      duration: 100,
      progress: 100,
    }),
    makeHistoryRecord({
      bvid: 'BVp2',
      title: 'Minecraft 红石教学',
      viewedAt: NOW_SEC - 2 * 3600,
      parentRegion: '游戏',
      tname: '单机游戏',
      authorMid: 11,
      authorName: 'UP甲',
      duration: 300,
      progress: 150,
    }),
    makeHistoryRecord({
      bvid: 'BVp3',
      title: '历史科普 纪录片',
      viewedAt: NOW_SEC - 20 * 86400,
      parentRegion: '知识',
      tname: '人文历史',
      authorMid: 22,
      authorName: 'UP乙',
      duration: 1200,
      progress: 600,
    }),
    makeHistoryRecord({
      bvid: 'BVp4',
      title: '无法分类',
      viewedAt: NOW_SEC - 3600,
      parentRegion: '其他',
      tname: '国产动画',
      authorMid: 33,
      authorName: 'UP丙',
      duration: 200,
      progress: 200,
    }),
  ];

  it('分区亲和归一化，其他不计入', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW, mid: 12345, uname: '测试' });
    expect(profile.mid).toBe(12345);
    expect(profile.regions[0]!.name).toBe('游戏');
    expect(profile.regions[0]!.affinity).toBeCloseTo(1, 4);
    expect(profile.regions.some((row) => row.name === '其他')).toBe(false);
    expect(profile.regions.find((row) => row.name === '知识')!.affinity).toBeLessThan(1);
    expect(affinityOf(profile, '游戏')).toBe(1);
    expect(affinityOf(profile, '其他')).toBe(0);
    expect(affinityOf(null, '游戏')).toBe(0);
  });

  it('UP 亲和、样本统计、完播率、时长偏好', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW });
    expect(profile.ups[0]!.mid).toBe(11);
    expect(profile.ups[0]!.name).toBe('UP甲');
    expect(profile.ups[0]!.affinity).toBe(1);
    expect(upAffinityOf(profile, 11)).toBe(1);
    expect(upAffinityOf(profile, 999)).toBe(0);
    expect(upAffinityOf(null, 11)).toBe(0);

    expect(profile.sample.total).toBe(4);
    expect(profile.sample.last7d).toBe(3);
    expect(profile.sample.windowDays).toBe(90);
    // 进度样本：(1 + 0.5 + 0.5 + 1) / 4 = 0.75；知识那条 progress 600/1200=0.5
    expect(profile.completionRate).toBeCloseTo(0.75, 4);
    expect(profile.avgDuration).toBe(450);
    expect(profile.preferredDuration.p10).toBeGreaterThanOrEqual(100);
    expect(profile.preferredDuration.p90).toBeGreaterThanOrEqual(profile.preferredDuration.p10);
  });

  it('24 维时段直方图归一化', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW });
    expect(profile.hours).toHaveLength(24);
    expect(Math.max(...profile.hours)).toBeCloseTo(1, 4);
    expect(profile.hours.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('标签统计窗口 7d/all 生效', () => {
    const records = [
      makeHistoryRecord({ bvid: 'BVw1', title: 'newterm 记录', viewedAt: NOW_SEC - 3600 }),
      makeHistoryRecord({ bvid: 'BVw2', title: 'oldterm 记录', viewedAt: NOW_SEC - 20 * 86400 }),
    ];
    const recent = buildProfile({ history: records, nowMs: FIXTURE_NOW, tagWindow: '7d' });
    const all = buildProfile({ history: records, nowMs: FIXTURE_NOW, tagWindow: 'all' });
    const recentTerms = recent.tags.map((row) => row.term);
    const allTerms = all.tags.map((row) => row.term);
    expect(recentTerms).toContain('newterm');
    expect(recentTerms).not.toContain('oldterm');
    expect(allTerms).toContain('oldterm');
    // 标签窗口只影响标签，不影响样本统计
    expect(recent.sample.total).toBe(2);
  });

  it('空历史返回稳定空画像', () => {
    const profile = buildProfile({ history: [], nowMs: FIXTURE_NOW });
    expect(profile.regions).toEqual([]);
    expect(profile.tags).toEqual([]);
    expect(profile.ups).toEqual([]);
    expect(profile.hours).toHaveLength(24);
    expect(profile.completionRate).toBe(0);
    expect(profile.avgDuration).toBe(0);
    expect(profile.preferredDuration).toEqual({ p10: 0, p90: 0 });
    expect(profile.sample.total).toBe(0);
  });

  it('画像摘要与标签索引', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW });
    const summary = profileSummaryOf(profile);
    expect(summary.topRegions.length).toBeLessThanOrEqual(5);
    expect(summary.topTags.length).toBeLessThanOrEqual(10);
    expect(profileSummaryOf(null)).toEqual({ topRegions: [], topTags: [] });
    const index = buildTagIndex(profile);
    expect(index.size).toBe(profile.tags.length);
    expect(buildTagIndex(null).size).toBe(0);
  });

  it('窗口过滤与分位数函数', () => {
    expect(filterByWindow(history, FIXTURE_NOW, 7).every((row) => NOW_SEC - row.viewedAt <= 7 * 86400)).toBe(true);
    expect(filterByTagWindow(history, '7d', FIXTURE_NOW)).toHaveLength(3);
    expect(filterByTagWindow(history, '30d', FIXTURE_NOW)).toHaveLength(4);
    expect(filterByTagWindow(history, 'all', FIXTURE_NOW)).toHaveLength(4);
    expect(percentileOf([], 0.5)).toBe(0);
    expect(percentileOf([100], 0.9)).toBe(100);
    expect(percentileOf([0, 10], 0.5)).toBe(5);
    expect(percentileOf([0, 10, 20, 30], 0.5)).toBe(15);
    expect(percentileOf([0, 10, 20, 30], 0)).toBe(0);
    expect(percentileOf([0, 10, 20, 30], 1)).toBe(30);
  });
});

describe('profile/weights 时间常量的合理性', () => {
  it('90 天前的记录权重接近 0', () => {
    const ancient = makeHistoryRecord({
      viewedAt: NOW_SEC - 90 * (DAY / 1000),
      duration: 100,
      progress: 100,
    });
    expect(historyWeight(ancient, FIXTURE_NOW)).toBeLessThan(0.001);
  });
});

describe('profile/build 只读信号合并（v0.2.0）', () => {
  const signals: InterestSignals = {
    fetchedAt: FIXTURE_NOW,
    mid: 12345,
    favoriteFolders: 2,
    favoriteCount: 120,
    favoriteSampled: 40,
    favoriteUps: [{ mid: 555, name: '收藏UP', count: 4 }],
    favoriteTags: [{ term: 'favoritekeyword', weight: 4, count: 4 }],
    followedTotal: 2,
    followed: [
      { mid: 777, name: '关注UP', mtime: 1_700_000_000 },
      { mid: 888, name: '关注UP2', mtime: 1_600_000_000 },
    ],
    watchLaterCount: 6,
    watchLaterSampled: 3,
    watchLaterRegions: [{ name: '音乐', weight: 3, count: 3 }],
    watchLaterTags: [{ term: 'watchlaterkeyword', weight: 3, count: 3 }],
    favoriteFallback: true,
  };

  const history = [
    makeHistoryRecord({
      bvid: 'BVsignalHistory',
      title: '历史主题',
      parentRegion: '游戏',
      tname: '手机游戏',
      authorMid: 111,
      authorName: '历史UP',
      duration: 100,
      progress: 100,
      viewedAt: NOW_SEC - 3600,
    }),
  ];

  it('收藏/关注 UP 与稍后再看分区按权重并入画像', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW, signals });
    const ups = profile.ups.map((row) => row.mid);
    expect(ups).toContain(555);
    expect(ups).toContain(777);
    expect(ups).toContain(888);
    // 收藏 UP 权重 4×1.5=6 最高；关注 3.0 次之；单条历史约 2.0
    expect(upAffinityOf(profile, 555)).toBeCloseTo(1, 4);
    expect(upAffinityOf(profile, 777)).toBeCloseTo(0.5, 4);
    expect(upAffinityOf(profile, 777)).toBeGreaterThan(upAffinityOf(profile, 111));
    // 稍后再看分区（3×1.2=3.6）超过单条历史权重，成为最高分区
    expect(affinityOf(profile, '音乐')).toBeCloseTo(1, 4);
    expect(affinityOf(profile, '游戏')).toBeGreaterThan(0);
    expect(affinityOf(profile, '游戏')).toBeLessThan(1);

    expect(isFollowedUp(profile, 777)).toBe(true);
    expect(isFollowedUp(profile, 888)).toBe(true);
    expect(isFollowedUp(profile, 999)).toBe(false);
    expect(isFollowedUp(null, 777)).toBe(false);
    expect(isFavoriteUp(profile, 555)).toBe(true);
    expect(isFavoriteUp(profile, 999)).toBe(false);
    expect(isFavoriteUp(null, 555)).toBe(false);
  });

  it('收藏/稍后再看标签合并进 tags，并产出 Profile.signals', () => {
    const profile = buildProfile({
      history,
      nowMs: FIXTURE_NOW,
      signals,
      tagWindow: 'all',
    });
    const terms = profile.tags.map((row) => row.term);
    expect(terms).toContain('favoritekeyword');
    expect(terms).toContain('watchlaterkeyword');
    expect(profile.tags.every((row) => row.weight >= 0 && row.weight <= 1)).toBe(true);

    expect(profile.signals).toBeDefined();
    expect(profile.signals!.fetchedAt).toBe(FIXTURE_NOW);
    expect(profile.signals!.favoriteFolders).toBe(2);
    expect(profile.signals!.favoriteCount).toBe(120);
    expect(profile.signals!.favoriteSampled).toBe(40);
    expect(profile.signals!.followedMids).toEqual([777, 888]);
    expect(profile.signals!.followedTotal).toBe(2);
    expect(profile.signals!.followedUps.find((row) => row.mid === 777)?.followedAt).toBe(
      1_700_000_000_000,
    );
    expect(profile.signals!.favoriteUps[0]).toMatchObject({ mid: 555, count: 4 });
    expect(profile.signals!.favoriteUps[0]!.affinity).toBe(1);
    expect(profile.signals!.favoriteTags.some((row) => row.term === 'favoritekeyword')).toBe(true);
    expect(profile.signals!.watchLaterRegions[0]!.name).toBe('音乐');
    expect(profile.signals!.watchLaterTags.some((row) => row.term === 'watchlaterkeyword')).toBe(true);
    expect(profile.signals!.watchLaterCount).toBe(6);
    expect(profile.signals!.watchLaterSampled).toBe(3);
    expect(profile.signals!.favoriteFallback).toBe(true);
  });

  it('无信号时不产出 signals 字段（旧画像兼容）', () => {
    const profile = buildProfile({ history, nowMs: FIXTURE_NOW });
    expect(profile.signals).toBeUndefined();
    expect(isFollowedUp(profile, 777)).toBe(false);
    expect(isFavoriteUp(profile, 555)).toBe(false);
  });

  it('仅信号、无历史也能得到 UP 与标签', () => {
    const profile = buildProfile({ history: [], nowMs: FIXTURE_NOW, signals });
    expect(profile.sample.total).toBe(0);
    expect(profile.ups.length).toBeGreaterThan(0);
    expect(profile.tags.some((row) => row.term === 'favoritekeyword')).toBe(true);
    expect(profile.signals!.followedMids).toEqual([777, 888]);
  });
});
