import { describe, expect, it } from 'vitest';
import {
  GROWTH_CONFIG,
  computeGrowth,
  estimateGrowth,
  growthRateOf,
  measuredGrowth,
  writeSnapshots,
} from '../../../src/core/recommend/growth';
import { createMemoryRepository } from '../../../src/core/store/repository';
import { FIXTURE_NOW, makeCandidate, makeGrowth, makeSnapshot } from './helpers';

const NOW_SEC = Math.floor(FIXTURE_NOW / 1000);

describe('recommend/growth 估算', () => {
  it('按发布以来日均估算 24 小时增量', () => {
    const candidate = makeCandidate({
      bvid: 'BVg1',
      pubdate: NOW_SEC - 48 * 3600,
      stat: { view: 24_000, like: 1_000, favorite: 480, coin: 100, reply: 240, danmaku: 10, share: 5 },
    });
    const estimate = estimateGrowth(candidate, NOW_SEC);
    expect(estimate).not.toBeNull();
    expect(estimate!.estimated).toBe(true);
    expect(estimate!.hours).toBe(24);
    // 48 小时 24k 播放 -> 24 小时约 12k
    expect(estimate!.view).toBe(12_000);
    expect(estimate!.favorite).toBe(240);
    expect(estimate!.reply).toBe(120);
  });

  it('发布不足 24 小时时窗口取发布时长', () => {
    const candidate = makeCandidate({
      bvid: 'BVg2',
      pubdate: NOW_SEC - 2 * 3600,
      stat: { view: 1_000, like: 10, favorite: 10, coin: 1, reply: 1, danmaku: 1, share: 1 },
    });
    const estimate = estimateGrowth(candidate, NOW_SEC)!;
    expect(estimate.hours).toBe(2);
    // 2 小时 1000 播放 -> 2 小时窗口内 1000
    expect(estimate.view).toBe(1000);
  });

  it('无 stat / 无发布时间时返回 null', () => {
    const noStat = makeCandidate({
      bvid: 'BVg3',
      stat: { view: 0, like: 0, favorite: 0, coin: 0, reply: 0, danmaku: 0, share: 0 },
    });
    expect(estimateGrowth(noStat, NOW_SEC)).toBeNull();
    const noPub = makeCandidate({ bvid: 'BVg4', pubdate: 0 });
    expect(estimateGrowth(noPub, NOW_SEC)).toBeNull();
    const future = makeCandidate({ bvid: 'BVg5', pubdate: NOW_SEC + 3600 });
    expect(estimateGrowth(future, NOW_SEC)).toBeNull();
  });
});

describe('recommend/growth 实测', () => {
  it('24h 内两次快照且间隔 ≥12h 算实测', () => {
    const snapshots = [
      makeSnapshot('BVg1', NOW_SEC - 13 * 3600, 1_000),
      makeSnapshot('BVg1', NOW_SEC, 11_000),
    ];
    const measured = measuredGrowth(snapshots, NOW_SEC);
    expect(measured).not.toBeNull();
    expect(measured!.estimated).toBe(false);
    expect(measured!.hours).toBe(13);
    expect(measured!.view).toBe(10_000);
  });

  it('间隔不足 12h、超出 24h 窗口或只有一条快照时为 null', () => {
    expect(
      measuredGrowth(
        [makeSnapshot('BVg1', NOW_SEC - 11 * 3600, 1_000), makeSnapshot('BVg1', NOW_SEC, 2_000)],
        NOW_SEC,
      ),
    ).toBeNull();
    expect(
      measuredGrowth(
        [makeSnapshot('BVg1', NOW_SEC - 30 * 3600, 1_000), makeSnapshot('BVg1', NOW_SEC, 2_000)],
        NOW_SEC,
      ),
    ).toBeNull();
    expect(measuredGrowth([makeSnapshot('BVg1', NOW_SEC, 1_000)], NOW_SEC)).toBeNull();
    expect(measuredGrowth(undefined, NOW_SEC)).toBeNull();
  });

  it('取窗口内最早满足间隔的快照', () => {
    const snapshots = [
      makeSnapshot('BVg1', NOW_SEC - 20 * 3600, 1_000),
      makeSnapshot('BVg1', NOW_SEC - 14 * 3600, 3_000),
      makeSnapshot('BVg1', NOW_SEC, 21_000),
    ];
    const measured = measuredGrowth(snapshots, NOW_SEC)!;
    expect(measured.hours).toBe(20);
    expect(measured.view).toBe(20_000);
  });
});

describe('recommend/growth 快照写入与整体计算', () => {
  it('writeSnapshots 只写有播放数据的候选，同 bvid 去重', async () => {
    const repo = createMemoryRepository();
    const candidates = [
      makeCandidate({ bvid: 'BVw1', stat: { view: 100, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 } }),
      makeCandidate({ bvid: 'BVw1', stat: { view: 200, like: 2, favorite: 2, coin: 2, reply: 2, danmaku: 2, share: 2 } }),
      makeCandidate({ bvid: 'BVw2', stat: { view: 0, like: 0, favorite: 0, coin: 0, reply: 0, danmaku: 0, share: 0 } }),
    ];
    const written = await writeSnapshots(repo, candidates, FIXTURE_NOW);
    expect(written).toBe(1);
    const rows = await repo.getSnapshots('BVw1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(NOW_SEC);
  });

  it('computeGrowth：实测优先，其次估算，无数据不返回', async () => {
    const repo = createMemoryRepository();
    await repo.putSnapshots([
      makeSnapshot('BVm1', NOW_SEC - 13 * 3600, 1_000),
      makeSnapshot('BVm1', NOW_SEC, 21_000),
    ]);
    const candidates = [
      makeCandidate({
        bvid: 'BVm1',
        pubdate: NOW_SEC - 48 * 3600,
        stat: { view: 100_000, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 },
      }),
      makeCandidate({
        bvid: 'BVm2',
        pubdate: NOW_SEC - 48 * 3600,
        stat: { view: 24_000, like: 1, favorite: 480, coin: 1, reply: 240, danmaku: 1, share: 1 },
      }),
      makeCandidate({
        bvid: 'BVm3',
        pubdate: 0,
        stat: { view: 500, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 },
      }),
    ];
    const growth = await computeGrowth(repo, candidates, FIXTURE_NOW);
    expect(growth.get('BVm1')!.estimated).toBe(false);
    expect(growth.get('BVm1')!.view).toBe(20_000);
    expect(growth.get('BVm2')!.estimated).toBe(true);
    expect(growth.get('BVm2')!.view).toBe(12_000);
    expect(growth.has('BVm3')).toBe(false);
  });

  it('growthRateOf 对估算值打折，无数据返回 0', () => {
    expect(growthRateOf(null)).toBe(0);
    expect(growthRateOf(makeGrowth(24_000, 24, false))).toBe(1000);
    expect(growthRateOf(makeGrowth(24_000, 24, true))).toBeCloseTo(
      1000 * GROWTH_CONFIG.estimateDiscount,
      6,
    );
    expect(growthRateOf({ hours: 0, view: 0, favorite: 0, reply: 0, estimated: false })).toBe(0);
  });
});
