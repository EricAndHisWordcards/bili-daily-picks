import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 20000,
    // 沙箱禁止管道子进程，用 worker 线程而不是 fork
    pool: 'threads',
  },
});
