import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WeChatAssistant, WeChatCloudState } from '../../src/shared/wechat-channel';

// The packaged app disables the cloud bridge in isolated profiles. Supply a
// synthetic state to the two cloud settings handlers only after checking the app
// and its isolated directory, then exercise the packaged renderer and preload.
// eslint-disable-next-line no-empty-pattern
test('packaged WeChat consent defaults off and keeps the other assistant settings', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-rich-consent-')));
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
      account_name: 'Fixture bot', targets: { private: { title: 'Fixture owner' }, group: { title: 'Fixture group' } },
    });
    await writePrivate(join(listener, 'owner.json'), {
      account: 'Fixture bot', title: 'Fixture owner', fingerprint: 'a'.repeat(64), group_fingerprints: ['b'.repeat(64)],
    });

    app = await electron.launch({ executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
    await expect.poll(() => app!.windows().some(page => page.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await writePrivate(join(listener, 'status.json'), {
      state: 'running', heartbeat_at: Date.now() / 1_000, pid: process.pid,
      private: 'ready', group: 'ready', pending: 0, uncertain: 0, group_policy_version: 4,
    });
    expect(await page.evaluate(async () => (await window.deskpet.wechat.getCloud()).available)).toBe(false);

    const assistant: WeChatAssistant = { enabled: false, memories: 'all', moments: true };
    const cloud: WeChatCloudState = {
      available: true, assistant, groupRules: {}, providers: [],
      settings: { private: null, groups: { legacy: { providerId: '00000000-0000-4000-8000-000000000001', model: 'fixture-model' } } },
    };
    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic handler refused outside the expected isolated packaged app');
      }
      let state = fixture.cloud;
      ipcMain.removeHandler('wechat:get-cloud');
      ipcMain.removeHandler('wechat:configure-assistant');
      ipcMain.handle('wechat:get-cloud', () => state);
      ipcMain.handle('wechat:configure-assistant', (_event, { payload }: { payload: WeChatAssistant }) => {
        if (typeof payload.richCloud !== 'boolean' && typeof payload.forwardCloud !== 'boolean') throw new Error('Expected an explicit consent choice');
        state = { ...state, assistant: { ...state.assistant, ...payload } };
        return state;
      });
    }, { asar, profile, executable, root, cloud });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    const openConsent = async () => {
      await expect(page.locator('.app-shell')).toBeVisible();
      await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: '微信通道', exact: true }).click();
      return page.getByRole('checkbox', { name: '允许将详细消息内容发送给云端模型。' });
    };
    let consent = await openConsent();
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();
    const forwardConsent = page.getByRole('checkbox', { name: '允许云端模型回答转发记录里的问题。' });
    await expect(forwardConsent).not.toBeChecked();
    expect(await page.evaluate(async () => (await window.deskpet.wechat.getCloud()).assistant)).toEqual(assistant);
    await consent.click();
    await expect(consent).toBeChecked();
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getCloud()).assistant))
      .toEqual({ ...assistant, richCloud: true });
    await expect(forwardConsent).not.toBeChecked();
    await forwardConsent.click();
    await expect(forwardConsent).toBeChecked();

    await page.reload();
    consent = await openConsent();
    await expect(consent).toBeChecked();
    await consent.click();
    await expect(consent).not.toBeChecked();
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechat.getCloud()).assistant))
      .toEqual({ ...assistant, richCloud: false, forwardCloud: true });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
