import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultWeChatFollowupSettings } from '../../src/shared/wechat-followup';
import type { WeChatFollowupAction, WeChatFollowupItem, WeChatFollowupSettings } from '../../src/shared/wechat-followup';

// The positive UI scenario uses synthetic IPC in an isolated profile. Source matching,
// scheduler delivery and permission revocation are exercised without a running listener.
// eslint-disable-next-line no-empty-pattern
test('packaged WeChat follow-ups preserve per-group consent and list controls', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-followup-packaged-')));
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
      account_name: 'Fixture account', targets: { private: { title: 'Fixture owner' }, group: { title: 'Fixture reply group' } },
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

    const protectedState = await page.evaluate(async () => {
      const followup = window.deskpet.wechatFollowup!;
      return { settings: await followup.getSettings(), items: await followup.list() };
    });
    expect(protectedState.settings).toMatchObject({ available: false, groups: [] });
    expect(protectedState.items).toEqual([]);

    const group = { id: 'c'.repeat(64), title: '合成待跟进群' };
    const item: WeChatFollowupItem = { id: 'd'.repeat(64), groupTitle: group.title, at: Date.UTC(2026, 0, 1),
      summary: '对方在等你确认参加。', detail: '合成上下文。', deadline: '周五 17:00', snoozedUntil: null };
    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic WeChat follow-ups refused outside the expected isolated packaged app');
      }
      let settings = fixture.settings;
      let items = [fixture.item];
      for (const channel of ['wechat-followup:get-settings', 'wechat-followup:configure', 'wechat-followup:list', 'wechat-followup:act']) ipcMain.removeHandler(channel);
      ipcMain.handle('wechat-followup:get-settings', () => ({ available: true, groups: [fixture.group], providers: [], settings }));
      ipcMain.handle('wechat-followup:configure', (_event, { payload }: { payload: WeChatFollowupSettings }) => { settings = payload; });
      ipcMain.handle('wechat-followup:list', () => items);
      ipcMain.handle('wechat-followup:act', (_event, { payload }: { payload: WeChatFollowupAction }) => {
        if (payload.id !== fixture.item.id) throw new Error('Unexpected synthetic follow-up action');
        if (payload.action === 'done') items = [];
        else items = items.map(item => ({ ...item, snoozedUntil: Date.now() + payload.minutes * 60_000 }));
      });
    }, { root, executable, profile, asar, settings: defaultWeChatFollowupSettings(), group, item });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '微信通道', exact: true }).click();
    await page.getByRole('tab', { name: '每日整理', exact: true }).click();
    const settings = page.getByRole('region', { name: '等你处理', exact: true });
    await expect(settings.getByLabel('每天发送时间（本机时间）')).toHaveValue('21:30');
    await settings.getByRole('spinbutton', { name: '等待回复（分钟）' }).fill('75');
    await settings.getByRole('checkbox', { name: group.title, exact: true }).check();
    await expect(settings.getByRole('checkbox', { name: `允许发送给云端模型 · ${group.title}`, exact: true })).not.toBeChecked();
    await settings.getByRole('button', { name: '保存跟进设置', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('跟进设置已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechatFollowup!.getSettings()).settings))
      .toEqual({ time: '21:30', waitMinutes: 75, groups: [{ id: group.id, cloud: false }], provider: null });

    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '等你处理', exact: true }).click();
    const result = page.getByRole('tabpanel', { name: '等你处理', exact: true });
    await expect(result.getByText(item.summary)).toBeVisible();
    await expect(result.getByText(item.detail)).toBeHidden();
    await result.getByText('展开上下文', { exact: true }).click();
    await expect(result.getByText(item.detail)).toBeVisible();
    await result.getByRole('button', { name: '延后 1 小时', exact: true }).click();
    await expect(result.getByText('延后提醒至', { exact: true })).toBeVisible();
    await result.getByRole('button', { name: '标为已处理', exact: true }).click();
    await expect(result.getByText('暂时没有等待你处理的群消息。')).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
