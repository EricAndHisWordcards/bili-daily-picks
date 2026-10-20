import type { ApiFetchResult } from '../../shared/types';
import { RATE_LIMIT } from '../../shared/constants';

/**
 * 轻量 HTTP 客户端：限流、超时、重试、风控码判断、B站标签页中转。
 *
 * 直连走 Service Worker 的 fetch（浏览器自动携带 B站 cookie）；当返回未登录/风控码
 * 或网络失败时，交给 `relay` 在已打开的 B站页面里重发一次（页面同源，cookie 与
 * Referer 都正确）。relay 由 extension 层注入，测试里可以省略。
 */

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  ttl?: number;
  data: T;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

export const noopCache: CacheStore = {
  async get() {
    return undefined;
  },
  async set() {
    /* no-op */
  },
};

export type RelayFn = (url: string) => Promise<ApiFetchResult>;

export interface HttpClientOptions {
  fetcher?: typeof fetch;
  relay?: RelayFn;
  maxConcurrent?: number;
  minGapMs?: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: readonly number[];
  /**
   * 额外请求头。浏览器里 `User-Agent` / `Referer` 是禁止设置的头，会被忽略；
   * Node 下的探针脚本可以借此带上正常的 UA / Referer，避免被风控。
   */
  defaultHeaders?: Record<string, string>;
  /** 每发起一次真实网络请求（含重试与中转）时调用，用于统计请求预算 */
  onRequest?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class BiliApiError extends Error {
  readonly code: number;
  readonly endpoint: string;

  constructor(message: string, code: number, endpoint: string) {
    super(message);
    this.name = 'BiliApiError';
    this.code = code;
    this.endpoint = endpoint;
  }
}

export class NetworkError extends Error {
  readonly endpoint: string;

  constructor(message: string, endpoint: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'NetworkError';
    this.endpoint = endpoint;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 这些返回码值得换到 B站页面上下文重试 */
export const RELAY_CODES = new Set([-101, -352, -412, -403, 412, 429]);

/** 这些返回码重试也没用（参数/资源问题） */
export const NON_RETRY_CODES = new Set([-400, -404, -10403]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class RateLimiter {
  private active = 0;
  private lastStart = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly minGapMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<() => void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    const wait = this.lastStart + this.minGapMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
    return () => {
      this.active -= 1;
      const next = this.waiters.shift();
      next?.();
    };
  }
}

export class HttpClient {
  private readonly fetcher: typeof fetch;
  private readonly relay?: RelayFn;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRequest?: (url: string) => void;
  private readonly defaultHeaders: Record<string, string>;

  /** 累计真实网络请求数，供运行报告使用 */
  requests = 0;

  constructor(options: HttpClientOptions = {}) {
    const fetchImpl = options.fetcher ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error('当前环境没有 fetch');
    this.fetcher = fetchImpl;
    this.relay = options.relay;
    this.timeoutMs = options.timeoutMs ?? RATE_LIMIT.timeoutMs;
    this.retries = options.retries ?? RATE_LIMIT.retries;
    this.backoffMs = options.backoffMs ?? RATE_LIMIT.backoffMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRequest = options.onRequest;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.limiter = new RateLimiter(
      options.maxConcurrent ?? RATE_LIMIT.maxConcurrent,
      options.minGapMs ?? RATE_LIMIT.minGapMs,
      this.sleep,
    );
  }

  /**
   * 请求并返回原始响应信封（不因 code !== 0 抛错），必要时自动改用标签页中转。
   */
  async get<T>(
    url: string,
    options: { timeoutMs?: number; allowRelay?: boolean } = {},
  ): Promise<ApiEnvelope<T>> {
    const allowRelay = options.allowRelay !== false && Boolean(this.relay);
    let direct: ApiEnvelope<T> | null = null;
    let directError: unknown = null;

    try {
      direct = await this.requestEnvelope<T>(url, options.timeoutMs);
    } catch (error) {
      directError = error;
    }

    const needRelay = allowRelay && (!direct || RELAY_CODES.has(direct.code));
    if (needRelay && this.relay) {
      try {
        const relayed = await this.requestViaRelay(url, options.timeoutMs);
        return relayed;
      } catch {
        /* 中转失败时退回直连结果 */
      }
    }

    if (direct) return direct;
    throw directError instanceof Error
      ? directError
      : new NetworkError('请求失败', url, { cause: directError });
  }

  /** 请求并要求 code === 0，否则抛 BiliApiError */
  async getJson<T>(url: string, options: { timeoutMs?: number; allowRelay?: boolean } = {}): Promise<T> {
    const envelope = await this.get<T>(url, options);
    if (envelope.code !== 0) {
      throw new BiliApiError(envelope.message || `接口返回 ${envelope.code}`, envelope.code, url);
    }
    return envelope.data;
  }

  private async requestViaRelay(url: string, timeoutMs?: number): Promise<ApiEnvelope<never>> {
    if (!this.relay) throw new NetworkError('没有可用的中转通道', url);
    const result = await this.relay(url);
    this.requests += 1;
    this.onRequest?.(url);
    if (!result.ok) {
      throw new NetworkError(result.error || `中转请求失败（HTTP ${result.status}）`, url);
    }
    try {
      return JSON.parse(result.body) as ApiEnvelope<never>;
    } catch {
      throw new NetworkError('中转响应不是 JSON', url);
    }
  }

  private async requestEnvelope<T>(url: string, timeoutMs?: number): Promise<ApiEnvelope<T>> {
    const total = this.retries + 1;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < total; attempt++) {
      if (attempt > 0) {
        const backoff = this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 1000;
        await this.sleep(backoff);
      }
      const release = await this.limiter.acquire();
      try {
        const result = await this.fetchOnce(url, timeoutMs);
        if (result.status >= 500 || result.status === 412 || result.status === 429) {
          lastError = new NetworkError(`HTTP ${result.status}`, url);
          continue;
        }
        if (!result.text.trim()) {
          lastError = new NetworkError('空响应', url);
          continue;
        }
        let envelope: ApiEnvelope<T>;
        try {
          envelope = JSON.parse(result.text) as ApiEnvelope<T>;
        } catch {
          lastError = new NetworkError(`响应不是 JSON（HTTP ${result.status}）`, url);
          continue;
        }
        if (typeof envelope.code !== 'number') {
          lastError = new NetworkError('响应缺少 code 字段', url);
          continue;
        }
        if (NON_RETRY_CODES.has(envelope.code)) return envelope;
        return envelope;
      } catch (error) {
        lastError = error;
      } finally {
        release();
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new NetworkError('请求失败', url, { cause: lastError });
  }

  private async fetchOnce(
    url: string,
    timeoutMs?: number,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    this.requests += 1;
    this.onRequest?.(url);
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain, */*', ...this.defaultHeaders },
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      throw new NetworkError(
        error instanceof Error && error.name === 'AbortError' ? '请求超时' : '网络请求失败',
        url,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
