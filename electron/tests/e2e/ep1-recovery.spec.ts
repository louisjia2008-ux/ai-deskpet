import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FileSystem from 'node:fs';
import type * as Crypto from 'node:crypto';
import type * as Path from 'node:path';
import type { PersistentState } from '../../src/main/domain/schemas';

interface RequestBody { model: string; messages: Array<{ role: string; content: string }> }
interface WireRecord { path: string; body: string; bodySHA256: string; receivedAt: string; response: string }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const password = 'synthetic-ep1-recovery-password';
const a = 'RECOVERY_OLD_FACT_A_20261028';
const b = 'RECOVERY_CORRECTED_FACT_B_20261028';
const c = 'RECOVERY_INDEPENDENT_FACT_C_20261028';
const pendingFact = 'RECOVERY_PENDING_IMPORT_20261028';
const replacement = 'RECOVERY_LATE_CORRECTION_MUST_NOT_APPLY_20261028';
const unknownCorrection = 'RECOVERY_ORDINARY_CORRECTION_STILL_UNKNOWN_20261028';
const evidenceRoot = join(process.cwd(), '..', '..', 'output', 'deskpet-electron-p1-closeout-20261028', 'recovery-gui');

const harness = async (name: string, info: TestInfo) => {
  const temporary = await mkdtemp(join(tmpdir(), 'deskpet-ep1-recovery-gui-'));
  const profile = join(temporary, 'profile'); const archive = join(temporary, 'synthetic.deskpet-backup');
  const output = join(evidenceRoot, `${name}-${new Date().toISOString().replace(/[^0-9]/gu, '')}`);
  await mkdir(output, { recursive: true });
  const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
  const wires: WireRecord[] = []; const launches: unknown[] = []; const checkpoints: unknown[] = []; const order: unknown[] = [];
  let application: ElectronApplication | undefined; let page!: Page; let passed = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let result: string;
      if (!request.url?.endsWith('/chat/completions')) {
        result = request.url?.endsWith('/api/show')
          ? JSON.stringify({ model_info: { 'fixture.context_length': 8192 } })
          : JSON.stringify({ data: [{ id: 'fixture', object: 'model', owned_by: 'synthetic-recorder' }] });
        response.writeHead(200, { 'content-type': 'application/json' });
      } else {
        const parsed = JSON.parse(body) as RequestBody;
        let content = 'Fresh synthetic chat works without recalled memories.';
        if (parsed.messages[0]?.content.startsWith('Analyze chat samples')) {
          const selected = JSON.parse(parsed.messages[1]!.content) as { samples: Array<{ id: string }> };
          content = JSON.stringify({ style: { tone: 'neutral', length: 'brief', sentences: 'short', emoji: 'none', phrases: [] },
            memories: [{ text: pendingFact, evidenceIds: [selected.samples[0]!.id] }] });
        }
        result = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
      }
      wires.push({ path: request.url ?? '', body, bodySHA256: digest(body), receivedAt: new Date().toISOString(), response: result });
      response.end(result);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const persist = async (failure?: unknown): Promise<void> => {
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ name, verdict: passed ? 'PASS' : failure ? 'FAIL' : 'RUNNING',
      failure: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure,
      profile, entry, mainBundleSHA256: digest(await readFile(entry)), launches, syntheticInputs: { a, b, c, pendingFact, replacement, unknownCorrection },
      order, checkpoints, wires, normalProductionSecuritySettings: true, providerUtilityBypassed: false, actualModelCalls: 0,
      testSource: { path: join(process.cwd(), 'tests/e2e/ep1-recovery.spec.ts'), sha256: digest(await readFile(join(process.cwd(), 'tests/e2e/ep1-recovery.spec.ts'))) } }, null, 2));
  };
  const launch = async (recovery = false): Promise<void> => {
    application = await electron.launch({ args: [entry], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    const preferences = await application.evaluate(({ app, dialog, BrowserWindow }, paths) => {
      if (app.getPath('userData') !== paths.profile || app.isPackaged) throw new Error('Wrong recovery fixture identity');
      app.relaunch = () => undefined;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.archive });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.archive] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      return { pid: process.pid, userData: app.getPath('userData'), isPackaged: app.isPackaged,
        noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), windows: BrowserWindow.getAllWindows().map((window) => {
          const contents = window.webContents as typeof window.webContents & { getLastWebPreferences(): Electron.WebPreferences };
          const value = contents.getLastWebPreferences();
          return { url: window.webContents.getURL(), sandbox: value.sandbox, nodeIntegration: value.nodeIntegration,
            contextIsolation: value.contextIsolation, webSecurity: value.webSecurity };
        }) };
    }, { profile, archive });
    expect(preferences.noSandboxSwitch).toBe(false);
    for (const window of preferences.windows) expect(window).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
    if (recovery) {
      await expect(page.locator('.startup-recovery')).toBeVisible();
      await expect(page.locator('.app-shell')).toHaveCount(0);
      launches.push({ recovery, preferences });
    } else {
      await expect(page.locator('.app-shell')).toBeVisible();
      await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const diagnostics = await page.evaluate(() => window.deskpet.app.getDiagnostics());
      expect(diagnostics.runtimeIdentity?.dataDirectory).toBe(profile);
      expect(diagnostics.runtimeIdentity?.mainBundleSHA256).toBe(digest(await readFile(entry)));
      launches.push({ recovery, preferences, diagnostics });
    }
    order.push({ action: recovery ? 'launch-startup-recovery' : 'launch-normal-app', pid: preferences.pid });
    await persist();
  };
  const stop = async (): Promise<void> => { await application?.close(); application = undefined; order.push({ action: 'stop-owned-app' }); };
  const settings = async (): Promise<void> => {
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Privacy and data' }).click();
  };
  const newChat = async (): Promise<void> => { await page.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click(); };
  const send = async (text: string, status: 'complete' | 'failed' = 'complete'): Promise<void> => {
    const before = await page.locator('.message.assistant').count();
    await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(before + 1);
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', status);
    order.push({ action: 'gui-chat', text, expectedStatus: status });
  };
  const configure = async (): Promise<string> => {
    const id = randomUUID();
    await page.evaluate(async (config) => { await window.deskpet.providers.upsert(config); await window.deskpet.providers.select(config.id); }, {
      id, kind: 'ollama' as const, name: 'Synthetic E-P1 recovery fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      enabled: true, supportsTools: false, localExecutionConfirmed: true,
    });
    return id;
  };
  const snapshot = async (label: string, staged = false): Promise<PersistentState> => {
    const relative = staged ? join('recovery', JSON.parse(await readFile(join(profile, 'restore-pending.json'), 'utf8')).id as string, 'incoming', 'profile.enc.json') : 'profile.enc.json';
    const state = await application!.evaluate(({ app, safeStorage }, relative) => {
      const fs = process.getBuiltinModule('fs') as typeof FileSystem;
      const crypto = process.getBuiltinModule('crypto') as typeof Crypto;
      const path = process.getBuiltinModule('path') as typeof Path;
      const envelope = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), relative), 'utf8'));
      const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(path.join(app.getPath('userData'), 'vault', 'vault-key.safe'))), 'base64');
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString()) as PersistentState;
      } finally { key.fill(0); }
    }, relative);
    await copyFile(join(profile, relative), join(output, `${label}.enc.json`));
    await writeFile(join(output, `${label}.state.json`), JSON.stringify(state, null, 2));
    checkpoints.push({ label, staged, state, encryptedSnapshotSHA256: digest(await readFile(join(profile, relative))) });
    await persist(); return state;
  };
  const backup = async (): Promise<void> => {
    await settings();
    await page.getByLabel('Backup password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password for a new backup').fill(password);
    await page.getByRole('button', { name: 'Create encrypted backup' }).click();
    await expect(page.getByText('Encrypted backup saved', { exact: true })).toBeVisible();
    await copyFile(archive, join(output, 'original.deskpet-backup'));
    order.push({ action: 'gui-create-backup', archiveSHA256: digest(await readFile(archive)) });
  };
  const restart = async (): Promise<void> => {
    const child = application!.process();
    await page.getByRole('button', { name: /Restart and restore|重启并恢复/ }).click();
    await expect.poll(() => child.exitCode, { timeout: 30_000 }).toBe(0); application = undefined;
    order.push({ action: 'gui-restart-and-restore', stoppedPID: child.pid }); await launch();
  };
  const screenshot = async (name: string): Promise<void> => { await page.screenshot({ path: join(output, `${name}.png`), fullPage: true }); };
  const finish = async (): Promise<void> => { passed = true; await persist(); await info.attach('recovery-evidence', { path: join(output, 'evidence.json'), contentType: 'application/json' }); };
  const clean = async (failure?: unknown): Promise<void> => {
    if (failure) { try { await screenshot('failure'); } catch { /* Owned process may already be stopped. */ } await persist(failure); }
    await stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (passed) await rm(temporary, { recursive: true, force: true });
  };
  return { launch, stop, settings, newChat, send, configure, snapshot, backup, restart, screenshot, finish, clean,
    page: () => page, app: () => application!, profile, output, wires, order, checkpoint: (value: unknown) => checkpoints.push(value) };
};

// eslint-disable-next-line no-empty-pattern
test('quarantines old backup memories through real corrupt-profile recovery and rejects restored old intents before final HTTP', async ({}, info) => {
  test.setTimeout(180_000); const h = await harness('corrupt-authority', info); let failure: unknown;
  try {
    await h.launch(); const providerId = await h.configure(); await h.newChat();
    await h.send(`请记住：${a}`); await h.send(`请记住：${c}`);
    const fact = (await h.page().evaluate(() => window.deskpet.memory.list())).find((memory) => memory.text === a)!; expect(fact).toBeTruthy();
    await h.newChat(); await h.send(`把“RECOVERY”改成“${replacement}”`);
    await expect(h.page().locator('.memory-edit .memory-forget-choices li')).toHaveCount(2);
    const choiceSession = await h.page().locator('.session-control select').inputValue();
    const pending = await h.page().evaluate(async ({ providerId, pendingFact }) => {
      const preview = await window.deskpet.imports.preview({ name: 'Synthetic pending source.txt', text: `FixtureSpeaker: ${pendingFact}` });
      const record = await window.deskpet.imports.savePreview(preview.id);
      return window.deskpet.imports.distill({ id: record.id, speakerId: record.messages[0]!.speakerId, isUser: false,
        messageIds: [record.messages[0]!.id], providerId });
    }, { providerId, pendingFact });
    expect(pending.draft?.memories).toHaveLength(1); expect(pending.draft?.memories[0]?.savedMemoryId).toBeNull();
    await h.snapshot('before-backup'); await h.backup();
    await h.newChat(); await h.send(`把“${a}”改成“${b}”`); await expect(h.page().locator('.memory-edit')).toContainText(b);
    await h.send(`忘记：${b}`); expect((await h.page().evaluate(() => window.deskpet.memory.list())).some((memory) => memory.id === fact.id)).toBe(false);
    const protectedState = await h.snapshot('corrected-then-deleted');
    expect(protectedState.memoryTombstones.some((guard) => guard.memoryId === fact.id && guard.kind === 'deleted')).toBe(true);
    await h.stop(); await writeFile(join(h.profile, 'profile.enc.json'), '{SYNTHETIC_CURRENT_AUTHORITY_UNREADABLE');
    h.order.push({ action: 'corrupt-stopped-owned-profile', originalProtectedSnapshot: 'corrected-then-deleted.enc.json' });
    await h.launch(true);
    await expect(h.page().locator('.startup-recovery')).toContainText(/pending review|待复核/);
    await h.screenshot('startup-protection-unavailable');
    await h.page().getByLabel(/Backup password|备份密码/, { exact: true }).fill(password);
    await h.page().getByRole('button', { name: /Restore backup|恢复备份/, exact: true }).click();
    await expect(h.page().getByRole('button', { name: /Restart and restore|重启并恢复/ })).toBeVisible();
    const staged = await h.snapshot('prepared-unknown-protection', true);
    expect(staged.memories.find((memory) => memory.id === fact.id)?.contextMetadata).toMatchObject({ trust: 'unverified', reviewReason: 'protection-unknown' });
    await h.screenshot('recovery-prepared'); await h.restart();
    const restored = await h.snapshot('new-process-restored-pending');
    expect(restored.memories.find((memory) => memory.id === fact.id)?.contextMetadata).toMatchObject({ trust: 'unverified', reviewReason: 'protection-unknown' });
    expect((await readdir(h.profile)).some((name) => name.startsWith('profile.enc.json.corrupt-'))).toBe(true);
    await h.page().locator('nav').getByRole('button', { name: 'Memory', exact: true }).click();
    const row = h.page().locator(`[data-memory-id="${fact.id}"]`); await expect(row).toContainText(a);
    await row.locator('summary').click(); await expect(row).toContainText('Existing source is unverified'); await h.screenshot('restored-memory-pending-review');
    await h.page().locator(`[data-session-id="${choiceSession}"] .session-item`).click();
    await h.page().getByRole('listitem', { name: a, exact: true }).getByRole('button', { name: 'Replace this memory' }).click();
    await expect(h.page().locator('.memory-edit').getByRole('alert')).toContainText('This choice has changed');
    await h.screenshot('restored-old-correction-rejected');
    await h.page().locator('nav').getByRole('button', { name: 'Memory', exact: true }).click();
    await h.page().getByRole('tab', { name: 'WeChat import & voice' }).click();
    await h.page().getByRole('combobox', { name: /Imported records/ }).selectOption(pending.id);
    await h.page().locator('.import-fact').getByRole('checkbox', { name: 'Save this memory' }).check();
    await h.page().getByRole('button', { name: 'Apply selected memories and voice' }).click();
    await expect(h.page().locator('.conversation-imports').getByRole('alert')).toContainText('no longer current');
    await h.screenshot('restored-old-import-rejected');
    const afterRejected = await h.snapshot('after-rejected-old-intents');
    expect(afterRejected.memories).toEqual(restored.memories);
    await h.newChat(); const beforeOrdinaryCorrection = h.wires.length;
    await h.send(`把“${a}”改成“${unknownCorrection}”`, 'failed');
    await expect(h.page().getByRole('alert')).toContainText('could not be updated');
    expect(h.wires.length).toBe(beforeOrdinaryCorrection);
    const afterOrdinaryCorrection = await h.snapshot('ordinary-unknown-correction-rejected');
    expect(afterOrdinaryCorrection.memories).toEqual(restored.memories);
    await h.screenshot('ordinary-unknown-correction-rejected');
    const beforeFresh = h.wires.length; await h.newChat(); await h.send('Give a short synthetic answer for this independent fresh chat.');
    const final = h.wires.slice(beforeFresh).filter((wire) => wire.path.endsWith('/chat/completions')); expect(final).toHaveLength(1);
    for (const marker of [a, b, c, pendingFact, replacement, unknownCorrection]) expect(final[0]!.body).not.toContain(marker);
    const finalState = await h.snapshot('fresh-chat-final-state');
    const receipt = finalState.chatMessages.flatMap((message) => message.requestReceipts ?? []).find((item) => item.expectedBodySHA256 === final[0]!.bodySHA256);
    expect(receipt).toMatchObject({ phase: 'terminal', contextTrace: { memoryReferences: [] } });
    await h.screenshot('fresh-chat-without-unknown-memory');
    h.checkpoint({ scenario: 'corrupt-authority', restoredOldChoiceRejected: true, restoredImportDraftRejected: true, ordinaryUnknownCorrectionRejected: true, freshChatWorks: true,
      finalBodySHA256: final[0]!.bodySHA256, finalReceipt: receipt, beforeCorruptionDeletion: protectedState.memoryTombstones });
    await h.finish();
  } catch (error) { failure = error; throw error; } finally { await h.clean(failure); }
});

// eslint-disable-next-line no-empty-pattern
test('preserves readable newer deletion guards through Settings restore and excludes deleted data after restart while independent memory remains usable', async ({}, info) => {
  test.setTimeout(150_000); const h = await harness('readable-authority', info); let failure: unknown;
  try {
    await h.launch(); await h.configure(); await h.newChat(); await h.send(`请记住：${a}`); await h.send(`请记住：${c}`);
    const original = await h.snapshot('original'); const fact = original.memories.find((memory) => memory.text === a)!;
    await h.backup(); await h.newChat(); await h.send(`把“${a}”改成“${b}”`); await h.send(`忘记：${b}`);
    const deleted = await h.snapshot('newer-correction-and-deletion');
    expect(deleted.memories.some((memory) => memory.id === fact.id)).toBe(false);
    await h.settings(); await h.page().getByText('Restore from a backup', { exact: true }).click();
    await h.page().getByLabel('This backup’s password', { exact: true }).fill(password);
    await h.page().getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(h.page().getByRole('alertdialog')).toContainText('Readable deletion and correction records'); await h.screenshot('settings-protection-preserved');
    const staged = await h.snapshot('prepared-readable-protection', true);
    expect(staged.memories.some((memory) => memory.id === fact.id)).toBe(false);
    expect(staged.memoryTombstones).toEqual(deleted.memoryTombstones);
    await h.restart(); const restored = await h.snapshot('new-process-readable-protection');
    expect(restored.memories.some((memory) => memory.id === fact.id)).toBe(false);
    expect(restored.memoryTombstones).toEqual(deleted.memoryTombstones);
    const before = h.wires.length; await h.newChat(); await h.send('Give a short synthetic answer and consider the remaining independent saved context.');
    const final = h.wires.slice(before).filter((wire) => wire.path.endsWith('/chat/completions')); expect(final).toHaveLength(1);
    expect(final[0]!.body).not.toContain(a); expect(final[0]!.body).not.toContain(b); expect(final[0]!.body).toContain(c);
    const state = await h.snapshot('readable-final-state');
    const receipt = state.chatMessages.flatMap((message) => message.requestReceipts ?? []).find((item) => item.expectedBodySHA256 === final[0]!.bodySHA256);
    expect(receipt).toMatchObject({ phase: 'terminal' }); expect(receipt?.contextTrace.memoryReferences).toHaveLength(1);
    await h.screenshot('readable-restore-final-http');
    h.checkpoint({ scenario: 'readable-authority', guardsPreserved: true, finalBodySHA256: final[0]!.bodySHA256, finalReceipt: receipt });
    await h.finish();
  } catch (error) { failure = error; throw error; } finally { await h.clean(failure); }
});

// eslint-disable-next-line no-empty-pattern
test('restoring a backup with a newer deletion never appends the older current corrected row around that deletion', async ({}, info) => {
  test.setTimeout(150_000); const h = await harness('backup-newer-deletion', info); let failure: unknown;
  try {
    await h.launch(); await h.configure(); await h.newChat(); await h.send(`请记住：${a}`); await h.send(`请记住：${c}`);
    const fact = (await h.page().evaluate(() => window.deskpet.memory.list())).find((memory) => memory.text === a)!;
    await h.send(`把“${a}”改成“${b}”`); const corrected = await h.snapshot('older-current-correction');
    expect(corrected.memories.find((memory) => memory.id === fact.id)?.text).toBe(b);
    const olderCorrectionBytes = await readFile(join(h.profile, 'profile.enc.json'));
    await h.send(`忘记：${b}`); const deleted = await h.snapshot('newer-backup-deletion');
    expect(deleted.memories.some((memory) => memory.id === fact.id)).toBe(false);
    await h.backup(); await h.stop();
    await writeFile(join(h.profile, 'profile.enc.json'), olderCorrectionBytes);
    h.order.push({ action: 'restore-only-owned-current-encrypted-file-to-older-correction', encryptedSHA256: digest(olderCorrectionBytes) });
    await h.launch(); const olderCurrent = await h.snapshot('new-process-older-current-correction');
    expect(olderCurrent.memories.find((memory) => memory.id === fact.id)?.text).toBe(b);
    await h.settings(); await h.page().getByText('Restore from a backup', { exact: true }).click();
    await h.page().getByLabel('This backup’s password', { exact: true }).fill(password);
    await h.page().getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(h.page().getByRole('alertdialog')).toContainText('Readable deletion and correction records');
    const staged = await h.snapshot('prepared-backup-newer-deletion', true);
    expect(staged.memories.some((memory) => memory.id === fact.id)).toBe(false);
    expect(staged.memoryTombstones).toEqual(expect.arrayContaining(deleted.memoryTombstones));
    await h.screenshot('backup-newer-deletion-prepared'); await h.restart();
    const restored = await h.snapshot('new-process-backup-newer-deletion');
    expect(restored.memories.some((memory) => memory.id === fact.id)).toBe(false);
    const before = h.wires.length; await h.newChat(); await h.send('Give a short synthetic answer for the restored independent context.');
    const final = h.wires.slice(before).filter((wire) => wire.path.endsWith('/chat/completions')); expect(final).toHaveLength(1);
    expect(final[0]!.body).not.toContain(a); expect(final[0]!.body).not.toContain(b); expect(final[0]!.body).toContain(c);
    const finalState = await h.snapshot('backup-newer-deletion-final-state');
    const receipt = finalState.chatMessages.flatMap((message) => message.requestReceipts ?? []).find((item) => item.expectedBodySHA256 === final[0]!.bodySHA256);
    expect(receipt).toMatchObject({ phase: 'terminal' }); expect(receipt?.contextTrace.memoryReferences).toHaveLength(1);
    await h.screenshot('backup-newer-deletion-final-http');
    h.checkpoint({ scenario: 'backup-newer-deletion', olderCurrentCorrectionNotAppended: true, finalBodySHA256: final[0]!.bodySHA256, finalReceipt: receipt });
    await h.finish();
  } catch (error) { failure = error; throw error; } finally { await h.clean(failure); }
});
