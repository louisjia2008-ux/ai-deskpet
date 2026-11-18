import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All grants belong to this disposable profile, never the installed user's
// permissions. Three real process launches exercise the encrypted persistence.
// eslint-disable-next-line no-empty-pattern
test('keeps explicitly chosen always permissions across restart and honors downgrade and revocation', async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-persistent-permissions-'));
  let application: ElectronApplication | undefined;
  let page!: Page;
  const snapshots: unknown[] = [];
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  };
  const permissions = async (): Promise<void> => {
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '权限', exact: true }).click();
  };
  const state = (title: string) => page.getByRole('article', { name: title, exact: true }).locator('[data-permission-state]');
  const requestTime = async (): Promise<void> => {
    await page.locator('nav').getByRole('button', { name: '聊天', exact: true }).click();
    await page.locator('.composer textarea').fill('帮我查一下现在上海的准确日期和时间。');
    await page.locator('.composer textarea').press('Enter');
  };
  try {
    await launch();
    await page.evaluate(async () => {
      await window.deskpet.app.setLocale('zh-CN');
      // Exact current-time commands run through the real deterministic tool
      // route; this configured provider is not contacted by these requests.
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Permission acceptance', model: 'unused', baseUrl: 'http://127.0.0.1:1/v1', enabled: true, supportsTools: true });
    });
    await permissions();
    await expect(state('日期与时间')).toHaveText('未授权');
    await page.getByRole('article', { name: '日期与时间', exact: true }).getByRole('button', { name: '本次会话允许' }).click();
    await expect(state('日期与时间')).toHaveText('本次会话');
    await page.getByRole('article', { name: '日期与时间', exact: true }).getByRole('button', { name: '始终允许' }).click();
    await expect(state('日期与时间')).toHaveText('始终允许');
    await page.getByRole('article', { name: '计算器', exact: true }).getByRole('button', { name: '本次会话允许' }).click();
    await expect(state('计算器')).toHaveText('本次会话');
    await expect(state('写入工作区文件')).toHaveText('未授权');
    snapshots.push({ stage: 'before-restart', permissions: await page.evaluate(() => window.deskpet.permissions.list()) });
    await page.screenshot({ path: info.outputPath('always-permission-selected.png') });
    await application!.close(); application = undefined;

    await launch(); await permissions();
    await expect(state('日期与时间')).toHaveText('始终允许');
    await expect(state('计算器')).toHaveText('未授权');
    await expect(state('写入工作区文件')).toHaveText('未授权');
    snapshots.push({ stage: 'after-restart', permissions: await page.evaluate(() => window.deskpet.permissions.list()) });
    await page.screenshot({ path: info.outputPath('always-permission-after-restart.png') });
    await requestTime();
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant').last()).toContainText('Asia/Shanghai');
    const allowedEvents = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
    expect(allowedEvents.some((event) => event.type === 'approval' && event.metadata.capabilityId === 'time.read' && event.metadata.action === 'consumed' && event.metadata.scope === 'always')).toBe(true);
    expect(allowedEvents.some((event) => event.metadata.route === 'direct' && event.metadata.toolId === 'time.current')).toBe(true);

    await permissions();
    await page.getByRole('article', { name: '日期与时间', exact: true }).getByRole('button', { name: '改为本次会话' }).click();
    await expect(state('日期与时间')).toHaveText('本次会话');
    await page.getByRole('article', { name: '计算器', exact: true }).getByRole('button', { name: '始终允许' }).click();
    await expect(state('计算器')).toHaveText('始终允许');
    await page.getByRole('article', { name: '计算器', exact: true }).getByRole('button', { name: '撤销' }).click();
    await expect(state('计算器')).toHaveText('未授权');
    await application!.close(); application = undefined;

    await launch(); await permissions();
    await expect(state('日期与时间')).toHaveText('未授权');
    await expect(state('计算器')).toHaveText('未授权');
    snapshots.push({ stage: 'after-downgrade-and-revoke-restart', permissions: await page.evaluate(() => window.deskpet.permissions.list()) });
    await page.screenshot({ path: info.outputPath('revoked-after-restart.png') });
    await requestTime();
    // A revoked permission no longer runs anything: the host asks again, and denying ends the run.
    const denied = page.getByRole('region', { name: '这一步需要你的确认', exact: true });
    await expect(denied).toBeVisible();
    await denied.getByRole('button', { name: '拒绝' }).click();
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'failed');
    const deniedEvents = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
    expect(deniedEvents.some((event) => event.type === 'approval' && event.metadata.capabilityId === 'time.read' && event.metadata.action === 'denied')).toBe(true);
    await writeFile(info.outputPath('permission-evidence.json'), JSON.stringify({ snapshots, allowedEvents, deniedEvents }, null, 2));
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
