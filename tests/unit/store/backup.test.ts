import { describe, expect, it } from 'vitest';
import {
  BACKUP_APP,
  BACKUP_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
} from '../../../src/shared/constants';
import { EMPTY_STAT } from '../../../src/shared/constants';
import {
  BackupValidationError,
  backupFilename,
  buildBackupFile,
  parseBackup,
} from '../../../src/core/store/backup';
import type {
  BackupData,
  DailyResult,
  HistoryRecord,
  Profile,
  SnapshotRow,
  WeeklyReport,
} from '../../../src/shared/types';

const history: HistoryRecord[] = [
  {
    bvid: 'BV1aa411c7aa',
    title: '测试视频一',
    viewedAt: 1_790_000_000,
    duration: 600,
    progress: 480,
    tname: '手机游戏',
    parentRegion: '游戏',
    authorMid: 42,
    authorName: '测试UP',
  },
  {
    bvid: 'BV1bb411c7bb',
    title: '测试视频二',
    viewedAt: 1_790_100_000,
    duration: 300,
    progress: 60,
    tname: '数码',
    parentRegion: '科技',
  },
];

const snapshots: SnapshotRow[] = [
  { bvid: 'BV1aa411c7aa', ts: 1_790_000_000, stat: { ...EMPTY_STAT, view: 1000 } },
];

const daily: DailyResult = {
  date: '2026-10-20',
  generatedAt: 1_790_000_000_000,
  mid: 123,
  mode: 'full',
  sections: [
    {
      id: 'today',
      title: '今日必看',
      kind: 'global',
      items: [
        {
          bvid: 'BV1aa411c7aa',
          title: '测试视频一',
          cover: '',
          duration: 600,
          pubdate: 1_789_000_000,
          owner: { mid: 42, name: '测试UP' },
          stat: { ...EMPTY_STAT, view: 1000 },
          tname: '手机游戏',
          parentRegion: '游戏',
          score: 0.8,
          sources: [{ kind: 'popular' }],
          reason: '测试理由',
          badges: ['热门'],
          growth: null,
        },
      ],
    },
  ],
  profileSummary: { topRegions: [], topTags: [] },
  meta: { candidates: 10, requests: 3, durationMs: 100, sources: ['popular'] },
};

const profile: Profile = {
  mid: 123,
  uname: '测试用户',
  generatedAt: 1_790_000_000_000,
  sample: { total: 2, last7d: 2, windowDays: 90 },
  regions: [{ name: '游戏', affinity: 1, count: 2 }],
  tags: [{ term: '游戏', weight: 1, count: 2, kind: 'region' }],
  ups: [{ mid: 42, name: '测试UP', affinity: 1, count: 2 }],
  hours: new Array(24).fill(0),
  completionRate: 0.8,
  avgDuration: 450,
  preferredDuration: { p10: 300, p90: 600 },
  signals: {
    fetchedAt: 1_790_000_000_000,
    favoriteFolders: 2,
    favoriteCount: 80,
    favoriteSampled: 60,
    favoriteUps: [{ mid: 42, name: '测试UP', affinity: 1, count: 3 }],
    favoriteTags: [{ term: '游戏', weight: 1, count: 3, kind: 'title' }],
    followedTotal: 10,
    followedMids: [42],
    followedUps: [{ mid: 42, name: '测试UP', affinity: 1, count: 1 }],
    watchLaterCount: 4,
    watchLaterSampled: 4,
    watchLaterRegions: [{ name: '游戏', affinity: 1, count: 4 }],
    watchLaterTags: [{ term: '游戏', weight: 1, count: 4, kind: 'title' }],
  },
};

const weekly: WeeklyReport = {
  weekKey: '2026-10-12',
  weekStart: 1_789_000_000_000,
  weekEnd: 1_789_604_800_000,
  label: '2026-10-12 ~ 2026-10-18',
  generatedAt: 1_790_000_000_000,
  stats: { watched: 2, watchSeconds: 540, activeDays: 2, completionRate: 0.8 },
  previous: { watched: 1, watchSeconds: 300, activeDays: 1, completionRate: 0.5 },
  daily: [],
  tags: [],
  rising: [],
  falling: [],
  regions: [],
  ups: [],
  summary: ['测试周报'],
  sample: { currentTotal: 2, previousTotal: 1 },
};

const backup: BackupData = {
  settings: { ...DEFAULT_SETTINGS },
  history,
  snapshots,
  daily: [daily],
  profile,
  dismissed: [{ bvid: 'BV1cc411c7cc', at: 1_790_000_000_000 }],
  weeklyReports: [weekly],
};

describe('backup', () => {
  it('导出→解析 往返保留数据与设置', () => {
    const file = buildBackupFile(backup, '0.2.0');
    expect(file.app).toBe(BACKUP_APP);
    expect(file.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.summary).toEqual({
      history: 2,
      snapshots: 1,
      daily: 1,
      dismissed: 1,
      weekly: 1,
      hasProfile: true,
      dropped: 0,
    });
    expect(parsed.data.settings.perSection).toBe(DEFAULT_SETTINGS.perSection);
    expect(parsed.data.history[0]!.bvid).toBe('BV1aa411c7aa');
    expect(parsed.data.profile?.signals?.favoriteCount).toBe(80);
    expect(parsed.data.weeklyReports?.[0]?.weekKey).toBe('2026-10-12');
    expect(parsed.data.daily[0]!.sections[0]!.items[0]!.score).toBe(0.8);
  });

  it('旧备份缺少 weeklyReports 时视为空数组', () => {
    const file = buildBackupFile(backup, '0.2.0');
    const legacy = { ...file, data: { ...file.data, weeklyReports: undefined } };
    const parsed = parseBackup(JSON.stringify(legacy));
    expect(parsed.data.weeklyReports).toEqual([]);
    expect(parsed.summary.weekly).toBe(0);
  });

  it('坏行被丢弃并计入 dropped，其余数据保留', () => {
    const file = buildBackupFile(backup, '0.2.0');
    const raw = JSON.parse(JSON.stringify(file)) as {
      data: { history: unknown[]; weeklyReports: unknown[] };
    };
    raw.data.history.unshift({ bvid: '', title: '缺 bvid' });
    raw.data.history.push('not-an-object');
    raw.data.weeklyReports.push({ weekKey: 'bad' });
    const parsed = parseBackup(JSON.stringify(raw));
    expect(parsed.summary.history).toBe(2);
    expect(parsed.summary.dropped).toBeGreaterThanOrEqual(3);
  });

  it('拒绝非本扩展/版本不符/坏 JSON，且不提供数据', () => {
    expect(() => parseBackup('not json')).toThrow(BackupValidationError);
    expect(() =>
      parseBackup(JSON.stringify({ app: 'other', schemaVersion: 1, data: {} })),
    ).toThrow(/不是本扩展/);
    expect(() =>
      parseBackup(JSON.stringify({ app: BACKUP_APP, schemaVersion: 99, data: {} })),
    ).toThrow(/版本不支持/);
    expect(() => parseBackup(JSON.stringify({ app: BACKUP_APP, schemaVersion: 1 }))).toThrow(
      /data/,
    );
  });

  it('设置与画像越界值被夹紧', () => {
    const file = buildBackupFile(backup, '0.2.0');
    const raw = JSON.parse(JSON.stringify(file)) as {
      data: { settings: Record<string, unknown>; profile: { completionRate: number } };
    };
    raw.data.settings.perSection = 99;
    raw.data.settings.theme = 'neon';
    raw.data.profile.completionRate = 3;
    const parsed = parseBackup(JSON.stringify(raw));
    expect(parsed.data.settings.perSection).toBe(5);
    expect(parsed.data.settings.theme).toBe('auto');
    expect(parsed.data.profile?.completionRate).toBe(1);
  });

  it('备份里的图片地址只允许 B站 CDN（https）', () => {
    const file = buildBackupFile(backup, '0.2.0');
    const raw = JSON.parse(JSON.stringify(file)) as {
      data: {
        daily: Array<{ sections: Array<{ items: Array<{ cover: string; owner: { face?: string } }> }> }>;
        profile: { avatar?: string };
      };
    };
    raw.data.daily[0]!.sections[0]!.items[0]!.cover = 'https://evil.example/track.png';
    raw.data.daily[0]!.sections[0]!.items[0]!.owner.face = 'https://evil.example/avatar.png';
    raw.data.profile.avatar = 'https://i0.hdslb.com/bfs/face/ok.png';
    const parsed = parseBackup(JSON.stringify(raw));
    const item = parsed.data.daily[0]!.sections[0]!.items[0]!;
    expect(item.cover).toBe('');
    expect(item.owner.face).toBeUndefined();
    expect(parsed.data.profile?.avatar).toBe('https://i0.hdslb.com/bfs/face/ok.png');
  });

  it('数组超过上限时截断数量计入 dropped', () => {
    const many = Array.from({ length: 6000 }, (_, index) => ({
      ...history[0]!,
      bvid: `BV1xx${String(index).padStart(7, '0')}`,
    }));
    const file = buildBackupFile({ ...backup, history: many }, '0.2.0');
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.data.history).toHaveLength(5000);
    expect(parsed.summary.dropped).toBeGreaterThanOrEqual(1000);
  });

  it('文件名包含日期与时间', () => {
    const name = backupFilename(new Date(2026, 9, 21, 4, 5).getTime());
    expect(name).toBe('bili-daily-picks-backup-20261021-0405.json');
  });
});
