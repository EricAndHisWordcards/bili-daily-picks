/** 推荐板块：标题 + 副标题 + 视频网格（空板块有独立空态）。 */
import type { ReactNode } from 'react';
import type { Section, SectionKind } from '../../shared/types';
import { cyrb53 } from '../../shared/hash';
import { VideoCard } from './VideoCard';
import { EmptyState } from './States';
import { IconFire, IconSections, IconSpark, IconStar, IconToday } from './Icons';

interface SectionBoardProps {
  section: Section;
  onDismiss: (bvid: string) => void;
  action?: ReactNode;
}

const TONES = ['pink', 'blue', 'violet', 'green', 'orange'] as const;

const BOARD_ICONS: Record<SectionKind, ReactNode> = {
  global: <IconSpark size={16} />,
  region: <IconSections size={16} />,
  growth: <IconFire size={16} />,
  weekly: <IconStar size={16} />,
};

const BOARD_TITLE_ICONS: Partial<Record<SectionKind, ReactNode>> = {
  global: <IconToday size={16} />,
};

export function SectionBoard({ section, onDismiss, action }: SectionBoardProps) {
  const tone = TONES[cyrb53(section.id) % TONES.length] ?? 'pink';
  const icon = section.kind === 'global' ? BOARD_TITLE_ICONS.global : BOARD_ICONS[section.kind];

  return (
    <section
      className={`board board--${tone}`}
      data-testid="section"
      data-kind={section.kind}
      data-section-id={section.id}
      data-tone={tone}
    >
      <header className="board-head">
        <div className="board-heading">
          <span className={`board-icon board-icon--${tone}`}>{icon}</span>
          <div className="board-titles">
            <h2 className="board-title">{section.title}</h2>
            {section.subtitle && <p className="board-subtitle">{section.subtitle}</p>}
          </div>
        </div>
        <div className="board-aside">
          {action}
          {section.items.length > 0 && <span className="chip">{section.items.length} 个视频</span>}
        </div>
      </header>

      {section.items.length === 0 ? (
        <EmptyState
          compact
          testid="empty-section"
          title="这个板块暂时没有推荐"
          description="稍后点「立即更新」再试，或在设置里调整每类数量。"
        />
      ) : (
        <div className="video-grid">
          {section.items.map((item) => (
            <VideoCard key={item.bvid} video={item} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </section>
  );
}
