/**
 * 共享类型契约。
 *
 * engine（数据/算法）、ui（仪表盘）、extension（后台/内容脚本）三方只依赖本文件与
 * `constants.ts`。不要在别处重复定义这些结构。
 */

/* ------------------------------------------------------------------ */
/* 视频与来源                                                          */
/* ------------------------------------------------------------------ */

export type SourceKind =
  | 'popular' // 热门
  | 'ranking' // 全站排行榜
  | 'regionRanking' // 分区排行榜
  | 'weekly' // 每周必看
  | 'rcmd' // 个性化推荐（猜你喜欢）
  | 'related'; // 相关推荐

export interface SourceRef {
  kind: SourceKind;
  /** 榜单名次（从 1 开始），仅 ranking/regionRanking/weekly 有 */
  rank?: number;
  /** 每周必看期号 */
  issue?: number;
  /** 分区排行榜的父分区 rid */
  rid?: number;
  /** 分区名，用于展示 */
  regionName?: string;
}

export interface VideoStat {
  view: number;
  like: number;
  favorite: number;
  coin: number;
  reply: number;
  danmaku: number;
  share: number;
}

export interface Owner {
  mid: number;
  name: string;
  face?: string;
}

export interface Candidate {
  bvid: string;
  aid?: number;
  cid?: number;
  title: string;
  cover: string;
  /** 秒 */
  duration: number;
  /** 秒级时间戳 */
  pubdate: number;
  tid?: number;
  /** 叶子分区名，如「手机游戏」 */
  tname: string;
  /** 一级分区名，如「游戏」 */
  parentRegion: string;
  owner: Owner;
  stat: VideoStat;
  sources: SourceRef[];
  rcmdReason?: string | null;
  isFollowed?: boolean;
  /** 由 /x/tag/archive/tags 补充，最多缓存 7 天 */
  tags?: string[];
}

/* ------------------------------------------------------------------ */
/* 历史记录                                                            */
/* ------------------------------------------------------------------ */

export interface HistoryRecord {
  bvid: string;
  title: string;
  cover?: string;
  /** 观看时间（秒级时间戳） */
  viewedAt: number;
  /** 视频总时长（秒），未知为 0 */
  duration: number;
  /** 观看进度（秒） */
  progress: number;
  /** 叶子分区名 */
  tname: string;
  parentRegion: string;
  authorMid?: number;
  authorName?: string;
  isFav?: boolean;
}

/* ------------------------------------------------------------------ */
/* 用户画像                                                            */
/* ------------------------------------------------------------------ */

export interface AffinityRow {
  name: string;
  /** 0..1 */
  affinity: number;
  count: number;
}

export interface TagRow {
  term: string;
  /** 归一化后的权重，0..1 */
  weight: number;
  count: number;
  kind: 'title' | 'tag' | 'region';
}

export interface UpRow {
  mid: number;
  name: string;
  affinity: number;
  count: number;
}

/** 当前 B站账号状态（只读，不接触 cookie/密码） */
export interface AccountInfo {
  loggedIn: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  /** 检测时间（毫秒） */
  checkedAt: number;
  /** 网络/风控等异常时的可读说明 */
  error?: string;
  /** 最近一次成功登录过的账号，用于登录失效提示 */
  last?: { mid?: number; uname?: string; face?: string; at: number };
}

export interface Profile {
  mid?: number;
  uname?: string;
  avatar?: string;
  generatedAt: number;
  sample: {
    total: number;
    last7d: number;
    /** 采集窗口天数 */
    windowDays: number;
  };
  regions: AffinityRow[];
  tags: TagRow[];
  ups: UpRow[];
  /** 24 维观看时段直方图（0..1 归一化） */
  hours: number[];
  /** 0..1，有进度信息的样本的平均完播率 */
  completionRate: number;
  /** 秒，历史样本的平均时长 */
  avgDuration: number;
  preferredDuration: { p10: number; p90: number };
  /** 收藏/关注/稍后再看等只读信号（v0.2.0 新增，旧画像可能没有） */
  signals?: ProfileSignals;
}

/** 画像里的只读兴趣信号（归一化后的展示结构） */
export interface ProfileSignals {
  fetchedAt: number;
  favoriteFolders: number;
  favoriteCount: number;
  favoriteSampled: number;
  favoriteUps: UpRow[];
  favoriteTags: TagRow[];
  followedTotal: number;
  followedMids: number[];
  followedUps: UpRow[];
  watchLaterCount: number;
  watchLaterSampled: number;
  watchLaterRegions: AffinityRow[];
  watchLaterTags: TagRow[];
  /** type=1（全部收藏夹）不可用时走了逐文件夹兼容路径 */
  favoriteFallback?: boolean;
}

/** 流水线 signals 阶段产出的原始聚合（持久化在 PipelineState） */
export interface InterestSignals {
  fetchedAt: number;
  mid: number;
  favoriteFolders: number;
  favoriteCount: number;
  favoriteSampled: number;
  favoriteUps: Array<{ mid: number; name: string; count: number }>;
  favoriteTags: Array<{ term: string; weight: number; count: number }>;
  followedTotal: number;
  followed: Array<{ mid: number; name: string; face?: string }>;
  watchLaterCount: number;
  watchLaterSampled: number;
  watchLaterRegions: Array<{ name: string; weight: number; count: number }>;
  watchLaterTags: Array<{ term: string; weight: number; count: number }>;
  favoriteFallback?: boolean;
}

/* ------------------------------------------------------------------ */
/* 推荐结果                                                            */
/* ------------------------------------------------------------------ */

export interface GrowthInfo {
  /** 观测窗口小时数 */
  hours: number;
  /** 窗口内新增播放 */
  view: number;
  /** 窗口内新增收藏 */
  favorite: number;
  /** 窗口内新增评论 */
  reply: number;
  /** true 表示用「发布以来日均」估算，不是实测增量 */
  estimated: boolean;
}

export interface Recommendation {
  bvid: string;
  title: string;
  cover: string;
  duration: number;
  pubdate: number;
  owner: Owner;
  stat: VideoStat;
  tname: string;
  parentRegion: string;
  /** 0..1 综合分 */
  score: number;
  sources: SourceRef[];
  reason: string;
  badges: string[];
  growth?: GrowthInfo | null;
}

export type SectionKind = 'global' | 'region' | 'growth' | 'weekly';

export interface Section {
  id: string;
  title: string;
  subtitle?: string;
  kind: SectionKind;
  items: Recommendation[];
}

export interface RunMeta {
  candidates: number;
  requests: number;
  durationMs: number;
  /** 有降级时的人类可读说明，例如「风控冷却，使用缓存」 */
  degraded?: string;
  sources: SourceKind[];
}

export interface DailyResult {
  /** 本地日期 YYYY-MM-DD（Asia/Shanghai 由浏览器本地时区决定） */
  date: string;
  generatedAt: number;
  mid?: number;
  mode: 'full' | 'public';
  sections: Section[];
  profileSummary: {
    topRegions: AffinityRow[];
    topTags: TagRow[];
  };
  meta: RunMeta;
}

/* ------------------------------------------------------------------ */
/* 周报                                                                */
/* ------------------------------------------------------------------ */

export type TrendDirection = 'new' | 'up' | 'down' | 'gone' | 'steady';

/** 周报：每个自然周一份，在周一的每日更新后生成并入库 */
export interface WeeklyReport {
  /** 周一日期 YYYY-MM-DD，也是 IndexedDB 主键 */
  weekKey: string;
  weekStart: number;
  /** 下周一 00:00，不含 */
  weekEnd: number;
  label: string;
  generatedAt: number;
  stats: { watched: number; watchSeconds: number; activeDays: number; completionRate: number };
  previous: {
    watched: number;
    watchSeconds: number;
    activeDays: number;
    completionRate: number;
  };
  daily: Array<{ date: string; weekday: string; watched: number; watchSeconds: number }>;
  tags: Array<{
    term: string;
    weight: number;
    previousWeight: number;
    delta: number;
    count: number;
    previousCount: number;
    status: TrendDirection;
  }>;
  rising: Array<{ term: string; delta: number; weight: number }>;
  falling: Array<{ term: string; delta: number; weight: number }>;
  regions: Array<{
    name: string;
    weight: number;
    previousWeight: number;
    delta: number;
    count: number;
    previousCount: number;
    status: TrendDirection;
  }>;
  ups: Array<{ mid: number; name: string; count: number; previousCount: number; delta: number }>;
  summary: string[];
  sample: { currentTotal: number; previousTotal: number };
}

export interface WeeklyReportMeta {
  weekKey: string;
  label: string;
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export interface Settings {
  /** 每个分区板块的视频数量 2..5 */
  perSection: number;
  autoUpdate: boolean;
  /** 本地时间整点 0..23，默认 4 */
  updateHour: number;
  enabledSources: Record<SourceKind, boolean>;
  showFloatingButton: boolean;
  theme: 'auto' | 'light' | 'dark';
  /** 分区板块数量 2..5 */
  regionSections: number;
  /** 标签页统计窗口 */
  tagWindow: '7d' | '30d' | 'all';
}

/* ------------------------------------------------------------------ */
/* 流水线与状态                                                        */
/* ------------------------------------------------------------------ */

export type PipelineStage =
  | 'auth'
  | 'signals'
  | 'history'
  | 'candidates'
  | 'enrich'
  | 'score'
  | 'done'
  | 'error';

export interface PipelineState {
  runId: string;
  startedAt: number;
  updatedAt: number;
  stage: PipelineStage;
  /** 计划触发时间，用于判断每日是否已跑过 */
  dueAt: number;
  force: boolean;
  mode: 'full' | 'public';
  /** auth 阶段产出 */
  mid?: number;
  uname?: string;
  /** signals 阶段产出（收藏/关注/稍后再看） */
  signals?: InterestSignals | null;
  /** history 阶段进度 */
  historyPages: number;
  historyCursor: { max: number; viewAt: number } | null;
  history: HistoryRecord[];
  /** candidates / enrich / score 阶段共享 */
  candidates: Candidate[];
  sourceIndex: number;
  enrichIndex: number;
  requests: number;
  error?: string;
}

export interface RunStatus {
  running: boolean;
  stage: PipelineStage | 'idle';
  /** 0..1 */
  progress: number;
  startedAt?: number;
  lastRunAt?: number;
  lastError?: string;
  requestCount?: number;
  nextDueAt?: number;
  /** 未登录时为 true */
  loggedOut?: boolean;
}

/* ------------------------------------------------------------------ */
/* 存储行                                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotRow {
  bvid: string;
  /** 秒级时间戳 */
  ts: number;
  stat: VideoStat;
}

export interface DismissEntry {
  bvid: string;
  at: number;
}

export interface StoredDaily extends DailyResult {
  /** 主键：YYYY-MM-DD */
  id: string;
}

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

export interface BackupData {
  settings: Settings;
  history: HistoryRecord[];
  snapshots: SnapshotRow[];
  daily: DailyResult[];
  profile: Profile | null;
  dismissed: DismissEntry[];
  /** v0.2.0 新增；旧备份可缺省 */
  weeklyReports?: WeeklyReport[];
}

export interface BackupFile {
  app: 'bili-daily-picks';
  schemaVersion: 1;
  appVersion: string;
  exportedAt: number;
  data: BackupData;
}

export interface ImportSummary {
  history: number;
  snapshots: number;
  daily: number;
  dismissed: number;
  weekly: number;
  hasProfile: boolean;
  dropped: number;
}

/* ------------------------------------------------------------------ */
/* 扩展消息协议                                                        */
/* ------------------------------------------------------------------ */

export interface DashboardData {
  daily: DailyResult | null;
  profile: Profile | null;
  status: RunStatus;
  settings: Settings;
  dismissed: string[];
  account: AccountInfo;
}

export interface WeeklyReportResponse {
  report: WeeklyReport | null;
  reports: WeeklyReportMeta[];
}

export type BgRequest =
  | { type: 'GET_DASHBOARD_DATA' }
  | { type: 'GET_DAILY' }
  | { type: 'GET_PROFILE' }
  | { type: 'GET_STATUS' }
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_WEEKLY_REPORT'; weekKey?: string }
  | { type: 'REFRESH_ACCOUNT' }
  | { type: 'EXPORT_BACKUP' }
  | { type: 'IMPORT_BACKUP'; json: string }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'RUN_NOW'; force?: boolean }
  | { type: 'CLEAR_DATA' }
  | { type: 'DISMISS'; bvid: string }
  | { type: 'OPEN_DASHBOARD' };

export interface BgResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/* 后台 -> B站标签页内容脚本 */
export interface ApiFetchRequest {
  type: 'API_FETCH';
  url: string;
}

export interface ApiFetchResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}
