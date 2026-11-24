import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFS from 'node:fs';
import type * as NodePath from 'node:path';
import type * as NodeOS from 'node:os';
import { decryptBytes, encryptJson } from '../../src/main/persistence/encryption';
import { persistentStateSchema } from '../../src/main/domain/schemas';


interface Wire { model: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }>; tool_choice?: string }

// Genuine renderer/preload/IPC/domain/utility/HTTP/encrypted persistence.
// Provider replies and the permission-confirmation dialog are controlled doubles,
// confined to this marked synthetic profile. No personal provider/key is read.
// eslint-disable-next-line no-empty-pattern
test('unconfigured capacity carries a full tool result and long job, preserves accounting and explains real limits', async ({}, info) => {
  test.setTimeout(120_000);
  const executable = process.env.DESKPET_CONTEXT_FIX_APP;
  const syntheticSafeStorage = process.env.DESKPET_CONTEXT_FIX_STORAGE === 'synthetic';
  if (executable && syntheticSafeStorage) throw new Error('Packaged synthetic safeStorage is unsupported. Unset DESKPET_CONTEXT_FIX_APP to validate the development bundle with controlled storage.');
  const root = await mkdtemp(join(tmpdir(), 'deskpet-context-capacity-'));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await mkdir(join(root, 'profile/workspace'), { recursive: true });
  const material = `${'合成参考资料必须完整传递，不能因默认四千上限丢失。'.repeat(500)}\nSYNTHETIC_LAST_FACT_7C19`;
  await writeFile(join(root, 'profile/workspace/context-reference.txt'), material);
  const wires: Array<{ body: Wire; sha256: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'synthetic-capacity' }] })); return; }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString()) as Wire;
      wires.push({ body, sha256: createHash('sha256').update(bytes).digest('hex') });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const tools = body.messages.filter(message => message.role === 'tool');
      const toolName = body.tools?.find(tool => tool.function.description.startsWith('Read workspace file.'))?.function.name;
      const choice = body.tool_choice === 'none' ? { delta: { content: 'SYNTHETIC_LONG_JOB_COMPLETE' }, finish_reason: 'stop' }
        : tools.length ? { delta: { content: 'SYNTHETIC_TOOL_CONTINUATION_COMPLETE: SYNTHETIC_LAST_FACT_7C19' }, finish_reason: 'stop' }
          : { delta: { tool_calls: [{ index: 0, id: 'capacity-read', function: { name: toolName, arguments: '{"path":"context-reference.txt","maxCharacters":16000}' } }] }, finish_reason: 'tool_calls' };
      response.end(`data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 31, completion_tokens: 7, ...(wires.length === 1 ? { cost: 0.0007, cost_currency: 'USD' } : {}) } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing controlled fixture port');
  let application: ElectronApplication | undefined, page: Page;
  const errors: string[] = [], identities: unknown[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const compiledEntry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
  const entry = syntheticSafeStorage ? join(root, 'synthetic-storage-entry.cjs') : compiledEntry;
  if (syntheticSafeStorage) await writeFile(entry, `const { safeStorage } = require('electron'); safeStorage.isEncryptionAvailable = () => true; safeStorage.encryptString = value => Buffer.from('SYNTHETIC_CONTEXT_WRAP:' + value); safeStorage.decryptString = bytes => { const value = bytes.toString(); if (!value.startsWith('SYNTHETIC_CONTEXT_WRAP:')) throw new Error('Wrong synthetic wrapper'); return value.slice(23); }; require(${JSON.stringify(compiledEntry)});`);
  const launch = async () => {
    application = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--deskpet-isolated-profile=${root}`] } : { args: [entry, `--deskpet-isolated-profile=${root}`] }) });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }); });
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(page.url()).toBe('deskpet://app/main_window/index.html');
    identities.push(await application.evaluate(({ app }) => ({ pid: process.pid, appPath: app.getAppPath(), isPackaged: app.isPackaged, name: app.getName(), userData: app.getPath('userData') })));
  };
  const send = async (content: string) => { await page.locator('.composer textarea').fill(content); await page.locator('.composer textarea').press('Enter'); };
  const readMessages = async () => { const sessionId = await page.getByRole('combobox', { name: 'New chat', exact: true }).inputValue(); return page.evaluate(id => window.deskpet.chat.listMessages(id), sessionId); };
  try {
    await launch();
    await page!.evaluate(async baseUrl => {
      await window.deskpet.app.setLocale('en');
      const provider = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Synthetic capacity regression', baseUrl, model: 'synthetic-capacity', enabled: true, supportsTools: true, localExecutionConfirmed: true });
      await window.deskpet.providers.select(provider.id);
    }, `http://127.0.0.1:${address.port}/v1`);
    // Seed only this empty synthetic fixture with a persisted legacy zero budget.
    // Obtain its wrapped vault key in the matching Electron namespace, stop the
    // writer, then edit authenticated ciphertext before restarting the same App.
    const fixtureKeyText = await application!.evaluate(({ app, safeStorage }, expectedRoot) => {
      // Electron main-process evaluation has Node require; renderer code never receives it.
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFS;
      const path = runtime.mainModule.require('node:path') as typeof NodePath;
      const os = runtime.mainModule.require('node:os') as typeof NodeOS;
      const actual = app.getPath('userData');
      const marker = JSON.parse(fs.readFileSync(path.join(expectedRoot, 'isolated-candidate.json'), 'utf8')) as { version: number; purpose: string };
      const canonicalRoot = fs.realpathSync(expectedRoot);
      if (path.dirname(canonicalRoot) !== fs.realpathSync(os.tmpdir()) || !path.basename(canonicalRoot).startsWith('deskpet-context-capacity-')
        || actual !== path.join(canonicalRoot, 'profile') || marker.version !== 1 || marker.purpose !== 'deskpet-isolated-candidate') throw new Error('Fixture profile guard refused');
      return safeStorage.decryptString(fs.readFileSync(path.join(actual, 'vault/vault-key.safe')));
    }, root);
    const fixtureKey = Buffer.from(fixtureKeyText, 'base64');
    try {
      await application!.close(); application = undefined;
      const profilePath = join(root, 'profile/profile.enc.json');
      const state = persistentStateSchema.parse(JSON.parse(decryptBytes(JSON.parse(await readFile(profilePath, 'utf8')), fixtureKey).toString('utf8')));
      state.usageBudget = { dailyRequestLimit: 0, dailyTokenLimit: 0 };
      const fixtureProvider = state.providers.find(value => value.model === 'synthetic-capacity')!;
      state.usageRates = [{ providerId: fixtureProvider.id, model: fixtureProvider.model, inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: new Date().toISOString() }];
      await writeFile(profilePath, `${JSON.stringify(encryptJson(state, fixtureKey))}\n`, { mode: 0o600 });
      const seeded = persistentStateSchema.parse(JSON.parse(decryptBytes(JSON.parse(await readFile(profilePath, 'utf8')), fixtureKey).toString('utf8')));
      expect(seeded.usageBudget).toEqual({ dailyRequestLimit: 0, dailyTokenLimit: 0 });
    } finally { fixtureKey.fill(0); }
    await launch();
    await application!.evaluate(({ dialog }) => { const original = dialog.showMessageBox; Object.assign(globalThis, { contextCapacityOriginalDialog: original }); dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    try { await page!.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'workspace.read', duration: 'always' })); }
    finally { await application!.evaluate(({ dialog }) => { dialog.showMessageBox = (globalThis as unknown as { contextCapacityOriginalDialog: typeof dialog.showMessageBox }).contextCapacityOriginalDialog; }); }
    await page!.getByRole('button', { name: 'Chat', exact: true }).click();
    await send('Read context-reference.txt and report its final synthetic fact.');
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page!.locator('.message.assistant').last()).toContainText('SYNTHETIC_LAST_FACT_7C19');
    expect(wires).toHaveLength(2);
    expect(JSON.parse(wires[1]!.body.messages.find(message => message.role === 'tool')!.content)).toMatchObject({ content: material, truncated: false, nextOffset: null, totalCharacters: material.length });
    const reply = (await readMessages()).at(-1)!;
    expect(reply.requestReceipts).toHaveLength(2);
    expect(reply.requestReceipts?.every(receipt => receipt.capacitySource === 'application-limit' && wires.some(wire => wire.sha256 === receipt.expectedBodySHA256))).toBe(true);
    expect(reply.requestReceipts?.at(-1)?.inputEstimate).toBeGreaterThan(3328);
    await page!.locator('.message.assistant').last().getByText('Request and context record', { exact: true }).click();
    await expect(page!.locator('.message.assistant').last()).toContainText('app request-size limit');
    await page!.screenshot({ path: info.outputPath('complete-tool-continuation.png'), fullPage: true });
    const provider = (await page!.evaluate(() => window.deskpet.providers.list()))[0]!;
    const job = await page!.evaluate(input => window.deskpet.jobs.submit(input), { operationId: randomUUID(), instruction: 'Read the synthetic final fact.', material, privacy: 'cloud-allowed' as const, providerId: provider.id, model: provider.model, expectedBaseUrl: provider.baseUrl });
    await expect.poll(async () => (await page!.evaluate(id => window.deskpet.jobs.get(id), job.id)).status).toBe('succeeded');
    expect(wires).toHaveLength(3);
    expect(wires[2]!.body.tool_choice).toBe('none');
    expect(wires[2]!.body.tools).toBeUndefined();
    expect(JSON.stringify(wires[2]!.body)).toContain(material.replaceAll('\n', '\\n'));
    const usage = await page!.evaluate(() => window.deskpet.usage.snapshot());
    expect(usage.events).toHaveLength(3);
    expect(new Set(usage.events.map(event => event.requestId)).size).toBe(3);
    expect(usage.events.every(event => event.inputTokens === 31 && event.outputTokens === 7 && event.tokenSource === 'provider-reported')).toBe(true);
    expect(await page!.evaluate(() => Object.keys(window.deskpet.usage))).toEqual(['snapshot', 'upsertRate', 'removeRate']);
    expect(usage.events.filter(event => event.reportedCostUSD !== null)).toMatchObject([{ reportedCostUSD: 0.0007 }]);
    expect(usage.rates).toHaveLength(1);
    await page!.locator('nav').getByRole('button', { name: 'Tools', exact: true }).click(); await page!.getByRole('tab', { name: 'Tokens and cost', exact: true }).click();
    await expect(page!.getByRole('heading', { name: 'Tokens and cost', exact: true })).toBeVisible();
    await expect(page!.getByRole('button', { name: /Save daily budget|Save entered prices/ })).toHaveCount(0);
    await expect(page!.getByText(/^\$0\.0007(?:0*)$/u).first()).toBeVisible();
    await page!.screenshot({ path: info.outputPath('token-accounting.png'), fullPage: true });
    await page!.locator('nav').getByRole('button', { name: 'Updates', exact: true }).click(); await page!.getByRole('tab', { name: 'To do', exact: true }).click();
    const attention = await page!.evaluate(() => window.deskpet.attention.snapshot());
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({ id: `background-job:${job.id}`, kind: 'result' });
    const card = page!.locator(`[data-attention-id="background-job:${job.id}"]`);
    await expect(card).toBeVisible();
    await page!.screenshot({ path: info.outputPath('attention-center.png'), fullPage: true });
    await card.getByRole('button', { name: 'View result', exact: true }).click();
    await expect(page!.locator(`[data-opened-job-id="${job.id}"]`)).toContainText('SYNTHETIC_LONG_JOB_COMPLETE');
    expect((await page!.evaluate(() => window.deskpet.attention.snapshot())).items).toHaveLength(1);
    await page!.locator('nav').getByRole('button', { name: 'Updates', exact: true }).click(); await page!.getByRole('tab', { name: 'To do', exact: true }).click();
    await page!.locator(`[data-attention-id="background-job:${job.id}"]`).getByRole('button', { name: 'Mark viewed', exact: true }).click();
    await expect.poll(async () => (await page!.evaluate(() => window.deskpet.attention.snapshot())).items.length).toBe(0);
    const observationOperation = randomUUID();
    await page!.evaluate(async operationId => {
      const { revision: _revision, ...policy } = (await window.deskpet.automation.snapshot()).proactivePolicy;
      void _revision;
      await window.deskpet.automation.configureProactive({ ...policy, mode: 'observe', enabled: false, eventKinds: ['explicit-check-in'], quietStart: '00:00', quietEnd: '00:00', timezone: 'Asia/Shanghai', providerId: null, model: '' });
      await window.deskpet.automation.explicitCheckIn({ operationId });
      await window.deskpet.automation.explicitCheckIn({ operationId });
    }, observationOperation);
    const observation = await page!.evaluate(() => window.deskpet.automation.snapshot());
    expect(observation.proactiveObservations).toHaveLength(1);
    expect(observation.automationTriggers).toEqual([]); expect(observation.jobs).toEqual([]);
    expect(wires).toHaveLength(3);
    await page!.locator('nav').getByRole('button', { name: 'Companion', exact: true }).click();
    await page!.getByRole('tab', { name: 'Check-ins', exact: true }).click();
    await expect(page!.getByRole('radio', { name: 'Record only, never interrupt', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page!.getByText('Advanced: check-in rules and records').click();
    await expect(page!.getByRole('region', { name: 'Event observation and check-ins', exact: true })).toBeVisible();
    await page!.screenshot({ path: info.outputPath('observation-mode.png'), fullPage: true });
    await page!.evaluate(async provider => {
      const { secretState: _secretState, ...input } = provider;
      void _secretState;
      await window.deskpet.providers.upsert({ ...input, contextWindowTokens: 4096 });
    }, provider);
    await page!.getByRole('button', { name: 'Chat', exact: true }).click();
    await send(material);
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'failed');
    await expect(page!.locator('.message.assistant').last().getByRole('alert')).toContainText('complete tool results exceed');
    expect(wires).toHaveLength(3);
    const beforeRestartUsage = await page!.evaluate(() => window.deskpet.usage.snapshot());
    expect(beforeRestartUsage.events).toHaveLength(3);
    expect(beforeRestartUsage.events.filter(event => event.dispatchedAt === null)).toEqual([]);
    await application!.close(); application = undefined;
    await launch();
    expect(await page!.evaluate(() => window.deskpet.usage.snapshot())).toEqual(beforeRestartUsage);
    const sessions = await page!.evaluate(() => window.deskpet.chat.listSessions());
    const restored = await page!.evaluate(id => window.deskpet.chat.listMessages(id), sessions[0]!.id);
    expect(restored.find(message => message.id === reply.id)).toEqual(reply);
    expect(wires).toHaveLength(3);
    expect((await page!.evaluate(() => window.deskpet.attention.snapshot())).items).toEqual([]);
    expect((await page!.evaluate(() => window.deskpet.automation.snapshot())).proactiveObservations).toEqual(observation.proactiveObservations);
    await page!.locator('nav').getByRole('button', { name: 'Tools', exact: true }).click(); await page!.getByRole('tab', { name: 'Tokens and cost', exact: true }).click();
    await expect(page!.getByRole('heading', { name: 'Tokens and cost', exact: true })).toBeVisible();
    await page!.getByRole('button', { name: 'Refresh records', exact: true }).click();
    expect(await page!.evaluate(() => window.deskpet.usage.snapshot())).toEqual(beforeRestartUsage);
    expect(wires).toHaveLength(3);
    await page!.screenshot({ path: info.outputPath('token-accounting-after-restart.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(consoleMessages.filter(message => message.type === 'error')).toEqual([]);
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ profileRoot: root, identities, wires, reply, usage, usageAfterRestart: beforeRestartUsage, errors, consoleMessages, page: { url: page!.url(), title: await page!.title(), viewport: await page!.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) }, legacyPersistedBudgetAtLaunch: { dailyRequestLimit: 0, dailyTokenLimit: 0 }, tokenAccounting: { requests: 3, inputTokens: 93, outputTokens: 21, totalTokens: 114, reportedUSD: 0.0007, estimatedUSD: 0.000208 }, attention, observation, syntheticProviderReplies: true, permissionConfirmationDouble: true, syntheticSafeStorage, personalProfileUsed: false, encryptedProfileBytes: (await readFile(join(root, 'profile/profile.enc.json'))).length }, null, 2));
  } finally {
    await application?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
