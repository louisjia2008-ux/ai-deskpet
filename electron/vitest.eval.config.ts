import { defineConfig } from 'vitest/config';

// Quality evals against a real model. Not part of `npm test`: they need an OpenAI key and cost money.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['evals/**/*.eval.ts'],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
