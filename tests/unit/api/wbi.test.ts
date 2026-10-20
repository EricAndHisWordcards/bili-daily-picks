import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildWbiKeys, encodeParam, keyFromUrl, mixinKeyFrom, signQuery } from '../../../src/core/api/wbi';
import { loadFixture, ok } from '../../helpers/fixtures';

describe('wbi', () => {
  it('从 URL 提取 key', () => {
    expect(
      keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'),
    ).toBe('7cd084941338484aae1ad9425b84077c');
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')).toBe(
      '4932caff0ff746eab6f01bf08b70ac45',
    );
  });

  it('mixin key 取前 32 位', () => {
    const imgKey = '7cd084941338484aae1ad9425b84077c';
    const subKey = '4932caff0ff746eab6f01bf08b70ac45';
    const mixin = mixinKeyFrom(imgKey, subKey);
    expect(mixin).toHaveLength(32);
    const raw = imgKey + subKey;
    const expected = [
      raw[46], raw[47], raw[18], raw[2], raw[53], raw[8], raw[23], raw[32], raw[15], raw[50],
      raw[10], raw[31], raw[58], raw[3], raw[45], raw[35], raw[27], raw[43], raw[5], raw[49],
      raw[33], raw[9], raw[42], raw[19], raw[29], raw[28], raw[14], raw[39], raw[12], raw[38],
      raw[41], raw[13],
    ].join('');
    expect(mixin).toBe(expected);
  });

  it('参数做 WBI 规定的转义', () => {
    expect(encodeParam("!*'()")).toBe('%21%2A%27%28%29');
    expect(encodeParam('中文 空格')).toBe('%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC');
  });

  it('签名：参数按 key 排序、包含 wts，w_rid = md5(query + mixin)', () => {
    const mixin = 'ea1db124af3c7062474693fa704f4ff8';
    const wts = 1700000000;
    const query = signQuery({ z: 'last', a: 'first', number: 395 }, mixin, wts);
    const [body, rid] = query.split('&w_rid=');
    expect(body).toBe(`a=first&number=395&wts=${wts}&z=last`);
    expect(rid).toBe(createHash('md5').update(body + mixin).digest('hex'));
  });

  it('从真实 nav fixture 生成密钥并可签名', () => {
    const nav = loadFixture<{ data: { wbi_img: { img_url: string; sub_url: string } } }>('nav');
    ok(nav.data.wbi_img.img_url, 'nav fixture 应包含 wbi_img');
    const keys = buildWbiKeys(nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url);
    expect(keys.imgKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keys.subKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keys.mixinKey).toHaveLength(32);
    const query = signQuery({ number: 395 }, keys.mixinKey, 1700000000);
    expect(query).toMatch(/number=395&wts=1700000000&w_rid=[0-9a-f]{32}$/);
  });
});
