import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const launch = async (root: string): Promise<{ application: ElectronApplication; page: Page }> => {
  let application: ElectronApplication;
  if (process.env.DESKPET_PACKAGED_APP) {
    const executable = await realpath(process.env.DESKPET_PACKAGED_APP);
    const asar = resolve(dirname(executable), '../Resources/app.asar');
    const expected = process.env.DESKPET_EXPECTED_ASAR_SHA256;
    expect(expected).toMatch(/^[a-f0-9]{64}$/u);
    expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expected);
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    application = await electron.launch({ executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
    expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData') })))
      .toEqual({ packaged: true, userData: join(root, 'profile') });
  } else {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')],
      env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: root } });
  }
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-doctor-e2e-')));
  const profile = process.env.DESKPET_PACKAGED_APP ? join(root, 'profile') : root;
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }), { mode: 0o600 });
    let page: Page;
    ({ application, page } = await launch(root));
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '医生', exact: true }).click();
    await expect(page.getByRole('heading', { name: '医生', exact: true }).last()).toBeVisible();
    await expect(page.getByLabel('医生开启')).toBeChecked();
    await expect(page.getByLabel('自动修复')).toBeChecked();
    await expect(page.getByRole('heading', { name: '最近的修复记录' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('doctor-settings.png'), scale: 'css', animations: 'disabled' });
    await page.getByLabel('自动修复').click();
    await expect(page.getByLabel('自动修复')).toBeEnabled();
    await expect(page.getByLabel('自动修复')).not.toBeChecked();
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
    // A completed synthetic record also verifies the packaged UI reads the persisted repair log.
    const doctorPath = join(profile, 'doctor.json');
    const saved = JSON.parse(await readFile(doctorPath, 'utf8'));
    const at = new Date().toISOString();
    saved.data.repairs = [{ id: 'asr', at, finishedAt: at, result: 'recovered', circuitUntil: null, heldForMorning: false, reportedAt: at }];
    await writeFile(doctorPath, JSON.stringify(saved), { mode: 0o600 });
    ({ application, page } = await launch(root));
    const status = await page.evaluate(() => window.deskpet.attention.checkDoctor!());
    expect(status.autoRepair).toBe(false);
    expect(status.cases).toEqual([expect.objectContaining({ code: 'app.uncleanExit', event: true, resolvedAt: null })]);
    expect(['desktop', 'held']).toContain(status.cases[0]!.reported);
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '医生', exact: true }).click();
    await expect(page.locator('.doctor-panel article.attention-card').filter({ hasText: '没有正常退出' })).toBeVisible();
    await expect(page.getByText(/重启本地语音识别.*已恢复/u)).toBeVisible();
    await page.screenshot({ path: info.outputPath('doctor.png'), scale: 'css', animations: 'disabled' });
  } finally { await application?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
