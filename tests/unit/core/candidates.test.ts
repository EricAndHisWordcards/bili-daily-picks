import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { DAY } from '../../../src/shared/time';
import type {
  PopularData,
  RankingData,
  RcmdData,
  RawVideo,
  RelatedData,
  WeeklyListData,
  WeeklyOneData,
} from '../../../src/core/api/endpoints';
import type { Candidate, Settings } from '../../../src/shared/types';
import {
  buildCandidatePlan,
  candidateFromRawVideo,
  candidateFromRcmd,
  collectSourceKinds,
  dedupeByTitleAndUp,
  filterCandidates,
  finalizeCandidates,
  isCandidateFreshEnough,
  mergeCandidate,
  mergeCandidates,
  mergeSourceRefs,
  pickTopRegionNames,
  runCandidateTask,
} from '../../../src/core/sources/candidates';
import {
  FIXTURE_NOW,
  createStubSources,
  loadFixture,
  loadSampleHistory,
  makeCandidate,
  makeProfile,
} from './helpers';

const NOW_SEC = Math.floor(FIXTURE_NOW / 1000);
const popularData = loadFixture<{ data: PopularData }>('popular.json').data;
const rankingAll = loadFixture<{ data: RankingData }>('ranking-0.json').data;
const rankingRegion = loadFixture<{ data: RankingData }>('ranking-4.json').data;
const weeklyList = loadFixture<{ data: WeeklyListData }>('weekly-list.json').data;
const weeklyOne = loadFixture<{ data: WeeklyOneData }>('weekly-one.json').data;
const rcmdData = loadFixture<{ data: RcmdData }>('rcmd.json').data;
const relatedData = loadFixture<{ data: RelatedData }>('related.json').data;

const fullSettings: Settings = {
  ...DEFAULT_SETTINGS,
  enabledSources: {
    popular: true,
    ranking: true,
    regionRanking: true,
    weekly: true,
    rcmd: true,
    related: true,
  },
};

describe('sources/candidates 映射', () => {
  it('RawVideo -> Candidate：字段与来源完整', () => {
    const video = popularData.list[0]!;
    const candidate = candidateFromRawVideo(video, { kind: 'popular' });
    expect(candidate).not.toBeNull();
    expect(candidate!.bvid).toBe(video.bvid);
    expect(candidate!.title).toBe(video.title);
    expect(candidate!.cover).toBe(video.pic);
    expect(candidate!.duration).toBe(video.duration);
    expect(candidate!.pubdate).toBe(video.pubdate);
    expect(candidate!.tid).toBe(video.tid);
    expect(candidate!.tname).toBe(video.tname);
    expect(candidate!.parentRegion).not.toBe('其他');
    expect(candidate!.owner.mid).toBe(video.owner.mid);
    expect(candidate!.stat.view).toBe(video.stat.view);
    expect(candidate!.stat.favorite).toBe(video.stat.favorite);
    expect(candidate!.sources).toEqual([{ kind: 'popular' }]);
  });

  it('缺少 bvid / 直播番剧课程 OGV 会被过滤', () => {
    const base = popularData.list[0]!;
    expect(candidateFromRawVideo({ ...base, bvid: '' }, { kind: 'popular' })).toBeNull();
    expect(candidateFromRawVideo({ ...base, tname: '番剧' }, { kind: 'ranking' })).toBeNull();
    expect(candidateFromRawVideo({ ...base, tname: '课程' }, { kind: 'ranking' })).toBeNull();
    expect(candidateFromRawVideo({ ...base, tname: '直播' }, { kind: 'ranking' })).toBeNull();
    const ogv = { ...base, is_ogv: true } as RawVideo;
    expect(candidateFromRawVideo(ogv, { kind: 'ranking' })).toBeNull();
    // 普通 UGC 的 season_type 非 0 不能当成 OGV 过滤（相关推荐 fixture 里很常见）
    const season = { ...base, season_type: 1 } as RawVideo;
    expect(candidateFromRawVideo(season, { kind: 'ranking' })).not.toBeNull();
  });

  it('相关推荐原始视频也能映射', () => {
    const candidate = candidateFromRawVideo(relatedData[0]!, { kind: 'related' });
    expect(candidate).not.toBeNull();
    expect(candidate!.sources[0]!.kind).toBe('related');
  });

  it('RcmdItem -> Candidate：goto 非 av 或无 bvid 跳过', () => {
    const item = rcmdData.item[0]!;
    const candidate = candidateFromRcmd(item, { kind: 'rcmd' });
    expect(candidate).not.toBeNull();
    expect(candidate!.bvid).toBe(item.bvid);
    expect(candidate!.parentRegion).toBe('其他');
    expect(candidate!.tname).toBe('');
    expect(candidate!.sources[0]!.kind).toBe('rcmd');
    expect(candidateFromRcmd({ ...item, goto: 'live' }, { kind: 'rcmd' })).toBeNull();
    expect(candidateFromRcmd({ ...item, bvid: undefined }, { kind: 'rcmd' })).toBeNull();
  });
});

describe('sources/candidates 任务执行', () => {
  const api = createStubSources({
    popular: async () => popularData,
    ranking: async (rid = 0) => (rid === 0 ? rankingAll : rankingRegion),
    weeklyList: async () => weeklyList,
    weeklyOne: async () => weeklyOne,
    rcmd: async () => rcmdData,
    related: async () => relatedData,
  });

  it('热门任务映射全部条目', async () => {
    const result = await runCandidateTask(api, { kind: 'popular', page: 1 });
    expect(result.candidates).toHaveLength(popularData.list.length);
    expect(result.candidates.every((c) => c.sources[0]!.kind === 'popular')).toBe(true);
  });

  it('排行榜任务写入名次，分区榜写入 rid 与分区名', async () => {
    const ranking = await runCandidateTask(api, { kind: 'ranking', rid: 0 });
    expect(ranking.candidates[0]!.sources[0]).toMatchObject({ kind: 'ranking', rank: 1 });
    expect(ranking.candidates[1]!.sources[0]!.rank).toBe(2);

    const region = await runCandidateTask(api, { kind: 'regionRanking', rid: 4, regionName: '游戏' });
    expect(region.candidates[0]!.sources[0]).toMatchObject({
      kind: 'regionRanking',
      rid: 4,
      regionName: '游戏',
      rank: 1,
    });
  });

  it('每周必看列表返回最近两期，精选任务写入期号', async () => {
    const list = await runCandidateTask(api, { kind: 'weeklyList' });
    expect(list.candidates).toHaveLength(0);
    expect(list.weeklyIssues).toEqual([395, 394]);
    const one = await runCandidateTask(api, { kind: 'weekly', issue: 395 });
    expect(one.candidates[0]!.sources[0]).toMatchObject({ kind: 'weekly', issue: 395, rank: 1 });
  });

  it('个性化推荐只保留稿件（goto=av）', async () => {
    const result = await runCandidateTask(api, { kind: 'rcmd', page: 1 });
    const expected = rcmdData.item.filter(
      (item) => item.goto === 'av' && Boolean(item.bvid),
    ).length;
    expect(result.candidates).toHaveLength(expected);
    expect(result.candidates.every((c) => c.sources[0]!.kind === 'rcmd')).toBe(true);
  });
});

describe('sources/candidates 合并与去重', () => {
  it('同 bvid 合并来源、统计取最大、分区优先已知值', () => {
    const first = makeCandidate({
      bvid: 'BVmerge',
      stat: { view: 100, like: 10, favorite: 5, coin: 1, reply: 1, danmaku: 1, share: 1 },
      sources: [{ kind: 'popular' }, { kind: 'popular' }],
    });
    const second = makeCandidate({
      bvid: 'BVmerge',
      tname: '',
      parentRegion: '其他',
      stat: { view: 300, like: 30, favorite: 15, coin: 2, reply: 2, danmaku: 2, share: 2 },
      sources: [{ kind: 'ranking', rank: 3 }],
      rcmdReason: '猜你喜欢',
    });
    const merged = mergeCandidates([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.stat.view).toBe(300);
    expect(merged[0]!.stat.favorite).toBe(15);
    expect(merged[0]!.parentRegion).toBe('游戏');
    expect(merged[0]!.sources.map((ref) => ref.kind).sort()).toEqual(['popular', 'ranking']);
    expect(merged[0]!.rcmdReason).toBe('猜你喜欢');
  });

  it('来源列表按 (种类/rid/期号/名次) 去重', () => {
    const refs = mergeSourceRefs(
      [{ kind: 'ranking', rank: 1 }, { kind: 'popular' }, { kind: 'weekly', issue: 395, rank: 1 }],
      [{ kind: 'ranking', rank: 1 }, { kind: 'weekly', issue: 395, rank: 2 }],
    );
    expect(refs).toHaveLength(4);
  });

  it('标题 + UP 去重保留播放量高的一条', () => {
    const low = makeCandidate({
      bvid: 'BVtitleA',
      title: '同一个标题！',
      owner: { mid: 7, name: '某UP' },
      stat: { view: 10, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 },
    });
    const high = makeCandidate({
      bvid: 'BVtitleB',
      title: '同一个 标题',
      owner: { mid: 7, name: '某UP' },
      stat: { view: 999, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 },
    });
    const other = makeCandidate({ bvid: 'BVtitleC', title: '别的标题', owner: { mid: 8, name: 'UP2' } });
    const deduped = dedupeByTitleAndUp([low, high, other]);
    expect(deduped).toHaveLength(2);
    expect(deduped.some((c) => c.bvid === 'BVtitleB')).toBe(true);
  });

  it('mergeCandidate 缺省字段互补', () => {
    const first = makeCandidate({ bvid: 'BVcomplement', cover: '', tid: undefined, cid: undefined });
    const second = makeCandidate({ bvid: 'BVcomplement', cover: 'https://x/2.jpg', cid: 42, aid: 99 });
    const merged = mergeCandidate(first, second);
    expect(merged.cover).toBe('https://x/2.jpg');
    expect(merged.cid).toBe(42);
    expect(merged.aid).toBe(99);
  });
});

describe('sources/candidates 过滤', () => {
  it('过滤已看过、不感兴趣、超过 60 天，每周必看放宽', () => {
    const fresh = makeCandidate({ bvid: 'BVfresh' });
    const watched = makeCandidate({ bvid: 'BVwatched' });
    const dismissed = makeCandidate({ bvid: 'BVdismissed' });
    const old = makeCandidate({ bvid: 'BVold', pubdate: NOW_SEC - 61 * 86400 });
    const weeklyOld = makeCandidate({
      bvid: 'BVweeklyOld',
      pubdate: NOW_SEC - 100 * 86400,
      sources: [{ kind: 'weekly', issue: 395, rank: 1 }],
    });
    const tooLong = makeCandidate({ bvid: 'BVlong', duration: 5 * 60 * 60 });
    const result = filterCandidates([fresh, watched, dismissed, old, weeklyOld, tooLong], {
      nowMs: FIXTURE_NOW,
      watched: new Set(['BVwatched']),
      dismissed: new Set(['BVdismissed']),
    });
    expect(result.map((c) => c.bvid).sort()).toEqual(['BVfresh', 'BVweeklyOld']);
  });

  it('isCandidateFreshEnough 对每周必看来源放宽', () => {
    const weekly = makeCandidate({
      bvid: 'BVage',
      pubdate: NOW_SEC - 120 * 86400,
      sources: [{ kind: 'weekly', issue: 1, rank: 1 }],
    });
    const normal = makeCandidate({ bvid: 'BVage2', pubdate: NOW_SEC - 120 * 86400 });
    expect(isCandidateFreshEnough(weekly, { nowMs: FIXTURE_NOW })).toBe(true);
    expect(isCandidateFreshEnough(normal, { nowMs: FIXTURE_NOW })).toBe(false);
    expect(
      isCandidateFreshEnough(makeCandidate({ bvid: 'BVage3', pubdate: NOW_SEC - 3 * 86400 }), {
        nowMs: FIXTURE_NOW,
      }),
    ).toBe(true);
  });

  it('finalizeCandidates 去重 + 过滤一起生效', () => {
    const candidates: Candidate[] = [
      makeCandidate({ bvid: 'BV1', title: '标题一', owner: { mid: 1, name: 'A' } }),
      makeCandidate({ bvid: 'BV1', sources: [{ kind: 'ranking', rank: 2 }] }),
      makeCandidate({ bvid: 'BV2', title: '标题一', owner: { mid: 1, name: 'A' } }),
      makeCandidate({ bvid: 'BV3', title: '标题三', owner: { mid: 2, name: 'B' } }),
    ];
    const result = finalizeCandidates(candidates, {
      nowMs: FIXTURE_NOW,
      watched: new Set(['BV3']),
    });
    expect(result.some((c) => c.bvid === 'BV3')).toBe(false);
    expect(result.filter((c) => c.bvid === 'BV1')).toHaveLength(1);
  });
});

describe('sources/candidates 任务计划', () => {
  it('完整模式包含全部来源，顺序稳定', () => {
    const plan = buildCandidatePlan({
      settings: fullSettings,
      profile: makeProfile(),
      history: loadSampleHistory(),
      nowMs: FIXTURE_NOW,
      mode: 'full',
    });
    const kinds = plan.map((task) => task.kind);
    expect(kinds.slice(0, 3)).toEqual(['popular', 'popular', 'ranking']);
    expect(kinds.filter((kind) => kind === 'regionRanking')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'rcmd')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'related')).toHaveLength(5);
    expect(kinds).toContain('weeklyList');
    // 未拿到期号时只有 weeklyList，没有 weekly
    expect(kinds.filter((kind) => kind === 'weekly')).toHaveLength(0);
  });

  it('拿到期号后插入两期每周必看，且不改变 weeklyList 之前的下标', () => {
    const base = {
      settings: fullSettings,
      profile: makeProfile(),
      history: loadSampleHistory(),
      nowMs: FIXTURE_NOW,
      mode: 'full' as const,
    };
    const withoutIssues = buildCandidatePlan(base);
    const withIssues = buildCandidatePlan({ ...base, weeklyIssues: [395, 394, 393] });
    const listIndex = withoutIssues.findIndex((task) => task.kind === 'weeklyList');
    expect(withIssues[listIndex]).toEqual({ kind: 'weeklyList' });
    expect(withIssues[listIndex + 1]).toEqual({ kind: 'weekly', issue: 395 });
    expect(withIssues[listIndex + 2]).toEqual({ kind: 'weekly', issue: 394 });
    expect(withIssues.slice(0, listIndex)).toEqual(withoutIssues.slice(0, listIndex));
  });

  it('公开模式不含个性化推荐与相关推荐', () => {
    const plan = buildCandidatePlan({
      settings: fullSettings,
      profile: null,
      history: [],
      nowMs: FIXTURE_NOW,
      mode: 'public',
    });
    const kinds = plan.map((task) => task.kind);
    expect(kinds).not.toContain('rcmd');
    expect(kinds).not.toContain('related');
    expect(kinds).toContain('popular');
    expect(kinds).toContain('weeklyList');
  });

  it('设置里关闭的来源不产生任务', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      enabledSources: {
        popular: false,
        ranking: false,
        regionRanking: false,
        weekly: false,
        rcmd: false,
        related: false,
      },
    };
    expect(
      buildCandidatePlan({
        settings,
        profile: null,
        history: [],
        nowMs: FIXTURE_NOW,
        mode: 'full',
      }),
    ).toEqual([]);
  });

  it('分区榜取画像 Top3，无画像时用兜底分区', () => {
    const withProfile = buildCandidatePlan({
      settings: fullSettings,
      profile: makeProfile(),
      history: [],
      nowMs: FIXTURE_NOW,
      mode: 'full',
    });
    const rids = withProfile
      .filter((task) => task.kind === 'regionRanking')
      .map((task) => (task.kind === 'regionRanking' ? task.rid : 0));
    expect(rids).toEqual([4, 36, 3]);

    expect(pickTopRegionNames(null)).toEqual(['动画', '音乐', '游戏']);
    const fallback = buildCandidatePlan({
      settings: fullSettings,
      profile: null,
      history: [],
      nowMs: FIXTURE_NOW,
      mode: 'public',
    });
    const fallbackRids = fallback
      .filter((task) => task.kind === 'regionRanking')
      .map((task) => (task.kind === 'regionRanking' ? task.rid : 0));
    expect(fallbackRids).toEqual([1, 3, 4]);
  });
});

describe('sources/candidates 辅助', () => {
  it('collectSourceKinds 按固定顺序输出', () => {
    const kinds = collectSourceKinds([
      makeCandidate({ bvid: 'BVa', sources: [{ kind: 'weekly', issue: 1, rank: 1 }] }),
      makeCandidate({ bvid: 'BVb', sources: [{ kind: 'popular' }] }),
      makeCandidate({ bvid: 'BVc', sources: [{ kind: 'ranking', rank: 1 }] }),
    ]);
    expect(kinds).toEqual(['popular', 'ranking', 'weekly']);
  });

  it('fixture 数据端到端：runCandidateTask -> finalizeCandidates', async () => {
    const api = createStubSources({
      popular: async () => popularData,
      ranking: async () => rankingAll,
      weeklyList: async () => weeklyList,
      weeklyOne: async () => weeklyOne,
      rcmd: async () => rcmdData,
      related: async () => relatedData,
    });
    const watched = popularData.list[0]!.bvid;
    const collected: Candidate[] = [];
    for (const task of [
      { kind: 'popular' as const, page: 1 },
      { kind: 'ranking' as const, rid: 0 },
      { kind: 'weekly' as const, issue: 395 },
      { kind: 'rcmd' as const, page: 1 },
      { kind: 'related' as const, bvid: 'BVseed' },
    ]) {
      collected.push(...(await runCandidateTask(api, task)).candidates);
    }
    const finalized = finalizeCandidates(collected, {
      nowMs: FIXTURE_NOW,
      watched: new Set([watched]),
    });
    expect(finalized.length).toBeGreaterThan(0);
    expect(finalized.some((c) => c.bvid === watched)).toBe(false);
    expect(new Set(finalized.map((c) => c.bvid)).size).toBe(finalized.length);
    // 每周必看来源即使老于 60 天也允许保留
    const weeklyCandidates = finalized.filter((c) =>
      c.sources.some((ref) => ref.kind === 'weekly'),
    );
    expect(weeklyCandidates.length).toBeGreaterThan(0);
    expect(
      weeklyCandidates.every((c) => (NOW_SEC - c.pubdate) / (DAY / 1000) <= 365),
    ).toBe(true);
  });
});
