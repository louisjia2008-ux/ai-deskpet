import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WeChatReplyFriend } from '../../src/shared/wechat-channel';

const privateJson = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value), { mode: 0o600 });

// eslint-disable-next-line no-empty-pattern
test('packaged WeChat settings list, bind and remove an isolated friend', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(90_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expected = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expected).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expected);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-reply-friends-')));
  const profile = join(root, 'profile');
  const channel = join(profile, 'wechat-channel');
  const listener = join(channel, 'listener');
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
  const friend = { id: 'c'.repeat(32), title: '合成联系人' };
  const rosterId = 'b'.repeat(64);

  try {
    await privateJson(join(root, 'isolated-candidate.json'), { version: 1, purpose: 'deskpet-isolated-candidate' });
    await mkdir(profile, { mode: 0o700 });
    await mkdir(channel, { mode: 0o700 });
    await mkdir(listener, { mode: 0o700 });
    await privateJson(join(channel, 'targets.json'), { account_name: 'Fixture bot', targets: { private: { title: 'Fixture owner' } } });
    await privateJson(join(listener, 'owner.json'), { account: 'Fixture bot', title: 'Fixture owner', fingerprint: 'a'.repeat(64) });
    const app = await electron.launch({ executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
    try {
      const identity = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, asar: app.getAppPath(), profile: app.getPath('userData') }));
      expect(identity).toEqual({ isPackaged: true, asar, profile });
      await privateJson(join(listener, 'status.json'), {
        state: 'running', heartbeat_at: Date.now() / 1000, pid: process.pid, private: 'ready', pending: 0, uncertain: 0,
        group_policy_version: 4, reply_target_binding_version: 2,
      });
      await expect.poll(() => app.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
      const page = app.windows().find(window => window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible();
      const blocked = await page.evaluate(async ({ friend, rosterId }) => {
        const invokeError = (p: Promise<unknown>) => p.then(() => '', reason => String(reason));
        const api = window.deskpet.wechat;
        return await Promise.all([invokeError(api.getReplyFriends()), invokeError(api.listReplyFriends()), invokeError(api.addReplyFriend(rosterId)),
          invokeError(api.removeReplyFriend(friend.id)), invokeError(api.configureFriendCloud({ friendId: friend.id, route: null }))]);
      }, { friend, rosterId });
      expect(blocked).toEqual(Array.from({ length: 5 }, () => expect.stringContaining('wechat.unavailable')));

      await app.evaluate(({ ipcMain }, { friend, rosterId }) => {
        let friends: WeChatReplyFriend[] = [];
        const channels = ['wechat:get-reply-friends', 'wechat:list-reply-friends', 'wechat:add-reply-friend', 'wechat:remove-reply-friend'];
        for (const name of channels) ipcMain.removeHandler(name);
        ipcMain.handle('wechat:get-reply-friends', () => friends);
        ipcMain.handle('wechat:list-reply-friends', () => friends.length ? [] : [{ id: rosterId, title: friend.title }]);
        ipcMain.handle('wechat:add-reply-friend', (_event, { payload }: { payload: { id: string } }) => {
          if (payload.id !== rosterId) throw Error('Unexpected fixture roster ID');
          friends = [friend];
          return friends;
        });
        ipcMain.handle('wechat:remove-reply-friend', (_event, { payload }: { payload: { id: string } }) => {
          if (payload.id !== friend.id) throw Error('Unexpected fixture friend ID');
          friends = [];
          return friends;
        });
      }, { friend, rosterId });

      await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
      await page.reload();
      await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: '微信通道', exact: true }).click();
      const settings = page.getByRole('region', { name: '可以回复的好友' });
      await expect(settings.getByText('还没有添加好友。')).toBeVisible();
      await settings.getByRole('button', { name: '添加好友' }).click();
      await settings.getByRole('button', { name: `添加 ${friend.title}` }).click();
      await expect(settings.getByRole('heading', { name: friend.title })).toBeVisible();
      await expect(page.getByText(/已添加好友，默认使用本机模型回复/u)).toBeVisible();
      await settings.getByRole('button', { name: '移除好友' }).click();
      await settings.getByRole('group', { name: '停止回复这位好友？' }).getByRole('button', { name: '移除好友' }).click();
      await expect(settings.getByRole('heading', { name: friend.title })).toHaveCount(0);
      await expect(settings.getByText('还没有添加好友。')).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
