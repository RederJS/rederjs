import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/*/dist/**'],
      thresholds: {
        'packages/core/src/**/*.ts': { lines: 80, functions: 80, branches: 75, statements: 80 },
        'packages/adapter-telegram/src/**/*.ts': {
          lines: 70,
          functions: 70,
          branches: 65,
          statements: 70,
        },
      },
    },
  },
});
