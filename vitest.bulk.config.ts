import { defineConfig } from 'vitest/config';

/**
 * Large-data correctness tests are intentionally isolated from the fast unit
 * suite. One fork and disabled file parallelism make their IndexedDB timing
 * reproducible enough to diagnose without changing ordinary test limits.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/bulk/**/*.test.ts'],
    restoreMocks: true,
    reporters: ['verbose'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
