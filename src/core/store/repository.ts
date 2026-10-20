import { RETENTION_DAYS } from '../../shared/constants';
import type {
  BackupData,
  DailyResult,
  DismissEntry,
  HistoryRecord,
  PipelineState,
  Profile,
  SnapshotRow,
  StoredDaily,
  WeeklyReport,
  WeeklyReportMeta,
} from '../../shared/types';
import { DAY } from '../../shared/time';
import {
  idbBulkPut,
  idbClear,
  idbDelete,
  idbDeleteRange,
  idbGet,
  idbGetAll,
  idbGetAllByIndex,
  idbGetLast,
  idbPut,
  type StoreName,
} from './db';
import type { CacheEntry, CacheStore } from '../api/http';

/** 数据访问接口。engine 只依赖这个接口，测试里用内存实现。 */
export interface Repository {
  getKv<T>(key: string): Promise<T | undefined>;
  setKv<T>(key: string, value: T): Promise<void>;
  deleteKv(key: string): Promise<void>;

  replaceHistory(rows: HistoryRecord[]): Promise<void>;
  getHistory(): Promise<HistoryRecord[]>;

  putSnapshots(rows: SnapshotRow[]): Promise<void>;
  getSnapshots(bvid: string): Promise<SnapshotRow[]>;
  getSnapshotsFor(bvids: string[], sinceTs: number): Promise<Map<string, SnapshotRow[]>>;
  getAllSnapshots(): Promise<SnapshotRow[]>;
  deleteSnapshotsBefore(ts: number): Promise<void>;

  saveDaily(result: DailyResult): Promise<void>;
  getDaily(date: string): Promise<DailyResult | undefined>;
  getLatestDaily(): Promise<DailyResult | undefined>;
  getAllDaily(): Promise<DailyResult[]>;

  saveProfile(profile: Profile): Promise<void>;
  getProfile(): Promise<Profile | null>;

  saveWeeklyReport(report: WeeklyReport): Promise<void>;
  getWeeklyReport(weekKey: string): Promise<WeeklyReport | undefined>;
  listWeeklyReports(): Promise<WeeklyReportMeta[]>;
  pruneWeeklyReports(keep?: number): Promise<void>;

  addDismissed(bvid: string): Promise<void>;
  getDismissed(): Promise<DismissEntry[]>;

  savePipeline(state: PipelineState): Promise<void>;
  getPipeline(): Promise<PipelineState | undefined>;
  clearPipeline(): Promise<void>;

  /** 备份恢复：整体替换业务数据（保留 kv 缓存） */
  replaceAllData(data: BackupData): Promise<void>;

  prune(now?: number): Promise<void>;
  clearAll(): Promise<void>;
}

interface KvRow<T> {
  key: string;
  value: T;
  expiresAt?: number;
}

interface StoredProfile extends Profile {
  id: string;
}

interface StoredSnapshot extends SnapshotRow {
  id: string;
}

interface StoredPipeline {
  id: string;
  state: PipelineState;
}

const now = () => Date.now();

export function createIdbRepository(): Repository {
  const repo: Repository = {
    async getKv<T>(key: string) {
      const row = await idbGet<KvRow<T>>('kv', key);
      if (!row) return undefined;
      if (row.expiresAt !== undefined && row.expiresAt < now()) {
        await idbDelete('kv', key);
        return undefined;
      }
      return row.value;
    },

    async setKv<T>(key: string, value: T) {
      const row: KvRow<T> = { key, value };
      await idbPut('kv', row);
    },

    async deleteKv(key: string) {
      await idbDelete('kv', key);
    },

    async replaceHistory(rows: HistoryRecord[]) {
      await idbClear('history');
      await idbBulkPut('history', rows);
    },

    async getHistory() {
      const rows = await idbGetAll<HistoryRecord>('history');
      return rows.sort((a, b) => b.viewedAt - a.viewedAt);
    },

    async putSnapshots(rows: SnapshotRow[]) {
      const stored: StoredSnapshot[] = rows.map((row) => ({ ...row, id: `${row.bvid}:${row.ts}` }));
      await idbBulkPut('snapshots', stored);
    },

    async getSnapshots(bvid: string) {
      const rows = await idbGetAllByIndex<StoredSnapshot>('snapshots', 'bvid', bvid);
      return rows.map(stripId).sort((a, b) => a.ts - b.ts);
    },

    async getSnapshotsFor(bvids: string[], sinceTs: number) {
      const result = new Map<string, SnapshotRow[]>();
      await Promise.all(
        bvids.map(async (bvid) => {
          const rows = (await repo.getSnapshots(bvid)).filter((row) => row.ts >= sinceTs);
          if (rows.length > 0) result.set(bvid, rows);
        }),
      );
      return result;
    },

    async getAllSnapshots() {
      const rows = await idbGetAll<StoredSnapshot>('snapshots');
      return rows.map(stripId).sort((a, b) => a.ts - b.ts);
    },

    async deleteSnapshotsBefore(ts: number) {
      await idbDeleteRange('snapshots', IDBKeyRange.upperBound(ts, true), 'ts');
    },

    async saveDaily(result: DailyResult) {
      const row: StoredDaily = { ...result, id: result.date };
      await idbPut('daily', row);
    },

    async getDaily(date: string) {
      const row = await idbGet<StoredDaily>('daily', date);
      return row ? stripDailyId(row) : undefined;
    },

    async getLatestDaily() {
      const row = await idbGetLast<StoredDaily>('daily');
      return row ? stripDailyId(row) : undefined;
    },

    async getAllDaily() {
      const rows = await idbGetAll<StoredDaily>('daily');
      return rows.map(stripDailyId).sort((a, b) => a.date.localeCompare(b.date));
    },

    async saveProfile(profile: Profile) {
      const row: StoredProfile = { ...profile, id: 'latest' };
      await idbPut('profile', row);
    },

    async getProfile() {
      const row = await idbGet<StoredProfile>('profile', 'latest');
      if (!row) return null;
      const { id: _id, ...profile } = row;
      return profile;
    },

    async saveWeeklyReport(report: WeeklyReport) {
      await idbPut('weekly', report);
    },

    async getWeeklyReport(weekKey: string) {
      return idbGet<WeeklyReport>('weekly', weekKey);
    },

    async listWeeklyReports() {
      const rows = await idbGetAll<WeeklyReport>('weekly');
      return rows
        .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
        .map(({ weekKey, label, generatedAt }) => ({ weekKey, label, generatedAt }));
    },

    async pruneWeeklyReports(keep = 12) {
      const rows = await idbGetAll<WeeklyReport>('weekly');
      const sorted = rows.sort((a, b) => b.weekKey.localeCompare(a.weekKey));
      for (const row of sorted.slice(Math.max(0, keep))) {
        await idbDelete('weekly', row.weekKey);
      }
    },

    async addDismissed(bvid: string) {
      const row: DismissEntry = { bvid, at: now() };
      await idbPut('dismissed', row);
    },

    async getDismissed() {
      return idbGetAll<DismissEntry>('dismissed');
    },

    async savePipeline(state: PipelineState) {
      const row: StoredPipeline = { id: 'current', state };
      await idbPut('pipeline', row);
    },

    async getPipeline() {
      const row = await idbGet<StoredPipeline>('pipeline', 'current');
      return row?.state;
    },

    async clearPipeline() {
      await idbDelete('pipeline', 'current');
    },

    async replaceAllData(data: BackupData) {
      const stores: StoreName[] = [
        'history',
        'snapshots',
        'daily',
        'profile',
        'dismissed',
        'weekly',
        'pipeline',
      ];
      for (const store of stores) await idbClear(store);
      await repo.replaceHistory(data.history);
      await repo.putSnapshots(data.snapshots);
      for (const row of data.daily) await repo.saveDaily(row);
      if (data.profile) await repo.saveProfile(data.profile);
      for (const row of data.dismissed) await idbPut('dismissed', row);
      for (const row of data.weeklyReports ?? []) await repo.saveWeeklyReport(row);
    },

    async prune(at = now()) {
      await repo.deleteSnapshotsBefore(Math.floor((at - RETENTION_DAYS.snapshots * DAY) / 1000));
      const historyCutoff = at - RETENTION_DAYS.history * DAY;
      const history = await repo.getHistory();
      const kept = history.filter((row) => row.viewedAt * 1000 >= historyCutoff);
      if (kept.length !== history.length) await repo.replaceHistory(kept);
      const dailyCutoff = dateKeyFrom(at - RETENTION_DAYS.daily * DAY);
      await idbDeleteRange('daily', IDBKeyRange.upperBound(dailyCutoff, true));
      await repo.pruneWeeklyReports(12);
    },

    async clearAll() {
      const stores: StoreName[] = [
        'kv',
        'history',
        'snapshots',
        'daily',
        'profile',
        'dismissed',
        'pipeline',
        'weekly',
      ];
      for (const store of stores) await idbClear(store);
    },
  };
  return repo;
}

function stripId(row: StoredSnapshot): SnapshotRow {
  const { bvid, ts, stat } = row;
  return { bvid, ts, stat };
}

function stripDailyId(row: StoredDaily): DailyResult {
  const { id: _id, ...rest } = row;
  return rest;
}

function dateKeyFrom(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把 Repository 的 kv 适配成 BiliApi 需要的缓存接口（带 TTL） */
export function createRepositoryCache(repo: Repository): CacheStore {
  return {
    async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
      const entry = await repo.getKv<CacheEntry<T>>(`cache:${key}`);
      if (!entry || typeof entry.expiresAt !== 'number') return undefined;
      if (entry.expiresAt < now()) {
        await repo.deleteKv(`cache:${key}`);
        return undefined;
      }
      return entry;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      const entry: CacheEntry<T> = { value, expiresAt: now() + ttlMs };
      await repo.setKv(`cache:${key}`, entry);
    },
    async delete(key: string): Promise<void> {
      await repo.deleteKv(`cache:${key}`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 内存实现：单元测试与 fixture 生成用                                  */
/* ------------------------------------------------------------------ */

export function createMemoryRepository(): Repository {
  const kv = new Map<string, unknown>();
  let history: HistoryRecord[] = [];
  let snapshots: SnapshotRow[] = [];
  let daily = new Map<string, DailyResult>();
  let profile: Profile | null = null;
  let dismissed = new Map<string, DismissEntry>();
  let pipeline: PipelineState | undefined;
  let weekly = new Map<string, WeeklyReport>();

  const repo: Repository = {
    async getKv<T>(key: string) {
      return kv.get(key) as T | undefined;
    },
    async setKv<T>(key: string, value: T) {
      kv.set(key, value);
    },
    async deleteKv(key: string) {
      kv.delete(key);
    },
    async replaceHistory(rows: HistoryRecord[]) {
      history = [...rows];
    },
    async getHistory() {
      return [...history].sort((a, b) => b.viewedAt - a.viewedAt);
    },
    async putSnapshots(rows: SnapshotRow[]) {
      const index = new Map(snapshots.map((row) => [`${row.bvid}:${row.ts}`, row]));
      for (const row of rows) index.set(`${row.bvid}:${row.ts}`, row);
      snapshots = [...index.values()];
    },
    async getSnapshots(bvid: string) {
      return snapshots.filter((row) => row.bvid === bvid).sort((a, b) => a.ts - b.ts);
    },
    async getSnapshotsFor(bvids: string[], sinceTs: number) {
      const result = new Map<string, SnapshotRow[]>();
      for (const bvid of bvids) {
        const rows = snapshots.filter((row) => row.bvid === bvid && row.ts >= sinceTs);
        if (rows.length > 0) result.set(bvid, rows.sort((a, b) => a.ts - b.ts));
      }
      return result;
    },
    async getAllSnapshots() {
      return [...snapshots].sort((a, b) => a.ts - b.ts);
    },
    async deleteSnapshotsBefore(ts: number) {
      snapshots = snapshots.filter((row) => row.ts >= ts);
    },
    async saveDaily(result: DailyResult) {
      daily.set(result.date, result);
    },
    async getDaily(date: string) {
      return daily.get(date);
    },
    async getLatestDaily() {
      const keys = [...daily.keys()].sort();
      const last = keys.at(-1);
      return last ? daily.get(last) : undefined;
    },
    async getAllDaily() {
      return [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
    async saveProfile(next: Profile) {
      profile = next;
    },
    async getProfile() {
      return profile;
    },
    async saveWeeklyReport(report: WeeklyReport) {
      weekly.set(report.weekKey, report);
    },
    async getWeeklyReport(weekKey: string) {
      return weekly.get(weekKey);
    },
    async listWeeklyReports() {
      return [...weekly.values()]
        .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
        .map(({ weekKey, label, generatedAt }) => ({ weekKey, label, generatedAt }));
    },
    async pruneWeeklyReports(keep = 12) {
      const sorted = [...weekly.values()].sort((a, b) => b.weekKey.localeCompare(a.weekKey));
      for (const row of sorted.slice(Math.max(0, keep))) weekly.delete(row.weekKey);
    },
    async addDismissed(bvid: string) {
      dismissed.set(bvid, { bvid, at: now() });
    },
    async getDismissed() {
      return [...dismissed.values()];
    },
    async savePipeline(state: PipelineState) {
      pipeline = state;
    },
    async getPipeline() {
      return pipeline;
    },
    async clearPipeline() {
      pipeline = undefined;
    },
    async replaceAllData(data: BackupData) {
      history = [...data.history];
      snapshots = [...data.snapshots];
      daily = new Map(data.daily.map((row) => [row.date, row]));
      profile = data.profile;
      dismissed = new Map(data.dismissed.map((row) => [row.bvid, row]));
      weekly = new Map((data.weeklyReports ?? []).map((row) => [row.weekKey, row]));
      pipeline = undefined;
    },
    async prune(at = now()) {
      snapshots = snapshots.filter(
        (row) => row.ts >= Math.floor((at - RETENTION_DAYS.snapshots * DAY) / 1000),
      );
      history = history.filter((row) => row.viewedAt * 1000 >= at - RETENTION_DAYS.history * DAY);
      const sorted = [...weekly.values()].sort((a, b) => b.weekKey.localeCompare(a.weekKey));
      for (const row of sorted.slice(12)) weekly.delete(row.weekKey);
    },
    async clearAll() {
      kv.clear();
      history = [];
      snapshots = [];
      daily = new Map();
      profile = null;
      dismissed = new Map();
      pipeline = undefined;
      weekly = new Map();
    },
  };
  return repo;
}
