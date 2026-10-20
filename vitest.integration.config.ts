import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 90000,
    hookTimeout: 90000,
    fileParallelism: false,
    pool: 'threads',
  },
});
