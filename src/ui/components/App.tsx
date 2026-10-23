/** 仪表盘外壳：左侧导航 + Hero + 页面路由 + Toast。 */
import { useEffect } from 'react';
import { useDashboard } from '../lib/hooks';
import { usePage } from '../lib/router';
import { Sidebar } from './Sidebar';
import { Hero } from './Hero';
import { ErrorState, LoadingPage, ToastStack } from './States';
import { IconAlert } from './Icons';
import { TodayPage } from '../pages/TodayPage';
import { SectionsPage } from '../pages/SectionsPage';
import { GrowthPage } from '../pages/GrowthPage';
import { WeeklyPage } from '../pages/WeeklyPage';
import { TagsPage } from '../pages/TagsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { hourLabel } from '../lib/view';

export default function App() {
  const dashboard = useDashboard();
  const page = usePage();
  const { data, status } = dashboard;

  const theme = data?.settings.theme ?? 'auto';
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    root.style.colorScheme = theme === 'auto' ? 'light dark' : theme;
  }, [theme]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [page]);

  const runNow = () => {
    void dashboard.runNow();
  };

  const renderPage = () => {
    if (!data) return null;
    switch (page) {
      case 'today':
        return <TodayPage data={data} onDismiss={dashboard.dismiss} onRunNow={runNow} />;
      case 'sections':
        return <SectionsPage data={data} onDismiss={dashboard.dismiss} onRunNow={runNow} />;
      case 'growth':
        return <GrowthPage data={data} onDismiss={dashboard.dismiss} onRunNow={runNow} />;
      case 'weekly':
        return (
          <WeeklyPage
            weekly={dashboard.weekly}
            loading={dashboard.weeklyLoading}
            error={dashboard.weeklyError}
            loggedIn={data.account.loggedIn}
            onLoad={(weekKey) => {
              void dashboard.loadWeeklyReport(weekKey);
            }}
            onGenerate={dashboard.generateWeekly}
          />
        );
      case 'tags':
        return <TagsPage data={data} onUpdateSettings={dashboard.updateSettings} />;
      case 'settings':
        return (
          <SettingsPage
            data={data}
            busy={dashboard.busy}
            apiMode={dashboard.apiMode}
            accountRefreshing={dashboard.accountRefreshing}
            onRefreshAccount={() => {
              void dashboard.refreshAccount();
            }}
            onUpdateSettings={dashboard.updateSettings}
            onClearData={dashboard.clearData}
            onExportBackup={dashboard.exportBackup}
            onImportBackup={dashboard.importBackup}
          />
        );
      default:
        return null;
    }
  };

  const liveStatus = status ?? data?.status ?? null;

  return (
    <div
      className="app"
      data-testid="dashboard"
      data-page={page}
      data-mode={dashboard.apiMode ?? 'loading'}
    >
      <Sidebar
        page={page}
        status={liveStatus}
        daily={data?.daily ?? null}
        apiMode={dashboard.apiMode}
        tagCount={data?.profile?.tags.length}
      />

      <main className="main">
        <div className="main-inner">
          {dashboard.loading && !data ? (
            <LoadingPage />
          ) : dashboard.error && !data ? (
            <ErrorState
              message={dashboard.error}
              onRetry={dashboard.retry}
              mockMode={dashboard.apiMode === 'mock'}
            />
          ) : data ? (
            <>
              <Hero
                data={data}
                status={liveStatus ?? data.status}
                busy={dashboard.busy}
                onRunNow={runNow}
                mockMode={dashboard.apiMode === 'mock'}
                onRefreshAccount={() => {
                  void dashboard.refreshAccount();
                }}
                accountRefreshing={dashboard.accountRefreshing}
              />

              {renderPage()}

              {dashboard.error && (
                <div className="inline-error" role="status">
                  <IconAlert size={14} />
                  刷新最新数据失败：{dashboard.error}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      void dashboard.reload();
                    }}
                  >
                    重试
                  </button>
                </div>
              )}

              <footer className="site-footer">
                <span>B站每日必看 · v0.2.4</span>
                <span aria-hidden="true">·</span>
                <span>数据只保存在本机</span>
                <span aria-hidden="true">·</span>
                <span>每天 {hourLabel(data.settings.updateHour)} 自动更新</span>
                <a href="#/settings">设置</a>
              </footer>
            </>
          ) : null}
        </div>
      </main>

      <ToastStack toasts={dashboard.toasts} onDismiss={dashboard.dismissToast} />
    </div>
  );
}
