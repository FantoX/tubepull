import { defineConfig } from 'vitest/config';

// Live tests against YouTube. Run nightly in CI, never as part of `npm test`.
export default defineConfig({
  test: {
    include: ['test/canary/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
