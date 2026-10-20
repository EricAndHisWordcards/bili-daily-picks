/**
 * 每日结果组装：打分 -> 分组 -> DailyResult（含画像摘要与运行报告）。
 *
 * 纯 CPU 逻辑：增长快照读写、请求计数、持久化等副作用都由流水线负责，
 * 这样单测可以完全离线、确定性地验证「同一天同样输入得到同样结果」。
 */
import type {
  Candidate,
  DailyResult,
  GrowthInfo,
  Profile,
  Recommendation,
  RunMeta,
  Section,
  Settings,
  SourceKind,
} from '../../shared/types';
import { dateKey } from '../../shared/time';
import { profileSummaryOf } from '../profile/build';
import { buildSections, collectSectionBvids } from './sections';
import { scoreCandidates, type ScoredCandidate } from './score';

/** 运行报告里流水线负责填的部分 */
export interface DailyMetaInput {
  requests: number;
  durationMs: number;
  candidates: number;
  degraded?: string;
}

export interface BuildDailyInput {
  candidates: Candidate[];
  growth: Map<string, GrowthInfo>;
  settings: Settings;
  profile: Profile | null;
  nowMs: number;
  mode: 'full' | 'public';
  mid?: number;
  /** 不感兴趣的 bvid */
  dismissed?: string[];
  /** 换一批时需要排除的已展示 bvid */
  extraExcluded?: string[];
  /** bvid -> 最近一次被推荐时间（毫秒），用于重复推荐惩罚 */
  pickedAt?: Map<string, number>;
  meta: DailyMetaInput;
}

export interface BuildDailyOutput {
  daily: DailyResult;
  scored: ScoredCandidate[];
  /** 本次结果涉及的全部 bvid（用于「换一批」排除） */
  bvids: string[];
}

const SOURCE_ORDER: SourceKind[] = [
  'popular',
  'ranking',
  'regionRanking',
  'weekly',
  'rcmd',
  'related',
];

function sourceKindsOfSections(sections: Section[]): SourceKind[] {
  const present = new Set<SourceKind>();
  for (const section of sections) {
    for (const item of section.items) {
      for (const ref of item.sources) present.add(ref.kind);
    }
  }
  return SOURCE_ORDER.filter((kind) => present.has(kind));
}

/** 组装每日推荐结果（纯函数，便于单测确定性） */
export function buildDailyResult(input: BuildDailyInput): BuildDailyOutput {
  const mid = input.mid ?? input.profile?.mid;
  const date = dateKey(input.nowMs);
  const seedKey = `${date}:${mid ?? 'anon'}`;

  const excluded = new Set<string>([
    ...(input.dismissed ?? []),
    ...(input.extraExcluded ?? []),
  ]);
  const pool = input.candidates.filter((candidate) => !excluded.has(candidate.bvid));

  const scored = scoreCandidates(pool, {
    profile: input.profile,
    nowMs: input.nowMs,
    growth: input.growth,
    pickedAt: input.pickedAt,
  });
  const sections = buildSections({
    scored,
    profile: input.profile,
    settings: input.settings,
    nowMs: input.nowMs,
    mode: input.mode,
    seedKey,
    excluded: new Set<string>(),
    context: { profile: input.profile, growth: input.growth },
  });

  const meta: RunMeta = {
    candidates: input.meta.candidates,
    requests: input.meta.requests,
    durationMs: Math.max(0, Math.round(input.meta.durationMs)),
    sources: sourceKindsOfSections(sections),
    ...(input.meta.degraded ? { degraded: input.meta.degraded } : {}),
  };

  const daily: DailyResult = {
    date,
    generatedAt: input.nowMs,
    mid,
    mode: input.mode,
    sections,
    profileSummary: profileSummaryOf(input.profile),
    meta,
  };

  return { daily, scored, bvids: collectSectionBvids(sections) };
}

/** 每日结果里出现的全部推荐（扁平化，测试与统计用） */
export function flattenRecommendations(sections: Section[]): Recommendation[] {
  return sections.flatMap((section) => section.items);
}

export type { ScoredCandidate };
