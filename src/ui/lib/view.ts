/**
 * 视图辅助：封面地址、B 站链接、阶段文案、相对时间等纯函数。
 * 不依赖 React，可单独复用。
 */
import type {
  GrowthInfo,
  PipelineStage,
  RunStatus,
  SourceKind,
  SourceRef,
  TrendDirection,
} from '../../shared/types';
import { BILI_WEB_ORIGIN, SOURCE_LABELS } from '../../shared/constants';
import { formatCount, formatDelta } from '../../shared/format';
import { formatDuration } from '../../shared/time';

/** B站登录页（登录成功后回到 B站首页） */
export const BILI_PASSPORT_LOGIN_URL =
  'https://passport.bilibili.com/login?gourl=https%3A%2F%2Fwww.bilibili.com%2F';

/** B站图片裁剪参数：672×378 的 16:9 封面，一张 WEBP 搞定列表展示 */
export const COVER_SUFFIX = '@672w_378h_1c.webp';

/** 把接口里的 http/协议相对地址统一成 https，并补上封面裁剪参数 */
export function toCoverUrl(pic: string | null | undefined): string | null {
  if (!pic) return null;
  let url = pic.trim();
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('http://')) url = `https://${url.slice(7)}`;
  else if (!/^https?:\/\//i.test(url)) return null;
  return url.includes('@') ? url : `${url}${COVER_SUFFIX}`;
}

/** 头像等其它图片只需要升级协议 */
export function toHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const value = url.trim();
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('http://')) return `https://${value.slice(7)}`;
  return /^https?:\/\//i.test(value) ? value : null;
}

export function toVideoUrl(bvid: string): string {
  return `${BILI_WEB_ORIGIN}/video/${encodeURIComponent(bvid)}`;
}

/** 新标签打开 B 站视频页（仪表盘本身不跳转） */
export function openVideo(bvid: string): void {
  window.open(toVideoUrl(bvid), '_blank', 'noopener,noreferrer');
}

export function openBilibili(): void {
  window.open(`${BILI_WEB_ORIGIN}/`, '_blank', 'noopener,noreferrer');
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

export const STAGE_LABELS: Record<PipelineStage | 'idle', string> = {
  idle: '等待更新',
  auth: '验证账号',
  signals: '读取兴趣信号',
  history: '读取观看历史',
  candidates: '汇总候选视频',
  enrich: '补全视频信息',
  score: '计算推荐结果',
  done: '更新完成',
  error: '更新失败',
};

export const STAGE_ORDER: PipelineStage[] = [
  'auth',
  'signals',
  'history',
  'candidates',
  'enrich',
  'score',
];

export function stageLabel(stage: PipelineStage | 'idle' | undefined): string {
  return stage ? STAGE_LABELS[stage] ?? '更新中' : '更新中';
}

export function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatDateText(tsMs: number = Date.now()): string {
  const d = new Date(tsMs);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAYS[d.getDay()]}`;
}

/** 未来时间的人类可读文案：23 分钟后 / 3 小时后 / 明天 04:00 / 10-21 04:00 */
export function formatFuture(tsMs: number, nowMs: number = Date.now()): string {
  const diff = tsMs - nowMs;
  if (diff <= 0) return '即将开始';
  const minute = 60 * 1000;
  if (diff < minute) return '不到 1 分钟后';
  if (diff < 60 * minute) return `${Math.round(diff / minute)} 分钟后`;
  if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} 小时后`;
  const d = new Date(tsMs);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
}

/** 下次自动更新的时间点（settings.updateHour 触发，今天是过去则顺延到明天） */
export function nextUpdateAt(hour: number, nowMs: number = Date.now()): number {
  const next = new Date(nowMs);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/* ------------------------------------------------------------------ */
/* 来源与增长                                                          */
/* ------------------------------------------------------------------ */

const SOURCE_PRIORITY: SourceKind[] = ['weekly', 'ranking', 'regionRanking', 'popular', 'rcmd', 'related'];

export function primarySource(sources: SourceRef[] | undefined): SourceRef {
  if (!sources || sources.length === 0) return { kind: 'popular' };
  for (const kind of SOURCE_PRIORITY) {
    const found = sources.find((s) => s.kind === kind);
    if (found) return found;
  }
  return sources[0]!;
}

/** 来源角标文案：排行榜 #12 / 每周必看 · 第 395 期 / 热门 */
export function sourceChipText(source: SourceRef): string {
  switch (source.kind) {
    case 'weekly':
      return source.issue ? `每周必看 · 第 ${source.issue} 期` : '每周必看';
    case 'ranking':
      return source.rank ? `排行榜 #${source.rank}` : '排行榜';
    case 'regionRanking':
      return source.rank ? `分区榜 #${source.rank}` : '分区榜';
    case 'popular':
      return '热门';
    case 'rcmd':
      return '猜你喜欢';
    case 'related':
      return '相关推荐';
    default:
      return SOURCE_LABELS[source.kind] ?? '推荐';
  }
}

/** 增长角标：实测显示窗口增量，估算显示日均 */
export function growthBadgeText(growth: GrowthInfo): string {
  if (growth.estimated) return `估算 ${formatDelta(growth.view)}/日`;
  return `${formatDelta(growth.view)} · ${Math.round(growth.hours)}h`;
}

export function growthBadgeTitle(growth: GrowthInfo): string {
  const parts = [
    `新增播放 ${formatDelta(growth.view)}`,
    `收藏 ${formatDelta(growth.favorite)}`,
    `评论 ${formatDelta(growth.reply)}`,
  ];
  return growth.estimated
    ? `按发布以来日均估算（${growth.hours}h 窗口）：${parts.join('，')}`
    : `实测 ${Math.round(growth.hours)} 小时增量：${parts.join('，')}`;
}

/** 增长排序分：统一折算成「每小时播放增量」，实测与估算可一起比较 */
export function growthScore(growth: GrowthInfo | null | undefined): number {
  if (!growth) return 0;
  return growth.view / Math.max(1, growth.hours);
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '未知错误';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function percent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

export function formatEnglishNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value));
}

/** 时长 + 播放量组合，用于紧凑展示 */
export function videoMetaText(duration: number, view: number): string {
  return `${formatDuration(duration)} · ${formatCount(view)} 播放`;
}

/** 把 0..1 的进度变成百分比字符串 */
export function progressPercent(progress: number): string {
  return `${Math.round(clamp01(progress) * 100)}%`;
}

export function isRunningStatus(status: RunStatus | null | undefined): boolean {
  return Boolean(status?.running);
}

/* ------------------------------------------------------------------ */
/* 周报 / 账号 / 备份文案                                              */
/* ------------------------------------------------------------------ */

/** 观看时长：45 分钟 / 3 小时 20 分 / 1 小时 */
export function formatWatchSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${Math.max(1, minutes)} 分钟`;
}

/** 文件体积：1.2MB / 356KB / 820B */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes)}B`;
}

/** 周报涨跌状态的展示文案 */
export function trendLabel(status: TrendDirection): string {
  switch (status) {
    case 'new':
      return '新晋';
    case 'up':
      return '上升';
    case 'down':
      return '下降';
    case 'gone':
      return '消失';
    case 'steady':
    default:
      return '持平';
  }
}

/** 归一化权重差 → 百分比点文案：+23% / -12% / 0% */
export function trendDeltaText(delta: number): string {
  const points = Math.round(delta * 100);
  if (points > 0) return `+${points}%`;
  if (points < 0) return `${points}%`;
  return '0%';
}

/** 数字增减：+12 / -3 / 0 */
export function signedNumber(delta: number): string {
  const rounded = Math.round(delta);
  if (rounded > 0) return `+${rounded}`;
  return String(rounded);
}

/** 百分比点增减：+5.2% / -1.4% / 0% */
export function signedPercentPoints(delta: number): string {
  const points = Math.round(delta * 1000) / 10;
  if (points > 0) return `+${points}%`;
  if (points < 0) return `${points}%`;
  return '0%';
}

/** 相对量变化：+18% / -7% / --（previous 为 0 时） */
export function relativeChange(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? '新增' : '--';
  const value = ((current - previous) / previous) * 100;
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded}%`;
  return `${rounded}%`;
}
