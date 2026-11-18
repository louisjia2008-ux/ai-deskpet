import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeFs from 'node:fs';
import type * as NodePromises from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationBatch, DelegationResult, DelegationSubmit } from '../../src/shared/delegations';
import type { PersistentState } from '../../src/main/domain/schemas';

interface Wire { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; tool_choice?: string }
interface WireRecord { path: string; body: Wire; bodySHA256: string; childIndex: number; receivedAt: string; authorizationPresent: boolean; fakeCredentialMatches: boolean }
type Scenario = 'normal-ui' | 'cancel-parent' | 'replace-parent' | 'host-contracts' | 'failure-isolation' | 'cancel-child'
  | 'cancel-durable-before-send' | 'expiry-queued' | 'crash-parent-cancel' | 'crash-running-expired' | 'checks-hidden-until-view' | 'finish-reason-hidden' | 'child-tools-forbidden';
const scenarios: Scenario[] = ['normal-ui', 'cancel-parent', 'replace-parent', 'host-contracts', 'failure-isolation', 'cancel-child',
  'cancel-durable-before-send', 'expiry-queued', 'crash-parent-cancel', 'crash-running-expired', 'checks-hidden-until-view', 'finish-reason-hidden', 'child-tools-forbidden'];
const archive = '/private/tmp/deskpet/output/deskpet-electron-ep3-20261028/e2e';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const historical17 = 'A fictional garden with blue flowers, an oak tree, two round ponds, and a quiet walking path.';

for (const scenario of scenarios) {
  // eslint-disable-next-line no-empty-pattern
  test(`controlled child delegation: ${scenario}`, async ({}, info) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-ep3-e2e-')); const profile = join(root, 'profile');
    await mkdir(join(profile, 'workspace'), { recursive: true });
    const marker = `EP3_${scenario}_${randomUUID()}`; const childTags = [0, 1, 2].map((index) => `${marker}_CHILD_${index}`);
    const parentOnly = `${marker}_PARENT_ONLY`; const memoryOnly = `${marker}_MEMORY_ONLY`; const chatTag = `${marker}_FRONT_CHAT`;
    const resultTags = [0, 1, 2].map((index) => `RESULT_ONLY_${marker}_${index}`); const rawFinishReason = `REASON_BODY_${marker}`; const fakeCredential = `FAKE_ONLY_EP3_${randomUUID()}`;
    const protectedFile = join(profile, 'workspace/untouched.txt'); await writeFile(protectedFile, memoryOnly);
    const directory = join(archive, `${new Date().toISOString().replaceAll(':', '-')}-${scenario}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { recursive: true });
    await copyFile(join(process.cwd(), 'tests/e2e/delegations.spec.ts'), join(directory, 'test-spec.ts'));
    const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainBundleSHA256 = hash(await readFile(entry)); const utilityBundleSHA256 = hash(await readFile(join(process.cwd(), '.webpack', process.arch, 'main/utility.js')));
    const requests: WireRecord[] = []; const auxiliary: string[] = []; const held = new Map<string, ServerResponse>();
    let historicalFixture: unknown = null;
    const launches: unknown[] = []; const order: unknown[] = []; const checkpoints: Array<{ phase: string; state: PersistentState }> = [];
    let application: ElectronApplication | undefined; let page: Page | undefined; let cancelBarrierArmed = false; let sessionId = ''; let verdict = 'RUNNING'; let failure: string | undefined;
    const reply = (response: ServerResponse, content: string, usage = true, tool?: 'modern' | 'legacy', finishReason?: string): void => {
      if (response.destroyed) { order.push({ action: 'late-response-client-already-closed' }); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const fn = { name: 'workspace.write', arguments: JSON.stringify({ path: 'untouched.txt', content: 'UNAUTHORIZED_EP3_TOOL_WRITE' }) };
      const delta = tool === 'modern' ? { tool_calls: [{ index: 0, id: 'untrusted-call', type: 'function', function: fn }] } : tool === 'legacy' ? { function_call: fn } : { content };
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason ?? (tool ? (tool === 'modern' ? 'tool_calls' : 'function_call') : 'stop') }], ...(usage ? { usage: { prompt_tokens: 19, completion_tokens: 11 } } : {}) })}\n\ndata: [DONE]\n\n`);
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!request.url?.endsWith('/chat/completions')) {
          auxiliary.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } } : { data: [{ id: 'child-a' }, { id: 'child-b' }, { id: 'front-model' }] })); return;
        }
        const body = JSON.parse(raw) as Wire; const childIndex = childTags.findIndex((tag) => body.messages.some((message) => message.content.includes(tag)));
        requests.push({ path: request.url ?? '', body, bodySHA256: hash(raw), childIndex, receivedAt: new Date().toISOString(), authorizationPresent: typeof request.headers.authorization === 'string', fakeCredentialMatches: request.headers.authorization === `Bearer ${fakeCredential}` });
        if (childIndex >= 0) {
          if ((['cancel-parent', 'replace-parent', 'crash-parent-cancel'].includes(scenario) && childIndex === 1)
            || (['normal-ui', 'cancel-child', 'crash-running-expired'].includes(scenario) && childIndex === 0)) { held.set(`child-${childIndex}`, response); return; }
          if (scenario === 'failure-isolation' && childIndex === 0) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'SYNTHETIC_EP3_ORDINARY_HTTP_FAILURE' } })); return; }
          if (scenario === 'finish-reason-hidden') { reply(response, rawFinishReason, true, undefined, rawFinishReason); return; }
          if (scenario === 'checks-hidden-until-view') { reply(response, historical17); return; }
          reply(response, resultTags[childIndex]!, scenario !== 'failure-isolation', scenario === 'child-tools-forbidden' ? (childIndex === 0 ? 'modern' : 'legacy') : undefined); return;
        }
        if (scenario === 'expiry-queued') { held.set('chat', response); return; }
        reply(response, `FRONT_RESULT_${chatTag}\n委派文本任务：DO_NOT_AUTORUN_${marker}`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const providerIds = [randomUUID(), randomUUID()];
    const launch = async (): Promise<void> => {
      const env: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
      application = await electron.launch({ args: [entry], cwd: process.cwd(), env });
      await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible();
      await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const identity = await page.evaluate(() => window.deskpet.app.getDiagnostics());
      expect(identity.runtimeIdentity!.dataDirectory).toBe(profile); expect(identity.runtimeIdentity!.mainBundleSHA256).toBe(mainBundleSHA256); launches.push(identity.runtimeIdentity);
      const security = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => {
        const webContents = window.webContents as typeof window.webContents & { getLastWebPreferences(): Electron.WebPreferences }; const prefs = webContents.getLastWebPreferences();
        return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
      }));
      for (const prefs of security) expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
      await writeFile(join(directory, `security-${launches.length}.json`), JSON.stringify(security, null, 2));
    };
    const disk = async (): Promise<PersistentState> => application!.evaluate(({ app, safeStorage }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Wrong synthetic profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFs; const crypto = runtime.mainModule.require('node:crypto') as typeof NodeCrypto;
      const envelope = JSON.parse(fs.readFileSync(`${expectedProfile}/profile.enc.json`, 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
      const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${expectedProfile}/vault/vault-key.safe`)), 'base64');
      try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as PersistentState;
      } finally { key.fill(0); }
    }, profile);
    const checkpoint = async (phase: string): Promise<PersistentState> => { const state = await disk(); checkpoints.push({ phase, state }); await copyFile(join(profile, 'profile.enc.json'), join(directory, `${phase}.enc.json`)); return state; };
    const showDelegations = async (): Promise<void> => {
      await page!.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
      const region = page!.getByRole('region', { name: 'Text delegations', exact: true });
      if (await region.count() === 0) await page!.getByRole('button', { name: 'Delegation status', exact: true }).click();
      await expect(region).toBeVisible();
    };
    const childRequests = (index?: number): WireRecord[] => requests.filter((record) => index === undefined ? record.childIndex >= 0 : record.childIndex === index);
    const batches = async (): Promise<DelegationBatch[]> => page!.evaluate((id) => window.deskpet.delegations.list(id), sessionId);
    const batch = async (id: string): Promise<DelegationBatch> => { const found = (await batches()).find((item) => item.id === id); if (!found) throw new Error('Missing batch'); return found; };
    const waitStatuses = async (id: string, statuses: string[]): Promise<DelegationBatch> => { await expect.poll(async () => (await batch(id)).children.map((child) => child.status)).toEqual(statuses); return batch(id); };
    const submit = async (input: DelegationSubmit): Promise<DelegationBatch> => page!.evaluate((value) => window.deskpet.delegations.submit(value), input);
    const getResult = async (batchId: string, childId: string): Promise<DelegationResult> => page!.evaluate((value) => window.deskpet.delegations.getResult(value), { batchId, childId });
    const input = async (count: number, deadlineAt = new Date(Date.now() + 90_000).toISOString()): Promise<DelegationSubmit> => {
      const draft = await page!.evaluate((id) => window.deskpet.delegations.openDraft({ sessionId: id }), sessionId);
      return { operationId: randomUUID(), sessionId, intentVersion: draft.intentVersion, goal: `Explicit parent goal ${marker}`, deadlineAt,
        budget: { maxEstimatedTokens: 24_000, maxRequests: 3 }, children: Array.from({ length: count }, (_, index) => ({
          instruction: `Child instruction ${childTags[index]}`, material: `ONLY_MATERIAL_${childTags[index]}`, privacy: 'local-only', providerId: providerIds[index === 1 ? 1 : 0]!, model: index === 1 ? 'child-b' : 'child-a', requirements: [],
        })) };
    };
    const sendChat = async (content = chatTag): Promise<void> => { await page!.evaluate((value) => window.deskpet.chat.send(value), { sessionId, content, providerId: providerIds[0]!, model: 'front-model' }); };
    const waitChatComplete = async (content = chatTag): Promise<void> => {
      await expect.poll(async () => {
        const messages = await page!.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId);
        const own = messages.findIndex((message) => message.role === 'user' && message.content === content);
        return own < 0 ? null : messages.slice(own + 1).find((message) => message.role === 'assistant')?.status;
      }).toBe('complete');
    };
    const installCancelBarrier = async (batchId: string): Promise<void> => { cancelBarrierArmed = true; await application!.evaluate(({ app, safeStorage }, config) => {
      if (app.isPackaged || app.getPath('userData') !== config.profile) throw new Error('Fault instrumentation outside own profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFs; const fsp = runtime.mainModule.require('node:fs/promises') as typeof NodePromises; const crypto = runtime.mainModule.require('node:crypto') as typeof NodeCrypto;
      const original = fsp.rename; const globals = globalThis as typeof globalThis & { __ep3Barrier?: { hit: boolean } }; globals.__ep3Barrier = { hit: false };
      fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
        await original(...args);
        if (String(args[1]) !== `${config.profile}/profile.enc.json` || globals.__ep3Barrier!.hit) return;
        const envelope = JSON.parse(fs.readFileSync(String(args[1]), 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
        const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${config.profile}/vault/vault-key.safe`)), 'base64');
        let state: { delegationBatches?: Array<{ id: string; cancelRequestedAt: string | null }> };
        try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
          state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as typeof state;
        } finally { key.fill(0); }
        if (state.delegationBatches?.some((value) => value.id === config.batchId && value.cancelRequestedAt)) { globals.__ep3Barrier!.hit = true; await new Promise<void>(() => undefined); }
      };
    }, { profile, batchId }); };
    const installFinalSendWindow = async (): Promise<void> => application!.evaluate(({ app, utilityProcess, safeStorage }, config) => {
      if (app.isPackaged || app.getPath('userData') !== config.profile) throw new Error('Send-window probe outside own profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFs; const fsp = runtime.mainModule.require('node:fs/promises') as typeof NodePromises; const crypto = runtime.mainModule.require('node:crypto') as typeof NodeCrypto;
      type WindowProbe = { intentSeen: boolean; credentialHeld: boolean; credentialReturned: boolean; cancelAckHeld: boolean; chatPosts: number; releaseCredential?: () => void; releaseCancel?: () => void };
      const globals = globalThis as typeof globalThis & { __ep3SendWindow?: WindowProbe };
      const probe: WindowProbe = { intentSeen: false, credentialHeld: false, credentialReturned: false, cancelAckHeld: false, chatPosts: 0 }; globals.__ep3SendWindow = probe;
      const fork = utilityProcess.fork.bind(utilityProcess);
      utilityProcess.fork = (...args: Parameters<typeof utilityProcess.fork>) => {
        const child = fork(...args); const post = child.postMessage.bind(child);
        child.postMessage = (...postArgs: Parameters<typeof child.postMessage>) => { if ((postArgs[0] as { kind?: string })?.kind === 'provider:chat') probe.chatPosts += 1; return post(...postArgs); };
        return child;
      };
      const secretPath = `${config.profile}/vault/provider-secrets/${crypto.createHash('sha256').update(config.providerId).digest('hex')}.safe`;
      const originalRead = fsp.readFile;
      fsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
        const value = await originalRead(...args);
        if (String(args[0]) === secretPath && probe.intentSeen && !probe.credentialHeld) {
          probe.credentialHeld = true; await new Promise<void>((resolve) => { probe.releaseCredential = resolve; }); probe.credentialReturned = true;
        }
        return value;
      }) as typeof fsp.readFile;
      const originalRename = fsp.rename;
      fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
        await originalRename(...args); if (String(args[1]) !== `${config.profile}/profile.enc.json`) return;
        const envelope = JSON.parse(fs.readFileSync(String(args[1]), 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
        const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${config.profile}/vault/vault-key.safe`)), 'base64');
        let state: { backgroundJobs?: Array<{ instruction: string; status: string }>; delegationBatches?: Array<{ goal: string; cancelRequestedAt: string | null }> };
        try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
          state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as typeof state;
        } finally { key.fill(0); }
        if (state.backgroundJobs?.some((job) => job.instruction.includes(config.marker) && job.status === 'dispatching')) probe.intentSeen = true;
        if (!probe.cancelAckHeld && state.delegationBatches?.some((batch) => batch.goal.includes(config.marker) && batch.cancelRequestedAt)) {
          probe.cancelAckHeld = true; await new Promise<void>((resolve) => { probe.releaseCancel = resolve; });
        }
      };
    }, { profile, providerId: providerIds[0]!, marker });
    const killOwned = async (): Promise<void> => {
      order.push({ action: 'pre-kill-owned-processes', metrics: await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName }))) });
      const pid = application!.process().pid; if (!pid) throw new Error('Missing owned Electron pid'); const closed = application!.waitForEvent('close'); process.kill(pid, 'SIGKILL'); await closed;
      order.push({ action: 'actual-SIGKILL-owned-main', pid }); application = undefined; page = undefined; cancelBarrierArmed = false;
    };
    try {
      await launch();
      if (scenario === 'cancel-durable-before-send') await installFinalSendWindow();
      sessionId = await page!.evaluate(async ({ ids, endpoint, credential }) => {
        for (const [index, id] of ids.entries()) await window.deskpet.providers.upsert({ id, kind: 'ollama', name: `Child service ${index + 1}`, baseUrl: `${endpoint}/${index === 0 ? 'first' : 'second'}/v1`, model: index === 0 ? 'child-a' : 'child-b', enabled: true, supportsTools: true,
          localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512, apiKey: credential });
        await window.deskpet.providers.select(ids[0]!); return (await window.deskpet.chat.createSession({ title: 'Controlled child delegation', kind: 'normal' })).id;
      }, { ids: providerIds, endpoint: `http://127.0.0.1:${address.port}`, credential: fakeCredential });
      await page!.evaluate((text) => window.deskpet.memory.upsert({ id: crypto.randomUUID(), text, tags: [], privacy: 'local-only', scope: { kind: 'global' } }), memoryOnly);
      await checkpoint('before');
      let current: DelegationBatch;
      if (scenario === 'normal-ui') {
        await sendChat(parentOnly); await waitChatComplete(parentOnly);
        await expect(page!.getByRole('form', { name: 'Delegation draft', exact: true })).toHaveCount(0);
        await page!.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
        await page!.locator('.composer textarea').fill(`委派文本任务：${marker} parent goal`); await page!.locator('.composer textarea').press('Enter');
        const form = page!.getByRole('form', { name: 'Delegation draft', exact: true }); await expect(form).toBeVisible(); expect(childRequests()).toHaveLength(0);
        await form.getByLabel('Child 1 instruction', { exact: true }).fill(`Child instruction ${childTags[0]}`);
        await form.getByLabel('Child 1 selected material (paste text)', { exact: true }).fill(`ONLY_MATERIAL_${childTags[0]}`);
        await form.getByLabel('Child 1 provider', { exact: true }).selectOption(providerIds[0]!); await form.getByLabel('Child 1 model', { exact: true }).selectOption('child-a');
        await form.getByRole('button', { name: 'Add child', exact: true }).click();
        await form.getByLabel('Child 2 instruction', { exact: true }).fill(`Child instruction ${childTags[1]}`);
        await form.getByLabel('Child 2 selected material (paste text)', { exact: true }).fill(`ONLY_MATERIAL_${childTags[1]}`);
        await form.getByLabel('Child 2 provider', { exact: true }).selectOption(providerIds[1]!); await form.getByLabel('Child 2 model', { exact: true }).selectOption('child-b');
        await expect(form.getByRole('spinbutton', { name: /budget|requests/i })).toHaveCount(0);
        await form.getByRole('button', { name: 'Submit delegation', exact: true }).click(); await expect.poll(() => held.has('child-0')).toBe(true);
        current = (await batches())[0]!; expect(current.children).toHaveLength(2);
        await page!.evaluate((id) => window.deskpet.providers.setModel(id, 'front-model'), providerIds[0]!);
    await page!.locator('.chat-model-picker > summary').click();
        await expect(page!.getByRole('combobox', { name: 'Chat model', exact: true })).toHaveValue('front-model');
        await page!.locator('.composer textarea').fill(chatTag); await page!.locator('.composer textarea').press('Enter');
        reply(held.get('child-0')!, resultTags[0]!); held.delete('child-0');
        current = await waitStatuses(current.id, ['succeeded', 'succeeded']); await waitChatComplete();
        expect(requests.find((record) => record.childIndex < 0 && record.body.messages.some((message) => message.content === chatTag))?.body.model).toBe('front-model');
        await expect(page!.getByRole('form', { name: 'Delegation draft', exact: true })).toHaveCount(0); expect(await batches()).toHaveLength(1);
        expect(current.children.map((child) => child.model)).toEqual(['child-a', 'child-b']); expect(new Set(current.children.map((child) => child.sessionId)).size).toBe(2);
        expect(current.children.every((child) => child.sessionId !== sessionId)).toBe(true); expect(requests).toHaveLength(4);
        await showDelegations(); const card = page!.locator(`[data-batch-id="${current.id}"]`); await expect(card).toBeVisible();
        for (const value of resultTags.slice(0, 2)) await expect(page!.getByText(value, { exact: true })).toHaveCount(0);
        const geometry = await page!.locator('.chat-pane').evaluate((pane) => {
          const read = (selector: string) => { const node = pane.querySelector(selector); if (!node) throw new Error(`Missing ${selector}`); const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; };
          return { header: read('.chat-header'), panel: read('.delegation-chat-panel'), transcript: read('.message-list'), composer: read('.composer-region'), rows: window.getComputedStyle(pane).gridTemplateRows };
        });
        order.push({ action: 'normal-layout-independent-scroll-geometry', geometry });
        expect(geometry.panel.height).toBeGreaterThan(60); expect(geometry.transcript.height).toBeGreaterThan(0);
        expect(geometry.header.bottom).toBeLessThanOrEqual(geometry.panel.top + 1); expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.transcript.top + 1); expect(geometry.transcript.bottom).toBeLessThanOrEqual(geometry.composer.top + 1);
        for (const [index, child] of current.children.entries()) {
          const viewButton = card.locator(`[data-child-id="${child.id}"]`).getByRole('button', { name: 'View result', exact: true });
          await viewButton.scrollIntoViewIfNeeded(); const pointer = await viewButton.evaluate((node) => { const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { childButtonReceivesPointer: hit === node || (hit !== null && node.contains(hit)), hitTag: hit?.tagName, rect: rect.toJSON() }; });
          order.push({ action: 'result-button-pointer-observation', childId: child.id, ...pointer }); expect(pointer.childButtonReceivesPointer).toBe(true);
          await viewButton.click();
          const shownBody = page!.getByRole('region', { name: 'Child result', exact: true }).locator('[data-result-body]'); await expect(shownBody).toHaveText(resultTags[index]!); await shownBody.scrollIntoViewIfNeeded(); await expect(shownBody).toBeInViewport();
        }
        await page!.screenshot({ path: join(directory, 'two-independent-results.png'), fullPage: true });
        await checkpoint('completed'); await application!.close(); application = undefined; page = undefined; await launch();
        current = await batch(current.id); expect(current.children.map((child) => child.status)).toEqual(['succeeded', 'succeeded']); expect(childRequests()).toHaveLength(2);
        expect((await getResult(current.id, current.children[0]!.id)).result).toBe(resultTags[0]); expect((await getResult(current.id, current.children[1]!.id)).result).toBe(resultTags[1]);
      } else if (['cancel-parent', 'replace-parent', 'crash-parent-cancel'].includes(scenario)) {
        current = await submit(await input(3)); current = await waitStatuses(current.id, ['succeeded', 'running', 'queued']);
        expect(childRequests()).toHaveLength(2); await sendChat();
        expect((await batch(current.id)).cancelRequestedAt).toBeNull(); // An ordinary chat did not change parent intent.
        if (scenario === 'crash-parent-cancel') {
          await installCancelBarrier(current.id); const cancelling = page!.evaluate((id) => window.deskpet.delegations.cancelBatch(id), current.id).catch(() => null);
          await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep3Barrier?: { hit: boolean } }).__ep3Barrier?.hit))).toBe(true);
          await checkpoint('cancel-durable-before-ack'); await killOwned(); await cancelling; for (const response of held.values()) response.destroy(); held.clear(); await launch();
          current = await batch(current.id); expect(current.children.map((child) => child.status)).toEqual(['succeeded', 'cancelled', 'cancelled']);
          expect(childRequests()).toHaveLength(2); expect(requests).toHaveLength(2); expect((await getResult(current.id, current.children[0]!.id)).result).toBe(resultTags[0]);
        } else if (scenario === 'replace-parent') {
          await page!.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
          await showDelegations(); const card = page!.locator(`[data-batch-id="${current.id}"]`); await expect(card).toBeVisible();
          await card.getByLabel('Replacement goal', { exact: true }).fill(`NEW_UNSUBMITTED_GOAL_${marker}`);
          await card.getByRole('button', { name: 'Replace goal', exact: true }).click();
          await expect(page!.getByRole('form', { name: 'Delegation draft', exact: true })).toBeVisible();
          current = await waitStatuses(current.id, ['succeeded', 'cancelled', 'cancelled']); expect(current.historicalAt).not.toBeNull(); expect(current.status).toBe('historical');
          expect((await getResult(current.id, current.children[0]!.id)).historical).toBe(true); expect((await batches())).toHaveLength(1);
          expect(requests.some((record) => JSON.stringify(record.body).includes('NEW_UNSUBMITTED_GOAL'))).toBe(false);
        } else {
          await page!.evaluate((id) => window.deskpet.delegations.cancelBatch(id), current.id); current = await waitStatuses(current.id, ['succeeded', 'cancelled', 'cancelled']); expect(current.status).toBe('cancelled');
          expect((await getResult(current.id, current.children[0]!.id)).result).toBe(resultTags[0]);
        }
        if (scenario !== 'crash-parent-cancel') {
          reply(held.get('child-1')!, `LATE_FORBIDDEN_${marker}`); held.delete('child-1'); await waitChatComplete();
          expect((await getResult(current.id, current.children[1]!.id)).result).toBeNull(); expect(childRequests(2)).toHaveLength(0);
        }
      } else if (scenario === 'host-contracts') {
        const spec = await input(2); const illegal = { ...spec, children: [...spec.children, spec.children[0]!, spec.children[1]!] };
        await expect(submit(illegal)).rejects.toThrow();
        // Legacy economic limits no longer prevent the selected child set.
        spec.budget = { maxEstimatedTokens: 1, maxRequests: 1 };
        expect(childRequests()).toHaveLength(0); expect(await batches()).toHaveLength(0);
        const [first, repeated] = await Promise.all([submit(spec), submit(spec)]); expect(first.id).toBe(repeated.id); current = await waitStatuses(first.id, ['succeeded', 'succeeded']);
        expect((await submit(spec)).id).toBe(current.id); await expect(submit({ ...spec, goal: 'CHANGED_SAME_OPERATION' })).rejects.toThrow('delegation.operationConflict');
        await expect(page!.evaluate((value) => window.deskpet.delegations.getResult(value), { batchId: current.id, childId: randomUUID() })).rejects.toThrow();
        await expect(page!.evaluate((value) => window.deskpet.delegations.submit(value as unknown as DelegationSubmit), { ...spec, operationId: randomUUID(), owner: 'forged-profile' })).rejects.toThrow();
        await expect(page!.evaluate((id) => window.deskpet.jobs.get(id), current.children[0]!.jobId)).rejects.toThrow('delegation.useChildEntry');
        await expect(page!.evaluate((id) => window.deskpet.jobs.cancel(id), current.children[0]!.jobId)).rejects.toThrow('delegation.useChildEntry');
        expect(await page!.evaluate(() => window.deskpet.jobs.list())).toHaveLength(0);
        expect(childRequests()).toHaveLength(2); expect(await batches()).toHaveLength(1);
        const state = await checkpoint('atomic-one-batch'); expect(state.backgroundJobs).toHaveLength(2);
        expect(current.children.map((child) => child.jobId).every((id) => state.backgroundJobs.some((job) => job.id === id))).toBe(true);
      } else if (scenario === 'failure-isolation') {
        current = await submit(await input(2)); current = await waitStatuses(current.id, ['failed', 'succeeded']); expect(current.status).not.toBe('completed');
        expect((await getResult(current.id, current.children[0]!.id)).result).toBeNull(); expect((await getResult(current.id, current.children[1]!.id)).result).toBe(resultTags[1]);
        expect(current.children[0]!.reservation.state).toBe('unknown'); expect(current.children[0]!.reservation.reservedTokens).toBeGreaterThan(0);
        expect(current.budget.outstandingTokens).toBeGreaterThan(0); expect(childRequests()).toHaveLength(2);
      } else if (scenario === 'cancel-child') {
        current = await submit(await input(2)); await expect.poll(() => held.has('child-0')).toBe(true);
        await page!.evaluate((value) => window.deskpet.delegations.cancelChild(value), { batchId: current.id, childId: current.children[0]!.id });
        current = await waitStatuses(current.id, ['cancelled', 'succeeded']); expect(current.cancelRequestedAt).toBeNull(); expect(current.status).not.toBe('completed');
        expect((await getResult(current.id, current.children[1]!.id)).result).toBe(resultTags[1]); expect(childRequests()).toHaveLength(2);
      } else if (scenario === 'cancel-durable-before-send') {
        current = await submit(await input(1));
        await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep3SendWindow?: { credentialHeld: boolean } }).__ep3SendWindow?.credentialHeld))).toBe(true);
        expect(childRequests()).toHaveLength(0); cancelBarrierArmed = true;
        const cancelling = page!.evaluate((id) => window.deskpet.delegations.cancelBatch(id), current.id); void cancelling.catch(() => undefined);
        await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep3SendWindow?: { cancelAckHeld: boolean } }).__ep3SendWindow?.cancelAckHeld))).toBe(true);
        const durable = await checkpoint('cancel-renamed-before-ack-and-send');
        expect(durable.delegationBatches.find((value) => value.id === current.id)?.cancelRequestedAt).not.toBeNull();
        await application!.evaluate(() => { (globalThis as typeof globalThis & { __ep3SendWindow: { releaseCredential?: () => void } }).__ep3SendWindow.releaseCredential?.(); });
        await application!.evaluate(() => new Promise<void>((resolve) => globalThis.setImmediate(resolve)));
        const probe = await application!.evaluate(() => { const value = (globalThis as typeof globalThis & { __ep3SendWindow: { credentialReturned: boolean; chatPosts: number; cancelAckHeld: boolean } }).__ep3SendWindow; return { credentialReturned: value.credentialReturned, chatPosts: value.chatPosts, cancelAckHeld: value.cancelAckHeld }; });
        order.push({ action: 'final-send-window-before-cancel-ack', ...probe }); expect(probe.credentialReturned).toBe(true); expect(probe.chatPosts).toBe(0); expect(childRequests()).toHaveLength(0);
        await application!.evaluate(() => { (globalThis as typeof globalThis & { __ep3SendWindow: { releaseCancel?: () => void } }).__ep3SendWindow.releaseCancel?.(); });
        current = await cancelling; cancelBarrierArmed = false; current = await waitStatuses(current.id, ['cancelled']); expect(childRequests()).toHaveLength(0);
      } else if (scenario === 'expiry-queued') {
        await sendChat(); await expect.poll(() => held.has('chat')).toBe(true);
        const deadlineAt = new Date(Date.now() + 2500).toISOString(); current = await submit(await input(2, deadlineAt));
        await expect.poll(() => Date.now() >= Date.parse(deadlineAt)).toBe(true); reply(held.get('chat')!, `FRONT_RESULT_${chatTag}`); held.delete('chat');
        await expect.poll(async () => (await batch(current.id)).children.every((child) => !['queued', 'running', 'dispatching'].includes(child.status))).toBe(true);
        current = await batch(current.id); expect(current.status).toBe('expired'); expect(childRequests()).toHaveLength(0); await waitChatComplete();
      } else if (scenario === 'crash-running-expired') {
        const deadlineAt = new Date(Date.now() + 3000).toISOString(); current = await submit(await input(2, deadlineAt)); await expect.poll(() => childRequests().length).toBe(1);
        await checkpoint('possible-send-before-crash'); await killOwned(); for (const response of held.values()) response.destroy(); held.clear();
        await expect.poll(() => Date.now() >= Date.parse(deadlineAt)).toBe(true); await launch();
        current = await batch(current.id); expect(current.children[0]!.status).toBe('interrupted'); expect(current.children[1]!.status).not.toBe('succeeded');
        expect(current.children.every((child) => !['queued', 'running', 'dispatching'].includes(child.status))).toBe(true); expect(childRequests()).toHaveLength(1); expect(requests).toHaveLength(1);
      } else if (scenario === 'checks-hidden-until-view') {
        const historical = JSON.parse(await readFile('/private/tmp/deskpet/output/deskpet-electron-ep3-20261028/checks/historical-failures.json', 'utf8')) as { fixtures: Array<{ body: string; bodySHA256: string }> };
        historicalFixture = historical.fixtures[0]; expect(historical.fixtures[0]!.body).toBe(historical17); expect(historical.fixtures[0]!.bodySHA256).toBe(hash(historical17));
        const spec = await input(1); spec.children[0]!.requirements = [
          { id: randomUUID(), kind: 'exact-text', expected: historical17 }, { id: randomUUID(), kind: 'english-word-count', min: 200, max: 220 },
          { id: randomUUID(), kind: 'unimplemented', description: 'Please evaluate beauty objectively' },
        ];
        current = await submit(spec); current = await waitStatuses(current.id, ['succeeded']);
        expect(current.children[0]!.checks.map((check) => check.status)).toEqual(['passed', 'failed', 'unchecked']); expect(current.children[0]!.factVerification).toBe('unverified');
        expect(JSON.stringify(current)).not.toContain(historical17); expect(current.children[0]!.checks.some((check) => 'actualWordCount' in check)).toBe(false);
        await showDelegations();
        const child = page!.locator(`[data-child-id="${current.children[0]!.id}"]`); await expect(child).toBeVisible();
        await expect(page!.getByText(historical17, { exact: true })).toHaveCount(0); await expect(child.locator('[data-requirement-status]')).toHaveCount(3);
        await expect(child.locator('[data-fact-verification="unverified"]')).toBeVisible(); await expect(page!.locator('[data-actual-word-count]')).toHaveCount(0);
        await page!.screenshot({ path: join(directory, 'checks-before-view.png'), fullPage: true });
        await child.getByRole('button', { name: 'View result', exact: true }).click(); const result = page!.getByRole('region', { name: 'Child result', exact: true });
        await expect(result.locator('[data-result-body]')).toHaveText(historical17); await result.locator('[data-result-body]').scrollIntoViewIfNeeded(); await expect(result.locator('[data-result-body]')).toBeInViewport(); const saved = await getResult(current.id, current.children[0]!.id);
        expect(saved.checks[1]).toMatchObject({ status: 'failed', actualWordCount: 17 }); expect(saved.factVerification).toBe('unverified');
        await page!.screenshot({ path: join(directory, 'checks-after-view.png'), fullPage: true });
      } else if (scenario === 'finish-reason-hidden') {
        current = await submit(await input(1)); current = await waitStatuses(current.id, ['succeeded']);
        expect(JSON.stringify(current)).not.toContain(rawFinishReason);
        const publicEvents = await page!.evaluate(() => window.deskpet.tasks.listRunEvents()); expect(JSON.stringify(publicEvents)).not.toContain(rawFinishReason);
        const auditBytes = await readFile(join(profile, 'events/tasks.jsonl'), 'utf8'); expect(auditBytes).not.toContain(rawFinishReason);
        await writeFile(join(directory, 'public-audit-before-view.jsonl'), auditBytes);
        await showDelegations();
        const child = page!.locator(`[data-child-id="${current.children[0]!.id}"]`); await expect(child).toBeVisible();
        await expect(page!.getByText(rawFinishReason, { exact: false })).toHaveCount(0);
        await child.getByRole('button', { name: 'View result', exact: true }).click();
        await expect(page!.getByRole('region', { name: 'Child result', exact: true }).locator('[data-result-body]')).toHaveText(rawFinishReason); await page!.getByRole('region', { name: 'Child result', exact: true }).locator('[data-result-body]').scrollIntoViewIfNeeded();
        const explicit = await getResult(current.id, current.children[0]!.id); expect(explicit.result).toBe(rawFinishReason); expect(explicit.finishReason).toBe(rawFinishReason);
      } else {
        current = await submit(await input(2)); current = await waitStatuses(current.id, ['failed', 'failed']);
        expect(current.children.every((child) => child.completionReason === 'job.toolsForbidden')).toBe(true);
        expect(current.children.map((child) => child.finishReason)).toEqual(['tool_calls', 'function_call']); expect(childRequests()).toHaveLength(2);
        expect((await disk()).sideEffects).toHaveLength(0); expect(await readFile(protectedFile, 'utf8')).toBe(memoryOnly);
      }
      for (const record of childRequests()) {
        expect(record.body.tools).toBeUndefined(); expect(record.body.tool_choice).toBe('none'); expect(record.fakeCredentialMatches).toBe(true);
        const text = JSON.stringify(record.body); expect(text).not.toContain(parentOnly); expect(text).not.toContain(memoryOnly); expect(text).not.toContain(fakeCredential);
        for (const [index, tag] of childTags.entries()) if (index !== record.childIndex) expect(text).not.toContain(tag);
        expect(record.body.model).toBe(record.childIndex === 1 ? 'child-b' : 'child-a'); expect(record.path).toContain(record.childIndex === 1 ? '/second/v1/' : '/first/v1/');
      }
      const final = await checkpoint('final');
      for (const job of final.backgroundJobs.filter((value) => value.delegation && value.result !== null)) {
        expect(final.chatMessages.some((message) => message.content.includes(job.result!))).toBe(false);
        expect(final.memories.some((memory) => memory.text.includes(job.result!))).toBe(false);
      }
      for (const record of childRequests()) {
        const owners = final.backgroundJobs.filter((job) => job.request?.bodySHA256 === record.bodySHA256);
        expect(owners).toHaveLength(1); const owner = owners[0]!; expect(owner.request?.requestId).toBe(owner.attemptId);
        expect(owner.delegation?.parentSessionId).toBe(sessionId); expect(owner.delegation?.sessionId).not.toBe(sessionId);
        const durableBatch = final.delegationBatches.find((value) => value.id === owner.delegation?.batchId);
        const durableChild = durableBatch?.children.find((value) => value.id === owner.delegation?.childId);
        expect(durableChild?.jobId).toBe(owner.id); expect(durableChild?.sessionId).toBe(owner.delegation?.sessionId);
      }
      expect(final.backgroundJobs.every((job) => job.request === null || job.request.observations.every((observation) => observation.usage.inputTokens !== 0 && observation.usage.outputTokens !== 0))).toBe(true);
      const processes = await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      order.push({ action: 'observed-production-processes', metrics: processes });
      const observedMetrics = order.flatMap((item) => (item as { metrics?: Array<{ name?: string; serviceName?: string }> }).metrics ?? []);
      expect(observedMetrics.some((metric) => metric.name === 'DeskPet Provider Runtime' || metric.serviceName === 'DeskPet Provider Runtime')).toBe(true);
      await page!.screenshot({ path: join(directory, 'final.png'), fullPage: true }); verdict = 'PASS';
    } catch (error) {
      verdict = 'FAIL'; failure = error instanceof Error ? error.stack ?? error.message : String(error);
      try { await page?.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); } catch { /* Process fault may already have closed its renderer. */ }
      if (application) { try { await checkpoint('failure'); } catch { /* Preserve remaining raw observations. */ } }
      throw error;
    } finally {
      if (application) {
        try { order.push({ action: 'pre-close-owned-processes', metrics: await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName }))) }); } catch { /* Process already stopped. */ }
        const pid = application.process().pid;
        if (cancelBarrierArmed && pid) { try { process.kill(pid, 'SIGKILL'); order.push({ action: 'fault-cleanup-owned-main-SIGKILL', pid }); } catch { /* Already exited. */ } }
        else try { await application.close(); } catch { if (pid) { try { process.kill(pid, 'SIGKILL'); order.push({ action: 'fault-cleanup-owned-main-SIGKILL', pid }); } catch { /* Already exited. */ } } }
      }
      for (const response of held.values()) response.destroy(); held.clear(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeFile(join(directory, 'evidence.json'), JSON.stringify({ scenario, verdict, failure, root, profile, entry, mainBundleSHA256, utilityBundleSHA256,
        launches, configuration: { normalRendererSecurity: true, isolatedProfile: true, controlledHTTP: true, providerUtilityBypassed: false, actualModelCalls: 0,
          instrumentation: scenario === 'cancel-durable-before-send' ? 'real credential-read and durable rename acknowledgement barriers; actual utility post count observation, original fork/post preserved' : scenario === 'crash-parent-cancel' ? 'fs rename acknowledgement barrier + actual SIGKILL/new process' : scenario === 'crash-running-expired' ? 'actual SIGKILL/new process with parent deadline' : null },
        historicalFixture, syntheticInputs: { rawFinishReason, marker, childTags, parentOnly, memoryOnly, chatTag, resultTags, sessionId, providerIds }, requests, auxiliary, order, checkpoints, recordingServerClosed: !server.listening,
      }, null, 2));
      await info.attach('delegation-evidence', { path: join(directory, 'evidence.json'), contentType: 'application/json' });
    }
  });
}
