import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionJournal } from '../../src/main/domain/companion-journal';
import { createDefaultState } from '../../src/main/domain/schemas';
import { DomainRepository } from '../../src/main/domain/repository';

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

for (const failure of ['diary.noCloud', 'provider.modelUnavailable'] as const) {
  // eslint-disable-next-line no-empty-pattern
  test(`the real diary scheduler reports ${failure} to Doctor`, async ({}, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-diary-failure-'));
    const profile = join(root, 'profile'), key = Buffer.alloc(32, 21), prefix = 'SYNTHETIC_JOURNAL_WRAP:';
    const vault = { getVaultKey: async () => key };
    const requests: string[] = [];
    const server = createServer((request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[{"id":"fixture-retired:cloud"}]}');
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body) as { model?: string; messages?: { role: string; content?: string }[] };
        if (payload.messages?.some(message => message.role === 'system' && message.content?.includes('Write a short private diary'))) {
          requests.push(String(payload.model));
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":{"code":"model_not_found","message":"Synthetic fixture model unavailable"}}');
      });
    });
    let application: ElectronApplication | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture did not bind a loopback port.');
      for (const directory of ['vault', 'qq-channel-vault']) {
        await mkdir(join(profile, directory), { recursive: true, mode: 0o700 });
        await writeFile(join(profile, directory, 'vault-key.safe'), prefix + key.toString('base64'), { mode: 0o600 });
      }
      const repository = new DomainRepository(join(profile, 'profile.enc.json'), vault);
      await repository.initialize();
      const journal = new CompanionJournal(join(profile, 'diary.enc.json'), vault);
      await journal.initialize(); await journal.configure({ ...journal.preferences(), diaryEnabled: true }); await journal.shutdown();
      const sessionId = randomUUID(), stamp = '2026-11-14T12:00:00.000Z';
      await repository.transaction(state => {
        state.memorySleep.settings = { enabled: false, hour: 3, timezone: 'UTC' };
        state.autoMemory.enabled = false;
        state.chatSessions.push({ id: sessionId, kind: 'normal', companionScope: 'owner', title: 'Synthetic diary owner', createdAt: stamp, updatedAt: stamp });
        state.chatMessages.push({ id: randomUUID(), sessionId, role: 'user', content: '合成日记来源。', status: 'complete', errorCode: null, createdAt: stamp,
          contextTrace: { version: 1, lineage: 'complete', memoryReferences: [], historyMessageIds: [], scope: { kind: 'global' }, privacy: 'cloud-allowed' } });
        if (failure === 'provider.modelUnavailable') {
          const id = randomUUID();
          state.providers.push({ id, kind: 'ollama', name: 'Synthetic local transport', model: 'fixture-retired:cloud',
            baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, supportsTools: false, secretState: 'missing', contextWindowTokens: 16_384 });
          state.providerCredentialRefs[id] = randomUUID();
        }
      });
      const entry = join(root, 'boot.cjs');
      await writeFile(entry, [
        'const {safeStorage,Notification} = require("electron"); Notification.isSupported=()=>false;',
        `const prefix=${JSON.stringify(prefix)}; safeStorage.isEncryptionAvailable=()=>true;`,
        'safeStorage.encryptString=value=>Buffer.from(prefix+value); safeStorage.decryptString=bytes=>{const value=bytes.toString(); if(!value.startsWith(prefix)) throw Error("Wrong fixture wrapper"); return value.slice(prefix.length);};',
        'const OriginalDate=Date; const clock=OriginalDate.parse("2026-11-15T03:01:00Z");',
        'global.Date=new Proxy(OriginalDate,{construct:(Ctor,args)=>Reflect.construct(Ctor,args.length?args:[clock]),get:(Ctor,key)=>key==="now"?()=>clock:Reflect.get(Ctor,key)});',
        'const interval=global.setInterval; global.setInterval=(callback,ms,...args)=>interval(callback,ms===30000?250:ms,...args);',
        `require(${JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js'))});`,
      ].join('\n'));
      application = await electron.launch({ args: [entry], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
      await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
      const page = application.windows().find(window => window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible();
      await expect.poll(() => page.evaluate(async () =>
        (await window.deskpet.attention.health!()).items.find(item => item.feature === 'diary')?.errorCode)).toBe(failure);
      const diaryRequests = [...requests];
      expect(diaryRequests).toEqual(failure === 'diary.noCloud' ? [] : ['fixture-retired:cloud']);
      await page.evaluate(async () => {
        await window.deskpet.app.setLocale('zh-CN');
        await window.deskpet.attention.setDoctor!(true);
        await window.deskpet.attention.checkDoctor!();
      });
      await page.reload();
      await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
      await page.getByRole('tab', { name: '医生', exact: true }).click();
      const explanation = failure === 'diary.noCloud' ? '日记需要当前选中的云端模型服务。' : '这个账号用不了这个模型。';
      const doctor = page.locator('.doctor-panel');
      await expect(doctor.getByText(failure, { exact: true })).toBeVisible();
      await expect(doctor.getByText(new RegExp(`日记.*${explanation}`, 'u'))).toBeVisible();
      await doctor.screenshot({ path: testInfo.outputPath(`${failure}.png`) });
      await writeFile(testInfo.outputPath(`${failure}.json`), JSON.stringify({ failure, diaryRequests }, null, 2));
    } finally {
      await application?.close();
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
