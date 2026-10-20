/** 设置：账号、推荐数量、自动更新、数据源、界面、数据备份、数据管理与隐私说明。 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { DashboardData, ImportSummary, Settings, SourceKind } from '../../shared/types';
import { BACKUP_LIMITS, SOURCE_LABELS } from '../../shared/constants';
import { relativeTime } from '../../shared/time';
import { PageIntro } from '../components/PageIntro';
import { Segmented, SelectField, SettingRow, Stepper, Switch } from '../components/Controls';
import { AccountCard } from '../components/AccountCard';
import { Notice } from '../components/States';
import {
  IconCheck,
  IconClock,
  IconDownload,
  IconInfo,
  IconRefresh,
  IconSettings,
  IconShield,
  IconTrash,
  IconUpload,
  IconUser,
} from '../components/Icons';
import type { ExportBackupResult } from '../lib/types';
import {
  errorMessage,
  formatBytes,
  formatFuture,
  hourLabel,
  nextUpdateAt,
} from '../lib/view';

interface SettingsPageProps {
  data: DashboardData;
  busy: boolean;
  apiMode: 'extension' | 'mock' | null;
  /** 账号刷新中 */
  accountRefreshing: boolean;
  onRefreshAccount: () => void;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  onClearData: () => Promise<void>;
  onExportBackup: () => Promise<ExportBackupResult | null>;
  onImportBackup: (json: string) => Promise<ImportSummary | null>;
}

const SOURCE_KINDS: SourceKind[] = [
  'popular',
  'ranking',
  'regionRanking',
  'weekly',
  'rcmd',
  'related',
];

const SOURCE_DESCRIPTIONS: Record<SourceKind, string> = {
  popular: '全站热门视频，适合发现大众话题',
  ranking: '全站排行榜，综合质量稳定',
  regionRanking: '你常看分区内的排行榜',
  weekly: 'B 站官方每周必看，编辑精选',
  rcmd: '登录态下的「猜你喜欢」',
  related: '和你最近看过的高质量视频相关',
};

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, '0')}:00`,
}));

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;

type SaveState = 'idle' | 'saving' | 'saved';

interface PendingImport {
  fileName: string;
  size: number;
  json: string;
}

export function SettingsPage({
  data,
  busy,
  apiMode,
  accountRefreshing,
  onRefreshAccount,
  onUpdateSettings,
  onClearData,
  onExportBackup,
  onImportBackup,
}: SettingsPageProps) {
  const settings = data.settings;
  const daily = data.daily;
  const status = data.status;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportBackupResult | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const applyPatch = async (patch: Partial<Settings>): Promise<void> => {
    setSaveState('saving');
    const ok = await onUpdateSettings(patch);
    if (!ok) {
      setSaveState('idle');
      return;
    }
    setSaveState('saved');
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaveState('idle'), 1800);
  };

  const enabledSourceCount = SOURCE_KINDS.filter((kind) => settings.enabledSources[kind]).length;
  // 引擎最终只会取前 5 个分区板块（sections.ts 硬截断），这里按有效值展示，避免出现「选 6 却不生效」
  const effectiveRegionSections = Math.min(settings.regionSections, 5);
  const nextAuto = nextUpdateAt(settings.updateHour);
  const lastUpdated = status.lastRunAt ?? daily?.generatedAt;

  const handleClear = async (): Promise<void> => {
    await onClearData();
    setConfirmingClear(false);
  };

  /** 导出备份：拿到后台完整 JSON 后用 Blob 触发浏览器下载 */
  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await onExportBackup();
      if (!result) return;
      const blob = new Blob([result.json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setLastExport(result);
      setImportError(null);
    } catch (err) {
      setImportError(`导出失败：${errorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  /** 选择备份文件：先本地读取并做体积校验，随后进入二次确认 */
  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportSummary(null);
    setImportError(null);
    if (file.size > BACKUP_LIMITS.jsonBytes) {
      setImportError(
        `备份文件过大（${formatBytes(file.size)}），上限 ${BACKUP_LIMITS.jsonBytes / 1024 / 1024}MB。`,
      );
      return;
    }
    try {
      const json = await file.text();
      setPendingImport({ fileName: file.name, size: file.size, json });
    } catch {
      setImportError('读取备份文件失败，请重试。');
    }
  };

  const handleConfirmImport = async (): Promise<void> => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const summary = await onImportBackup(pendingImport.json);
      if (summary) {
        setImportSummary(summary);
        setPendingImport(null);
        setImportError(null);
      } else {
        setImportError('导入失败，当前数据未改动。');
      }
    } finally {
      setImporting(false);
    }
  };

  const handleCancelImport = (): void => {
    setPendingImport(null);
    setImportError(null);
  };

  return (
    <div className="page" data-testid="settings">
      <PageIntro
        eyebrow="偏好设置"
        title="设置"
        description="所有设置即时保存到本机浏览器，不会上传到任何服务器。"
      >
        <span className={`save-state save-state--${saveState}`} data-testid="settings-save-state">
          {saveState === 'saving' ? (
            <>
              <IconRefresh size={13} className="is-spinning" />
              保存中…
            </>
          ) : saveState === 'saved' ? (
            <>
              <IconCheck size={13} />
              已保存
            </>
          ) : apiMode === 'mock' ? (
            <>离线演示</>
          ) : (
            <>自动保存</>
          )}
        </span>
      </PageIntro>

      {apiMode === 'mock' && (
        <Notice tone="info" title="离线演示模式">
          当前通过 <code>?mock=1</code> 使用 tests/fixtures 合成的数据；设置只写入本页内存，刷新页面后会恢复默认值。
        </Notice>
      )}

      <div className="settings-grid">
        <section className="panel panel--wide" data-testid="account-panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconUser size={15} />
              账号
            </h3>
            <span className="panel-hint">只读检测登录状态，不读取 cookie / 密码</span>
          </div>
          <AccountCard
            account={data.account}
            refreshing={accountRefreshing}
            onRefresh={onRefreshAccount}
          />
          <p className="setting-desc">
            登录状态用于采集观看历史、收藏 / 关注 / 稍后再看信号与个性化推荐；检测只调用
            B站公开的登录状态接口，不会保存任何登录凭据。
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconSettings size={15} />
              推荐数量
            </h3>
            <span className="panel-hint">保存后下次生成生效</span>
          </div>
          <SettingRow
            title="每个分区板块的视频数量"
            description="2–5 个；数量越少越精致，越多越容易刷到新内容。"
            control={
              <Stepper
                value={settings.perSection}
                min={2}
                max={5}
                label="每个分区板块的视频数量"
                testid="setting-per-section"
                disabled={busy}
                onChange={(next) => {
                  void applyPatch({ perSection: next });
                }}
              />
            }
          />
          <SettingRow
            title="展示的分区板块数量"
            description="2–5 个；按分区偏好从高到低取板块。"
            control={
              <Stepper
                value={effectiveRegionSections}
                min={2}
                max={5}
                label="展示的分区板块数量"
                testid="setting-region-sections"
                disabled={busy}
                onChange={(next) => {
                  void applyPatch({ regionSections: next });
                }}
              />
            }
          />
          <p className="setting-summary">
            当前：最多 <strong>{effectiveRegionSections}</strong> 个分区板块，每个板块{' '}
            <strong>{settings.perSection}</strong> 个视频。
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconClock size={15} />
              每日更新
            </h3>
          </div>
          <SettingRow
            title="自动更新"
            description="浏览器保持运行时，每天自动生成一次今日推荐。"
            control={
              <Switch
                checked={settings.autoUpdate}
                label="自动更新"
                testid="setting-auto-update"
                disabled={busy}
                onChange={(next) => {
                  void applyPatch({ autoUpdate: next });
                }}
              />
            }
          />
          <SettingRow
            title="更新时间"
            description={
              settings.autoUpdate
                ? `每天 ${hourLabel(settings.updateHour)} 触发；下次约在 ${formatFuture(nextAuto)}。`
                : '自动更新已关闭，仍可随时点右上角「立即更新」。'
            }
            control={
              <SelectField
                value={String(settings.updateHour)}
                options={HOUR_OPTIONS}
                label="更新时间"
                testid="setting-update-hour"
                disabled={busy || !settings.autoUpdate}
                onChange={(next) => {
                  void applyPatch({ updateHour: Number(next) });
                }}
              />
            }
          />
          <SettingRow
            title="最近一次更新"
            description={
              lastUpdated
                ? `${relativeTime(lastUpdated)}${status.lastError ? ` · 上次失败：${status.lastError}` : ''}`
                : '还没有运行过'
            }
            control={
              <span className="chip">
                <IconRefresh size={12} />
                {status.running ? '运行中' : '空闲'}
              </span>
            }
          />
        </section>

        <section className="panel panel--wide">
          <div className="panel-head">
            <h3 className="panel-title">数据源</h3>
            <span className="panel-hint">
              已启用 {enabledSourceCount} / {SOURCE_KINDS.length} 个
            </span>
          </div>
          <div className="source-grid">
            {SOURCE_KINDS.map((kind) => {
              const enabled = settings.enabledSources[kind];
              const isLastOne = enabled && enabledSourceCount === 1;
              return (
                <SettingRow
                  key={kind}
                  title={SOURCE_LABELS[kind]}
                  description={
                    isLastOne ? '至少保留一个数据源，否则推荐会为空。' : SOURCE_DESCRIPTIONS[kind]
                  }
                  control={
                    <Switch
                      checked={enabled}
                      label={SOURCE_LABELS[kind]}
                      testid={`setting-source-${kind}`}
                      disabled={busy || isLastOne}
                      onChange={(next) => {
                        void applyPatch({ enabledSources: { ...settings.enabledSources, [kind]: next } });
                      }}
                    />
                  }
                />
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title">界面</h3>
          </div>
          <SettingRow
            title="主题"
            description="默认跟随系统深浅色，也可以固定浅色或深色。"
            control={
              <Segmented
                value={settings.theme}
                options={THEME_OPTIONS}
                label="主题"
                testid="setting-theme"
                disabled={busy}
                onChange={(next) => {
                  void applyPatch({ theme: next });
                }}
              />
            }
          />
          <SettingRow
            title="B 站页面悬浮按钮"
            description="在 bilibili.com 右下角显示入口圆钮，点击打开仪表盘。"
            control={
              <Switch
                checked={settings.showFloatingButton}
                label="B 站页面悬浮按钮"
                testid="setting-floating-button"
                disabled={busy}
                onChange={(next) => {
                  void applyPatch({ showFloatingButton: next });
                }}
              />
            }
          />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconInfo size={15} />
              关于
            </h3>
          </div>
          <dl className="info-list">
            <div>
              <dt>版本</dt>
              <dd>v0.2.2</dd>
            </div>
            <div>
              <dt>运行模式</dt>
              <dd>{apiMode === 'mock' ? '离线演示（?mock=1）' : 'Chrome 扩展'}</dd>
            </div>
            <div>
              <dt>数据存储</dt>
              <dd>IndexedDB + chrome.storage.local</dd>
            </div>
            <div>
              <dt>今日结果</dt>
              <dd>{daily ? `${daily.date} · ${daily.sections.length} 个板块` : '尚未生成'}</dd>
            </div>
            <div>
              <dt>历史样本</dt>
              <dd>{data.profile ? `${data.profile.sample.total} 条` : '未采集'}</dd>
            </div>
          </dl>
        </section>

        <section className="panel panel--wide" data-testid="backup-panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconDownload size={15} />
              数据备份
            </h3>
            <span className="panel-hint">本地 JSON 文件</span>
          </div>
          <SettingRow
            title="导出 / 导入备份"
            description="导出包含设置、观看历史、增长快照、推荐结果、画像、拉黑与周报；导入会覆盖当前全部本地数据，且不可撤销。"
            control={
              <div className="backup-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-testid="backup-export"
                  disabled={busy || exporting}
                  onClick={() => {
                    void handleExport();
                  }}
                >
                  <IconDownload size={14} />
                  {exporting ? '导出中…' : '导出备份'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-testid="backup-import"
                  disabled={busy || importing}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconUpload size={14} />
                  导入备份
                </button>
              </div>
            }
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            data-testid="backup-file-input"
            onChange={(event) => {
              void handleFileChange(event);
            }}
          />
          <p className="backup-warning">
            备份文件包含完整观看历史，且未加密；请妥善保管，不要上传到公开位置。导入覆盖前建议先导出一份当前数据。
          </p>
          {lastExport && (
            <p className="backup-meta" data-testid="backup-export-info">
              已导出 <strong>{lastExport.filename}</strong>（{formatBytes(lastExport.bytes)}）
            </p>
          )}
          {pendingImport && (
            <div className="backup-confirm" data-testid="backup-confirm">
              <p className="backup-confirm-title">
                <strong>{pendingImport.fileName}</strong> · {formatBytes(pendingImport.size)}
              </p>
              <p className="setting-desc">
                导入将覆盖当前全部本地数据（历史、推荐、画像、周报、拉黑与设置），此操作不可撤销。
              </p>
              <div className="backup-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-testid="backup-confirm-import"
                  disabled={importing || busy}
                  onClick={() => {
                    void handleConfirmImport();
                  }}
                >
                  {importing ? '导入中…' : '确认导入'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="backup-cancel-import"
                  disabled={importing}
                  onClick={handleCancelImport}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {importSummary && (
            <div className="backup-summary" data-testid="backup-import-summary">
              <p className="backup-summary-title">
                <IconCheck size={14} />
                备份导入成功
              </p>
              <dl className="backup-summary-grid">
                <div>
                  <dt>历史记录</dt>
                  <dd>{importSummary.history} 条</dd>
                </div>
                <div>
                  <dt>增长快照</dt>
                  <dd>{importSummary.snapshots} 条</dd>
                </div>
                <div>
                  <dt>推荐结果</dt>
                  <dd>{importSummary.daily} 天</dd>
                </div>
                <div>
                  <dt>周报</dt>
                  <dd>{importSummary.weekly} 份</dd>
                </div>
                <div>
                  <dt>不感兴趣</dt>
                  <dd>{importSummary.dismissed} 条</dd>
                </div>
                <div>
                  <dt>画像</dt>
                  <dd>{importSummary.hasProfile ? '有' : '无'}</dd>
                </div>
              </dl>
              {importSummary.dropped > 0 && (
                <p className="setting-desc">已忽略 {importSummary.dropped} 条无效记录。</p>
              )}
            </div>
          )}
          {importError && (
            <p className="backup-error" data-testid="backup-error">
              {importError}
            </p>
          )}
        </section>

        <section className="panel panel--wide danger-panel">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconTrash size={15} />
              数据管理
            </h3>
            <span className="chip chip--warn">谨慎操作</span>
          </div>
          <SettingRow
            title="清空我的数据"
            description="删除本扩展保存的本地历史副本、标签画像、推荐结果、增长快照与全部设置；不会改动你的 B站账号数据。清空后自动更新会暂停。"
            control={
              confirmingClear ? (
                <div className="danger-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="confirm-clear"
                    disabled={busy}
                    onClick={() => {
                      void handleClear();
                    }}
                  >
                    确认清空
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmingClear(false)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger-ghost"
                  data-testid="clear-data"
                  disabled={busy}
                  onClick={() => setConfirmingClear(true)}
                >
                  <IconTrash size={14} />
                  清空我的数据
                </button>
              )
            }
          />
          {confirmingClear && (
            <p className="danger-hint">
              确认后会立即删除全部本地数据并暂停自动更新，扩展回到「未初始化」状态；需要时可在
              「自动更新」里重新开启，或点右上角「立即更新」手动生成。
            </p>
          )}
        </section>

        <section className="panel panel--wide">
          <div className="panel-head">
            <h3 className="panel-title">
              <IconShield size={15} />
              隐私说明
            </h3>
          </div>
          <ul className="privacy-list">
            <li>只读调用 <code>api.bilibili.com</code> 的官方网页接口，不读写、不保存你的 cookie。</li>
            <li>只读调用收藏夹、关注列表与稍后再看接口用于完善推荐画像，不会修改或删除你的任何 B站数据。</li>
            <li>历史记录、画像、推荐结果与增长快照只保存在本机浏览器，不向任何第三方发送。</li>
            <li>导出的备份文件未加密，包含完整观看历史，请妥善保管。</li>
            <li>没有远程代码、没有埋点统计、没有账号体系。</li>
            <li>源码可审计；你可以随时用「清空我的数据」删除全部本地记录。</li>
            <li>仅供个人学习与自用，请遵守 B 站用户协议，不要用于批量抓取或商业用途。</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
