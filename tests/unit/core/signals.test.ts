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
  /** 按收藏夹 id + 页码返回 type=0 回退页；优先于 fallbackPages */
  fallbackPagesByFolder?: Record<number, Array<Cell<FavResourceListData>>>;
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
      const byFolder = config.fallbackPagesByFolder?.[mediaId];
      if (byFolder) {
        return resolveCell(byFolder[pn - 1], { medias: [], has_more: false });
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

function fixedPage(medias: FavMediaRaw[], hasMore = false): FavResourceListData {
  return { medias, has_more: hasMore };
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

  it('type=1 返回 -400 时回退扫描所有收藏夹（favoriteFallback + degraded）', async () => {
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
    // 回退扫描所有非空收藏夹；无 mtime 时按 id 倒序，首轮各取第 1 页
    const fallbackCalls = calls.favorites.filter((call) => call.type === 0);
    expect(fallbackCalls.map((call) => call.mediaId)).toEqual([104, 103, 102, 101]);
    expect(fallbackCalls.every((call) => call.pn === 1)).toBe(true);
    expect(result.signals!.favoriteSampled).toBeGreaterThan(0);
  });

  it('旧大收藏夹不会挤掉新建的小收藏夹', async () => {
    const recent = [
      favMedia({ bvid: 'BVnewSmall1', upMid: 9001, upName: '新夹UP', favTime: NOW_SEC - 60 }),
      favMedia({ bvid: 'BVnewSmall2', upMid: 9001, upName: '新夹UP', favTime: NOW_SEC - 120 }),
    ];
    const oldPage = (id: number, upMid: number) =>
      favoritePage([
        favMedia({
          bvid: `BVold${id}`,
          upMid,
          upName: `旧夹${upMid}`,
          favTime: NOW_SEC - 365 * 86400,
        }),
      ]);
    const { api } = makeStubApi({
      folders: folderList([
        { id: 701, fid: 1, mediaCount: 1000 },
        { id: 702, fid: 2, mediaCount: 900 },
        { id: 703, fid: 3, mediaCount: 800 },
        { id: 999, fid: 4, mediaCount: 2 },
      ]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: {
        999: [fixedPage(recent)],
        701: [oldPage(701, 7001)],
        702: [oldPage(702, 7002)],
        703: [oldPage(703, 7003)],
      },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteFolders).toBe(4);
    expect(result.signals!.favoriteSampled).toBe(5);
    // 旧算法按 media_count 只取前 3 个夹，会漏掉 id=999 的新夹
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9001)).toBe(true);
  });

  it('按收藏时间取全局最近 60 条，而不是按收藏夹大小', async () => {
    const makePage = (prefix: string, base: number, upMid: number) =>
      fixedPage(
        Array.from({ length: 20 }, (_, index) =>
          favMedia({
            bvid: `BV${prefix}${index}`,
            upMid,
            upName: prefix,
            favTime: NOW_SEC - base - index * 10,
          }),
        ),
      );
    const { api } = makeStubApi({
      folders: folderList([
        { id: 1101, fid: 1, mediaCount: 1000 },
        { id: 1102, fid: 2, mediaCount: 800 },
        { id: 1103, fid: 3, mediaCount: 600 },
        { id: 1104, fid: 4, mediaCount: 400 },
      ]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: {
        1101: [makePage('a', 1, 9101)],
        1102: [makePage('b', 300, 9102)],
        1103: [makePage('c', 600, 9103)],
        1104: [makePage('d', 900, 9104)],
      },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteSampled).toBe(60);
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9101)).toBe(true);
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9102)).toBe(true);
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9103)).toBe(true);
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9104)).toBe(false);
  });

  it('不足 60 条时继续翻页直到没有更多', async () => {
    const items: FavoriteSeed[] = Array.from({ length: 25 }, (_, index) => ({
      bvid: `BVpage${index}`,
      upMid: 9201,
      upName: '翻页UP',
      favTime: NOW_SEC - index * 10,
    }));
    const { api, calls } = makeStubApi({
      folders: folderList([{ id: 1201, fid: 0, mediaCount: 25 }]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: { 1201: pagesOf(items) },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteSampled).toBe(25);
    const fallbackCalls = calls.favorites.filter((call) => call.type === 0);
    expect(fallbackCalls.map((call) => call.pn)).toEqual([1, 2]);
  });

  it('已经不可能进入前 60 的旧收藏夹不再翻页', async () => {
    const makePage = (prefix: string, base: number, upMid: number) =>
      fixedPage(
        Array.from({ length: 20 }, (_, index) =>
          favMedia({
            bvid: `BV${prefix}${index}`,
            upMid,
            upName: prefix,
            favTime: NOW_SEC - base - index * 10,
          }),
        ),
      );
    const oldItems = Array.from({ length: 20 }, (_, index) =>
      favMedia({
        bvid: `BVoldCut${index}`,
        upMid: 9404,
        upName: '旧夹',
        favTime: NOW_SEC - 365 * 86400 - index * 10,
      }),
    );
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 1301, fid: 1, mediaCount: 400 },
        { id: 1302, fid: 2, mediaCount: 300 },
        { id: 1303, fid: 3, mediaCount: 200 },
        { id: 1304, fid: 4, mediaCount: 100 },
      ]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: {
        1301: [makePage('a', 1, 9301)],
        1302: [makePage('b', 300, 9302)],
        1303: [makePage('c', 600, 9303)],
        1304: [fixedPage(oldItems, true), fixedPage([])],
      },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteSampled).toBe(60);
    // 1304 的第一页已经全部早于第 60 名，不应再请求第 2 页
    const extraPages = calls.favorites.filter((call) => call.type === 0 && call.pn > 1);
    expect(extraPages).toHaveLength(0);
  });

  it('收藏夹很多时按上限只扫描前 40 个', async () => {
    const folders = Array.from({ length: 50 }, (_, index) => ({
      id: 2000 + index,
      fid: index + 1,
      mediaCount: 1,
    }));
    const pages: Record<number, FavResourceListData[]> = {};
    for (const folder of folders) {
      pages[folder.id] = [
        fixedPage([
          favMedia({
            bvid: `BVcap${folder.id}`,
            upMid: folder.id,
            upName: `夹${folder.id}`,
            favTime: NOW_SEC - folder.id,
          }),
        ]),
      ];
    }
    const { api, calls } = makeStubApi({
      folders: folderList(folders),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: pages,
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteFolders).toBe(50);
    expect(result.signals!.favoriteSampled).toBe(40);
    expect(calls.favorites.filter((call) => call.type === 0)).toHaveLength(40);
    expect(result.degraded).toContain('仅扫描');
  });

  it('单个收藏夹失败不影响其它收藏夹', async () => {
    const { api } = makeStubApi({
      folders: folderList([
        { id: 1401, fid: 1, mediaCount: 5 },
        { id: 1402, fid: 2, mediaCount: 1 },
      ]),
      favoritePages: [new BiliApiError('type=1 不支持', -400, 'fav')],
      fallbackPagesByFolder: {
        1401: [new Error('这个夹失败')],
        1402: [fixedPage([favMedia({ bvid: 'BVgoodFolder', upMid: 9502 })])],
      },
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteSampled).toBe(1);
    expect(result.signals!.favoriteUps.some((up) => up.mid === 9502)).toBe(true);
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

  it('type=1 返回 11010（内容不存在）时回退逐文件夹', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 601, fid: 0, mediaCount: 3 },
        { id: 602, fid: 2, mediaCount: 2 },
      ]),
      favoritePages: [new BiliApiError('您访问的内容不存在', 11010, 'fav')],
      fallbackPages: [favoritePage([favMedia({ bvid: 'BV11010Fallback' })])],
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

  it('收藏夹列表返回 11010 时用分页列表兜底', async () => {
    const { api } = makeStubApi({
      folders: new BiliApiError('您访问的内容不存在', 11010, 'fav'),
      favoritePages: [favoritePage([favMedia({ bvid: 'BVpagedList' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    (api as SignalsApiPort & {
      favFoldersPaged: NonNullable<SignalsApiPort['favFoldersPaged']>;
    }).favFoldersPaged = async () => folderList([{ id: 701, fid: 0, mediaCount: 10 }]);
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals).not.toBeNull();
    expect(result.signals!.favoriteFolders).toBe(1);
    expect(result.signals!.favoriteCount).toBe(10);
    expect(result.signals!.favoriteSampled).toBe(1);
    expect(result.degraded).toBeUndefined();
  });

  it('收藏夹列表为空时也用分页列表兜底', async () => {
    const { api } = makeStubApi({
      folders: { count: 0, list: [] },
      favoritePages: [favoritePage([favMedia({ bvid: 'BVpagedEmptyList' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    (api as SignalsApiPort & {
      favFoldersPaged: NonNullable<SignalsApiPort['favFoldersPaged']>;
    }).favFoldersPaged = async () => folderList([{ id: 702, fid: 0, mediaCount: 8 }]);
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.favoriteFolders).toBe(1);
    expect(result.signals!.favoriteCount).toBe(8);
    expect(result.signals!.favoriteSampled).toBe(1);
  });

  it('默认收藏夹为空时 type=1 仍用默认夹 id，11010 后回退逐文件夹', async () => {
    const { api, calls } = makeStubApi({
      folders: folderList([
        { id: 401, fid: 0, mediaCount: 0 },
        { id: 402, fid: 2, mediaCount: 9 },
      ]),
      favoritePages: [new BiliApiError('您访问的内容不存在', 11010, 'fav')],
      fallbackPages: [favoritePage([favMedia({ bvid: 'BVnonEmptyFolder' })])],
      followingsPages: [{ total: 0, list: [] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    const typeOne = calls.favorites.filter((call) => call.type === 1);
    expect(typeOne[0]!.mediaId).toBe(401);
    expect(result.signals!.favoriteFallback).toBe(true);
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

  it('关注列表按最近关注时间倒序', async () => {
    const { api } = makeStubApi({
      folders: { count: 0, list: [] },
      followingsPages: [
        {
          total: 3,
          list: [
            { mid: 1, uname: 'A', mtime: 100 },
            { mid: 2, uname: 'B', mtime: 300 },
            { mid: 3, uname: 'C', mtime: 200 },
          ],
        },
      ],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW });
    expect(result.signals!.followed.map((row) => row.mid)).toEqual([2, 3, 1]);
    expect(result.signals!.followed.map((row) => row.mtime)).toEqual([300, 200, 100]);
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

  it('收藏失败时不写缓存，下一次仍会重试', async () => {
    const repo = createMemoryRepository();
    const { api } = makeStubApi({
      folders: new BiliApiError('您访问的内容不存在', 11010, 'fav'),
      followingsPages: [{ total: 1, list: [{ mid: 1, uname: 'a' }] }],
      watchLater: { count: 0, list: [] },
    });
    const result = await collectSignals({ api, mid: 12345, nowMs: NOW, repo });
    expect(result.signals).not.toBeNull();
    expect(result.degraded).toContain('收藏夹');
    expect(await repo.getKv(SIGNALS_KV_KEY)).toBeUndefined();
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
