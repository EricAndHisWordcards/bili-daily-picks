/**
 * 候选补全：/x/web-interface/view 与 /x/tag/archive/tags。
 *
 * 目的：候选来自不同接口，字段完整度不同——
 * - 个性化推荐/相关推荐可能缺 tid、时长、统计、发布时间（用 /view 补，缓存 6 小时）
 * - 标题标签用于兴趣匹配与推荐理由（用 /tags 补，缓存 7 天）
 *
 * 预算：只对候选池前 120 个补 /view（且只在缺 stat/tid/tname 时），前 60 个补 /tags；
 * 失败只降级不抛错，并用 10 分钟负缓存避免反复请求风控接口。
 */
import { TTL } from '../../shared/constants';
import type { Candidate } from '../../shared/types';
import { normalizeStat } from '../../shared/stat';
import type { TagData, ViewData } from '../api/endpoints';
import type { Repository } from '../store/repository';
import { resolveCandidateRegion } from './region';

/** 只依赖 view / tags，便于测试注入桩 */
export interface EnrichApiPort {
  view(bvid: string): Promise<ViewData>;
  tags(bvid: string): Promise<TagData[]>;
}

export const ENRICH_CONFIG = {
  /** 前多少个候选补 /view */
  maxView: 120,
  /** 前多少个候选补 /tags */
  maxTags: 60,
  /** 每个视频最多保留多少个标签 */
  maxTagsPerVideo: 10,
  /** 失败负缓存时长 */
  negativeTtlMs: 10 * 60 * 1000,
} as const;

const VIEW_CACHE_PREFIX = 'enrich:view:';
const TAGS_CACHE_PREFIX = 'enrich:tags:';
const VIEW_FAIL_PREFIX = 'enrich:vfail:';
const TAGS_FAIL_PREFIX = 'enrich:tfail:';

interface CacheRow<T> {
  value: T;
  expiresAt: number;
}

async function readCache<T>(
  repo: Repository,
  key: string,
  nowMs: number,
): Promise<T | undefined> {
  const row = await repo.getKv<CacheRow<T>>(key);
  if (!row) return undefined;
  if (row.expiresAt <= nowMs) {
    await repo.deleteKv(key);
    return undefined;
  }
  return row.value;
}

async function writeCache<T>(
  repo: Repository,
  key: string,
  value: T,
  ttlMs: number,
  nowMs: number,
): Promise<void> {
  const row: CacheRow<T> = { value, expiresAt: nowMs + ttlMs };
  await repo.setKv(key, row);
}

async function isFailureCached(
  repo: Repository,
  key: string,
  nowMs: number,
): Promise<boolean> {
  const row = await repo.getKv<CacheRow<boolean>>(key);
  if (!row) return false;
  if (row.expiresAt <= nowMs) {
    await repo.deleteKv(key);
    return false;
  }
  return row.value === true;
}

/** 该候选是否需要补 /view（统计缺失、tid 缺失或分区名缺失） */
export function needsView(candidate: Candidate): boolean {
  return candidate.stat.view <= 0 || candidate.tid === undefined || !candidate.tname;
}

/** 该候选是否需要补标签 */
export function needsTags(candidate: Candidate): boolean {
  return !candidate.tags || candidate.tags.length === 0;
}

export interface EnrichCandidateInput {
  repo: Repository;
  api: EnrichApiPort;
  /** 当前时间（毫秒），缓存过期判断用，测试可注入 */
  nowMs: number;
  /** 候选在池中的下标（0 开始），决定是否在补全预算内 */
  index: number;
  maxView?: number;
  maxTags?: number;
}

export interface EnrichCandidateResult {
  candidate: Candidate;
  viewRequested: boolean;
  tagsRequested: boolean;
  /** 有降级时的人类可读说明（一次补全最多一条） */
  degraded?: string;
}

/** 把 /view 结果合并进候选 */
export function applyView(candidate: Candidate, view: ViewData): Candidate {
  if (!view) return candidate;
  const tname = (view.tname ?? '').trim() || candidate.tname;
  const parentRegion =
    candidate.parentRegion !== '其他'
      ? candidate.parentRegion
      : resolveCandidateRegion({ tname, rid: undefined, regionName: undefined });
  return {
    ...candidate,
    aid: view.aid ?? candidate.aid,
    cid: view.cid ?? candidate.cid,
    title: candidate.title || (view.title ?? ''),
    cover: candidate.cover || (view.pic ?? ''),
    duration: candidate.duration > 0 ? candidate.duration : (view.duration ?? 0),
    pubdate: candidate.pubdate > 0 ? candidate.pubdate : (view.pubdate ?? 0),
    tid: view.tid ?? candidate.tid,
    tname,
    parentRegion,
    owner: {
      mid: candidate.owner.mid || view.owner?.mid || 0,
      name: candidate.owner.name || view.owner?.name || '',
      face: candidate.owner.face ?? view.owner?.face,
    },
    stat: normalizeStat(view.stat),
  };
}

/** 把 /tags 结果合并进候选 */
export function applyTags(candidate: Candidate, tags: TagData[]): Candidate {
  const names = [...new Set(
    (tags ?? [])
      .map((tag) => (tag.tag_name ?? '').trim())
      .filter((name) => name.length > 0),
  )].slice(0, ENRICH_CONFIG.maxTagsPerVideo);
  if (names.length === 0) return candidate;
  return { ...candidate, tags: names };
}

/**
 * 补全单个候选：按需请求 /view 与 /tags，全部走缓存；失败只返回 degraded 说明。
 * 一次只处理一个候选，便于流水线把 enrichIndex 持久化后续跑。
 */
export async function enrichCandidate(
  candidate: Candidate,
  input: EnrichCandidateInput,
): Promise<EnrichCandidateResult> {
  const maxView = input.maxView ?? ENRICH_CONFIG.maxView;
  const maxTags = input.maxTags ?? ENRICH_CONFIG.maxTags;
  let current = candidate;
  let viewRequested = false;
  let tagsRequested = false;
  let degraded: string | undefined;

  if (input.index < maxView && needsView(current)) {
    const cacheKey = `${VIEW_CACHE_PREFIX}${current.bvid}`;
    const cached = await readCache<ViewData>(input.repo, cacheKey, input.nowMs);
    if (cached) {
      current = applyView(current, cached);
    } else if (!(await isFailureCached(input.repo, `${VIEW_FAIL_PREFIX}${current.bvid}`, input.nowMs))) {
      try {
        const view = await input.api.view(current.bvid);
        viewRequested = true;
        await writeCache(input.repo, cacheKey, view, TTL.stat, input.nowMs);
        current = applyView(current, view);
      } catch (error) {
        viewRequested = true;
        await writeCache(
          input.repo,
          `${VIEW_FAIL_PREFIX}${current.bvid}`,
          true,
          ENRICH_CONFIG.negativeTtlMs,
          input.nowMs,
        );
        degraded = `视频详情补全失败（${describeError(error)}）`;
      }
    }
  }

  if (input.index < maxTags && needsTags(current)) {
    const cacheKey = `${TAGS_CACHE_PREFIX}${current.bvid}`;
    const cached = await readCache<TagData[]>(input.repo, cacheKey, input.nowMs);
    if (cached) {
      current = applyTags(current, cached);
    } else if (!(await isFailureCached(input.repo, `${TAGS_FAIL_PREFIX}${current.bvid}`, input.nowMs))) {
      try {
        const tags = await input.api.tags(current.bvid);
        tagsRequested = true;
        await writeCache(input.repo, cacheKey, tags, TTL.tags, input.nowMs);
        current = applyTags(current, tags);
      } catch (error) {
        tagsRequested = true;
        await writeCache(
          input.repo,
          `${TAGS_FAIL_PREFIX}${current.bvid}`,
          true,
          ENRICH_CONFIG.negativeTtlMs,
          input.nowMs,
        );
        degraded = degraded ?? `标签补全失败（${describeError(error)}）`;
      }
    }
  }

  return { candidate: current, viewRequested, tagsRequested, degraded };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
