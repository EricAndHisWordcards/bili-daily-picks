/**
 * 历史记录采集：分页抓 `/x/web-interface/history/cursor`，映射成 HistoryRecord。
 *
 * 约束（见实施计划）：
 * - 只取最近 90 天，最多 30 页（HISTORY_PAGE_SIZE = 20，即最多 600 条）
 * - 只保留业务类型为 archive 且有 bvid 的记录（直播/番剧/专栏等跳过）
 * - tag_name 经 region-seed 映射一级分区，未知归「其他」
 * - 同 bvid 多次观看只保留最近一次（isFav 取「或」）
 *
 * 为了适配「每分钟 tick、单次 ≤20 秒」的分片流水线，抓取按页进行：一次调用只请求一页，
 * 游标与页数由调用方（PipelineState）持久化，Service Worker 被回收后可续跑。
 */
import {
  HISTORY_MAX_PAGES,
  HISTORY_PAGE_SIZE,
  HISTORY_WINDOW_DAYS,
} from '../../shared/constants';
import type { HistoryData, HistoryRawItem } from '../api/endpoints';
import { DAY } from '../../shared/time';
import type { HistoryRecord } from '../../shared/types';
import { resolveParentRegion } from './region';

/** 只依赖 history 方法，方便测试注入桩 */
export interface HistoryApiPort {
  history(params?: { ps?: number; max?: number; viewAt?: number }): Promise<HistoryData>;
}

/** 历史游标（`max` / `view_at` 都由接口原样返回） */
export interface HistoryCursor {
  max: number;
  /** 秒级时间戳 */
  viewAt: number;
}

export interface FetchHistoryChunkInput {
  api: HistoryApiPort;
  /** 已抓页数，0 表示第一页 */
  page: number;
  /** 下一页游标，null 表示从头开始 */
  cursor: HistoryCursor | null;
  /** 当前时间（毫秒），用于 90 天窗口判断与测试注入 */
  nowMs: number;
  pageSize?: number;
  maxPages?: number;
  windowDays?: number;
}

export interface FetchHistoryChunkResult {
  /** 本页映射后的记录（未跨页去重） */
  records: HistoryRecord[];
  /** 下一页游标；null 表示已到末尾 */
  nextCursor: HistoryCursor | null;
  /** 本页之后是否采集完成 */
  done: boolean;
  /** 本次实际请求的页数（成功请求才有值） */
  pagesFetched: number;
}

/** 90 天窗口的秒级下界 */
export function historyCutoffSec(nowMs: number, windowDays = HISTORY_WINDOW_DAYS): number {
  return Math.floor(nowMs / 1000 - windowDays * (DAY / 1000));
}

/** 单条原始记录 -> HistoryRecord；不符合要求时返回 null */
export function mapHistoryItem(raw: HistoryRawItem): HistoryRecord | null {
  const history = raw?.history;
  if (!history) return null;
  if (history.business !== 'archive') return null;
  const bvid = history.bvid?.trim();
  if (!bvid) return null;

  const title = (raw.title || raw.long_title || '').trim();
  const tname = (raw.tag_name ?? '').trim();
  const viewedAt = Number.isFinite(raw.view_at) ? Math.max(0, Math.floor(raw.view_at)) : 0;
  if (viewedAt <= 0) return null;

  const duration = Number.isFinite(raw.duration) ? Math.max(0, Math.round(raw.duration)) : 0;
  const progress = Number.isFinite(raw.progress) ? Math.max(0, Math.round(raw.progress)) : 0;

  return {
    bvid,
    title,
    cover: raw.cover || undefined,
    viewedAt,
    duration,
    progress,
    tname,
    parentRegion: resolveParentRegion(tname),
    authorMid: typeof raw.author_mid === 'number' ? raw.author_mid : undefined,
    authorName: raw.author_name || undefined,
    isFav: Boolean(raw.is_fav),
  };
}

/** 批量映射，并按 90 天窗口过滤（不跨页去重） */
export function mapHistoryItems(
  raws: HistoryRawItem[],
  options: { nowMs: number; windowDays?: number } = { nowMs: Date.now() },
): HistoryRecord[] {
  const cutoff = historyCutoffSec(options.nowMs, options.windowDays ?? HISTORY_WINDOW_DAYS);
  const records: HistoryRecord[] = [];
  for (const raw of raws ?? []) {
    const record = mapHistoryItem(raw);
    if (!record) continue;
    if (record.viewedAt < cutoff) continue;
    records.push(record);
  }
  return records;
}

/**
 * 同 bvid 去重：保留 viewedAt 最新的一条，isFav 取「或」，标题/封面缺省互补。
 * 结果按 viewedAt 倒序，与 Repository.getHistory 的约定一致。
 */
export function dedupeHistory(records: HistoryRecord[]): HistoryRecord[] {
  const byBvid = new Map<string, HistoryRecord>();
  for (const record of records) {
    const prev = byBvid.get(record.bvid);
    if (!prev) {
      byBvid.set(record.bvid, { ...record });
      continue;
    }
    const newer = record.viewedAt >= prev.viewedAt ? record : prev;
    const older = newer === record ? prev : record;
    byBvid.set(record.bvid, {
      ...newer,
      isFav: Boolean(newer.isFav || older.isFav),
      cover: newer.cover || older.cover,
      title: newer.title || older.title,
      tname: newer.tname || older.tname,
      parentRegion: newer.parentRegion || older.parentRegion,
      authorMid: newer.authorMid ?? older.authorMid,
      authorName: newer.authorName || older.authorName,
    });
  }
  return [...byBvid.values()].sort((a, b) => b.viewedAt - a.viewedAt);
}

/** 按 viewedAt 拆成近 7 天与整体（整体已按 90 天窗口采集） */
export function splitHistory(
  records: HistoryRecord[],
  nowMs: number,
  days = 7,
): { last7d: HistoryRecord[]; all: HistoryRecord[] } {
  const cutoff = Math.floor(nowMs / 1000 - days * (DAY / 1000));
  const all = [...records].sort((a, b) => b.viewedAt - a.viewedAt);
  const last7d = all.filter((row) => row.viewedAt >= cutoff);
  return { last7d, all };
}

/**
 * 抓取一页历史。
 *
 * done 判定：页数用完 / 返回空列表 / 接口游标归零 / 本页全部早于 90 天窗口 /
 * 游标没有前进（防止接口异常时死循环）。
 */
export async function fetchHistoryChunk(
  input: FetchHistoryChunkInput,
): Promise<FetchHistoryChunkResult> {
  const pageSize = input.pageSize ?? HISTORY_PAGE_SIZE;
  const maxPages = input.maxPages ?? HISTORY_MAX_PAGES;
  const windowDays = input.windowDays ?? HISTORY_WINDOW_DAYS;
  const requestCursor = input.cursor
    ? { max: input.cursor.max, viewAt: input.cursor.viewAt }
    : { max: 0, viewAt: 0 };

  const data = await input.api.history({
    ps: pageSize,
    max: requestCursor.max,
    viewAt: requestCursor.viewAt,
  });

  const list = data?.list ?? [];
  const records = mapHistoryItems(list, { nowMs: input.nowMs, windowDays });
  const nextCursorRaw = data?.cursor;
  const nextCursor: HistoryCursor | null =
    nextCursorRaw && (nextCursorRaw.max > 0 || nextCursorRaw.view_at > 0)
      ? { max: nextCursorRaw.max ?? 0, viewAt: nextCursorRaw.view_at ?? 0 }
      : null;

  const pageIndex = input.page + 1;
  const exhausted = pageIndex >= maxPages;
  const empty = list.length === 0;
  const allOutOfWindow = list.length > 0 && records.length === 0;
  const cursorStalled =
    nextCursor !== null &&
    nextCursor.max === requestCursor.max &&
    nextCursor.viewAt === requestCursor.viewAt;

  const done = exhausted || empty || allOutOfWindow || nextCursor === null || cursorStalled;
  return {
    records,
    nextCursor: done ? null : nextCursor,
    done,
    pagesFetched: 1,
  };
}
