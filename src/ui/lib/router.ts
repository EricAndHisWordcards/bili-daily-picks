/** 极简 hash 路由：#/today、#/sections、#/growth、#/tags、#/settings。 */
import { useEffect, useState } from 'react';
import { PAGE_IDS } from './types';
import type { PageId } from './types';

export function parsePage(hash: string): PageId {
  const raw = hash.replace(/^#\/?/, '').split(/[?&/]/)[0] ?? '';
  return (PAGE_IDS as readonly string[]).includes(raw) ? (raw as PageId) : 'today';
}

export function pageHref(page: PageId): string {
  return `#/${page}`;
}

/** 跳到指定页面（保留 ?mock= 等查询参数） */
export function navigate(page: PageId): void {
  const next = pageHref(page);
  if (window.location.hash !== next) window.location.hash = next;
}

export function usePage(): PageId {
  const [page, setPage] = useState<PageId>(() => parsePage(window.location.hash));
  useEffect(() => {
    const onChange = () => setPage(parsePage(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}
