import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WeChatInboxItem } from '../../src/shared/wechat-inbox';

// Mock only the inbox IPC boundary of the verified isolated packaged app.
// The encrypted repository and owner isolation are covered in wechat-inbox.test.ts.
// eslint-disable-next-line no-empty-pattern
test('packaged Memory inbox lists, searches, and deletes saved items', async ({}) => {
  test.skip(process.platform !== 'darwin' || !process.env.DESKPET_PACKAGED_APP, 'An exact packaged macOS executable is required.');
  test.setTimeout(120_000);
  const executable = await realpath(process.env.DESKPET_PACKAGED_APP!);
  const asar = resolve(dirname(executable), '../Resources/app.asar');
  const expectedSHA = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  expect(expectedSHA).toMatch(/^[a-f0-9]{64}$/u);
  expect(createHash('sha256').update(await readFile(asar)).digest('hex')).toBe(expectedSHA);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-wechat-inbox-packaged-')));
  const profile = join(root, 'profile');
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key]!;
  const items: WeChatInboxItem[] = [
    { id: 'a'.repeat(64), kind: 'link', title: 'Fixture article', summary: 'Fixture reading summary.',
      source: 'Fixture chat', at: Date.UTC(2026, 0, 1), url: 'https://example.invalid/article' },
    { id: 'b'.repeat(64), kind: 'file', title: 'Fixture file', summary: 'A synthetic Markdown attachment.',
      source: 'Fixture chat', at: Date.UTC(2026, 0, 2) },
  ];

  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }), { mode: 0o600 });
    app = await electron.launch({ executablePath: executable, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
    await expect.poll(() => app!.windows().some(page => page.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await app.evaluate(({ app, ipcMain }, fixture) => {
      if (!app.isPackaged || app.getAppPath() !== fixture.asar || app.getPath('userData') !== fixture.profile
        || process.execPath !== fixture.executable || !process.argv.includes(`--deskpet-isolated-profile=${fixture.root}`)) {
        throw new Error('Synthetic inbox refused outside the expected isolated packaged app');
      }
      let inbox = fixture.items;
      ipcMain.removeHandler('wechat-inbox:list');
      ipcMain.removeHandler('wechat-inbox:remove');
      ipcMain.handle('wechat-inbox:list', (_event, { payload }: { payload: { query: string } }) =>
        inbox.filter(item => item.title.toLowerCase().includes(payload.query.toLowerCase())));
      ipcMain.handle('wechat-inbox:remove', (_event, { payload }: { payload: { id: string } }) => {
        if (!inbox.some(item => item.id === payload.id)) throw new Error('No matching synthetic fixture');
        inbox = inbox.filter(item => item.id !== payload.id);
      });
    }, { root, executable, profile, asar, items });

    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '记忆', exact: true }).click();
    await page.getByRole('tab', { name: '收件箱', exact: true }).click();
    const inbox = page.getByRole('tabpanel', { name: '收件箱', exact: true });
    await expect(inbox.getByRole('heading', { name: 'Fixture article' })).toBeVisible();
    await expect(inbox.getByText('https://example.invalid/article')).toBeVisible();
    await inbox.getByRole('searchbox', { name: '搜索收件箱' }).fill('file');
    await inbox.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(inbox.getByRole('heading', { name: 'Fixture file' })).toBeVisible();
    await expect(inbox.getByRole('heading', { name: 'Fixture article' })).toHaveCount(0);
    await inbox.getByRole('button', { name: '删除 Fixture file' }).click();
    await expect(inbox.getByText('没有匹配的条目。')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.wechatInbox!.list('')).map(item => item.title)))
      .toEqual(['Fixture article']);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
