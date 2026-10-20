/**
 * engine 单元测试公共工具（不联网）：
 * - 从 tests/fixtures/api 读取真实接口响应
 * - 用固定 fetcher 把 HttpClient / BiliApi 接到 fixture 上
 * - 构造内存 Repository、内存设置、流水线沙箱
 * - 构造 Candidate / HistoryRecord / ScoredCandidate 测试数据
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Candidate,
  GrowthInfo,
  HistoryRecord,
  PipelineState,
  Settings,
  SnapshotRow,
  VideoStat,
} from '../../../src/shared/types';
import {
  BILI_PATHS,
  BiliApi,
  type FavFolderListData,
  type FavMediaRaw,
  type FavResourceListData,
  type FollowingsData,
  type HistoryData,
  type HistoryRawItem,
  type NavRaw,
  type PopularData,
  type RankingData,
  type RcmdData,
  type RawVideo,
  type RelatedData,
  type TagData,
  type ToViewData,
  type ViewData,
  type WeeklyListData,
  type WeeklyOneData,
} from '../../../src/core/api/endpoints';
import { HttpClient } from '../../../src/core/api/http';
import { createPipeline } from '../../../src/core/pipeline';
import type { PipelineController, PipelineDeps } from '../../../src/core/pipeline-contract';
import type { CandidateSourcesPort } from '../../../src/core/sources/candidates';
import type { EnrichApiPort } from '../../../src/core/sources/enrich';
import {
  createMemoryRepository,
  createRepositoryCache,
  type Repository,
} from '../../../src/core/store/repository';
import { createMemorySettingsStore, type SettingsStore } from '../../../src/core/store/settings';

/** 固定「当前时间」：fixture 抓取时间（2026-10-20）之后一分钟，保证年龄/日期稳定 */
export const FIXTURE_NOW = 1_792_510_000_000;

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/api');

/** 读取 fixture JSON */
export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8')) as T;
}

export function fixtureEnvelope<T>(data: T, code = 0, message = '0'): { code: number; message: string; data: T } {
  return { code, message, data };
}

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 空响应数据（模拟接口返回空列表） */
function emptyDataOf(pathname: string): unknown {
  switch (pathname) {
    case BILI_PATHS.history:
      return { cursor: { max: 0, view_at: 0, business: '', ps: 20 }, list: [] };
    case BILI_PATHS.popular:
      return { list: [], no_more: true };
    case BILI_PATHS.ranking:
      return { list: [] };
    case BILI_PATHS.weeklyList:
      return { list: [] };
    case BILI_PATHS.weeklyOne:
      return { list: [] };
    case BILI_PATHS.rcmd:
      return { item: [] };
    case BILI_PATHS.related:
      return [];
    case BILI_PATHS.tags:
      return [];
    case BILI_PATHS.favFolders:
      return { count: 0, list: [] };
    case BILI_PATHS.favResources:
      return { medias: [], has_more: false };
    case BILI_PATHS.followings:
      return { list: [], total: 0 };
    case BILI_PATHS.watchLater:
      return { count: 0, list: [] };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* 只读信号 fixture（收藏/关注/稍后再看）                               */
/* ------------------------------------------------------------------ */

export interface SignalsFixtureOptions {
  /** 收藏夹列表；不传用默认（2 个收藏夹，默认收藏夹 media_count=120） */
  folders?: FavFolderListData;
  /** type=1（全部收藏夹）分页；默认 3 页 × 20 条 */
  favoritePages?: FavResourceListData[];
  /** type=0 回退路径分页；默认与 favoritePages 相同 */
  fallbackPages?: FavResourceListData[];
  /** 关注列表分页；默认 2 页（50 + 25） */
  followingsPages?: FollowingsData[];
  /** 稍后再看；默认 4 条稿件 */
  watchLater?: ToViewData;
}

const SIGNAL_BASE_SEC = Math.floor(FIXTURE_NOW / 1000);

/** 默认收藏夹列表 */
export function defaultFavFolders(): FavFolderListData {
  return {
    count: 2,
    list: [
      { id: 501, fid: 0, mid: 12345, title: '默认收藏夹', media_count: 120 },
      { id: 502, fid: 1, mid: 12345, title: '动画', media_count: 12 },
    ],
  };
}

/** 默认「全部收藏夹」分页：3 页 × 20 条，10 个 UP、6 类主题，收藏时间递减 */
export function defaultFavoritePages(): FavResourceListData[] {
  const pages: FavResourceListData[] = [];
  for (let page = 0; page < 3; page += 1) {
    const medias: FavMediaRaw[] = [];
    for (let index = 0; index < 20; index += 1) {
      const order = page * 20 + index;
      medias.push({
        id: 900000 + order,
        type: 2,
        title: `收藏视频 主题${order % 6}`,
        cover: 'https://example.com/fav.jpg',
        bvid: `BVfav${String(order).padStart(4, '0')}`,
        duration: 200 + (order % 5) * 60,
        upper: { mid: 3000 + (order % 10), name: `收藏UP${order % 10}` },
        fav_time: SIGNAL_BASE_SEC - order * 60,
        pubtime: SIGNAL_BASE_SEC - order * 600,
      });
    }
    pages.push({ medias, has_more: page < 2 });
  }
  return pages;
}

/** 默认关注列表：2 页（50 + 25） */
export function defaultFollowingsPages(): FollowingsData[] {
  return [
    {
      total: 75,
      list: Array.from({ length: 50 }, (_, index) => ({
        mid: 4000 + index,
        uname: `关注UP${index}`,
        face: 'https://example.com/face.jpg',
      })),
    },
    {
      total: 75,
      list: Array.from({ length: 25 }, (_, index) => ({
        mid: 4050 + index,
        uname: `关注UP${50 + index}`,
        face: 'https://example.com/face.jpg',
      })),
    },
  ];
}

/** 默认稍后再看：4 条稿件（游戏 3 条、知识 1 条） */
export function defaultWatchLater(): ToViewData {
  const makeVideo = (bvid: string, title: string, tname: string, tid: number): RawVideo => ({
    aid: Number(bvid.replace(/\D/g, '')) || 1,
    bvid,
    cid: 1000,
    tid,
    tname,
    pic: 'https://example.com/cover.jpg',
    title,
    pubdate: SIGNAL_BASE_SEC - 3600,
    duration: 300,
    owner: { mid: 3000, name: '收藏UP0' },
    stat: { view: 1000, like: 10, favorite: 10, coin: 1, reply: 1, danmaku: 1, share: 1 },
  });
  return {
    count: 6,
    list: [
      makeVideo('BVlater0001', '稍后再看 游戏攻略', '手机游戏', 172),
      makeVideo('BVlater0002', '稍后再看 游戏比赛', '电子竞技', 171),
      makeVideo('BVlater0003', '稍后再看 单机游戏', '单机游戏', 17),
      makeVideo('BVlater0004', '稍后再看 科学科普', '科学科普', 201),
    ],
  };
}

export interface FixtureFetcherOptions {
  /** 是否已登录（nav.isLogin） */
  loggedIn?: boolean;
  /** 这些 pathname 返回 -412 风控 */
  fail?: string[];
  /** pathname -> 返回的业务错误码（如 -101/-400），用于测试未登录/兼容回退 */
  failCode?: Record<string, number>;
  /** 这些 pathname 返回空数据 */
  empty?: string[];
  /** 历史分页数据；不传时返回空历史 */
  historyPages?: HistoryData[];
  /** 覆盖 /view 返回的数据 */
  viewData?: ViewData;
  /** 覆盖 /tag/archive/tags 返回的数据 */
  tagData?: TagData[];
  /** 只读兴趣信号（收藏/关注/稍后再看）的分页数据 */
  signals?: SignalsFixtureOptions;
  /** 覆盖任意 pathname 的 data */
  extra?: Record<string, unknown>;
}

export interface FixtureFetcherHarness {
  fetcher: typeof fetch;
  /** 按调用顺序记录的 pathname */
  calls: string[];
  /** 某个 pathname 的调用次数 */
  countOf: (pathname: string) => number;
}

/** 用 fixture 构造一个假的 fetch：不访问网络，按 URL 路径返回真实响应结构 */
export function createFixtureFetcher(options: FixtureFetcherOptions = {}): FixtureFetcherHarness {
  const calls: string[] = [];
  const navFixture = loadFixture<{ data: NavRaw }>('nav.json');
  const popularFixture = loadFixture<{ data: PopularData }>('popular.json');
  const rankingAll = loadFixture<{ data: RankingData }>('ranking-0.json');
  const rankingRegion = loadFixture<{ data: RankingData }>('ranking-4.json');
  const weeklyListFixture = loadFixture<{ data: WeeklyListData }>('weekly-list.json');
  const weeklyOneFixture = loadFixture<{ data: WeeklyOneData }>('weekly-one.json');
  const rcmdFixture = loadFixture<{ data: RcmdData }>('rcmd.json');
  const relatedFixture = loadFixture<{ data: RelatedData }>('related.json');
  const viewFixture = loadFixture<{ data: ViewData }>('view.json');
  const tagsFixture = loadFixture<{ data: TagData[] }>('tags.json');
  const historyPages = options.historyPages ?? [];
  const signalFolders = options.signals?.folders ?? defaultFavFolders();
  const signalFavoritePages = options.signals?.favoritePages ?? defaultFavoritePages();
  const signalFallbackPages = options.signals?.fallbackPages ?? signalFavoritePages;
  const signalFollowingsPages = options.signals?.followingsPages ?? defaultFollowingsPages();
  const signalWatchLater = options.signals?.watchLater ?? defaultWatchLater();

  const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    calls.push(pathname);

    if (options.fail?.includes(pathname)) {
      return jsonResponse({ code: -412, message: '请求被风控拦截', ttl: 1, data: null });
    }
    if (options.failCode && pathname in options.failCode) {
      const code = options.failCode[pathname]!;
      return jsonResponse({
        code,
        message: code === -101 ? '账号未登录' : `业务错误 ${code}`,
        ttl: 1,
        data: null,
      });
    }
    if (options.extra && pathname in options.extra) {
      return jsonResponse(fixtureEnvelope(options.extra[pathname]));
    }
    if (options.empty?.includes(pathname)) {
      return jsonResponse(fixtureEnvelope(emptyDataOf(pathname)));
    }

    switch (pathname) {
      case BILI_PATHS.nav: {
        const data: NavRaw = {
          ...navFixture.data,
          isLogin: Boolean(options.loggedIn),
          mid: options.loggedIn ? 12345 : undefined,
          uname: options.loggedIn ? '测试用户' : undefined,
        };
        return jsonResponse(fixtureEnvelope(data));
      }
      case BILI_PATHS.history: {
        const max = Number(url.searchParams.get('max') ?? 0);
        const viewAt = Number(url.searchParams.get('view_at') ?? 0);
        let index = 0;
        if (max !== 0 || viewAt !== 0) {
          index = historyPages.findIndex(
            (page) => page.cursor.max === max && page.cursor.view_at === viewAt,
          );
          if (index < 0) {
            return jsonResponse(fixtureEnvelope(emptyDataOf(BILI_PATHS.history)));
          }
          index += 1;
        }
        const page = historyPages[index];
        if (!page) return jsonResponse(fixtureEnvelope(emptyDataOf(BILI_PATHS.history)));
        return jsonResponse(fixtureEnvelope(page));
      }
      case BILI_PATHS.popular: {
        // 热门接口有 pn 参数：第一页返回 30 条，第二页返回后 10 条，模拟分页
        const pn = Number(url.searchParams.get('pn') ?? 1);
        const list = popularFixture.data.list ?? [];
        const pageList = pn === 1 ? list : list.slice(20);
        return jsonResponse(
          fixtureEnvelope({ list: pageList, no_more: pn >= 2 }),
        );
      }
      case BILI_PATHS.ranking: {
        const rid = Number(url.searchParams.get('rid') ?? 0);
        const data = rid === 0 ? rankingAll.data : rankingRegion.data;
        return jsonResponse(fixtureEnvelope(data));
      }
      case BILI_PATHS.weeklyList:
        return jsonResponse(fixtureEnvelope(weeklyListFixture.data));
      case BILI_PATHS.weeklyOne:
        return jsonResponse(fixtureEnvelope(weeklyOneFixture.data));
      case BILI_PATHS.rcmd:
        return jsonResponse(fixtureEnvelope(rcmdFixture.data));
      case BILI_PATHS.related:
        return jsonResponse(fixtureEnvelope(relatedFixture.data));
      case BILI_PATHS.view: {
        const bvid = url.searchParams.get('bvid') ?? viewFixture.data.bvid;
        const data = { ...(options.viewData ?? viewFixture.data), bvid };
        return jsonResponse(fixtureEnvelope(data));
      }
      case BILI_PATHS.tags:
        return jsonResponse(fixtureEnvelope(options.tagData ?? tagsFixture.data));
      case BILI_PATHS.favFolders:
        return jsonResponse(fixtureEnvelope(signalFolders));
      case BILI_PATHS.favResources: {
        const type = Number(url.searchParams.get('type') ?? 1);
        const pn = Number(url.searchParams.get('pn') ?? 1);
        const pages = type === 1 ? signalFavoritePages : signalFallbackPages;
        const data = pages[pn - 1] ?? { medias: [], has_more: false };
        return jsonResponse(fixtureEnvelope(data));
      }
      case BILI_PATHS.followings: {
        const pn = Number(url.searchParams.get('pn') ?? 1);
        const data = signalFollowingsPages[pn - 1] ?? { list: [], total: 0 };
        return jsonResponse(fixtureEnvelope(data));
      }
      case BILI_PATHS.watchLater:
        return jsonResponse(fixtureEnvelope(signalWatchLater));
      default:
        return jsonResponse({ code: -404, message: '未找到', ttl: 1, data: null });
    }
  }) as typeof fetch;

  return {
    fetcher,
    calls,
    countOf: (pathname: string) => calls.filter((call) => call === pathname).length,
  };
}

export interface FixtureApiHarness {
  api: BiliApi;
  http: HttpClient;
  fetcher: FixtureFetcherHarness;
  calls: string[];
  countOf: (pathname: string) => number;
}

/** 构造接到 fixture 上的 HttpClient（不限流、不重试，测试秒级完成） */
export function createFixtureHttp(options: FixtureFetcherOptions = {}): {
  http: HttpClient;
  fetcher: FixtureFetcherHarness;
} {
  const fetcher = createFixtureFetcher(options);
  const http = new HttpClient({
    fetcher: fetcher.fetcher,
    minGapMs: 0,
    maxConcurrent: 4,
    retries: 0,
    timeoutMs: 2000,
    sleep: async () => {},
  });
  return { http, fetcher };
}

/** 构造接到 fixture 上的 BiliApi（传入 repo 时 WBI 密钥会缓存到 kv，贴近生产） */
export function createFixtureBiliApi(
  options: FixtureFetcherOptions = {},
  repo?: Repository,
): FixtureApiHarness {
  const { http, fetcher } = createFixtureHttp(options);
  const api = new BiliApi(http, repo ? { cache: createRepositoryCache(repo) } : {});
  return { api, http, fetcher, calls: fetcher.calls, countOf: fetcher.countOf };
}

/* ------------------------------------------------------------------ */
/* 历史记录 fixture                                                     */
/* ------------------------------------------------------------------ */

/** 把 HistoryRecord 反向构造成 history/cursor 的原始条目 */
export function toRawHistoryItem(record: HistoryRecord): HistoryRawItem {
  return {
    title: record.title,
    cover: record.cover,
    view_at: record.viewedAt,
    progress: record.progress,
    duration: record.duration,
    author_name: record.authorName,
    author_mid: record.authorMid,
    tag_name: record.tname,
    is_fav: record.isFav ? 1 : 0,
    history: { oid: 1, bvid: record.bvid, business: 'archive' },
  };
}

/** 把 HistoryRecord 列表切成 history/cursor 分页响应 */
export function makeHistoryPages(records: HistoryRecord[], pageSize = 20): HistoryData[] {
  const pages: HistoryData[] = [];
  for (let offset = 0; offset < records.length; offset += pageSize) {
    const slice = records.slice(offset, offset + pageSize);
    const last = slice[slice.length - 1];
    const hasNext = offset + pageSize < records.length;
    pages.push({
      cursor: {
        max: hasNext ? pages.length + 1 : 0,
        view_at: hasNext ? (last?.viewedAt ?? 0) : 0,
        business: 'archive',
        ps: pageSize,
      },
      list: slice.map(toRawHistoryItem),
    });
  }
  return pages;
}

let recordSeq = 0;

/** 构造一条历史记录（默认近 1 小时、看完的手机游戏视频） */
export function makeHistoryRecord(
  input: Partial<HistoryRecord> & { bvid?: string } = {},
): HistoryRecord {
  recordSeq += 1;
  const bvid = input.bvid ?? `BVhist${String(recordSeq).padStart(4, '0')}`;
  return {
    bvid,
    title: `测试视频 ${recordSeq}`,
    cover: 'https://example.com/cover.jpg',
    viewedAt: Math.floor(FIXTURE_NOW / 1000) - 3600,
    duration: 300,
    progress: 240,
    tname: '手机游戏',
    parentRegion: '游戏',
    authorMid: 900000 + recordSeq,
    authorName: `UP主${recordSeq}`,
    isFav: false,
    ...input,
  };
}

/* ------------------------------------------------------------------ */
/* 候选 fixture                                                        */
/* ------------------------------------------------------------------ */

/** 构造一个字段完整的 Candidate */
export function makeCandidate(input: Partial<Candidate> & { bvid: string }): Candidate {
  const stat: VideoStat = {
    view: 100_000,
    like: 5_000,
    favorite: 2_000,
    coin: 800,
    reply: 300,
    danmaku: 100,
    share: 50,
    ...(input.stat ?? {}),
  };
  const base: Candidate = {
    bvid: input.bvid,
    title: `候选视频 ${input.bvid}`,
    cover: 'https://example.com/cover.jpg',
    duration: 300,
    pubdate: Math.floor(FIXTURE_NOW / 1000) - 3 * 86400,
    tid: 172,
    tname: '手机游戏',
    parentRegion: '游戏',
    owner: { mid: 1000, name: 'UP主' },
    sources: [{ kind: 'popular' }],
    stat,
  };
  return { ...base, ...input, stat };
}

/** 构造一条增长信息 */
export function makeGrowth(view: number, hours = 24, estimated = false): GrowthInfo {
  return { hours, view, favorite: 10, reply: 5, estimated };
}

export function makeSnapshot(bvid: string, ts: number, view: number): SnapshotRow {
  return {
    bvid,
    ts,
    stat: { view, like: 0, favorite: 0, coin: 0, reply: 0, danmaku: 0, share: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* 候选源 / 补全接口桩                                                  */
/* ------------------------------------------------------------------ */

/** 六类候选源的空实现，测试里按需覆盖 */
export function createStubSources(
  overrides: Partial<CandidateSourcesPort> = {},
): CandidateSourcesPort {
  const base: CandidateSourcesPort = {
    popular: async () => ({ list: [], no_more: true }),
    ranking: async () => ({ list: [] }),
    weeklyList: async () => ({ list: [] }),
    weeklyOne: async () => ({ list: [] }),
    rcmd: async () => ({ item: [] }),
    related: async () => [],
  };
  return { ...base, ...overrides };
}

/** 补全接口桩：记录调用次数 */
export interface StubEnrichApi extends EnrichApiPort {
  viewCalls: string[];
  tagCalls: string[];
}

export function createStubEnrichApi(overrides: Partial<EnrichApiPort> = {}): StubEnrichApi {
  const viewCalls: string[] = [];
  const tagCalls: string[] = [];
  const viewFixture = loadFixture<{ data: ViewData }>('view.json').data;
  const tagsFixture = loadFixture<{ data: TagData[] }>('tags.json').data;
  const api: StubEnrichApi = {
    viewCalls,
    tagCalls,
    async view(bvid: string) {
      viewCalls.push(bvid);
      if (overrides.view) return overrides.view(bvid);
      return { ...viewFixture, bvid };
    },
    async tags(bvid: string) {
      tagCalls.push(bvid);
      if (overrides.tags) return overrides.tags(bvid);
      return tagsFixture;
    },
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* 流水线沙箱                                                          */
/* ------------------------------------------------------------------ */

export interface PipelineHarness {
  deps: PipelineDeps;
  controller: PipelineController;
  repo: Repository;
  settings: SettingsStore;
  http: HttpClient;
  api: BiliApi;
  fetcher: FixtureFetcherHarness;
  calls: string[];
}

export interface PipelineHarnessOptions extends FixtureFetcherOptions {
  settings?: Partial<Settings>;
  now?: number;
}

/** 用 fixture + 内存存储构造完整流水线（保证不联网） */
export function createPipelineHarness(options: PipelineHarnessOptions = {}): PipelineHarness {
  const repo = createMemoryRepository();
  const settings = createMemorySettingsStore(options.settings);
  const { api, http, fetcher } = createFixtureBiliApi(options, repo);
  const mapNow = options.now ?? FIXTURE_NOW;
  const deps: PipelineDeps = {
    repo,
    settings,
    api,
    http,
    now: () => mapNow,
    logger: () => {},
  };
  const controller = createPipeline(deps);
  return { deps, controller, repo, settings, http, api, fetcher, calls: fetcher.calls };
}

/** 反复 tick 直到流水线结束（或达到上限） */
export async function drainPipeline(
  controller: PipelineController,
  maxTicks = 20,
): Promise<Awaited<ReturnType<PipelineController['tick']>>> {
  let status = await controller.tick();
  for (let i = 0; i < maxTicks && status.running; i += 1) {
    status = await controller.tick();
  }
  return status;
}

/** 构造一个可续跑的流水线状态 */
export function makePipelineState(
  input: Partial<PipelineState> & { stage: PipelineState['stage'] },
): PipelineState {
  return {
    runId: 'test-run',
    startedAt: FIXTURE_NOW - 60_000,
    updatedAt: FIXTURE_NOW - 60_000,
    dueAt: FIXTURE_NOW - 60_000,
    force: false,
    mode: 'public',
    historyPages: 0,
    historyCursor: null,
    history: [],
    candidates: [],
    sourceIndex: 0,
    enrichIndex: 0,
    requests: 0,
    ...input,
  };
}

/** 从 history.sample.json 读取 48 条历史记录（作为已映射的 HistoryRecord 用） */
export function loadSampleHistory(): HistoryRecord[] {
  const fixture = loadFixture<{ list: HistoryRecord[] }>('history.sample.json');
  return fixture.list;
}

/** 构造画像（默认只有分区亲和），用于打分/分组测试 */
export function makeProfile(
  regions: Array<{ name: string; affinity: number; count?: number }> = [
    { name: '游戏', affinity: 1 },
    { name: '知识', affinity: 0.8 },
    { name: '音乐', affinity: 0.6 },
  ],
): import('../../../src/shared/types').Profile {
  return {
    generatedAt: FIXTURE_NOW,
    sample: { total: 30, last7d: 10, windowDays: 90 },
    regions: regions.map((row) => ({ name: row.name, affinity: row.affinity, count: row.count ?? 3 })),
    tags: [],
    ups: [],
    hours: new Array<number>(24).fill(0),
    completionRate: 0.6,
    avgDuration: 400,
    preferredDuration: { p10: 60, p90: 1200 },
  };
}
