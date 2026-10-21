import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../../../src/shared/format';

const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);

describe('shared/format 相对时间', () => {
  it('刚刚 / 分钟 / 小时', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 小时前');
  });

  it('天 / 周 / 月 / 年', () => {
    expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 天前');
    expect(formatRelativeTime(NOW - 10 * 86_400_000, NOW)).toBe('1 周前');
    expect(formatRelativeTime(NOW - 40 * 86_400_000, NOW)).toBe('1 月前');
    expect(formatRelativeTime(NOW - 400 * 86_400_000, NOW)).toBe('1 年前');
  });

  it('非法/未来时间不产生负数', () => {
    expect(formatRelativeTime(0, NOW)).toBe('');
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('');
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('刚刚');
  });
});
