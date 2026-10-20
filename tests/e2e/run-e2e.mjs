#!/usr/bin/env node
/**
 * 端到端验收脚本（playwright-core 直接驱动本机 Chrome，无 Playwright Test Runner）。
 *
 * 覆盖：
 * 1) 仪表盘（?mock=1，本地静态服务托管 dist）：data-testid、分区板块与视频卡数量、
 *    标签数量、增长角标、设置页、mock 空态/错误态/未登录态、立即更新流程，
 *    并输出 1440×900 / 1024×768 截图；
 * 2) 加载真实扩展（--disable-extensions-except / --load-extension）：从 service worker
 *    取扩展 id 打开 chrome-extension://<id>/dashboard.html，检查无 console error、
 *    后台消息路由、闹钟注册；并做 service worker 直连 api.bilibili.com 的风控探测
 *    （code=0 直连可用；code=-352 需要 DNR 改 Referer/Origin，结果写入摘要）；
 * 3) 打开 bilibili.com 检查右下角悬浮入口、关闭记忆与 API_FETCH 安全校验；网络受限时
 *    记录 skip，并用本地兜底页继续验证内容脚本（不依赖外网）。
 *
 * 用法：
 *   node tests/e2e/run-e2e.mjs                # 全部两个阶段
 *   node tests/e2e/run-e2e.mjs --only=mock    # 只跑仪表盘截图
 *   node tests/e2e/run-e2e.mjs --only=extension
 *
 * 输出：artifacts/screenshots/*.png 与 artifacts/e2e-summary.json；有失败项时 exit code 为 1。
 *
 * 浏览器：默认用 Playwright 自带 Chromium（不传 executablePath）。
 * 稳定版 Chrome 137+ 已移除 `--load-extension` 命令行开关，系统 Chrome 无法加载未打包扩展；
 * 没有 Playwright 自带浏览器时，可用环境变量 BDP_CHROME_PATH 指向一个支持 --load-extension
 * 的 Chromium 构建（例如 npmmirror 的 Chromium 开源快照）：
 *   $env:BDP_CHROME_PATH = '.tools\chromium\chrome-win\chrome.exe'; npm run e2e
 *
 * 排障用环境变量：
 *   BDP_E2E_HEADLESS=1        # 无头模式（默认 headed）
 *   BDP_E2E_PROFILE_ROOT=<custom-dir>
 *                             # 自定义浏览器 profile 根目录（默认工作区 artifacts/.e2e-profiles）；
 *                             # 默认放在工作区是因为系统 %TEMP% 路径下可能触发
 *                             # Chromium ProcessSingleton 失败
 * 若在本机沙箱内直接运行会因为 Chrome 沙箱/Mojo 命名管道被拒而失败，需要真正提权运行。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, 'artifacts');
const SCREENSHOTS = join(ARTIFACTS, 'screenshots');
/** e2e 运行期临时文件（下载的备份 / 导入 fixture），不属于交付截图 */
const E2E_TMP = join(ARTIFACTS, '.e2e-tmp');

/** 可选：外部 Chromium 可执行文件路径（未设置时用 Playwright 默认 Chromium） */
const CHROME_PATH = process.env.BDP_CHROME_PATH?.trim() || null;
/** 自定义 profile 根目录（用于排查 profile 单实例锁问题） */
const PROFILE_ROOT = process.env.BDP_E2E_PROFILE_ROOT?.trim() || null;
/** 无头模式（默认 headed；无头可用于排查不可见桌面/会话问题） */
const HEADLESS = /^(1|true|yes)$/i.test(process.env.BDP_E2E_HEADLESS ?? '');
/** e2e 摘要里展示的浏览器标识 */
const BROWSER_LABEL = CHROME_PATH ?? 'Playwright 默认 Chromium';

const results = [];
const screenshots = [];
const cleanupTasks = [];
/** 写进 e2e-summary.json 的附加信息（如 SW 直连风控探测结果） */
const extraSummary = {};

/** 网络类 console error 视为可忽略（离线/图片加载失败不算页面 JS 错误） */
const IGNORABLE_CONSOLE_PATTERNS = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|TIMED_OUT|BLOCKED|ABORTED)/i,
  /favicon/i,
  /Download the React DevTools/i,
  /DevTools failed to load/i,
];

const MOCK_BILIBILI_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>哔哩哔哩（本地兜底页）</title></head>
  <body><div id="app"><h1>哔哩哔哩</h1><p>网络受限时用于验证内容脚本注入的本地页面。</p></div></body>
</html>`;

/**
 * v0.2.0：导入备份用的最小合法 BackupFile（app + schemaVersion + data 必须齐全）。
 * 结构与 buildBackupFile 输出一致，parseBackup 校验后应 0 丢弃。
 */
function buildBackupFixture() {
  const now = Date.now();
  return JSON.stringify({
    app: 'bili-daily-picks',
    schemaVersion: 1,
    appVersion: '0.1.0',
    exportedAt: now,
    data: {
      settings: {
        perSection: 4,
        autoUpdate: true,
        updateHour: 5,
        enabledSources: {
          popular: true,
          ranking: true,
          regionRanking: true,
          weekly: true,
          rcmd: true,
          related: true,
        },
        showFloatingButton: true,
        theme: 'light',
        regionSections: 4,
        tagWindow: '30d',
      },
      history: [
        {
          bvid: 'BV1e2eimport01',
          title: '导入测试视频（e2e）',
          viewedAt: Math.floor(now / 1000) - 3600,
          duration: 600,
          progress: 300,
          tname: '手机游戏',
          parentRegion: '游戏',
        },
      ],
      snapshots: [],
      daily: [
        {
          date: '2026-10-20',
          generatedAt: now - 86_400_000,
          mode: 'full',
          sections: [],
          profileSummary: { topRegions: [], topTags: [] },
          meta: { candidates: 0, requests: 0, durationMs: 0, sources: [] },
        },
      ],
      profile: null,
      dismissed: [{ bvid: 'BV1e2edismiss', at: now }],
      weeklyReports: [],
    },
  });
}

/* ------------------------------------------------------------------ */
/* 日志与断言                                                          */
/* ------------------------------------------------------------------ */

/** 摘要脱敏：未打包扩展 ID 由本地扩展目录路径派生，回环端口每次随机，均不应写进仓库 */
function sanitizeDetail(detail) {
  if (!detail) return detail;
  return String(detail)
    .replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://<extension-id>')
    .replace(/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<port>');
}

function record(status, name, detail = '') {
  const safeDetail = sanitizeDetail(detail);
  results.push({ status, name, detail: safeDetail });
  const icon = status === 'pass' ? '✅' : status === 'skip' ? '⚠️ ' : '❌';
  console.log(`${icon} [${status}] ${name}${safeDetail ? ` — ${safeDetail}` : ''}`);
}

const pass = (name, detail) => record('pass', name, detail);
const fail = (name, detail) => record('fail', name, detail);
const skip = (name, detail) => record('skip', name, detail);

function short(error) {
  const text = error instanceof Error ? error.message : String(error);
  return sanitizeDetail(text.split('\n')[0].trim().slice(0, 400));
}

/** 启动失败时给可操作的中文提示（写进 e2e 摘要，便于排障） */
function launchFailureHint(message) {
  if (/ProcessSingleton/i.test(message)) {
    return '（Chromium 无法创建 profile 单实例锁：通常是运行环境没有可交互桌面/会话被隔离，或 profile 目录不可写、被占用。可试 BDP_E2E_PROFILE_ROOT 指向 ASCII 可写目录 + BDP_E2E_HEADLESS=1；沙箱内需要真正提权的交互式会话）';
  }
  if (/spawn EPERM/i.test(message)) {
    return '（沙箱禁止管道子进程：Playwright 无法拉起浏览器，需要在普通终端/真正提权的环境运行）';
  }
  if (/Executable doesn't exist|Executable file not found/i.test(message)) {
    return '（找不到浏览器可执行文件：设置 BDP_CHROME_PATH，或安装 Playwright Chromium）';
  }
  return '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 断言式检查：抛错记 fail，正常记 pass */
async function check(name, task) {
  try {
    const detail = await task();
    pass(name, typeof detail === 'string' ? detail : detail?.detail ?? '');
    return detail;
  } catch (error) {
    fail(name, short(error));
    return undefined;
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/* ------------------------------------------------------------------ */
/* 浏览器启动                                                          */
/* ------------------------------------------------------------------ */

function rememberCleanup(task) {
  cleanupTasks.push(task);
}

function cleanupDirectory(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

/** 浏览器 profile 根目录：默认放在工作区 artifacts/.e2e-profiles，可用环境变量覆盖。
 * 经验：放到系统 %TEMP% 下时在本机可能触发 Chromium ProfileSingleton 失败，
 * 工作区路径（与 Lead 真机探测脚本一致）稳定可用。 */
const DEFAULT_PROFILE_BASE = join(ARTIFACTS, '.e2e-profiles');
const PROFILE_BASE = PROFILE_ROOT ?? DEFAULT_PROFILE_BASE;

/**
 * 打开浏览器上下文。
 * 两个阶段都用「显式 profile 的持久上下文」：便于控制 profile 路径、清理与排障。
 * @param {object} options
 * @param {boolean} options.persistent 是否需要加载扩展
 * @param {number} options.width
 * @param {number} options.height
 */
async function openBrowser(options) {
  const { persistent = false, width = 1440, height = 900 } = options;
  const kind = persistent ? 'ext' : 'mock';
  const profileDir = makeProfileDirectory(kind);
  // 先注册目录清理，确保清理顺序在关闭浏览器之后
  rememberCleanup(() => cleanupDirectory(profileDir));
  try {
    return await launchPersistentContext(profileDir, {
      width,
      height,
      extensionArgs: persistent
        ? [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
        : [],
    });
  } catch (error) {
    cleanupDirectory(profileDir);
    throw error;
  }
}

function makeProfileDirectory(kind) {
  mkdirSync(PROFILE_BASE, { recursive: true });
  const dir = join(PROFILE_BASE, `${kind}-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchPersistentContext(profileDir, options) {
  const { width, height, extensionArgs = [] } = options;
  // Playwright 自带 Chromium 或 BDP_CHROME_PATH 指定的 Chromium：
  // 稳定版 Chrome 137+ 不支持 --load-extension（开源 Chromium 需要配合下面两个开关）
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    headless: HEADLESS,
    viewport: { width, height },
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      ...extensionArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,DisableLoadExtensionCommandLineSwitch',
      '--enable-unsafe-extension-debugging',
      '--disable-background-networking',
      `--window-size=${width},${height}`,
    ],
  });
  rememberCleanup(async () => {
    await context.close().catch(() => {});
  });
  return { mode: 'playwright', context, page: context.pages()[0] ?? (await context.newPage()) };
}

async function closeBrowserHandle(handle) {
  if (handle.browser) await handle.browser.close().catch(() => {});
  else await handle.context.close().catch(() => {});
}

function readPngSize(filePath) {
  try {
    const buffer = readFileSync(filePath);
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

async function takeScreenshot(page, fileName) {
  const filePath = join(SCREENSHOTS, fileName);
  await page.screenshot({ path: filePath, animations: 'disabled' }).catch(() =>
    page.screenshot({ path: filePath }),
  );
  screenshots.push(filePath);
  const size = readPngSize(filePath);
  console.log(`   📸 截图：${filePath}（${size ? `${size.width}×${size.height}` : '尺寸未知'}）`);
  return { filePath, size };
}

/** console error + 未捕获异常采集 */
function createConsoleAudit(page) {
  const rows = [];
  page.on('console', (message) => {
    if (message.type() === 'error') rows.push({ kind: 'console', text: message.text() });
  });
  page.on('pageerror', (error) => {
    rows.push({ kind: 'pageerror', text: error?.message ?? String(error) });
  });
  return rows;
}

function significantErrors(rows) {
  return rows.filter(
    (row) => row.kind === 'pageerror' || !IGNORABLE_CONSOLE_PATTERNS.some((re) => re.test(row.text)),
  );
}

/* ------------------------------------------------------------------ */
/* 静态服务器（托管 dist）                                              */
/* ------------------------------------------------------------------ */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function startStaticServer(rootDir) {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === '/') pathname = '/dashboard.html';
      const filePath = normalize(join(rootDir, pathname));
      if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('forbidden');
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`not found: ${pathname}`);
        return;
      }
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  rememberCleanup(
    () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  );
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

/* ------------------------------------------------------------------ */
/* 阶段 1：仪表盘（?mock=1）                                            */
/* ------------------------------------------------------------------ */

/** 侧边栏导航：优先 data-testid="nav-<key>"（hash 锚点），其次按可见文字点击 */
async function navigateToPage(page, key) {
  const direct = page.locator(`[data-testid="nav-${key}"]`);
  if ((await direct.count()) > 0) {
    await direct.first().click();
    return `data-testid=nav-${key}`;
  }
  const fallbackTexts = {
    today: ['今日必看'],
    sections: ['分区精选', '分区'],
    growth: ['增长榜'],
    tags: ['我的标签'],
    settings: ['设置'],
  };
  for (const text of fallbackTexts[key] ?? []) {
    const byText = page.getByText(text, { exact: true });
    if ((await byText.count()) > 0) {
      await byText.first().click();
      return `文字「${text}」`;
    }
  }
  throw new Error(`找不到前往「${key}」页面的导航入口（nav-${key} / 文字）`);
}

async function waitForPageRoot(page, testId, timeout = 15000) {
  await page.locator(`[data-testid="${testId}"]`).first().waitFor({ state: 'visible', timeout });
  return `data-testid=${testId} 可见`;
}

async function stageDashboardMock(origin) {
  console.log('\n=== 阶段 1/2：仪表盘 ?mock=1（静态服务） ===');

  const handle = await openBrowser({ width: 1440, height: 900 });
  try {
    const page = handle.page;
    const audit = createConsoleAudit(page);

    await check('打开 dashboard.html?mock=1', async () => {
      const url = `${origin}/dashboard.html?mock=1`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return url;
    });

    await check('dashboard 根容器渲染', async () => {
      await page.locator('[data-testid="dashboard"]').first().waitFor({ state: 'visible', timeout: 20000 });
      return 'data-testid=dashboard';
    });

    await check('今日必看页与状态徽标渲染', async () => {
      await waitForPageRoot(page, 'today');
      await page.locator('[data-testid="status-badge"]').first().waitFor({ state: 'visible', timeout: 10000 });
      return 'data-testid=today + status-badge 可见';
    });

    await check('今日必看视频卡数量 ≥6', async () => {
      const count = await page.locator('[data-testid="today"] [data-testid="video-card"]').count();
      assert(count >= 6, `今日必看只有 ${count} 张视频卡，期望 ≥6`);
      return `视频卡=${count}`;
    });

    await check('增长角标渲染（growth-badge）', async () => {
      let count = await page.locator('[data-testid="growth-badge"]').count();
      if (count === 0) {
        await navigateToPage(page, 'growth');
        await waitForPageRoot(page, 'growth');
        await page.locator('[data-testid="growth-badge"]').first().waitFor({ state: 'visible', timeout: 15000 });
        count = await page.locator('[data-testid="growth-badge"]').count();
      }
      assert(count >= 1, '没有找到 growth-badge');
      return `growth-badge=${count}`;
    });

    await check('分区精选页：板块数量与每板块视频卡 2–5', async () => {
      await navigateToPage(page, 'sections');
      await waitForPageRoot(page, 'sections');
      const regionSections = page.locator('[data-testid="section"][data-kind="region"]');
      await regionSections.first().waitFor({ state: 'visible', timeout: 15000 });
      const sectionCount = await regionSections.count();
      assert(sectionCount >= 2 && sectionCount <= 6, `分区板块数量=${sectionCount}，期望 2–6`);
      const distributions = [];
      for (let index = 0; index < sectionCount; index += 1) {
        const cards = await regionSections.nth(index).locator('[data-testid="video-card"]').count();
        assert(cards >= 2 && cards <= 5, `第 ${index + 1} 个分区板块有 ${cards} 张卡，期望 2–5`);
        distributions.push(cards);
      }
      return `分区板块=${sectionCount}，每板块卡片=[${distributions.join(', ')}]`;
    });

    await check('补充截图：分区精选页 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await takeScreenshot(page, 'dashboard-sections-1440x900.png');
      return 'artifacts/screenshots/dashboard-sections-1440x900.png';
    });

    await check('我的标签页：标签数量 ≥15', async () => {
      await navigateToPage(page, 'tags');
      await waitForPageRoot(page, 'tags');
      await page.locator('[data-testid="tag-cloud"]').first().waitFor({ state: 'visible', timeout: 15000 });
      const count = await page.locator('[data-testid="tag-cloud"] [data-testid="tag"]').count();
      assert(count >= 15, `标签数量=${count}，期望 ≥15`);
      return `标签数量=${count}`;
    });

    await check('补充截图：我的标签页 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await takeScreenshot(page, 'dashboard-tags-1440x900.png');
      return 'artifacts/screenshots/dashboard-tags-1440x900.png';
    });

    // ---------------- v0.2.0：标签页兴趣信号面板 ----------------
    await check('标签页兴趣信号面板（收藏/关注/稍后再看）', async () => {
      const strip = page.locator('[data-testid="signal-strip"]').first();
      await strip.waitFor({ state: 'visible', timeout: 15000 });
      const statCount = await page.locator('[data-testid="signal-stat"]').count();
      assert(statCount >= 3, `signal-stat 数量=${statCount}，期望 ≥3`);
      const signals = await page
        .locator('[data-testid="signal-stat"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-signal')));
      for (const expected of ['favorite', 'following', 'watchLater']) {
        assert(signals.includes(expected), `缺少 signal-stat[data-signal=${expected}]，实际 ${signals.join(',')}`);
      }
      const favorites = page.locator('[data-testid="signal-favorites"]').first();
      await favorites.waitFor({ state: 'visible', timeout: 10000 });
      const favoritesText = (await favorites.innerText()).replace(/\s+/g, ' ');
      assert(favoritesText.includes('全部收藏夹'), `收藏面板文本=${favoritesText.slice(0, 100)}`);
      assert(favoritesText.includes('60'), `收藏面板文本未提到最近 60 条：${favoritesText.slice(0, 100)}`);
      const favoriteUpCount = await page
        .locator('[data-testid="favorite-ups"] [data-testid="favorite-up"]')
        .count();
      assert(favoriteUpCount >= 1, `favorite-up 数量=${favoriteUpCount}`);
      const followedUpCount = await page
        .locator('[data-testid="followed-ups"] [data-testid="followed-up"]')
        .count();
      await page.locator('[data-testid="signal-watchlater"]').first().waitFor({ state: 'visible', timeout: 10000 });
      const watchlaterTagCount = await page
        .locator('[data-testid="watchlater-tags"] [data-testid="watchlater-tag"]')
        .count();
      return `signal-stat=${statCount}，favorite-up=${favoriteUpCount}，followed-up=${followedUpCount}，watchlater-tag=${watchlaterTagCount}`;
    });

    await check('补充截图：标签页信号面板 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page
        .locator('[data-testid="signal-favorites"]')
        .first()
        .scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -120));
      await page.waitForTimeout(300);
      await takeScreenshot(page, 'dashboard-tags-signals-1440x900.png');
      return 'artifacts/screenshots/dashboard-tags-signals-1440x900.png';
    });

    await check('mock 收藏夹兼容模式（?mock=fallback=1）', async () => {
      await page.goto(`${origin}/dashboard.html?mock=fallback=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await waitForPageRoot(page, 'today', 20000);
      await navigateToPage(page, 'tags');
      await waitForPageRoot(page, 'tags');
      const fallback = page.locator('[data-testid="favorite-fallback"]').first();
      await fallback.waitFor({ state: 'visible', timeout: 15000 });
      const text = (await fallback.innerText()).replace(/\s+/g, ' ');
      assert(text.includes('兼容模式'), `favorite-fallback 文本=${text.slice(0, 100)}`);
      return text.slice(0, 120);
    });

    await check('设置页渲染', async () => {
      await navigateToPage(page, 'settings');
      await waitForPageRoot(page, 'settings');
      return 'data-testid=settings 可见';
    });

    await check('补充截图：设置页 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await takeScreenshot(page, 'dashboard-settings-1440x900.png');
      return 'artifacts/screenshots/dashboard-settings-1440x900.png';
    });

    // ---------------- v0.2.0：账号卡 ----------------
    await check('账号卡显示已登录（normal）', async () => {
      await page.locator('[data-testid="account-panel"]').first().waitFor({ state: 'visible', timeout: 15000 });
      const card = page.locator('[data-testid="account-card"]').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      const loggedIn = await card.getAttribute('data-logged-in');
      const state = await card.getAttribute('data-state');
      assert(loggedIn === 'true', `data-logged-in=${loggedIn}，期望 true`);
      assert(state === 'logged-in', `data-state=${state}，期望 logged-in`);
      const checkedAt = Number(await card.getAttribute('data-checked-at'));
      assert(Number.isFinite(checkedAt) && checkedAt > 0, 'data-checked-at 不合法');
      const statusText = (await page.locator('[data-testid="account-status"]').first().innerText()).trim();
      assert(statusText.includes('已登录'), `account-status 文本=${statusText}`);
      const loginHref = await page.locator('[data-testid="account-login"]').first().getAttribute('href');
      assert(
        Boolean(loginHref) && String(loginHref).includes('passport.bilibili.com/login'),
        `account-login href=${loginHref}`,
      );
      return `${statusText}，checkedAt=${new Date(checkedAt).toLocaleString()}`;
    });

    await check('Hero 显示账号昵称', async () => {
      const name = (await page.locator('[data-testid="hero-account-name"]').first().innerText()).trim();
      assert(name.length > 0, 'hero-account-name 为空');
      return `昵称=${name}`;
    });

    await check('账号卡「刷新登录状态」生效', async () => {
      const card = page.locator('[data-testid="account-card"]').first();
      const refresh = page.locator('[data-testid="account-refresh"]').first();
      const before = await card.getAttribute('data-checked-at');
      await refresh.click();
      // 刷新中：按钮 disabled 或 data-refreshing="true"
      await page.waitForFunction(
        () => {
          const button = document.querySelector('[data-testid="account-refresh"]');
          return Boolean(button) && (button.disabled || button.getAttribute('data-refreshing') === 'true');
        },
        null,
        { timeout: 3000 },
      );
      // 完成后 checked-at 更新
      await page.waitForFunction(
        (previous) => {
          const element = document.querySelector('[data-testid="account-card"]');
          return Boolean(element) && element.getAttribute('data-checked-at') !== previous;
        },
        before,
        { timeout: 10000 },
      );
      const after = await card.getAttribute('data-checked-at');
      const state = await card.getAttribute('data-state');
      assert(after !== before, `data-checked-at 未更新（${before} -> ${after}）`);
      assert(state === 'logged-in', `刷新后 data-state=${state}，期望 logged-in`);
      return `checked-at ${before} -> ${after}`;
    });

    // ---------------- v0.2.0：备份导出 / 导入 ----------------
    await check('备份导出触发下载且 BackupFile schema 合法', async () => {
      const exportButton = page.locator('[data-testid="backup-export"]').first();
      await exportButton.waitFor({ state: 'visible', timeout: 15000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        exportButton.click(),
      ]);
      const filename = download.suggestedFilename();
      assert(
        /^bili-daily-picks-backup-\d{8}-\d{4}\.json$/.test(filename),
        `下载文件名不合法：${filename}`,
      );
      const savedPath = join(E2E_TMP, 'backup-export.json');
      mkdirSync(E2E_TMP, { recursive: true });
      await download.saveAs(savedPath);
      const text = readFileSync(savedPath, 'utf8');
      const file = JSON.parse(text);
      assert(file.app === 'bili-daily-picks', `app=${file.app}`);
      assert(file.schemaVersion === 1, `schemaVersion=${file.schemaVersion}`);
      assert(file.appVersion === '0.2.0', `appVersion=${file.appVersion}，期望 0.2.0`);
      assert(typeof file.exportedAt === 'number' && file.exportedAt > 0, 'exportedAt 不合法');
      assert(file.data && typeof file.data === 'object', '缺少 data');
      for (const key of ['history', 'snapshots', 'daily', 'dismissed', 'weeklyReports']) {
        assert(Array.isArray(file.data[key]), `data.${key} 应为数组`);
      }
      assert(
        file.data.settings && typeof file.data.settings.perSection === 'number',
        'data.settings 缺失',
      );
      return `${filename}，${text.length} 字节`;
    });

    await check('备份导入：选择文件 → 二次确认 → 导入摘要', async () => {
      const fixturePath = join(E2E_TMP, 'backup-fixture.json');
      mkdirSync(E2E_TMP, { recursive: true });
      writeFileSync(fixturePath, buildBackupFixture(), 'utf8');
      await page.locator('[data-testid="backup-file-input"]').setInputFiles(fixturePath);
      await page.locator('[data-testid="backup-confirm"]').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="backup-confirm-import"]').first().click({ timeout: 10000 });
      const summary = page.locator('[data-testid="backup-import-summary"]').first();
      await summary.waitFor({ state: 'visible', timeout: 15000 });
      const text = (await summary.innerText()).replace(/\s+/g, ' ').trim();
      assert(text.length > 0, 'backup-import-summary 为空');
      assert(/历史|快照|推荐|周报|拉黑/.test(text), `导入摘要缺少统计项：${text.slice(0, 120)}`);
      return text.slice(0, 160);
    });

    await check('导入后设置已回读（perSection/regionSections/updateHour/theme）', async () => {
      const perSection = (await page.locator('[data-testid="setting-per-section"]').first().innerText()).replace(/\s+/g, ' ');
      assert(/4/.test(perSection), `setting-per-section=${perSection}，期望 4`);
      const regionSections = (await page.locator('[data-testid="setting-region-sections"]').first().innerText()).replace(/\s+/g, ' ');
      assert(/4/.test(regionSections), `setting-region-sections=${regionSections}，期望 4`);
      const updateHour = await page.locator('[data-testid="setting-update-hour"]').first().inputValue();
      assert(updateHour === '5', `setting-update-hour=${updateHour}，期望 5`);
      const theme = (await page.locator('[data-testid="setting-theme"] .is-active').first().innerText()).trim();
      assert(theme.includes('浅色'), `setting-theme 选中=${theme}，期望 浅色`);
      return `perSection=4，regionSections=4，updateHour=5，theme=${theme}`;
    });

    await check('补充截图：设置页账号与备份面板 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('[data-testid="backup-panel"]').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await takeScreenshot(page, 'dashboard-settings-backup-1440x900.png');
      return 'artifacts/screenshots/dashboard-settings-backup-1440x900.png';
    });

    // 回到今日必看，按两种尺寸截主图
    await check('切回今日必看', async () => {
      await navigateToPage(page, 'today');
      await waitForPageRoot(page, 'today');
      return '已回到今日必看';
    });

    await check('1440×900 截图', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(400);
      const { size } = await takeScreenshot(page, 'dashboard-1440x900.png');
      assert(
        size && Math.abs(size.width - 1440) <= 2 && Math.abs(size.height - 900) <= 2,
        `截图尺寸 ${size?.width}×${size?.height}，期望 1440×900`,
      );
      return 'artifacts/screenshots/dashboard-1440x900.png';
    });

    await check('1024×768 截图', async () => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.waitForTimeout(600);
      const { size } = await takeScreenshot(page, 'dashboard-1024x768.png');
      assert(
        size && Math.abs(size.width - 1024) <= 2 && Math.abs(size.height - 768) <= 2,
        `截图尺寸 ${size?.width}×${size?.height}，期望 1024×768`,
      );
      return 'artifacts/screenshots/dashboard-1024x768.png';
    });

    // ---------------- v0.2.0：周报页 ----------------
    await check('周报页渲染（概览/7 日趋势/标签/涨跌/分区/UP）', async () => {
      await page.goto(`${origin}/dashboard.html?mock=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await waitForPageRoot(page, 'today', 20000);
      await navigateToPage(page, 'weekly');
      await waitForPageRoot(page, 'weekly', 20000);
      // 页面根先渲染、周报数据异步加载：等到 data-week-key 变成合法日期再断言
      await page.waitForFunction(
        () => {
          const element = document.querySelector('[data-testid="weekly"]');
          return /^\d{4}-\d{2}-\d{2}$/.test(element?.getAttribute('data-week-key') ?? '');
        },
        null,
        { timeout: 20000 },
      );
      const root = page.locator('[data-testid="weekly"]').first();
      const weekKey = await root.getAttribute('data-week-key');
      assert(/^\d{4}-\d{2}-\d{2}$/.test(weekKey ?? ''), `data-week-key=${weekKey}`);
      const label = (await page.locator('[data-testid="weekly-label"]').first().innerText()).trim();
      assert(label.length > 0, 'weekly-label 为空');
      const statCount = await page.locator('[data-testid="weekly-stat"]').count();
      assert(statCount >= 4, `weekly-stat 数量=${statCount}，期望 ≥4`);
      const stats = await page
        .locator('[data-testid="weekly-stat"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-stat')));
      for (const expected of ['watched', 'duration', 'activeDays', 'completion']) {
        assert(stats.includes(expected), `缺少 weekly-stat[data-stat=${expected}]，实际 ${stats.join(',')}`);
      }
      const summary = (await page.locator('[data-testid="weekly-summary"]').first().innerText()).trim();
      assert(summary.length > 0, 'weekly-summary 为空');
      await page.locator('[data-testid="weekly-trend"]').first().waitFor({ state: 'visible', timeout: 10000 });
      const barCount = await page.locator('[data-testid="weekly-trend-bar"]').count();
      assert(barCount === 7, `weekly-trend-bar 数量=${barCount}，期望 7`);
      const barAttrs = await page
        .locator('[data-testid="weekly-trend-bar"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-date')));
      // 真实数据是 YYYY-MM-DD，mock 演示数据用 MM.DD，两种都接受
      const datePattern = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2})$/;
      assert(
        barAttrs.every((value) => datePattern.test(value ?? '')),
        `weekly-trend-bar data-date 不合法：${barAttrs.join(',')}`,
      );
      const tagCount = await page.locator('[data-testid="weekly-tags"] [data-testid="weekly-tag"]').count();
      assert(tagCount >= 1, `weekly-tag 数量=${tagCount}`);
      const statuses = await page
        .locator('[data-testid="weekly-tag"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')).filter(Boolean));
      assert(statuses.length >= 1, 'weekly-tag 缺少 data-status');
      await page.locator('[data-testid="weekly-movers"]').first().waitFor({ state: 'visible', timeout: 10000 });
      const moverCount = await page.locator('[data-testid="weekly-mover"]').count();
      const risingCount = await page
        .locator('[data-testid="weekly-rising"] [data-testid="weekly-mover"][data-direction="rising"]')
        .count();
      const fallingCount = await page
        .locator('[data-testid="weekly-falling"] [data-testid="weekly-mover"][data-direction="falling"]')
        .count();
      assert(moverCount >= 1, `weekly-mover 数量=${moverCount}`);
      assert(risingCount + fallingCount >= 1, `上升+下降条目=${risingCount + fallingCount}，期望 ≥1`);
      await page.locator('[data-testid="weekly-regions"]').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="weekly-ups"]').first().waitFor({ state: 'visible', timeout: 10000 });
      return `weekKey=${weekKey}，label=${label}，统计=${statCount}，趋势=${barCount}，标签=${tagCount}，上升=${risingCount}，下降=${fallingCount}`;
    });

    await check('补充截图：周报页 1440×900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(400);
      await takeScreenshot(page, 'dashboard-weekly-1440x900.png');
      return 'artifacts/screenshots/dashboard-weekly-1440x900.png';
    });

    await check('周报周切换（select 第 2 项 → weekKey / label 变化）', async () => {
      const root = page.locator('[data-testid="weekly"]').first();
      const beforeKey = await root.getAttribute('data-week-key');
      const beforeLabel = (await page.locator('[data-testid="weekly-label"]').first().innerText()).trim();
      const picker = page.locator('[data-testid="weekly-week-picker"]').first();
      await picker.waitFor({ state: 'visible', timeout: 10000 });
      // 等下拉框有真实可选周报（data 加载完成后 option 才填充）
      await page.waitForFunction(
        () => {
          const select = document.querySelector('[data-testid="weekly-week-picker"]');
          return Boolean(select) && select instanceof HTMLSelectElement && select.options.length >= 2;
        },
        null,
        { timeout: 15000 },
      );
      await picker.selectOption({ index: 1 });
      await page.waitForFunction(
        (previous) => {
          const element = document.querySelector('[data-testid="weekly"]');
          const key = element?.getAttribute('data-week-key') ?? '';
          return /^\d{4}-\d{2}-\d{2}$/.test(key) && key !== previous;
        },
        beforeKey,
        { timeout: 15000 },
      );
      const afterKey = await root.getAttribute('data-week-key');
      const afterLabel = (await page.locator('[data-testid="weekly-label"]').first().innerText()).trim();
      assert(afterKey !== beforeKey, `weekKey 未变化（${beforeKey} -> ${afterKey}）`);
      assert(afterLabel !== beforeLabel, `weekly-label 未变化（${beforeLabel}）`);
      return `${beforeKey} -> ${afterKey}；label「${beforeLabel}」->「${afterLabel}」`;
    });

    await check('mock empty：周报显示空态', async () => {
      await page.goto(`${origin}/dashboard.html?mock=empty=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await waitForPageRoot(page, 'today', 20000);
      await navigateToPage(page, 'weekly');
      const empty = page.locator('[data-testid="weekly-empty"]').first();
      await empty.waitFor({ state: 'visible', timeout: 15000 });
      const text = (await empty.innerText()).replace(/\s+/g, ' ');
      assert(text.includes('04:00') || text.includes('周一'), `weekly-empty 文案=${text.slice(0, 120)}`);
      const key = await page.locator('[data-testid="weekly"]').first().getAttribute('data-week-key');
      assert(key === '', `空态 data-week-key 应为空字符串，实际 ${key}`);
      return 'weekly-empty 可见，data-week-key 为空';
    });

    // mock 场景：未登录公开模式 / 空态 / 错误态
    await check('mock 未登录态（login-hint）', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${origin}/dashboard.html?mock=loggedout=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.locator('[data-testid="login-hint"]').first().waitFor({ state: 'visible', timeout: 15000 });
      return 'login-hint 可见';
    });

    await check('mock loggedout：账号卡登录已失效 + Hero 刷新仍保持未登录', async () => {
      // 当前仍在 loggedout 场景：Hero login-hint 内的刷新按钮点击后仍为未登录
      await page.locator('[data-testid="login-refresh"]').first().click({ timeout: 10000 });
      await page.waitForTimeout(1200);
      await page.locator('[data-testid="login-hint"]').first().waitFor({ state: 'visible', timeout: 10000 });
      await navigateToPage(page, 'settings');
      await waitForPageRoot(page, 'settings');
      const card = page.locator('[data-testid="account-card"]').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      const loggedIn = await card.getAttribute('data-logged-in');
      const state = await card.getAttribute('data-state');
      assert(loggedIn === 'false', `loggedout data-logged-in=${loggedIn}，期望 false`);
      assert(state === 'expired', `loggedout data-state=${state}，期望 expired`);
      const statusText = (await page.locator('[data-testid="account-status"]').first().innerText()).trim();
      assert(statusText.includes('登录已失效'), `account-status=${statusText}`);
      const cardText = (await card.innerText()).replace(/\s+/g, ' ');
      assert(cardText.includes('上次登录'), `账号卡缺少「上次登录」：${cardText.slice(0, 120)}`);
      return `${statusText}，含上次登录`;
    });

    await check('mock 空态（empty-state）', async () => {
      await page.goto(`${origin}/dashboard.html?mock=empty=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.locator('[data-testid="empty-state"]').first().waitFor({ state: 'visible', timeout: 15000 });
      return 'empty-state 可见';
    });

    await check('mock 错误态（error-state）', async () => {
      await page.goto(`${origin}/dashboard.html?mock=error=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.locator('[data-testid="error-state"]').first().waitFor({ state: 'visible', timeout: 15000 });
      return 'error-state 可见';
    });

    // 立即更新流程（mock 约 4.6s 走完阶段）
    await check('立即更新流程（run-now → run-progress → toast）', async () => {
      await page.goto(`${origin}/dashboard.html?mock=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await waitForPageRoot(page, 'today', 20000);
      await page.locator('[data-testid="run-now"]').first().click({ timeout: 10000 });
      await page.locator('[data-testid="run-progress"]').first().waitFor({ state: 'visible', timeout: 10000 });
      await page
        .locator('[data-testid="run-progress"]')
        .first()
        .waitFor({ state: 'detached', timeout: 25000 });
      await page.locator('[data-testid="toast"]').first().waitFor({ state: 'visible', timeout: 10000 });
      return 'run-progress 出现后消失，toast 提示完成';
    });

    await check('仪表盘无 JS console error', async () => {
      const rows = significantErrors(audit);
      assert(
        rows.length === 0,
        `共 ${rows.length} 条：${rows
          .slice(0, 3)
          .map((row) => row.text)
          .join(' | ')}`,
      );
      return '0 条（已忽略图片/网络加载失败）';
    });
  } finally {
    await closeBrowserHandle(handle);
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 2：加载真实扩展                                                */
/* ------------------------------------------------------------------ */

/** 等扩展 service worker 就绪，返回 { serviceWorker, extensionId } */
function waitForServiceWorker(context, timeoutMs = 30000) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return Promise.resolve(existing[0]);
  return context.waitForEvent('serviceworker', { timeout: timeoutMs });
}

async function stageExtension() {
  console.log('\n=== 阶段 2/2：加载扩展 + 内容脚本 ===');

  const handle = await openBrowser({ persistent: true, width: 1440, height: 900 });
  try {
    const context = handle.context;

    let serviceWorker = null;
    let extensionId = null;
    await check('扩展 service worker 已启动', async () => {
      serviceWorker = await waitForServiceWorker(context, 30000);
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(serviceWorker.url());
      assert(match, `无法从 service worker URL 解析扩展 id：${serviceWorker.url()}`);
      extensionId = match[1];
      return `扩展 id=${extensionId}`;
    });
    if (!extensionId || !serviceWorker) return;

    // service worker 直连 api.bilibili.com 的风控探测（结果写进 e2e 摘要）
    try {
      const probe = await serviceWorker.evaluate(async () => {
        try {
          const response = await fetch(
            'https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1',
            { credentials: 'include' },
          );
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            /* 非 JSON 响应 */
          }
          return {
            ok: true,
            status: response.status,
            code: typeof payload?.code === 'number' ? payload.code : null,
            message: payload?.message ?? '',
          };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      });
      extraSummary.swDirectFetch = probe;
      console.log(`   🔎 SW 直连 api.bilibili.com：${JSON.stringify(probe)}`);
      if (!probe.ok) {
        skip('service worker 直连 api.bilibili.com（网络不可达，跳过风控探测）', probe.error);
      } else if (probe.code === 0) {
        pass('service worker 直连 api.bilibili.com（风控探测）', 'code=0，直连可用，无需 DNR');
      } else if (probe.code === -352) {
        pass(
          'service worker 直连 api.bilibili.com（风控探测）',
          'code=-352，SW 直连被风控，需要 declarativeNetRequest 改 Referer/Origin',
        );
      } else {
        fail(
          'service worker 直连 api.bilibili.com（风控探测）',
          `意外返回 code=${probe.code}（HTTP ${probe.status}，message=${probe.message || '空'}）`,
        );
      }
    } catch (error) {
      extraSummary.swDirectFetch = { ok: false, error: short(error) };
      skip('service worker 直连 api.bilibili.com（风控探测）', `service worker 已休眠或不可求值：${short(error)}`);
    }

    const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
    const dashboardPage = await context.newPage();
    const audit = createConsoleAudit(dashboardPage);

    await check('打开扩展内仪表盘（无 mock，走后台消息）', async () => {
      await dashboardPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dashboardPage.locator('#root').waitFor({ state: 'attached', timeout: 15000 });
      await dashboardPage.waitForTimeout(1200);
      const childCount = await dashboardPage
        .locator('#root')
        .evaluate((element) => element.childElementCount);
      assert(childCount > 0, `#root 没有渲染内容（childElementCount=${childCount}），可能后台消息失败`);
      return dashboardUrl;
    });

    await check('后台消息路由 GET_* 全部可用', async () => {
      const response = await dashboardPage.evaluate(async () => {
        const send = (payload) => chrome.runtime.sendMessage(payload);
        return {
          settings: await send({ type: 'GET_SETTINGS' }),
          status: await send({ type: 'GET_STATUS' }),
          dashboard: await send({ type: 'GET_DASHBOARD_DATA' }),
          daily: await send({ type: 'GET_DAILY' }),
          profile: await send({ type: 'GET_PROFILE' }),
        };
      });
      assert(response.settings?.ok === true, `GET_SETTINGS 失败：${response.settings?.error ?? 'unknown'}`);
      assert(response.status?.ok === true, `GET_STATUS 失败：${response.status?.error ?? 'unknown'}`);
      assert(response.dashboard?.ok === true, `GET_DASHBOARD_DATA 失败：${response.dashboard?.error ?? 'unknown'}`);
      assert(response.daily?.ok === true, `GET_DAILY 失败：${response.daily?.error ?? 'unknown'}`);
      assert(response.profile?.ok === true, `GET_PROFILE 失败：${response.profile?.error ?? 'unknown'}`);
      assert(response.settings.data?.updateHour >= 0, 'GET_SETTINGS 返回的设置不合法');
      return `updateHour=${response.settings.data.updateHour}，status.stage=${response.status.data?.stage}`;
    });

    // ---------------- v0.2.0：账号 / 周报 / 备份 消息路由 ----------------
    await check('GET_DASHBOARD_DATA 含 account（未登录）', async () => {
      const response = await dashboardPage.evaluate(async () => {
        const res = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' });
        return res;
      });
      assert(response?.ok === true, `GET_DASHBOARD_DATA 失败：${response?.error ?? 'unknown'}`);
      const account = response.data?.account;
      assert(account && typeof account === 'object', 'DashboardData 缺少 account 字段');
      assert(account.loggedIn === false, `新 profile 应为未登录，实际 loggedIn=${account.loggedIn}`);
      assert(typeof account.checkedAt === 'number' && account.checkedAt > 0, 'account.checkedAt 不合法');
      return `loggedIn=false，checkedAt=${new Date(account.checkedAt).toLocaleString()}`;
    });

    await check('REFRESH_ACCOUNT 返回实况登录态', async () => {
      const response = await dashboardPage.evaluate(async () =>
        chrome.runtime.sendMessage({ type: 'REFRESH_ACCOUNT' }),
      );
      assert(response?.ok === true, `REFRESH_ACCOUNT 失败：${response?.error ?? 'unknown'}`);
      const account = response.data;
      assert(account && typeof account === 'object', 'REFRESH_ACCOUNT 未返回 AccountInfo');
      assert(account.loggedIn === false, `未登录环境应返回 loggedIn=false，实际 ${account.loggedIn}`);
      assert(typeof account.checkedAt === 'number', 'account.checkedAt 缺失');
      return `loggedIn=false${account.error ? `，error=${String(account.error).slice(0, 60)}` : ''}`;
    });

    await check('GET_WEEKLY_REPORT 无报告时返回 report=null', async () => {
      const response = await dashboardPage.evaluate(async () =>
        chrome.runtime.sendMessage({ type: 'GET_WEEKLY_REPORT' }),
      );
      assert(response?.ok === true, `GET_WEEKLY_REPORT 失败：${response?.error ?? 'unknown'}`);
      const data = response.data;
      assert(data && typeof data === 'object', 'GET_WEEKLY_REPORT 返回结构不合法');
      assert(data.report === null, `新 profile 应无周报，实际 report=${JSON.stringify(data.report)?.slice(0, 80)}`);
      assert(Array.isArray(data.reports), 'weeklyReports.reports 应为数组');
      return `report=null，reports=${data.reports.length} 份`;
    });

    let exportedBackup = null;
    await check('EXPORT_BACKUP 返回合法备份 schema', async () => {
      const { response, manifestVersion } = await dashboardPage.evaluate(async () => {
        const res = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' });
        return { response: res, manifestVersion: chrome.runtime.getManifest().version };
      });
      assert(response?.ok === true, `EXPORT_BACKUP 失败：${response?.error ?? 'unknown'}`);
      const payload = response.data;
      assert(payload && typeof payload.json === 'string' && payload.json.length > 0, '返回缺少 json');
      assert(
        typeof payload.filename === 'string' &&
          /^bili-daily-picks-backup-\d{8}-\d{4}\.json$/.test(payload.filename),
        `备份文件名不合法：${payload.filename}`,
      );
      assert(typeof payload.bytes === 'number' && payload.bytes > 0, 'bytes 不合法');
      assert(
        payload.bytes === new TextEncoder().encode(payload.json).length,
        `bytes=${payload.bytes} 与 JSON 实际字节数不一致`,
      );
      const file = JSON.parse(payload.json);
      assert(file.app === 'bili-daily-picks', `app 字段错误：${file.app}`);
      assert(file.schemaVersion === 1, `schemaVersion 错误：${file.schemaVersion}`);
      assert(file.appVersion === manifestVersion, `appVersion=${file.appVersion} 与 manifest ${manifestVersion} 不一致`);
      assert(typeof file.exportedAt === 'number' && file.exportedAt > 0, 'exportedAt 缺失');
      assert(file.data && typeof file.data === 'object', '缺少 data');
      for (const key of ['history', 'snapshots', 'daily', 'dismissed']) {
        assert(Array.isArray(file.data[key]), `data.${key} 应为数组`);
      }
      assert(file.data.settings && typeof file.data.settings === 'object', '缺少 data.settings');
      exportedBackup = payload;
      return `filename=${payload.filename}，bytes=${payload.bytes}，appVersion=${file.appVersion}`;
    });

    const backupFixture = buildBackupFixture();
    let importSummary = null;
    await check('IMPORT_BACKUP 小样本成功（summary 正确）', async () => {
      const response = await dashboardPage.evaluate(
        async (json) => chrome.runtime.sendMessage({ type: 'IMPORT_BACKUP', json }),
        backupFixture,
      );
      assert(response?.ok === true, `IMPORT_BACKUP 失败：${response?.error ?? 'unknown'}`);
      const summary = response.data;
      assert(summary && typeof summary === 'object', '缺少 ImportSummary');
      assert(summary.history === 1, `summary.history=${summary.history}，期望 1`);
      assert(summary.dismissed === 1, `summary.dismissed=${summary.dismissed}，期望 1`);
      assert(summary.daily === 1, `summary.daily=${summary.daily}，期望 1`);
      assert(summary.weekly === 0, `summary.weekly=${summary.weekly}，期望 0`);
      assert(summary.hasProfile === false, `summary.hasProfile=${summary.hasProfile}，期望 false`);
      assert(summary.dropped === 0, `summary.dropped=${summary.dropped}，期望 0`);
      importSummary = summary;
      return JSON.stringify(summary);
    });

    await check('导入后设置 / 拉黑 / 每日结果已回读', async () => {
      assert(importSummary, '上一步 IMPORT_BACKUP 未成功，无法回读');
      const result = await dashboardPage.evaluate(async () => {
        const [settings, dashboard, daily, profile] = await Promise.all([
          chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
          chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }),
          chrome.runtime.sendMessage({ type: 'GET_DAILY' }),
          chrome.runtime.sendMessage({ type: 'GET_PROFILE' }),
        ]);
        return { settings, dashboard, daily, profile };
      });
      assert(result.settings?.ok === true, `GET_SETTINGS 失败：${result.settings?.error ?? 'unknown'}`);
      assert(result.settings.data.perSection === 4, `perSection=${result.settings.data.perSection}，期望 4`);
      assert(result.settings.data.updateHour === 5, `updateHour=${result.settings.data.updateHour}，期望 5`);
      assert(result.settings.data.tagWindow === '30d', `tagWindow=${result.settings.data.tagWindow}，期望 30d`);
      assert(result.settings.data.regionSections === 4, `regionSections=${result.settings.data.regionSections}，期望 4`);
      assert(result.dashboard?.ok === true, `GET_DASHBOARD_DATA 失败：${result.dashboard?.error ?? 'unknown'}`);
      assert(
        Array.isArray(result.dashboard.data.dismissed) &&
          result.dashboard.data.dismissed.includes('BV1e2edismiss'),
        '拉黑列表未回读导入的 bvid',
      );
      assert(result.daily?.ok === true && result.daily.data?.date === '2026-10-20', `GET_DAILY date=${result.daily.data?.date}`);
      return 'perSection=4 / updateHour=5 / tagWindow=30d / 拉黑与 daily 均已回读';
    });

    await check('IMPORT_BACKUP 非法内容失败且不覆盖数据', async () => {
      const result = await dashboardPage.evaluate(async () => {
        const badApp = await chrome.runtime.sendMessage({
          type: 'IMPORT_BACKUP',
          json: '{"app":"not-ours","schemaVersion":1,"data":{}}',
        });
        const brokenJson = await chrome.runtime.sendMessage({ type: 'IMPORT_BACKUP', json: 'not-json' });
        const oversize = await chrome.runtime.sendMessage({
          type: 'IMPORT_BACKUP',
          json: JSON.stringify({ blob: 'x'.repeat(21 * 1024 * 1024) }),
        });
        const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        const daily = await chrome.runtime.sendMessage({ type: 'GET_DAILY' });
        return { badApp, brokenJson, oversize, settings, daily };
      });
      assert(result.badApp?.ok === false, '非本扩展备份应失败');
      assert(typeof result.badApp.error === 'string' && result.badApp.error.length > 0, '失败时应返回 error');
      assert(result.brokenJson?.ok === false, '非法 JSON 应失败');
      assert(result.oversize?.ok === false, '超过 20MB 的备份应被拒绝');
      assert(result.settings.data.perSection === 4, '导入失败后设置被改动');
      assert(result.daily.data?.date === '2026-10-20', '导入失败后每日结果被改动');
      return `错误信息示例：「${result.badApp.error.slice(0, 40)}…」；数据保持导入样本`;
    });

    await check('导入后再导出包含导入数据（往返一致）', async () => {
      const response = await dashboardPage.evaluate(async () =>
        chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' }),
      );
      assert(response?.ok === true, `EXPORT_BACKUP 失败：${response?.error ?? 'unknown'}`);
      const file = JSON.parse(response.data.json);
      assert(file.data.settings.perSection === 4, `导出设置 perSection=${file.data.settings.perSection}，期望 4`);
      assert(
        file.data.history.some((row) => row.bvid === 'BV1e2eimport01'),
        '导出历史缺少导入的视频',
      );
      assert(
        file.data.dismissed.some((row) => row.bvid === 'BV1e2edismiss'),
        '导出拉黑缺少导入项',
      );
      assert(
        file.data.daily.some((row) => row.date === '2026-10-20'),
        '导出每日结果缺少导入项',
      );
      return `history=${file.data.history.length}，dismissed=${file.data.dismissed.length}，daily=${file.data.daily.length}`;
    });

    await check('SET_SETTINGS 生效并可回读', async () => {
      const response = await dashboardPage.evaluate(async () => {
        const send = (payload) => chrome.runtime.sendMessage(payload);
        const set = await send({ type: 'SET_SETTINGS', patch: { showFloatingButton: false } });
        const read = await send({ type: 'GET_SETTINGS' });
        const restore = await send({ type: 'SET_SETTINGS', patch: { showFloatingButton: true } });
        return { set, read, restore };
      });
      assert(response.set?.ok === true, `SET_SETTINGS 失败：${response.set?.error ?? 'unknown'}`);
      assert(response.read?.ok === true && response.read.data.showFloatingButton === false, '设置未生效');
      assert(response.restore?.ok === true && response.restore.data.showFloatingButton === true, '设置未恢复');
      return 'showFloatingButton false -> 回读 -> 恢复';
    });

    await check('空闲时 tick 不产生额外请求（观察 GET_STATUS 约 2 秒）', async () => {
      const sample = async () =>
        dashboardPage.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
          return response?.ok ? response.data : null;
        });
      const before = await sample();
      await dashboardPage.waitForTimeout(2200);
      const after = await sample();
      assert(before && after, 'GET_STATUS 返回异常');
      if (before.running || after.running) {
        return `观察窗口内有任务在跑（stage=${after.stage ?? '?'}），无法验证空闲请求数`;
      }
      if (typeof before.requestCount === 'number' && typeof after.requestCount === 'number') {
        assert(
          after.requestCount === before.requestCount,
          `空闲状态下请求数增长：${before.requestCount} -> ${after.requestCount}`,
        );
        return `requestCount 稳定在 ${after.requestCount}`;
      }
      return `running=false，stage=${after.stage}（controller 未提供 requestCount）`;
    });

    await check('后台闹钟已注册（每分钟 tick + 每日更新）', async () => {
      const alarms = await dashboardPage.evaluate(() => chrome.alarms.getAll());
      const tick = alarms.find((alarm) => alarm.name === 'pipeline-tick');
      const daily = alarms.find((alarm) => alarm.name === 'daily-update');
      assert(Boolean(tick), '缺少 pipeline-tick 闹钟');
      assert(tick.periodInMinutes === 1, `pipeline-tick 周期=${tick.periodInMinutes}，期望 1 分钟`);
      assert(Boolean(daily), '缺少 daily-update 闹钟');
      return `pipeline-tick(每 ${tick.periodInMinutes} 分钟) + daily-update(${
        daily.scheduledTime ? new Date(daily.scheduledTime).toLocaleString() : '?'
      })`;
    });

    await check('扩展仪表盘截图', async () => {
      await dashboardPage.waitForTimeout(500);
      await takeScreenshot(dashboardPage, 'extension-dashboard-1440x900.png');
      return 'artifacts/screenshots/extension-dashboard-1440x900.png';
    });

    await check('扩展仪表盘无 JS console error', async () => {
      const rows = significantErrors(audit);
      assert(
        rows.length === 0,
        `共 ${rows.length} 条：${rows
          .slice(0, 3)
          .map((row) => row.text)
          .join(' | ')}`,
      );
      return '0 条（已忽略图片/网络加载失败）';
    });

    // v0.1.1：清空数据后必须暂停自动更新，避免后台 tick 立刻重新采集历史
    await check('清空数据会暂停自动更新并移除每日闹钟', async () => {
      const result = await dashboardPage.evaluate(async () => {
        const cleared = await chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
        const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        const daily = await chrome.runtime.sendMessage({ type: 'GET_DAILY' });
        const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
        const alarms = await chrome.alarms.getAll();
        return {
          cleared,
          settings,
          daily,
          status,
          alarms: alarms.map((alarm) => alarm.name),
        };
      });
      assert(result.cleared?.ok === true, `CLEAR_DATA 失败：${result.cleared?.error ?? 'unknown'}`);
      assert(
        result.settings?.data?.autoUpdate === false,
        `清空后 autoUpdate 应为 false，实际 ${result.settings?.data?.autoUpdate}`,
      );
      assert(result.daily?.data === null, '清空后仍存在每日推荐结果');
      assert(!result.alarms.includes('daily-update'), '清空后 daily-update 闹钟未移除');
      return `autoUpdate=false，daily=null，status.stage=${result.status?.data?.stage}`;
    });

    // v0.2.0：清空数据后导出备份应为空，确认数据真的被清除
    await check('清空后导出备份为空（历史/拉黑/每日结果已清除）', async () => {
      const response = await dashboardPage.evaluate(async () =>
        chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' }),
      );
      assert(response?.ok === true, `清空后 EXPORT_BACKUP 失败：${response?.error ?? 'unknown'}`);
      const file = JSON.parse(response.data.json);
      assert(file.data.history.length === 0, `清空后 history=${file.data.history.length}，期望 0`);
      assert(file.data.dismissed.length === 0, `清空后 dismissed=${file.data.dismissed.length}，期望 0`);
      assert(file.data.daily.length === 0, `清空后 daily=${file.data.daily.length}，期望 0`);
      assert(file.data.profile === null, '清空后 profile 应为 null');
      assert(file.data.settings.autoUpdate === false, `清空后 autoUpdate=${file.data.settings.autoUpdate}，期望 false`);
      return `history=0，dismissed=0，daily=0，profile=null，autoUpdate=false`;
    });

    // relay 依赖 chrome.tabs.query(url)，确认 manifest 权限足够（放在关闭仪表盘标签页之前）
    await check('chrome.tabs.query(url) 可用（标签页中转所需）', async () => {
      const probe = await dashboardPage.evaluate(async () => {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] });
          return { ok: true, count: tabs.length };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      });
      assert(probe.ok, probe.error ?? 'tabs.query 失败');
      return `匹配 ${probe.count} 个 B站标签页`;
    });

    // ---------------- 内容脚本 / bilibili.com ----------------
    await check('bilibili.com 悬浮入口 / 关闭记忆 / API_FETCH 安全校验', async () => {
      const biliPage = await context.newPage();
      const biliAudit = createConsoleAudit(biliPage);
      let networkLimited = false;
      let usedMockPage = false;

      try {
        await biliPage.goto('https://www.bilibili.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
      } catch (error) {
        networkLimited = true;
        usedMockPage = true;
        skip('打开真实 bilibili.com（网络受限，改用本地兜底页验证内容脚本）', short(error));
        await biliPage
          .route('https://www.bilibili.com/**', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: MOCK_BILIBILI_HTML,
            }),
          )
          .catch(() => {});
        await biliPage.goto('https://www.bilibili.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
      }

      // 内容脚本 document_idle 注入，留一点时间
      await biliPage.waitForTimeout(1500);
      await biliPage
        .locator('[data-testid="floating-entry"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20000 });
      const suffix = usedMockPage ? '（本地兜底页）' : '（真实页面）';
      await takeScreenshot(
        biliPage,
        `bilibili-floating-1440x900${usedMockPage ? '-mock' : ''}.png`,
      );

      // 关闭所有已打开的仪表盘标签页（含本阶段创建的与安装时自动打开的），
      // 这样点击悬浮按钮必然新建一个标签页，便于断言。
      for (const candidate of [...context.pages()]) {
        if (candidate === biliPage) continue;
        if (candidate.url().startsWith(`chrome-extension://${extensionId}/`)) {
          await candidate.close().catch(() => {});
        }
      }
      const pageCountBefore = context.pages().length;
      await biliPage.locator('[data-testid="floating-button"]').first().click({ timeout: 10000 });
      const deadline = Date.now() + 10000;
      let openedDashboard = null;
      while (Date.now() < deadline) {
        openedDashboard = context
          .pages()
          .find(
            (item) =>
              item !== biliPage &&
              item.url().startsWith(`chrome-extension://${extensionId}/`) &&
              item.url().includes('dashboard.html'),
          );
        if (openedDashboard) break;
        await sleep(200);
      }
      assert(
        openedDashboard,
        `点击悬浮按钮后没有打开仪表盘（标签页数 ${pageCountBefore} -> ${context.pages().length}）`,
      );
      await openedDashboard.close().catch(() => {});

      // 关闭按钮 -> 刷新后仍然隐藏（记忆）
      await biliPage.locator('[data-testid="floating-close"]').first().click({ timeout: 10000 });
      await biliPage.waitForTimeout(400);
      const afterClose = await biliPage.locator('[data-testid="floating-entry"]').count();
      assert(afterClose === 0, '点击关闭后悬浮入口仍然存在');

      await biliPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await biliPage.waitForTimeout(1500);
      const afterReload = await biliPage.locator('[data-testid="floating-entry"]').count();
      assert(afterReload === 0, '刷新后悬浮入口又出现了，关闭记忆未生效');

      // 借一个扩展页做两件事：API_FETCH 安全校验 + 清掉关闭记忆（避免污染后续手动测试）
      const adminPage = await context.newPage();
      await adminPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const relayGuard = await adminPage.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (typeof tab.id !== 'number') continue;
          try {
            const result = await chrome.tabs.sendMessage(tab.id, {
              type: 'API_FETCH',
              url: 'https://evil.example.com/steal',
            });
            if (result && typeof result === 'object') return result;
          } catch {
            /* 该标签页没有内容脚本 */
          }
        }
        return null;
      });
      await adminPage.evaluate(() => chrome.storage.local.remove('floating:dismissed')).catch(() => {});
      await adminPage.close().catch(() => {});

      assert(
        relayGuard && relayGuard.ok === false && /api\.bilibili\.com/.test(relayGuard.error ?? ''),
        `API_FETCH 安全校验失败：${JSON.stringify(relayGuard)}`,
      );

      // 清除关闭记忆后，刷新应恢复显示
      await biliPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await biliPage.waitForTimeout(1500);
      await biliPage
        .locator('[data-testid="floating-entry"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });

      const biliErrors = significantErrors(biliAudit);
      if (biliErrors.length > 0) {
        console.warn(
          `   bilibili 页面 console 噪音：${biliErrors
            .slice(0, 2)
            .map((row) => row.text)
            .join(' | ')}`,
        );
      }
      await biliPage.close().catch(() => {});
      return `${suffix}${networkLimited ? '，真实站点不可达已记录 skip' : ''}`;
    });
  } finally {
    await closeBrowserHandle(handle);
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : 'all';
  return { only: only && only !== 'true' ? only : 'all' };
}

function distCheck() {
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'icons/icon16.png',
    'icons/icon128.png',
  ];
  const missing = required.filter((relative) => !existsSync(join(DIST, relative)));
  const dashboardMissing = !existsSync(join(DIST, 'dashboard.html'));
  return { missing, dashboardMissing };
}

/** 摘要里一律写相对路径，避免把本机绝对路径带进仓库 */
function rel(target) {
  if (!target) return target;
  const r = relative(ROOT, target);
  if (!r || r.startsWith('..') || isAbsolute(r)) {
    return isAbsolute(target) ? `<external>/${basename(target)}` : target;
  }
  return r.split(sep).join('/');
}

function writeSummary(only) {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      join(ARTIFACTS, 'e2e-summary.json'),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          only,
          browser: CHROME_PATH ? rel(CHROME_PATH) : BROWSER_LABEL,
          browserExecutable: CHROME_PATH ? rel(CHROME_PATH) : null,
          headless: HEADLESS,
          profileRoot: PROFILE_ROOT ? rel(PROFILE_ROOT) : null,
          profileBase: rel(PROFILE_BASE),
          dist: rel(DIST),
          results,
          screenshots,
          ...extraSummary,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    console.warn(`写入 e2e-summary.json 失败：${short(error)}`);
  }
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const stages = only === 'all' ? ['mock', 'extension'] : only.split(',').map((item) => item.trim());

  console.log('B站每日必看 · 端到端验收');
  console.log(`工作区：${ROOT}`);
  console.log(`dist：${DIST}`);
  console.log(`浏览器：${BROWSER_LABEL}（${HEADLESS ? 'headless' : 'headed'}）`);
  console.log(`profile 根目录：${PROFILE_BASE}`);
  console.log(`阶段：${stages.join(' + ')}`);
  if (CHROME_PATH && !existsSync(CHROME_PATH)) {
    console.error(`❌ BDP_CHROME_PATH 指向的文件不存在：${CHROME_PATH}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(SCREENSHOTS, { recursive: true });

  const { missing, dashboardMissing } = distCheck();
  const runMock = stages.includes('mock');
  const runExtension = stages.includes('extension');
  const blocking = missing.length > 0 || (runMock && dashboardMissing);
  if (blocking) {
    fail(
      'dist 产物完整',
      missing.length > 0
        ? `缺少 ${missing.join(', ')}，请先运行 npm run build`
        : '缺少 dashboard.html，请先运行 npm run build:ui（或 npm run build）',
    );
    writeSummary(only);
    process.exitCode = 1;
    return;
  }
  if (!dashboardMissing) pass('dist 产物完整');

  try {
    if (runMock) {
      const { origin } = await startStaticServer(DIST);
      console.log(`静态服务：${origin}`);
      try {
        await stageDashboardMock(origin);
      } catch (error) {
        fail('仪表盘 mock 阶段执行', `${short(error)}${launchFailureHint(short(error))}`);
      }
    }
    if (runExtension) {
      try {
        await stageExtension();
      } catch (error) {
        fail('扩展阶段执行', `${short(error)}${launchFailureHint(short(error))}`);
      }
    }
  } finally {
    for (const task of cleanupTasks.reverse()) {
      try {
        await task();
      } catch {
        /* ignore */
      }
    }
    writeSummary(only);
  }

  const failed = results.filter((row) => row.status === 'fail');
  const skipped = results.filter((row) => row.status === 'skip');
  console.log('\n=== 结果摘要 ===');
  console.log(
    `通过 ${results.filter((row) => row.status === 'pass').length} 项，失败 ${failed.length} 项，跳过 ${skipped.length} 项`,
  );
  console.log(`浏览器：${BROWSER_LABEL}（${HEADLESS ? 'headless' : 'headed'}）`);
  console.log(`截图目录：${SCREENSHOTS}`);
  if (extraSummary.swDirectFetch) {
    console.log(`SW 直连 api.bilibili.com：${JSON.stringify(extraSummary.swDirectFetch)}`);
  }
  if (failed.length > 0) {
    console.log('失败项：');
    for (const row of failed) console.log(`  ❌ ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
  }
  if (skipped.length > 0) {
    console.log('跳过项：');
    for (const row of skipped) console.log(`  ⚠️  ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

process.on('unhandledRejection', (error) => {
  console.error('未处理的 Promise 拒绝：', error);
  process.exitCode = 1;
});

main().catch((error) => {
  console.error('❌ e2e 异常终止：', error);
  fail('e2e 执行异常', short(error));
  writeSummary('unknown');
  process.exitCode = 1;
});
