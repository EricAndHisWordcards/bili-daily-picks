import { describe, expect, it } from 'vitest';
import { BILI_PATHS } from '../../../src/core/api/endpoints';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { collectSectionBvids } from '../../../src/core/recommend/sections';
import { buildWeeklyReport } from '../../../src/core/report/weekly';
import type { BackupData, DailyResult } from '../../../src/shared/types';
import {
  FIXTURE_NOW,
  createPipelineHarness,
  loadSampleHistory,
  makeCandidate,
  makeHistoryPages,
  makeHistoryRecord,
  makePipelineState,
} from './helpers';

const historyPages = () => makeHistoryPages(loadSampleHistory());

/** 断言分区板块满足 2–5 条、同分区、同 UP 唯一 */
function expectRegionSectionsValid(daily: DailyResult): void {
  const regionSections = daily.sections.filter((section) => section.kind === 'region');
  for (const section of regionSections) {
    const region = section.id.replace('region:', '');
    expect(section.items.length).toBeGreaterThanOrEqual(2);
    expect(section.items.length).toBeLessThanOrEqual(5);
    expect(section.items.every((item) => item.parentRegion === region)).toBe(true);
    const mids = section.items.map((item) => item.owner.mid);
    expect(new Set(mids).size).toBe(mids.length);
  }
}

describe('pipeline 公开模式', () => {
  it('未登录时自动公开模式：只用公开来源、无画像、可出结果', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    const status = await harness.controller.runNow();
    expect(status.running).toBe(false);
    expect(status.stage).not.toBe('error');
    expect(status.loggedOut).toBe(true);

    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.mode).toBe('public');
    expect(daily!.mid).toBeUndefined();
    expect(daily!.sections.length).toBeGreaterThan(0);
    expect(daily!.meta.candidates).toBeGreaterThan(0);
    expect(daily!.meta.requests).toBeGreaterThan(0);
    expect(daily!.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(daily!.meta.sources.length).toBeGreaterThan(0);
    expect(daily!.meta.sources).not.toContain('rcmd');
    expect(daily!.meta.sources).not.toContain('related');
    expect(daily!.profileSummary.topRegions).toEqual([]);
    expect(daily!.profileSummary.topTags).toEqual([]);

    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.daily).not.toBeNull();
    expect(dashboard.profile).toBeNull();
    expect(dashboard.status.stage).toBe('idle');
    expect(dashboard.settings.autoUpdate).toBe(true);
    expect(dashboard.dismissed).toEqual([]);

    // 未登录不应该有历史画像
    expect(await harness.repo.getProfile()).toBeNull();
  });
});

describe('pipeline 完整模式', () => {
  it('已登录：采集历史、生成画像与分区板块', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
    });
    const status = await harness.controller.runNow();
    expect(status.stage).not.toBe('error');

    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.mode).toBe('full');
    expect(daily!.mid).toBe(12345);
    expect(daily!.sections.length).toBeGreaterThan(0);

    // 今日必看 ≤6，且同分区 ≤2
    const today = daily!.sections.find((section) => section.kind === 'global')!;
    expect(today.items.length).toBeLessThanOrEqual(6);
    const regionCount = new Map<string, number>();
    for (const item of today.items) {
      regionCount.set(item.parentRegion, (regionCount.get(item.parentRegion) ?? 0) + 1);
    }
    expect([...regionCount.values()].every((count) => count <= 2)).toBe(true);
    expectRegionSectionsValid(daily!);

    // 推荐理由与角标均非空
    const allItems = daily!.sections.flatMap((section) => section.items);
    expect(allItems.every((item) => item.reason.length > 0)).toBe(true);
    expect(allItems.every((item) => item.badges.length > 0)).toBe(true);
    expect(allItems.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);

    // 历史与画像落盘
    const history = await harness.repo.getHistory();
    expect(history.length).toBeGreaterThan(0);
    const profile = await harness.repo.getProfile();
    expect(profile).not.toBeNull();
    expect(profile!.sample.total).toBeGreaterThan(0);
    expect(profile!.regions.length).toBeGreaterThan(0);
    expect(profile!.mid).toBe(12345);

    // 请求预算内
    expect(daily!.meta.requests).toBeLessThanOrEqual(140);
    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.profile).not.toBeNull();
    expect(dashboard.status.loggedOut).toBe(false);
  });

  it('同一天重复运行（非强制）结果稳定', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    const first = await harness.controller.getDaily();
    await harness.controller.runNow();
    const second = await harness.controller.getDaily();
    expect(second).not.toBeNull();
    expect(second!.sections).toEqual(first!.sections);
  });

  it('换一批：排除当天已展示的视频', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    const first = await harness.controller.getDaily();
    const firstBvids = new Set(collectSectionBvids(first!.sections));
    expect(firstBvids.size).toBeGreaterThan(0);

    await harness.controller.runNow({ force: true });
    const second = await harness.controller.getDaily();
    expect(second).not.toBeNull();
    const secondBvids = collectSectionBvids(second!.sections);
    expect(secondBvids.length).toBeGreaterThan(0);
    expect(secondBvids.filter((bvid) => firstBvids.has(bvid))).toEqual([]);
  });
});

describe('pipeline 容错与续跑', () => {
  it('上一轮 error 后下一次 tick 能重新推进（不会卡死）', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    await harness.repo.savePipeline(
      makePipelineState({
        stage: 'error',
        mode: 'public',
        error: '上一轮失败：网络异常',
        updatedAt: 0,
        dueAt: 0,
      }),
    );
    const status = await harness.controller.tick();
    expect(status.stage).not.toBe('error');
    expect(await harness.controller.getDaily()).not.toBeNull();
    expect(await harness.repo.getPipeline()).toBeUndefined();
  });

  it('从 enrich 阶段续跑（Service Worker 被回收后恢复）', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    const candidates = Array.from({ length: 12 }, (_, index) =>
      makeCandidate({
        bvid: `BVresume${index}`,
        tid: 172,
        tname: '手机游戏',
        parentRegion: '游戏',
        pubdate: Math.floor(FIXTURE_NOW / 1000) - 3600 * (index + 1),
        tags: ['已有标签'],
        owner: { mid: 2000 + index, name: `UP${index}` },
      }),
    );
    await harness.repo.savePipeline(
      makePipelineState({
        stage: 'enrich',
        mode: 'public',
        candidates,
        enrichIndex: 0,
        startedAt: FIXTURE_NOW - 5000,
        updatedAt: 0,
      }),
    );
    const status = await harness.controller.tick();
    expect(status.stage).not.toBe('error');
    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.meta.candidates).toBeGreaterThan(0);
    expect(await harness.repo.getPipeline()).toBeUndefined();
    // 续跑不应重复抓候选源
    expect(harness.calls).not.toContain(BILI_PATHS.popular);
  });

  it('来源触发风控时降级并继续出结果', async () => {
    // 热门与每周必看列表失败，排行榜/分区榜成功：仍应出结果并带降级说明
    const harness = createPipelineHarness({
      loggedIn: false,
      fail: [BILI_PATHS.popular, BILI_PATHS.weeklyList],
    });
    await harness.controller.runNow();
    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.meta.degraded).toBeTruthy();
    expect(daily!.meta.degraded).toContain('风控');
    expect(daily!.meta.sources.length).toBeGreaterThan(0);
    expect(daily!.sections.length).toBeGreaterThan(0);
  });

  it('候选为空且无历史结果时仍返回空板块而不报错', async () => {
    const harness = createPipelineHarness({
      loggedIn: false,
      fail: [
        BILI_PATHS.popular,
        BILI_PATHS.ranking,
        BILI_PATHS.weeklyList,
        BILI_PATHS.weeklyOne,
      ],
    });
    await harness.controller.runNow();
    const status = await harness.controller.getStatus();
    expect(status.stage).not.toBe('error');
    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.sections).toEqual([]);
    expect(daily!.meta.degraded).toContain('风控');
  });
});

describe('pipeline 日程与设置', () => {
  it('autoUpdate 关闭时 tick 不自动运行，runNow 仍可手动触发', async () => {
    const harness = createPipelineHarness({
      loggedIn: false,
      settings: { autoUpdate: false },
    });
    const status = await harness.controller.tick();
    expect(status.running).toBe(false);
    expect(status.stage).toBe('idle');
    expect(harness.calls).toHaveLength(0);

    await harness.controller.runNow();
    expect(await harness.controller.getDaily()).not.toBeNull();
    const settings = await harness.controller.getStatus();
    expect(settings.nextDueAt).toBeUndefined();
  });

  it('当天已生成过结果时 tick 不重复抓取', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    await harness.controller.runNow();
    const callsAfterRun = harness.calls.length;
    const status = await harness.controller.tick();
    expect(status.running).toBe(false);
    expect(harness.calls.length).toBe(callsAfterRun);
    const after = await harness.controller.getStatus();
    expect(after.nextDueAt).toEqual(expect.any(Number));
  });

  it('不感兴趣：加入拉黑后不再出现在推荐里', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    const first = await harness.controller.getDaily();
    const someBvid = first!.sections[0]!.items[0]!.bvid;
    await harness.controller.dismiss(someBvid);
    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.dismissed).toContain(someBvid);

    await harness.controller.runNow({ force: true });
    const second = await harness.controller.getDaily();
    expect(collectSectionBvids(second!.sections)).not.toContain(someBvid);
  });

  it('清空数据会删除每日结果/画像/拉黑并重置设置', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    await harness.controller.dismiss('BVdismissTest');
    await harness.settings.set({ theme: 'dark' });

    await harness.controller.clearData();
    expect(await harness.controller.getDaily()).toBeNull();
    expect(await harness.repo.getProfile()).toBeNull();
    expect(await harness.repo.getHistory()).toEqual([]);
    expect(await harness.repo.getDismissed()).toEqual([]);
    expect(await harness.settings.get()).toEqual({ ...DEFAULT_SETTINGS, autoUpdate: false });

    // 清空后暂停自动更新：下一次 tick 不应重新采集历史或生成推荐
    const requestsBefore = harness.http.requests;
    const status = await harness.controller.tick();
    expect(status.running).toBe(false);
    expect(await harness.controller.getDaily()).toBeNull();
    expect(harness.http.requests).toBe(requestsBefore);

    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.daily).toBeNull();
    expect(dashboard.profile).toBeNull();
    expect(dashboard.dismissed).toEqual([]);
  });

  it('getStatus 返回合法进度与请求计数', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    const idle = await harness.controller.getStatus();
    expect(idle.running).toBe(false);
    expect(idle.stage).toBe('idle');
    expect(idle.progress).toBe(0);

    await harness.controller.tick();
    const after = await harness.controller.getStatus();
    expect(after.running).toBe(false);
    expect(['idle', 'error']).toContain(after.stage);
    expect(after.lastRunAt).toEqual(expect.any(Number));
  });
});

/* ------------------------------------------------------------------ */
/* v0.2.0：账号 / 只读信号 / 周报 / 备份                                */
/* ------------------------------------------------------------------ */

function localTime(year: number, month: number, day: number, hour = 4): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

const MONDAY_NOW = localTime(2026, 10, 19, 4); // 2026-10-19 周一 04:00

describe('pipeline v0.2.0 账号', () => {
  it('getAccount 返回登录态，60 秒内复用 nav 缓存，force 绕过缓存', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    const account = await harness.controller.getAccount();
    expect(account.loggedIn).toBe(true);
    expect(account.mid).toBe(12345);
    expect(account.uname).toBe('测试用户');
    expect(account.checkedAt).toBe(FIXTURE_NOW);
    expect(account.error).toBeUndefined();

    const navCalls = harness.fetcher.countOf(BILI_PATHS.nav);
    await harness.controller.getAccount();
    expect(harness.fetcher.countOf(BILI_PATHS.nav)).toBe(navCalls);

    await harness.controller.getAccount(true);
    expect(harness.fetcher.countOf(BILI_PATHS.nav)).toBe(navCalls + 1);
  });

  it('未登录时返回 loggedIn:false 且不报错', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    const account = await harness.controller.getAccount();
    expect(account.loggedIn).toBe(false);
    expect(account.error).toBeUndefined();
    expect(account.checkedAt).toBe(FIXTURE_NOW);
  });

  it('nav 失败时返回 loggedIn:false + error + 最近成功登录信息（不抛错）', async () => {
    const harness = createPipelineHarness({ loggedIn: true, fail: [BILI_PATHS.nav] });
    await harness.repo.setKv('account:last', {
      mid: 12345,
      uname: '测试用户',
      at: FIXTURE_NOW - 60_000,
    });
    const account = await harness.controller.getAccount(true);
    expect(account.loggedIn).toBe(false);
    expect(account.error).toBeTruthy();
    expect(account.last?.mid).toBe(12345);
    expect(account.last?.uname).toBe('测试用户');

    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.account.loggedIn).toBe(false);
    expect(dashboard.account.last?.mid).toBe(12345);
  });

  it('auth 阶段成功登录会落 account:last，getDashboardData 返回 account', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    const last = await harness.repo.getKv<{ mid?: number; uname?: string }>('account:last');
    expect(last?.mid).toBe(12345);
    expect(last?.uname).toBe('测试用户');

    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.account.loggedIn).toBe(true);
    expect(dashboard.account.mid).toBe(12345);
  });
});

describe('pipeline v0.2.0 只读信号', () => {
  it('已登录：signals 阶段采集收藏/关注/稍后再看并并入画像', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    expect(harness.fetcher.countOf(BILI_PATHS.favFolders)).toBe(1);
    expect(harness.fetcher.countOf(BILI_PATHS.favResources)).toBe(3);
    expect(harness.fetcher.countOf(BILI_PATHS.followings)).toBe(2);
    expect(harness.fetcher.countOf(BILI_PATHS.watchLater)).toBe(1);

    const profile = await harness.repo.getProfile();
    expect(profile).not.toBeNull();
    expect(profile!.signals).toBeDefined();
    expect(profile!.signals!.favoriteSampled).toBeGreaterThan(0);
    expect(profile!.signals!.followedMids.length).toBeGreaterThan(0);
    expect(profile!.signals!.watchLaterSampled).toBeGreaterThan(0);
    expect(await harness.repo.getKv('signals:last')).toBeTruthy();

    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.mode).toBe('full');
    expect(daily!.meta.degraded).toBeUndefined();
  });

  it('公开模式跳过 signals 阶段，不发收藏/关注/稍后再看请求', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    await harness.controller.runNow();
    expect(harness.fetcher.countOf(BILI_PATHS.favFolders)).toBe(0);
    expect(harness.fetcher.countOf(BILI_PATHS.favResources)).toBe(0);
    expect(harness.fetcher.countOf(BILI_PATHS.followings)).toBe(0);
    expect(harness.fetcher.countOf(BILI_PATHS.watchLater)).toBe(0);
    expect(await harness.repo.getProfile()).toBeNull();
  });

  it('signals 接口风控时降级不阻塞，画像与推荐仍生成', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
      fail: [BILI_PATHS.favFolders, BILI_PATHS.followings, BILI_PATHS.watchLater],
    });
    await harness.controller.runNow();
    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.meta.degraded).toContain('收藏');
    expect(await harness.repo.getProfile()).not.toBeNull();
  });

  it('signals 返回 -101 时静默并切公开模式（本次不写 degraded）', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
      failCode: { [BILI_PATHS.favFolders]: -101 },
    });
    await harness.controller.runNow();
    const daily = await harness.controller.getDaily();
    expect(daily).not.toBeNull();
    expect(daily!.mode).toBe('public');
    expect(daily!.meta.degraded).toBeUndefined();
  });

  it('第二次运行命中信号 12 小时缓存，不再请求收藏/关注', async () => {
    const harness = createPipelineHarness({ loggedIn: true, historyPages: historyPages() });
    await harness.controller.runNow();
    const counts = {
      folders: harness.fetcher.countOf(BILI_PATHS.favFolders),
      followings: harness.fetcher.countOf(BILI_PATHS.followings),
    };
    await harness.controller.runNow();
    expect(harness.fetcher.countOf(BILI_PATHS.favFolders)).toBe(counts.folders);
    expect(harness.fetcher.countOf(BILI_PATHS.followings)).toBe(counts.followings);
  });
});

describe('pipeline v0.2.0 周报', () => {
  it('周一 04:00 的更新产出上周周报，重复更新幂等', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
      now: MONDAY_NOW,
    });
    await harness.controller.runNow();
    const weekly = await harness.controller.getWeeklyReport();
    expect(weekly.report).not.toBeNull();
    expect(weekly.report!.weekKey).toBe('2026-10-12');
    expect(weekly.report!.stats.watched).toBeGreaterThan(0);
    expect(weekly.reports.length).toBe(1);
    expect(weekly.reports[0]!.weekKey).toBe('2026-10-12');

    await harness.controller.runNow();
    const again = await harness.controller.getWeeklyReport();
    expect(again.reports.length).toBe(1);
    expect(again.report!.weekKey).toBe('2026-10-12');
  });

  it('getWeeklyReport 支持指定 weekKey，并返回最近元数据列表', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
      now: MONDAY_NOW,
    });
    await harness.controller.runNow();
    // 手动补一份更早的周报
    const older = buildWeeklyReport(
      loadSampleHistory(),
      localTime(2026, 10, 5, 0),
      MONDAY_NOW,
    );
    await harness.repo.saveWeeklyReport(older);

    const latest = await harness.controller.getWeeklyReport();
    expect(latest.report!.weekKey).toBe('2026-10-12');
    expect(latest.reports.map((row) => row.weekKey)).toEqual(['2026-10-12', '2026-10-05']);

    const olderInfo = await harness.controller.getWeeklyReport('2026-10-05');
    expect(olderInfo.report!.weekKey).toBe('2026-10-05');
    const missing = await harness.controller.getWeeklyReport('2000-01-03');
    expect(missing.report).toBeNull();
    expect(missing.reports).toHaveLength(2);
  });

  it('公开模式（无历史）不生成周报', async () => {
    const harness = createPipelineHarness({ loggedIn: false, now: MONDAY_NOW });
    await harness.controller.runNow();
    const weekly = await harness.controller.getWeeklyReport();
    expect(weekly.report).toBeNull();
    expect(weekly.reports).toEqual([]);
  });
});

describe('pipeline v0.2.0 备份', () => {
  it('exportData/importData 往返恢复数据与设置，且导入不触发运行', async () => {
    const harness = createPipelineHarness({
      loggedIn: true,
      historyPages: historyPages(),
      settings: { theme: 'dark', perSection: 4 },
    });
    await harness.controller.runNow();
    const exported = await harness.controller.exportData();
    expect(exported.settings.theme).toBe('dark');
    expect(exported.history.length).toBeGreaterThan(0);
    expect(exported.snapshots.length).toBeGreaterThan(0);
    expect(exported.daily.length).toBeGreaterThan(0);
    expect(exported.profile).not.toBeNull();
    expect(exported.weeklyReports!.length).toBeGreaterThan(0);

    await harness.controller.clearData();
    expect(await harness.controller.getDaily()).toBeNull();

    const callsBefore = harness.calls.length;
    const summary = await harness.controller.importData(exported);
    // 导入不触发流水线运行
    expect(harness.calls.length).toBe(callsBefore);
    expect(summary).toEqual({
      history: exported.history.length,
      snapshots: exported.snapshots.length,
      daily: exported.daily.length,
      dismissed: exported.dismissed.length,
      weekly: exported.weeklyReports!.length,
      hasProfile: true,
      dropped: 0,
    });

    expect((await harness.repo.getHistory()).length).toBe(exported.history.length);
    expect(await harness.controller.getDaily()).not.toBeNull();
    const dashboard = await harness.controller.getDashboardData();
    expect(dashboard.settings.theme).toBe('dark');
    expect(dashboard.settings.perSection).toBe(4);
    const weekly = await harness.controller.getWeeklyReport();
    expect(weekly.reports.length).toBe(exported.weeklyReports!.length);
  });

  it('导入空备份会清空业务数据与未完成的流水线状态', async () => {
    const harness = createPipelineHarness({ loggedIn: false });
    await harness.repo.savePipeline(makePipelineState({ stage: 'history', mode: 'public' }));
    await harness.repo.replaceHistory([makeHistoryRecord({ bvid: 'BVtoClear' })]);
    const empty: BackupData = {
      settings: { ...DEFAULT_SETTINGS },
      history: [],
      snapshots: [],
      daily: [],
      profile: null,
      dismissed: [],
      weeklyReports: [],
    };
    const summary = await harness.controller.importData(empty);
    expect(summary).toEqual({
      history: 0,
      snapshots: 0,
      daily: 0,
      dismissed: 0,
      weekly: 0,
      hasProfile: false,
      dropped: 0,
    });
    expect(await harness.repo.getPipeline()).toBeUndefined();
    expect(await harness.repo.getHistory()).toEqual([]);
    expect((await harness.settings.get()).autoUpdate).toBe(true);
  });
});
