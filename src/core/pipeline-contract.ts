/**
 * 流水线契约：engine 实现 `createPipeline`，extension 只依赖这里定义的接口。
 *
 * 这样后台/内容脚本不需要知道推荐算法细节，engine 也不需要知道 Chrome 消息协议。
 */
import type { BiliApi } from './api/endpoints';
import type { HttpClient } from './api/http';
import type { Repository } from './store/repository';
import type { SettingsStore } from './store/settings';
import type {
  AccountInfo,
  BackupData,
  DashboardData,
  DailyResult,
  ImportSummary,
  RunStatus,
  WeeklyReport,
  WeeklyReportMeta,
} from '../shared/types';

export interface PipelineDeps {
  repo: Repository;
  settings: SettingsStore;
  api: BiliApi;
  http: HttpClient;
  /** 便于测试注入固定时间 */
  now?: () => number;
  logger?: (message: string, extra?: unknown) => void;
}

export interface PipelineController {
  /** 读取当前运行状态（仪表盘轮询用） */
  getStatus(): Promise<RunStatus>;
  /** 仪表盘一次取全量数据 */
  getDashboardData(): Promise<DashboardData>;
  /** 当前缓存的每日结果 */
  getDaily(): Promise<DailyResult | null>;
  /** 当前账号状态；force=true 会绕过 nav 的 60 秒缓存 */
  getAccount(force?: boolean): Promise<AccountInfo>;
  /** 周报：默认最近一份，传 weekKey 读取指定周；同时返回最近 12 份元数据 */
  getWeeklyReport(
    weekKey?: string,
  ): Promise<{ report: WeeklyReport | null; reports: WeeklyReportMeta[] }>;
  /** 导出全部本地数据（设置 + 历史/快照/推荐/画像/拉黑/周报） */
  exportData(): Promise<BackupData>;
  /** 导入备份；调用前必须先通过 parseBackup 校验 */
  importData(data: BackupData): Promise<ImportSummary>;
  /**
   * 推进一小段流水线（后台每分钟调用一次）。
   * 单次最多约 20 秒，状态持久化在 Repository 里，Service Worker 被回收也能续跑。
   */
  tick(): Promise<RunStatus>;
  /** 手动触发：重置为待运行并立刻推进一段，后续由 tick 续跑 */
  runNow(options?: { force?: boolean }): Promise<RunStatus>;
  /** 不感兴趣：加入拉黑列表 */
  dismiss(bvid: string): Promise<void>;
  /** 清空全部本地数据（含设置） */
  clearData(): Promise<void>;
}

export type CreatePipeline = (deps: PipelineDeps) => PipelineController;
