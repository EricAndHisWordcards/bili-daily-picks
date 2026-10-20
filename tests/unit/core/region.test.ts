import { describe, expect, it } from 'vitest';
import { PARENT_REGIONS } from '../../../src/shared/constants';
import {
  UNKNOWN_REGION,
  isSectionRegion,
  regionNameOfRid,
  regionRidOf,
  resolveCandidateRegion,
  resolveParentRegion,
} from '../../../src/core/sources/region';

describe('sources/region', () => {
  it('把叶子分区映射到一级分区', () => {
    expect(resolveParentRegion('手机游戏')).toBe('游戏');
    expect(resolveParentRegion('人文历史')).toBe('知识');
    expect(resolveParentRegion('喵星人')).toBe('动物圈');
    expect(resolveParentRegion(' 数码 ')).toBe('科技');
  });

  it('本身就是一级分区名时原样返回', () => {
    for (const region of PARENT_REGIONS) {
      expect(resolveParentRegion(region.name)).toBe(region.name);
      expect(resolveParentRegion(`${region.name} `)).toBe(region.name);
    }
  });

  it('未知分区归入「其他」', () => {
    expect(resolveParentRegion('国产动画')).toBe(UNKNOWN_REGION);
    expect(resolveParentRegion('')).toBe(UNKNOWN_REGION);
    expect(resolveParentRegion(undefined)).toBe(UNKNOWN_REGION);
    expect(resolveParentRegion('不存在的分区')).toBe(UNKNOWN_REGION);
    expect(resolveParentRegion('其他')).toBe(UNKNOWN_REGION);
  });

  it('rid 与一级分区名可互查', () => {
    expect(regionRidOf('游戏')).toBe(4);
    expect(regionRidOf('知识')).toBe(36);
    expect(regionRidOf('其他')).toBeUndefined();
    expect(regionRidOf('')).toBeUndefined();
    expect(regionNameOfRid(4)).toBe('游戏');
    expect(regionNameOfRid(36)).toBe('知识');
    expect(regionNameOfRid(9999)).toBeUndefined();
    expect(regionNameOfRid(undefined)).toBeUndefined();
  });

  it('候选分区解析：tname 优先，其次来源 rid/分区名', () => {
    expect(resolveCandidateRegion({ tname: '手机游戏' })).toBe('游戏');
    expect(resolveCandidateRegion({ tname: '', rid: 4 })).toBe('游戏');
    expect(resolveCandidateRegion({ tname: '未知叶子', rid: 36 })).toBe('知识');
    expect(resolveCandidateRegion({ tname: '', regionName: '音乐' })).toBe('音乐');
    expect(resolveCandidateRegion({})).toBe(UNKNOWN_REGION);
  });

  it('只有真实一级分区才能进入分区板块', () => {
    for (const region of PARENT_REGIONS) expect(isSectionRegion(region.name)).toBe(true);
    expect(isSectionRegion('其他')).toBe(false);
    expect(isSectionRegion('番剧')).toBe(false);
    expect(isSectionRegion('手机游戏')).toBe(false);
  });
});
