import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line no-empty-pattern
test('backs up Kitty and profile data through settings, rejects a wrong password, restores and restarts', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'deskpet-backup-e2e-'));
  const profile = join(root, 'profile');
  const archive = join(root, 'fixture.deskpet-backup');
  let application: ElectronApplication | undefined;
  let page: Page;
  const launch = async () => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    // Only fixture dialogs are replaced; all persistence, encryption and model
    // rendering use the actual app. Never run this launcher on a user profile.
    await application.evaluate(({ app, dialog }, paths) => {
      if (app.getPath('userData') !== paths.profile) throw new Error('Wrong test profile');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.archive });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.archive] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, { profile, archive });
  };
  const settings = async () => {
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Privacy and data' }).click();
  };
  try {
    await launch();
    const sessionId = await page!.evaluate(async () => {
      const session = await window.deskpet.chat.createSession({ title: 'Backup acceptance', kind: 'normal' });
      await window.deskpet.relationship.setNickname('Kitty backup original');
      await window.deskpet.memory.upsert({ id: crypto.randomUUID(), text: 'Fixture memory retained', tags: ['backup'] });
      return session.id;
    });
    const core = process.env.DESKPET_LIVE2D_CORE; const model = process.env.DESKPET_LIVE2D_MODEL;
    if (core && model) {
      await application!.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, [core, model]);
      await page!.evaluate(async () => { await window.deskpet.character.importCore(); await window.deskpet.character.importModel(); });
      await expect.poll(async () => (await page!.evaluate(() => window.deskpet.character.getState())).modelState).toBe('ready');
      await page!.evaluate(() => window.deskpet.character.setExpression('Watermark'));
      await application!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, archive);
    }
    await settings();
    await page!.getByLabel('Backup password', { exact: true }).fill('fixture-backup-password');
    await page!.getByLabel('Confirm password for a new backup').fill('fixture-backup-password');
    await page!.getByRole('button', { name: 'Create encrypted backup' }).click();
    await expect(page!.getByText('Encrypted backup saved', { exact: true })).toBeVisible();
    expect((await readFile(archive)).subarray(0, 17).toString()).toBe('DESKPET-BACKUP-1\n');
    await page!.evaluate(() => window.deskpet.relationship.setNickname('Changed after backup'));
    await page!.getByLabel('Backup password', { exact: true }).fill('wrong-fixture-password');
    await page!.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(page!.getByRole('alert')).toContainText('Incorrect password');
    expect((await page!.evaluate(() => window.deskpet.relationship.get())).nickname).toBe('Changed after backup');
    await page!.getByLabel('Backup password', { exact: true }).fill('fixture-backup-password');
    await page!.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(page!.getByRole('alertdialog')).toBeVisible();
    await page!.screenshot({ path: testInfo.outputPath('restore-ready.png') });
    // Intercept only the relaunch request so the fixture can await a clean exit
    // before launching its next isolated process.
    await application!.evaluate(({ app }) => { app.relaunch = () => undefined; });
    const child = application!.process();
    await page!.getByRole('button', { name: 'Restart and restore' }).click();
    await expect.poll(() => child.exitCode).toBe(0);
    await launch();
    expect((await page!.evaluate(() => window.deskpet.relationship.get())).nickname).toBe('Kitty backup original');
    expect((await page!.evaluate(() => window.deskpet.chat.listSessions())).map((item) => item.id)).toContain(sessionId);
    expect((await page!.evaluate(() => window.deskpet.memory.list()))[0]?.text).toBe('Fixture memory retained');
    if (core && model) {
      await expect.poll(async () => (await page!.evaluate(() => window.deskpet.character.getState())).expression).toBe('Watermark');
      await expect(application!.windows().find((window) => window.url().includes('/overlay_window/'))!.locator('main')).toHaveAttribute('data-load-state', 'ready');
    }
    await page!.screenshot({ path: testInfo.outputPath('restored.png') });
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});
