import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultWeChatOfficialBriefSettings } from '../../src/shared/wechat-digests';
import type { WeChatOfficialBriefSettings } from '../../src/shared/wechat-digests';

// Supply synthetic account discovery only after verifying the packaged app and
// its isolated profile. The live account reader and model are never contacted.
// eslint-disable-next-line no-empty-pattern
test('packaged WeChat official brief preserves account scope and default cloud denial', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-official-packaged-')));
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

    const account = { id: 'c'.repeat(64), title: 'Fixture official account' };
    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic official brief refused outside the expected isolated packaged app');
      }
      let settings = fixture.settings;
      ipcMain.removeHandler('wechat-digests:get-official');
      ipcMain.removeHandler('wechat-digests:set-official');
      ipcMain.handle('wechat-digests:get-official', () =>
        ({ available: true, accounts: [fixture.account], providers: [], settings }));
      ipcMain.handle('wechat-digests:set-official', (_event, { payload }: { payload: WeChatOfficialBriefSettings }) => {
        settings = payload;
      });
    }, { root, executable, profile, asar, settings: defaultWeChatOfficialBriefSettings(), account });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '微信通道', exact: true }).click();
    await page.getByRole('tab', { name: '每日整理', exact: true }).click();
    const section = page.getByRole('region', { name: '公众号简报', exact: true });
    await expect(section.getByLabel('每天发送时间（本机时间）')).toHaveValue('08:30');
    await expect(section.getByRole('spinbutton', { name: '最多选取篇数' })).toHaveValue('5');
    const cloud = section.getByRole('checkbox', { name: '允许将文章内容发给云端模型' });
    await expect(cloud).not.toBeChecked();
    await section.getByRole('checkbox', { name: '每天发送公众号简报' }).check();
    await section.getByRole('radio', { name: '仅选中的公众号' }).check();
    await section.getByRole('checkbox', { name: account.title }).check();
    await section.getByRole('spinbutton', { name: '最多选取篇数' }).fill('7');
    await section.getByRole('textbox', { name: '兴趣关键词（每行一个）' }).fill('合成兴趣');
    await section.getByRole('button', { name: '保存公众号简报设置' }).click();
    await expect(section.getByRole('status')).toHaveText('公众号简报设置已保存。');
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechatDigests!.getOfficialSettings()).settings))
      .toEqual({ ...defaultWeChatOfficialBriefSettings(), enabled: true, limit: 7, accountIds: [account.id], keywords: ['合成兴趣'] });
    await expect(cloud).not.toBeChecked();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
