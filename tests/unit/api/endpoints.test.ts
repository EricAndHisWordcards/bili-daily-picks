import { describe, expect, it } from 'vitest';
import { BiliApi } from '../../../src/core/api/endpoints';
import { BiliApiError, HttpClient } from '../../../src/core/api/http';

function makeApi(response: unknown = { code: 0, message: 'OK', data: { list: [] } }) {
  const urls: string[] = [];
  const client = new HttpClient({
    fetcher: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => undefined,
    minGapMs: 0,
  });
  return { api: new BiliApi(client), urls };
}

describe('v0.2.0 收藏/关注/稍后再看端点', () => {
  it('收藏夹列表带 up_mid', async () => {
    const { api, urls } = makeApi();
    await api.favFolders(946974);
    expect(urls[0]).toContain('/x/v3/fav/folder/created/list-all');
    expect(urls[0]).toContain('up_mid=946974');
  });

  it('全部收藏夹：type=1 + order=mtime + 分页参数', async () => {
    const { api, urls } = makeApi();
    await api.favResources(1052622027, { pn: 2, ps: 20, order: 'mtime', type: 1 });
    const url = urls[0]!;
    expect(url).toContain('/x/v3/fav/resource/list');
    expect(url).toContain('media_id=1052622027');
    expect(url).toContain('type=1');
    expect(url).toContain('order=mtime');
    expect(url).toContain('pn=2');
    expect(url).toContain('ps=20');
    expect(url).toContain('platform=web');
  });

  it('关注列表带 vmid 与分页', async () => {
    const { api, urls } = makeApi();
    await api.followings(42, 2, 50);
    expect(urls[0]).toContain('/x/relation/followings');
    expect(urls[0]).toContain('vmid=42');
    expect(urls[0]).toContain('pn=2');
    expect(urls[0]).toContain('ps=50');
  });

  it('稍后再看带分页', async () => {
    const { api, urls } = makeApi();
    await api.watchLater(1, 20);
    expect(urls[0]).toContain('/x/v2/history/toview');
    expect(urls[0]).toContain('pn=1');
    expect(urls[0]).toContain('ps=20');
  });

  it('未登录 -101 抛 BiliApiError，交给上层降级', async () => {
    const { api } = makeApi({ code: -101, message: '账号未登录', data: null });
    await expect(api.followings(42)).rejects.toBeInstanceOf(BiliApiError);
    await expect(api.watchLater()).rejects.toMatchObject({ code: -101 });
  });

  it('data=null 时正常返回空对象结构（收藏接口匿名常见）', async () => {
    const { api } = makeApi({ code: 0, message: 'OK', data: null });
    await expect(api.favFolders(42)).resolves.toBeNull();
  });
});
