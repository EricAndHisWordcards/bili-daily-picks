/** 今日必看：全局 6 条 + 增长黑马预览 + 每周必看精选。 */
import type { DashboardData, Recommendation, Section } from '../../shared/types';
import { relativeTime } from '../../shared/time';
import { SectionBoard } from '../components/SectionBoard';
import { EmptyState } from '../components/States';
import { IconChevronRight, IconClock, IconSections, IconSpark, IconToday } from '../components/Icons';

interface TodayPageProps {
  data: DashboardData;
  onDismiss: (bvid: string) => void;
  onRunNow: () => void;
}

/** 实测、估算交错展示，保证预览里两种增长角标都能看到 */
function mixGrowthItems(items: Recommendation[], count: number): Recommendation[] {
  const measured = items.filter((item) => item.growth && !item.growth.estimated);
  const estimated = items.filter((item) => item.growth?.estimated);
  const mixed: Recommendation[] = [];
  const max = Math.max(measured.length, estimated.length);
  for (let index = 0; index < max && mixed.length < count; index += 1) {
    const measuredItem = measured[index];
    const estimatedItem = estimated[index];
    if (measuredItem && mixed.length < count) mixed.push(measuredItem);
    if (estimatedItem && mixed.length < count) mixed.push(estimatedItem);
  }
  for (const item of items) {
    if (mixed.length >= count) break;
    if (!mixed.includes(item)) mixed.push(item);
  }
  return mixed;
}

export function TodayPage({ data, onDismiss, onRunNow }: TodayPageProps) {
  const daily = data.daily;

  if (!daily) {
    return (
      <div className="page page--today" data-testid="today">
        <EmptyState
          icon={<IconSpark size={26} />}
          title="还没有今天的推荐"
          description="首次使用需要先采集观看历史并汇总榜单，点击下面的按钮开始；大约需要 1–2 分钟。"
          action={
            <button type="button" className="btn btn-primary btn-lg" onClick={onRunNow}>
              立即生成今日推荐
            </button>
          }
        />
      </div>
    );
  }

  const globalSection = daily.sections.find((section) => section.kind === 'global');
  const growthSection = daily.sections.find((section) => section.kind === 'growth');
  const weeklySection = daily.sections.find((section) => section.kind === 'weekly');
  const regionCount = daily.sections.filter((section) => section.kind === 'region').length;
  const totalItems = daily.sections.reduce((sum, section) => sum + section.items.length, 0);

  const growthPreview: Section | null = growthSection
    ? {
        ...growthSection,
        id: 'growth-preview',
        title: '增长黑马',
        subtitle: '现在播放涨得最快的视频 · 实测与估算混合展示',
        items: mixGrowthItems(growthSection.items, 4),
      }
    : null;

  return (
    <div className="page page--today" data-testid="today">
      <div className="today-overview">
        <span className="overview-chip">
          <IconToday size={14} />
          {daily.date}
        </span>
        <span className="overview-chip">
          <IconClock size={14} />
          更新于 {relativeTime(daily.generatedAt)}
        </span>
        <span className="overview-chip">
          <IconSections size={14} />
          {regionCount} 个分区 · {totalItems} 条推荐
        </span>
        <span className="overview-grow">
          <span className="legend-dot legend-dot--measured" aria-hidden="true" />
          实测 24h 增量
          <span className="legend-dot legend-dot--estimated" aria-hidden="true" />
          估算 发布以来日均
        </span>
      </div>

      {globalSection && (
        <SectionBoard
          section={globalSection}
          onDismiss={onDismiss}
          action={
            <a className="board-link" href="#/sections">
              全部分区
              <IconChevronRight size={13} />
            </a>
          }
        />
      )}

      {growthPreview && (
        <SectionBoard
          section={growthPreview}
          onDismiss={onDismiss}
          action={
            <a className="board-link" href="#/growth">
              完整增长榜
              <IconChevronRight size={13} />
            </a>
          }
        />
      )}

      {weeklySection && <SectionBoard section={weeklySection} onDismiss={onDismiss} />}

      {!globalSection && !growthPreview && !weeklySection && (
        <EmptyState
          title="今天的推荐还在路上"
          description="点击右上角「立即更新」重新生成。"
          action={
            <button type="button" className="btn btn-primary" onClick={onRunNow}>
              立即更新
            </button>
          }
        />
      )}

      <div className="today-footer">
        <a className="btn btn-ghost" href="#/sections">
          按分区浏览全部推荐
          <IconChevronRight size={13} />
        </a>
        <a className="btn btn-ghost" href="#/tags">
          查看我的标签画像
          <IconChevronRight size={13} />
        </a>
      </div>
    </div>
  );
}
