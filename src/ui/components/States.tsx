/**
 * 共用状态组件：状态角标、增长角标、运行进度、提示条、空态、错误态、骨架屏、Toast。
 */
import type { ReactNode } from 'react';
import type {
  AccountInfo,
  DailyResult,
  GrowthInfo,
  PipelineStage,
  RunStatus,
} from '../../shared/types';
import { relativeTime } from '../../shared/time';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  clamp01,
  growthBadgeText,
  growthBadgeTitle,
  progressPercent,
  stageLabel,
} from '../lib/view';
import type { ToastItem } from '../lib/types';
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconClose,
  IconInfo,
  IconRefresh,
  IconSpark,
  IconTrend,
  IconUser,
} from './Icons';

/* ------------------------------------------------------------------ */
/* 状态角标                                                            */
/* ------------------------------------------------------------------ */

export function StatusBadge({
  status,
  daily,
}: {
  status: RunStatus | null;
  daily: DailyResult | null;
}) {
  const running = status?.running ?? false;
  const lastError = status?.lastError;
  const updatedAt = status?.lastRunAt ?? daily?.generatedAt;

  let tone: 'run' | 'ok' | 'error' | 'idle' = 'idle';
  let label = '尚未更新';
  let title = '点击「立即更新」生成今日推荐';
  if (running) {
    tone = 'run';
    label = `更新中 · ${stageLabel(status?.stage)}`;
    title = `阶段：${stageLabel(status?.stage)} · ${progressPercent(status?.progress ?? 0)}`;
  } else if (lastError) {
    tone = 'error';
    label = '上次更新失败';
    title = lastError;
  } else if (updatedAt) {
    tone = 'ok';
    label = '已更新';
    title = `最近更新：${relativeTime(updatedAt)}`;
  }

  return (
    <span
      className={`status-badge status-badge--${tone}`}
      data-testid="status-badge"
      data-tone={tone}
      title={title}
    >
      <span className="status-dot" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 增长角标                                                            */
/* ------------------------------------------------------------------ */

export function GrowthBadge({ growth }: { growth: GrowthInfo }) {
  return (
    <span
      className={`growth-badge ${growth.estimated ? 'is-estimated' : 'is-measured'}`}
      data-testid="growth-badge"
      data-estimated={growth.estimated ? 'true' : 'false'}
      title={growthBadgeTitle(growth)}
    >
      <IconTrend size={11} strokeWidth={2.1} />
      {growthBadgeText(growth)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 运行进度                                                            */
/* ------------------------------------------------------------------ */

export function RunProgress({ status }: { status: RunStatus }) {
  const progress = clamp01(status.progress ?? 0);
  const stage = (status.stage ?? 'auth') as PipelineStage | 'idle';
  const currentIndex = STAGE_ORDER.indexOf(stage as PipelineStage);

  return (
    <div className="run-progress" data-testid="run-progress">
      <div className="run-progress-head">
        <span className="run-stage">
          <span className="spinner" aria-hidden="true" />
          正在{stageLabel(stage)}
        </span>
        <span className="run-percent">{status.requestCount ? `${status.requestCount} 次请求 · ` : ''}{progressPercent(progress)}</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-label="更新进度"
      >
        <span className="progress-fill" style={{ width: `${Math.max(4, progress * 100)}%` }} />
      </div>
      <ol className="stage-steps">
        {STAGE_ORDER.map((item, index) => {
          const state = currentIndex < 0 ? 'todo' : index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
          return (
            <li key={item} className={`stage-step stage-step--${state}`}>
              <span className="stage-dot">{state === 'done' ? <IconCheck size={9} /> : null}</span>
              {STAGE_LABELS[item]}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 提示条                                                              */
/* ------------------------------------------------------------------ */

interface NoticeProps {
  tone?: 'info' | 'warn' | 'error';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

export function Notice({ tone = 'info', icon, title, children, action }: NoticeProps) {
  const defaultIcon = tone === 'error' ? <IconAlert size={17} /> : <IconInfo size={17} />;
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon">{icon ?? defaultIcon}</span>
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

interface LoginHintProps {
  account?: AccountInfo | null;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function LoginHint({ account, refreshing, onRefresh }: LoginHintProps) {
  const last = account?.last;
  return (
    <div className="notice notice--info login-hint" data-testid="login-hint">
      <span className="notice-icon">
        <IconUser size={17} />
      </span>
      <div className="notice-body">
        <strong>未登录 B 站，当前为公开模式</strong>
        <p>
          只使用热门、排行榜与每周必看等公开数据；登录后可获得基于观看历史的个性化推荐、标签画像、
          收藏/关注信号与周报。
        </p>
        {last && (
          <p className="login-last">
            上次登录：{last.uname ?? '未知账号'}
            {last.mid ? `（UID ${last.mid}）` : ''} · {relativeTime(last.at)}
          </p>
        )}
      </div>
      <div className="notice-action">
        {onRefresh && (
          <button
            type="button"
            className="btn btn-sm btn-soft login-refresh"
            data-testid="login-refresh"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <IconRefresh size={13} className={refreshing ? 'is-spinning' : ''} />
            {refreshing ? '检测中…' : '已登录？刷新'}
          </button>
        )}
        <a
          className="btn btn-soft btn-sm"
          href="https://passport.bilibili.com/login?gourl=https%3A%2F%2Fwww.bilibili.com%2F"
          target="_blank"
          rel="noopener noreferrer"
        >
          去登录
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 统计卡片（标签页 / 周报共用）                                       */
/* ------------------------------------------------------------------ */

interface StatCardProps {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  hint?: ReactNode;
  testid?: string;
  /** 额外 data 属性，例如 data-stat="watched" */
  dataStat?: string;
  /** 额外 data 属性，例如 data-signal="favorite" */
  dataSignal?: string;
}

export function StatCard({ icon, value, label, hint, testid, dataStat, dataSignal }: StatCardProps) {
  return (
    <div className="stat-card" data-testid={testid} data-stat={dataStat} data-signal={dataSignal}>
      <span className="stat-icon">{icon}</span>
      <div className="stat-body">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
        {hint && <span className="stat-hint">{hint}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 空态 / 错误态 / 骨架屏                                              */
/* ------------------------------------------------------------------ */

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  testid?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  testid = 'empty-state',
}: EmptyStateProps) {
  return (
    <div
      className={`empty-state ${compact ? 'empty-state--compact' : ''}`}
      data-testid={testid}
    >
      <span className="empty-icon">{icon ?? <IconSpark size={26} />}</span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  mockMode?: boolean;
  hint?: string;
}

export function ErrorState({ message, onRetry, mockMode, hint }: ErrorStateProps) {
  return (
    <div className="error-state" data-testid="error-state">
      <span className="error-icon">
        <IconAlert size={26} />
      </span>
      <h2>仪表盘加载失败</h2>
      <p className="error-message">{message}</p>
      {hint && <p className="error-hint">{hint}</p>}
      {mockMode && (
        <p className="error-hint">
          当前为离线演示模式：<code>?mock=error</code> 会故意展示错误态，去掉参数即可恢复演示数据。
        </p>
      )}
      <div className="error-actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <IconRefresh size={15} />
          重试
        </button>
      </div>
      <ul className="error-tips">
        <li>确认从扩展页面打开（chrome-extension://…/dashboard.html）</li>
        <li>本地静态预览请加 <code>?mock=1</code></li>
        <li>扩展后台可能正在重启，稍等几秒再重试</li>
      </ul>
    </div>
  );
}

export function LoadingPage() {
  return (
    <div className="loading-page" data-testid="loading" aria-busy="true" aria-label="正在加载仪表盘">
      <div className="skeleton skeleton-hero" />
      <div className="skeleton skeleton-title" />
      <div className="skeleton-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton skeleton-cover" />
            <div className="skeleton skeleton-line skeleton-line--lg" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line--sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} data-testid="toast" role="status">
          <span className="toast-icon">
            {toast.kind === 'success' ? (
              <IconCheck size={14} />
            ) : toast.kind === 'error' ? (
              <IconAlert size={14} />
            ) : (
              <IconClock size={14} />
            )}
          </span>
          <span className="toast-text">{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭提示"
            onClick={() => onDismiss(toast.id)}
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
