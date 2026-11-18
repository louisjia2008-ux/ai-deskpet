import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGOw6bnznxLMMGrAqAGjBgwXAwAf1qMf4q4HQgAAAABJRU5ErkJggg==', 'base64');
interface PackagedIdentity { isPackaged: boolean; appPath: string; userData: string; executable: string }

/** Opt in with an exact signed bundle and digest. This never opens a daily
 * profile or configures a provider; all imported pixels are synthetic. */
// eslint-disable-next-line no-empty-pattern
test('signed packaged app imports, renders and reloads a managed attachment in its marked isolated profile', async ({}) => {
  test.skip(!process.env.DESKPET_PACKAGED_APP, 'An exact packaged executable is required.');
  test.setTimeout(1_800_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA256 = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA256).toMatch(/^[a-f0-9]{64}$/u);
  expect(digest(await readFile(asar))).toBe(expectedSHA256);
  const evidence = resolve(process.env.DESKPET_MEDIA_EVIDENCE_DIR ?? 'test-results/packaged-media'); await mkdir(evidence, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-media-packaged-'))), fixtureImage = join(root, '合成收到.png');
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await writeFile(fixtureImage, syntheticPng);
  let application: ElectronApplication | undefined, page: Page | undefined, identity: PackagedIdentity | undefined, succeeded = false;
  const checks: string[] = [];
  try {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    application = await electron.launch({ executablePath: executable, args: ['--deskpet-isolated-profile=' + root, '--use-mock-keychain'], env, timeout: 55_000 });
    identity = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), executable: process.execPath }));
    expect(identity).toEqual({ isPackaged: true, appPath: asar, userData: join(root, 'profile'), executable }); checks.push('packaged-exact-identity-and-isolated-userData');
    await application.evaluate(({ dialog, net }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      const original = net.fetch.bind(net);
      const state = globalThis as typeof globalThis & { __packagedMediaNetwork: string[] }; state.__packagedMediaNetwork = [];
      net.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).protocol === 'file:') return original(input, options);
        state.__packagedMediaNetwork.push(url); return Promise.reject(Error('Packaged media smoke does not use a network service'));
      };
    }, fixtureImage);
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN')); await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '工具', exact: true }).click(); await page.getByRole('tab', { name: '表情图库', exact: true }).click();
    await page.getByRole('button', { name: '导入图片', exact: true }).click();
    await expect(page.getByText('已导入 1 张，复用 0 张，跳过 0 个文件。')).toBeVisible();
    const assetId = digest(syntheticPng), localUrl = `deskpet://managed/reply-images/${assetId}.png`;
    const rendered = async (selector: string): Promise<void> => {
      const image = page!.locator(selector); await expect(image).toHaveAttribute('src', localUrl);
      await expect.poll(() => image.evaluate(element => { const actual = element as unknown as { complete: boolean; naturalWidth: number }; return actual.complete && actual.naturalWidth; })).toBe(16);
    };
    await rendered('.media-card img'); checks.push('native-dialog-import-and-protocol-image-decode');
    await page.screenshot({ path: join(evidence, 'packaged-library.png'), scale: 'css' });
    await page.getByRole('article', { name: '合成收到', exact: true }).getByRole('button', { name: '放入当前对话' }).click();
    await rendered('.message.user .chat-images img'); checks.push('manual-chat-attachment-render');
    const sessions = await page.evaluate(() => window.deskpet.chat.listSessions()), session = sessions.find(item => item.title === '图片对话'); expect(session).toBeTruthy();
    const messages = await page.evaluate(id => window.deskpet.chat.listMessages(id), session!.id);
    expect(messages.at(-1)).toMatchObject({ role: 'user', attachments: [{ assetId, alt: '合成收到' }] });
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible(); await rendered('.message.user .chat-images img'); checks.push('attachment-preserved-after-renderer-reload');
    await page.screenshot({ path: join(evidence, 'packaged-chat-attachment.png'), scale: 'css' });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __packagedMediaNetwork: string[] }).__packagedMediaNetwork)).toEqual([]); checks.push('no-provider-or-channel-network-calls');
    expect(digest(await readFile(asar))).toBe(expectedSHA256); checks.push('asar-unchanged-after-test');
    succeeded = true;
  } finally {
    await writeFile(join(evidence, 'packaged-smoke-receipt.json'), JSON.stringify({ succeeded, scope: 'Exact signed packaged Electron in a marked disposable profile; synthetic PNG only; no daily data or API credentials.',
      expectedASARSHA256: expectedSHA256, observedASARSHA256: digest(await readFile(asar)), isolatedRoot: root, identity, checks }, null, 2));
    if (!succeeded && page) await page.screenshot({ path: join(evidence, 'packaged-smoke-failure.png'), scale: 'css' }).catch(() => undefined);
    await application?.close().catch(() => undefined);
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
});
