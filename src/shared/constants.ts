import type { Settings, SourceKind, VideoStat } from './types';

/** 扩展名，同时用于日志前缀 */
export const APP_NAME = 'B站每日必看';

export const DASHBOARD_PAGE = 'dashboard.html';

export const EMPTY_STAT: VideoStat = {
  view: 0,
  like: 0,
  favorite: 0,
  coin: 0,
  reply: 0,
  danmaku: 0,
  share: 0,
};

/* ------------------------------------------------------------------ */
/* B站接口                                                             */
/* ------------------------------------------------------------------ */

export const BILI_ORIGIN = 'https://api.bilibili.com';
export const BILI_WEB_ORIGIN = 'https://www.bilibili.com';

/** 历史记录分页 */
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_PAGES = 30;
export const HISTORY_WINDOW_DAYS = 90;

/** 缓存 TTL（毫秒） */
export const TTL = {
  nav: 12 * 60 * 60 * 1000,
  wbi: 12 * 60 * 60 * 1000,
  stat: 6 * 60 * 60 * 1000,
  tags: 7 * 24 * 60 * 60 * 1000,
  candidates: 30 * 60 * 1000,
} as const;

/** 数据保留（天） */
export const RETENTION_DAYS = {
  history: 90,
  snapshots: 30,
  daily: 60,
} as const;

/** 请求限流 */
export const RATE_LIMIT = {
  maxConcurrent: 2,
  minGapMs: 250,
  timeoutMs: 15000,
  retries: 2,
  backoffMs: [1000, 3000, 8000],
  /** -352/-412 后冷却 */
  cooldownMs: 10 * 60 * 1000,
} as const;

/** 单次全量运行的请求预算，超过后降级为使用已有候选 */
export const REQUEST_BUDGET = 140;

/* ------------------------------------------------------------------ */
/* 分区                                                                */
/* ------------------------------------------------------------------ */

/** 实测可用的 16 个一级分区排行榜；番剧 13 / 国创 167 / 资讯 202 返回 -400 */
export const PARENT_REGIONS: ReadonlyArray<{ rid: number; name: string }> = [
  { rid: 1, name: '动画' },
  { rid: 3, name: '音乐' },
  { rid: 4, name: '游戏' },
  { rid: 5, name: '娱乐' },
  { rid: 36, name: '知识' },
  { rid: 119, name: '鬼畜' },
  { rid: 129, name: '舞蹈' },
  { rid: 155, name: '时尚' },
  { rid: 160, name: '生活' },
  { rid: 177, name: '纪录片' },
  { rid: 181, name: '影视' },
  { rid: 188, name: '科技' },
  { rid: 211, name: '美食' },
  { rid: 217, name: '动物圈' },
  { rid: 223, name: '汽车' },
  { rid: 234, name: '运动' },
];

/** 一级分区名集合，用于校验映射结果 */
export const PARENT_REGION_NAMES: ReadonlySet<string> = new Set([
  ...PARENT_REGIONS.map((r) => r.name),
  '番剧',
  '国创',
  '资讯',
  '其他',
]);

/** 来源展示名 */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  popular: '热门',
  ranking: '排行榜',
  regionRanking: '分区榜',
  weekly: '每周必看',
  rcmd: '猜你喜欢',
  related: '相关推荐',
};

/* ------------------------------------------------------------------ */
/* 默认设置                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: Settings = {
  perSection: 3,
  autoUpdate: true,
  updateHour: 4,
  enabledSources: {
    popular: true,
    ranking: true,
    regionRanking: true,
    weekly: true,
    rcmd: true,
    related: true,
  },
  showFloatingButton: true,
  theme: 'auto',
  regionSections: 5,
  tagWindow: '7d',
};

/** 打分权重（可在设置中微调，保留默认值用于测试） */
export const SCORE_WEIGHTS = {
  interest: 0.35,
  quality: 0.25,
  growth: 0.2,
  curation: 0.12,
  freshness: 0.08,
} as const;

/** 惩罚项（同板块同 UP 的去重是 sections 层的硬约束，不在打分里扣分） */
export const PENALTIES = {
  pickedWithin2Days: 0.2,
  pickedWithin7Days: 0.08,
  durationOutOfRange: 0.05,
} as const;

/** 进入分区板块的最低分 */
export const SECTION_MIN_SCORE = 0.62;

/** 排名奖励：rank 1 -> 0.8，rank 100 -> 0 */
export function rankingBonus(rank: number | undefined, total = 100): number {
  if (!rank || rank < 1) return 0;
  return Math.max(0, 0.8 * (1 - (rank - 1) / Math.max(1, total - 1)));
}

/* ------------------------------------------------------------------ */
/* 只读兴趣信号（收藏/关注/稍后再看）                                  */
/* ------------------------------------------------------------------ */

export const SIGNAL_CONFIG = {
  /** 收藏：全部收藏夹按 mtime 排，最多翻 3 页 */
  favoritePages: 3,
  favoritePageSize: 20,
  favoriteMaxItems: 60,
  /** type=1 不可用时，最多扫描的收藏夹数 / 每夹最多页数 / 总请求上限 */
  fallbackMaxFolders: 40,
  fallbackPagesPerFolder: 3,
  fallbackMaxRequests: 60,
  /** 收藏夹列表兜底：分页接口每页数量与最多页数 */
  folderPageSize: 20,
  folderMaxPages: 5,
  /** 关注：最多 2 页 × 50 */
  followingPages: 2,
  followingPageSize: 50,
  followingMaxItems: 100,
  /** 稍后再看一页 */
  watchLaterPageSize: 20,
  /** 信号缓存 */
  cacheTtlMs: 12 * 60 * 60 * 1000,
} as const;

/** 信号并入画像时的权重（与历史权重相加后再归一化） */
export const SIGNAL_WEIGHTS = {
  favoriteUp: 1.5,
  followedUp: 3.0,
  favoriteTag: 1.5,
  watchLaterRegion: 1.2,
  watchLaterTag: 1.2,
} as const;

/* ------------------------------------------------------------------ */
/* 周报                                                                */
/* ------------------------------------------------------------------ */

export const WEEKLY_CONFIG = {
  /** 保留最近多少份周报 */
  keepReports: 12,
  /** 标签展示 Top N */
  tagLimit: 12,
  /** 分区/UP 展示 Top N */
  regionLimit: 6,
  upLimit: 6,
  /** 涨跌阈值（归一化权重） */
  tagDelta: 0.15,
  regionDelta: 0.1,
  /** 上升/下降榜条数 */
  moverLimit: 5,
} as const;

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

export const BACKUP_APP = 'bili-daily-picks';
export const BACKUP_SCHEMA_VERSION = 1;

export const BACKUP_LIMITS = {
  /** JSON 字符串最大体积（字节） */
  jsonBytes: 20 * 1024 * 1024,
  history: 5000,
  snapshots: 300000,
  daily: 120,
  dismissed: 5000,
  weekly: 12,
} as const;

/* ------------------------------------------------------------------ */
/* 版本与权限                                                          */
/* ------------------------------------------------------------------ */

/** Chromium 最低版本 */
export const MIN_CHROME_VERSION = 120;
