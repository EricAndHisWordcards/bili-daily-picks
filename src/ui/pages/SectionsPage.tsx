/** 分区精选：按一级分区偏好排序的若干个板块。 */
import type { DashboardData } from '../../shared/types';
import { PageIntro } from '../components/PageIntro';
import { SectionBoard } from '../components/SectionBoard';
import { EmptyState, Notice } from '../components/States';
import { IconSections } from '../components/Icons';

interface SectionsPageProps {
  data: DashboardData;
  onDismiss: (bvid: string) => void;
  onRunNow: () => void;
}

export function SectionsPage({ data, onDismiss, onRunNow }: SectionsPageProps) {
  const daily = data.daily;
  const regionSections = daily?.sections.filter((section) => section.kind === 'region') ?? [];

  return (
    <div className="page" data-testid="sections">
      <PageIntro
        eyebrow="按兴趣分区"
        title="分区精选"
        description={`按你近 90 天的分区偏好排序；当前每个分区 ${data.settings.perSection} 个视频（可在设置里调到 2–5 个）。`}
      >
        <span className="chip">
          <IconSections size={13} />
          {regionSections.length} 个分区
        </span>
      </PageIntro>

      {daily?.mode === 'public' && (
        <Notice tone="info" title="公开模式">
          未登录时按热门分区和榜单数据排序；登录 B 站后，分区顺序会贴合你的真实观看偏好。
        </Notice>
      )}

      {!daily ? (
        <EmptyState
          title="还没有分区推荐"
          description="先更新一次数据，就会按你的兴趣生成分区精选。"
          action={
            <button type="button" className="btn btn-primary" onClick={onRunNow}>
              立即更新
            </button>
          }
        />
      ) : regionSections.length === 0 ? (
        <EmptyState
          title="暂时没有分区板块"
          description="可能是候选数据不足或触发了风控，稍后重试；也可以检查设置里的数据源开关。"
        />
      ) : (
        regionSections.map((section) => (
          <SectionBoard key={section.id} section={section} onDismiss={onDismiss} />
        ))
      )}
    </div>
  );
}
