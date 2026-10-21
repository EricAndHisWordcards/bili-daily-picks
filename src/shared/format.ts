/** 展示用格式化，UI 与推荐理由文案共用。 */

export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100_000_000) return `${trim(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${trim(value / 10_000)}万`;
  return String(Math.round(value));
}

function trim(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

/** 增长角标：+1.2万 / +356 */
export function formatDelta(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return `+${formatCount(value)}`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function formatDateTime(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / N 小时前 / N 天前 / N 周前 / N 月前 / N 年前 */
export function formatRelativeTime(tsMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '';
  const diff = Math.max(0, nowMs - tsMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 截断长标题，保留完整标题在 title 属性里 */
export function truncate(text: string, max = 56): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
