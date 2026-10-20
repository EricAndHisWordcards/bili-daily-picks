import { beforeAll, describe, expect, it } from 'vitest';
import { BiliApi, type PopularData, type RankingData, type RawVideo } from '../../src/core/api/endpoints';
import { BiliApiError, HttpClient } from '../../src/core/api/http';

/**
 * 匿名契约检查：只请求公开接口（历史记录接口除外，用于确认未登录返回 -101）。
 * 需要网络；CI 或离线时设置 SKIP_LIVE=1 跳过。
 */

const live = process.env.SKIP_LIVE !== '1';

const http = new HttpClient({
  retries: 1,
  minGapMs: 320,
  timeoutMs: 20000,
  // Node 下没有浏览器 UA，B站风控会返回 -352；带上正常 UA/Referer 以便契约检查
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  },
});
const api = new BiliApi(http);

let popular: PopularData;
let ranking: RankingData;
let sample: RawVideo;

beforeAll(async () => {
  popular = await api.popular(1, 20);
  ranking = await api.ranking(0);
  sample = popular.list[0] ?? ranking.list[0];
}, 90_000);

describe.skipIf(!live)('B站公开接口契约（匿名）', () => {
  it('nav 返回 WBI 密钥', async () => {
    const nav = await api.nav(true);
    expect(nav.hasWbi).toBe(true);
    console.log(`nav: loggedIn=${nav.loggedIn} hasWbi=${nav.hasWbi}`);
  });

  it('热门返回 >= 10 条且字段齐全', () => {
    expect(popular.list.length).toBeGreaterThanOrEqual(10);
    for (const video of popular.list.slice(0, 3)) {
      expect(video.bvid).toMatch(/^BV/);
      expect(video.title.length).toBeGreaterThan(0);
      expect(video.owner.mid).toBeGreaterThan(0);
      expect(video.stat.view).toBeGreaterThan(0);
    }
    console.log(`popular: ${popular.list.length} 条，首条「${popular.list[0]?.title}」`);
  });

  it('全站排行榜返回 >= 50 条', () => {
    expect(ranking.list.length).toBeGreaterThanOrEqual(50);
    console.log(`ranking: ${ranking.list.length} 条`);
  });

  it('分区排行榜（游戏 rid=4）可用', async () => {
    const game = await api.ranking(4);
    expect(game.list.length).toBeGreaterThan(10);
  });

  it('每周必看列表与详情（详情需要 WBI 签名）', async ({ skip }) => {
    const list = await api.weeklyList();
    expect(list.list.length).toBeGreaterThan(0);
    const latest = list.list[0]!;

    // B站风控在短时间内多次请求时会返回 -352；隔几秒重试一次，仍被风控则跳过而不是判失败
    async function fetchIssue() {
      try {
        return await api.weeklyOne(latest!.number);
      } catch (error) {
        if (error instanceof BiliApiError && (error.code === -352 || error.code === -412)) {
          await new Promise((resolve) => setTimeout(resolve, 8000));
          return api.weeklyOne(latest!.number);
        }
        throw error;
      }
    }

    let issue;
    try {
      issue = await fetchIssue();
    } catch (error) {
      if (error instanceof BiliApiError && (error.code === -352 || error.code === -412)) {
        console.warn(`weekly 接口被风控（${error.code}），跳过本次契约断言；WBI 签名在 live 验收中已验证通过`);
        skip(`B站风控返回 ${error.code}，重试后仍被拦截`);
        return;
      }
      throw error;
    }
    expect(issue.list.length).toBeGreaterThan(10);
    console.log(`weekly: 第 ${latest.number} 期「${latest.subject}」${issue.list.length} 条`);
  });

  it('个性化推荐可用', async () => {
    const rcmd = await api.rcmd(1, 6);
    expect(rcmd.item.length).toBeGreaterThan(0);
    expect(rcmd.item.some((item) => item.goto === 'av' && item.bvid)).toBe(true);
  });

  it('相关推荐 / 视频详情 / 标签可用', async () => {
    const related = await api.related(sample.bvid);
    expect(related.length).toBeGreaterThan(0);
    const view = await api.view(sample.bvid);
    expect(view.stat.view).toBeGreaterThan(0);
    expect(view.tid).toBeGreaterThan(0);
    const tags = await api.tags(sample.bvid);
    expect(Array.isArray(tags)).toBe(true);
    console.log(`related=${related.length} tags=${tags.length}`);
  });

  it('匿名请求历史记录返回 -101', async () => {
    await expect(api.history({ ps: 5 })).rejects.toBeInstanceOf(BiliApiError);
    await expect(api.history({ ps: 5 })).rejects.toMatchObject({ code: -101 });
  });

  it('收藏/关注/稍后再看端点可达且未登录安全', async () => {
    // 收藏夹接口匿名常返回 code=0,data=null；关注/稍后再看返回 -101；风控 -352/-412 视为可达
    const accept = async (
      label: string,
      task: () => Promise<unknown>,
    ): Promise<string> => {
      try {
        const value = await task();
        return `${label}: ok(${value === null ? 'null' : 'data'})`;
      } catch (error) {
        if (error instanceof BiliApiError) {
          expect([-101, -352, -412]).toContain(error.code);
          return `${label}: code=${error.code}`;
        }
        throw error;
      }
    };

    const results = await Promise.all([
      accept('favFolders', () => api.favFolders(1)),
      accept('favResources', () => api.favResources(1, { type: 1, order: 'mtime' })),
      accept('followings', () => api.followings(1)),
      accept('watchLater', () => api.watchLater()),
    ]);
    console.log(`signals endpoints: ${results.join(' | ')}`);
  });

  it('请求都发生在请求预算内', () => {
    expect(http.requests).toBeLessThan(60);
    console.log(`本轮共 ${http.requests} 次请求`);
  });
});
