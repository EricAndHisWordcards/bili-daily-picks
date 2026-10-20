import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { createMemorySettingsStore, sanitizeSettings } from '../../../src/core/store/settings';

describe('settings', () => {
  it('默认值合法', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.perSection).toBe(3);
    expect(DEFAULT_SETTINGS.regionSections).toBe(5);
    expect(DEFAULT_SETTINGS.updateHour).toBe(4);
  });

  it('边界值被夹紧', () => {
    expect(sanitizeSettings({ perSection: 9 }).perSection).toBe(5);
    expect(sanitizeSettings({ perSection: 0 }).perSection).toBe(2);
    expect(sanitizeSettings({ regionSections: 100 }).regionSections).toBe(5);
    expect(sanitizeSettings({ regionSections: 1 }).regionSections).toBe(2);
    expect(sanitizeSettings({ updateHour: -3 }).updateHour).toBe(0);
    expect(sanitizeSettings({ updateHour: 99 }).updateHour).toBe(23);
  });

  it('非法枚举回退默认值', () => {
    const settings = sanitizeSettings({ theme: 'neon', tagWindow: '2y' } as never);
    expect(settings.theme).toBe('auto');
    expect(settings.tagWindow).toBe('7d');
  });

  it('数据源开关只接受布尔值', () => {
    const settings = sanitizeSettings({ enabledSources: { popular: false, ranking: 'yes' } } as never);
    expect(settings.enabledSources.popular).toBe(false);
    expect(settings.enabledSources.ranking).toBe(DEFAULT_SETTINGS.enabledSources.ranking);
    expect(Object.keys(settings.enabledSources)).toHaveLength(6);
  });

  it('memory store 可读可写可重置', async () => {
    const store = createMemorySettingsStore();
    expect((await store.get()).perSection).toBe(3);
    const updated = await store.set({ perSection: 5, showFloatingButton: false });
    expect(updated.perSection).toBe(5);
    expect((await store.get()).showFloatingButton).toBe(false);
    expect((await store.reset()).perSection).toBe(3);
  });
});
