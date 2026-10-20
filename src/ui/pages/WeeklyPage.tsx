/** 周报：最近 12 个自然周的观看回顾（趋势 / 标签涨跌 / 分区 / UP 主）。 */
import { useEffect, useState } from 'react';
import type {
  TrendDirection,
  WeeklyReport,
  WeeklyReportResponse,
} from '../../shared/types';
import { formatPercent } from '../../shared/format';
import { PageIntro } from '../components/PageIntro';
import { Avatar } from '../components/Avatar';
import { SelectField } from '../components/Controls';
import { EmptyState, Notice, StatCard } from '../components/States';
import {
  IconCalendar,
  IconClock,
  IconPlay,
  IconRefresh,
  IconSpark,
  IconTrend,
} from '../components/Icons';
import {
  BILI_PASSPORT_LOGIN_URL,
  formatWatchSeconds,
  relativeChange,
  signedNumber,
  signedPercentPoints,
  trendDeltaText,
  trendLabel,
} from '../lib/view';

interface WeeklyPageProps {
  weekly: WeeklyReportResponse | null;
  loading: boolean;
  error: string | null;
  loggedIn: boolean;
  onLoad: (weekKey?: string) => void;
  onGenerate: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 小部件                                                              */
/* ------------------------------------------------------------------ */

function PanelHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="panel-head">
      <h3 className="panel-title">{title}</h3>
      {hint && <span className="panel-hint">{hint}</span>}
    </div>
  );
}

function TrendChip({ status, delta }: { status: TrendDirection; delta: number }) {
  const text =
    status === 'steady' || status === 'gone'
      ? trendLabel(status)
      : `${trendLabel(status)} ${trendDeltaText(delta)}`;
  return <span className={`trend-chip trend-chip--${status}`}>{text}</span>;
}

/** 7 天趋势柱状图（纯 CSS） */
function WeekTrend({ report }: { report: WeeklyReport }) {
  const max = Math.max(...report.daily.map((day) => day.watched), 1);
  const peak = report.daily.reduce(
    (best, day) => (day.watched > best.watched ? day : best),
    report.daily[0] ?? { date: '', weekday: '—', watched: 0, watchSeconds: 0 },
  );
  return (
    <section className="panel" data-testid="weekly-trend">
      <PanelHead
        title="7 天观看趋势"
        hint={peak.watched > 0 ? `峰值 ${peak.weekday} · ${peak.watched} 个` : '该周没有记录到观看'}
      />
      <div className="week-trend" role="img" aria-label="该周 7 天观看数量趋势">
        {report.daily.map((day) => {
          const ratio = day.watched > 0 ? Math.max(8, (day.watched / max) * 100) : 3;
          return (
            <div className="week-trend-col" key={`${day.date}-${day.weekday}`}>
              <span className="week-trend-value">{day.watched > 0 ? day.watched : ''}</span>
              <div className="week-trend-track">
                <span
                  className={`week-trend-bar ${day.date === peak.date && peak.watched > 0 ? 'is-peak' : ''}`}
                  data-testid="weekly-trend-bar"
                  data-date={day.date}
                  data-watched={day.watched}
                  style={{ height: `${ratio}%` }}
                  title={`${day.weekday} ${day.date}：${day.watched} 个视频 · ${formatWatchSeconds(day.watchSeconds)}`}
                />
              </div>
              <span className="week-trend-label">{day.weekday}</span>
              <span className="week-trend-date">{day.date}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function WeeklyPage({
  weekly,
  loading,
  error,
  loggedIn,
  onLoad,
  onGenerate,
}: WeeklyPageProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // 首次进入自动加载最新一份
  useEffect(() => {
    if (!weekly && !loading && !error) onLoad();
  }, [weekly, loading, error, onLoad]);

  // 加载完成后同步下拉框选中项
  useEffect(() => {
    if (weekly?.report) setSelectedKey(weekly.report.weekKey);
  }, [weekly]);

  const report = weekly?.report ?? null;
  const reports = weekly?.reports ?? [];
  const options = reports.length
    ? reports.map((meta) => ({ value: meta.weekKey, label: meta.label }))
    : [{ value: '', label: '暂无可选周报' }];
  const pickerValue = selectedKey ?? report?.weekKey ?? '';
  const refresh = () => onLoad(selectedKey ?? undefined);

  const handleGenerate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    try {
      await onGenerate();
    } finally {
      setGenerating(false);
    }
  };

  const changeWeek = (key: string) => {
    if (!key || key === pickerValue) return;
    setSelectedKey(key);
    onLoad(key);
  };

  return (
    <div className="page" data-testid="weekly" data-week-key={report?.weekKey ?? ''}>
      <PageIntro
        eyebrow="每周回顾"
        title="周报"
        description="每个自然周一份，在每周一 04:00 的每日更新后自动生成；只在登录后生成，错过后会在下次每日更新或手动「立即更新」时补生成。数据只保存在本机。"
      >
        <div className="weekly-toolbar">
          <span className="weekly-label" data-testid="weekly-label">
            {report?.label ?? '暂无周报'}
          </span>
          <SelectField
            value={pickerValue}
            options={options}
            onChange={changeWeek}
            label="选择周报"
            testid="weekly-week-picker"
            disabled={loading || reports.length < 2}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="weekly-refresh"
            onClick={refresh}
            disabled={loading}
          >
            <IconRefresh size={13} className={loading ? 'is-spinning' : ''} />
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </PageIntro>

      {loading && !report && (
        <div className="weekly-loading" data-testid="weekly-loading" aria-busy="true">
          <div className="stat-strip">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="skeleton skeleton-stat" key={index} />
            ))}
          </div>
          <div className="skeleton skeleton-hero" />
        </div>
      )}

      {!loading && error && !report && (
        <div data-testid="weekly-error">
          <Notice
            tone="error"
            title="周报加载失败"
            action={
              <button type="button" className="btn btn-sm btn-ghost" onClick={refresh}>
                <IconRefresh size={13} />
                重试
              </button>
            }
          >
            {error}
          </Notice>
        </div>
      )}

      {!loading && !error && !report && (
        <EmptyState
          testid="weekly-empty"
          icon={<IconCalendar size={26} />}
          title={
            loggedIn
              ? '周报将在每周一 04:00 的每日更新后自动生成'
              : '登录 B站 后才会生成周报'
          }
          description={
            loggedIn
              ? '错过周一 04:00 也没关系：下一次每日更新，或点下面的「立即更新并生成」，都会补生成上一完整周（周一至周日）的报告。公开模式不会生成周报。'
              : '周报基于登录后采集的本地观看历史，公开模式不会生成。请先在浏览器登录 B站，再回到这里点「刷新登录状态」，然后更新一次即可补生成上一完整周。'
          }
          action={
            loggedIn ? (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="weekly-generate"
                onClick={() => {
                  void handleGenerate();
                }}
                disabled={generating}
              >
                <IconRefresh size={14} className={generating ? 'is-spinning' : ''} />
                {generating ? '正在更新…' : '立即更新并生成'}
              </button>
            ) : (
              <a
                className="btn btn-primary"
                data-testid="weekly-login"
                href={BILI_PASSPORT_LOGIN_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                去 B站 登录
              </a>
            )
          }
        />
      )}

      {report && (
        <>
          {error && (
            <Notice tone="warn" title="刷新周报失败">
              {error}
            </Notice>
          )}

          <div className="stat-strip">
            <StatCard
              testid="weekly-stat"
              dataStat="watched"
              icon={<IconPlay size={17} />}
              value={`${report.stats.watched} 个`}
              label="该周观看"
              hint={`上一周 ${report.previous.watched} 个 · ${relativeChange(report.stats.watched, report.previous.watched)}`}
            />
            <StatCard
              testid="weekly-stat"
              dataStat="duration"
              icon={<IconClock size={17} />}
              value={formatWatchSeconds(report.stats.watchSeconds)}
              label="观看时长"
              hint={`上一周 ${formatWatchSeconds(report.previous.watchSeconds)}`}
            />
            <StatCard
              testid="weekly-stat"
              dataStat="activeDays"
              icon={<IconCalendar size={17} />}
              value={`${report.stats.activeDays} 天`}
              label="活跃天数"
              hint={`较上周 ${signedNumber(report.stats.activeDays - report.previous.activeDays)} 天`}
            />
            <StatCard
              testid="weekly-stat"
              dataStat="completion"
              icon={<IconSpark size={17} />}
              value={formatPercent(report.stats.completionRate, 1)}
              label="平均完播率"
              hint={`较上周 ${signedPercentPoints(report.stats.completionRate - report.previous.completionRate)}`}
            />
          </div>

          <div className="weekly-grid">
            <WeekTrend report={report} />

            <section className="panel summary-panel" data-testid="weekly-summary">
              <PanelHead title="该周总结" hint={report.label} />
              <ul className="summary-list">
                {(report.summary.length > 0
                  ? report.summary
                  : ['该周还没有足够的观看数据生成总结。']
                ).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </section>

            <section className="panel" data-testid="weekly-tags">
              <PanelHead title="标签 Top 12" hint="对比上一周的主题权重变化" />
              {report.tags.length === 0 ? (
                <p className="muted">该周没有足够的标签数据。</p>
              ) : (
                <div className="week-tag-list">
                  {report.tags.slice(0, 12).map((tag) => (
                    <div
                      className="week-tag-row"
                      key={tag.term}
                      data-testid="weekly-tag"
                      data-status={tag.status}
                      data-term={tag.term}
                    >
                      <span className="week-tag-term" title={tag.term}>
                        {tag.term}
                      </span>
                      <span className="bar-track week-tag-bar">
                        <span
                          className="bar-fill"
                          style={{ width: `${Math.max(6, tag.weight * 100)}%` }}
                        />
                      </span>
                      <span className="week-tag-count">{tag.count} 次</span>
                      <TrendChip status={tag.status} delta={tag.delta} />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel" data-testid="weekly-movers">
              <PanelHead title="上升 / 下降" hint="按主题权重变化排序" />
              <div className="week-movers">
                <div className="week-mover-group" data-testid="weekly-rising">
                  <h4 className="week-mover-title">
                    <IconTrend size={13} /> 上升最快
                  </h4>
                  {report.rising.length === 0 ? (
                    <p className="muted">该周没有明显上升的主题。</p>
                  ) : (
                    report.rising.map((item) => (
                      <div
                        className="week-mover-row"
                        key={`rising-${item.term}`}
                        data-testid="weekly-mover"
                        data-direction="rising"
                      >
                        <span className="week-mover-term">{item.term}</span>
                        <span className="trend-chip trend-chip--up">
                          {trendDeltaText(item.delta)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div className="week-mover-group" data-testid="weekly-falling">
                  <h4 className="week-mover-title week-mover-title--down">
                    <IconTrend size={13} /> 下降最多
                  </h4>
                  {report.falling.length === 0 ? (
                    <p className="muted">该周没有明显下降的主题。</p>
                  ) : (
                    report.falling.map((item) => (
                      <div
                        className="week-mover-row"
                        key={`falling-${item.term}`}
                        data-testid="weekly-mover"
                        data-direction="falling"
                      >
                        <span className="week-mover-term">{item.term}</span>
                        <span className="trend-chip trend-chip--down">
                          {trendDeltaText(item.delta)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="panel" data-testid="weekly-regions">
              <PanelHead title="分区 Top 6" hint="权重与上周对比" />
              {report.regions.slice(0, 6).map((region) => (
                <div className="week-region-row" key={region.name}>
                  <span className="week-region-name" title={region.name}>
                    {region.name}
                  </span>
                  <span className="bar-track week-region-bar">
                    <span
                      className="bar-fill"
                      style={{ width: `${Math.max(6, region.weight * 100)}%` }}
                    />
                  </span>
                  <span className="week-region-count">{region.count} 次</span>
                  <TrendChip status={region.status} delta={region.delta} />
                </div>
              ))}
              {report.regions.length === 0 && <p className="muted">该周没有分区数据。</p>}
            </section>

            <section className="panel" data-testid="weekly-ups">
              <PanelHead title="常看 UP Top 6" hint="按该周观看次数" />
              <ol className="week-up-list">
                {report.ups.slice(0, 6).map((up, index) => (
                  <li className="week-up-row" key={`${up.mid}-${up.name}`}>
                    <span className={`up-rank ${index < 3 ? 'up-rank--top' : ''}`}>
                      {index + 1}
                    </span>
                    <Avatar name={up.name} size="xs" />
                    <span className="up-name" title={up.name}>
                      {up.name}
                    </span>
                    <span className="week-up-count">{up.count} 个</span>
                    <span
                      className={`week-up-delta ${up.delta > 0 ? 'is-up' : up.delta < 0 ? 'is-down' : ''}`}
                    >
                      {signedNumber(up.delta)}
                    </span>
                  </li>
                ))}
              </ol>
              {report.ups.length === 0 && <p className="muted">该周没有足够的 UP 主数据。</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
