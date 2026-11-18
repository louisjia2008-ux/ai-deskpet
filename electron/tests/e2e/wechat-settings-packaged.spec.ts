import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const writePrivate = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value), { mode: 0o600 });

async function openWeChat(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '微信通道', exact: true }).click();
  const section = page.getByRole('region', { name: '微信通道', exact: true });
  await expect(section.getByText('Fixture group', { exact: true })).toBeVisible();
  return section;
}

// eslint-disable-next-line no-empty-pattern
test('packaged WeChat settings persist group policy and pause state through IPC', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(200_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA256 = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA256).toMatch(/^[a-f0-9]{64}$/u);
  expect(digest(await readFile(asar))).toBe(expectedSHA256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-packaged-')));
  const profile = join(root, 'profile');
  const channel = join(profile, 'wechat-channel');
  const listener = join(channel, 'listener');
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;

  let application: ElectronApplication | undefined;
  const launch = async (): Promise<Page> => {
    application = await electron.launch({
      executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'],
      env, timeout: 55_000,
    });
    const identity = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') }));
    expect(identity).toEqual({ isPackaged: true, appPath: asar, userData: profile });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    return application.windows().find(window => window.url().includes('/main_window/'))!;
  };

  try {
    await writePrivate(join(root, 'isolated-candidate.json'), { version: 1, purpose: 'deskpet-isolated-candidate' });
    await mkdir(profile, { mode: 0o700 });
    await mkdir(channel, { mode: 0o700 });
    await mkdir(listener, { mode: 0o700 });
    await writePrivate(join(channel, 'targets.json'), {
      account_name: 'Fixture bot', targets: { private: { title: 'Fixture owner' }, group: { title: 'Fixture group' } },
    });
    await writePrivate(join(listener, 'owner.json'), {
      account: 'Fixture bot', title: 'Fixture owner', fingerprint: 'a'.repeat(64), group_fingerprints: ['b'.repeat(64)],
    });
    const writeHeartbeat = (versioned: boolean): Promise<void> => writePrivate(join(listener, 'status.json'), {
      state: 'running', heartbeat_at: Date.now() / 1000, pid: process.pid, private: 'ready', group: 'ready', pending: 0, uncertain: 0,
      ...(versioned ? { group_policy_version: 4 } : {}),
    });
    let page = await launch();
    await expect(page.locator('.app-shell')).toBeVisible();
    await writeHeartbeat(true);
    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    let section = await openWeChat(page);
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getCloud()).available)).toBe(false);
    const isolatedRoster = await page.evaluate(async () => {
      const error = (request: Promise<unknown>) => request.then(() => '', reason => String(reason));
      return Promise.all([error(window.deskpet.wechat.listReplyGroups()), error(window.deskpet.wechat.addReplyGroup('a'.repeat(64)))]);
    });
    expect(isolatedRoster).toEqual([expect.stringContaining('wechat.unavailable'), expect.stringContaining('wechat.unavailable')]);
    let mode = section.getByLabel('什么时候在群里回复');
    await expect(mode).toHaveValue('mentions');
    await expect(section.getByText('运行中', { exact: true })).toBeVisible();
    await mode.selectOption('sender');
    const sender = section.getByRole('textbox', { name: /成员在这个群里显示的准确昵称/u });
    const save = section.getByRole('button', { name: '保存群聊回复方式', exact: true });
    await expect(save).toBeDisabled();
    await sender.fill('  群友甲  ');
    await save.click();
    await expect(section.getByRole('status').filter({ hasText: '群聊回复方式已保存。' })).toHaveText('群聊回复方式已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getState()).groupPolicy)).toEqual({ mode: 'sender', sender: '群友甲' });
    await application!.close();

    page = await launch();
    section = await openWeChat(page);
    mode = section.getByLabel('什么时候在群里回复');
    await expect(mode).toHaveValue('sender');
    await expect(section.getByRole('textbox', { name: /成员在这个群里显示的准确昵称/u })).toHaveValue('群友甲');
    const saveAfterRestart = section.getByRole('button', { name: '保存群聊回复方式', exact: true });
    await mode.selectOption('all');
    await expect(section.getByText(/包括没有 @ 它的消息/u)).toBeVisible();
    await saveAfterRestart.click();
    await expect(section.getByRole('status').filter({ hasText: '群聊回复方式已保存。' })).toHaveText('群聊回复方式已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getState()).groupPolicy)).toEqual({ mode: 'all', sender: null });
    await mode.selectOption('off');
    await saveAfterRestart.click();
    await expect(section.getByRole('status').filter({ hasText: '群聊回复方式已保存。' })).toHaveText('群聊回复方式已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getState()).groupPolicy)).toEqual({ mode: 'off', sender: null });

    await section.getByRole('button', { name: '暂停自动回复', exact: true }).click();
    await expect(section.getByRole('button', { name: '恢复自动回复', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getState()).paused)).toBe(true);
    await section.getByRole('button', { name: '恢复自动回复', exact: true }).click();
    await expect(section.getByRole('button', { name: '暂停自动回复', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getState()).paused)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('wechat-settings.png'), scale: 'css' });

    await writeHeartbeat(false);
    await section.getByRole('button', { name: '刷新状态', exact: true }).click();
    await expect(section.getByRole('alert').filter({ hasText: /现有微信监听服务需要更新/u })).toHaveText(/现有微信监听服务需要更新/u);
    await expect(mode).toBeDisabled();
    await expect(saveAfterRestart).toBeDisabled();
    await expect(section.getByRole('button', { name: '暂停自动回复', exact: true })).toBeEnabled();
    await writePrivate(join(listener, 'status.json'), {
      state: 'degraded', heartbeat_at: Date.now() / 1000, pid: process.pid, private: 'send_uncertain',
      group: 'ready', pending: 0, uncertain: 1, group_policy_version: 4, reason: 'send_receipt_unconfirmed',
    });
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: /^运行状态/u }).click();
    const diagnosis = page.locator('article.attention-card').filter({ has: page.getByRole('heading', { name: '微信', exact: true }) });
    await expect(diagnosis.getByRole('status')).toContainText('目前未确认送达。不会重复发送。');
    await expect(diagnosis.getByRole('status')).toContainText('wechat.send_receipt_unconfirmed');
    expect(digest(await readFile(asar))).toBe(expectedSHA256);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
