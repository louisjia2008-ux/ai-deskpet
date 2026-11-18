import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultWeChatFriendsMomentsSettings } from '../../src/shared/wechat-digests';
import type { WeChatFriendsMomentsSettings } from '../../src/shared/wechat-digests';

// Supply synthetic cache availability only after verifying the packaged app and
// its isolated profile. The live cache reader and model are never contacted.
// eslint-disable-next-line no-empty-pattern
test('packaged WeChat friends’ Moments digest keeps weekly delivery separate from cloud permission', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-friends-moments-packaged-')));
  const profile = join(root, 'profile');
  const channel = join(profile, 'wechat-channel');
  const listener = join(channel, 'listener');
  const writePrivate = (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key]!;

  let app: ElectronApplication | undefined;
  try {
    await writePrivate(join(root, 'isolated-candidate.json'), { version: 1, purpose: 'deskpet-isolated-candidate' });
    await mkdir(listener, { recursive: true, mode: 0o700 });
    await writePrivate(join(channel, 'targets.json'), {
      account_name: 'Fixture account', targets: { private: { title: 'Fixture owner' }, group: { title: 'Fixture group' } },
    });
    await writePrivate(join(listener, 'owner.json'), {
      account: 'Fixture account', title: 'Fixture owner', fingerprint: 'a'.repeat(64), group_fingerprints: ['b'.repeat(64)],
    });

    app = await electron.launch({ executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
    await expect.poll(() => app!.windows().some(page => page.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await writePrivate(join(listener, 'status.json'), {
      state: 'running', heartbeat_at: Date.now() / 1_000, pid: process.pid,
      private: 'ready', group: 'ready', pending: 0, uncertain: 0, group_policy_version: 4,
    });

    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic friends’ Moments digest refused outside the expected isolated packaged app');
      }
      let settings = fixture.settings;
      ipcMain.removeHandler('wechat-digests:get-friends-moments');
      ipcMain.removeHandler('wechat-digests:set-friends-moments');
      ipcMain.handle('wechat-digests:get-friends-moments', () =>
        ({ available: true, providers: [], settings }));
      ipcMain.handle('wechat-digests:set-friends-moments', (_event, { payload }: { payload: WeChatFriendsMomentsSettings }) => {
        settings = payload;
      });
    }, { root, executable, profile, asar, settings: defaultWeChatFriendsMomentsSettings() });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '微信通道', exact: true }).click();
    await page.getByRole('tab', { name: '每日整理', exact: true }).click();
    const section = page.getByRole('region', { name: '好友朋友圈摘要', exact: true });
    await expect(section.getByText(/只读取该账号自己好友已经同步到本机缓存/u)).toBeVisible();
    await expect(section.getByLabel('发送时间（本机时间）')).toHaveValue('20:00');
    const enabled = section.getByRole('checkbox', { name: '发送好友朋友圈摘要' });
    const cloud = section.getByRole('checkbox', { name: '允许将好友朋友圈内容发给云端模型' });
    await expect(enabled).not.toBeChecked();
    await expect(cloud).toBeChecked();
    await enabled.check();
    await cloud.uncheck();
    await section.getByRole('combobox', { name: '发送频率' }).selectOption('weekly');
    await section.getByRole('combobox', { name: '星期', exact: true }).selectOption('6');
    await section.getByRole('button', { name: '保存好友朋友圈摘要设置' }).click();
    await expect(section.getByRole('status')).toHaveText('好友朋友圈摘要设置已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechatDigests!.getFriendsMomentsSettings()).settings))
      .toEqual({ ...defaultWeChatFriendsMomentsSettings(), enabled: true, cloud: false, cadence: 'weekly', weekday: 6 });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
