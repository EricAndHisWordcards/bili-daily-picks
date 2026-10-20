/**
 * 内容脚本：B站页面右下角的悬浮入口 + 为后台中转 api.bilibili.com 请求。
 *
 * 约定：
 * - 悬浮入口整体放在 Shadow DOM 内，页面样式进不来，也不会污染 B站页面；
 * - 是否显示由「设置里的 showFloatingButton」与「用户点过关闭的本地记忆」共同决定；
 * - 只允许中转 https://api.bilibili.com/ 下的 URL，防止被任意页面借道请求；
 * - 内容脚本在每个页面只注入一次，SPA 切路由不会重复挂载。
 */
import { BILI_ORIGIN } from '../shared/constants';
import { createChromeSettingsStore } from '../core/store/settings';
import type { ApiFetchRequest, ApiFetchResult } from '../shared/types';

/** 宿主元素 id 与 e2e 选择器：宿主在页面 DOM 里，按钮在 Shadow DOM 里 */
const HOST_ID = 'bili-daily-picks-floating';
const HOST_TESTID = 'floating-entry';
const BUTTON_TESTID = 'floating-button';
const CLOSE_TESTID = 'floating-close';

/** 用户点过「关闭」后的记忆；设置里重新打开 showFloatingButton 时由后台清除 */
const DISMISS_STORAGE_KEY = 'floating:dismissed';
const SETTINGS_STORAGE_KEY = 'settings';
const INJECTED_FLAG = '__biliDailyPicksFloatingInjected__';

const ALLOWED_API_HOST = new URL(BILI_ORIGIN).hostname;

const settingsStore = createChromeSettingsStore();

let hostElement: HTMLDivElement | null = null;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.storage?.local) &&
    typeof chrome.storage.local.get === 'function'
  );
}

/** 用户是否手动关掉了悬浮入口（跨页面/刷新记忆） */
async function readDismissed(): Promise<boolean> {
  if (!hasChromeStorage()) return false;
  try {
    const stored = await chrome.storage.local.get(DISMISS_STORAGE_KEY);
    return stored?.[DISMISS_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

async function writeDismissed(): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [DISMISS_STORAGE_KEY]: true });
  } catch {
    /* 存储失败时先隐藏，下次刷新可能再出现，可接受 */
  }
}

/* ------------------------------------------------------------------ */
/* 悬浮入口（Shadow DOM）                                              */
/* ------------------------------------------------------------------ */

function shadowStyleText(): string {
  return `
    :host {
      all: initial;
    }
    .bdp-wrap {
      position: relative;
      width: 100%;
      height: 100%;
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .bdp-button {
      appearance: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      width: 56px;
      height: 56px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: linear-gradient(135deg, #fb7299 0%, #ff9db7 100%);
      color: #fff;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 6px 18px rgba(251, 114, 153, 0.45);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .bdp-button:hover {
      transform: translateY(-2px) scale(1.04);
      box-shadow: 0 8px 22px rgba(251, 114, 153, 0.55);
    }
    .bdp-button:active {
      transform: scale(0.96);
    }
    .bdp-button:focus-visible {
      outline: 2px solid #00aeec;
      outline-offset: 2px;
    }
    .bdp-label {
      display: block;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.12;
      letter-spacing: 0.5px;
      color: #fff;
    }
    .bdp-close {
      position: absolute;
      top: -5px;
      right: -5px;
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      margin: 0;
      padding: 0 0 1px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 50%;
      background: #fff;
      color: #666;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    }
    .bdp-wrap:hover .bdp-close,
    .bdp-close:focus-visible {
      opacity: 1;
    }
  `;
}

function createLabel(text: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'bdp-label';
  label.textContent = text;
  return label;
}

function createMainButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bdp-button';
  button.dataset.testid = BUTTON_TESTID;
  button.title = '打开 B站每日必看';
  button.setAttribute('aria-label', '打开 B站每日必看仪表盘');
  button.append(createLabel('每日'), createLabel('必看'));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openDashboard();
  });
  return button;
}

function createCloseButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bdp-close';
  button.dataset.testid = CLOSE_TESTID;
  button.title = '关闭悬浮按钮（可在设置里重新打开）';
  button.setAttribute('aria-label', '关闭悬浮按钮');
  button.textContent = '×';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void dismissFloating();
  });
  return button;
}

/** 创建宿主 + Shadow DOM；已存在时直接复用，保证只注入一次 */
function ensureFloatingElement(): HTMLDivElement | null {
  if (!document.body) return null;
  const existing = document.getElementById(HOST_ID);
  if (existing instanceof HTMLDivElement) {
    hostElement = existing;
    return existing;
  }

  const element = document.createElement('div');
  element.id = HOST_ID;
  element.dataset.testid = HOST_TESTID;
  // 宿主定位同时写在 content.css 里，这里内联一份作为兜底
  element.style.cssText = [
    'position: fixed',
    'right: 20px',
    'bottom: 112px',
    'width: 56px',
    'height: 56px',
    'z-index: 2147483000',
    'pointer-events: auto',
  ].join(';');

  const shadow = element.attachShadow({ mode: 'open' });
  const wrap = document.createElement('div');
  wrap.className = 'bdp-wrap';

  const style = document.createElement('style');
  style.textContent = shadowStyleText();

  wrap.append(createMainButton(), createCloseButton());
  shadow.append(style, wrap);
  document.body.append(element);
  hostElement = element;
  return element;
}

function removeFloatingElement(): void {
  const existing = hostElement ?? document.getElementById(HOST_ID);
  existing?.remove();
  hostElement = null;
}

/** 根据设置与关闭记忆决定显示/隐藏 */
async function refreshVisibility(): Promise<void> {
  const [settings, dismissed] = await Promise.all([settingsStore.get(), readDismissed()]);
  if (settings.showFloatingButton && !dismissed) {
    ensureFloatingElement();
  } else {
    removeFloatingElement();
  }
}

async function dismissFloating(): Promise<void> {
  removeFloatingElement();
  await writeDismissed();
}

async function openDashboard(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  } catch (error) {
    console.warn('[B站每日必看] 打开仪表盘失败', error);
  }
}

/* ------------------------------------------------------------------ */
/* API_FETCH：后台 -> 内容脚本的页面上下文中转                          */
/* ------------------------------------------------------------------ */

function isApiFetchRequest(message: unknown): message is ApiFetchRequest {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; url?: unknown };
  return candidate.type === 'API_FETCH' && typeof candidate.url === 'string';
}

/** 只允许 https://api.bilibili.com/ 前缀，且主机名必须完全匹配 */
function isAllowedApiUrl(rawUrl: string): boolean {
  if (!rawUrl.startsWith(`${BILI_ORIGIN}/`)) return false;
  try {
    const target = new URL(rawUrl);
    return target.protocol === 'https:' && target.hostname === ALLOWED_API_HOST;
  } catch {
    return false;
  }
}

async function fetchFromPageContext(url: string): Promise<ApiFetchResult> {
  if (!isAllowedApiUrl(url)) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: '只允许中转 https://api.bilibili.com/ 开头的请求',
    };
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: error instanceof Error ? error.message : '页面上下文请求失败',
    };
  }
}

function installApiRelay(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isApiFetchRequest(message)) return false;
    void fetchFromPageContext(message.url).then(sendResponse);
    // 异步回包必须 return true 保持消息通道
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/**
 * SPA 页面切换路由时 body 内容可能被清空（我们挂在 body 下）。
 * 用一个低频检查把宿主补回去，同时不会重复创建（按 id 复用）。
 */
function installReattachGuard(): void {
  window.setInterval(() => {
    if (!hostElement || hostElement.isConnected || !document.body) return;
    document.body.append(hostElement);
  }, 5000);
}

function installSettingsSync(): void {
  if (!hasChromeStorage() || typeof chrome.storage.onChanged?.addListener !== 'function') return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[SETTINGS_STORAGE_KEY] || changes[DISMISS_STORAGE_KEY]) void refreshVisibility();
  });
}

function start(): void {
  installApiRelay();
  installSettingsSync();
  // 先按设置挂载，再装低频补挂保护
  void refreshVisibility().finally(installReattachGuard);
}

const injectedFlags = globalThis as unknown as Record<string, boolean>;
if (!injectedFlags[INJECTED_FLAG]) {
  injectedFlags[INJECTED_FLAG] = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start(), { once: true });
  } else {
    start();
  }
}
