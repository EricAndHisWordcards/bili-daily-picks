/** 每个页面顶部的标题区（今日必看页用 Hero 代替，不额外放）。 */
import type { ReactNode } from 'react';

interface PageIntroProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function PageIntro({ eyebrow, title, description, children }: PageIntroProps) {
  return (
    <header className="page-intro">
      <div className="page-intro-main">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {children && <div className="page-intro-aside">{children}</div>}
    </header>
  );
}
