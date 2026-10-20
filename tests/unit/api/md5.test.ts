import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from '../../../src/core/api/md5';

function nodeMd5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

describe('md5', () => {
  it('matches RFC 1321 标准向量', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });

  it('与 Node 的 crypto 实现一致（含中文与长文本）', () => {
    const samples = [
      'B站每日必看',
      '中文测试：历史记录、排行榜、每周必看',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(65),
      'x'.repeat(1000),
      JSON.stringify({ code: 0, data: { mid: 123456, uname: '测试用户' } }),
    ];
    for (const sample of samples) {
      expect(md5(sample)).toBe(nodeMd5(sample));
    }
  });

  it('随机字符串交叉校验', () => {
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return String.fromCharCode(32 + (seed % 95));
    };
    for (let i = 0; i < 20; i++) {
      const sample = Array.from({ length: 1 + (i * 7) % 80 }, next).join('');
      expect(md5(sample)).toBe(nodeMd5(sample));
    }
  });
});
