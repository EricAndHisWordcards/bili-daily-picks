/**
 * 后台 service worker：依赖装配 + 闹钟调度 + 消息路由。
 *
 * 架构：
 * - 数据采集/打分全部由 `createPipeline`（engine 实现）负责，这里只做 Chrome 环境适配；
 * - 每分钟一个 `pipeline-tick` 闹钟推进流水线，单个 tick 最多约 20 秒，进度存在 IndexedDB，
 *   Service Worker 被回收后仍能续跑；
 * - 每日在 settings.updateHour（本地时间）触发一次全量运行（autoUpdate 打开时）；
 * - 仪表盘通过 chrome.runtime.sendMessage 发 BgRequest，这里统一返回 BgResponse。
 */
import { APP_NAME, BACKUP_LIMITS, DASHBOARD_PAGE, DEFAULT_SETTINGS } from '../shared/constants';
import { DAY, MINUTE, todayAtHour } from '../shared/time';
import type {
  BgRequest,
  BgResponse,
  DashboardData,
  ImportSummary,
  RunStatus,
  WeeklyReportResponse,
} from '../shared/types';
import { createBrowserHttpClient } from '../core/api/transport';
import { createBiliApi } from '../core/api/endpoints';
import { createPipeline } from '../core/pipeline';
import type { PipelineController } from '../core/pipeline-contract';
import { createIdbRepository, createRepositoryCache } from '../core/store/repository';
import { createChromeSettingsStore } from '../core/store/settings';
import { backupFilename, buildBackupFile, parseBackup } from '../core/store/backup';

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

const TICK_ALARM = 'pipeline-tick';
const DAILY_ALARM = 'daily-update';

/** tick 跨 Service Worker 实例的并发保护（内存队列之外的兜底） */
const TICK_LOCK_KEY = 'pipeline:tick-lock';
const TICK_LOCK_STALE_MS = 3 * MINUTE;
const LAST_ERROR_KEY = 'pipeline:last-error';
const NEXT_DUE_KEY = 'pipeline:next-due';
const TICK_HEARTBEAT_KEY = 'pipeline:tick-heartbeat';

/** 用户关掉悬浮入口的记忆，设置里重新打开 showFloatingButton 时清除 */
const DISMISS_STORAGE_KEY = 'floating:dismissed';

/* ------------------------------------------------------------------ */
/* 依赖装配                                                           */
/* ------------------------------------------------------------------ */

const repo = createIdbRepository();
const settings = createChromeSettingsStore();

/** 真实网络请求计数（含重试与标签页中转），供日志与运行报告使用 */
let requestCount = 0;

const http = createBrowserHttpClient({
  onRequest: () => {
    requestCount += 1;
  },
});

const api = createBiliApi(http, { cache: createRepositoryCache(repo) });

function logger(message: string, extra?: unknown): void {
  if (extra === undefined) console.info(`[${APP_NAME}] ${message}`);
  else console.info(`[${APP_NAME}] ${message}`, extra);
}

let controller: PipelineController | null = null;

/** 延迟构造：即使 engine 初始化失败，也让消息路由能返回结构化错误 */
function getController(): PipelineController {
  if (!controller) {
    controller = createPipeline({
      repo,
      settings,
      api,
      http,
      now: () => Date.now(),
      logger,
    });
    logger('流水线控制器已初始化');
  }
  return controller;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

interface StoredLock {
  at: number;
}

interface StoredError {
  at: number;
  message: string;
}

interface TickHeartbeat {
  at: number;
  stage: string;
  running: boolean;
  requests: number;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  try {
    const stored = await chrome.storage.local.get(key);
    return stored?.[key] as T | undefined;
  } catch {
    return undefined;
  }
}

async function storageSet(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(items);
  } catch {
    /* 存储失败不影响主流程 */
  }
}

async function storageRemove(keys: string | string[]): Promise<void> {
  try {
    await chrome.storage.local.remove(keys);
  } catch {
    /* 忽略 */
  }
}

/**
 * 串行化所有会修改流水线状态的操作（tick / runNow / clearData / dismiss）。
 * Service Worker 是单线程，但多个事件（闹钟 + 消息）的异步链可能交错。
 */
let pipelineQueue: Promise<unknown> = Promise.resolve();

function serializePipeline<T>(task: () => Promise<T>): Promise<T> {
  const next = pipelineQueue.then(task, task);
  pipelineQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* 运行状态与 due 计算                                                 */
/* ------------------------------------------------------------------ */

/** 下一次每日更新时刻（本地时间 updateHour 整点） */
function nextDueAtFor(updateHour: number, referenceMs: number = Date.now()): number {
  const todayDue = todayAtHour(updateHour, referenceMs);
  if (todayDue > referenceMs) return todayDue;
  return todayAtHour(updateHour, referenceMs + DAY);
}

async function currentNextDueAt(): Promise<number | undefined> {
  const current = await settings.get();
  if (!current.autoUpdate) return undefined;
  return nextDueAtFor(current.updateHour);
}

async function readLastError(): Promise<string | undefined> {
  const row = await storageGet<StoredError>(LAST_ERROR_KEY);
  if (!row || typeof row.message !== 'string') return undefined;
  if (Date.now() - row.at > 7 * DAY) return undefined;
  return row.message;
}

/** 把 nextDueAt / 定时器里的 lastError 合并进 controller 返回的状态 */
async function enrichStatus(status: RunStatus): Promise<RunStatus> {
  const [nextDueAt, lastError] = await Promise.all([currentNextDueAt(), readLastError()]);
  return {
    ...status,
    nextDueAt: status.nextDueAt ?? nextDueAt,
    lastError: status.lastError ?? lastError,
  };
}

/* ------------------------------------------------------------------ */
/* 闹钟                                                               */
/* ------------------------------------------------------------------ */

async function ensureTickAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) {
    await chrome.alarms.create(TICK_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    logger('已创建每分钟流水线闹钟');
  }
}

/** 按当前 settings.updateHour 重建每日闹钟；autoUpdate 关闭时删除 */
async function rescheduleDailyAlarm(): Promise<number | undefined> {
  const current = await settings.get();
  if (!current.autoUpdate) {
    await chrome.alarms.clear(DAILY_ALARM);
    await storageSet({ [NEXT_DUE_KEY]: null });
    logger('自动更新已关闭，移除每日闹钟');
    return undefined;
  }
  const nextDueAt = nextDueAtFor(current.updateHour);
  await chrome.alarms.create(DAILY_ALARM, { when: nextDueAt });
  await storageSet({ [NEXT_DUE_KEY]: nextDueAt });
  logger(`每日更新闹钟已设置：${new Date(nextDueAt).toLocaleString()}`);
  return nextDueAt;
}

/** Service Worker 被唤醒时自愈：只补缺失的每日闹钟，不覆盖已有计划 */
async function ensureDailyAlarm(): Promise<void> {
  const current = await settings.get();
  if (!current.autoUpdate) {
    await chrome.alarms.clear(DAILY_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(DAILY_ALARM);
  if (existing) return;
  await chrome.alarms.create(DAILY_ALARM, { when: nextDueAtFor(current.updateHour) });
}

async function acquireTickLock(): Promise<boolean> {
  const lock = await storageGet<StoredLock>(TICK_LOCK_KEY);
  if (lock && typeof lock.at === 'number' && Date.now() - lock.at < TICK_LOCK_STALE_MS) {
    return false;
  }
  await storageSet({ [TICK_LOCK_KEY]: { at: Date.now() } satisfies StoredLock });
  return true;
}

async function releaseTickLock(): Promise<void> {
  await storageRemove(TICK_LOCK_KEY);
}

/** 每分钟推进一小段流水线；失败只记录 lastError，下个 tick 继续 */
async function handleTick(): Promise<void> {
  await serializePipeline(async () => {
    if (!(await acquireTickLock())) {
      logger('上一个 tick 尚未结束，跳过本次');
      return;
    }
    try {
      const status = await getController().tick();
      await storageSet({
        [TICK_HEARTBEAT_KEY]: {
          at: Date.now(),
          stage: status.stage,
          running: status.running,
          requests: requestCount,
        } satisfies TickHeartbeat,
      });
      await storageRemove(LAST_ERROR_KEY);
    } catch (error) {
      const message = toErrorMessage(error);
      await storageSet({ [LAST_ERROR_KEY]: { at: Date.now(), message } satisfies StoredError });
      console.warn(`[${APP_NAME}] 定时推进失败：${message}`);
    } finally {
      await releaseTickLock();
    }
  });
}

/**
 * 每日到点：直接触发一次 tick。
 * 「是否到期、是否该启动新一轮」由 engine 的 controller.tick() 根据
 * settings.autoUpdate / updateHour / 最近一次 DailyResult 自行判断，
 * 后台不再重复实现启动逻辑，避免与每分钟 tick 竞争。
 */
async function handleDailyAlarm(): Promise<void> {
  try {
    await handleTick();
  } finally {
    try {
      await rescheduleDailyAlarm();
    } catch (error) {
      console.warn(`[${APP_NAME}] 重设每日闹钟失败：${toErrorMessage(error)}`);
    }
  }
}

/** 浏览器启动时补跑今天错过的每日任务（安装/更新时不补跑，避免打扰） */
async function catchUpMissedDaily(): Promise<void> {
  const current = await settings.get();
  if (!current.autoUpdate) return;
  if (Date.now() < todayAtHour(current.updateHour)) return;
  await handleTick();
}

/* ------------------------------------------------------------------ */
/* 仪表盘                                                             */
/* ------------------------------------------------------------------ */

async function findDashboardTabId(url: string): Promise<number | null> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB' as chrome.runtime.ContextType],
    });
    for (const context of contexts) {
      if (
        typeof context.tabId === 'number' &&
        context.tabId >= 0 &&
        typeof context.documentUrl === 'string' &&
        context.documentUrl.startsWith(url)
      ) {
        return context.tabId;
      }
    }
  } catch {
    /* 老版本浏览器没有 getContexts，直接新开一个标签页 */
  }
  return null;
}

async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL(DASHBOARD_PAGE);
  const existingTabId = await findDashboardTabId(url);
  if (existingTabId !== null) {
    try {
      await chrome.tabs.update(existingTabId, { active: true });
    } catch {
      /* 标签页可能刚被关闭，继续走新建流程 */
    }
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      /* 忽略窗口聚焦失败 */
    }
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                           */
/* ------------------------------------------------------------------ */

async function loadDashboardData(): Promise<DashboardData> {
  const data = await getController().getDashboardData();
  return { ...data, status: await enrichStatus(data.status) };
}

/* ---------------- v0.2.0：账号 / 周报 / 备份 ---------------- */

interface ExportBackupPayload {
  filename: string;
  json: string;
  bytes: number;
}

/** UTF-8 字节数（与 parseBackup 使用同一口径） */
function jsonByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function oversizedBackupError(bytes: number): Error {
  return new Error(
    `备份文件过大（${formatMb(bytes)}MB），上限 ${formatMb(BACKUP_LIMITS.jsonBytes)}MB`,
  );
}

/**
 * 导出全部本地数据为备份文件内容。
 * 返回 JSON 字符串而不是直接触发下载：下载由仪表盘用 Blob + <a download> 完成，
 * 这样后台不需要 downloads 权限（也不加新权限）。
 */
async function exportBackup(): Promise<ExportBackupPayload> {
  const data = await getController().exportData();
  const file = buildBackupFile(data, chrome.runtime.getManifest().version);
  const json = JSON.stringify(file);
  const bytes = jsonByteLength(json);
  if (bytes > BACKUP_LIMITS.jsonBytes) throw oversizedBackupError(bytes);
  return { filename: backupFilename(), json, bytes };
}

/**
 * 导入备份：先按 BACKUP_LIMITS 检查体积，再 parseBackup 完整校验；
 * 校验失败直接抛错，不会调用 importData 覆盖任何现有数据。
 * 导入成功后按备份里的设置重设每日闹钟。
 */
async function importBackup(json: string): Promise<ImportSummary> {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new Error('缺少备份 JSON 内容');
  }
  const bytes = jsonByteLength(json);
  if (bytes > BACKUP_LIMITS.jsonBytes) throw oversizedBackupError(bytes);
  const parsed = parseBackup(json);
  const summary = await serializePipeline(() => getController().importData(parsed.data));
  // 坏行在 parseBackup 阶段已被丢弃，controller 只拿到清洗后的数据，这里把 dropped 合并回 UI
  const merged: ImportSummary = { ...summary, dropped: parsed.summary.dropped };
  await rescheduleDailyAlarm();
  logger(`备份导入完成：${JSON.stringify(merged)}`);
  return merged;
}

async function clearAllData(): Promise<void> {
  await serializePipeline(async () => {
    await getController().clearData();
    // controller 会清空全部数据并把设置恢复默认；这里显式再写一次，
    // 同时保持自动更新关闭，避免下一分钟的 tick 立刻重新采集历史。
    await settings.set({ ...DEFAULT_SETTINGS, autoUpdate: false });
    await storageRemove([
      TICK_LOCK_KEY,
      LAST_ERROR_KEY,
      NEXT_DUE_KEY,
      TICK_HEARTBEAT_KEY,
      DISMISS_STORAGE_KEY,
    ]);
    requestCount = 0;
  });
  await rescheduleDailyAlarm();
  logger('本地数据已清空');
}

async function handleRequest(request: BgRequest): Promise<BgResponse> {
  switch (request.type) {
    case 'GET_DASHBOARD_DATA': {
      return { ok: true, data: await loadDashboardData() };
    }
    case 'GET_DAILY': {
      return { ok: true, data: await getController().getDaily() };
    }
    case 'GET_PROFILE': {
      return { ok: true, data: await repo.getProfile() };
    }
    case 'GET_STATUS': {
      return { ok: true, data: await enrichStatus(await getController().getStatus()) };
    }
    case 'GET_SETTINGS': {
      return { ok: true, data: await settings.get() };
    }
    case 'REFRESH_ACCOUNT': {
      // force=true 绕开 nav 的短缓存，用户点「刷新账号」时拿最新登录态
      return { ok: true, data: await getController().getAccount(true) };
    }
    case 'GET_WEEKLY_REPORT': {
      const weekKey =
        typeof request.weekKey === 'string' && request.weekKey.trim()
          ? request.weekKey.trim()
          : undefined;
      const response = (await getController().getWeeklyReport(weekKey)) as WeeklyReportResponse;
      return { ok: true, data: response };
    }
    case 'EXPORT_BACKUP': {
      try {
        return { ok: true, data: await exportBackup() };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    }
    case 'IMPORT_BACKUP': {
      try {
        return { ok: true, data: await importBackup(request.json) };
      } catch (error) {
        // 校验/写入失败：数据保持原样（parseBackup 在 importData 之前完成）
        return { ok: false, error: toErrorMessage(error) };
      }
    }
    case 'SET_SETTINGS': {
      const patch = request.patch ?? {};
      const next = await settings.set(patch);
      if (patch.showFloatingButton === true) {
        // 用户在设置里重新打开悬浮按钮：清掉之前的关闭记忆
        await storageRemove(DISMISS_STORAGE_KEY);
      }
      if (patch.autoUpdate !== undefined || patch.updateHour !== undefined) {
        await rescheduleDailyAlarm();
      }
      return { ok: true, data: next };
    }
    case 'RUN_NOW': {
      const status = await serializePipeline(() =>
        getController().runNow({ force: request.force ?? true }),
      );
      return { ok: true, data: await enrichStatus(status) };
    }
    case 'CLEAR_DATA': {
      await clearAllData();
      return { ok: true };
    }
    case 'DISMISS': {
      if (typeof request.bvid !== 'string' || request.bvid.length === 0) {
        return { ok: false, error: '缺少要拉黑的 bvid' };
      }
      await serializePipeline(() => getController().dismiss(request.bvid));
      return { ok: true };
    }
    case 'OPEN_DASHBOARD': {
      await openDashboard();
      return { ok: true };
    }
    default: {
      const unknown = request as { type?: unknown };
      return { ok: false, error: `未知消息类型：${String(unknown.type)}` };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // 内容脚本之间的 API_FETCH 中转由 content.ts 处理，后台不参与
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string' || type === 'API_FETCH') return false;

  handleRequest(message as BgRequest)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      const text = toErrorMessage(error);
      console.warn(`[${APP_NAME}] 处理消息 ${type} 失败：${text}`);
      sendResponse({ ok: false, error: text } satisfies BgResponse);
    });
  // 异步回包必须 return true
  return true;
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

async function initialize(reason: string): Promise<void> {
  await ensureTickAlarm();
  await rescheduleDailyAlarm();
  // 把合法设置落盘，内容脚本/设置页首读即有值
  await settings.set({});
  try {
    await repo.prune();
  } catch (error) {
    console.warn(`[${APP_NAME}] 清理过期数据失败：${toErrorMessage(error)}`);
  }
  logger(`扩展已初始化（${reason}）`);
  if (reason === 'install') {
    await openDashboard();
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void initialize(details.reason).catch((error: unknown) => {
    console.warn(`[${APP_NAME}] 初始化失败：${toErrorMessage(error)}`);
  });
});

// manifest 没有 default_popup，点击工具栏图标 = 打开仪表盘
chrome.action.onClicked.addListener(() => {
  void openDashboard().catch((error: unknown) => {
    console.warn(`[${APP_NAME}] 点击图标打开仪表盘失败：${toErrorMessage(error)}`);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    try {
      await ensureTickAlarm();
      await rescheduleDailyAlarm();
      await catchUpMissedDaily();
    } catch (error) {
      console.warn(`[${APP_NAME}] 启动自检失败：${toErrorMessage(error)}`);
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void handleTick();
  else if (alarm.name === DAILY_ALARM) void handleDailyAlarm();
});

// Service Worker 每次被唤醒都自愈闹钟（安装/启动事件之外的兜底）
void (async () => {
  try {
    await ensureTickAlarm();
    await ensureDailyAlarm();
  } catch (error) {
    console.warn(`[${APP_NAME}] 闹钟自检失败：${toErrorMessage(error)}`);
  }
})();

logger('background ready');
