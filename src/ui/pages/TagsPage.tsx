/** 我的标签：标签云、分区偏好、常看 UP、兴趣信号、24h 观看时段、画像总结。 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AffinityRow,
  DashboardData,
  Profile,
  ProfileSignals,
  Settings,
  TagRow,
  UpRow,
} from '../../shared/types';
import { formatPercent } from '../../shared/format';
import { formatDuration } from '../../shared/time';
import { Avatar } from '../components/Avatar';
import { PageIntro } from '../components/PageIntro';
import { Segmented } from '../components/Controls';
import { EmptyState, Notice, StatCard } from '../components/States';
import {
  IconClock,
  IconLock,
  IconSignal,
  IconSpark,
  IconStar,
  IconTag,
  IconTrend,
  IconUser,
} from '../components/Icons';

interface TagsPageProps {
  data: DashboardData;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* 标签云                                                              */
/* ------------------------------------------------------------------ */

function TagCloud({ tags }: { tags: TagRow[] }) {
  const maxWeight = Math.max(...tags.map((tag) => tag.weight), 0.0001);
  return (
    <div className="tag-cloud" data-testid="tag-cloud">
      {tags.map((tag, index) => {
        const weight = Math.max(0.16, tag.weight / maxWeight);
        const fontSize = 12 + weight * 7;
        return (
          <span
            key={tag.term}
            data-testid="tag"
            data-kind={tag.kind}
            data-tone={index % 4}
            className="tag-pill"
            style={{ fontSize: `${fontSize.toFixed(1)}px`, animationDelay: `${Math.min(index, 20) * 22}ms` }}
            title={`${tag.term} · 出现 ${tag.count} 次 · 权重 ${Math.round(weight * 100)}%`}
          >
            {tag.term}
            <span className="tag-count">{tag.count}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 分区偏好条                                                          */
/* ------------------------------------------------------------------ */

function RegionBars({ rows }: { rows: AffinityRow[] }) {
  const top = rows.slice(0, 10);
  return (
    <div className="region-bars">
      {top.map((row, index) => (
        <div className="region-bar" key={row.name}>
          <span className="region-bar-name">{row.name}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{
                width: `${Math.max(6, row.affinity * 100)}%`,
                animationDelay: `${index * 40}ms`,
              }}
            />
          </span>
          <span className="region-bar-count">{row.count} 次</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 常看 UP                                                             */
/* ------------------------------------------------------------------ */

function UpList({ ups }: { ups: UpRow[] }) {
  return (
    <ol className="up-list">
      {ups.map((up, index) => (
        <li className="up-row" key={`${up.mid}-${up.name}`}>
          <span className={`up-rank ${index < 3 ? 'up-rank--top' : ''}`}>{index + 1}</span>
          <Avatar name={up.name} size="xs" />
          <span className="up-name" title={up.name}>
            {up.name}
          </span>
          <span className="up-count">{up.count} 次</span>
          <span className="up-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(8, up.affinity * 100)}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* 兴趣信号（收藏 / 关注 / 稍后再看）                                  */
/* ------------------------------------------------------------------ */

function UpRowItem({
  up,
  index,
  countText,
  testid,
}: {
  up: UpRow;
  index: number;
  countText: string;
  testid: string;
}) {
  return (
    <li className="up-row" data-testid={testid}>
      <span className={`up-rank ${index < 3 ? 'up-rank--top' : ''}`}>{index + 1}</span>
      <Avatar name={up.name} size="xs" />
      <span className="up-name" title={up.name}>
        {up.name}
      </span>
      <span className="up-count">{countText}</span>
      <span className="up-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(8, up.affinity * 100)}%` }} />
      </span>
    </li>
  );
}

function SignalStrip({ signals }: { signals: ProfileSignals }) {
  return (
    <div className="signal-strip" data-testid="signal-strip">
      <StatCard
        testid="signal-stat"
        dataSignal="favorite"
        icon={<IconStar size={17} />}
        value={`${signals.favoriteFolders} 个收藏夹`}
        label="全部收藏夹"
        hint={`收藏 ${signals.favoriteCount} 条 · 采样 ${signals.favoriteSampled} 条`}
      />
      <StatCard
        testid="signal-stat"
        dataSignal="following"
        icon={<IconUser size={17} />}
        value={`${signals.followedTotal} 人`}
        label="关注"
        hint="只读关注列表，不会修改或取消关注"
      />
      <StatCard
        testid="signal-stat"
        dataSignal="watchLater"
        icon={<IconClock size={17} />}
        value={`${signals.watchLaterCount} 条`}
        label="稍后再看"
        hint={`采样 ${signals.watchLaterSampled} 条`}
      />
    </div>
  );
}

function FavoriteFollowPanel({ signals }: { signals: ProfileSignals }) {
  return (
    <section className="panel" data-testid="signal-favorites">
      <PanelHead
        title="收藏与关注"
        hint={`全部收藏夹 · 最近 ${signals.favoriteSampled} 条`}
      />
      {signals.favoriteFallback && (
        <p className="favorite-fallback" data-testid="favorite-fallback">
          兼容模式：前 3 个收藏夹
        </p>
      )}
      <div className="signal-columns">
        <div className="signal-column">
          <h4 className="signal-subtitle">
            <IconStar size={13} /> 收藏 UP 主 Top 10
          </h4>
          <ol className="up-list" data-testid="favorite-ups">
            {signals.favoriteUps.slice(0, 10).map((up, index) => (
              <UpRowItem
                key={`fav-${up.mid}-${up.name}`}
                up={up}
                index={index}
                countText={`${up.count} 条`}
                testid="favorite-up"
              />
            ))}
          </ol>
          {signals.favoriteUps.length === 0 && (
            <p className="muted">暂无收藏 UP 主数据。</p>
          )}
        </div>
        <div className="signal-column">
          <h4 className="signal-subtitle">
            <IconUser size={13} /> 关注 UP 主 Top 10
          </h4>
          <ol className="up-list" data-testid="followed-ups">
            {signals.followedUps.slice(0, 10).map((up, index) => (
              <UpRowItem
                key={`follow-${up.mid}-${up.name}`}
                up={up}
                index={index}
                countText="已关注"
                testid="followed-up"
              />
            ))}
          </ol>
          {signals.followedUps.length === 0 && (
            <p className="muted">暂无关注数据。</p>
          )}
        </div>
      </div>
      {signals.favoriteTags.length > 0 && (
        <div className="signal-tag-row">
          <span className="signal-tag-label">收藏标签</span>
          {signals.favoriteTags.slice(0, 8).map((tag) => (
            <span className="mini-tag" key={tag.term}>
              {tag.term}
              <sup>{tag.count}</sup>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function WatchLaterPanel({ signals }: { signals: ProfileSignals }) {
  return (
    <section className="panel" data-testid="signal-watchlater">
      <PanelHead
        title="稍后再看"
        hint={`共 ${signals.watchLaterCount} 条 · 采样 ${signals.watchLaterSampled} 条`}
      />
      <div className="signal-columns">
        <div className="signal-column">
          <h4 className="signal-subtitle">分区分布</h4>
          <div data-testid="watchlater-regions">
            <RegionBars rows={signals.watchLaterRegions} />
          </div>
        </div>
        <div className="signal-column">
          <h4 className="signal-subtitle">主题标签</h4>
          <div className="watchlater-tags" data-testid="watchlater-tags">
            {signals.watchLaterTags.slice(0, 12).map((tag) => (
              <span className="mini-tag" key={tag.term} data-testid="watchlater-tag">
                {tag.term}
                <sup>{tag.count}</sup>
              </span>
            ))}
            {signals.watchLaterTags.length === 0 && <p className="muted">暂无症状标签数据。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 观看时段直方图（纯 CSS 柱状图）                                     */
/* ------------------------------------------------------------------ */

function HoursChart({ hours }: { hours: number[] }) {
  const safeHours = hours.length === 24 ? hours : [...hours, ...new Array(24 - hours.length).fill(0)].slice(0, 24);
  const max = Math.max(...safeHours, 0.0001);
  const peak = safeHours.indexOf(Math.max(...safeHours));
  return (
    <div className="hours-chart">
      <div className="hours-bars" role="img" aria-label={`观看时段分布，最活跃时段 ${peak} 点`}>
        {safeHours.map((value, hour) => (
          <div
            className="hours-col"
            key={hour}
            title={`${String(hour).padStart(2, '0')}:00 · 相对活跃度 ${Math.round((value / max) * 100)}%`}
          >
            <span
              className={`hours-bar ${hour === peak ? 'is-peak' : ''}`}
              style={{ height: `${Math.max(4, (value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="hours-axis" aria-hidden="true">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => (
          <span key={hour}>{String(hour).padStart(2, '0')}:00</span>
        ))}
      </div>
      <p className="hours-caption">
        <IconClock size={13} />
        最活跃时段：{String(peak).padStart(2, '0')}:00 – {String((peak + 1) % 24).padStart(2, '0')}:00
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小面板                                                              */
/* ------------------------------------------------------------------ */

function PanelHead({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="panel-head">
      <h3 className="panel-title">{title}</h3>
      {hint && <span className="panel-hint">{hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 画像总结                                                            */
/* ------------------------------------------------------------------ */

function buildSummary(profile: Profile): ReactNode[] {
  const topRegions = profile.regions.slice(0, 2);
  const topTags = profile.tags.slice(0, 3);
  const topUp = profile.ups[0];
  const safeHours = profile.hours.length === 24 ? profile.hours : new Array<number>(24).fill(0);
  const peakHour = Math.max(0, safeHours.indexOf(Math.max(...safeHours)));

  const nodes: ReactNode[] = [
    <span key="sample">
      最近 {profile.sample.windowDays} 天，你一共看了
      <mark>{profile.sample.total}</mark> 个视频，其中近 7 天 <mark>{profile.sample.last7d}</mark> 个。
    </span>,
    <span key="regions">
      最常逛的是
      {topRegions.map((row, index) => (
        <span key={row.name}>
          {index > 0 ? '、' : ''}
          <mark>{row.name}</mark>
        </span>
      ))}
      区，最关注的主题是
      {topTags.map((tag, index) => (
        <span key={tag.term}>
          {index > 0 ? '、' : ''}
          <mark>{tag.term}</mark>
        </span>
      ))}
      。
    </span>,
    <span key="duration">
      偏好 <mark>{formatDuration(profile.preferredDuration.p10)} – {formatDuration(profile.preferredDuration.p90)}</mark>{' '}
      的视频，平均完播率 <mark>{formatPercent(profile.completionRate)}</mark>，平均时长{' '}
      {formatDuration(profile.avgDuration)}。
    </span>,
  ];
  if (topUp) {
    nodes.push(
      <span key="up">
        出现最多的是 UP 主「<mark>{topUp.name}</mark>」（近 {profile.sample.windowDays} 天 {topUp.count} 次）。
      </span>,
    );
  }
  nodes.push(
    <span key="hours">
      晚上 <mark>{String(peakHour).padStart(2, '0')}:00</mark> 前后是你最活跃的观看时段。
    </span>,
  );
  return nodes;
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

const WINDOW_OPTIONS: ReadonlyArray<{ value: Settings['tagWindow']; label: string }> = [
  { value: '7d', label: '近一周' },
  { value: '30d', label: '近一月' },
  { value: 'all', label: '全部' },
];

export function TagsPage({ data, onUpdateSettings }: TagsPageProps) {
  const [saving, setSaving] = useState(false);
  const profile = data.profile;
  const loggedOut = data.daily?.mode === 'public';

  if (!profile) {
    return (
      <div className="page" data-testid="tags">
        <PageIntro eyebrow="观看画像" title="我的标签" description="基于最近 90 天观看历史生成，只保存在本机。" />
        <EmptyState
          testid="tags-locked"
          icon={loggedOut ? <IconLock size={26} /> : <IconSpark size={26} />}
          title={loggedOut ? '登录后查看你的标签画像' : '还没有观看画像'}
          description={
            loggedOut
              ? '标签、分区偏好和常看 UP 主都来自你的观看历史。在浏览器里登录 B 站后刷新仪表盘，再更新一次即可生成。'
              : '首次使用还没有采集到足够的观看历史。更新一次数据后，这里会展示标签云、观看时段和画像总结。'
          }
          action={
            loggedOut ? (
              <a
                className="btn btn-primary"
                href="https://www.bilibili.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                去 B 站登录
              </a>
            ) : undefined
          }
        />
      </div>
    );
  }

  const changeWindow = async (next: Settings['tagWindow']): Promise<void> => {
    if (next === data.settings.tagWindow) return;
    setSaving(true);
    await onUpdateSettings({ tagWindow: next });
    setSaving(false);
  };

  const summary = buildSummary(profile);

  return (
    <div className="page" data-testid="tags">
      <PageIntro
        eyebrow="观看画像"
        title="我的标签"
        description="基于最近 90 天观看历史生成：越靠中间、字号越大的标签权重越高。所有数据只保存在本机。"
      >
        <Segmented
          value={data.settings.tagWindow}
          options={WINDOW_OPTIONS}
          onChange={(next) => {
            void changeWindow(next);
          }}
          label="标签统计窗口"
          testid="tag-window"
          disabled={saving}
        />
      </PageIntro>

      <div className="stat-strip">
        <StatCard
          icon={<IconClock size={17} />}
          value={`${profile.sample.last7d} 个`}
          label="近 7 天观看"
          hint={`共同统计 ${profile.sample.windowDays} 天样本`}
        />
        <StatCard
          icon={<IconTag size={17} />}
          value={`${profile.sample.total} 个`}
          label="历史观看样本"
          hint={`画像生成于 ${new Date(profile.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}
        />
        <StatCard
          icon={<IconTrend size={17} />}
          value={formatPercent(profile.completionRate)}
          label="平均完播率"
          hint="有进度信息的样本"
        />
        <StatCard
          icon={<IconSpark size={17} />}
          value={formatDuration(profile.avgDuration)}
          label="平均视频时长"
          hint={`偏好 ${formatDuration(profile.preferredDuration.p10)} – ${formatDuration(profile.preferredDuration.p90)}`}
        />
      </div>

      {profile.signals ? (
        <SignalStrip signals={profile.signals} />
      ) : (
        <div data-testid="signal-empty">
          <Notice
            tone="info"
            icon={<IconSignal size={17} />}
            title="暂未采集兴趣信号"
          >
            本次画像还没有收藏 / 关注 / 稍后再看数据（旧版数据或本次采集被风控跳过）。点右上角「立即更新」后，下次会尝试重新采集。
          </Notice>
        </div>
      )}

      <div className="tags-layout">
        <div className="tags-main">
          <section className="panel">
            <PanelHead title="标签云" hint={`${profile.tags.length} 个标签 · 字号表示权重，右上角数字是出现次数`} />
            <TagCloud tags={profile.tags} />
          </section>
          <section className="panel summary-panel">
            <PanelHead title="画像总结" hint="根据观看历史自动生成" />
            <ul className="summary-list">
              {summary.map((node, index) => (
                <li key={index}>{node}</li>
              ))}
            </ul>
          </section>
        </div>

        <div className="tags-side">
          <section className="panel">
            <PanelHead title="分区偏好" hint="近 90 天" />
            <RegionBars rows={profile.regions} />
          </section>
          <section className="panel">
            <PanelHead title="常看 UP 主 Top 10" hint="按观看时间与完播加权" />
            <UpList ups={profile.ups} />
          </section>
        </div>
      </div>

      {profile.signals && (
        <>
          <FavoriteFollowPanel signals={profile.signals} />
          <WatchLaterPanel signals={profile.signals} />
        </>
      )}

      <section className="panel">
        <PanelHead title="观看时段分布" hint="24 小时 · 按历史观看时间统计" />
        <HoursChart hours={profile.hours} />
      </section>
    </div>
  );
}
