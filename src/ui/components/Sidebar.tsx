/** 左侧 240px 导航栏：品牌、六个页面入口、后台状态与版本号。 */
import type { ReactNode } from 'react';
import type { DailyResult, RunStatus } from '../../shared/types';
import { PAGE_IDS, PAGE_META } from '../lib/types';
import type { PageId, UiApi } from '../lib/types';
import { pageHref } from '../lib/router';
import {
  BrandMark,
  IconCalendar,
  IconExternal,
  IconSections,
  IconSettings,
  IconTag,
  IconToday,
  IconTrend,
} from './Icons';

const NAV_ICONS: Record<PageId, ReactNode> = {
  today: <IconToday size={17} />,
  sections: <IconSections size={17} />,
  growth: <IconTrend size={17} />,
  weekly: <IconCalendar size={17} />,
  tags: <IconTag size={17} />,
  settings: <IconSettings size={17} />,
};

interface SidebarProps {
  page: PageId;
  status: RunStatus | null;
  daily: DailyResult | null;
  apiMode: UiApi['mode'] | null;
  tagCount?: number;
}

export function Sidebar({ page, status, daily, apiMode, tagCount }: SidebarProps) {
  const running = Boolean(status?.running);
  const lastError = status?.lastError;
  const updatedAt = status?.lastRunAt ?? daily?.generatedAt;
  const stateText = running
    ? '后台更新中'
    : lastError
      ? '上次更新失败'
      : updatedAt
        ? '数据已就绪'
        : '等待首次更新';
  const stateTone = running ? 'run' : lastError ? 'error' : updatedAt ? 'ok' : 'idle';
  const growthCount = daily?.sections.find((section) => section.kind === 'growth')?.items.length ?? 0;

  return (
    <aside className="sidebar" data-testid="sidebar">
      <a className="brand" href={pageHref('today')} data-testid="nav-brand">
        <BrandMark />
        <span className="brand-text">
          <span className="brand-name">B站每日必看</span>
          <span className="brand-sub">每天发现值得看的</span>
        </span>
      </a>

      <nav className="nav" aria-label="主导航">
        <span className="nav-label">浏览</span>
        {PAGE_IDS.map((id) => {
          const active = id === page;
          return (
            <a
              key={id}
              className={`nav-item ${active ? 'is-active' : ''}`}
              href={pageHref(id)}
              data-testid={`nav-${id}`}
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-icon">{NAV_ICONS[id]}</span>
              <span className="nav-text">{PAGE_META[id].label}</span>
              {id === 'growth' && growthCount > 0 && <span className="nav-badge">{growthCount}</span>}
              {id === 'tags' && tagCount ? <span className="nav-badge nav-badge--ghost">{tagCount}</span> : null}
            </a>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className={`sidebar-status sidebar-status--${stateTone}`}>
          <span className={`status-dot ${running ? 'status-dot--pulse' : ''}`} />
          <span>{stateText}</span>
        </div>
        {apiMode === 'mock' ? (
          <span className="sidebar-mock" title="?mock=1：使用 tests/fixtures 合成的离线演示数据">
            离线演示数据
          </span>
        ) : apiMode === 'extension' ? (
          <span className="sidebar-mock sidebar-mock--live">扩展运行中</span>
        ) : (
          <span className="sidebar-mock">正在连接后台…</span>
        )}
        <a
          className="sidebar-link"
          href="https://www.bilibili.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconExternal size={12} />
          打开 bilibili.com
        </a>
        <span className="sidebar-version">v0.2.2 · 数据仅存本机</span>
      </div>
    </aside>
  );
}
