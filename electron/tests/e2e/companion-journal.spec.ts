import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionJournal } from '../../src/main/domain/companion-journal';
import { createDefaultState } from '../../src/main/domain/schemas';

// Synthetic encryption wrapper is installed before app startup. No real
// Keychain/profile/model is involved; the diary store, IPC and editor are real.
// eslint-disable-next-line no-empty-pattern
test('a generated encrypted diary is editable, survives restart, and can be deleted through the bilingual settings UI', async ({}) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'deskpet-journal-e2e-')), profile = join(root, 'profile'), key = Buffer.alloc(32, 19);
  const path = join(profile, 'diary.enc.json'), diary = new CompanionJournal(path, { getVaultKey: async () => key });
  const state = createDefaultState(), sessionId = randomUUID(), stamp = '2026-11-14T12:00:00.000Z';
  state.chatSessions.push({ id: sessionId, kind: 'normal', companionScope: 'owner', title: 'Synthetic owner', createdAt: stamp, updatedAt: stamp });
  state.chatMessages.push({ id: randomUUID(), sessionId, role: 'user', content: '今天完成了测试。', status: 'complete', errorCode: null, createdAt: stamp,
    contextTrace: { version: 1, lineage: 'complete', memoryReferences: [], historyMessageIds: [], scope: { kind: 'global' }, privacy: 'cloud-allowed' } });
  await mkdir(join(profile, 'qq-channel-vault'), { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'qq-channel-vault/vault-key.safe'), 'SYNTHETIC_JOURNAL_WRAP:' + key.toString('base64'), { mode: 0o600 });
  await diary.initialize(); await diary.configure({ ...diary.preferences(), diaryEnabled: true });
  await diary.tick({ now: Date.parse('2026-11-15T03:01:00Z'), timezone: 'UTC', available: () => true, state: () => state, suppressed: () => false,
    complete: async () => ({ text: '今天听到主人完成了测试，我也很开心。', summary: '主人完成了测试。' }) });
  await diary.configure({ ...diary.preferences(), diaryEnabled: false }); await diary.shutdown();
  const entry = join(root, 'boot.cjs');
  await writeFile(entry, `const {safeStorage}=require('electron'); safeStorage.isEncryptionAvailable=()=>true;
safeStorage.encryptString=value=>Buffer.from('SYNTHETIC_JOURNAL_WRAP:'+value);
safeStorage.decryptString=bytes=>{const value=bytes.toString();if(!value.startsWith('SYNTHETIC_JOURNAL_WRAP:'))throw Error('Wrong fixture wrapper');return value.slice(23);};
require(${JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js'))});`);
  let application: ElectronApplication | undefined, page: Page;
  const launch = async () => {
    application = await electron.launch({ args: [entry], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN')); await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '陪伴', exact: true }).click(); await page.getByRole('tab', { name: '日记', exact: true }).click();
  };
  try {
    await launch();
    await expect(page!.getByRole('checkbox', { name: '每晚写日记', exact: true })).not.toBeChecked();
    await page!.getByRole('button', { name: '2026-11-14', exact: true }).click();
    await expect(page!.getByRole('textbox', { name: '日记正文' })).toHaveValue('今天听到主人完成了测试，我也很开心。');
    await page!.getByRole('textbox', { name: '日记正文' }).fill('合成编辑：明天也慢慢来。'); await page!.getByRole('button', { name: '保存日记' }).click();
    await expect(page!.getByRole('article', { name: '编辑日记' })).toHaveCount(0);
    expect(await readFile(path, 'utf8')).not.toContain('合成编辑');
    await application!.close(); application = undefined; await launch();
    await page!.getByRole('button', { name: '2026-11-14', exact: true }).click(); await expect(page!.getByRole('textbox', { name: '日记正文' })).toHaveValue('合成编辑：明天也慢慢来。');
    await page!.getByRole('button', { name: '删除日记' }).click(); await expect(page!.getByRole('button', { name: '2026-11-14', exact: true })).toHaveCount(0);
    expect(await page!.evaluate(() => window.deskpet.journal!.list())).toEqual([]);
    await page!.evaluate(() => window.deskpet.app.setLocale('en')); await page!.reload(); await expect(page!.locator('.app-shell')).toBeVisible();
    await page!.locator('nav').getByRole('button', { name: 'Companion', exact: true }).click(); await page!.getByRole('tab', { name: 'Diary', exact: true }).click();
    await expect(page!.getByRole('checkbox', { name: 'Write a nightly diary' })).not.toBeChecked();
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});
