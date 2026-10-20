import { describe, expect, it } from 'vitest';
import type {
  FavFolderListData,
  FavMediaRaw,
  FavResourceListData,
  FollowingsData,
  ToViewData,
} from '../../../src/core/api/endpoints';
import { BiliApiError } from '../../../src/core/api/http';
import { SIGNAL_CONFIG } from '../../../src/shared/constants';
import {
  SIGNALS_KV_KEY,
  bvidOfFavorite,
  collectSignals,
  readSignalsCache,
  type SignalsApiPort,
} from '../../../src/core/sources/signals';
import { createMemoryRepository } from '../../../src/core/store/repository';
import { FIXTURE_NOW } from './helpers';

const NOW = FIXTURE_NOW;
const NOW_SEC = Math.floor(NOW / 1000);

/* ------------------------------------------------------------------ */
/* 测试桩                                                              */
/* ------------------------------------------------------------------ */

type Cell<T> = T | Error;

interface StubConfig {
  folders?: Cell<FavFolderListData>;
  /** 按 pn 索引；缺省返回空页 */
  favoritePages?: Array<Cell<FavResourceListData>>;
  /** type=0（回退）按调用顺序返回；缺省空页 */
  fallbackPages?: Array<Cell<FavResourceListData>>;
  followingsPages?: Array<Cell<FollowingsData>>;
  watchLater?: Cell<ToViewData>;
}

interface StubCalls {
  folders: number[];
  favorites: Array<{ mediaId: number; type: number; pn: number }>;
  followings: Array<{ mid: number; pn: number }>;
  watchLater: number;
}

function resolveCell<T>(cell: Cell<T> | undefined, fallback: T): T {
  if (cell === undefined) return fallback;
  if (cell instanceof Error) throw cell;
  return cell;
}

function makeStubApi(config: StubConfig = {}): { api: SignalsApiPort; calls: StubCalls } {
  const calls: StubCalls = { folders: [], favorites: [], followings: [], watchLater: 0 };
  const api: SignalsApiPort = {
    async favFolders(mid) {
      calls.folders.push(mid);
      return resolveCell(config.folders, { count: 0, list: [] });
    },
    async favResources(mediaId, options = {}) {
      const type = options.type ?? 1;
      const pn = options.pn ?? 1;
      calls.favorites.push({ mediaId, type, pn });
      if (type === 1) {
        return resolveCell(config.favoritePages?.[pn - 1], { medias: [], has_more: false });
      }
      const index = calls.favorites.filter((call) => call.type === 0).length - 1;
      return resolveCell(config.fallbackPages?.[index], { medias: [], has_more: false });
    },
    async followings(mid, pn = 1) {
      calls.followings.push({ mid, pn });
      return resolveCell(config.followingsPages?.[pn - 1], { list: [], total: 0 });
    },
    async watchLater() {
      calls.watchLater += 1;
      return resolveCell(config.watchLater, { count: 0, list: [] });
    },
  };
  return { api, calls };
}

/* ------------------------------------------------------------------ */
/* 数据构造                                                            */
/* ------------------------------------------------------------------ */

interface FavoriteSeed {
  bvid: string;
  title?: string;
  upMid?: number;
  upName?: string;
  favTime?: number;
  mtime?: number;
  pubtime?: number;
}

function favMedia(seed: FavoriteSeed): FavMediaRaw {
  return {
    type: 2,
    title: seed.title ?? `收藏视频 ${seed.bvid}`,
    cover: 'https://example.com/fav.jpg',
    bvid: seed.bvid,
    duration: 300,
    upper: { mid: seed.upMid ?? 5000, name: seed.upName ?? '收藏UP' },
    fav_time: seed.favTime,
    mtime: seed.mtime,
    pubtime: seed.pubtime,
  };
}

function favoritePage(medias: FavMediaRaw[]): FavResourceListData {
  return { medias, has_more: medias.length >= SIGNAL_CONFIG.favoritePageSize };
}

function folderList(
  folders: Array<{ id: number; fid?: number; mediaCount?: number }>,
): FavFolderListData {
  return {
    count: folders.length,
    list: folders.map((folder) => ({
      id: folder.id,
      fid: folder.fid,
      title: `收藏夹${folder.id}`,
      media_count: folder.mediaCount ?? 0,
    })),
  };
}

/** 生成 n 条一页的收藏分页 */
function pagesOf(
  items: FavoriteSeed[],
  pageSize: number = SIGNAL_CONFIG.favoritePageSize,
): FavResourceListData[] {
  const pages: FavResourceListData[] = [];
  for (let offset = 0; offset < items.length; offset += pageSize) {
    pages.push(favoritePage(items.slice(offset, offset + pageSize).map(favMedia)));
  }
  return pages;
}

const defaultWatchLater: ToViewData = {
  count: 6,
  list: [
    {
      aid: 1,
      bvid: 'BVlater0001',
      tid: 172,
      tname: '手机游戏',
      pic: '',
      title: '稍后再看 游戏攻略',
      pubdate: NOW_SEC - 3600,
      duration: 300,
      owner: { mid: 1, name: 'UP' },
      stat: { view: 1 },
    },
    {
      aid: 2,
      bvid: 'BVlater0002',
      tid: 201,
      tname: '科学科普',
      pic: '',
      title: '稍后再看 科学科普',
      pubdate: NOW_SEC - 7200,
      duration: 600,
      owner: { mid: 2, name: 'UP2' },
      stat: { view: 2 },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

describe('sources/signals 收藏', () => {
  it('bvid 从 bvid / bv_id / link 提取', () => {
    expect(bvidOfFavorite({ bvid: 'BV1abc' })).toBe('BV1abc');
    expect(bvidOfFavorite({ bv_id: 'BV1xyz' })).toBe('BV1xyz');
    expect(bvidOfFavorite({ link: 'https://www.bilibili.com/video/BV1link1234?p=1' })).toBe(
      'BV1link1234',
    );
    expect(bvidOfFavorite({ title: '没有 bvid' })).toBe('');
  });

  it('type=1 三页合并、按时间倒序、取 60', async () => {
    // 75 条：有效时间戳从新到旧；最旧 15 条带专属词 cutterm / UP 9999
    const seeds: FavoriteSeed[] = [];
    for (let index = 0; index < 75; index += 1) {
      const isCut = index >= 60;
      seeds.push({
        bvid: `BVorder${String(index).padStart(3, '0')}`,
        title: isCut ? `cutterm 旧视频 ${index}` : `主题${index % 6} 视频`,
        upMid: isCut ? 9999 : 100 + (index % 5),
        upName: isCut ? '旧UP' : `UP${index % 5}`,
        // 混合三种时间字段，验证 fav_time ?? mtime ?? pubtime 的取值顺序
        ...(index % 3 === 0
          ? { mtime: NOW_SEC - index * 60 }
          : index % 3 === 1
            ? { pubtime: NOW_SEC - index * 60 }
            : { favTime: NOW_SEC - index * 60 }),
      });
    }
    // 每页 25 条（接口 ps=20，但兼容接口多返回的情况），三页恰好 75 条
    const pages = pagesOf(seeds, 25);
    const { api, calls } = makeStubApi({
      folders: folderList([{ id: 501, fid: 0, mediaCount: 120 }]),
      favoritePages: pages,
      watchLater: defaultWatchLater,
      followingsPages: [{ total: 0, list: [] }],
    });
    const repo = createMemoryRepository();
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW, repo });

    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteFolders).toBe(1);
    expect(result.signals!.favoriteCount).toBe(120);
    expect(result.signals!.favoriteSampled).toBe(SIGNAL_CONFIG.favoriteMaxItems);
    // 请求的是 fid=0 的收藏夹，type=1、order=mtime，共 3 页
    expect(calls.favorites.filter((call) => call.type === 1)).toHaveLength(
      SIGNAL_CONFIG.favoritePages,
    );
    expect(calls.favorites[0]).toMatchObject({ mediaId: 501, type: 1, pn: 1 });
    // 最旧的 15 条被截断：它们专属的 UP 与词不出现
    expect(result.signals!.favoriteUps.some((row) => row.mid === 9999)).toBe(false);
    expect(result.signals!.favoriteTags.some((row) => row.term === 'cutterm')).toBe(false);
    expect(result.signals!.favoriteUps.length).toBeGreaterThan(0);
    expect(result.signals!.favoriteUps[0]!.count).toBeGreaterThan(0);
  });

  it('跨页同 bvid 去重后采样数正确', async () => {
    const page1 = Array.from({ length: 20 }, (_, index) =>
      favMedia({ bvid: `BVdedupe${index}`, title: `去重视频 ${index}`, favTime: NOW_SEC - index * 60 }),
    );
    const page2 = Array.from({ length: 20 }, (_, index) =>
      favMedia({ bvid: `BVdedupeB${index}`, title: `去重视频B ${index}`, favTime: NOW_SEC - 2000 - index }),
    );
    // 第三页 5 条与第一页重复（时间更新），15 条是新视频
    const page3 = [
      ...page1.slice(0, 5).map((media) => ({ ...media, fav_time: NOW_SEC - 10 })),
      ...Array.from({ length: 15 }, (_, index) =>
        favMedia({ bvid: `BVdedupeC${index}`, favTime: NOW_SEC - 5000 - index }),
      ),
    ];
    const { api } = makeStubApi({
      folders: folderList([{ id: 501, fid: 0, mediaCount: 55 }]),
      favoritePages: [
        favoritePage(page1),
        favoritePage(page2),
        favoritePage(page3),
      ],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    // 原始 60 条，其中 5 条与第一页重复 -> 55 条唯一
    expect(result.signals!.favoriteSampled).toBe(55);
  });

  it('无 fid=0 时选 media_count 最大的收藏夹作为 mlid', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 11, fid: 2, mediaCount: 5 },
        { id: 22, fid: 3, mediaCount: 80 },
      ]),
      favoritePages: [favoritePage([favMedia({ bvid: 'BVfolder22' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    await collectSignals({ api, mid: 12345, nowMs: NOW });
    const typeOne = calls.favorites.filter((call) => call.type === 1);
    expect(typeOne[0]!.mediaId).toBe(22);
  });

  it('type=1 返回 -400 时回退前 3 个收藏夹第一页（favoriteFallback + degraded）', async () => {
    const fallbackPage = favoritePage([
      favMedia({ bvid: 'BVfallbackA', title: '回退视频 A', upMid: 7001 }),
      favMedia({ bvid: 'BVfallbackB', title: '回退视频 B', upMid: 7002 }),
    ]);
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 101, fid: 1, mediaCount: 100 },
        { id: 102, fid: 2, mediaCount: 50 },
        { id: 103, fid: 3, mediaCount: 30 },
        { id: 104, fid: 4, mediaCount: 10 },
      ]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPages: [fallbackPage, fallbackPage, fallbackPage],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteFallback).toBe(true);
    expect(result.degraded).toContain('回退');
    // 回退只取 media_count 前三的收藏夹、第一页
    const fallbackCalls = calls.favorites.filter((call) => call.type === 0);
    expect(fallbackCalls.map((call) => call.mediaId)).toEqual([101, 102, 103]);
    expect(fallbackCalls.every((call) => call.pn === 1)).toBe(true);
    expect(result.signals!.favoriteSampled).toBeGreaterThan(0);
  });

  it('type=1 返回 -404（内容不存在）时也回退逐文件夹', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 301, fid: 0, mediaCount: 4 },
        { id: 302, fid: 1, mediaCount: 2 },
      ]),
      favoritePages: [new BiliApiError('您访问的内容不存在', -404, 'fav')],
      fallbackPages: [favoritePage([favMedia({ bvid: 'BV404Fallback' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteFallback).toBe(true);
    expect(result.signals!.favoriteSampled).toBe(1);
    expect(result.degraded).toContain('回退');
    expect(calls.favorites.some((call) => call.type === 0)).toBe(true);
  });

  it('默认收藏夹为空时跳过它，选择有内容的收藏夹', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 401, fid: 0, mediaCount: 0 },
        { id: 402, fid: 2, mediaCount: 9 },
      ]),
      favoritePages: [favoritePage([favMedia({ bvid: 'BVnonEmptyFolder' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    const typeOne = calls.favorites.filter((call) => call.type === 1);
    expect(typeOne[0]!.mediaId).toBe(402);
    expect(result.signals!.favoriteSampled).toBe(1);
    expect(result.signals!.favoriteFolders).toBe(2);
  });

  it('所有收藏夹都为空时直接返回空收藏，不发内容请求', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 501, fid: 0, mediaCount: 0 },
        { id: 502, fid: 1, mediaCount: 0 },
      ]),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteCount).toBe(0);
    expect(result.signals!.favoriteSampled).toBe(0);
    expect(calls.favorites).toHaveLength(0);
    expect(result.degraded).toBeUndefined();
  });

  it('type=1 返回空但收藏夹非空时同样回退', async () => {
    const { api } = makeStubApi({
      folders: folderList([{ id: 201, fid: 0, mediaCount: 3 }]),
      favoritePages: [favoritePage([])],
      fallbackPages: [favoritePage([favMedia({ bvid: 'BVemptyFallback' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteFallback).toBe(true);
    expect(result.signals!.favoriteSampled).toBe(1);
  });

  it('没有收藏夹时返回空收藏且不报错', async () => {
    const { api } = makeStubApi({
      folders: { count: 0, list: [] },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteFolders).toBe(0);
    expect(result.signals!.favoriteCount).toBe(0);
    expect(result.signals!.favoriteSampled).toBe(0);
    expect(result.degraded).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 关注 / 稍后再看                                                     */
/* ------------------------------------------------------------------ */

describe('sources/signals 关注与稍后再看', () => {
  it('关注 2 页、按 mid 去重、最多 100 人', async () => {
    const page1: FollowingsData = {
      total: 120,
      list: Array.from({ length: 50 }, (_, index) => ({ mid: 5000 + index, uname: `UP${index}` })),
    };
    const page2: FollowingsData = {
      total: 120,
      // 60 个新关注（与第一页无重复），合计会超过 100 上限
      list: Array.from({ length: 60 }, (_, index) => ({
        mid: 5050 + index,
        uname: `UP${50 + index}`,
      })),
    };
    const { api, calls } = makeStubApi({
      folders: { count: 0, list: [] },
      followingsPages: [page1, page2],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(calls.followings.map((call) => call.pn)).toEqual([1, 2]);
    expect(result.signals!.followedTotal).toBe(120);
    expect(result.signals!.followed).toHaveLength(SIGNAL_CONFIG.followingMaxItems);
    expect(new Set(result.signals!.followed.map((row) => row.mid)).size).toBe(100);
  });

  it('关注第一页不满 50 时不翻第二页', async () => {
    const { api, calls } = makeStubApi({
      folders: { count: 0, list: [] },
      followingsPages: [{ total: 3, list: [{ mid: 1 }, { mid: 2 }, { mid: 3 }] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(calls.followings).toHaveLength(1);
    expect(result.signals!.followed).toHaveLength(3);
    expect(result.signals!.followedTotal).toBe(3);
  });

  it('稍后再看聚合分区与标题标签', async () => {
    const { api } = makeStubApi({
      folders: { count: 0, list: [] },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: defaultWatchLater,
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.watchLaterCount).toBe(6);
    expect(result.signals!.watchLaterSampled).toBe(2);
    expect(result.signals!.watchLaterRegions.map((row) => row.name).sort()).toEqual([
      '游戏',
      '知识',
    ]);
    expect(result.signals!.watchLaterTags.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 缓存与失败                                                          */
/* ------------------------------------------------------------------ */

describe('sources/signals 缓存与失败处理', () => {
  it('12 小时内命中缓存，不重复请求；过期后重新抓取', async () => {
    const repo = createMemoryRepository();
    const config: StubConfig = {
      folders: folderList([{ id: 501, fid: 0, mediaCount: 10 }]),
      favoritePages: [favoritePage([favMedia({ bvid: 'BVcache1' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    };
    const first = makeStubApi(config);
    const firstResult = await collectSignals({
      api: first.api,
      mid: 12345,
      nowMs: NOW,
      repo,
    });
    expect(firstResult.fromCache).toBe(false);
    expect(first.calls.folders).toHaveLength(1);
    const cached = await readSignalsCache(repo, 12345, NOW + 60_000);
    expect(cached?.fresh).toBe(true);
    expect(await repo.getKv(SIGNALS_KV_KEY)).toBeTruthy();

    const second = makeStubApi(config);
    const hit = await collectSignals({
      api: second.api,
      mid: 12345,
      nowMs: NOW + SIGNAL_CONFIG.cacheTtlMs - 1,
      repo,
    });
    expect(hit.fromCache).toBe(true);
    expect(second.calls.folders).toHaveLength(0);

    const third = makeStubApi(config);
    const expired = await collectSignals({
      api: third.api,
      mid: 12345,
      nowMs: NOW + SIGNAL_CONFIG.cacheTtlMs + 1,
      repo,
    });
    expect(expired.fromCache).toBe(false);
    expect(third.calls.folders).toHaveLength(1);
  });

  it('缓存按 mid 隔离', async () => {
    const repo = createMemoryRepository();
    const config: StubConfig = {
      folders: folderList([{ id: 501, fid: 0, mediaCount: 10 }]),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    };
    const first = makeStubApi(config);
    await collectSignals({ api: first.api, mid: 111, nowMs: NOW, repo });
    const other = makeStubApi(config);
    const result = await collectSignals({ api: other.api, mid: 222, nowMs: NOW, repo });
    expect(result.fromCache).toBe(false);
    expect(other.calls.folders).toEqual([222]);
  });

  it('网络失败时有旧缓存则用缓存（degraded），无缓存则返回 null 不抛错', async () => {
    const repo = createMemoryRepository();
    const ok = makeStubApi({
      folders: folderList([{ id: 501, fid: 0, mediaCount: 10 }]),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    await collectSignals({ api: ok.api, mid: 12345, nowMs: NOW, repo });

    const failConfig: StubConfig = {
      folders: new Error('网络错误'),
      followingsPages: [new Error('网络错误')],
      watchLater: new Error('网络错误'),
    };
    const failing = makeStubApi(failConfig);
    const stale = await collectSignals({
      api: failing.api,
      mid: 12345,
      nowMs: NOW + SIGNAL_CONFIG.cacheTtlMs + 1,
      repo,
    });
    expect(stale.signals).not.toBeNull();
    expect(stale.fromCache).toBe(true);
    expect(stale.degraded).toContain('缓存');

    const noCache = await collectSignals({
      api: makeStubApi(failConfig).api,
      mid: 999,
      nowMs: NOW,
    });
    expect(noCache.signals).toBeNull();
    expect(noCache.degraded).toBeTruthy();
  });

  it('-101（未登录）静默：unauthorized、无 degraded、不写缓存', async () => {
    const repo = createMemoryRepository();
    const { api, calls } = makeStubApi({
      folders: new BiliApiError('账号未登录', -101, 'fav'),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW, repo });
    expect(result.signals).toBeNull();
    expect(result.unauthorized).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(calls.folders).toHaveLength(1);
    // 未登录不再继续请求关注/稍后再看
    expect(calls.followings).toHaveLength(0);
    expect(calls.watchLater).toBe(0);
    expect(await repo.getKv(SIGNALS_KV_KEY)).toBeUndefined();
  });

  it('-101 时若有旧缓存则静默使用缓存', async () => {
    const repo = createMemoryRepository();
    const ok = makeStubApi({
      folders: folderList([{ id: 501, fid: 0, mediaCount: 10 }]),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    await collectSignals({ api: ok.api, mid: 12345, nowMs: NOW, repo });
    const expired = NOW + SIGNAL_CONFIG.cacheTtlMs + 1;
    const unauthorized = makeStubApi({
      folders: new BiliApiError('账号未登录', -101, 'fav'),
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({
      api: unauthorized.api,
      mid: 12345,
      nowMs: expired,
      repo,
    });
    expect(result.signals).not.toBeNull();
    expect(result.fromCache).toBe(true);
    expect(result.degraded).toBeUndefined();
  });

  it('部分来源失败时保留其它来源并降级', async () => {
    const { api } = makeStubApi({
      folders: new BiliApiError('风控', -352, 'fav'),
      followingsPages: [{ total: 2, list: [{ mid: 1, uname: 'A' }, { mid: 2, uname: 'B' }] }],
      watchLater: defaultWatchLater,
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteSampled).toBe(0);
    expect(result.signals!.followed).toHaveLength(2);
    expect(result.signals!.watchLaterSampled).toBe(2);
    expect(result.degraded).toContain('收藏夹');
  });

  it('mid 非法时直接静默返回', async () => {
    const { api, calls } = makeStubApi({});
    const result = await collectSignals({ api, mid: 0, nowMs: NOW });
    expect(result.signals).toBeNull();
    expect(result.unauthorized).toBe(true);
    expect(calls.folders).toHaveLength(0);
  });
});
