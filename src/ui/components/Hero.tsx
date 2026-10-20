/** 顶部 Hero：账号、更新时间、立即更新、运行时阶段进度、降级/未登录/失败提示。 */
import type { DashboardData, RunStatus } from '../../shared/types';
import { relativeTime } from '../../shared/time';
import {
  formatDateText,
  formatFuture,
  greeting,
  nextUpdateAt,
  openBilibili,
} from '../lib/view';
import { Avatar } from './Avatar';
import { LoginHint, Notice, RunProgress, StatusBadge } from './States';
import { IconClock, IconExternal, IconRefresh, IconSections, IconUser } from './Icons';

interface HeroProps {
  data: DashboardData;
  status: RunStatus;
  busy: boolean;
  onRunNow: () => void;
  mockMode: boolean;
  /** 未登录提示里的「已登录？刷新」 */
  onRefreshAccount?: () => void;
  accountRefreshing?: boolean;
}

export function Hero({
  data,
  status,
  busy,
  onRunNow,
  mockMode,
  onRefreshAccount,
  accountRefreshing = false,
}: HeroProps) {
  const { daily, profile, settings, account } = data;
  const running = Boolean(status.running);
  const updatedAt = status.lastRunAt ?? daily?.generatedAt;
  const accountError = Boolean(account.error);
  // 网络/风控导致检测失败时不能当作「未登录」，否则会把个性化结果误标成公开模式
  const loggedOut = !account.loggedIn && !accountError;
  const publicMode = loggedOut || daily?.mode === 'public' || Boolean(status.loggedOut);
  // 账号信息优先读 data.account，旧数据/后台未提供时用画像兜底
  const uname =
    (account.loggedIn ? account.uname : account.last?.uname) ?? profile?.uname ?? undefined;
  const avatar =
    (account.loggedIn ? account.face : account.last?.face) ?? profile?.avatar ?? undefined;
  const nextDue = settings.autoUpdate ? nextUpdateAt(settings.updateHour) : null;
  const totalItems = daily?.sections.reduce((sum, section) => sum + section.items.length, 0) ?? 0;
  const regionCount = daily?.sections.filter((section) => section.kind === 'region').length ?? 0;
  const degraded = daily?.meta.degraded;
  const lastError = status.lastError;

  const title = publicMode && loggedOut
    ? '公开模式 · 今天看点什么？'
    : uname
      ? `${uname}，今天看点什么？`
      : '今天看点什么？';

  return (
    <header className="hero" data-testid="hero">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-main">
        <Avatar
          className="hero-avatar"
          src={avatar}
          name={uname ?? '哔'}
          size="hero"
        />
        <div className="hero-text">
          <p className="hero-eyebrow">
            <span>{greeting()}</span>
            <span className="dot-sep" aria-hidden="true" />
            <span>{formatDateText()}</span>
            {mockMode && (
              <span className="demo-chip" title="?mock=1：使用 tests/fixtures 合成的离线演示数据">
                离线演示
              </span>
            )}
          </p>
          <h1 className="hero-title">{title}</h1>
          <div className="hero-meta">
            <StatusBadge status={status} daily={daily} />
            <span className="meta-item" data-testid="hero-account-name">
              <IconUser size={14} />
              {uname ?? '未登录'}
            </span>
            {updatedAt ? (
              <span className="meta-item">
                <IconClock size={14} />
                更新于 {relativeTime(updatedAt)}
              </span>
            ) : null}
            <span className="meta-item">
              <IconRefresh size={14} />
              {settings.autoUpdate && nextDue
                ? `下次自动更新 ${formatFuture(nextDue)}`
                : '自动更新已关闭'}
            </span>
            {daily ? (
              <span className="meta-item">
                <IconSections size={14} />
                {regionCount} 个分区 · {totalItems} 条推荐
              </span>
            ) : null}
          </div>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            data-testid="run-now"
            onClick={onRunNow}
            disabled={running || busy}
          >
            <IconRefresh size={16} className={running || busy ? 'is-spinning' : ''} />
            {running ? '更新中…' : busy ? '处理中…' : '立即更新'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={openBilibili}>
            <IconExternal size={14} />
            打开 B 站
          </button>
        </div>
      </div>

      {running && <RunProgress status={status} />}

      {lastError && !running && (
        <Notice
          tone="error"
          title="上次更新失败"
          action={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRunNow}
              disabled={busy}
            >
              <IconRefresh size={13} />
              重试
            </button>
          }
        >
          {lastError}
        </Notice>
      )}

      {degraded && !running && (
        <Notice tone="warn" title="数据源降级">
          {degraded}
        </Notice>
      )}

      {accountError && !running && (
        <Notice
          tone="warn"
          title="登录状态检测失败"
          action={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRefreshAccount}
              disabled={accountRefreshing}
            >
              <IconRefresh size={13} className={accountRefreshing ? 'is-spinning' : ''} />
              重试
            </button>
          }
        >
          {account.error}
        </Notice>
      )}

      {loggedOut && !running && (
        <LoginHint
          account={account}
          refreshing={accountRefreshing}
          onRefresh={onRefreshAccount}
        />
      )}
    </header>
  );
}
