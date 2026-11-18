import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

// Each Playwright worker must preload the guard before it imports the launcher.
// Packaged-app acceptance uses its own isolated profile and scripted dialogs.
const guard = '--require=' + JSON.stringify(join(__dirname, 'tests/support/playwright-electron-guard.cjs'));
if (!process.env.NODE_OPTIONS?.includes(guard)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guard].filter(Boolean).join(' ');
}

export default defineConfig({
  testDir: './tests/e2e',
  // Only clear disposable E2E artifacts; retain manual/native acceptance reports.
  outputDir: './test-results/e2e',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  workers: 1,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
