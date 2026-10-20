import type { ApiFetchRequest, ApiFetchResult } from '../../shared/types';
import { HttpClient } from './http';

/**
 * 传输层：B站标签页中转。
 *
 * Service Worker 直连 B站接口时，cookie 一般能带上；但个别情况下会被判未登录或触发风控。
 * 此时把同样的 URL 交给已打开的 B站页面里的 content script，用页面上下文重发一次，
 * 再回传 JSON 文本。这样不复制、不保存任何 cookie。
 */

/** 只有 www.bilibili.com 匹配 content script，中转范围与 manifest 保持一致 */
export const BILI_TAB_PATTERNS = ['https://www.bilibili.com/*'];

export function hasBiliTabsApi(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.tabs?.query);
}

export async function relayViaBiliTab(url: string): Promise<ApiFetchResult> {
  if (!hasBiliTabsApi()) {
    return { ok: false, status: 0, body: '', error: '当前环境没有 chrome.tabs' };
  }

  const tabs = await chrome.tabs.query({ url: BILI_TAB_PATTERNS });
  const request: ApiFetchRequest = { type: 'API_FETCH', url };

  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const result = (await chrome.tabs.sendMessage(tab.id, request)) as
        | ApiFetchResult
        | undefined;
      if (result && typeof result.body === 'string' && result.body.length > 0) return result;
    } catch {
      /* 这个标签页没有 content script 或已卸载，换下一个 */
    }
  }

  return {
    ok: false,
    status: 0,
    body: '',
    error: '没有可用的 B站标签页，请先打开 bilibili.com',
  };
}

/** 后台使用的默认客户端：直连 + 标签页中转 */
export function createBrowserHttpClient(options?: {
  onRequest?: (url: string) => void;
}): HttpClient {
  return new HttpClient({ relay: relayViaBiliTab, onRequest: options?.onRequest });
}
