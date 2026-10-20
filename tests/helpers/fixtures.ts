import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURE_DIR = resolve(process.cwd(), 'tests/fixtures/api');

/** 读取 tests/fixtures/api 下的 JSON fixture */
export function loadFixture<T = unknown>(name: string): T {
  const file = resolve(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** 测试里的断言辅助：先检查前置条件，再让类型收窄 */
export function ok(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`fixture 断言失败：${message}`);
}
