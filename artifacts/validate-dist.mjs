/**
 * dist 静态产物校验（不启动浏览器，沙箱内也能跑）。
 *
 * 校验项：
 * 1) dist/manifest.json 是合法 MV3 JSON，权限/内容脚本/service worker 配置正确；
 * 2) dashboard.html 引用的 JS/CSS 都存在；
 * 3) dist 关键文件齐全；
 * 4) 构建产物里包含 e2e 依赖的 data-testid、后台消息类型、内容脚本关键逻辑。
 *
 * 注意：Vite/rolldown 压缩后字符串会使用反引号（如 `"data-testid":`dashboard``），
 * 所以这里同时匹配三种引号形式。
 *
 * 运行：node artifacts/validate-dist.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve('dist');
const failures = [];

function check(name, task) {
  try {
    const detail = task();
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`❌ ${name} — ${error instanceof Error ? error.message : error}`);
  }
}

/** 匹配压缩产物里的字符串字面量（双引号/单引号/反引号） */
function containsLiteral(source, literal) {
  return (
    source.includes(`"${literal}"`) ||
    source.includes(`'${literal}'`) ||
    source.includes(`\`${literal}\``)
  );
}

check('dist/manifest.json 是合法 MV3 JSON', () => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('不是 MV3');
  if (manifest.background?.service_worker !== 'background.js') throw new Error('service_worker 不对');
  if (manifest.background?.type !== 'module') throw new Error('service worker 不是 module');
  if (!manifest.permissions?.includes('alarms')) throw new Error('缺少 alarms 权限');
  if (!manifest.permissions?.includes('storage')) throw new Error('缺少 storage 权限');
  if (!manifest.host_permissions?.some((item) => item.includes('api.bilibili.com'))) {
    throw new Error('缺少 api.bilibili.com 主机权限');
  }
  if (manifest.content_scripts?.[0]?.js?.join(',') !== 'content.js') throw new Error('content script 配置不对');
  return `name=${manifest.name}, version=${manifest.version}, content=${manifest.content_scripts[0].js.join(',')}`;
});

check('dashboard.html 引用的资源都存在', () => {
  const html = readFileSync(join(DIST, 'dashboard.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  if (refs.length === 0) throw new Error('没有解析到任何资源引用');
  const missing = refs.filter((ref) => !existsSync(join(DIST, ref.replace(/^\.\//, ''))));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join(', ')}`);
  return refs.join(', ');
});

check('dist 关键文件齐全', () => {
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'dashboard.html',
    'icons/icon16.png',
    'icons/icon128.png',
  ];
  const missing = required.filter((relative) => !existsSync(join(DIST, relative)));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join(', ')}`);
  return required.join(', ');
});

check('UI 产物的 data-testid 覆盖 e2e 断言所需', () => {
  const assets = readdirSync(join(DIST, 'assets'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(DIST, 'assets', file), 'utf8'))
    .join('\n');
  const literals = [
    'dashboard',
    'today',
    'sections',
    'growth',
    'tags',
    'settings',
    'section',
    'video-card',
    'tag-cloud',
    'tag',
    'growth-badge',
    'status-badge',
    'login-hint',
    'empty-state',
    'error-state',
    'run-now',
    'run-progress',
    'toast',
    'hero',
    // v0.2.0 账号
    'account-panel',
    'account-card',
    'account-status',
    'account-login',
    'account-refresh',
    'hero-account-name',
    'login-refresh',
    // v0.2.0 备份
    'backup-panel',
    'backup-export',
    'backup-import',
    'backup-file-input',
    'backup-confirm',
    'backup-confirm-import',
    'backup-import-summary',
    'backup-error',
    // v0.2.0 周报
    'weekly',
    'weekly-label',
    'weekly-week-picker',
    'weekly-stat',
    'weekly-summary',
    'weekly-trend',
    'weekly-trend-bar',
    'weekly-tags',
    'weekly-tag',
    'weekly-movers',
    'weekly-rising',
    'weekly-falling',
    'weekly-mover',
    'weekly-regions',
    'weekly-ups',
    'weekly-empty',
    'weekly-refresh',
    'weekly-loading',
    'weekly-error',
    // v0.2.0 兴趣信号
    'signal-strip',
    'signal-stat',
    'signal-favorites',
    'favorite-ups',
    'favorite-up',
    'followed-ups',
    'followed-up',
    'signal-watchlater',
    'watchlater-regions',
    'watchlater-tags',
    'watchlater-tag',
    'favorite-fallback',
  ];
  const missing = literals.filter((literal) => !containsLiteral(assets, literal));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join(', ')}`);
  // nav-${id} 是模板字符串，退化为检查前缀
  if (!assets.includes('nav-')) throw new Error('缺少 nav-* 导航 testid');
  const testidCount = assets.split('data-testid').length - 1;
  if (testidCount < 40) throw new Error(`data-testid 出现次数偏少：${testidCount}`);
  return `${literals.length} 个 testid + nav-* 模板；构建产物里 data-testid 出现 ${testidCount} 次`;
});

check('background.js 含关键逻辑标记', () => {
  const background = readFileSync(join(DIST, 'background.js'), 'utf8');
  const required = [
    'pipeline-tick',
    'daily-update',
    'GET_DASHBOARD_DATA',
    'GET_STATUS',
    'SET_SETTINGS',
    'RUN_NOW',
    'CLEAR_DATA',
    'DISMISS',
    'OPEN_DASHBOARD',
    // v0.2.0
    'REFRESH_ACCOUNT',
    'GET_WEEKLY_REPORT',
    'EXPORT_BACKUP',
    'IMPORT_BACKUP',
    'bili-daily-picks-backup-',
    'pipeline:tick-lock',
    'floating:dismissed',
    'getContexts',
  ];
  const missing = required.filter((text) => !background.includes(text));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join(', ')}`);
  return `${required.length} 个关键标记都在`;
});

check('content.js 含悬浮入口与 API_FETCH 白名单', () => {
  const content = readFileSync(join(DIST, 'content.js'), 'utf8');
  const required = [
    'floating-entry',
    'floating-button',
    'floating-close',
    'API_FETCH',
    'api.bilibili.com',
    'floating:dismissed',
    'showFloatingButton',
  ];
  const missing = required.filter((text) => !content.includes(text));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join(', ')}`);
  return `${required.length} 个关键标记都在`;
});

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} 项校验失败`);
  process.exitCode = 1;
} else {
  console.log('\n✅ dist 静态产物校验通过');
}
