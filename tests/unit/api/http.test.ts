import { describe, expect, it } from 'vitest';
import {
  BiliApiError,
  HttpClient,
  NetworkError,
  RELAY_CODES,
} from '../../../src/core/api/http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const noSleep = async () => undefined;

describe('HttpClient', () => {
  it('解析信封并统计请求次数', async () => {
    let calls = 0;
    const client = new HttpClient({
      fetcher: async () => {
        calls += 1;
        return jsonResponse({ code: 0, message: 'OK', data: { value: 1 } });
      },
      sleep: noSleep,
      minGapMs: 0,
    });
    const data = await client.getJson<{ value: number }>('https://api.bilibili.com/test');
    expect(data).toEqual({ value: 1 });
    expect(calls).toBe(1);
    expect(client.requests).toBe(1);
  });

  it('code !== 0 时 getJson 抛 BiliApiError', async () => {
    const client = new HttpClient({
      fetcher: async () => jsonResponse({ code: -404, message: '啥都木有', data: null }),
      sleep: noSleep,
      minGapMs: 0,
    });
    await expect(client.getJson('https://api.bilibili.com/test')).rejects.toMatchObject({
      name: 'BiliApiError',
      code: -404,
    });
  });

  it('未登录码会改用标签页中转', async () => {
    const relayed: string[] = [];
    let direct = 0;
    const client = new HttpClient({
      fetcher: async () => {
        direct += 1;
        return jsonResponse({ code: -101, message: '账号未登录', data: null });
      },
      relay: async (url) => {
        relayed.push(url);
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ code: 0, message: 'OK', data: { via: 'tab' } }),
        };
      },
      sleep: noSleep,
      minGapMs: 0,
    });
    expect(RELAY_CODES.has(-101)).toBe(true);
    expect(RELAY_CODES.has(11010)).toBe(true);
    const data = await client.getJson<{ via: string }>('https://api.bilibili.com/history');
    expect(data).toEqual({ via: 'tab' });
    expect(direct).toBe(1);
    expect(relayed).toHaveLength(1);
  });

  it('参数错误码不触发中转', async () => {
    let relayed = 0;
    const client = new HttpClient({
      fetcher: async () => jsonResponse({ code: -400, message: '请求错误', data: null }),
      relay: async () => {
        relayed += 1;
        return { ok: true, status: 200, body: '{"code":0,"message":"OK","data":1}' };
      },
      sleep: noSleep,
      minGapMs: 0,
    });
    await expect(client.getJson('https://api.bilibili.com/x')).rejects.toBeInstanceOf(BiliApiError);
    expect(relayed).toBe(0);
  });

  it('网络失败会重试，并在可用时中转', async () => {
    let attempts = 0;
    const client = new HttpClient({
      fetcher: async () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
      relay: async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ code: 0, message: 'OK', data: { ok: true } }),
      }),
      retries: 1,
      sleep: noSleep,
      minGapMs: 0,
    });
    const data = await client.getJson<{ ok: boolean }>('https://api.bilibili.com/x');
    expect(data.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('HTTP 412 会重试；没有中转时最终抛错', async () => {
    let attempts = 0;
    const client = new HttpClient({
      fetcher: async () => {
        attempts += 1;
        return new Response('blocked', { status: 412 });
      },
      retries: 1,
      sleep: noSleep,
      minGapMs: 0,
    });
    await expect(client.get('https://api.bilibili.com/x')).rejects.toBeInstanceOf(NetworkError);
    expect(attempts).toBe(2);
  });

  it('中转失败时退回直连结果', async () => {
    const client = new HttpClient({
      fetcher: async () => jsonResponse({ code: -101, message: '账号未登录', data: null }),
      relay: async () => {
        throw new NetworkError('没有可用的 B站标签页', 'https://api.bilibili.com/x');
      },
      sleep: noSleep,
      minGapMs: 0,
    });
    const envelope = await client.get('https://api.bilibili.com/x');
    expect(envelope.code).toBe(-101);
  });

  it('空响应会重试后失败', async () => {
    const client = new HttpClient({
      fetcher: async () => new Response('', { status: 200 }),
      retries: 0,
      sleep: noSleep,
      minGapMs: 0,
    });
    await expect(client.get('https://api.bilibili.com/x')).rejects.toBeInstanceOf(NetworkError);
  });
});
