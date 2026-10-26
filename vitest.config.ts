import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/bulk/**/*.test.ts'],
    restoreMocks: true,
    server: { deps: { inline: ['wxt'] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'entrypoints/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: process.env.WEB_INK_COVERAGE_DIR || 'coverage',
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 70 },
    },
  },
});
