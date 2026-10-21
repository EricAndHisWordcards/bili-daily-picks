import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SECTION_MIN_SCORE } from '../../../src/shared/constants';
import type { GrowthInfo, Settings, SourceRef } from '../../../src/shared/types';
import {
  SECTION_CONFIG,
  buildSections,
  collectSectionBvids,
  pickItems,
} from '../../../src/core/recommend/sections';
import type { ScoredCandidate } from '../../../src/core/recommend/score';
import { FIXTURE_NOW, makeCandidate, makeGrowth, makeProfile } from './helpers';

interface ScoredInput {
  bvid: string;
  score: number;
  region?: string;
  mid?: number;
  growth?: GrowthInfo | null;
  sources?: SourceRef[];
  pubdate?: number;
}

function scored(input: ScoredInput): ScoredCandidate {
  const candidate = makeCandidate({
    bvid: input.bvid,
    parentRegion: input.region ?? '游戏',
    owner: { mid: input.mid ?? 1000, name: `UP-${input.bvid}` },
    sources: input.sources ?? [{ kind: 'ranking', rank: 5 }],
    ...(input.pubdate !== undefined ? { pubdate: input.pubdate } : {}),
  });
  return {
    candidate,
    score: input.score,
    parts: { interest: 0, quality: 0, growth: 0, curation: 0, freshness: 0 },
    penalties: { recentPicks: 0, duration: 0, total: 0 },
    growth: input.growth ?? null,
  };
}

const regions = ['游戏', '生活', '知识', '音乐', '影视'] as const;
const regionCodes = ['g', 'l', 'k', 'm', 'y'] as const;

/** 5 个分区 × 3 条高分视频（0.95..0.81），外加低分填充与每周必看候选 */
function buildPool(): ScoredCandidate[] {
  const pool: ScoredCandidate[] = [];
  let score = 0.95;
  let mid = 100;
  regions.forEach((region, regionIndex) => {
    for (let j = 0; j < 3; j += 1) {
      pool.push(
        scored({
          bvid: `BV${regionCodes[regionIndex]}${j}`,
          score,
          region,
          mid: mid++,
          growth: makeGrowth(5000 - j * 100),
          sources: [{ kind: 'ranking', rank: regionIndex * 3 + j + 1 }],
        }),
      );
      score -= 0.01;
    }
  });
  // 低分填充（不满足 SECTION_MIN_SCORE，不应进入分区板块）
  for (let i = 0; i < 10; i += 1) {
    pool.push(scored({ bvid: `BVlow${i}`, score: 0.3 - i * 0.01, region: '游戏', mid: 9000 + i }));
  }
  // 每周必看候选（纪录片分区，分数低于高分项）
  for (let i = 0; i < 6; i += 1) {
    pool.push(
      scored({
        bvid: `BVweekly${i}`,
        score: 0.8 - i * 0.005,
        region: '纪录片',
        mid: 8000 + i,
        sources: [{ kind: 'weekly', issue: 395, rank: i + 1 }],
      }),
    );
  }
  return pool;
}

const settings: Settings = { ...DEFAULT_SETTINGS, perSection: 3, regionSections: 5 };

function build(pool: ScoredCandidate[], extra: Partial<Parameters<typeof buildSections>[0]> = {}) {
  return buildSections({
    scored: pool,
    profile: makeProfile(),
    settings,
    nowMs: FIXTURE_NOW,
    mode: 'full',
    seedKey: '2026-10-20:12345',
    ...extra,
  });
}

describe('recommend/sections 今日必看', () => {
  it('固定 6 条，同分区 ≤2、同 UP ≤2', () => {
    const sections = build(buildPool());
    const today = sections[0]!;
    expect(today.id).toBe('today');
    expect(today.kind).toBe('global');
    expect(today.items).toHaveLength(SECTION_CONFIG.todaySize);

    const regionCount = new Map<string, number>();
    const upCount = new Map<number, number>();
    for (const item of today.items) {
      regionCount.set(item.parentRegion, (regionCount.get(item.parentRegion) ?? 0) + 1);
      upCount.set(item.owner.mid, (upCount.get(item.owner.mid) ?? 0) + 1);
    }
    expect(Math.max(...regionCount.values())).toBeLessThanOrEqual(SECTION_CONFIG.todayPerRegion);
    expect(Math.max(...upCount.values())).toBeLessThanOrEqual(SECTION_CONFIG.todayPerUp);
  });

  it('切到公开模式时标题副文案不同，且条目结构不变', () => {
    const publicSections = build(buildPool(), { mode: 'public', profile: null });
    expect(publicSections[0]!.subtitle).toContain('公开模式');
    expect(publicSections[0]!.items).toHaveLength(SECTION_CONFIG.todaySize);
  });
});

describe('recommend/sections 分区板块', () => {
  it('最多 5 个板块，每板块 2–5 条，同 UP 唯一，分数达标', () => {
    const sections = build(buildPool());
    const regionSections = sections.filter((section) => section.kind === 'region');
    expect(regionSections.length).toBeGreaterThanOrEqual(2);
    expect(regionSections.length).toBeLessThanOrEqual(SECTION_CONFIG.maxRegionSections);

    for (const section of regionSections) {
      const region = section.id.replace('region:', '');
      expect(section.items.length).toBeGreaterThanOrEqual(SECTION_CONFIG.minSectionItems);
      expect(section.items.length).toBeLessThanOrEqual(SECTION_CONFIG.maxSectionItems);
      expect(section.items.every((item) => item.parentRegion === region)).toBe(true);
      expect(section.items.every((item) => item.score >= SECTION_MIN_SCORE)).toBe(true);
      const mids = section.items.map((item) => item.owner.mid);
      expect(new Set(mids).size).toBe(mids.length);
      expect(section.title).toContain(region);
    }
  });

  it('每板块条数受设置控制，且不超过 5', () => {
    const two = build(buildPool(), { settings: { ...settings, perSection: 2 } });
    const regionSections = two.filter((section) => section.kind === 'region');
    expect(regionSections.every((section) => section.items.length <= 2)).toBe(true);
    // 最少 2 条，实际都会取到 2 条
    expect(regionSections.every((section) => section.items.length >= 2)).toBe(true);

    const many = build(buildPool(), { settings: { ...settings, regionSections: 6, perSection: 5 } });
    const manyRegions = many.filter((section) => section.kind === 'region');
    expect(manyRegions.length).toBeLessThanOrEqual(SECTION_CONFIG.maxRegionSections);
    expect(
      manyRegions.every((section) => section.items.length <= SECTION_CONFIG.maxSectionItems),
    ).toBe(true);
  });

  it('所有候选都低于阈值时放宽一次，避免整页空白', () => {
    const pool = ['游戏', '生活', '知识'].flatMap((region, regionIndex) => [
      scored({ bvid: `BVrelax${regionIndex}a`, score: 0.5, region, mid: 2000 + regionIndex * 2 }),
      scored({ bvid: `BVrelax${regionIndex}b`, score: 0.49, region, mid: 2001 + regionIndex * 2 }),
    ]);
    const sections = build(pool);
    const regionSections = sections.filter((section) => section.kind === 'region');
    expect(regionSections.length).toBeGreaterThan(0);
    expect(regionSections.every((section) => section.items.every((item) => item.score < SECTION_MIN_SCORE))).toBe(true);
    expect(regionSections[0]!.subtitle).toContain('候选较少');
  });

  it('低分视频不会进入分区板块', () => {
    const sections = build(buildPool());
    const regionItems = sections
      .filter((section) => section.kind === 'region')
      .flatMap((section) => section.items);
    expect(regionItems.some((item) => item.bvid.startsWith('BVlow'))).toBe(false);
    expect(regionItems.every((item) => item.score >= SECTION_MIN_SCORE)).toBe(true);
  });
});

/** 回归 D-01：构造「同一分区里有两条同 UP」的候选池 */
function buildSameUpPool(): ScoredCandidate[] {
  const pool: ScoredCandidate[] = [];
  // 今日必看填满 6 条（3 个分区 × 2 个不同 UP），分数都高于游戏区候选
  const fillers: Array<{ region: string; score: number; mid: number }> = [
    { region: '生活', score: 0.99, mid: 1001 },
    { region: '生活', score: 0.98, mid: 1002 },
    { region: '知识', score: 0.97, mid: 1003 },
    { region: '知识', score: 0.96, mid: 1004 },
    { region: '音乐', score: 0.95, mid: 1005 },
    { region: '音乐', score: 0.94, mid: 1006 },
  ];
  for (const filler of fillers) {
    pool.push(
      scored({
        bvid: `BVfill${filler.mid}`,
        score: filler.score,
        region: filler.region,
        mid: filler.mid,
      }),
    );
  }
  // 游戏区：同一个 UP（mid=42）连续两条，外加两个不同 UP
  pool.push(scored({ bvid: 'BVgameA', score: 0.9, region: '游戏', mid: 42 }));
  pool.push(scored({ bvid: 'BVgameB', score: 0.89, region: '游戏', mid: 42 }));
  pool.push(scored({ bvid: 'BVgameC', score: 0.88, region: '游戏', mid: 43 }));
  pool.push(scored({ bvid: 'BVgameD', score: 0.87, region: '游戏', mid: 44 }));
  return pool;
}

describe('recommend/sections 同 UP 约束（回归 D-01）', () => {
  it('同一分区板块内同一 UP 最多 1 条（硬约束生效）', () => {
    const sections = build(buildSameUpPool());
    const gameSection = sections.find((section) => section.id === 'region:游戏');
    expect(gameSection).toBeDefined();
    const mids = gameSection!.items.map((item) => item.owner.mid);
    // 该 UP 有两条候选（0.90 / 0.89），板块内只能出现一次
    expect(mids.filter((mid) => mid === 42)).toHaveLength(1);
    expect(new Set(mids).size).toBe(mids.length);
    // 跳过重复 UP 后仍应补足其他 UP 的候选，保持 2–5 条
    expect(gameSection!.items.length).toBeGreaterThanOrEqual(SECTION_CONFIG.minSectionItems);
    expect(gameSection!.items.length).toBeLessThanOrEqual(SECTION_CONFIG.maxSectionItems);
    expect(gameSection!.items.every((item) => item.score >= SECTION_MIN_SCORE)).toBe(true);
    // 今日必看行为保持不变：同一 UP 允许最多 2 条
    const today = sections[0]!;
    const upCount = new Map<number, number>();
    for (const item of today.items) upCount.set(item.owner.mid, (upCount.get(item.owner.mid) ?? 0) + 1);
    expect(Math.max(...upCount.values())).toBeLessThanOrEqual(SECTION_CONFIG.todayPerUp);
  });

  it('分区内只剩同一 UP 的候选时不生成该板块（兜底 pass 同样限制同 UP）', () => {
    const pool = buildSameUpPool().filter(
      (row) => row.candidate.bvid !== 'BVgameC' && row.candidate.bvid !== 'BVgameD',
    );
    const sections = build(pool);
    expect(sections.some((section) => section.id === 'region:游戏')).toBe(false);
    // 其他分区板块不受影响
    expect(sections.filter((section) => section.kind === 'region').length).toBeGreaterThan(0);
  });

  it('pickItems 的 perUp 按本次已选列表统计', () => {
    const sameUp = [
      scored({ bvid: 'BVs1', score: 0.9, region: '游戏', mid: 7 }),
      scored({ bvid: 'BVs2', score: 0.8, region: '游戏', mid: 7 }),
      scored({ bvid: 'BVs3', score: 0.7, region: '游戏', mid: 7 }),
      scored({ bvid: 'BVs4', score: 0.6, region: '游戏', mid: 8 }),
    ];
    expect(pickItems(sameUp, 4, { perUp: 1 }).map((row) => row.candidate.bvid)).toEqual([
      'BVs1',
      'BVs4',
    ]);
    expect(pickItems(sameUp, 4, { perUp: 2 }).map((row) => row.candidate.bvid)).toEqual([
      'BVs1',
      'BVs2',
      'BVs4',
    ]);
  });
});

describe('recommend/sections 增长榜与每周必看', () => {
  it('增长榜：只含有增长数据的视频，实测优先', () => {
    const sections = build(buildPool());
    const growth = sections.find((section) => section.kind === 'growth');
    expect(growth).toBeDefined();
    expect(growth!.items.length).toBeGreaterThan(0);
    expect(growth!.items.length).toBeLessThanOrEqual(SECTION_CONFIG.growthSize);
    expect(growth!.items.every((item) => (item.growth?.view ?? 0) > 0)).toBe(true);
    expect(growth!.items[0]!.growth?.estimated).toBe(false);
  });

  it('每周必看精选只来自 weekly 来源，且按期号/名次排序', () => {
    const sections = build(buildPool());
    const weekly = sections.find((section) => section.kind === 'weekly');
    expect(weekly).toBeDefined();
    expect(weekly!.items.length).toBeGreaterThanOrEqual(SECTION_CONFIG.minSectionItems);
    expect(
      weekly!.items.every((item) => item.sources.some((ref) => ref.kind === 'weekly')),
    ).toBe(true);
    expect(weekly!.subtitle).toContain('395');
  });
});

describe('recommend/sections 排除与确定性', () => {
  it('排除集合中的视频不会出现', () => {
    const pool = buildPool();
    const sections = build(pool, { excluded: new Set(['BVg0', 'BVweekly0']) });
    const bvids = collectSectionBvids(sections);
    expect(bvids).not.toContain('BVg0');
    expect(bvids).not.toContain('BVweekly0');
  });

  it('同输入同 seed 结果完全一致', () => {
    const first = build(buildPool());
    const second = build(buildPool());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // collectSectionBvids 去重且顺序稳定
    expect(collectSectionBvids(first)).toEqual(collectSectionBvids(second));
  });

  it('空候选返回空板块数组', () => {
    expect(build([])).toEqual([]);
  });
});

describe('recommend/sections pickItems', () => {
  const pool: ScoredCandidate[] = [
    scored({ bvid: 'BV1', score: 0.9, region: '游戏', mid: 1 }),
    scored({ bvid: 'BV2', score: 0.85, region: '游戏', mid: 2 }),
    scored({ bvid: 'BV3', score: 0.8, region: '游戏', mid: 3 }),
    scored({ bvid: 'BV4', score: 0.75, region: '游戏', mid: 4 }),
    scored({ bvid: 'BV5', score: 0.7, region: '知识', mid: 2 }),
  ];

  it('按条数与限制挑选', () => {
    expect(pickItems(pool, 2).map((row) => row.candidate.bvid)).toEqual(['BV1', 'BV2']);
    expect(
      pickItems(pool, 5, { perRegion: 2 }).map((row) => row.candidate.bvid),
    ).toEqual(['BV1', 'BV2', 'BV5']);
    const perUp = pickItems(
      [scored({ bvid: 'BVa', score: 0.9, mid: 7 }), scored({ bvid: 'BVb', score: 0.8, mid: 7 }), scored({ bvid: 'BVc', score: 0.7, mid: 8 })],
      3,
      { perUp: 2 },
    );
    expect(perUp.map((row) => row.candidate.bvid)).toEqual(['BVa', 'BVb', 'BVc']);
  });

  it('sectionUps 会跳过同 UP，minScore 过滤低分', () => {
    expect(
      pickItems(pool, 2, { sectionUps: new Set([1]), perRegion: 2 }).map((row) => row.candidate.bvid),
    ).toEqual(['BV2', 'BV3']);
    expect(pickItems(pool, 5, { minScore: 0.8 }).map((row) => row.candidate.bvid)).toEqual([
      'BV1',
      'BV2',
      'BV3',
    ]);
  });
});
