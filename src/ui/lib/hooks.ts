/**
 * 仪表盘数据控制器：初次加载、运行状态轮询、账号刷新、周报、备份与用户操作。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AccountInfo,
  DashboardData,
  ImportSummary,
  RunStatus,
  Settings,
  WeeklyReportResponse,
} from '../../shared/types';
import { getApi } from './api';
import type { ExportBackupResult, MockVariant, ToastItem, ToastKind, UiApi } from './types';
import { errorMessage } from './view';

const ACCOUNT_AUTO_REFRESH_MS = 15_000;

export interface DashboardController {
  data: DashboardData | null;
  status: RunStatus | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  apiMode: UiApi['mode'] | null;
  mockVariant: MockVariant | null;
  toasts: ToastItem[];
  /** 账号状态刷新中（手动 / 回到页面自动） */
  accountRefreshing: boolean;
  /** 周报数据（懒加载） */
  weekly: WeeklyReportResponse | null;
  weeklyLoading: boolean;
  weeklyError: string | null;
  runNow: () => Promise<void>;
  retry: () => void;
  reload: () => Promise<void>;
  dismiss: (bvid: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  clearData: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  loadWeeklyReport: (weekKey?: string) => Promise<void>;
  /** 周报为空时：触发一次完整更新，等流水线结束后刷新周报 */
  generateWeekly: () => Promise<void>;
  exportBackup: () => Promise<ExportBackupResult | null>;
  importBackup: (json: string) => Promise<ImportSummary | null>;
  dismissToast: (id: number) => void;
}

/** 从所有板块里移除「不感兴趣」的视频（本地即时生效，后台同时会持久化） */
function applyDismissed(data: DashboardData, dismissed: Set<string>): DashboardData {
  if (!data.daily || dismissed.size === 0) return data;
  const sections = data.daily.sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => !dismissed.has(item.bvid)),
  }));
  return { ...data, daily: { ...data.daily, sections } };
}

export function useDashboard(): DashboardController {
  const [api, setApi] = useState<UiApi | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const [weekly, setWeekly] = useState<WeeklyReportResponse | null>(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);

  const dismissedRef = useRef<Set<string>>(new Set());
  const wasRunningRef = useRef(false);
  const toastSeq = useRef(0);
  const apiRef = useRef<UiApi | null>(null);
  const dataRef = useRef<DashboardData | null>(null);
  const busyRef = useRef(false);
  const accountBusyRef = useRef(false);
  const lastAccountRefreshRef = useRef(0);
  /** 「检测到登录但每日结果仍是公开模式」只自动补跑一次，避免循环 */
  const loginRerunRef = useRef(false);
  const weeklySeqRef = useRef(0);
  dataRef.current = data;

  const showToast = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const acceptData = useCallback((next: DashboardData) => {
    for (const bvid of next.dismissed) dismissedRef.current.add(bvid);
    const filtered = applyDismissed(next, dismissedRef.current);
    setData(filtered);
    setStatus(next.status);
    if (next.daily?.mode === 'full') loginRerunRef.current = false;
    return filtered;
  }, []);

  /* 初次加载 / 重试 -------------------------------------------------- */
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const instance = await getApi();
        if (stopped) return;
        apiRef.current = instance;
        setApi(instance);
        const next = await instance.getDashboardData();
        if (stopped) return;
        acceptData(next);
        wasRunningRef.current = next.status.running;
        lastAccountRefreshRef.current = Date.now();
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [reloadKey, acceptData]);

  /* 运行状态轮询：运行中 1.2s 一次，空闲 25s 一次 ------------------- */
  useEffect(() => {
    if (!api) return;
    let stopped = false;
    let timer = 0;

    const schedule = (delay: number): void => {
      if (stopped) return;
      timer = window.setTimeout(() => {
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      try {
        const nextStatus = await api.getStatus();
        if (stopped) return;
        setStatus(nextStatus);
        setData((prev) => (prev ? { ...prev, status: nextStatus } : prev));
        const finished = wasRunningRef.current && !nextStatus.running;
        wasRunningRef.current = nextStatus.running;
        if (finished) {
          const fresh = await api.getDashboardData();
          if (stopped) return;
          acceptData(fresh);
          wasRunningRef.current = fresh.status.running;
          if (fresh.status.lastError) showToast('error', `更新失败：${fresh.status.lastError}`);
          else showToast('success', '更新完成，推荐已刷新');
        }
        schedule(nextStatus.running ? 1200 : nextStatus.lastError ? 15000 : 25000);
      } catch {
        // 后台休眠或暂时不可用时保持界面，过一会儿再试
        schedule(25000);
      }
    };

    schedule(2500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [api, acceptData, showToast]);

  /* 用户操作 -------------------------------------------------------- */

  const reload = useCallback(async (): Promise<void> => {
    try {
      const instance = apiRef.current ?? (await getApi());
      apiRef.current = instance;
      const next = await instance.getDashboardData();
      acceptData(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [acceptData]);

  const retry = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  /** 内部统一启动一次更新；force=false 用于「检测到登录后自动补跑」 */
  const startRun = useCallback(
    async (force: boolean): Promise<boolean> => {
      const instance = apiRef.current;
      if (!instance || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const next = await instance.runNow(force);
        wasRunningRef.current = next.running;
        setStatus(next);
        setData((prev) => (prev ? { ...prev, status: next } : prev));
        if (next.running) {
          showToast('info', force ? '已开始更新，正在采集数据…' : '检测到已登录，正在重新生成个性化推荐…');
        } else if (next.lastError) {
          showToast('error', `更新失败：${next.lastError}`);
        }
        return true;
      } catch (err) {
        showToast('error', errorMessage(err));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [showToast],
  );

  const runNow = useCallback(async (): Promise<void> => {
    await startRun(true);
  }, [startRun]);

  const dismiss = useCallback(
    async (bvid: string): Promise<void> => {
      const instance = apiRef.current;
      if (!instance) return;
      dismissedRef.current.add(bvid);
      setData((prev) => (prev ? applyDismissed(prev, dismissedRef.current) : prev));
      try {
        await instance.dismiss(bvid);
        showToast('success', '已隐藏，这个视频不会再出现');
      } catch (err) {
        dismissedRef.current.delete(bvid);
        showToast('error', errorMessage(err));
        await reload();
      }
    },
    [reload, showToast],
  );

  const updateSettings = useCallback(
    async (patch: Partial<Settings>): Promise<boolean> => {
      const instance = apiRef.current;
      if (!instance) return false;
      const previous = dataRef.current?.settings;
      if (previous) {
        setData((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
      }
      try {
        const saved = await instance.saveSettings(patch);
        if (saved && typeof saved === 'object') {
          setData((prev) => (prev ? { ...prev, settings: saved } : prev));
        }
        // 每类数量、统计窗口等会影响生成结果，保存后重取一次
        const fresh = await instance.getDashboardData();
        acceptData(fresh);
        setError(null);
        return true;
      } catch (err) {
        if (previous) setData((prev) => (prev ? { ...prev, settings: previous } : prev));
        showToast('error', errorMessage(err));
        return false;
      }
    },
    [acceptData, showToast],
  );

  const clearData = useCallback(async (): Promise<void> => {
    const instance = apiRef.current;
    if (!instance) return;
    setBusy(true);
    try {
      await instance.clearData();
      dismissedRef.current.clear();
      setWeekly(null);
      const fresh = await instance.getDashboardData();
      acceptData(fresh);
      showToast('success', '已清空全部本地数据，自动更新已暂停');
    } catch (err) {
      showToast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [acceptData, showToast]);

  /* 账号状态 -------------------------------------------------------- */

  const performAccountRefresh = useCallback(
    async (notify: boolean): Promise<void> => {
      const instance = apiRef.current;
      if (!instance || accountBusyRef.current) return;
      accountBusyRef.current = true;
      setAccountRefreshing(true);
      try {
        const account: AccountInfo = await instance.refreshAccount();
        lastAccountRefreshRef.current = Date.now();
        setData((prev) => (prev ? { ...prev, account } : prev));
        if (notify) {
          showToast(
            'success',
            account.loggedIn
              ? '登录状态已刷新：已登录'
              : account.last
                ? '登录状态已刷新：登录已失效'
                : '登录状态已刷新：未登录',
          );
        }
        const currentDaily = dataRef.current?.daily;
        if (account.loggedIn && currentDaily?.mode === 'public' && !loginRerunRef.current) {
          loginRerunRef.current = true;
          await startRun(false);
        }
      } catch (err) {
        showToast('error', `刷新登录状态失败：${errorMessage(err)}`);
      } finally {
        accountBusyRef.current = false;
        setAccountRefreshing(false);
      }
    },
    [showToast, startRun],
  );

  const refreshAccount = useCallback(async (): Promise<void> => {
    await performAccountRefresh(true);
  }, [performAccountRefresh]);

  /** 页面重新可见时自动检测一次登录（15 秒内不重复） */
  useEffect(() => {
    if (!api) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastAccountRefreshRef.current < ACCOUNT_AUTO_REFRESH_MS) return;
      void performAccountRefresh(false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [api, performAccountRefresh]);

  /**
   * 已登录但库存结果仍是公开模式（例如上一次运行时还没登录）：
   * 提示一次并自动用 force=false 补跑一次推荐。
   */
  useEffect(() => {
    if (!api || !data) return;
    if (!data.account.loggedIn) return;
    if (data.daily?.mode !== 'public') return;
    if (loginRerunRef.current) return;
    loginRerunRef.current = true;
    showToast('info', '检测到已登录，正在重新生成个性化推荐…');
    void startRun(false);
  }, [api, data, showToast, startRun]);

  /* 周报 ------------------------------------------------------------ */

  const loadWeeklyReport = useCallback(async (weekKey?: string): Promise<void> => {
    const instance = apiRef.current ?? (await getApi());
    apiRef.current = instance;
    const seq = ++weeklySeqRef.current;
    setWeeklyLoading(true);
    setWeeklyError(null);
    try {
      const response = await instance.getWeeklyReport(weekKey);
      if (seq === weeklySeqRef.current) setWeekly(response);
    } catch (err) {
      if (seq === weeklySeqRef.current) setWeeklyError(errorMessage(err));
    } finally {
      if (seq === weeklySeqRef.current) setWeeklyLoading(false);
    }
  }, []);

  const generateWeekly = useCallback(async (): Promise<void> => {
    const instance = apiRef.current;
    if (!instance) return;
    if (!dataRef.current?.account.loggedIn) {
      showToast('info', '请先在浏览器登录 B站，再生成周报');
      return;
    }
    const started = await startRun(false);
    if (!started) return;
    showToast('info', '已开始更新，完成后会自动刷新周报…');
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const status = await instance.getStatus();
        setStatus(status);
        setData((prev) => (prev ? { ...prev, status } : prev));
        if (!status.running) break;
      } catch {
        break;
      }
    }
    await loadWeeklyReport();
  }, [loadWeeklyReport, showToast, startRun]);

  /* 备份 ------------------------------------------------------------ */

  const exportBackup = useCallback(async (): Promise<ExportBackupResult | null> => {
    const instance = apiRef.current;
    if (!instance) return null;
    try {
      return await instance.exportBackup();
    } catch (err) {
      showToast('error', `导出备份失败：${errorMessage(err)}`);
      return null;
    }
  }, [showToast]);

  const importBackup = useCallback(
    async (json: string): Promise<ImportSummary | null> => {
      const instance = apiRef.current;
      if (!instance) return null;
      setBusy(true);
      try {
        const summary = await instance.importBackup(json);
        setWeekly(null);
        const fresh = await instance.getDashboardData();
        acceptData(fresh);
        showToast(
          'success',
          `导入成功：历史 ${summary.history} 条 · 推荐 ${summary.daily} 天 · 周报 ${summary.weekly} 份`,
        );
        return summary;
      } catch (err) {
        showToast('error', `导入失败：${errorMessage(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [acceptData, showToast],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return {
    data,
    status,
    loading,
    error,
    busy,
    apiMode: api?.mode ?? null,
    mockVariant: api?.variant ?? null,
    toasts,
    accountRefreshing,
    weekly,
    weeklyLoading,
    weeklyError,
    runNow,
    retry,
    reload,
    dismiss,
    updateSettings,
    clearData,
    refreshAccount,
    loadWeeklyReport,
    generateWeekly,
    exportBackup,
    importBackup,
    dismissToast,
  };
}
