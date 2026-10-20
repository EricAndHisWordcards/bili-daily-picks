import { describe, expect, it } from 'vitest';
import type { TagData, ViewData } from '../../../src/core/api/endpoints';
import {
  ENRICH_CONFIG,
  applyTags,
  applyView,
  enrichCandidate,
  needsTags,
  needsView,
} from '../../../src/core/sources/enrich';
import { createMemoryRepository } from '../../../src/core/store/repository';
import {
  FIXTURE_NOW,
  createStubEnrichApi,
  loadFixture,
  makeCandidate,
} from './helpers';

const viewFixture = loadFixture<{ data: ViewData }>('view.json').data;
const tagFixture = loadFixture<{ data: TagData[] }>('tags.json').data;

function emptyCandidate(bvid = 'BV1empty') {
  return makeCandidate({
    bvid,
    stat: { view: 0, like: 0, favorite: 0, coin: 0, reply: 0, danmaku: 0, share: 0 },
    tid: undefined,
    cid: undefined,
    tname: '',
    parentRegion: '其他',
    duration: 0,
    pubdate: 0,
    tags: undefined,
  });
}

describe('sources/enrich 判定', () => {
  it('缺 stat / tid / tname 时需要补详情', () => {
    expect(needsView(emptyCandidate())).toBe(true);
    expect(needsView(makeCandidate({ bvid: 'BVok', stat: { view: 100, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1, share: 1 } }))).toBe(
      false,
    );
    expect(needsView(makeCandidate({ bvid: 'BVnotid', tid: undefined }))).toBe(true);
    expect(needsView(makeCandidate({ bvid: 'BVnoname', tname: '' }))).toBe(true);
  });

  it('无标签时需要补标签', () => {
    expect(needsTags(emptyCandidate())).toBe(true);
    expect(needsTags(makeCandidate({ bvid: 'BVtagged', tags: ['游戏'] }))).toBe(false);
  });

  it('applyView 合并统计/分区/时长，applyTags 去重截断', () => {
    const candidate = emptyCandidate('BV1view');
    const applied = applyView(candidate, {
      ...viewFixture,
      bvid: 'BV1view',
      tname: '科学科普',
    });
    expect(applied.tid).toBe(viewFixture.tid);
    expect(applied.cid).toBe(viewFixture.cid);
    expect(applied.pubdate).toBe(viewFixture.pubdate);
    expect(applied.duration).toBe(viewFixture.duration);
    expect(applied.stat.view).toBeGreaterThan(0);
    expect(applied.tname).toBe('科学科普');
    expect(applied.parentRegion).toBe('知识');

    const tagged = applyTags(candidate, [
      { tag_id: 1, tag_name: '标签A' },
      { tag_id: 2, tag_name: '标签A' },
      { tag_id: 3, tag_name: ' 标签B ' },
      { tag_id: 4, tag_name: '' },
    ]);
    expect(tagged.tags).toEqual(['标签A', '标签B']);
    const many = Array.from({ length: 20 }, (_, i) => ({ tag_id: i, tag_name: `标签${i}` }));
    expect(applyTags(candidate, many).tags).toHaveLength(ENRICH_CONFIG.maxTagsPerVideo);
  });
});

describe('sources/enrich 补全与缓存', () => {
  it('按需请求 /view 与 /tags 并写入缓存', async () => {
    const repo = createMemoryRepository();
    const api = createStubEnrichApi({
      view: async (bvid) => ({ ...viewFixture, bvid, tname: '科学科普' }),
    });
    const result = await enrichCandidate(emptyCandidate('BV1cache'), {
      repo,
      api,
      nowMs: FIXTURE_NOW,
      index: 0,
    });
    expect(result.viewRequested).toBe(true);
    expect(result.tagsRequested).toBe(true);
    expect(result.candidate.tid).toBe(viewFixture.tid);
    expect(result.candidate.parentRegion).toBe('知识');
    expect(result.candidate.tags?.length).toBeGreaterThan(0);
    expect(api.viewCalls).toEqual(['BV1cache']);
    expect(api.tagCalls).toEqual(['BV1cache']);

    // 第二次用同一 bvid 的「原始缺字段」候选：命中缓存，不再请求
    const again = await enrichCandidate(emptyCandidate('BV1cache'), {
      repo,
      api,
      nowMs: FIXTURE_NOW + 60_000,
      index: 0,
    });
    expect(again.viewRequested).toBe(false);
    expect(again.tagsRequested).toBe(false);
    expect(api.viewCalls).toHaveLength(1);
    expect(api.tagCalls).toHaveLength(1);
    expect(again.candidate.stat.view).toBeGreaterThan(0);
  });

  it('缓存过期后会重新请求', async () => {
    const repo = createMemoryRepository();
    const api = createStubEnrichApi();
    await enrichCandidate(emptyCandidate('BV1ttl'), { repo, api, nowMs: FIXTURE_NOW, index: 0 });
    // 6 小时 1 毫秒之后 /view 缓存过期（标签缓存仍是新鲜的）
    const later = FIXTURE_NOW + 6 * 60 * 60 * 1000 + 1;
    await enrichCandidate(emptyCandidate('BV1ttl'), { repo, api, nowMs: later, index: 0 });
    expect(api.viewCalls).toHaveLength(2);
    expect(api.tagCalls).toHaveLength(1);
  });

  it('只补前 120 个的 /view、前 60 个的 /tags', async () => {
    const repo = createMemoryRepository();
    const api = createStubEnrichApi();
    const candidate = emptyCandidate('BV1limit');

    const beyondView = await enrichCandidate(candidate, {
      repo,
      api,
      nowMs: FIXTURE_NOW,
      index: ENRICH_CONFIG.maxView,
    });
    expect(beyondView.viewRequested).toBe(false);

    const beyondTags = await enrichCandidate(candidate, {
      repo,
      api,
      nowMs: FIXTURE_NOW,
      index: ENRICH_CONFIG.maxTags,
    });
    // index >= maxTags 时仍可补 /view（120 以内）
    expect(beyondTags.viewRequested).toBe(true);
    expect(beyondTags.tagsRequested).toBe(false);
    expect(api.viewCalls).toEqual(['BV1limit']);
    expect(api.tagCalls).toHaveLength(0);
  });

  it('接口失败只降级不抛错，并做负缓存', async () => {
    const repo = createMemoryRepository();
    const api = createStubEnrichApi({
      view: async () => {
        throw new Error('风控校验失败');
      },
      tags: async () => {
        throw new Error('接口超时');
      },
    });
    const result = await enrichCandidate(emptyCandidate('BV1fail'), {
      repo,
      api,
      nowMs: FIXTURE_NOW,
      index: 0,
    });
    expect(result.degraded).toContain('详情补全失败');
    expect(result.candidate.stat.view).toBe(0);
    // 负缓存生效：10 分钟内不再重试
    const second = await enrichCandidate(emptyCandidate('BV1fail'), {
      repo,
      api,
      nowMs: FIXTURE_NOW + 60_000,
      index: 0,
    });
    expect(second.degraded).toBeUndefined();
    expect(api.viewCalls).toHaveLength(1);
    expect(api.tagCalls).toHaveLength(1);
  });

  it('已有完整信息时不发请求', async () => {
    const repo = createMemoryRepository();
    const api = createStubEnrichApi();
    const candidate = makeCandidate({ bvid: 'BV1complete', tags: ['已有标签'] });
    const result = await enrichCandidate(candidate, {
      repo,
      api,
      nowMs: FIXTURE_NOW,
      index: 0,
    });
    expect(result.viewRequested).toBe(false);
    expect(result.tagsRequested).toBe(false);
    expect(api.viewCalls).toHaveLength(0);
    expect(api.tagCalls).toHaveLength(0);
  });
});
