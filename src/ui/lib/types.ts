/**
 * 仪表盘内部使用的类型：只定义 UI 侧关心的接口。
 *
 * 业务数据结构全部来自 `src/shared/types.ts`，这里不重复定义。
 */
import type {
  AccountInfo,
  DashboardData,
  ImportSummary,
  RunStatus,
  Settings,
  WeeklyReportResponse,
} from '../../shared/types';

/**
 * 离线演示数据的场景开关（?mock=...）。
 * fallback：normal 数据 + 收藏夹走「扫描全部收藏夹最近收藏」兼容路径。
 */
export type MockVariant =
  | 'normal'
  | 'loggedout'
  | 'empty'
  | 'error'
  | 'degraded'
  | 'fallback';

/** 后台 EXPORT_BACKUP 返回体（与 extension 约定，shared 未定义） */
export interface ExportBackupResult {
  filename: string;
  json: string;
  /** JSON 字符串字节数 */
  bytes: number;
}

/**
 * UI 数据层接口。
 *
 * 真实环境走 `chrome.runtime.sendMessage`；`?mock=1` 或非扩展环境（本地静态预览）走
 * `mock.ts` 的离线演示实现。页面只依赖这个接口，不关心消息协议细节。
 */
export interface UiApi {
  readonly mode: 'extension' | 'mock';
  readonly variant: MockVariant | null;
  /** 一次取全量数据（后台 GET_DASHBOARD_DATA） */
  getDashboardData(): Promise<DashboardData>;
  /** 轮询运行状态（后台 GET_STATUS） */
  getStatus(): Promise<RunStatus>;
  /** 立即更新（后台 RUN_NOW） */
  runNow(force?: boolean): Promise<RunStatus>;
  /** 不感兴趣（后台 DISMISS） */
  dismiss(bvid: string): Promise<void>;
  /** 保存部分设置（后台 SET_SETTINGS），返回合并后的设置 */
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  /** 清空本机全部数据（后台 CLEAR_DATA） */
  clearData(): Promise<void>;
  /** 重新检测登录状态（后台 REFRESH_ACCOUNT） */
  refreshAccount(): Promise<AccountInfo>;
  /** 周报：默认最近一份，传 weekKey 读取指定周；返回 {report, reports} */
  getWeeklyReport(weekKey?: string): Promise<WeeklyReportResponse>;
  /** 导出全部本地数据（后台 EXPORT_BACKUP） */
  exportBackup(): Promise<ExportBackupResult>;
  /** 导入备份 JSON（后台 IMPORT_BACKUP），失败会抛错 */
  importBackup(json: string): Promise<ImportSummary>;
}

/** 六个页面：周报插在增长榜与我的标签之间 */
export const PAGE_IDS = [
  'today',
  'sections',
  'growth',
  'weekly',
  'tags',
  'settings',
] as const;
export type PageId = (typeof PAGE_IDS)[number];

export const PAGE_META: Record<PageId, { label: string; title: string }> = {
  today: { label: '今日必看', title: '今日必看' },
  sections: { label: '分区精选', title: '分区精选' },
  growth: { label: '增长榜', title: '增长榜' },
  weekly: { label: '周报', title: '周报' },
  tags: { label: '我的标签', title: '我的标签' },
  settings: { label: '设置', title: '设置' },
};

export type ToastKind = 'success' | 'info' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
