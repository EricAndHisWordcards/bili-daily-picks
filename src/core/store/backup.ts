/**
 * 数据备份：导出/导入 JSON 的构造与校验。
 *
 * 原则：
 * - 导入前先完整校验，校验通过后才允许覆盖现有数据；
 * - 只接受本扩展导出的格式（app + schemaVersion）；
 * - 字段白名单 + 数量上限，坏行丢弃并计入 dropped，避免坏文件把界面弄崩；
 * - 不执行文件里的任何代码/URL，不访问网络。
 */
import { BACKUP_APP, BACKUP_LIMITS, BACKUP_SCHEMA_VERSION } from '../../shared/constants';
import { normalizeStat } from '../../shared/stat';
import type {
  AffinityRow,
  BackupData,
  BackupFile,
  DailyResult,
  DismissEntry,
  GrowthInfo,
  HistoryRecord,
  ImportSummary,
  Profile,
  ProfileSignals,
  Recommendation,
  Section,
  SnapshotRow,
  SourceKind,
  SourceRef,
  TagRow,
  UpRow,
  VideoStat,
  WeeklyReport,
} from '../../shared/types';
import { sanitizeSettings } from './settings';

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

export interface ParsedBackup {
  file: BackupFile;
  data: BackupData;
  summary: ImportSummary;
}

const SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  'popular',
  'ranking',
  'regionRanking',
  'weekly',
  'rcmd',
  'related',
]);

const SECTION_KINDS: ReadonlySet<Section['kind']> = new Set([
  'global',
  'region',
  'growth',
  'weekly',
]);

const TAG_KINDS: ReadonlySet<TagRow['kind']> = new Set(['title', 'tag', 'region']);

const TREND_STATUSES = new Set(['new', 'up', 'down', 'gone', 'steady']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 备份里的图片地址只允许 B站 CDN 域名且必须是 https。
 * 避免伪造备份让仪表盘向任意域名发起图片请求（泄露网络元数据）。
 */
const ALLOWED_IMAGE_SUFFIXES = ['hdslb.com', 'bilibili.com', 'bilivideo.com'] as const;

function safeImageUrl(value: unknown): string {
  const raw = optStr(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    const allowed = ALLOWED_IMAGE_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    return allowed ? raw : '';
  } catch {
    return '';
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 数组超出导入上限时被截断的数量，计入 dropped，避免静默丢数据 */
function overflowCount(value: unknown, limit: number): number {
  return Array.isArray(value) ? Math.max(0, value.length - limit) : 0;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown): number {
  return Math.max(0, num(value, 0));
}

function positive(value: unknown): number {
  const n = num(value, 0);
  return n > 0 ? n : 0;
}

function clamp01(value: unknown): number {
  return Math.min(1, Math.max(0, num(value, 0)));
}

function bool(value: unknown): boolean {
  return value === true;
}

/* ------------------------------------------------------------------ */
/* 单项清洗                                                            */
/* ------------------------------------------------------------------ */

function sanitizeHistory(raw: unknown): { rows: HistoryRecord[]; dropped: number } {
  const rows: HistoryRecord[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, BACKUP_LIMITS.history)) {
    if (!isObject(item)) {
      dropped += 1;
      continue;
    }
    const bvid = str(item.bvid);
    const title = str(item.title);
    const viewedAt = positive(item.viewedAt);
    if (!bvid || !title || viewedAt <= 0) {
      dropped += 1;
      continue;
    }
    rows.push({
      bvid,
      title,
      cover: optStr(item.cover),
      viewedAt,
      duration: nonNegative(item.duration),
      progress: nonNegative(item.progress),
      tname: str(item.tname),
      parentRegion: str(item.parentRegion) || '其他',
      authorMid: positive(item.authorMid) || undefined,
      authorName: optStr(item.authorName),
      isFav: item.isFav === true ? true : undefined,
    });
  }
  return { rows, dropped };
}

function sanitizeSnapshots(raw: unknown): { rows: SnapshotRow[]; dropped: number } {
  const rows: SnapshotRow[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, BACKUP_LIMITS.snapshots)) {
    if (!isObject(item)) {
      dropped += 1;
      continue;
    }
    const bvid = str(item.bvid);
    const ts = positive(item.ts);
    if (!bvid || ts <= 0) {
      dropped += 1;
      continue;
    }
    rows.push({ bvid, ts, stat: normalizeStat(item.stat as Partial<VideoStat>) });
  }
  return { rows, dropped };
}

function sanitizeOwner(raw: unknown): Recommendation['owner'] {
  const obj = isObject(raw) ? raw : {};
  return {
    mid: positive(obj.mid),
    name: str(obj.name),
    face: safeImageUrl(obj.face) || undefined,
  };
}

function sanitizeSources(raw: unknown): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const item of asArray(raw).slice(0, 8)) {
    if (!isObject(item)) continue;
    const kind = str(item.kind) as SourceKind;
    if (!SOURCE_KINDS.has(kind)) continue;
    const ref: SourceRef = { kind };
    if (item.rank !== undefined) ref.rank = positive(item.rank) || undefined;
    if (item.issue !== undefined) ref.issue = positive(item.issue) || undefined;
    if (item.rid !== undefined) ref.rid = positive(item.rid) || undefined;
    if (item.regionName !== undefined) ref.regionName = optStr(item.regionName);
    refs.push(ref);
  }
  return refs;
}

function sanitizeGrowth(raw: unknown): GrowthInfo | null {
  if (!isObject(raw)) return null;
  return {
    hours: nonNegative(raw.hours),
    view: nonNegative(raw.view),
    favorite: nonNegative(raw.favorite),
    reply: nonNegative(raw.reply),
    estimated: bool(raw.estimated),
  };
}

function sanitizeRecommendation(raw: unknown): Recommendation | null {
  if (!isObject(raw)) return null;
  const bvid = str(raw.bvid);
  const title = str(raw.title);
  if (!bvid || !title) return null;
  return {
    bvid,
    title,
    cover: safeImageUrl(raw.cover),
    duration: nonNegative(raw.duration),
    pubdate: num(raw.pubdate),
    owner: sanitizeOwner(raw.owner),
    stat: normalizeStat(raw.stat as Partial<VideoStat>),
    tname: str(raw.tname),
    parentRegion: str(raw.parentRegion) || '其他',
    score: clamp01(raw.score),
    sources: sanitizeSources(raw.sources),
    reason: str(raw.reason),
    badges: asArray(raw.badges)
      .filter((value): value is string => typeof value === 'string')
      .slice(0, 6),
    growth: raw.growth === undefined ? null : sanitizeGrowth(raw.growth),
  };
}

function sanitizeSections(raw: unknown): { sections: Section[]; dropped: number } {
  const sections: Section[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, 16)) {
    if (!isObject(item)) {
      dropped += 1;
      continue;
    }
    const kind = str(item.kind) as Section['kind'];
    if (!SECTION_KINDS.has(kind)) {
      dropped += 1;
      continue;
    }
    const items: Recommendation[] = [];
    for (const entry of asArray(item.items).slice(0, 12)) {
      const recommendation = sanitizeRecommendation(entry);
      if (recommendation) items.push(recommendation);
      else dropped += 1;
    }
    sections.push({
      id: str(item.id) || `${kind}:${sections.length}`,
      title: str(item.title) || '推荐',
      subtitle: optStr(item.subtitle),
      kind,
      items,
    });
  }
  return { sections, dropped };
}

function sanitizeDaily(raw: unknown): { rows: DailyResult[]; dropped: number } {
  const rows: DailyResult[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, BACKUP_LIMITS.daily)) {
    if (!isObject(item)) {
      dropped += 1;
      continue;
    }
    const date = str(item.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dropped += 1;
      continue;
    }
    const { sections, dropped: sectionDropped } = sanitizeSections(item.sections);
    dropped += sectionDropped;
    const mode = item.mode === 'public' ? 'public' : 'full';
    const meta = isObject(item.meta) ? item.meta : {};
    const summary = isObject(item.profileSummary) ? item.profileSummary : {};
    rows.push({
      date,
      generatedAt: num(item.generatedAt),
      mid: positive(item.mid) || undefined,
      mode,
      sections,
      profileSummary: {
        topRegions: sanitizeAffinityRows(summary.topRegions).rows,
        topTags: sanitizeTagRows(summary.topTags).rows,
      },
      meta: {
        candidates: nonNegative(meta.candidates),
        requests: nonNegative(meta.requests),
        durationMs: nonNegative(meta.durationMs),
        degraded: optStr(meta.degraded),
        sources: asArray(meta.sources).filter(
          (value): value is SourceKind => typeof value === 'string' && SOURCE_KINDS.has(value as SourceKind),
        ),
      },
    });
  }
  return { rows, dropped };
}

function sanitizeAffinityRows(raw: unknown): { rows: AffinityRow[]; dropped: number } {
  const rows: AffinityRow[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, 50)) {
    if (!isObject(item) || !str(item.name)) {
      dropped += 1;
      continue;
    }
    rows.push({
      name: str(item.name),
      affinity: clamp01(item.affinity),
      count: nonNegative(item.count),
    });
  }
  return { rows, dropped };
}

function sanitizeTagRows(raw: unknown): { rows: TagRow[]; dropped: number } {
  const rows: TagRow[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, 80)) {
    if (!isObject(item) || !str(item.term)) {
      dropped += 1;
      continue;
    }
    const kind = str(item.kind) as TagRow['kind'];
    rows.push({
      term: str(item.term),
      weight: clamp01(item.weight),
      count: nonNegative(item.count),
      kind: TAG_KINDS.has(kind) ? kind : 'title',
    });
  }
  return { rows, dropped };
}

function sanitizeUpRows(raw: unknown): { rows: UpRow[]; dropped: number } {
  const rows: UpRow[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, 50)) {
    if (!isObject(item) || !positive(item.mid)) {
      dropped += 1;
      continue;
    }
    const followedAt = positive(item.followedAt);
    rows.push({
      mid: positive(item.mid),
      name: str(item.name),
      affinity: clamp01(item.affinity),
      count: nonNegative(item.count),
      ...(followedAt > 0 ? { followedAt } : {}),
    });
  }
  return { rows, dropped };
}

function sanitizeProfileSignals(raw: unknown): { signals?: ProfileSignals; dropped: number } {
  if (!isObject(raw)) return { dropped: 0 };
  let dropped = 0;
  const favoriteUps = sanitizeUpRows(raw.favoriteUps);
  const favoriteTags = sanitizeTagRows(raw.favoriteTags);
  const followedUps = sanitizeUpRows(raw.followedUps);
  const watchLaterRegions = sanitizeAffinityRows(raw.watchLaterRegions);
  const watchLaterTags = sanitizeTagRows(raw.watchLaterTags);
  dropped +=
    favoriteUps.dropped +
    favoriteTags.dropped +
    followedUps.dropped +
    watchLaterRegions.dropped +
    watchLaterTags.dropped;
  return {
    dropped,
    signals: {
      fetchedAt: num(raw.fetchedAt),
      favoriteFolders: nonNegative(raw.favoriteFolders),
      favoriteCount: nonNegative(raw.favoriteCount),
      favoriteSampled: nonNegative(raw.favoriteSampled),
      favoriteUps: favoriteUps.rows,
      favoriteTags: favoriteTags.rows,
      followedTotal: nonNegative(raw.followedTotal),
      followedMids: asArray(raw.followedMids)
        .map((value) => positive(value))
        .filter((value) => value > 0)
        .slice(0, 200),
      followedUps: followedUps.rows,
      watchLaterCount: nonNegative(raw.watchLaterCount),
      watchLaterSampled: nonNegative(raw.watchLaterSampled),
      watchLaterRegions: watchLaterRegions.rows,
      watchLaterTags: watchLaterTags.rows,
      favoriteFallback: raw.favoriteFallback === true ? true : undefined,
    },
  };
}

function sanitizeProfile(raw: unknown): { profile: Profile | null; dropped: number } {
  if (!isObject(raw)) return { profile: null, dropped: 0 };
  const regions = sanitizeAffinityRows(raw.regions);
  const tags = sanitizeTagRows(raw.tags);
  const ups = sanitizeUpRows(raw.ups);
  const signals = sanitizeProfileSignals(raw.signals);
  const hours = asArray(raw.hours)
    .slice(0, 24)
    .map((value) => clamp01(value));
  while (hours.length < 24) hours.push(0);
  const sample = isObject(raw.sample) ? raw.sample : {};
  const preferred = isObject(raw.preferredDuration) ? raw.preferredDuration : {};
  return {
    profile: {
      mid: positive(raw.mid) || undefined,
      uname: optStr(raw.uname),
      avatar: safeImageUrl(raw.avatar) || undefined,
      generatedAt: num(raw.generatedAt),
      sample: {
        total: nonNegative(sample.total),
        last7d: nonNegative(sample.last7d),
        windowDays: nonNegative(sample.windowDays) || 90,
      },
      regions: regions.rows,
      tags: tags.rows,
      ups: ups.rows,
      hours,
      completionRate: clamp01(raw.completionRate),
      avgDuration: nonNegative(raw.avgDuration),
      preferredDuration: {
        p10: nonNegative(preferred.p10),
        p90: nonNegative(preferred.p90),
      },
      signals: signals.signals,
    },
    dropped: regions.dropped + tags.dropped + ups.dropped + signals.dropped,
  };
}

function sanitizeDismissed(raw: unknown): { rows: DismissEntry[]; dropped: number } {
  const rows: DismissEntry[] = [];
  let dropped = 0;
  for (const item of asArray(raw).slice(0, BACKUP_LIMITS.dismissed)) {
    if (!isObject(item) || !str(item.bvid)) {
      dropped += 1;
      continue;
    }
    rows.push({ bvid: str(item.bvid), at: num(item.at) });
  }
  return { rows, dropped };
}

function sanitizeWeekly(raw: unknown): { rows: WeeklyReport[]; dropped: number } {
  const rows: WeeklyReport[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of asArray(raw).slice(0, BACKUP_LIMITS.weekly)) {
    if (!isObject(item)) {
      dropped += 1;
      continue;
    }
    const weekKey = str(item.weekKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey) || seen.has(weekKey)) {
      dropped += 1;
      continue;
    }
    const stats = isObject(item.stats) ? item.stats : {};
    const previous = isObject(item.previous) ? item.previous : {};
    const daily = asArray(item.daily).slice(0, 7).map((row) => {
      const entry = isObject(row) ? row : {};
      return {
        date: str(entry.date),
        weekday: str(entry.weekday),
        watched: nonNegative(entry.watched),
        watchSeconds: nonNegative(entry.watchSeconds),
      };
    });
    const tags = asArray(item.tags).slice(0, 30).map((row) => {
      const entry = isObject(row) ? row : {};
      const status = str(entry.status);
      return {
        term: str(entry.term),
        weight: clamp01(entry.weight),
        previousWeight: clamp01(entry.previousWeight),
        delta: num(entry.delta),
        count: nonNegative(entry.count),
        previousCount: nonNegative(entry.previousCount),
        status: (TREND_STATUSES.has(status) ? status : 'steady') as WeeklyReport['tags'][number]['status'],
      };
    }).filter((row) => row.term);
    const regions = asArray(item.regions).slice(0, 20).map((row) => {
      const entry = isObject(row) ? row : {};
      const status = str(entry.status);
      return {
        name: str(entry.name),
        weight: clamp01(entry.weight),
        previousWeight: clamp01(entry.previousWeight),
        delta: num(entry.delta),
        count: nonNegative(entry.count),
        previousCount: nonNegative(entry.previousCount),
        status: (TREND_STATUSES.has(status) ? status : 'steady') as WeeklyReport['regions'][number]['status'],
      };
    }).filter((row) => row.name);
    rows.push({
      weekKey,
      weekStart: num(item.weekStart),
      weekEnd: num(item.weekEnd),
      label: str(item.label) || weekKey,
      generatedAt: num(item.generatedAt),
      stats: {
        watched: nonNegative(stats.watched),
        watchSeconds: nonNegative(stats.watchSeconds),
        activeDays: nonNegative(stats.activeDays),
        completionRate: clamp01(stats.completionRate),
      },
      previous: {
        watched: nonNegative(previous.watched),
        watchSeconds: nonNegative(previous.watchSeconds),
        activeDays: nonNegative(previous.activeDays),
        completionRate: clamp01(previous.completionRate),
      },
      daily,
      tags,
      rising: asArray(item.rising).slice(0, 10).map((row) => {
        const entry = isObject(row) ? row : {};
        return { term: str(entry.term), delta: num(entry.delta), weight: clamp01(entry.weight) };
      }).filter((row) => row.term),
      falling: asArray(item.falling).slice(0, 10).map((row) => {
        const entry = isObject(row) ? row : {};
        return { term: str(entry.term), delta: num(entry.delta), weight: clamp01(entry.weight) };
      }).filter((row) => row.term),
      regions,
      ups: asArray(item.ups).slice(0, 20).map((row) => {
        const entry = isObject(row) ? row : {};
        return {
          mid: positive(entry.mid),
          name: str(entry.name),
          count: nonNegative(entry.count),
          previousCount: nonNegative(entry.previousCount),
          delta: num(entry.delta),
        };
      }).filter((row) => row.mid > 0 || row.name),
      summary: asArray(item.summary)
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 6),
      sample: {
        currentTotal: nonNegative(isObject(item.sample) ? item.sample.currentTotal : 0),
        previousTotal: nonNegative(isObject(item.sample) ? item.sample.previousTotal : 0),
      },
    });
    seen.add(weekKey);
  }
  return { rows, dropped };
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export function buildBackupFile(data: BackupData, appVersion: string): BackupFile {
  return {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion,
    exportedAt: Date.now(),
    data,
  };
}

export function backupFilename(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `bili-daily-picks-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/**
 * 解析并校验备份 JSON。校验失败抛 BackupValidationError；成功时不会修改现有数据。
 */
export function parseBackup(json: string): ParsedBackup {
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > BACKUP_LIMITS.jsonBytes) {
    throw new BackupValidationError(
      `备份文件过大（${(bytes / 1024 / 1024).toFixed(1)}MB），上限 ${BACKUP_LIMITS.jsonBytes / 1024 / 1024}MB`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BackupValidationError('备份文件不是合法 JSON');
  }
  if (!isObject(raw)) throw new BackupValidationError('备份文件根节点必须是对象');
  if (raw.app !== BACKUP_APP) throw new BackupValidationError('不是本扩展导出的备份文件');
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupValidationError(
      `备份版本不支持（${String(raw.schemaVersion)}），当前只支持 ${BACKUP_SCHEMA_VERSION}`,
    );
  }
  if (!isObject(raw.data)) throw new BackupValidationError('备份缺少 data 字段');

  const dataRaw = raw.data;
  const settings = sanitizeSettings(dataRaw.settings);
  const history = sanitizeHistory(dataRaw.history);
  const snapshots = sanitizeSnapshots(dataRaw.snapshots);
  const daily = sanitizeDaily(dataRaw.daily);
  const profile = sanitizeProfile(dataRaw.profile);
  const dismissed = sanitizeDismissed(dataRaw.dismissed);
  const weekly = sanitizeWeekly(dataRaw.weeklyReports);

  const data: BackupData = {
    settings,
    history: history.rows,
    snapshots: snapshots.rows,
    daily: daily.rows,
    profile: profile.profile,
    dismissed: dismissed.rows,
    weeklyReports: weekly.rows,
  };
  const dropped =
    history.dropped +
    snapshots.dropped +
    daily.dropped +
    profile.dropped +
    dismissed.dropped +
    weekly.dropped +
    overflowCount(dataRaw.history, BACKUP_LIMITS.history) +
    overflowCount(dataRaw.snapshots, BACKUP_LIMITS.snapshots) +
    overflowCount(dataRaw.daily, BACKUP_LIMITS.daily) +
    overflowCount(dataRaw.dismissed, BACKUP_LIMITS.dismissed) +
    overflowCount(dataRaw.weeklyReports, BACKUP_LIMITS.weekly);

  const summary: ImportSummary = {
    history: data.history.length,
    snapshots: data.snapshots.length,
    daily: data.daily.length,
    dismissed: data.dismissed.length,
    weekly: data.weeklyReports?.length ?? 0,
    hasProfile: Boolean(data.profile),
    dropped,
  };

  return {
    file: {
      app: BACKUP_APP,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: str(raw.appVersion, 'unknown'),
      exportedAt: num(raw.exportedAt),
      data,
    },
    data,
    summary,
  };
}
