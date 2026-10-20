/**
 * 池内百分位与数值小工具。
 *
 * 打分使用「同一批候选内的相对位置」而不是绝对阈值，这样不同日期、不同候选池的
 * 分数具有可比性（quality/growth 都基于百分位）。
 */

/** 数值工具：限制到 0..1 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 四舍五入到指定小数位 */
export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 平均值；空数组返回 0 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 升序数组中第一个 >= value 的下标（二分） */
function lowerBound(sortedAsc: number[], value: number): number {
  let low = 0;
  let high = sortedAsc.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const current = sortedAsc[mid]!;
    if (current < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 构造百分位函数：输入数值，输出该值在数据集中的 0..1 百分位。
 * - 越大越靠近 1
 * - 并列值取平均名次
 * - 只有一个数据时返回 1
 */
export function buildPercentile(values: number[]): (value: number) => number {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return () => 0;
  if (count === 1) return () => 1;

  const cache = new Map<number, number>();
  const compute = (value: number): number => {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const first = lowerBound(sorted, value);
    if (first >= count || sorted[first] !== value) {
      // 不在数据集里：按插入位置给出近似值
      const approx = count === 1 ? 1 : clamp01(first / (count - 1));
      cache.set(value, approx);
      return approx;
    }
    let last = first;
    while (last + 1 < count && sorted[last + 1] === value) last += 1;
    const midRank = (first + last) / 2;
    const percentile = count === 1 ? 1 : clamp01(midRank / (count - 1));
    cache.set(value, percentile);
    return percentile;
  };
  return compute;
}

/** 单值百分位（便捷函数，批量计算请用 buildPercentile） */
export function percentileOf(values: number[], value: number): number {
  return buildPercentile(values)(value);
}
