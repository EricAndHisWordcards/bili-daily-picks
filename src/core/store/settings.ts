import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { Settings, SourceKind } from '../../shared/types';

const SETTINGS_KEY = 'settings';

const SOURCE_KINDS: SourceKind[] = ['popular', 'ranking', 'regionRanking', 'weekly', 'rcmd', 'related'];

export interface SettingsStore {
  get(): Promise<Settings>;
  set(patch: Partial<Settings>): Promise<Settings>;
  reset(): Promise<Settings>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 合并默认值并做边界校验，避免坏数据把界面弄崩 */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Settings>;
  const enabled = { ...DEFAULT_SETTINGS.enabledSources };
  if (raw.enabledSources && typeof raw.enabledSources === 'object') {
    for (const kind of SOURCE_KINDS) {
      if (typeof raw.enabledSources[kind] === 'boolean') enabled[kind] = raw.enabledSources[kind]!;
    }
  }
  const theme: Settings['theme'] =
    raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'auto'
      ? raw.theme
      : DEFAULT_SETTINGS.theme;
  const tagWindow: Settings['tagWindow'] =
    raw.tagWindow === '7d' || raw.tagWindow === '30d' || raw.tagWindow === 'all'
      ? raw.tagWindow
      : DEFAULT_SETTINGS.tagWindow;

  return {
    perSection: clampInt(raw.perSection, 2, 5, DEFAULT_SETTINGS.perSection),
    autoUpdate: typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULT_SETTINGS.autoUpdate,
    updateHour: clampInt(raw.updateHour, 0, 23, DEFAULT_SETTINGS.updateHour),
    enabledSources: enabled,
    showFloatingButton:
      typeof raw.showFloatingButton === 'boolean'
        ? raw.showFloatingButton
        : DEFAULT_SETTINGS.showFloatingButton,
    theme,
    regionSections: clampInt(raw.regionSections, 2, 5, DEFAULT_SETTINGS.regionSections),
    tagWindow,
  };
}

export function createMemorySettingsStore(initial?: Partial<Settings>): SettingsStore {
  let current = sanitizeSettings({ ...DEFAULT_SETTINGS, ...initial });
  return {
    async get() {
      return { ...current };
    },
    async set(patch) {
      current = sanitizeSettings({ ...current, ...patch });
      return { ...current };
    },
    async reset() {
      current = { ...DEFAULT_SETTINGS };
      return { ...current };
    },
  };
}

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.storage?.local) &&
    typeof chrome.storage.local.get === 'function'
  );
}

export function createChromeSettingsStore(): SettingsStore {
  if (!hasChromeStorage()) return createMemorySettingsStore();

  const read = async (): Promise<Settings> => {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      return sanitizeSettings(stored?.[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  };

  const write = async (settings: Settings): Promise<Settings> => {
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    } catch {
      /* 存储失败时仍返回内存值，界面不至于崩 */
    }
    return settings;
  };

  return {
    async get() {
      return read();
    },
    async set(patch) {
      const current = await read();
      return write(sanitizeSettings({ ...current, ...patch }));
    },
    async reset() {
      return write({ ...DEFAULT_SETTINGS });
    },
  };
}
