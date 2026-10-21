/**
 * 只读兴趣信号：收藏夹、关注列表、稍后再看。
 *
 * 用途：这些是「不需要历史记录也能表达兴趣」的只读数据，并入画像后能显著改善
 * 「关注/收藏过的 UP」与「稍后再看过的分区」的推荐权重。
 *
 * 实现约定（与实施计划一致）：
 * - 收藏：先取收藏夹列表，优先用 `fid === 0` 的默认收藏夹作为 mlid（没有默认夹时用
 *   media_count 最大的），再用 `type=1`（全部收藏夹）+ `order=mtime` 翻 3 页 × 20，按
 *   `fav_time ?? mtime ?? pubtime` 倒序、bvid 去重后取 60 条；
 * - `type=1` 返回 -400/-404/11010 或空列表（且确实有收藏夹）时，回退为扫描所有
 *   非空收藏夹，按收藏时间取全局最近 60 条（最多 40 个夹、60 次请求），并标记 favoriteFallback；
 * - 关注：2 页 × 50，最多 100 人；稍后再看：1 页 × 20；
 * - 缓存：kv `signals:last:v4`，12 小时内按 mid 复用；任一信号失败时不写缓存，
 *   避免把「0 收藏」这类失败结果缓存 12 小时；
 * - 失败处理：-101（未登录）静默；风控/网络异常时优先用缓存，否则只降级不阻塞主流程。
 */
import { SIGNAL_CONFIG } from '../../shared/constants';
import type {
  FavFolderListData,
  FavFolderRaw,
  FavMediaRaw,
  FavResourceListData,
  FollowingsData,
  RawVideo,
  ToViewData,
} from '../api/endpoints';
import { BiliApiError } from '../api/http';
import type { InterestSignals } from '../../shared/types';
import { resolveParentRegion } from './region';
import { collectTitleTags } from '../profile/tags';

/** 只依赖 4 个只读接口，便于测试注入桩 */
export interface SignalsApiPort {
  favFolders(mid: number): Promise<FavFolderListData>;
  /** 分页收藏夹列表兜底；测试桩可以不实现 */
  favFoldersPaged?(mid: number, pn?: number, ps?: number): Promise<FavFolderListData>;
  favResources(
    mediaId: number,
    options?: { pn?: number; ps?: number; order?: string; type?: 0 | 1 },
  ): Promise<FavResourceListData>;
  followings(mid: number, pn?: number, ps?: number): Promise<FollowingsData>;
  watchLater(pn?: number, ps?: number): Promise<ToViewData>;
}

/** 缓存读写只需要 kv 能力 */
export interface SignalsCachePort {
  getKv<T>(key: string): Promise<T | undefined>;
  setKv<T>(key: string, value: T): Promise<void>;
}

export const SIGNALS_KV_KEY = 'signals:last:v4';

interface SignalsCacheRow {
  mid: number;
  at: number;
  signals: InterestSignals;
}

export interface SignalsInput {
  api: SignalsApiPort;
  mid: number;
  /** 逻辑当前时间（毫秒），用于缓存有效期与 fetchedAt */
  nowMs: number;
  repo?: SignalsCachePort;
  logger?: (message: string, extra?: unknown) => void;
}

export interface SignalsResult {
  signals: InterestSignals | null;
  /** true 表示命中 12 小时缓存，没有发请求 */
  fromCache: boolean;
  /** 有降级时的人类可读说明 */
  degraded?: string;
  /** -101（未登录）时为 true，调用方应静默处理 */
  unauthorized?: boolean;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 未登录错误（静默处理） */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof BiliApiError && error.code === -101;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** fav_time 优先，其次 mtime，最后 pubtime */
function favoriteTimestamp(item: FavMediaRaw): number {
  for (const value of [item.fav_time, item.mtime, item.pubtime]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** 从 bvid / bv_id / link 中提取 bvid */
export function bvidOfFavorite(item: FavMediaRaw): string {
  const direct = (item.bvid ?? item.bv_id ?? '').trim();
  if (direct) return direct;
  const match = /(BV[0-9A-Za-z]{8,12})/.exec(item.link ?? '');
  return match ? match[1]! : '';
}

interface FavoriteSample {
  bvid: string;
  title: string;
  timestamp: number;
  up?: { mid: number; name: string };
}

function toFavoriteSamples(medias: FavMediaRaw[] | null | undefined): FavoriteSample[] {
  const samples: FavoriteSample[] = [];
  for (const media of medias ?? []) {
    if (!media) continue;
    const bvid = bvidOfFavorite(media);
    if (!bvid) continue;
    const up =
      typeof media.upper?.mid === 'number' && media.upper.mid > 0
        ? { mid: media.upper.mid, name: media.upper.name ?? '' }
        : undefined;
    samples.push({
      bvid,
      title: media.title ?? '',
      timestamp: favoriteTimestamp(media),
      up,
    });
  }
  return samples;
}

/** 时间倒序 + bvid 去重 + 截断 */
function pickFavoriteSamples(samples: FavoriteSample[], limit: number): FavoriteSample[] {
  const sorted = [...samples].sort(
    (a, b) => b.timestamp - a.timestamp || a.bvid.localeCompare(b.bvid),
  );
  const seen = new Set<string>();
  const picked: FavoriteSample[] = [];
  for (const sample of sorted) {
    if (seen.has(sample.bvid)) continue;
    seen.add(sample.bvid);
    picked.push(sample);
    if (picked.length >= limit) break;
  }
  return picked;
}

function aggregateFavoriteUps(samples: FavoriteSample[]): Array<{ mid: number; name: string; count: number }> {
  const map = new Map<number, { mid: number; name: string; count: number }>();
  for (const sample of samples) {
    const up = sample.up;
    if (!up || up.mid <= 0) continue;
    const prev = map.get(up.mid);
    if (prev) {
      prev.count += 1;
      if (!prev.name && up.name) prev.name = up.name;
    } else {
      map.set(up.mid, { mid: up.mid, name: up.name, count: 1 });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.mid - b.mid)
    .slice(0, 30);
}

function emptySignals(mid: number, nowMs: number): InterestSignals {
  return {
    fetchedAt: nowMs,
    mid,
    favoriteFolders: 0,
    favoriteCount: 0,
    favoriteSampled: 0,
    favoriteUps: [],
    favoriteTags: [],
    followedTotal: 0,
    followed: [],
    watchLaterCount: 0,
    watchLaterSampled: 0,
    watchLaterRegions: [],
    watchLaterTags: [],
  };
}

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

interface FavoriteResult {
  samples: FavoriteSample[];
  favoriteFolders: number;
  favoriteCount: number;
  favoriteSampled: number;
  favoriteFallback?: boolean;
  degraded?: string;
}

/** 允许触发逐文件夹兼容回退的收藏接口错误码（不含未登录/风控） */
const FAVORITE_FALLBACK_CODES = new Set([-400, -403, -404, 11010]);

function describeSignalsError(error: unknown): string {
  if (error instanceof BiliApiError) {
    if (error.code === -404 || error.code === 11010) {
      return '接口提示内容不存在（可能默认收藏夹为空或接口变更）';
    }
    return `code ${error.code}：${error.message}`;
  }
  return describeError(error);
}

function filterUsableFolders(list: FavFolderRaw[] | null | undefined): FavFolderRaw[] {
  return (list ?? []).filter(
    (folder): folder is FavFolderRaw =>
      Boolean(folder) && typeof folder.id === 'number' && folder.id > 0,
  );
}

/**
 * 读取收藏夹列表：优先 list-all；它返回空或 11010/-404 时，改用分页列表兜底。
 * 对含私密收藏夹或 list-all 被限制的账号，分页接口通常更稳。
 */
async function loadFavoriteFolders(api: SignalsApiPort, mid: number): Promise<FavFolderRaw[]> {
  let listAllError: unknown = null;
  try {
    const data = await api.favFolders(mid);
    const folders = filterUsableFolders(data?.list);
    if (folders.length > 0) return folders;
  } catch (error) {
    if (!(error instanceof BiliApiError) || !FAVORITE_FALLBACK_CODES.has(error.code)) throw error;
    listAllError = error;
  }

  if (!api.favFoldersPaged) {
    if (listAllError) throw listAllError;
    return [];
  }

  const merged: FavFolderRaw[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= SIGNAL_CONFIG.folderMaxPages; page += 1) {
    const data = await api.favFoldersPaged(mid, page, SIGNAL_CONFIG.folderPageSize);
    const pageFolders = filterUsableFolders(data?.list);
    for (const folder of pageFolders) {
      if (!seen.has(folder.id)) {
        seen.add(folder.id);
        merged.push(folder);
      }
    }
    if (pageFolders.length < SIGNAL_CONFIG.folderPageSize) break;
  }
  return merged;
}

function pickPrimaryFolder(folders: FavFolderRaw[]): FavFolderRaw | undefined {
  const usable = folders.filter(
    (folder): folder is FavFolderRaw =>
      Boolean(folder) && typeof folder.id === 'number' && folder.id > 0,
  );
  // type=1 的 media_id 传默认收藏夹 id 最稳妥；默认夹为空时也先用它，
  // 由 -404/11010/空列表触发逐文件夹回退，避免拿非默认夹 id 反而报 11010。
  const byFidZero = usable.find((folder) => folder.fid === 0);
  if (byFidZero) return byFidZero;
  return [...usable].sort((a, b) => (b.media_count ?? 0) - (a.media_count ?? 0))[0];
}

async function fetchFavoritePages(
  api: SignalsApiPort,
  mediaId: number,
  type: 0 | 1,
): Promise<{ medias: FavMediaRaw[]; firstPageEmpty: boolean }> {
  const medias: FavMediaRaw[] = [];
  let firstPageEmpty = false;
  for (let page = 1; page <= SIGNAL_CONFIG.favoritePages; page += 1) {
    const data = await api.favResources(mediaId, {
      pn: page,
      ps: SIGNAL_CONFIG.favoritePageSize,
      order: 'mtime',
      type,
    });
    const list = data?.medias ?? [];
    if (page === 1 && list.length === 0) firstPageEmpty = true;
    medias.push(...list);
    if (list.length < SIGNAL_CONFIG.favoritePageSize) break;
    if (data?.has_more === false) break;
  }
  return { medias, firstPageEmpty };
}

async function fetchFavorites(api: SignalsApiPort, mid: number): Promise<FavoriteResult> {
  const folders = await loadFavoriteFolders(api, mid);
  const favoriteFolders = folders.length;
  const favoriteCount = folders.reduce((sum, folder) => sum + Math.max(0, folder.media_count ?? 0), 0);
  if (folders.length === 0) {
    return { samples: [], favoriteFolders: 0, favoriteCount: 0, favoriteSampled: 0 };
  }
  if (favoriteCount === 0) {
    // 所有收藏夹都是空：不发请求，也不报错（等价于「没有收藏内容」）
    return { samples: [], favoriteFolders, favoriteCount: 0, favoriteSampled: 0 };
  }

  const primary = pickPrimaryFolder(folders);
  if (!primary) {
    return { samples: [], favoriteFolders, favoriteCount, favoriteSampled: 0 };
  }

  let samples: FavoriteSample[] = [];
  let favoriteFallback = false;
  let degraded: string | undefined;

  try {
    const { medias, firstPageEmpty } = await fetchFavoritePages(api, primary.id, 1);
    samples = toFavoriteSamples(medias);
    if (firstPageEmpty) {
      // 全部收藏夹接口返回空但确实有收藏夹：走逐文件夹兼容路径
      favoriteFallback = true;
    }
  } catch (error) {
    if (!(error instanceof BiliApiError) || !FAVORITE_FALLBACK_CODES.has(error.code)) throw error;
    favoriteFallback = true;
  }

  if (favoriteFallback) {
    const fallback = await fetchFallbackFavorites(api, folders);
    samples = fallback.samples;
    degraded =
      samples.length > 0
        ? '「全部收藏夹」接口不可用，已回退为扫描所有收藏夹最近收藏'
        : '「全部收藏夹」接口异常，已跳过收藏信号';
    if (fallback.note) {
      degraded = `${degraded}；${fallback.note}`;
    }
  }

  const picked = pickFavoriteSamples(samples, SIGNAL_CONFIG.favoriteMaxItems);
  return {
    samples: picked,
    favoriteFolders,
    favoriteCount,
    favoriteSampled: picked.length,
    favoriteFallback,
    degraded,
  };
}

interface FolderFetchState {
  folder: FavFolderRaw;
  page: number;
  hasMore: boolean;
  /** 本夹已取到的最旧一条收藏时间；用于判断是否还值得继续翻页 */
  oldestTimestamp: number;
}

interface FallbackFavoritesResult {
  samples: FavoriteSample[];
  note?: string;
}

/**
 * type=1 不可用：扫描所有非空收藏夹，按收藏时间取全局最近 60 条。
 *
 * 先每个收藏夹取第一页，再只对“最旧一条仍可能进入全局前 60”的收藏夹继续翻页，
 * 避免旧的大收藏夹挤掉新建的小收藏夹，也避免无意义地翻完所有页。
 * 上限：最多 40 个收藏夹、每夹 3 页、总请求 60 次。
 */
async function fetchFallbackFavorites(
  api: SignalsApiPort,
  folders: FavFolderRaw[],
): Promise<FallbackFavoritesResult> {
  const nonEmpty = folders.filter((folder) => (folder.media_count ?? 0) > 0);
  // 新文件夹的 id 通常更大；mtime 可用时优先按最近更新排序。
  const candidates = [...nonEmpty]
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || b.id - a.id)
    .slice(0, SIGNAL_CONFIG.fallbackMaxFolders);

  const states: FolderFetchState[] = [];
  const pool: FavoriteSample[] = [];
  let requests = 0;

  const fetchPage = async (state: FolderFetchState, page: number): Promise<void> => {
    if (requests >= SIGNAL_CONFIG.fallbackMaxRequests) return;
    requests += 1;
    try {
      const data = await api.favResources(state.folder.id, {
        pn: page,
        ps: SIGNAL_CONFIG.favoritePageSize,
        order: 'mtime',
        type: 0,
      });
      const medias = data?.medias ?? [];
      const pageSamples = toFavoriteSamples(medias);
      pool.push(...pageSamples);
      state.page = page;
      state.hasMore =
        data?.has_more !== false && medias.length >= SIGNAL_CONFIG.favoritePageSize;
      let oldest = 0;
      for (const sample of pageSamples) {
        if (sample.timestamp > 0 && (oldest === 0 || sample.timestamp < oldest)) {
          oldest = sample.timestamp;
        }
      }
      state.oldestTimestamp = oldest;
    } catch {
      // 单个收藏夹失败不影响其它文件夹
      state.page = page;
      state.hasMore = false;
    }
  };

  // 首轮：所有候选收藏夹各取第一页
  for (const folder of candidates) {
    if (requests >= SIGNAL_CONFIG.fallbackMaxRequests) break;
    const state: FolderFetchState = { folder, page: 0, hasMore: true, oldestTimestamp: 0 };
    states.push(state);
    await fetchPage(state, 1);
  }

  let picked = pickFavoriteSamples(pool, SIGNAL_CONFIG.favoriteMaxItems);
  // 补页：只有仍可能进入全局前 60 的收藏夹才继续翻页
  while (requests < SIGNAL_CONFIG.fallbackMaxRequests) {
    const cutoff =
      picked.length >= SIGNAL_CONFIG.favoriteMaxItems
        ? picked[picked.length - 1]!.timestamp
        : 0;
    const next = states.filter((state) => {
      if (!state.hasMore || state.page >= SIGNAL_CONFIG.fallbackPagesPerFolder) return false;
      if (picked.length < SIGNAL_CONFIG.favoriteMaxItems) return true;
      return state.oldestTimestamp > 0 && state.oldestTimestamp >= cutoff;
    });
    if (next.length === 0) break;
    for (const state of next) {
      if (requests >= SIGNAL_CONFIG.fallbackMaxRequests) break;
      await fetchPage(state, state.page + 1);
    }
    picked = pickFavoriteSamples(pool, SIGNAL_CONFIG.favoriteMaxItems);
  }

  const notes: string[] = [];
  if (states.length < nonEmpty.length) {
    notes.push(`仅扫描最近更新的 ${states.length} 个收藏夹`);
  }
  if (
    requests >= SIGNAL_CONFIG.fallbackMaxRequests &&
    picked.length < SIGNAL_CONFIG.favoriteMaxItems
  ) {
    notes.push(`已达到采样请求上限（${picked.length} 条）`);
  }
  return { samples: pool, note: notes.length > 0 ? notes.join('；') : undefined };
}

/* ------------------------------------------------------------------ */
/* 关注                                                                */
/* ------------------------------------------------------------------ */

interface FollowingResult {
  followed: Array<{ mid: number; name: string; face?: string; mtime?: number }>;
  followedTotal: number;
}

async function fetchFollowings(api: SignalsApiPort, mid: number): Promise<FollowingResult> {
  const seen = new Set<number>();
  const followed: Array<{ mid: number; name: string; face?: string; mtime?: number }> = [];
  let total = 0;
  for (let page = 1; page <= SIGNAL_CONFIG.followingPages; page += 1) {
    const data = await api.followings(mid, page, SIGNAL_CONFIG.followingPageSize);
    const list = data?.list ?? [];
    if (typeof data?.total === 'number' && data.total >= 0) total = data.total;
    for (const row of list) {
      if (!row || typeof row.mid !== 'number' || row.mid <= 0) continue;
      if (seen.has(row.mid)) continue;
      seen.add(row.mid);
      followed.push({ mid: row.mid, name: row.uname ?? '', face: row.face, mtime: row.mtime });
      if (followed.length >= SIGNAL_CONFIG.followingMaxItems) break;
    }
    if (followed.length >= SIGNAL_CONFIG.followingMaxItems) break;
    if (list.length < SIGNAL_CONFIG.followingPageSize) break;
  }
  // 关注列表按最近关注排序；mtime 缺失时保持接口顺序（稳定排序）
  followed.sort((a, b) => {
    const am = a.mtime ?? 0;
    const bm = b.mtime ?? 0;
    if (am === bm) return 0;
    return bm - am;
  });
  return { followed, followedTotal: total > 0 ? total : followed.length };
}

/* ------------------------------------------------------------------ */
/* 稍后再看                                                            */
/* ------------------------------------------------------------------ */

interface WatchLaterResult {
  count: number;
  sampled: number;
  regions: Array<{ name: string; weight: number; count: number }>;
  tags: Array<{ term: string; weight: number; count: number }>;
}

function toWatchLaterResult(data: ToViewData): WatchLaterResult {
  const list = (data?.list ?? []).filter((video): video is RawVideo => Boolean(video));
  const regionMap = new Map<string, number>();
  for (const video of list) {
    const region = resolveParentRegion(video.tname);
    if (region === '其他') continue;
    regionMap.set(region, (regionMap.get(region) ?? 0) + 1);
  }
  const regions = [...regionMap.entries()]
    .map(([name, count]) => ({ name, weight: count, count }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 20);
  return {
    count: typeof data?.count === 'number' ? data.count : list.length,
    sampled: list.length,
    regions,
    tags: collectTitleTags(list.map((video) => video.title ?? '')),
  };
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

export async function readSignalsCache(
  repo: SignalsCachePort | undefined,
  mid: number,
  nowMs: number,
): Promise<{ signals: InterestSignals; fresh: boolean } | null> {
  if (!repo || !mid) return null;
  const row = await repo.getKv<SignalsCacheRow>(SIGNALS_KV_KEY);
  if (!row || !row.signals || row.mid !== mid) return null;
  const fresh = nowMs - row.at <= SIGNAL_CONFIG.cacheTtlMs;
  return { signals: row.signals, fresh };
}

async function writeSignalsCache(
  repo: SignalsCachePort | undefined,
  mid: number,
  signals: InterestSignals,
  nowMs: number,
): Promise<void> {
  if (!repo) return;
  const row: SignalsCacheRow = { mid, at: nowMs, signals };
  await repo.setKv(SIGNALS_KV_KEY, row);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 采集一次只读兴趣信号。不会抛错：所有失败都转成 degraded/unauthorized，
 * 调用方（流水线 signals 阶段）无需 try/catch 即可继续主流程。
 */
export async function collectSignals(input: SignalsInput): Promise<SignalsResult> {
  const { api, mid, nowMs, repo, logger } = input;
  const cached = await readSignalsCache(repo, mid, nowMs);
  if (cached?.fresh) return { signals: cached.signals, fromCache: true };
  const stale = cached?.signals ?? null;

  if (!mid || mid <= 0) {
    if (stale) return { signals: stale, fromCache: true };
    return { signals: null, fromCache: false, unauthorized: true };
  }

  const degraded: string[] = [];
  let favoriteFailed = false;
  let followingFailed = false;
  let watchLaterFailed = false;

  /* ---- 收藏 ---- */
  let favorite: FavoriteResult = {
    samples: [],
    favoriteFolders: 0,
    favoriteCount: 0,
    favoriteSampled: 0,
  };
  try {
    favorite = await fetchFavorites(api, mid);
    if (favorite.degraded) degraded.push(favorite.degraded);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (stale) return { signals: stale, fromCache: true };
      return { signals: null, fromCache: false, unauthorized: true };
    }
    favoriteFailed = true;
    degraded.push(`收藏夹获取失败（${describeSignalsError(error)}）`);
  }

  /* ---- 关注 ---- */
  let following: FollowingResult = { followed: [], followedTotal: 0 };
  try {
    following = await fetchFollowings(api, mid);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (stale) return { signals: stale, fromCache: true };
      return { signals: null, fromCache: false, unauthorized: true };
    }
    followingFailed = true;
    degraded.push(`关注列表获取失败（${describeSignalsError(error)}）`);
  }

  /* ---- 稍后再看 ---- */
  let watchLater: WatchLaterResult = { count: 0, sampled: 0, regions: [], tags: [] };
  try {
    watchLater = toWatchLaterResult(await api.watchLater(1, SIGNAL_CONFIG.watchLaterPageSize));
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (stale) return { signals: stale, fromCache: true };
      return { signals: null, fromCache: false, unauthorized: true };
    }
    watchLaterFailed = true;
    degraded.push(`稍后再看获取失败（${describeSignalsError(error)}）`);
  }

  const allFailed = favoriteFailed && followingFailed && watchLaterFailed;
  if (allFailed) {
    if (stale) {
      return { signals: stale, fromCache: true, degraded: '收藏/关注/稍后再看接口异常，已使用上次缓存' };
    }
    return {
      signals: null,
      fromCache: false,
      degraded: degraded.length > 0 ? degraded.join('；') : '只读信号获取失败',
    };
  }

  // 收藏与稍后再看标题参与标签聚合
  const favoriteTags = collectTitleTags(favorite.samples.map((sample) => sample.title));
  const signals: InterestSignals = {
    ...emptySignals(mid, nowMs),
    favoriteFolders: favorite.favoriteFolders,
    favoriteCount: favorite.favoriteCount,
    favoriteSampled: favorite.favoriteSampled,
    favoriteUps: aggregateFavoriteUps(favorite.samples),
    favoriteTags,
    followedTotal: following.followedTotal,
    followed: following.followed,
    watchLaterCount: watchLater.count,
    watchLaterSampled: watchLater.sampled,
    watchLaterRegions: watchLater.regions,
    watchLaterTags: watchLater.tags,
    ...(favorite.favoriteFallback ? { favoriteFallback: true } : {}),
  };

  // 部分信号失败时不写缓存，避免把 0 收藏/0 关注的结果缓存 12 小时
  if (!favoriteFailed && !followingFailed && !watchLaterFailed) {
    await writeSignalsCache(repo, mid, signals, nowMs);
  }
  logger?.('[signals] 已采集', {
    mid,
    favoriteSampled: signals.favoriteSampled,
    followed: signals.followed.length,
    watchLaterSampled: signals.watchLaterSampled,
    fallback: Boolean(signals.favoriteFallback),
  });

  return {
    signals,
    fromCache: false,
    ...(degraded.length > 0 ? { degraded: degraded.join('；') } : {}),
  };
}
