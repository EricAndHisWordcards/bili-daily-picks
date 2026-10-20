import { BILI_ORIGIN, TTL } from '../../shared/constants';
import { BiliApiError, HttpClient, noopCache, type CacheStore } from './http';
import { buildWbiKeys, signQuery, type WbiKeys } from './wbi';

/**
 * B站 web 接口封装。所有端点集中在这里，接口一旦改版只需要改这一处。
 * 方法返回接口的 data 字段；code !== 0 时抛 BiliApiError。
 */

/* ------------------------------------------------------------------ */
/* 原始响应类型（只声明用到的字段）                                     */
/* ------------------------------------------------------------------ */

export interface RawStat {
  view?: number;
  like?: number;
  favorite?: number;
  coin?: number;
  reply?: number;
  danmaku?: number;
  share?: number;
  his_rank?: number;
  now_rank?: number;
}

export interface RawOwner {
  mid: number;
  name: string;
  face?: string;
}

export interface RawVideo {
  aid: number;
  bvid: string;
  cid?: number;
  tid: number;
  tname: string;
  pic: string;
  title: string;
  pubdate: number;
  ctime?: number;
  desc?: string;
  duration: number;
  videos?: number;
  owner: RawOwner;
  stat: RawStat;
  rcmd_reason?: string | null;
  rank?: number;
}

export interface NavRaw {
  isLogin?: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  wbi_img?: { img_url: string; sub_url: string };
}

export interface NavInfo {
  loggedIn: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  hasWbi: boolean;
}

export interface HistoryRawItem {
  title: string;
  long_title?: string;
  cover?: string;
  view_at: number;
  progress: number;
  duration: number;
  author_name?: string;
  author_mid?: number;
  tag_name?: string;
  is_fav?: number;
  history: {
    oid: number;
    bvid?: string;
    page?: number;
    cid?: number;
    business: string;
    dt?: number;
  };
}

export interface HistoryData {
  cursor: { max: number; view_at: number; business: string; ps: number };
  list: HistoryRawItem[];
  tab?: unknown;
}

export interface PopularData {
  list: RawVideo[];
  no_more?: boolean;
}

export interface RankingData {
  list: RawVideo[];
  note?: string;
}

export interface WeeklyIssue {
  number: number;
  subject: string;
  status: number;
  name: string;
}

export interface WeeklyListData {
  list: WeeklyIssue[];
}

export interface WeeklyOneData {
  subject?: string;
  label?: string;
  share_subtitle?: string;
  list: RawVideo[];
}

export interface RcmdItem {
  id: number;
  bvid?: string;
  cid?: number;
  goto: string;
  title: string;
  pic: string;
  duration: number;
  pubdate: number;
  owner: RawOwner;
  stat?: { view?: number; like?: number; danmaku?: number };
  is_followed?: number;
  rcmd_reason?: string | null;
}

export interface RcmdData {
  item: RcmdItem[];
}

export type RelatedData = RawVideo[];

export interface ViewData {
  aid: number;
  bvid: string;
  cid?: number;
  tid: number;
  tname: string;
  pic: string;
  title: string;
  pubdate: number;
  duration: number;
  videos?: number;
  owner: RawOwner;
  stat: RawStat;
}

export interface TagData {
  tag_id: number;
  tag_name: string;
}

/* 收藏夹（需要登录；全部收藏夹用 type=1） */
export interface FavFolderRaw {
  id: number;
  fid?: number;
  mid?: number;
  attr?: number;
  title?: string;
  fav_state?: number;
  media_count?: number;
}

export interface FavFolderListData {
  count?: number;
  list?: FavFolderRaw[] | null;
}

export interface FavMediaRaw {
  id?: number;
  type?: number;
  title?: string;
  cover?: string;
  link?: string;
  bvid?: string;
  bv_id?: string;
  page?: number;
  duration?: number;
  upper?: RawOwner;
  cnt_info?: { collect?: number; play?: number; danmaku?: number; vt?: number };
  fav_time?: number;
  mtime?: number;
  pubtime?: number;
}

export interface FavResourceListData {
  info?: unknown;
  medias?: FavMediaRaw[] | null;
  has_more?: boolean;
}

export interface FollowingRaw {
  mid: number;
  uname?: string;
  face?: string;
  sign?: string;
  attribute?: number;
  mtime?: number;
}

export interface FollowingsData {
  list?: FollowingRaw[] | null;
  total?: number;
}

export interface ToViewData {
  count?: number;
  list?: RawVideo[] | null;
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

export const BILI_PATHS = {
  nav: '/x/web-interface/nav',
  history: '/x/web-interface/history/cursor',
  popular: '/x/web-interface/popular',
  ranking: '/x/web-interface/ranking/v2',
  weeklyList: '/x/web-interface/popular/series/list',
  weeklyOne: '/x/web-interface/popular/series/one',
  rcmd: '/x/web-interface/wbi/index/top/feed/rcmd',
  related: '/x/web-interface/archive/related',
  view: '/x/web-interface/view',
  tags: '/x/tag/archive/tags',
  favFolders: '/x/v3/fav/folder/created/list-all',
  favResources: '/x/v3/fav/resource/list',
  followings: '/x/relation/followings',
  watchLater: '/x/v2/history/toview',
} as const;

export interface BiliApiOptions {
  cache?: CacheStore;
  origin?: string;
}

function urlWith(path: string, params: Record<string, string | number | undefined>): string {
  const search: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return search.length ? `${path}?${search.join('&')}` : path;
}

export class BiliApi {
  private readonly cache: CacheStore;

  constructor(
    private readonly http: HttpClient,
    private readonly options: BiliApiOptions = {},
  ) {
    this.cache = options.cache ?? noopCache;
  }

  private get origin(): string {
    return this.options.origin ?? BILI_ORIGIN;
  }

  /** 登录态。未登录返回 loggedIn=false 而不是抛错 */
  async nav(force = false): Promise<NavInfo> {
    const cacheKey = 'bili:nav';
    if (!force) {
      const cached = await this.cache.get<NavInfo>(cacheKey);
      if (cached) return cached.value;
    }
    const envelope = await this.http.get<NavRaw>(`${this.origin}${BILI_PATHS.nav}`);
    const data = envelope.data ?? {};
    if (envelope.code !== 0 && envelope.code !== -101) {
      throw new BiliApiError(envelope.message || `nav 返回 ${envelope.code}`, envelope.code, 'nav');
    }
    const info: NavInfo = {
      loggedIn: Boolean(data.isLogin),
      mid: data.mid,
      uname: data.uname,
      face: data.face,
      hasWbi: Boolean(data.wbi_img?.img_url && data.wbi_img?.sub_url),
    };
    await this.cache.set(cacheKey, info, 60_000);
    if (data.wbi_img?.img_url && data.wbi_img.sub_url) {
      await this.cache.set(
        'bili:wbi',
        buildWbiKeys(data.wbi_img.img_url, data.wbi_img.sub_url),
        TTL.wbi,
      );
    }
    return info;
  }

  async getWbiKeys(force = false): Promise<WbiKeys> {
    if (!force) {
      const cached = await this.cache.get<WbiKeys>('bili:wbi');
      if (cached) return cached.value;
    }
    const envelope = await this.http.get<NavRaw>(`${this.origin}${BILI_PATHS.nav}`);
    const wbi = envelope.data?.wbi_img;
    if (!wbi?.img_url || !wbi.sub_url) {
      throw new BiliApiError('拿不到 WBI 密钥', envelope.code, 'nav');
    }
    const keys = buildWbiKeys(wbi.img_url, wbi.sub_url);
    await this.cache.set('bili:wbi', keys, TTL.wbi);
    return keys;
  }

  private async signed<T>(
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const attempt = async (forceKeys: boolean): Promise<T> => {
      const keys = await this.getWbiKeys(forceKeys);
      const url = `${this.origin}${path}?${signQuery(params, keys.mixinKey)}`;
      return this.http.getJson<T>(url);
    };
    try {
      return await attempt(false);
    } catch (error) {
      if (error instanceof BiliApiError && (error.code === -352 || error.code === -403)) {
        return attempt(true);
      }
      throw error;
    }
  }

  async history(params: { ps?: number; max?: number; viewAt?: number } = {}): Promise<HistoryData> {
    const url = `${this.origin}${urlWith(BILI_PATHS.history, {
      type: 'archive',
      ps: params.ps ?? 20,
      max: params.max ?? 0,
      view_at: params.viewAt ?? 0,
    })}`;
    return this.http.getJson<HistoryData>(url);
  }

  async popular(pn = 1, ps = 50): Promise<PopularData> {
    const url = `${this.origin}${urlWith(BILI_PATHS.popular, { pn, ps })}`;
    return this.http.getJson<PopularData>(url);
  }

  async ranking(rid = 0): Promise<RankingData> {
    const url = `${this.origin}${urlWith(BILI_PATHS.ranking, { rid, type: 'all' })}`;
    return this.http.getJson<RankingData>(url);
  }

  async weeklyList(): Promise<WeeklyListData> {
    return this.http.getJson<WeeklyListData>(`${this.origin}${BILI_PATHS.weeklyList}`);
  }

  async weeklyOne(number: number): Promise<WeeklyOneData> {
    return this.signed<WeeklyOneData>(BILI_PATHS.weeklyOne, { number });
  }

  async rcmd(freshIdx = 1, ps = 6): Promise<RcmdData> {
    return this.signed<RcmdData>(BILI_PATHS.rcmd, {
      ps,
      fresh_idx: freshIdx,
      fresh_type: 4,
      web_location: 1430650,
    });
  }

  async related(bvid: string): Promise<RelatedData> {
    return this.http.getJson<RelatedData>(
      `${this.origin}${urlWith(BILI_PATHS.related, { bvid })}`,
    );
  }

  async view(bvid: string): Promise<ViewData> {
    return this.http.getJson<ViewData>(`${this.origin}${urlWith(BILI_PATHS.view, { bvid })}`);
  }

  async tags(bvid: string): Promise<TagData[]> {
    return this.http.getJson<TagData[]>(
      `${this.origin}${urlWith(BILI_PATHS.tags, { bvid })}`,
    );
  }

  /** 用户创建的全部收藏夹（需要登录） */
  async favFolders(mid: number): Promise<FavFolderListData> {
    return this.http.getJson<FavFolderListData>(
      `${this.origin}${urlWith(BILI_PATHS.favFolders, { up_mid: mid })}`,
    );
  }

  /**
   * 收藏夹内容。type=1 表示全部收藏夹（配合 order=mtime 即按收藏时间），
   * media_id 仍必填，传默认收藏夹的 mlid 即可。
   */
  async favResources(
    mediaId: number,
    options: { pn?: number; ps?: number; order?: string; type?: 0 | 1 } = {},
  ): Promise<FavResourceListData> {
    return this.http.getJson<FavResourceListData>(
      `${this.origin}${urlWith(BILI_PATHS.favResources, {
        media_id: mediaId,
        pn: options.pn ?? 1,
        ps: options.ps ?? 20,
        order: options.order ?? 'mtime',
        type: options.type ?? 1,
        platform: 'web',
      })}`,
    );
  }

  /** 关注列表（需要登录） */
  async followings(mid: number, pn = 1, ps = 50): Promise<FollowingsData> {
    return this.http.getJson<FollowingsData>(
      `${this.origin}${urlWith(BILI_PATHS.followings, { vmid: mid, pn, ps, order: 'desc' })}`,
    );
  }

  /** 稍后再看（需要登录） */
  async watchLater(pn = 1, ps = 20): Promise<ToViewData> {
    return this.http.getJson<ToViewData>(
      `${this.origin}${urlWith(BILI_PATHS.watchLater, { pn, ps })}`,
    );
  }
}

/** 便捷构造：默认不带中转，测试与探针脚本使用 */
export function createBiliApi(http: HttpClient, options?: BiliApiOptions): BiliApi {
  return new BiliApi(http, options);
}
