import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';

export default defineConfig({
  test: {
    // Keep tokenizer-heavy suites within their existing timeout under load.
    maxWorkers: Math.min(4, availableParallelism()),
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
