/** 时间工具：全部使用本地时区（扩展运行在用户浏览器里，默认中国大陆）。 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 本地日期键 YYYY-MM-DD */
export function dateKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天本地时间 hour:00 的时间戳（毫秒） */
export function todayAtHour(hour: number, ts: number = Date.now()): number {
  const d = new Date(ts);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function endOfLocalDay(ts: number = Date.now()): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function daysBetween(tsA: number, tsB: number): number {
  return Math.abs(tsA - tsB) / DAY;
}

export function ageDays(pubdateSec: number, nowMs: number = Date.now()): number {
  return Math.max(0, nowMs / 1000 - pubdateSec) / 86400;
}

/** 人类可读的「x 分钟前」 */
export function relativeTime(tsMs: number, nowMs: number = Date.now()): string {
  const diff = nowMs - tsMs;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return dateKey(tsMs);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
