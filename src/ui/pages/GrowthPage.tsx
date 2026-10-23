/** 增长榜：实测增长与估算增长分开排列，角标区分数据口径。 */
import type { DashboardData, Recommendation, Section } from '../../shared/types';
import { PageIntro } from '../components/PageIntro';
import { SectionBoard } from '../components/SectionBoard';
import { EmptyState, Notice } from '../components/States';
import { IconTrend } from '../components/Icons';
import { growthScore } from '../lib/view';

interface GrowthPageProps {
  data: DashboardData;
  onDismiss: (bvid: string) => void;
  onRunNow: () => void;
}

function sortByGrowth(items: Recommendation[]): Recommendation[] {
  return [...items].sort((a, b) => growthScore(b.growth) - growthScore(a.growth));
}

export function GrowthPage({ data, onDismiss, onRunNow }: GrowthPageProps) {
  const daily = data.daily;
  const allItems = daily?.sections.find((section) => section.kind === 'growth')?.items ?? [];
  const measured = sortByGrowth(allItems.filter((item) => item.growth && !item.growth.estimated));
  const estimated = sortByGrowth(allItems.filter((item) => item.growth?.estimated));

  const sections: Section[] = [];
  if (measured.length > 0) {
    sections.push({
      id: 'growth-measured',
      title: '实测增长 · 24 小时',
      subtitle: '两次本地快照间隔 ≥12 小时，直接测到的播放/收藏/评论增量',
      kind: 'growth',
      items: measured,
    });
  }
  if (estimated.length > 0) {
    sections.push({
      id: 'growth-estimated',
      title: '估算增长 · 发布以来日均',
      subtitle: '快照还不够两次时的估算口径，仅供参考',
      kind: 'growth',
      items: estimated,
    });
  }

  return (
    <div className="page" data-testid="growth">
      <PageIntro
        eyebrow="增长观察"
        title="增长榜"
        description="不只看总播放，更看「最近涨得多快」。增长数据来自本机快照，不额外请求接口。"
      >
        <span className="chip">
          <IconTrend size={13} />
          实测 {measured.length} · 估算 {estimated.length}
        </span>
      </PageIntro>

      <Notice tone="info" title="增长数据怎么来的？">
        每次更新会把候选视频的播放、收藏、评论写入本地快照。24 小时内两次快照间隔 ≥12 小时记为「实测增量」；不足两次快照时按「发布以来日均」估算，并标注「估算」。首次安装后通常需要运行一两天才能积累实测数据。
      </Notice>

      {allItems.length === 0 ? (
        <EmptyState
          icon={<IconTrend size={26} />}
          title={daily ? '增长数据积累中' : '还没有增长数据'}
          description={
            daily
              ? '当前推荐里还没有可用于计算增长的快照数据。保持浏览器运行，之后每次更新都会积累快照；也可以直接点「立即更新」。'
              : '先更新一次数据，之后每次更新都会积累增长快照。'
          }
          action={
            <button type="button" className="btn btn-primary" onClick={onRunNow}>
              立即更新
            </button>
          }
        />
      ) : (
        sections.map((section) => (
          <SectionBoard key={section.id} section={section} onDismiss={onDismiss} />
        ))
      )}
    </div>
  );
}
