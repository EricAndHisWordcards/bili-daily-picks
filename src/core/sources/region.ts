/**
 * 分区映射：把接口返回的叶子分区名（如「手机游戏」）映射到一级分区名（如「游戏」）。
 *
 * 数据源是 `src/shared/region-seed.json`（由 Phase 0 用真实接口抓取整理），未知分区统一
 * 归入「其他」，避免污染分区偏好统计。排行榜接口按 rid 请求，这里也提供 rid 反查。
 */
import { PARENT_REGIONS } from '../../shared/constants';
import rawSeed from '../../shared/region-seed.json';

/** 未知/无法归类的一级分区名 */
export const UNKNOWN_REGION = '其他';

/** 叶子分区名 -> 一级分区名 */
const REGION_SEED: Record<string, string> = rawSeed as Record<string, string>;

/** 一级分区名 -> rid；用于请求分区排行榜 */
const RID_BY_NAME = new Map<string, number>(PARENT_REGIONS.map((row) => [row.name, row.rid]));

/** rid -> 一级分区名；用于解析分区排行榜来源 */
const NAME_BY_RID = new Map<number, string>(PARENT_REGIONS.map((row) => [row.rid, row.name]));

/** 真正参与「分区板块」的一级分区名（不含番剧/国创/资讯/其他） */
export const SECTION_REGION_NAMES: ReadonlySet<string> = new Set(
  PARENT_REGIONS.map((row) => row.name),
);

/**
 * 解析一级分区名。
 * - 命中 seed：返回映射结果（例如「手机游戏」-> 「游戏」）
 * - 本身就是一级分区名（例如排行榜接口有时给「游戏」）：原样返回
 * - 空值/未知（例如「国产动画」）：返回「其他」
 */
export function resolveParentRegion(tname: string | null | undefined): string {
  const name = (tname ?? '').trim();
  if (!name) return UNKNOWN_REGION;
  const mapped = REGION_SEED[name];
  if (mapped) return mapped;
  if (SECTION_REGION_NAMES.has(name)) return name;
  if (name === UNKNOWN_REGION) return UNKNOWN_REGION;
  return UNKNOWN_REGION;
}

/** 一级分区名 -> rid；不是可用排行榜分区时返回 undefined */
export function regionRidOf(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  return RID_BY_NAME.get(name.trim());
}

/** rid -> 一级分区名 */
export function regionNameOfRid(rid: number | null | undefined): string | undefined {
  if (rid === null || rid === undefined) return undefined;
  return NAME_BY_RID.get(rid);
}

/** 是否是可进入「分区板块」的一级分区（排除「其他」等） */
export function isSectionRegion(name: string): boolean {
  return SECTION_REGION_NAMES.has(name);
}

/** 某个叶子分区名是否可在 seed 里找到一级分区（用于测试与调试） */
export function isKnownLeafRegion(tname: string): boolean {
  return Boolean(REGION_SEED[tname.trim()]);
}

/**
 * 综合解析候选视频的一级分区：优先叶子分区名，其次来源 rid，最后「其他」。
 * `Candidate` 映射与 enrich 阶段共用这个入口，保证口径一致。
 */
export function resolveCandidateRegion(input: {
  tname?: string | null;
  rid?: number;
  regionName?: string | null;
}): string {
  const direct = resolveParentRegion(input.tname);
  if (direct !== UNKNOWN_REGION) return direct;
  const fallback = input.regionName
    ? resolveParentRegion(input.regionName)
    : regionNameOfRid(input.rid);
  return fallback ?? UNKNOWN_REGION;
}
