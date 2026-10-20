/** 账号卡片：只读展示 B站登录状态，提供打开登录页与刷新检测入口。 */
import type { AccountInfo } from '../../shared/types';
import { relativeTime } from '../../shared/time';
import { BILI_PASSPORT_LOGIN_URL } from '../lib/view';
import { Avatar } from './Avatar';
import { IconExternal, IconRefresh } from './Icons';

export type AccountState = 'logged-in' | 'expired' | 'logged-out';

export function accountState(account: AccountInfo): AccountState {
  if (account.loggedIn) return 'logged-in';
  return account.last ? 'expired' : 'logged-out';
}

const STATE_LABEL: Record<AccountState, string> = {
  'logged-in': '已登录',
  expired: '登录已失效',
  'logged-out': '未登录',
};

interface AccountCardProps {
  account: AccountInfo;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function AccountCard({ account, refreshing = false, onRefresh }: AccountCardProps) {
  const state = accountState(account);
  const displayName = account.loggedIn
    ? account.uname ?? '已登录账号'
    : account.last?.uname ?? '未登录';
  const avatar = account.loggedIn ? account.face : account.last?.face;
  const mid = account.loggedIn ? account.mid : account.last?.mid;

  return (
    <div
      className="account-card"
      data-testid="account-card"
      data-logged-in={account.loggedIn ? 'true' : 'false'}
      data-state={state}
      data-checked-at={account.checkedAt}
    >
      <Avatar src={avatar} name={displayName} size="lg" className="account-avatar" />
      <div className="account-main">
        <div className="account-name-row">
          <span className="account-name">{displayName}</span>
          <span
            className={`account-status account-status--${state}`}
            data-testid="account-status"
            data-state={state}
          >
            {STATE_LABEL[state]}
          </span>
        </div>
        <dl className="account-meta">
          <div>
            <dt>UID</dt>
            <dd>{mid ?? '—'}</dd>
          </div>
          <div>
            <dt>最近检测</dt>
            <dd>{account.checkedAt > 0 ? relativeTime(account.checkedAt) : '—'}</dd>
          </div>
          <div>
            <dt>上次登录</dt>
            <dd>
              {account.last
                ? `${account.last.uname ?? '未知账号'} · ${relativeTime(account.last.at)}`
                : account.loggedIn
                  ? '当前账号已登录'
                  : '暂无记录'}
            </dd>
          </div>
        </dl>
        {account.error && <p className="account-error">检测异常：{account.error}</p>}
        <div className="account-actions">
          <a
            className="btn btn-sm btn-ghost"
            data-testid="account-login"
            href={BILI_PASSPORT_LOGIN_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconExternal size={13} />
            打开 B站登录
          </a>
          {onRefresh && (
            <button
              type="button"
              className="btn btn-sm btn-soft"
              data-testid="account-refresh"
              data-refreshing={refreshing ? 'true' : 'false'}
              disabled={refreshing}
              onClick={onRefresh}
            >
              <IconRefresh size={13} className={refreshing ? 'is-spinning' : ''} />
              {refreshing ? '刷新中…' : '刷新登录状态'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
