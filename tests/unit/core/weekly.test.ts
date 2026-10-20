import { describe, expect, it } from 'vitest';
import { WEEKLY_CONFIG } from '../../../src/shared/constants';
import type { HistoryRecord } from '../../../src/shared/types';
import {
  buildWeeklyReport,
  localWeekStart,
  maybeGenerateWeeklyReport,
  previousCompletedWeek,
  weekKeyOf,
  weekWindowFromStart,
} from '../../../src/core/report/weekly';
import { createMemoryRepository } from '../../../src/core/store/repository';
import { makeHistoryRecord } from './helpers';

/** 本地时间构造（避免依赖运行机器时区，断言全部基于本地日历） */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function record(
  title: string,
  viewedAtMs: number,
  options: { duration?: number; progress?: number; parentRegion?: string; tname?: string; authorMid?: number; authorName?: string } = {},
): HistoryRecord {
  return makeHistoryRecord({
    bvid: `BVw${Math.round(viewedAtMs / 60000)}${title.length}`,
    title,
    viewedAt: Math.floor(viewedAtMs / 1000),
    duration: options.duration ?? 100,
    progress: options.progress ?? 100,
    parentRegion: options.parentRegion ?? '游戏',
    tname: options.tname ?? '手机游戏',
    authorMid: options.authorMid ?? 111,
    authorName: options.authorName ?? 'UP甲',
  });
}

describe('report/weekly 周窗口', () => {
  it('localWeekStart 一律回到周一 00:00', () => {
    const monday = at(2026, 10, 19, 0);
    expect(localWeekStart(at(2026, 10, 21))).toBe(monday); // 周三
    expect(localWeekStart(at(2026, 10, 19, 4))).toBe(monday); // 周一凌晨
    expect(localWeekStart(at(2026, 10, 25, 23))).toBe(monday); // 周日深夜
  });

  it('weekKeyOf 返回周一日期', () => {
    expect(weekKeyOf(at(2026, 10, 21))).toBe('2026-10-19');
    expect(weekKeyOf(at(2026, 10, 19, 4))).toBe('2026-10-19');
  });

  it('previousCompletedWeek 是最近一个完整自然周', () => {
    const window = previousCompletedWeek(at(2026, 10, 21));
    expect(window.weekStart).toBe(at(2026, 10, 12, 0));
    expect(window.weekEnd).toBe(at(2026, 10, 19, 0));
    expect(window.weekKey).toBe('2026-10-12');
    expect(window.label).toContain('10月12日');
    expect(window.label).toContain('10月18日');

    // 周一 04:00 的每日更新：上一周已完整结束
    const mondayWindow = previousCompletedWeek(at(2026, 10, 19, 4));
    expect(mondayWindow.weekKey).toBe('2026-10-12');
  });

  it('跨年周的周键与标签正确', () => {
    const window = previousCompletedWeek(at(2026, 1, 5, 4)); // 2026-01-05 周一
    expect(window.weekKey).toBe('2025-12-29');
    expect(window.weekStart).toBe(at(2025, 12, 29, 0));
    expect(window.weekEnd).toBe(at(2026, 1, 5, 0));
    expect(window.label).toContain('2025年12月29日');
    expect(window.label).toContain('2026年1月4日');
  });

  it('weekWindowFromStart 的 weekEnd 为下周一 00:00', () => {
    const window = weekWindowFromStart(at(2026, 10, 12, 0));
    expect(window.weekEnd).toBe(at(2026, 10, 19, 0));
    expect(window.label).toBe('10月12日 - 10月18日');
  });
});

describe('report/weekly 统计与趋势', () => {
  const weekStart = at(2026, 10, 12, 0);
  const now = at(2026, 10, 21, 4);

  const current: HistoryRecord[] = [
    record('newtopic 专题', at(2026, 10, 13, 12), { parentRegion: '知识', tname: '科学科普', authorMid: 1, authorName: 'UP一' }),
    record('newtopic 专题', at(2026, 10, 13, 20), { parentRegion: '知识', tname: '科学科普', authorMid: 1, authorName: 'UP一' }),
    record('risingtopic 内容', at(2026, 10, 15, 9), { parentRegion: '知识', tname: '科学科普', authorMid: 2, authorName: 'UP二' }),
    record('risingtopic 内容', at(2026, 10, 16, 9), { parentRegion: '游戏', tname: '手机游戏', authorMid: 3, authorName: 'UP三' }),
    record('steadyterm 内容', at(2026, 10, 17, 9), { parentRegion: '游戏', tname: '单机游戏', authorMid: 3, authorName: 'UP三' }),
    record('risingtopic 内容', at(2026, 10, 18, 9), { parentRegion: '知识', tname: '科学科普', authorMid: 2, authorName: 'UP二' }),
  ];
  const previous: HistoryRecord[] = [
    record('oldtopic 专题', at(2026, 10, 6, 10), { parentRegion: '游戏', tname: '手机游戏', authorMid: 1, authorName: 'UP一' }),
    record('risingtopic 内容', at(2026, 10, 7, 10), { parentRegion: '游戏', tname: '手机游戏', authorMid: 2, authorName: 'UP二' }),
    record('steadyterm 内容', at(2026, 10, 8, 10), { parentRegion: '游戏', tname: '手机游戏', authorMid: 3, authorName: 'UP三' }),
  ];
  const history = [...current, ...previous];
  const report = buildWeeklyReport(history, weekStart, now);

  it('基础统计、环比与每日分布', () => {
    expect(report.weekKey).toBe('2026-10-12');
    expect(report.weekStart).toBe(weekStart);
    expect(report.weekEnd).toBe(at(2026, 10, 19, 0));
    expect(report.generatedAt).toBe(now);
    expect(report.stats.watched).toBe(6);
    expect(report.stats.watchSeconds).toBe(600);
    expect(report.stats.activeDays).toBe(5);
    expect(report.stats.completionRate).toBe(1);
    expect(report.previous.watched).toBe(3);
    expect(report.sample).toEqual({ currentTotal: 6, previousTotal: 3 });

    expect(report.daily).toHaveLength(7);
    expect(report.daily[0]).toMatchObject({ date: '2026-10-12', weekday: '周一', watched: 0 });
    expect(report.daily[1]).toMatchObject({ date: '2026-10-13', weekday: '周二', watched: 2, watchSeconds: 200 });
    expect(report.daily[6]).toMatchObject({ date: '2026-10-18', weekday: '周日' });
    expect(report.daily.reduce((sum, row) => sum + row.watched, 0)).toBe(6);
  });

  it('标签 Top12：归一化、涨跌状态与阈值', () => {
    expect(report.tags.length).toBeGreaterThan(0);
    expect(report.tags.length).toBeLessThanOrEqual(WEEKLY_CONFIG.tagLimit);
    for (const row of report.tags) {
      expect(row.weight).toBeGreaterThanOrEqual(0);
      expect(row.weight).toBeLessThanOrEqual(1);
      expect(row.previousWeight).toBeGreaterThanOrEqual(0);
      expect(row.previousWeight).toBeLessThanOrEqual(1);
    }
    const byTerm = new Map(report.tags.map((row) => [row.term, row]));
    expect(byTerm.get('newtopic')!.status).toBe('new');
    expect(byTerm.get('oldtopic')!.status).toBe('gone');
    expect(byTerm.get('steadyterm')!.status).toBe('steady');
    expect(byTerm.get('risingtopic')!.status).toBe('up');
    expect(byTerm.get('risingtopic')!.delta).toBeGreaterThanOrEqual(WEEKLY_CONFIG.tagDelta);
    expect(byTerm.get('oldtopic')!.delta).toBeLessThan(-WEEKLY_CONFIG.tagDelta);
    // 有词被归一化到接近 1
    expect(Math.max(...report.tags.map((row) => Math.max(row.weight, row.previousWeight)))).toBeCloseTo(1, 4);
  });

  it('分区 Top6 与阈值、UP Top6 与环比', () => {
    expect(report.regions.length).toBeGreaterThan(0);
    expect(report.regions.length).toBeLessThanOrEqual(WEEKLY_CONFIG.regionLimit);
    const regions = new Map(report.regions.map((row) => [row.name, row]));
    expect(regions.get('知识')!.status).toBe('new');
    expect(regions.get('游戏')!.status).toBe('down');
    expect(regions.get('游戏')!.delta).toBeLessThanOrEqual(-WEEKLY_CONFIG.regionDelta);

    expect(report.ups.length).toBeGreaterThan(0);
    expect(report.ups.length).toBeLessThanOrEqual(WEEKLY_CONFIG.upLimit);
    const upOne = report.ups.find((row) => row.mid === 1)!;
    expect(upOne.name).toBe('UP一');
    expect(upOne.count).toBe(2);
    expect(upOne.previousCount).toBe(1);
    expect(upOne.delta).toBe(1);
    // 按本周观看次数排序，UP一/UP二次数最多
    expect(report.ups[0]!.count).toBeGreaterThanOrEqual(report.ups.at(-1)!.count);
  });

  it('上升/下降榜各 ≤5 且方向正确', () => {
    expect(report.rising.length).toBeGreaterThan(0);
    expect(report.rising.length).toBeLessThanOrEqual(WEEKLY_CONFIG.moverLimit);
    expect(report.rising.every((row) => row.delta > 0)).toBe(true);
    const deltas = report.rising.map((row) => row.delta);
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);

    expect(report.falling.length).toBeGreaterThan(0);
    expect(report.falling.length).toBeLessThanOrEqual(WEEKLY_CONFIG.moverLimit);
    expect(report.falling.every((row) => row.delta < 0)).toBe(true);
    // 标签词表里同时包含分区词：分区下降幅度最大，老标签 oldtopic 也在下降榜里
    expect(report.falling[0]!.term).toBe('游戏');
    expect(report.falling.some((row) => row.term === 'oldtopic')).toBe(true);
  });

  it('总结文案非空且包含该周关键信息', () => {
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.summary.length).toBeLessThanOrEqual(4);
    expect(report.summary.join('')).toContain('该周观看 6 个视频');
    expect(report.summary.join('')).toContain('知识');
    expect(report.summary.some((line) => line.includes('比上周更关注'))).toBe(true);
  });
});

describe('report/weekly 空态', () => {
  it('当前周无记录时返回空态周报', () => {
    const weekStart = at(2026, 10, 12, 0);
    const previous = [
      record('old 内容', at(2026, 10, 6, 10), { parentRegion: '游戏' }),
      record('old2 内容', at(2026, 10, 7, 10), { parentRegion: '游戏' }),
    ];
    const report = buildWeeklyReport(previous, weekStart, at(2026, 10, 21, 4));
    expect(report.stats.watched).toBe(0);
    expect(report.stats.watchSeconds).toBe(0);
    expect(report.stats.activeDays).toBe(0);
    expect(report.stats.completionRate).toBe(0);
    expect(report.previous.watched).toBe(2);
    expect(report.tags).toEqual([]);
    expect(report.regions).toEqual([]);
    expect(report.ups).toEqual([]);
    expect(report.rising).toEqual([]);
    expect(report.falling).toEqual([]);
    expect(report.daily).toHaveLength(7);
    expect(report.daily.every((row) => row.watched === 0)).toBe(true);
    expect(report.sample).toEqual({ currentTotal: 0, previousTotal: 2 });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0]).toContain('没有观看记录');
  });

  it('完全无历史也能生成空态周报', () => {
    const report = buildWeeklyReport([], at(2026, 10, 12, 0), at(2026, 10, 21, 4));
    expect(report.stats.watched).toBe(0);
    expect(report.summary[0]).toContain('没有观看记录');
  });
});

describe('report/weekly 生成与幂等', () => {
  it('生成上一个完整自然周，重复调用跳过', async () => {
    const repo = createMemoryRepository();
    const now = at(2026, 10, 21, 4);
    const history = [
      record('新主题 内容', at(2026, 10, 14, 10), { parentRegion: '知识' }),
      record('另一个主题 内容', at(2026, 10, 15, 10), { parentRegion: '游戏' }),
    ];
    const first = await maybeGenerateWeeklyReport({ repo, history, nowMs: now });
    expect(first.skipped).toBeNull();
    expect(first.report).not.toBeNull();
    expect(first.report!.weekKey).toBe('2026-10-12');
    expect(await repo.getWeeklyReport('2026-10-12')).toBeTruthy();
    expect(await repo.listWeeklyReports()).toHaveLength(1);

    const second = await maybeGenerateWeeklyReport({ repo, history, nowMs: now });
    expect(second.skipped).toBe('exists');
    expect(second.report).toBeNull();
    expect(await repo.listWeeklyReports()).toHaveLength(1);
  });

  it('没有历史时跳过生成', async () => {
    const repo = createMemoryRepository();
    const outcome = await maybeGenerateWeeklyReport({
      repo,
      history: [],
      nowMs: at(2026, 10, 21, 4),
    });
    expect(outcome.skipped).toBe('no-history');
    expect(await repo.listWeeklyReports()).toEqual([]);
  });

  it('生成后只保留最近 12 份周报', async () => {
    const repo = createMemoryRepository();
    const now = at(2026, 10, 21, 4);
    // 预置 12 份更早的周报（截止 2026-10-05，避免与目标周 10-12 冲突）
    for (let index = 0; index < 12; index += 1) {
      const weekStart = at(2026, 7, 20, 0) + index * 7 * 86_400_000;
      await repo.saveWeeklyReport(
        buildWeeklyReport([record('旧内容', weekStart + 3_600_000)], weekStart, now),
      );
    }
    const history = [record('新内容', at(2026, 10, 15, 10))];
    const outcome = await maybeGenerateWeeklyReport({ repo, history, nowMs: now });
    expect(outcome.report).not.toBeNull();
    const metas = await repo.listWeeklyReports();
    expect(metas).toHaveLength(WEEKLY_CONFIG.keepReports);
    expect(metas[0]!.weekKey).toBe('2026-10-12');
  });
});

describe('report/weekly 记录时间窗口', () => {
  it('只统计当前周（周一 00:00 至下周一 00:00）', () => {
    const weekStart = at(2026, 10, 12, 0);
    const inWindowStart = record('边界 内容', weekStart, { parentRegion: '游戏' });
    const beforeWindow = record('窗口前 内容', weekStart - 1, { parentRegion: '游戏' });
    const lastMoment = record('窗口尾 内容', at(2026, 10, 19, 0) - 1, { parentRegion: '游戏' });
    const nextWeek = record('下周 内容', at(2026, 10, 19, 0), { parentRegion: '游戏' });
    const report = buildWeeklyReport(
      [inWindowStart, beforeWindow, lastMoment, nextWeek],
      weekStart,
      at(2026, 10, 21, 4),
    );
    expect(report.stats.watched).toBe(2);
    expect(report.sample.currentTotal).toBe(2);
    expect(report.sample.previousTotal).toBe(1); // 「窗口前」落入上一周
  });
});
