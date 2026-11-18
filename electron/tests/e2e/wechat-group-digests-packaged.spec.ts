import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultWeChatDigestGroupSettings } from '../../src/shared/wechat-digests';
import type { WeChatDigestGroupSettings } from '../../src/shared/wechat-digests';

// The settings and results use isolated synthetic IPC. Worker authorization,
// scheduler delivery and model routing are exercised in their own test suites.
// eslint-disable-next-line no-empty-pattern
test('packaged WeChat group digest settings and Updates details', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-digests-packaged-')));
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

    const group = { id: 'c'.repeat(64), title: 'Fixture read-only group' };
    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic group digests refused outside the expected isolated packaged app');
      }
      let settings = fixture.settings;
      ipcMain.removeHandler('wechat-digests:get-groups');
      ipcMain.removeHandler('wechat-digests:set-groups');
      ipcMain.removeHandler('wechat-digests:group-results');
      ipcMain.handle('wechat-digests:get-groups', () =>
        ({ available: true, groups: [fixture.group], providers: [], settings }));
      ipcMain.handle('wechat-digests:set-groups', (_event, { payload }: { payload: WeChatDigestGroupSettings }) => {
        settings = payload;
      });
      ipcMain.handle('wechat-digests:group-results', () => [{
        at: Date.UTC(2026, 0, 1), delivery: 'succeeded',
        entries: [{ title: fixture.group.title, summary: '合成摘要。', detail: '用于验收的合成详细版。' }],
      }]);
    }, { root, executable, profile, asar, settings: defaultWeChatDigestGroupSettings(), group });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '微信通道', exact: true }).click();
    await page.getByRole('tab', { name: '每日整理', exact: true }).click();
    const settings = page.getByRole('region', { name: '群聊每日精华', exact: true });
    const time = settings.getByLabel('每天发送时间（本机时间）');
    await expect(time).toHaveValue('21:30');
    await time.fill('19:15');
    const selected = settings.getByRole('checkbox', { name: group.title, exact: true });
    await expect(selected).not.toBeChecked();
    await selected.check();
    const cloud = settings.getByRole('checkbox', { name: `允许发送给云端模型 · ${group.title}`, exact: true });
    await expect(cloud).toBeChecked();
    await cloud.uncheck();
    await settings.getByRole('button', { name: '保存群聊精华设置', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('群聊精华设置已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechatDigests!.getGroupSettings()).settings))
      .toEqual({ time: '19:15', groups: [{ id: group.id, cloud: false }], provider: null, keywords: [] });

    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '群聊每日精华', exact: true }).click();
    const results = page.getByRole('tabpanel', { name: '群聊每日精华', exact: true });
    await expect(results.getByText('合成摘要。')).toBeVisible();
    await expect(results.getByText('已发到主人私聊')).toBeVisible();
    await expect(results.getByText('用于验收的合成详细版。')).toBeHidden();
    await results.getByText('查看详细版').click();
    await expect(results.getByText('用于验收的合成详细版。')).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
