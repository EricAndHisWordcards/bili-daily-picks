/**
 * 标签/主题词提取：中文分词 + 停用词 + 长度权重。
 *
 * - 优先用 `Intl.Segmenter('zh-CN', { granularity: 'word' })`（Chrome 87+ / Node 20+ 均支持）；
 *   环境不支持时退化为「按标点切分 + 中文二元组」。
 * - 停用词过滤只针对功能词与平台噪声词（不删除游戏/动画这类主题词）。
 * - 长度权重：2 字词略降权，6 字及以上满权，避免「视」「频」这类碎片。
 *
 * 产出 `TagRow[]` 供「我的标签」标签云与推荐兴趣分使用。
 */
import type { HistoryRecord, TagRow } from '../../shared/types';
import { historyWeight } from './weights';

/** 停用词：功能词 + 标题噪声词，均为小写比较 */
export const TAG_STOPWORDS: ReadonlySet<string> = new Set([
  // 功能词/代词/连词
  '的', '了', '是', '在', '和', '与', '及', '或', '而', '被', '把', '让', '给', '就', '都',
  '也', '还', '又', '很', '太', '更', '最', '我', '你', '他', '她', '它', '我们', '你们',
  '他们', '自己', '这', '那', '这个', '那个', '这些', '那些', '一个', '一种', '一次', '一下',
  '什么', '怎么', '为什么', '如何', '哪个', '哪些', '可以', '没有', '不是', '就是', '还是',
  '已经', '因为', '所以', '但是', '如果', '然后', '现在', '大家', '今天', '明天', '昨天',
  '真的', '非常', '特别', '比较', '可能', '应该', '需要', '以及', '其中', '对于', '关于',
  // 平台/标题噪声
  '视频', '官方', '合集', '直播', '高清', '完整版', '完整', '作者', '转载', '自制', '搬运',
  '字幕', '中字', '预告', '花絮', '简介', '相关', '推荐', '热门', '排行', '精华', '最新',
  '更新', '系列', '全部', '观看', '播放', '内容', '作品', '原创', '频道', '栏目', '节目',
  '弹幕', '评论', '点赞', '投币', '收藏', '关注', '分享', '链接', '第一', '第二', '第三',
  '最后', '本期', '上期', '下期', '第', '期', '集', '话', '篇', '版', 'mv', 'ai', 'up',
  'up主', 'vlog', 'reaction', '1080p', '4k', 'hdr', '完整版', '版', '投稿', '动态',
]);

/** 词条最短长度（中文/英文都按 2 处理，单字太泛） */
export const MIN_TERM_LENGTH = 2;
/** 词条最长长度（避免整句/链接混入） */
export const MAX_TERM_LENGTH = 12;

type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

let segmenter: InstanceType<SegmenterCtor> | null | undefined;

function getSegmenter(): InstanceType<SegmenterCtor> | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    segmenter = ctor ? new ctor('zh-CN', { granularity: 'word' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const DIGITS_ONLY = /^\d+(?:\.\d+)?$/;
const NUMBER_UNIT = /^\d+(?:\.\d+)?(?:万|亿|k|w|千|百)$/i;

/** 是否是可作为标签的词 */
export function isUsableTerm(term: string): boolean {
  const text = term.trim().toLowerCase();
  if (text.length < MIN_TERM_LENGTH) return false;
  if (text.length > MAX_TERM_LENGTH) return false;
  if (TAG_STOPWORDS.has(text)) return false;
  if (DIGITS_ONLY.test(text)) return false;
  if (NUMBER_UNIT.test(text)) return false;
  if (!LETTER.test(text)) return false;
  return true;
}

/** 长度权重：2 字 0.7，6 字及以上 1.0 */
export function lengthWeight(term: string): number {
  const len = Math.min(term.trim().length, 6);
  return 0.55 + (0.45 * len) / 6;
}

/** 去掉标题里的括号、竖线、URL 等干扰，保留可分词文本 */
export function cleanTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[【】[\]「」『』（）()《》<>〔〕]/g, ' ')
    .replace(/[|｜_—–~·•\\/→←↑↓]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 无 Segmenter 时的兜底：标点切分 + 中文二元组 */
function fallbackTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.split(/[\s\p{P}\p{S}]+/u)) {
    if (!chunk) continue;
    if (HAN.test(chunk)) {
      if (chunk.length <= 2) {
        tokens.push(chunk);
      } else {
        for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2));
      }
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

/**
 * 标题分词（不含权重，已过滤停用词与噪声）。
 * 同一标题里的重复词会保留重复，交给聚合阶段计数。
 */
export function tokenizeTitle(title: string): string[] {
  const text = cleanTitle(title ?? '');
  if (!text) return [];
  const tokens: string[] = [];
  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(text)) {
      if (part.isWordLike === false) continue;
      const term = part.segment.trim().toLowerCase();
      if (!isUsableTerm(term)) continue;
      tokens.push(term);
    }
    return tokens;
  }
  for (const raw of fallbackTokens(text)) {
    const term = raw.trim().toLowerCase();
    if (!isUsableTerm(term)) continue;
    tokens.push(term);
  }
  return tokens;
}

/** 「词条 -> 权重」列表：分词结果 × 长度权重 */
export function weightedTermsOfTitle(title: string): Array<{ term: string; weight: number }> {
  return tokenizeTitle(title).map((term) => ({ term, weight: lengthWeight(term) }));
}

interface TagAccumulator {
  weight: number;
  count: number;
  kind: TagRow['kind'];
}

export interface BuildTagRowsOptions {
  /** 最多返回多少条，默认 40 */
  limit?: number;
  /** 是否把一级分区名与叶子分区名也计入（默认 true） */
  includeRegions?: boolean;
}

/**
 * 从历史记录聚合标签行：
 * - 标题分词（kind=title）× 历史权重 × 长度权重
 * - 一级分区（kind=region）× 历史权重 × 1.2
 * - 叶子分区（kind=tag）× 历史权重 × 0.6
 * 结果按权重归一化到 0..1，按权重/次数排序后截断。
 */
export function buildTagRows(
  history: HistoryRecord[],
  nowMs: number,
  options: BuildTagRowsOptions = {},
): TagRow[] {
  const limit = options.limit ?? 40;
  const includeRegions = options.includeRegions !== false;
  const acc = new Map<string, TagAccumulator>();

  const add = (term: string, weight: number, kind: TagRow['kind']): void => {
    if (!Number.isFinite(weight) || weight <= 0) return;
    const key = `${kind}:${term}`;
    const prev = acc.get(key);
    if (prev) {
      prev.weight += weight;
      prev.count += 1;
    } else {
      acc.set(key, { weight, count: 1, kind });
    }
  };

  for (const record of history) {
    const base = historyWeight(record, nowMs);
    if (base <= 0) continue;
    for (const { term, weight } of weightedTermsOfTitle(record.title)) {
      add(term, base * weight, 'title');
    }
    if (includeRegions) {
      const parent = (record.parentRegion ?? '').trim();
      if (parent && parent !== '其他') add(parent, base * 1.2, 'region');
      const leaf = (record.tname ?? '').trim();
      if (leaf && leaf !== parent) add(leaf, base * 0.6, 'tag');
    }
  }

  const rows = [...acc.entries()].map(([key, value]) => ({
    term: key.slice(key.indexOf(':') + 1),
    weight: value.weight,
    count: value.count,
    kind: value.kind,
  }));
  if (rows.length === 0) return [];
  const maxWeight = Math.max(...rows.map((row) => row.weight));
  const normalized = rows
    .map((row) => ({
      ...row,
      weight: Math.round((row.weight / maxWeight) * 10_000) / 10_000,
    }))
    .sort(
      (a, b) =>
        b.weight - a.weight || b.count - a.count || a.term.localeCompare(b.term, 'zh-CN'),
    );
  return normalized.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 只读信号（收藏/稍后再看）的标签聚合                                  */
/* ------------------------------------------------------------------ */

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

/** 由一组标题聚合原始标签权重（收藏/稍后再看等没有历史权重的场景） */
export function collectTitleTags(
  titles: string[],
  limit = 40,
): Array<{ term: string; weight: number; count: number }> {
  const acc = new Map<string, { weight: number; count: number }>();
  for (const title of titles) {
    for (const { term, weight } of weightedTermsOfTitle(title)) {
      const prev = acc.get(term);
      if (prev) {
        prev.weight += weight;
        prev.count += 1;
      } else {
        acc.set(term, { weight, count: 1 });
      }
    }
  }
  return [...acc.entries()]
    .map(([term, row]) => ({ term, weight: round4(row.weight), count: row.count }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count || a.term.localeCompare(b.term, 'zh-CN'))
    .slice(0, limit);
}

/**
 * 把原始「词条 + 权重 + 次数」归一化为 TagRow[]（权重 0..1，最大值为 1）。
 * 收藏标签、稍后再看标签等信号数据用它转成画像里的标准结构。
 */
export function tagRowsFromRaw(
  rows: Array<{ term: string; weight: number; count: number }>,
  limit = 40,
  kind: TagRow['kind'] = 'title',
): TagRow[] {
  const valid = rows.filter((row) => row.term && row.weight > 0);
  if (valid.length === 0) return [];
  const maxWeight = Math.max(...valid.map((row) => row.weight));
  return valid
    .map((row) => ({
      term: row.term,
      weight: round4(Math.min(1, row.weight / maxWeight)),
      count: row.count,
      kind,
    }))
    .sort(
      (a, b) =>
        b.weight - a.weight || b.count - a.count || a.term.localeCompare(b.term, 'zh-CN'),
    )
    .slice(0, limit);
}

/**
 * 合并多组标签：(每组先按自身最大值归一化) × 组权重，逐词相加后再全局归一化。
 * 用于把历史标签与收藏/稍后再看标签按 SIGNAL_WEIGHTS 合并进画像。
 */
export function mergeTagRows(
  sources: Array<{ rows: TagRow[]; weight: number }>,
  limit = 40,
): TagRow[] {
  const acc = new Map<string, { weight: number; count: number; kind: TagRow['kind'] }>();
  for (const source of sources) {
    if (!(source.weight > 0) || source.rows.length === 0) continue;
    const maxWeight = Math.max(...source.rows.map((row) => row.weight), 0);
    if (maxWeight <= 0) continue;
    for (const row of source.rows) {
      const term = row.term.trim();
      if (!term) continue;
      const add = (row.weight / maxWeight) * source.weight;
      const prev = acc.get(term);
      if (prev) {
        prev.weight += add;
        prev.count += row.count;
      } else {
        acc.set(term, { weight: add, count: row.count, kind: row.kind });
      }
    }
  }
  if (acc.size === 0) return [];
  const entries = [...acc.entries()];
  const maxWeight = Math.max(...entries.map(([, row]) => row.weight));
  if (maxWeight <= 0) return [];
  return entries
    .map(([term, row]) => ({
      term,
      weight: round4(row.weight / maxWeight),
      count: row.count,
      kind: row.kind,
    }))
    .sort(
      (a, b) =>
        b.weight - a.weight || b.count - a.count || a.term.localeCompare(b.term, 'zh-CN'),
    )
    .slice(0, limit);
}
