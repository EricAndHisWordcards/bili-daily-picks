/**
 * 数据层：扩展环境通过 chrome.runtime.sendMessage 请求后台；离线演示时动态加载 mock。
 *
 * 消息协议见 `src/shared/types.ts` 的 BgRequest / BgResponse。
 */
import type {
  AccountInfo,
  BgRequest,
  BgResponse,
  DashboardData,
  ImportSummary,
  RunStatus,
  Settings,
  WeeklyReportResponse,
} from '../../shared/types';
import type { ExportBackupResult, MockVariant, UiApi } from './types';

/* ------------------------------------------------------------------ */
/* 运行环境判断                                                        */
/* ------------------------------------------------------------------ */

interface ChromeRuntimeLike {
  id?: string;
  lastError?: { message?: string };
  sendMessage(message: unknown, callback: (response: BgResponse | undefined) => void): void;
}

interface ChromeLike {
  runtime?: ChromeRuntimeLike;
}

function getRuntime(): ChromeRuntimeLike | undefined {
  const chrome = (globalThis as { chrome?: ChromeLike }).chrome;
  return chrome?.runtime && typeof chrome.runtime.sendMessage === 'function' && chrome.runtime.id
    ? chrome.runtime
    : undefined;
}

function hasExtensionRuntime(): boolean {
  try {
    return Boolean(getRuntime());
  } catch {
    return false;
  }
}

/** 读取 ?mock= 场景参数；不在 mock 模式返回 null */
export function readMockVariant(): MockVariant | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('mock')) return null;
  const raw = (params.get('mock') ?? '').trim().toLowerCase();
  if (params.get('loggedout') === '1' || raw.startsWith('loggedout')) return 'loggedout';
  if (raw.startsWith('empty')) return 'empty';
  if (raw.startsWith('error')) return 'error';
  if (raw.startsWith('degraded')) return 'degraded';
  if (raw.startsWith('fallback')) return 'fallback';
  return 'normal';
}

export function isMockMode(): boolean {
  return readMockVariant() !== null || !hasExtensionRuntime();
}

/* ------------------------------------------------------------------ */
/* 扩展消息封装                                                        */
/* ------------------------------------------------------------------ */

class BackgroundUnavailableError extends Error {
  constructor() {
    super('扩展后台不可用：请从扩展页面打开仪表盘（离线预览请加 ?mock=1）');
    this.name = 'BackgroundUnavailableError';
  }
}

/** 发送一条 BgRequest，按 BgResponse 约定解包 */
export function sendBgRequest<T>(request: BgRequest): Promise<T> {
  const runtime = getRuntime();
  if (!runtime) return Promise.reject(new BackgroundUnavailableError());
  return new Promise<T>((resolve, reject) => {
    try {
      runtime.sendMessage(request, (response) => {
        // MV3 中必须在本回调内读取 lastError，否则会被浏览器记为未处理错误
        const lastError = runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message ?? '扩展后台通信失败'));
          return;
        }
        if (!response) {
          reject(new Error('扩展后台没有返回数据，请重新加载仪表盘'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error ?? '扩展后台处理失败'));
          return;
        }
        resolve(response.data as T);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/* ------------------------------------------------------------------ */
/* 两种实现                                                            */
/* ------------------------------------------------------------------ */

function createExtensionApi(): UiApi {
  return {
    mode: 'extension',
    variant: null,
    async getDashboardData() {
      const data = await sendBgRequest<DashboardData | undefined>({ type: 'GET_DASHBOARD_DATA' });
      if (!data || typeof data !== 'object') {
        throw new Error('后台没有返回仪表盘数据，请确认扩展为最新版本后重新加载');
      }
      return data;
    },
    async getStatus() {
      const status = await sendBgRequest<RunStatus | undefined>({ type: 'GET_STATUS' });
      return status ?? { running: false, stage: 'idle', progress: 0 };
    },
    async runNow(force = true) {
      const status = await sendBgRequest<RunStatus | undefined>({ type: 'RUN_NOW', force });
      return status ?? { running: true, stage: 'auth', progress: 0 };
    },
    async dismiss(bvid) {
      await sendBgRequest<unknown>({ type: 'DISMISS', bvid });
    },
    async saveSettings(patch) {
      const saved = await sendBgRequest<Settings | undefined>({ type: 'SET_SETTINGS', patch });
      // 后台契约应返回合并后的设置；若没有返回，再补一次 GET_SETTINGS 拿到完整值
      if (saved && typeof saved === 'object') return saved;
      return sendBgRequest<Settings>({ type: 'GET_SETTINGS' });
    },
    async clearData() {
      await sendBgRequest<unknown>({ type: 'CLEAR_DATA' });
    },
    async refreshAccount() {
      const account = await sendBgRequest<AccountInfo | undefined>({ type: 'REFRESH_ACCOUNT' });
      if (!account || typeof account !== 'object') {
        throw new Error('后台没有返回账号状态，请重新加载仪表盘');
      }
      return account;
    },
    async getWeeklyReport(weekKey) {
      const response = await sendBgRequest<WeeklyReportResponse | undefined>({
        type: 'GET_WEEKLY_REPORT',
        weekKey,
      });
      return response ?? { report: null, reports: [] };
    },
    async exportBackup() {
      const result = await sendBgRequest<ExportBackupResult | undefined>({
        type: 'EXPORT_BACKUP',
      });
      if (!result || typeof result.json !== 'string' || !result.json) {
        throw new Error('后台没有返回备份内容');
      }
      return result;
    },
    async importBackup(json) {
      const summary = await sendBgRequest<ImportSummary | undefined>({
        type: 'IMPORT_BACKUP',
        json,
      });
      if (!summary || typeof summary !== 'object') {
        throw new Error('后台没有返回导入结果');
      }
      return summary;
    },
  };
}

let apiPromise: Promise<UiApi> | null = null;

/** 获取 UI 数据层单例（mock 模块按需动态加载，正常扩展加载不会加载演示数据） */
export function getApi(): Promise<UiApi> {
  if (!apiPromise) {
    apiPromise = (async (): Promise<UiApi> => {
      const variant = readMockVariant();
      if (variant !== null || !hasExtensionRuntime()) {
        const { createMockApi } = await import('./mock');
        return createMockApi(variant ?? 'normal');
      }
      return createExtensionApi();
    })().catch((error: unknown) => {
      apiPromise = null;
      throw error;
    });
  }
  return apiPromise;
}

/** 测试/调试用：重置单例（正常页面不需要） */
export function resetApiForTests(): void {
  apiPromise = null;
}
