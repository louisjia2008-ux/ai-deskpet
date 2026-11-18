import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launch = async (profile: string): Promise<{ application: ElectronApplication; page: Page }> => {
  const application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
  await expect.poll(() => application.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
  const page = application.windows().find((window) => window.url().includes('/main_window/'))!;
  await expect(page.locator('.app-shell')).toBeVisible();
  // Keep the doctor's desktop fallback off the tester's screen.
  await application.evaluate(({ Notification }) => { Notification.prototype.show = function show() { return undefined; }; });
  await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
  return { application, page };
};

// Isolated profile; real main/preload/renderer. QQ is not set up, so reports fall back to the desktop.
// eslint-disable-next-line no-empty-pattern
test('the doctor tab shows its switch and checks, and a run that was killed is reported after the next start', async ({}, info) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-doctor-e2e-'));
  let application: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ application, page } = await launch(profile));
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '医生', exact: true }).click();
    await expect(page.getByRole('heading', { name: '医生', exact: true }).last()).toBeVisible();
    await expect(page.getByLabel('医生开启')).toBeChecked();
    await page.getByRole('button', { name: '立即检查', exact: true }).click();
    await expect(page.locator('.doctor-panel')).toContainText('还没有记录到问题');
    await expect(page.locator('.doctor-panel')).not.toContainText('上次检查：还没有');
    await page.getByLabel('医生开启').uncheck();
    await expect(page.getByRole('button', { name: '立即检查', exact: true })).toBeDisabled();
    await page.getByLabel('医生开启').check();
    await expect(page.getByRole('button', { name: '立即检查', exact: true })).toBeEnabled();

    // No normal shutdown: the next run must say so.
    const killed = application.process();
    killed.kill('SIGKILL');
    await expect.poll(() => killed.exitCode !== null || killed.signalCode !== null).toBe(true);
    ({ application, page } = await launch(profile));
    const status = await page.evaluate(() => window.deskpet.attention.checkDoctor!());
    expect(status.cases).toEqual([expect.objectContaining({ code: 'app.uncleanExit', event: true, resolvedAt: null })]);
    expect(['desktop', 'held']).toContain(status.cases[0]!.reported);
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '医生', exact: true }).click();
    await expect(page.locator('.doctor-panel article.attention-card')).toContainText('没有正常退出');
    await page.screenshot({ path: info.outputPath('doctor.png'), scale: 'css', animations: 'disabled' });
  } finally { await application?.close().catch(() => undefined); await rm(profile, { recursive: true, force: true }); }
});
