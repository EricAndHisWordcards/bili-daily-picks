/**
 * 离线演示数据（?mock=1 或非扩展环境时生效）。
 *
 * 目标：不联网就能完整渲染仪表盘，用于本地预览与 Playwright 截图。
 * 全部数据由 `tests/fixtures/api/**.json`（真实 B 站接口响应 + 合成历史）推导，
 * 保证分区板块 5 个、每板块 3 条、标签 20+、增长同时包含实测与估算两种。
 *
 * 注意：本模块由 `api.ts` 动态 import，正常扩展运行不会加载这些体积较大的 fixture。
 */
import type {
  AccountInfo,
  AffinityRow,
  BackupData,
  BackupFile,
  DailyResult,
  DashboardData,
  GrowthInfo,
  HistoryRecord,
  ImportSummary,
  Owner,
  Profile,
  ProfileSignals,
  Recommendation,
  RunMeta,
  RunStatus,
  Section,
  Settings,
  SnapshotRow,
  SourceKind,
  SourceRef,
  TagRow,
  TrendDirection,
  UpRow,
  VideoStat,
  WeeklyReport,
  WeeklyReportMeta,
  WeeklyReportResponse,
} from '../../shared/types';
import {
  BACKUP_APP,
  BACKUP_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  HISTORY_WINDOW_DAYS,
  PARENT_REGION_NAMES,
  WEEKLY_CONFIG,
} from '../../shared/constants';
import { cyrb53, seededFraction } from '../../shared/hash';
import { normalizeStat } from '../../shared/stat';
import { dateKey, sleep } from '../../shared/time';
import { formatPercent } from '../../shared/format';
import type { ExportBackupResult, MockVariant, UiApi } from './types';
import { formatWatchSeconds, nextUpdateAt } from './view';

import regionSeedJson from '../../shared/region-seed.json';
import popularJson from '../../../tests/fixtures/api/popular.json';
import ranking0Json from '../../../tests/fixtures/api/ranking-0.json';
import ranking4Json from '../../../tests/fixtures/api/ranking-4.json';
import weeklyJson from '../../../tests/fixtures/api/weekly-one.json';
import rcmdJson from '../../../tests/fixtures/api/rcmd.json';
import relatedJson from '../../../tests/fixtures/api/related.json';
import tagsJson from '../../../tests/fixtures/api/tags.json';
import historyJson from '../../../tests/fixtures/api/history.sample.json';

/* ------------------------------------------------------------------ */
/* fixture 原始结构（只看用到的字段）                                   */
/* ------------------------------------------------------------------ */

interface RawStat {
  view?: number;
  like?: number;
  favorite?: number;
  coin?: number;
  reply?: number;
  danmaku?: number;
  share?: number;
}

interface RawOwner {
  mid?: number;
  name?: string;
  face?: string;
}

interface RawVideo {
  bvid?: string;
  title?: string;
  pic?: string;
  duration?: number;
  pubdate?: number;
  tname?: string;
  owner?: RawOwner;
  stat?: RawStat;
  goto?: string;
  is_ogv?: boolean;
}

interface RawListFile {
  data?: { list?: RawVideo[]; item?: RawVideo[]; config?: { number?: number; subject?: string } };
}

interface RawRelatedFile {
  data?: RawVideo[];
}

interface RawTagsFile {
  data?: Array<{ tag_name?: string }>;
}

interface RawHistoryFile {
  list?: Array<{
    bvid?: string;
    title?: string;
    cover?: string;
    viewedAt?: number;
    duration?: number;
    progress?: number;
    tname?: string;
    parentRegion?: string;
    authorMid?: number;
    authorName?: string;
    isFav?: boolean;
  }>;
}

const LEAF_TO_PARENT = regionSeedJson as Record<string, string>;

const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;
const DAY_MS = DAY_SEC * 1000;
const WEEK_MS = 7 * DAY_MS;
const RUN_DURATION_MS = 4_600;
const APP_VERSION = '0.2.0';
const MOCK_MID = 20261020;
const MOCK_UNAME = '星海旅人';

const WEEKLY_DATA = (weeklyJson as unknown as RawListFile).data;
const WEEKLY_ISSUE = WEEKLY_DATA?.config?.number ?? 395;
const WEEKLY_SUBJECT = WEEKLY_DATA?.config?.subject ?? 'B 站官方每周精选';

const REGION_OVERRIDES: Record<string, string> = {
  国产动画: '动画',
  番剧: '番剧',
  国创: '国创',
  资讯: '资讯',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/* ------------------------------------------------------------------ */
/* 一级分区映射                                                        */
/* ------------------------------------------------------------------ */

function normalizeParentRegion(tname: string | undefined, rawParent?: string): string {
  if (rawParent && PARENT_REGION_NAMES.has(rawParent)) return rawParent;
  if (rawParent && REGION_OVERRIDES[rawParent]) return REGION_OVERRIDES[rawParent];
  const leaf = tname?.trim();
  if (leaf && LEAF_TO_PARENT[leaf]) return LEAF_TO_PARENT[leaf];
  return '其他';
}

/** 猜你喜欢接口不返回 tname，用标题关键词兜底猜一个一级分区 */
const TITLE_REGION_HINTS: Array<[RegExp, string]> = [
  [/篮球|足球|球星|NBA|体育|比赛/i, '运动'],
  [/游戏|英雄联盟|崩坏|星穹|原神|绝区零|电竞|手游/i, '游戏'],
  [/数码|电脑|显卡|芯片|手机|人工智能|机器人|编程/i, '科技'],
  [/穿搭|美妆|护肤|时尚/i, '时尚'],
  [/美食|做饭|厨房|糖水|探店|甜品/i, '美食'],
  [/电影|影视|剧集|预告|短片/i, '影视'],
  [/猫|狗|宠物|动物/i, '动物圈'],
  [/音乐|MV|歌曲|演奏|翻唱/i, '音乐'],
  [/动画|动漫|二次元|手书/i, '动画'],
  [/汽车|车评|新能源/i, '汽车'],
  [/纪录片|历史|科普|知识|学习/i, '知识'],
  [/旅行|生活|日常|搞笑/i, '生活'],
];

function guessRegion(title: string): string {
  for (const [pattern, region] of TITLE_REGION_HINTS) {
    if (pattern.test(title)) return region;
  }
  return '其他';
}

/* ------------------------------------------------------------------ */
/* 视频池                                                              */
/* ------------------------------------------------------------------ */

interface PoolItem {
  bvid: string;
  title: string;
  cover: string;
  duration: number;
  pubdate: number;
  owner: Owner;
  stat: VideoStat;
  tname: string;
  parentRegion: string;
  sources: SourceRef[];
  /** 0..1 的互动质量百分位 */
  quality: number;
  /** 0..1 综合分（展示用） */
  score: number;
  growth: GrowthInfo;
}

function normalizeOwner(raw: RawOwner | undefined, key: string): Owner {
  const name = raw?.name?.trim() || '神秘 UP 主';
  const mid = raw?.mid ?? (cyrb53(`${name}:${key}`) % 2_000_000_000);
  return { mid, name, face: raw?.face };
}

/** 补全缺字段的统计（猜你喜欢只返回 view/like/danmaku） */
function normalizeMockStat(raw: RawStat | undefined, bvid: string): VideoStat {
  const stat = normalizeStat(raw ?? {});
  const view = Math.max(0, stat.view);
  const noise = (key: string) => seededFraction(`${bvid}:${key}`, 9);
  if (!stat.favorite) stat.favorite = Math.round(view * (0.012 + noise('fav') * 0.03));
  if (!stat.like) stat.like = Math.round(view * (0.03 + noise('like') * 0.03));
  if (!stat.coin) stat.coin = Math.round(stat.like * (0.12 + noise('coin') * 0.16));
  if (!stat.reply) stat.reply = Math.round(view * (0.0015 + noise('reply') * 0.0025));
  if (!stat.danmaku) stat.danmaku = Math.round(view * (0.001 + noise('dm') * 0.002));
  if (!stat.share) stat.share = Math.round(view * (0.0008 + noise('share') * 0.0015));
  return stat;
}

/** 增长数据：约 2/3 用「两次快照的 24h 实测增量」，其余用「发布以来日均」估算 */
function buildGrowth(item: PoolItem): GrowthInfo {
  const seed = seededFraction(item.bvid, 21);
  const measured = seed < 0.68;
  const hours = measured ? 20 + Math.round(seededFraction(item.bvid, 22) * 8) : 24;
  const ageDays = Math.max(0.25, (NOW_SEC - item.pubdate) / DAY_SEC);
  const totalView = Math.max(1, item.stat.view);
  const ratio = 0.004 + seed * 0.06;
  const view = Math.max(
    1,
    measured ? Math.round(totalView * ratio) : Math.min(totalView, Math.round(totalView / ageDays)),
  );
  const favorite = measured
    ? Math.round(view * (0.015 + seed * 0.05))
    : Math.round(item.stat.favorite / ageDays);
  const reply = measured
    ? Math.round(view * (0.002 + seed * 0.005))
    : Math.round(item.stat.reply / ageDays);
  return {
    hours,
    view,
    favorite: Math.max(0, favorite),
    reply: Math.max(0, reply),
    estimated: !measured,
  };
}

function buildPool(): PoolItem[] {
  const map = new Map<string, PoolItem>();

  const addList = (list: RawVideo[] | undefined, makeSource: (index: number) => SourceRef): void => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, index) => {
      if (!raw || !raw.bvid || !raw.title) return;
      if (raw.goto && raw.goto !== 'av') return;
      if (raw.is_ogv) return;
      const bvid = raw.bvid;
      const source = makeSource(index);
      const existing = map.get(bvid);
      if (existing) {
        if (!existing.sources.some((item) => item.kind === source.kind)) existing.sources.push(source);
        return;
      }
      const title = raw.title.trim();
      const tname = raw.tname?.trim() ?? '';
      let parentRegion = normalizeParentRegion(tname);
      if (parentRegion === '其他' && !tname) parentRegion = guessRegion(title);
      const duration = Number.isFinite(raw.duration) && raw.duration ? Math.max(0, Math.round(raw.duration)) : 0;
      const pubdate =
        Number.isFinite(raw.pubdate) && raw.pubdate ? Math.round(raw.pubdate) : NOW_SEC - DAY_SEC * 7;
      map.set(bvid, {
        bvid,
        title,
        cover: raw.pic?.trim() ?? '',
        duration,
        pubdate,
        owner: normalizeOwner(raw.owner, bvid),
        stat: normalizeMockStat(raw.stat, bvid),
        tname: tname || parentRegion,
        parentRegion,
        sources: [source],
        quality: 0,
        score: 0.8,
        growth: { hours: 24, view: 0, favorite: 0, reply: 0, estimated: true },
      });
    });
  };

  addList((popularJson as unknown as RawListFile).data?.list, (index) => ({
    kind: 'popular',
    rank: index + 1,
  }));
  addList((ranking0Json as unknown as RawListFile).data?.list, (index) => ({
    kind: 'ranking',
    rank: index + 1,
  }));
  addList((ranking4Json as unknown as RawListFile).data?.list, (index) => ({
    kind: 'regionRanking',
    rank: index + 1,
    rid: 4,
    regionName: '游戏',
  }));
  addList(WEEKLY_DATA?.list, (index) => ({ kind: 'weekly', rank: index + 1, issue: WEEKLY_ISSUE }));
  addList((rcmdJson as unknown as RawListFile).data?.item, () => ({ kind: 'rcmd' }));
  addList((relatedJson as unknown as RawRelatedFile).data, () => ({ kind: 'related' }));

  const items = [...map.values()];

  // 互动质量百分位 → 展示用综合分
  const qualityRaw = items.map((item) => {
    const view = Math.max(1, item.stat.view);
    return (
      (item.stat.like / view) * 0.35 +
      (item.stat.favorite / view) * 0.3 +
      (item.stat.coin / view) * 0.2 +
      (item.stat.reply / view) * 0.1 +
      (item.stat.share / view) * 0.05
    );
  });
  qualityRaw
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)
    .forEach((entry, rank) => {
      items[entry.index].quality = items.length > 1 ? rank / (items.length - 1) : 1;
    });

  for (const item of items) {
    item.score = round2(Math.min(0.99, 0.72 + item.quality * 0.26 + seededFraction(item.bvid, 5) * 0.01));
    item.growth = buildGrowth(item);
  }
  return items;
}

const POOL = buildPool();
const PUBLIC_POOL = POOL.filter((item) =>
  item.sources.some(
    (source) =>
      source.kind === 'popular' ||
      source.kind === 'ranking' ||
      source.kind === 'regionRanking' ||
      source.kind === 'weekly',
  ),
);

/* ------------------------------------------------------------------ */
/* 历史与画像                                                          */
/* ------------------------------------------------------------------ */

function normalizeHistory(): HistoryRecord[] {
  const raw = (historyJson as unknown as RawHistoryFile).list ?? [];
  const records: HistoryRecord[] = [];
  for (const entry of raw) {
    if (!entry.bvid || !entry.title || !entry.viewedAt) continue;
    const tname = entry.tname?.trim() ?? '';
    records.push({
      bvid: entry.bvid,
      title: entry.title,
      cover: entry.cover,
      viewedAt: entry.viewedAt,
      duration: entry.duration ?? 0,
      progress: entry.progress ?? 0,
      tname,
      parentRegion: normalizeParentRegion(tname, entry.parentRegion),
      authorMid: entry.authorMid,
      authorName: entry.authorName,
      isFav: entry.isFav,
    });
  }
  return records;
}

const HISTORY = normalizeHistory();

function buildRegionAffinities(): AffinityRow[] {
  const counts = new Map<string, number>();
  for (const record of HISTORY) {
    counts.set(record.parentRegion, (counts.get(record.parentRegion) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .filter(([name]) => name && name !== '其他')
    .map(([name, count]) => ({ name, count, affinity: 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const max = rows[0]?.count ?? 1;
  return rows.map((row) => ({ ...row, affinity: round2(row.count / max) }));
}

function buildUps(): UpRow[] {
  interface Acc {
    mid: number;
    name: string;
    count: number;
    weight: number;
  }
  const map = new Map<string, Acc>();
  for (const record of HISTORY) {
    const name = record.authorName?.trim();
    if (!name) continue;
    const mid = record.authorMid ?? (cyrb53(name) % 2_000_000_000);
    const ageDays = Math.max(0, (NOW_SEC - record.viewedAt) / DAY_SEC);
    const completion =
      record.duration > 0 ? Math.min(1, record.progress / record.duration) : 0.35;
    const weight = Math.exp(-ageDays / 10) * (ageDays <= 7 ? 2 : 1) * (0.35 + 0.65 * completion);
    const current = map.get(name) ?? { mid, name, count: 0, weight: 0 };
    current.count += 1;
    current.weight += weight;
    map.set(name, current);
  }
  const rows = [...map.values()].sort(
    (a, b) => b.weight - a.weight || b.count - a.count || a.name.localeCompare(b.name),
  );
  const max = rows[0]?.weight || 1;
  return rows.slice(0, 10).map((row) => ({
    mid: row.mid,
    name: row.name,
    count: row.count,
    affinity: round2(row.weight / max),
  }));
}

function buildHours(): number[] {
  const counts = new Array<number>(24).fill(0);
  for (const record of HISTORY) {
    if (!record.viewedAt) continue;
    const hour = new Date(record.viewedAt * 1000).getHours();
    counts[hour] += 1;
  }
  // fixture 的时间分布比较平，这里叠加一个「午休 + 晚间」的合理作息形状
  const values = counts.map((count, hour) => {
    const evening = Math.exp(-((hour - 21.5) ** 2) / 12);
    const noon = Math.exp(-((hour - 12.5) ** 2) / 10);
    const morning = Math.exp(-((hour - 8.5) ** 2) / 8);
    return 0.1 + count * 0.04 + evening * 0.95 + noon * 0.4 + morning * 0.22;
  });
  const max = Math.max(...values, 0.0001);
  return values.map((value) => round2(value / max));
}

interface TagDraft {
  term: string;
  weight: number;
  count: number;
  kind: TagRow['kind'];
}

const TITLE_KEYWORDS: Array<[string, RegExp]> = [
  ['绝区零', /绝区零/],
  ['英雄联盟', /英雄联盟|LOL/i],
  ['崩坏', /崩坏|星穹/],
  ['原神', /原神/],
  ['电影', /电影|影视|剧集/],
  ['纪录片', /纪录片/],
  ['美食', /美食|糖水|做饭|探店/],
  ['旅行', /旅行|地中海|风景/],
  ['篮球', /篮球|NBA/],
  ['数码', /数码|电脑|显卡|芯片|手机/],
  ['AI', /AI|人工智能/i],
  ['二次元', /二次元/],
  ['鬼畜', /鬼畜/],
  ['萌宠', /猫|狗|宠物/],
  ['语言', /语言|中文|词汇/],
  ['职场', /职场|工作|打工/],
  ['摄影', /摄影|相机/],
  ['音乐', /音乐|MV|歌曲/],
];

function buildTags(regions: AffinityRow[], window: Settings['tagWindow']): TagRow[] {
  const drafts = new Map<string, TagDraft>();
  const add = (term: string, weight: number, count: number, kind: TagRow['kind']): void => {
    const key = term.trim();
    if (!key) return;
    const existing = drafts.get(key);
    if (existing) {
      existing.count += count;
      existing.weight = round2(Math.max(existing.weight, weight));
      return;
    }
    drafts.set(key, { term: key, weight: round2(weight), count: Math.max(1, Math.round(count)), kind });
  };

  // 1) 来自 tags.json 的标签（真实接口返回）
  const fixtureTags = (tagsJson as unknown as RawTagsFile).data
    ?.map((tag) => tag.tag_name?.trim())
    .filter((name): name is string => Boolean(name));
  (fixtureTags ?? []).forEach((term, index) => {
    add(term, 0.78 - index * 0.045, Math.max(2, 7 - Math.floor(index / 2)), 'tag');
  });

  // 2) 一级分区偏好
  for (const region of regions.slice(0, 8)) {
    add(region.name, 0.55 + region.affinity * 0.4, region.count, 'region');
  }

  // 3) 历史标题里的主题词
  for (const [term, pattern] of TITLE_KEYWORDS) {
    const matches = HISTORY.filter((record) => pattern.test(record.title)).length;
    if (matches > 0) add(term, 0.36 + Math.min(0.4, matches * 0.09), matches, 'title');
  }

  const base = [...drafts.values()].sort((a, b) => b.weight - a.weight || b.count - a.count);
  const baseMax = base[0]?.weight || 1;

  // 4) 统计窗口影响标签权重（7d 更聚焦最近、all 更平滑）
  const windowFactor = window === '7d' ? 0.58 : window === '30d' ? 0.82 : 1;
  const countFactor = window === '7d' ? 0.42 : window === '30d' ? 0.72 : 1;
  const scaled = base.map((draft) => {
    const jitter = 0.85 + seededFraction(`${draft.term}:${window}`, 71) * 0.3;
    return {
      ...draft,
      weight: ((draft.weight / baseMax) * windowFactor * jitter),
      count: Math.max(1, Math.round(draft.count * countFactor)),
    };
  });
  const max = Math.max(...scaled.map((draft) => draft.weight), 0.0001);
  return scaled
    .map<TagRow>((draft) => ({
      term: draft.term,
      weight: round2(draft.weight / max),
      count: draft.count,
      kind: draft.kind,
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count);
}

function buildProfile(state: MockState): Profile {
  const regions = buildRegionAffinities();
  const durations = HISTORY.filter((record) => record.duration > 0)
    .map((record) => record.duration)
    .sort((a, b) => a - b);
  const completionSamples = HISTORY.filter(
    (record) => record.duration > 0 && record.progress > 0,
  ).map((record) => Math.min(1, record.progress / record.duration));
  const completionRate = completionSamples.length
    ? round3(completionSamples.reduce((sum, value) => sum + value, 0) / completionSamples.length)
    : 0.45;
  const avgDuration = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 900;
  const p10 = durations.length ? durations[Math.floor(durations.length * 0.1)] : 120;
  const p90 = durations.length
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))]
    : 1800;
  const last7d = HISTORY.filter((record) => NOW_SEC - record.viewedAt <= 7 * DAY_SEC).length;

  return {
    mid: 20261020,
    uname: '星海旅人',
    avatar: '',
    generatedAt: state.generatedAt,
    sample: {
      total: HISTORY.length,
      last7d,
      windowDays: HISTORY_WINDOW_DAYS,
    },
    regions,
    tags: buildTags(regions, state.settings.tagWindow),
    ups: buildUps(),
    hours: buildHours(),
    completionRate,
    avgDuration,
    preferredDuration: { p10, p90 },
    signals: buildProfileSignals(state),
  };
}

/* ------------------------------------------------------------------ */
/* 推荐理由与角标                                                      */
/* ------------------------------------------------------------------ */

function primarySource(sources: SourceRef[]): SourceRef {
  const order: SourceKind[] = ['weekly', 'ranking', 'regionRanking', 'popular', 'rcmd', 'related'];
  for (const kind of order) {
    const found = sources.find((source) => source.kind === kind);
    if (found) return found;
  }
  return sources[0] ?? { kind: 'popular' };
}

function buildReason(item: PoolItem, profile: Profile | null): string {
  const upRow = profile?.ups.find((row) => row.name === item.owner.name);
  const regionRow = profile?.regions.find((row) => row.name === item.parentRegion);
  const source = primarySource(item.sources);
  const pick = seededFraction(item.bvid, 33);

  if (upRow && upRow.count >= 2 && pick > 0.35) {
    return `你最近常看「${upRow.name}」，这条别错过`;
  }
  if (regionRow && regionRow.count >= 3 && pick > 0.55) {
    return `近 90 天你看了 ${regionRow.count} 个「${regionRow.name}」视频，这条合口味`;
  }
  switch (source.kind) {
    case 'weekly':
      return `每周必看第 ${source.issue ?? WEEKLY_ISSUE} 期 · ${WEEKLY_SUBJECT}`;
    case 'ranking':
      return source.rank ? `全站排行榜第 ${source.rank} 名` : '全站排行榜精选';
    case 'regionRanking':
      return source.rank
        ? `${source.regionName ?? item.parentRegion}分区排行第 ${source.rank} 名`
        : '分区排行榜精选';
    case 'rcmd':
      return '猜你喜欢 · 和你最近看过的内容相似';
    case 'related':
      return '相关推荐 · 和你常看的视频同主题';
    case 'popular':
    default: {
      const likeRate = item.stat.view > 0 ? item.stat.like / item.stat.view : 0;
      return `热门视频 · 点赞率 ${formatPercent(likeRate)}`;
    }
  }
}

function buildBadges(item: PoolItem): string[] {
  const badges: string[] = [];
  const view = Math.max(1, item.stat.view);
  const favoriteRate = item.stat.favorite / view;
  const likeRate = item.stat.like / view;
  const ageDays = Math.max(0, (NOW_SEC - item.pubdate) / DAY_SEC);
  const growthRate = item.growth.view / Math.max(1, item.growth.hours);

  if (favoriteRate >= 0.045) badges.push('高收藏');
  if (likeRate >= 0.055) badges.push('高赞');
  if (!item.growth.estimated && growthRate >= 1200) badges.push('增长快');
  if (ageDays <= 2.5) badges.push('新鲜出炉');
  if (item.duration >= 1200) badges.push('深度长视频');
  if (item.duration > 0 && item.duration <= 180) badges.push('短视频');
  if (item.sources.some((source) => source.kind === 'weekly')) badges.push('每周必看');
  if (!badges.length) badges.push('编辑精选');
  return badges.slice(0, 2);
}

function toRecommendation(item: PoolItem, profile: Profile | null): Recommendation {
  return {
    bvid: item.bvid,
    title: item.title,
    cover: item.cover,
    duration: item.duration,
    pubdate: item.pubdate,
    owner: item.owner,
    stat: item.stat,
    tname: item.tname,
    parentRegion: item.parentRegion,
    score: item.score,
    sources: item.sources,
    reason: buildReason(item, profile),
    badges: buildBadges(item),
    growth: item.growth,
  };
}

/* ------------------------------------------------------------------ */
/* 分块组装                                                            */
/* ------------------------------------------------------------------ */

interface TakeOptions {
  oneUp?: boolean;
  regionLimit?: number;
}

/** 从已排序候选里取 N 个，默认同一 UP 只出现一次；不够时放宽限制兜底 */
function takeUnique(
  candidates: PoolItem[],
  count: number,
  used: Set<string>,
  options: TakeOptions = {},
): PoolItem[] {
  const picked: PoolItem[] = [];
  const ups = new Set<number>();
  const regions = new Map<string, number>();
  for (const item of candidates) {
    if (picked.length >= count) break;
    if (used.has(item.bvid)) continue;
    if (options.oneUp && ups.has(item.owner.mid)) continue;
    if (options.regionLimit) {
      const regionUsed = regions.get(item.parentRegion) ?? 0;
      if (regionUsed >= options.regionLimit) continue;
    }
    picked.push(item);
    used.add(item.bvid);
    ups.add(item.owner.mid);
    regions.set(item.parentRegion, (regions.get(item.parentRegion) ?? 0) + 1);
  }
  if (picked.length < count) {
    for (const item of candidates) {
      if (picked.length >= count) break;
      if (used.has(item.bvid)) continue;
      picked.push(item);
      used.add(item.bvid);
    }
  }
  return picked;
}

function uniqueRegionOrder(pool: PoolItem[], profile: Profile | null, mode: 'full' | 'public'): string[] {
  const counts = new Map<string, number>();
  for (const item of pool) {
    counts.set(item.parentRegion, (counts.get(item.parentRegion) ?? 0) + 1);
  }
  const byCount = [...counts.entries()]
    .filter(([name, count]) => name !== '其他' && count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  if (mode === 'full' && profile) {
    const preferred = profile.regions
      .map((row) => row.name)
      .filter((name) => name !== '其他' && (counts.get(name) ?? 0) >= 2);
    const merged: string[] = [];
    for (const name of [...preferred, ...byCount]) {
      if (!merged.includes(name)) merged.push(name);
    }
    return merged;
  }
  return byCount;
}

interface BuildSectionsOptions {
  mode: 'full' | 'public';
  settings: Settings;
  profile: Profile | null;
  dismissed: Set<string>;
  daySeed: number;
}

function buildSections(options: BuildSectionsOptions): Section[] {
  const { mode, settings, profile, dismissed, daySeed } = options;
  const pool = (mode === 'full' ? POOL : PUBLIC_POOL).filter((item) => !dismissed.has(item.bvid));
  if (pool.length === 0) return [];

  const used = new Set<string>();
  const perSection = clampInt(settings.perSection, 2, 5, DEFAULT_SETTINGS.perSection);
  const regionTarget = clampInt(settings.regionSections, 2, 5, DEFAULT_SETTINGS.regionSections);
  const rankSort = (a: PoolItem, b: PoolItem): number =>
    b.score - a.score || seededFraction(a.bvid, daySeed) - seededFraction(b.bvid, daySeed);

  // 先让分区板块占位，保证兴趣最强的分区一定有足够候选
  const regionSections: Section[] = [];
  for (const name of uniqueRegionOrder(pool, profile, mode)) {
    if (regionSections.length >= regionTarget) break;
    const picked = takeUnique(
      pool.filter((item) => item.parentRegion === name).sort(rankSort),
      perSection,
      used,
      { oneUp: true },
    );
    if (picked.length < 2) continue;
    const profileRow = profile?.regions.find((row) => row.name === name);
    regionSections.push({
      id: `region-${name}`,
      title: `${name} · 精选`,
      subtitle: profileRow
        ? `近 ${HISTORY_WINDOW_DAYS} 天看了 ${profileRow.count} 次 · 偏好度 ${formatPercent(profileRow.affinity)}`
        : '公开数据里的热门分区视频',
      kind: 'region',
      items: picked.map((item) => toRecommendation(item, profile)),
    });
  }

  // 全局 6 条：限制每分区 ≤2、每 UP ≤1，避免刷屏
  const globalPicked = takeUnique([...pool].sort(rankSort), 6, used, {
    oneUp: true,
    regionLimit: 2,
  });
  const globalSection: Section = {
    id: 'today-global',
    title: '今日必看',
    subtitle:
      mode === 'public'
        ? '公开数据合成 · 热门 / 排行榜 / 每周必看'
        : '综合你的兴趣、互动质量与增长 · 每天 04:00 更新',
    kind: 'global',
    items: globalPicked.map((item) => toRecommendation(item, profile)),
  };

  const sections: Section[] = [globalSection, ...regionSections];

  const weeklyPicked = takeUnique(
    pool
      .filter((item) => item.sources.some((source) => source.kind === 'weekly'))
      .sort(rankSort),
    6,
    used,
    { oneUp: true },
  );
  if (weeklyPicked.length >= 2) {
    sections.push({
      id: `weekly-${WEEKLY_ISSUE}`,
      title: `每周必看 · 第 ${WEEKLY_ISSUE} 期`,
      subtitle: `${WEEKLY_SUBJECT} · 官方每周精选`,
      kind: 'weekly',
      items: weeklyPicked.map((item) => toRecommendation(item, profile)),
    });
  }

  const growthCandidates = pool
    .filter((item) => !used.has(item.bvid))
    .sort(
      (a, b) =>
        b.growth.view / Math.max(1, b.growth.hours) - a.growth.view / Math.max(1, a.growth.hours),
    );
  const measured = growthCandidates.filter((item) => !item.growth.estimated).slice(0, 9);
  const estimated = growthCandidates.filter((item) => item.growth.estimated).slice(0, 5);
  if (measured.length + estimated.length >= 2) {
    sections.push({
      id: 'growth',
      title: '增长黑马',
      subtitle: '按本地快照的播放增量排序 · 实测与推算混合',
      kind: 'growth',
      items: [...measured, ...estimated].map((item) => toRecommendation(item, profile)),
    });
  }

  return sections;
}

function buildDaily(state: MockState, profile: Profile | null, variant: MockVariant): DailyResult {
  const mode: 'full' | 'public' = state.loggedOut ? 'public' : 'full';
  const sections = buildSections({
    mode,
    settings: state.settings,
    profile,
    dismissed: state.dismissed,
    daySeed: cyrb53(dateKey(state.generatedAt)),
  });
  const sourceKinds = new Set<SourceKind>();
  for (const section of sections) {
    for (const item of section.items) {
      for (const source of item.sources) sourceKinds.add(source.kind);
    }
  }
  const meta: RunMeta = {
    candidates: (mode === 'full' ? POOL : PUBLIC_POOL).length - state.dismissed.size,
    requests: mode === 'public' ? 43 : 96,
    durationMs: mode === 'public' ? 11_800 : 22_400,
    sources: [...sourceKinds],
  };
  if (variant === 'degraded') {
    meta.degraded = '风控冷却中：部分榜单使用 30 分钟前的本地缓存，本次推荐可能略有延迟。';
  }
  return {
    date: dateKey(state.generatedAt),
    generatedAt: state.generatedAt,
    mid: profile?.mid,
    mode,
    sections,
    profileSummary: {
      topRegions: profile?.regions.slice(0, 4) ?? [],
      topTags: profile?.tags.slice(0, 8) ?? [],
    },
    meta,
  };
}

/* ------------------------------------------------------------------ */
/* v0.2.0：账号、兴趣信号、周报、备份                                  */
/* ------------------------------------------------------------------ */

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const FIXTURE_TAG_TERMS: string[] =
  (tagsJson as unknown as RawTagsFile).data
    ?.map((tag) => tag.tag_name?.trim())
    .filter((name): name is string => Boolean(name)) ?? [];
const PAD_TAG_TERMS = [
  ...FIXTURE_TAG_TERMS,
  '动画',
  '游戏',
  '知识',
  '生活',
  '音乐',
  '影视',
  '科技',
  '美食',
  '鬼畜',
  '运动',
  '时尚',
  '娱乐',
  '纪录片',
  '数码',
  '篮球',
];

/** 模拟 B站登录态：normal / empty 已登录；loggedout 未登录但带最近登录记录 */
function buildAccount(state: MockState): AccountInfo {
  if (!state.loggedOut) {
    return {
      loggedIn: true,
      mid: MOCK_MID,
      uname: MOCK_UNAME,
      face: '',
      checkedAt: state.accountCheckedAt,
    };
  }
  return {
    loggedIn: false,
    checkedAt: state.accountCheckedAt,
    last: { mid: MOCK_MID, uname: MOCK_UNAME, face: '', at: state.accountLastLoginAt },
  };
}

/** 画像里的只读兴趣信号（收藏 / 关注 / 稍后再看） */
function buildProfileSignals(state: MockState): ProfileSignals {
  const regions = buildRegionAffinities();
  const ups = buildUps();
  const tags = buildTags(regions, state.settings.tagWindow);

  const favoriteUps: UpRow[] = ups.slice(0, 10).map((row, index) => ({
    mid: row.mid,
    name: row.name,
    count: Math.max(1, 9 - index),
    affinity: round2(Math.max(0.1, 1 - index * 0.07)),
  }));
  const followedUps: UpRow[] = [...ups.slice(2), ...ups.slice(0, 2)]
    .slice(0, 10)
    .map((row, index) => ({
      mid: row.mid,
      name: row.name,
      count: 1,
      affinity: round2(Math.max(0.1, 0.9 - index * 0.06)),
    }));
  const favoriteTags: TagRow[] = tags.slice(0, 8).map((tag, index) => ({
    ...tag,
    weight: round2(Math.max(0.15, 0.9 - index * 0.09)),
    count: Math.max(1, 8 - index),
  }));
  const watchLaterTags: TagRow[] = tags.slice(4, 12).map((tag, index) => ({
    ...tag,
    weight: round2(Math.max(0.12, 0.7 - index * 0.07)),
    count: Math.max(1, 5 - Math.floor(index / 2)),
  }));
  const watchLaterRegions: AffinityRow[] = regions.slice(0, 6).map((row, index) => ({
    name: row.name,
    count: Math.max(1, row.count - index),
    affinity: round2(Math.max(0.15, row.affinity * 0.9 - index * 0.06)),
  }));

  return {
    fetchedAt: state.generatedAt,
    favoriteFolders: 3,
    favoriteCount: 428,
    favoriteSampled: 60,
    favoriteUps,
    favoriteTags,
    followedTotal: 132,
    followedMids: followedUps.map((row) => row.mid),
    followedUps,
    watchLaterCount: 27,
    watchLaterSampled: 20,
    watchLaterRegions,
    watchLaterTags,
    favoriteFallback: state.variant === 'fallback' ? true : undefined,
  };
}

/* ------------------------- 周报 ---------------------------------- */

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfWeekMonday(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  const diff = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - diff);
  return date.getTime();
}

interface WeekStats {
  watched: number;
  watchSeconds: number;
  activeDays: number;
  completionRate: number;
}

function summarizeWeek(rows: HistoryRecord[]): WeekStats {
  let watchSeconds = 0;
  let completionSum = 0;
  let completionCount = 0;
  const days = new Set<string>();
  for (const row of rows) {
    const played =
      row.duration > 0 ? Math.min(row.progress > 0 ? row.progress : row.duration, row.duration) : 0;
    watchSeconds += played;
    if (row.duration > 0 && row.progress > 0) {
      completionSum += Math.min(1, row.progress / row.duration);
      completionCount += 1;
    }
    days.add(dateKey(row.viewedAt * 1000));
  }
  return {
    watched: rows.length,
    watchSeconds: Math.round(watchSeconds),
    activeDays: days.size,
    completionRate: completionCount > 0 ? round3(completionSum / completionCount) : 0,
  };
}

/** 取某一自然周的历史；fixture 里如果这一周恰好没有记录，就用确定性的样本补齐，保证演示有 12 周 */
function rowsForWeek(weekStart: number, weekEnd: number): HistoryRecord[] {
  const rows = HISTORY.filter(
    (record) => record.viewedAt * 1000 >= weekStart && record.viewedAt * 1000 < weekEnd,
  );
  if (rows.length > 0) return rows;
  const key = dateKey(weekStart);
  const count = 3 + Math.floor(seededFraction(key, 41) * 3);
  return Array.from({ length: count }, (_, index) => {
    const source = HISTORY[cyrb53(`${key}:${index}`) % HISTORY.length]!;
    const dayIndex = Math.floor(seededFraction(`${key}:${index}`, 5) * 7);
    return {
      ...source,
      viewedAt: Math.floor((weekStart + dayIndex * DAY_MS + 20 * 3_600_000) / 1000),
    };
  });
}

interface TermWeight {
  weight: number;
  count: number;
}

/** 一周内的主题权重：分区 + 叶子分区 + 标题关键词，加入稳定抖动制造涨跌 */
function weekTermWeights(rows: HistoryRecord[], weekKey: string): Map<string, TermWeight> {
  const map = new Map<string, TermWeight>();
  const add = (term: string, weight: number): void => {
    if (!term) return;
    const current = map.get(term) ?? { weight: 0, count: 0 };
    current.weight += weight;
    current.count += 1;
    map.set(term, current);
  };
  for (const row of rows) {
    add(row.parentRegion, 1.2);
    if (row.tname) add(row.tname, 0.6);
    for (const [term, pattern] of TITLE_KEYWORDS) {
      if (pattern.test(row.title)) add(term, 1);
    }
  }
  for (const [term, value] of map) {
    value.weight *= 0.7 + seededFraction(`${term}:${weekKey}`, 7) * 0.5;
  }
  const max = Math.max(...[...map.values()].map((value) => value.weight), 0.0001);
  const normalized = new Map<string, TermWeight>();
  for (const [term, value] of map) {
    normalized.set(term, { weight: round2(value.weight / max), count: value.count });
  }
  return normalized;
}

function weekRegionWeights(rows: HistoryRecord[], weekKey: string): Map<string, TermWeight> {
  const map = new Map<string, TermWeight>();
  for (const row of rows) {
    if (!row.parentRegion) continue;
    const current = map.get(row.parentRegion) ?? { weight: 0, count: 0 };
    current.weight += 1;
    current.count += 1;
    map.set(row.parentRegion, current);
  }
  for (const [name, value] of map) {
    value.weight *= 0.8 + seededFraction(`${name}:${weekKey}`, 13) * 0.4;
  }
  const max = Math.max(...[...map.values()].map((value) => value.weight), 0.0001);
  const normalized = new Map<string, TermWeight>();
  for (const [name, value] of map) {
    normalized.set(name, { weight: round2(value.weight / max), count: value.count });
  }
  return normalized;
}

function trendStatus(
  currentWeight: number,
  previousWeight: number,
  currentCount: number,
  previousCount: number,
  threshold: number,
): TrendDirection {
  if (currentCount > 0 && previousCount === 0 && currentWeight > 0.05) return 'new';
  if (currentWeight === 0 && previousWeight > 0) return 'gone';
  const delta = currentWeight - previousWeight;
  if (delta >= threshold) return 'up';
  if (delta <= -threshold) return 'down';
  return 'steady';
}

/** 演示数据保证至少有一条「新晋」与一条「下降」，方便截图与断言 */
function ensureTrendSample<
  T extends { status: TrendDirection; delta: number; term: string; weight: number },
>(rows: T[]): void {
  if (rows.length === 0) return;
  if (!rows.some((row) => row.status === 'new')) {
    const candidate = [...rows].sort((a, b) => b.weight - a.weight)[0];
    if (candidate) {
      candidate.status = 'new';
      candidate.delta = Math.max(candidate.delta, 0.2);
    }
  }
  if (!rows.some((row) => row.status === 'down' || row.status === 'gone')) {
    const candidate =
      [...rows].sort((a, b) => a.delta - b.delta).find((row) => row.delta <= 0.02) ??
      [...rows].sort((a, b) => a.weight - b.weight)[0];
    if (candidate) {
      candidate.status = 'down';
      candidate.delta = Math.min(candidate.delta, -0.2);
    }
  }
}

function buildWeeklyReport(weekStart: number, weekEnd: number): WeeklyReport | null {
  const rows = rowsForWeek(weekStart, weekEnd);
  if (rows.length === 0) return null;
  const previousStart = weekStart - WEEK_MS;
  const previousRows = rowsForWeek(previousStart, weekStart);
  const stats = summarizeWeek(rows);
  const previous = summarizeWeek(previousRows);
  const weekKey = dateKey(weekStart);
  const previousKey = dateKey(previousStart);

  // 标签：当前周 + 上一周的并集，支持「新晋 / 上升 / 下降 / 消失」
  const currentTerms = weekTermWeights(rows, weekKey);
  const previousTerms = weekTermWeights(previousRows, previousKey);
  for (const term of PAD_TAG_TERMS) {
    if (currentTerms.size >= 12) break;
    if (!currentTerms.has(term)) {
      currentTerms.set(term, {
        weight: round2(0.15 + seededFraction(`${term}:${weekKey}`, 3) * 0.35),
        count: 1,
      });
    }
  }
  interface TagTrend {
    term: string;
    weight: number;
    previousWeight: number;
    delta: number;
    count: number;
    previousCount: number;
    status: TrendDirection;
  }
  const allTagRows: TagTrend[] = [];
  const termUnion = new Set([...currentTerms.keys(), ...previousTerms.keys()]);
  for (const term of termUnion) {
    const current = currentTerms.get(term) ?? { weight: 0, count: 0 };
    const before = previousTerms.get(term) ?? { weight: 0, count: 0 };
    allTagRows.push({
      term,
      weight: current.weight,
      previousWeight: before.weight,
      delta: round2(current.weight - before.weight),
      count: current.count,
      previousCount: before.count,
      status: trendStatus(
        current.weight,
        before.weight,
        current.count,
        before.count,
        WEEKLY_CONFIG.tagDelta,
      ),
    });
  }
  allTagRows.sort((a, b) => b.weight - a.weight || b.delta - a.delta);
  const topTags = allTagRows.slice(0, WEEKLY_CONFIG.tagLimit);
  ensureTrendSample(topTags);
  const tags = allTagRows.slice(0, 20);

  // 分区
  const currentRegions = weekRegionWeights(rows, weekKey);
  const previousRegions = weekRegionWeights(previousRows, previousKey);
  interface RegionTrend {
    name: string;
    weight: number;
    previousWeight: number;
    delta: number;
    count: number;
    previousCount: number;
    status: TrendDirection;
  }
  const regionRows: RegionTrend[] = [];
  const regionUnion = new Set([...currentRegions.keys(), ...previousRegions.keys()]);
  for (const name of regionUnion) {
    const current = currentRegions.get(name) ?? { weight: 0, count: 0 };
    const before = previousRegions.get(name) ?? { weight: 0, count: 0 };
    regionRows.push({
      name,
      weight: current.weight,
      previousWeight: before.weight,
      delta: round2(current.weight - before.weight),
      count: current.count,
      previousCount: before.count,
      status: trendStatus(
        current.weight,
        before.weight,
        current.count,
        before.count,
        WEEKLY_CONFIG.regionDelta,
      ),
    });
  }
  regionRows.sort((a, b) => b.weight - a.weight);
  const regions = regionRows.slice(0, WEEKLY_CONFIG.regionLimit);

  // UP 主：本周观看次数 Top 6
  interface UpTrend {
    mid: number;
    name: string;
    count: number;
    previousCount: number;
    delta: number;
  }
  const upMap = new Map<string, { mid: number; count: number }>();
  for (const row of rows) {
    const name = row.authorName?.trim();
    if (!name) continue;
    const mid = row.authorMid ?? (cyrb53(name) % 2_000_000_000);
    const current = upMap.get(name) ?? { mid, count: 0 };
    current.count += 1;
    upMap.set(name, current);
  }
  const previousUpMap = new Map<string, number>();
  for (const row of previousRows) {
    const name = row.authorName?.trim();
    if (!name) continue;
    previousUpMap.set(name, (previousUpMap.get(name) ?? 0) + 1);
  }
  const ups: UpTrend[] = [...upMap.entries()]
    .map(([name, value]) => ({
      mid: value.mid,
      name,
      count: value.count,
      previousCount: previousUpMap.get(name) ?? 0,
      delta: value.count - (previousUpMap.get(name) ?? 0),
    }))
    .sort((a, b) => b.count - a.count || b.delta - a.delta)
    .slice(0, WEEKLY_CONFIG.upLimit);

  // 7 天趋势
  const daily = WEEKDAY_NAMES.map((weekday, index) => {
    const dayStart = weekStart + index * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const dayRows = rows.filter(
      (row) => row.viewedAt * 1000 >= dayStart && row.viewedAt * 1000 < dayEnd,
    );
    const day = new Date(dayStart);
    return {
      date: `${day.getMonth() + 1}.${day.getDate()}`,
      weekday,
      watched: dayRows.length,
      watchSeconds: Math.round(
        dayRows.reduce(
          (sum, row) =>
            sum +
            (row.duration > 0
              ? Math.min(row.progress > 0 ? row.progress : row.duration, row.duration)
              : 0),
          0,
        ),
      ),
    };
  });

  const rising = [...allTagRows]
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, WEEKLY_CONFIG.moverLimit)
    .map((row) => ({ term: row.term, delta: row.delta, weight: row.weight }));
  const falling = [...allTagRows]
    .filter((row) => row.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, WEEKLY_CONFIG.moverLimit)
    .map((row) => ({ term: row.term, delta: row.delta, weight: row.weight }));

  const startDate = new Date(weekStart);
  const endDate = new Date(weekEnd - DAY_MS);
  const label = `${startDate.getFullYear()} 年 ${startDate.getMonth() + 1} 月 ${startDate.getDate()} 日 – ${endDate.getMonth() + 1} 月 ${endDate.getDate()} 日`;

  const summary: string[] = [
    `该周共观看 ${stats.watched} 个视频，累计 ${formatWatchSeconds(stats.watchSeconds)}；上一周是 ${previous.watched} 个。`,
    regions[0] ? `最常看的分区是「${regions[0].name}」，共 ${regions[0].count} 个视频。` : '',
    tags[0]
      ? `主题上最关注「${tags[0].term}」${tags[0].status === 'new' ? '，是该周新出现的兴趣' : tags[0].status === 'up' ? '，热度在上升' : ''}。`
      : '',
    ups[0] ? `看得最多的 UP 主是「${ups[0].name}」。` : '',
    `该周活跃 ${stats.activeDays} 天，平均完播率 ${formatPercent(stats.completionRate)}。`,
  ].filter((line): line is string => Boolean(line));

  return {
    weekKey,
    weekStart,
    weekEnd,
    label,
    generatedAt: Math.min(NOW_MS, weekEnd + 4 * 3_600_000),
    stats,
    previous,
    daily,
    tags,
    rising,
    falling,
    regions,
    ups,
    summary,
    sample: { currentTotal: rows.length, previousTotal: previousRows.length },
  };
}

function buildWeeklyReports(): WeeklyReport[] {
  const currentWeekStart = startOfWeekMonday(NOW_MS);
  const reports: WeeklyReport[] = [];
  for (let offset = 1; offset <= WEEKLY_CONFIG.keepReports; offset += 1) {
    const weekStart = currentWeekStart - offset * WEEK_MS;
    const report = buildWeeklyReport(weekStart, weekStart + WEEK_MS);
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => b.weekStart - a.weekStart);
}

const WEEKLY_REPORTS = buildWeeklyReports();

/* ------------------------- 备份 ---------------------------------- */

function backupFilename(now: number = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `bili-daily-picks-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

function buildMockBackupData(state: MockState): BackupData {
  const profile = state.loggedOut || state.cleared ? null : buildProfile(state);
  const daily = state.cleared ? [] : [buildDaily(state, profile, state.variant)];
  const snapshots: SnapshotRow[] = POOL.slice(0, 24).map((item, index) => ({
    bvid: item.bvid,
    ts: NOW_SEC - index * 3_600,
    stat: item.stat,
  }));
  return {
    settings: { ...state.settings, enabledSources: { ...state.settings.enabledSources } },
    history: HISTORY.slice(0, 200),
    snapshots,
    daily,
    profile,
    dismissed: [...state.dismissed].map((bvid) => ({ bvid, at: state.generatedAt })),
    weeklyReports: state.cleared || state.loggedOut ? [] : WEEKLY_REPORTS,
  };
}

function buildExportResult(state: MockState): ExportBackupResult {
  const file: BackupFile = {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    data: buildMockBackupData(state),
  };
  const json = JSON.stringify(file, null, 2);
  return {
    filename: backupFilename(),
    json,
    bytes: new TextEncoder().encode(json).length,
  };
}

function readBackupSettings(raw: unknown): Partial<Settings> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // 备份里的 settings 可能是旧版本/局部字段，交给 sanitizeSettingsPatch 与当前值合并
  return raw as Partial<Settings>;
}

function parseMockBackup(json: string): { summary: ImportSummary; settings?: Partial<Settings> } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('备份文件不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('备份文件根节点必须是对象');
  const file = raw as {
    app?: unknown;
    schemaVersion?: unknown;
    data?: Record<string, unknown>;
  };
  if (file.app !== BACKUP_APP) throw new Error('不是本扩展导出的备份文件');
  if (file.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`备份版本不支持（${String(file.schemaVersion)}），当前只支持 ${BACKUP_SCHEMA_VERSION}`);
  }
  const data = file.data ?? {};
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const summary: ImportSummary = {
    history: count(data.history),
    snapshots: count(data.snapshots),
    daily: count(data.daily),
    dismissed: count(data.dismissed),
    weekly: count(data.weeklyReports),
    hasProfile: Boolean(data.profile),
    dropped: 0,
  };
  return { summary, settings: readBackupSettings(data.settings) };
}

/* ------------------------------------------------------------------ */
/* 运行状态与 Mock API                                                 */
/* ------------------------------------------------------------------ */

interface MockState {
  variant: MockVariant;
  loggedOut: boolean;
  cleared: boolean;
  settings: Settings;
  dismissed: Set<string>;
  run: { startedAt: number; force: boolean } | null;
  lastRunAt: number | undefined;
  generatedAt: number;
  lastError?: string;
  /** 账号状态：最近一次检测时间 / 最近一次成功登录时间（毫秒） */
  accountCheckedAt: number;
  accountLastLoginAt: number;
}

function createState(variant: MockVariant): MockState {
  const now = Date.now();
  return {
    variant,
    loggedOut: variant === 'loggedout',
    cleared: variant === 'empty',
    settings: { ...DEFAULT_SETTINGS, enabledSources: { ...DEFAULT_SETTINGS.enabledSources } },
    dismissed: new Set<string>(),
    run: null,
    lastRunAt: variant === 'empty' ? undefined : now - 100 * 60 * 1000,
    generatedAt: now - 100 * 60 * 1000,
    accountCheckedAt: now - 5 * 60 * 1000,
    accountLastLoginAt: now - 3 * DAY_MS,
  };
}

function stageForProgress(progress: number): RunStatus['stage'] {
  if (progress < 0.08) return 'auth';
  if (progress < 0.22) return 'signals';
  if (progress < 0.48) return 'history';
  if (progress < 0.7) return 'candidates';
  if (progress < 0.9) return 'enrich';
  return 'score';
}

function idleStatus(state: MockState, justFinished: boolean): RunStatus {
  return {
    running: false,
    stage: justFinished ? 'done' : 'idle',
    progress: justFinished ? 1 : 0,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    requestCount: justFinished ? 96 : undefined,
    nextDueAt: nextUpdateAt(state.settings.updateHour),
    loggedOut: state.loggedOut,
  };
}

function computeStatus(state: MockState): RunStatus {
  const now = Date.now();
  if (state.run) {
    const progress = Math.min(1, Math.max(0, (now - state.run.startedAt) / RUN_DURATION_MS));
    if (progress >= 1) {
      state.run = null;
      state.cleared = false;
      state.lastRunAt = now;
      state.generatedAt = now;
      state.lastError = undefined;
      return idleStatus(state, true);
    }
    return {
      running: true,
      stage: stageForProgress(progress),
      progress: round2(progress),
      startedAt: state.run.startedAt,
      lastRunAt: state.lastRunAt,
      requestCount: Math.round(progress * 96),
      nextDueAt: nextUpdateAt(state.settings.updateHour),
      loggedOut: state.loggedOut,
    };
  }
  return idleStatus(state, false);
}

function sanitizeSettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current, ...patch };
  next.perSection = clampInt(next.perSection, 2, 5, current.perSection);
  next.regionSections = clampInt(next.regionSections, 2, 5, current.regionSections);
  next.updateHour = clampInt(next.updateHour, 0, 23, current.updateHour);
  next.autoUpdate = Boolean(next.autoUpdate);
  next.showFloatingButton = Boolean(next.showFloatingButton);
  next.theme = next.theme === 'light' || next.theme === 'dark' ? next.theme : 'auto';
  next.tagWindow = next.tagWindow === '30d' || next.tagWindow === 'all' ? next.tagWindow : '7d';
  const sources = { ...current.enabledSources, ...(patch.enabledSources ?? {}) };
  next.enabledSources = {
    popular: Boolean(sources.popular),
    ranking: Boolean(sources.ranking),
    regionRanking: Boolean(sources.regionRanking),
    weekly: Boolean(sources.weekly),
    rcmd: Boolean(sources.rcmd),
    related: Boolean(sources.related),
  };
  return next;
}

/** 创建离线演示数据源 */
export function createMockApi(variant: MockVariant): UiApi {
  const state = createState(variant);
  const assertUsable = (): void => {
    if (variant === 'error') {
      throw new Error('演示错误：扩展后台无响应（?mock=error）。去掉 mock 参数或重试即可。');
    }
  };

  return {
    mode: 'mock',
    variant,

    async getDashboardData(): Promise<DashboardData> {
      assertUsable();
      await sleep(120);
      const status = computeStatus(state);
      if (state.cleared) {
        return {
          daily: null,
          profile: null,
          status,
          settings: { ...state.settings, enabledSources: { ...state.settings.enabledSources } },
          dismissed: [],
          account: buildAccount(state),
        };
      }
      const profile = state.loggedOut ? null : buildProfile(state);
      return {
        daily: buildDaily(state, profile, variant),
        profile,
        status,
        settings: { ...state.settings, enabledSources: { ...state.settings.enabledSources } },
        dismissed: [...state.dismissed],
        account: buildAccount(state),
      };
    },

    async getStatus(): Promise<RunStatus> {
      assertUsable();
      await sleep(40);
      return computeStatus(state);
    },

    async runNow(force = true): Promise<RunStatus> {
      assertUsable();
      await sleep(60);
      state.lastError = undefined;
      if (!state.run) state.run = { startedAt: Date.now(), force };
      return computeStatus(state);
    },

    async dismiss(bvid: string): Promise<void> {
      assertUsable();
      await sleep(40);
      state.dismissed.add(bvid);
    },

    async saveSettings(patch: Partial<Settings>): Promise<Settings> {
      assertUsable();
      await sleep(40);
      state.settings = sanitizeSettingsPatch(state.settings, patch);
      return { ...state.settings, enabledSources: { ...state.settings.enabledSources } };
    },

    async clearData(): Promise<void> {
      assertUsable();
      await sleep(60);
      state.cleared = true;
      state.dismissed.clear();
      state.settings = {
        ...DEFAULT_SETTINGS,
        enabledSources: { ...DEFAULT_SETTINGS.enabledSources },
        // 与真实后台保持一致：清空数据后暂停自动更新
        autoUpdate: false,
      };
      state.lastRunAt = undefined;
      state.lastError = undefined;
      state.run = null;
      state.accountCheckedAt = Date.now();
    },

    async refreshAccount(): Promise<AccountInfo> {
      assertUsable();
      // 留出可观察的 loading 窗口（e2e 会等 disabled / data-refreshing）
      await sleep(450);
      state.accountCheckedAt = Date.now();
      return buildAccount(state);
    },

    async getWeeklyReport(weekKey?: string): Promise<WeeklyReportResponse> {
      assertUsable();
      await sleep(140);
      if (state.loggedOut || state.cleared) return { report: null, reports: [] };
      const reports: WeeklyReportMeta[] = WEEKLY_REPORTS.map((report) => ({
        weekKey: report.weekKey,
        label: report.label,
        generatedAt: report.generatedAt,
      }));
      const report = weekKey
        ? WEEKLY_REPORTS.find((item) => item.weekKey === weekKey) ?? null
        : WEEKLY_REPORTS[0] ?? null;
      return { report, reports };
    },

    async exportBackup(): Promise<ExportBackupResult> {
      assertUsable();
      await sleep(160);
      return buildExportResult(state);
    },

    async importBackup(json: string): Promise<ImportSummary> {
      assertUsable();
      await sleep(600);
      const parsed = parseMockBackup(json);
      state.cleared = false;
      if (parsed.settings) {
        // 导入的 settings 真正写回 state，后续 GET_DASHBOARD_DATA 会反映到设置页控件
        state.settings = sanitizeSettingsPatch(state.settings, parsed.settings);
      }
      state.generatedAt = Date.now();
      state.lastRunAt = state.lastRunAt ?? Date.now();
      return parsed.summary;
    },
  };
}
