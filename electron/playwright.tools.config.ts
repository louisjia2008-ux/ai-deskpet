import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/tool-eval',
  outputDir: './test-results/tool-eval',
  reporter: [['list']],
  workers: 1,
  retries: 0,
  timeout: 1_800_000,
});
