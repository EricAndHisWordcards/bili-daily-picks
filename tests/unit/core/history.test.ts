import { describe, expect, it } from 'vitest';
import { HISTORY_MAX_PAGES, HISTORY_WINDOW_DAYS } from '../../../src/shared/constants';
import { DAY } from '../../../src/shared/time';
import type { HistoryData, HistoryRawItem } from '../../../src/core/api/endpoints';
import type { HistoryRecord } from '../../../src/shared/types';
import {
  dedupeHistory,
  fetchHistoryChunk,
  historyCutoffSec,
  mapHistoryItem,
  mapHistoryItems,
  splitHistory,
  type HistoryCursor,
} from '../../../src/core/sources/history';
import {
  FIXTURE_NOW,
  loadSampleHistory,
  makeHistoryPages,
  makeHistoryRecord,
} from './helpers';

const NOW_SEC = Math.floor(FIXTURE_NOW / 1000);

function rawArchive(overrides: Partial<HistoryRawItem> = {}): HistoryRawItem {
  return {
    title: '一个视频标题',
    cover: 'https://example.com/cover.jpg',
    view_at: NOW_SEC - 3600,
    progress: 200,
    duration: 300,
    author_name: '某UP',
    author_mid: 123,
    tag_name: '手机游戏',
    is_fav: 0,
    history: { oid: 1, bvid: 'BV1test0001', business: 'archive' },
    ...overrides,
  };
}

describe('sources/history 映射', () => {
  it('映射 archive 记录并解析一级分区', () => {
    const record = mapHistoryItem(rawArchive());
    expect(record).not.toBeNull();
    expect(record!.bvid).toBe('BV1test0001');
    expect(record!.tname).toBe('手机游戏');
    expect(record!.parentRegion).toBe('游戏');
    expect(record!.viewedAt).toBe(NOW_SEC - 3600);
    expect(record!.duration).toBe(300);
    expect(record!.progress).toBe(200);
    expect(record!.authorMid).toBe(123);
    expect(record!.isFav).toBe(false);
  });

  it('未知分区名归入「其他」', () => {
    const record = mapHistoryItem(rawArchive({ tag_name: '国产动画' }));
    expect(record!.parentRegion).toBe('其他');
  });

  it('跳过非 archive 业务与缺少 bvid 的记录', () => {
    expect(mapHistoryItem(rawArchive({ history: { oid: 2, business: 'live' } }))).toBeNull();
    expect(mapHistoryItem(rawArchive({ history: { oid: 3, bvid: '', business: 'archive' } }))).toBeNull();
    expect(mapHistoryItem(rawArchive({ view_at: 0 }))).toBeNull();
  });

  it('按 90 天窗口过滤', () => {
    const fresh = mapHistoryItems([rawArchive()], { nowMs: FIXTURE_NOW });
    expect(fresh).toHaveLength(1);
    const tooOld = rawArchive({
      view_at: NOW_SEC - (HISTORY_WINDOW_DAYS + 1) * (DAY / 1000),
    });
    expect(mapHistoryItems([tooOld], { nowMs: FIXTURE_NOW })).toHaveLength(0);
  });

  it('historyCutoffSec 正确', () => {
    expect(historyCutoffSec(FIXTURE_NOW)).toBe(
      Math.floor(NOW_SEC - HISTORY_WINDOW_DAYS * (DAY / 1000)),
    );
  });
});

describe('sources/history 去重与拆分', () => {
  it('同 bvid 保留最近一次观看，isFav 取或，并按时间倒序', () => {
    const older = makeHistoryRecord({ bvid: 'BV1dup', viewedAt: NOW_SEC - 7200, isFav: false });
    const newer = makeHistoryRecord({ bvid: 'BV1dup', viewedAt: NOW_SEC - 600, isFav: true });
    const other = makeHistoryRecord({ bvid: 'BV1other', viewedAt: NOW_SEC - 1200 });
    const deduped = dedupeHistory([older, newer, other]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.bvid).toBe('BV1dup');
    expect(deduped[0]!.viewedAt).toBe(NOW_SEC - 600);
    expect(deduped[0]!.isFav).toBe(true);
    expect(deduped[1]!.bvid).toBe('BV1other');
  });

  it('用 fixture 历史拆分近 7 天与整体', () => {
    const history = dedupeHistory(loadSampleHistory());
    const { all, last7d } = splitHistory(history, FIXTURE_NOW);
    expect(all.length).toBeGreaterThan(0);
    expect(last7d.length).toBeLessThanOrEqual(all.length);
    const cutoff = NOW_SEC - 7 * (DAY / 1000);
    expect(last7d.every((row) => row.viewedAt >= cutoff)).toBe(true);
    expect(all[0]!.viewedAt).toBeGreaterThanOrEqual(all[all.length - 1]!.viewedAt);
  });
});

describe('sources/history 分页采集', () => {
  it('逐页抓取并返回 done / nextCursor', async () => {
    const records = loadSampleHistory();
    const pages = makeHistoryPages(records, 20);
    const historyApi = {
      history: async (params: { ps?: number; max?: number; viewAt?: number } = {}): Promise<HistoryData> => {
        const max = params.max ?? 0;
        const viewAt = params.viewAt ?? 0;
        if (max === 0 && viewAt === 0) return pages[0]!;
        const index = pages.findIndex(
          (page) => page.cursor.max === max && page.cursor.view_at === viewAt,
        );
        return pages[index + 1] ?? pages[pages.length - 1]!;
      },
    };

    const collected: HistoryRecord[] = [];
    let page = 0;
    let cursor: HistoryCursor | null = null;
    let done = false;
    while (!done && page < 10) {
      const chunk = await fetchHistoryChunk({
        api: historyApi,
        page,
        cursor,
        nowMs: FIXTURE_NOW,
        pageSize: 20,
      });
      collected.push(...chunk.records);
      cursor = chunk.nextCursor;
      done = chunk.done;
      page += 1;
    }
    expect(page).toBe(pages.length);
    expect(done).toBe(true);
    // fixture 中有重复 bvid，去重后应少于等于记录数
    const deduped = dedupeHistory(collected);
    expect(deduped.length).toBeGreaterThan(0);
    expect(deduped.length).toBeLessThan(collected.length);
  });

  it('页数上限会终止采集', async () => {
    const records = loadSampleHistory();
    const pages = makeHistoryPages(records, 10);
    const historyApi = {
      history: async (params: { max?: number; viewAt?: number } = {}): Promise<HistoryData> => {
        const max = params.max ?? 0;
        const viewAt = params.viewAt ?? 0;
        if (max === 0 && viewAt === 0) return pages[0]!;
        const index = pages.findIndex(
          (page) => page.cursor.max === max && page.cursor.view_at === viewAt,
        );
        return pages[index + 1] ?? pages[pages.length - 1]!;
      },
    };
    const chunk = await fetchHistoryChunk({
      api: historyApi,
      page: HISTORY_MAX_PAGES - 1,
      cursor: { max: 1, viewAt: NOW_SEC },
      nowMs: FIXTURE_NOW,
    });
    expect(chunk.done).toBe(true);
    expect(chunk.nextCursor).toBeNull();
  });

  it('空列表立即结束', async () => {
    const chunk = await fetchHistoryChunk({
      api: { history: async () => ({ cursor: { max: 0, view_at: 0, business: '', ps: 20 }, list: [] }) },
      page: 0,
      cursor: null,
      nowMs: FIXTURE_NOW,
    });
    expect(chunk.done).toBe(true);
    expect(chunk.records).toHaveLength(0);
    expect(chunk.nextCursor).toBeNull();
  });

  it('本页全部超出 90 天窗口时结束', async () => {
    const oldItem = rawArchive({
      view_at: NOW_SEC - (HISTORY_WINDOW_DAYS + 5) * (DAY / 1000),
    });
    const chunk = await fetchHistoryChunk({
      api: {
        history: async () => ({
          cursor: { max: 99, view_at: NOW_SEC, business: 'archive', ps: 20 },
          list: [oldItem],
        }),
      },
      page: 0,
      cursor: null,
      nowMs: FIXTURE_NOW,
    });
    expect(chunk.records).toHaveLength(0);
    expect(chunk.done).toBe(true);
  });
});
