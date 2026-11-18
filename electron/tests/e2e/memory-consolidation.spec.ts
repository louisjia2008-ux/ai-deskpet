import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import type * as Fs from 'node:fs';
import type * as Fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConsolidationBatch, ConsolidationCandidate, ConsolidationPreviewInput } from '../../src/shared/consolidation';
import type { MemoryItem } from '../../src/shared';
import type { PersistentState } from '../../src/main/domain/schemas';

interface Wire { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; tool_choice?: string }
interface WireRecord { path: string; body: Wire; bodySHA256: string; receivedAt: string; responseBody: string; authorizationPresent: boolean; fakeCredentialMatches: boolean }
type Scenario = 'manual-flow' | 'source-mutation' | 'privacy' | 'overlap-competition' | 'duplicate-edit' | 'protocol-failures' | 'candidate-crash' | 'apply-ack-crash' | 'commit-uncertain' | 'old-backup-restore' | 'late-generation-invalid' | 'ancestor-revocation-final-send';
const scenarios: Scenario[] = ['manual-flow', 'source-mutation', 'privacy', 'overlap-competition', 'duplicate-edit', 'protocol-failures', 'candidate-crash', 'apply-ack-crash', 'commit-uncertain', 'old-backup-restore', 'late-generation-invalid', 'ancestor-revocation-final-send'];
const archive = '/private/tmp/deskpet/output/deskpet-electron-ep4-20261029/e2e';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const invariantFacts = (memories: MemoryItem[]) => memories.map((memory) => ({ id: memory.id, text: memory.text, tags: memory.tags,
  revision: memory.contextMetadata?.revision, sources: memory.contextMetadata?.sourceReferences, events: memory.contextMetadata?.sourceEventIds }));

for (const scenario of scenarios) {
  // eslint-disable-next-line no-empty-pattern
  test(`manual sourced consolidation: ${scenario}`, async ({}, info) => {
    test.setTimeout(150_000);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-ep4-e2e-')); const profile = join(root, 'profile'); const backupPath = join(root, 'synthetic-ep4.deskpet-backup');
    const marker = `EP4_${scenario}_${randomUUID()}`; const sourceIds = [randomUUID(), randomUUID(), randomUUID()];
    const facts = [`${marker}: Aster's pump setting is 51 mL only during bench testing; never use it for field operation.`,
      `${marker}: Birch prefers mint tea on weekends only; weekday preference is unspecified.`,
      `${marker}: Cedar's current dock is New Quay as of 2026-10-01; Old Port is superseded.`];
    const originals = facts.map((fact, index) => `RAW_RECORD_${index}_${marker}. ${Array(9).fill(fact).join(' ')}`);
    const summary = (indices: number[], suffix = ''): ConsolidationCandidate => ({ segments: indices.map((index) => ({ text: `${facts[index]}${suffix}`, sourceIds: [sourceIds[index]!] })), coveredMemoryIds: indices.map((index) => sourceIds[index]!), uncoveredMemoryIds: [], conflicts: [] });
    const directory = join(archive, `${new Date().toISOString().replaceAll(':', '-')}-${scenario}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { recursive: true });
    await copyFile(join(process.cwd(), 'tests/e2e/memory-consolidation.spec.ts'), join(directory, 'test-spec.ts'));
    const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainBundleSHA256 = hash(await readFile(entry)); const utilityBundleSHA256 = hash(await readFile(join(process.cwd(), '.webpack', process.arch, 'main/utility.js')));
    const providerId = randomUUID(); const remoteId = randomUUID(); const fakeCredential = `FAKE_EP4_ONLY_${randomUUID()}`;
    const unselected = `UNSELECTED_EP4_${randomUUID()}`; const requests: WireRecord[] = []; const metadata: unknown[] = [];
    const launches: unknown[] = []; const order: unknown[] = []; const checkpoints: Array<{ phase: string; state: PersistentState }> = [];
    const held: ServerResponse[] = []; let nextReply: unknown = summary([0, 1]); let responseMode: 'json' | 'malformed' | 'truncated' | 'tool' | 'held' = 'json';
    let application: ElectronApplication | undefined; let page: Page | undefined; let sessionId = ''; let faultArmed = false; let verdict = 'RUNNING'; let failure: string | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk)); request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!request.url?.endsWith('/chat/completions')) {
          metadata.push({ path: request.url }); response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } } : { data: [{ id: 'ep4-fixture' }] })); return;
        }
        const body = JSON.parse(raw) as Wire; const isJob = body.tool_choice === 'none';
        const content = isJob ? responseMode === 'malformed' ? '{not valid JSON' : JSON.stringify(nextReply) : `CONTROLLED_CHAT_OK_${marker}`;
        const finish = isJob && responseMode === 'truncated' ? 'length' : isJob && responseMode === 'tool' ? 'tool_calls' : 'stop';
        const delta = isJob && responseMode === 'tool' ? { tool_calls: [{ index: 0, id: 'forbidden-ep4', type: 'function', function: { name: 'workspace.write', arguments: '{"path":"ep4-forbidden.txt","content":"SHOULD_NOT_EXIST"}' } }] } : { content };
        const responseBody = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 31, completion_tokens: 17 } })}\n\ndata: [DONE]\n\n`;
        requests.push({ path: request.url, body, bodySHA256: hash(raw), receivedAt: new Date().toISOString(), responseBody,
          authorizationPresent: typeof request.headers.authorization === 'string', fakeCredentialMatches: request.headers.authorization === `Bearer ${fakeCredential}` });
        if (isJob && responseMode === 'held') { held.push(response); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(responseBody);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing E-P4 receiver address');
    const launch = async (): Promise<void> => {
      const env: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
      application = await electron.launch({ args: [entry], cwd: process.cwd(), env });
      await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible();
      await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const identity = (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity;
      expect(identity?.dataDirectory).toBe(profile); expect(identity?.mainBundleSHA256).toBe(mainBundleSHA256);
      const security = await application.evaluate(({ app, BrowserWindow }) => ({ pid: process.pid, noSandbox: app.commandLine.hasSwitch('no-sandbox'),
        windows: BrowserWindow.getAllWindows().map((window) => {
          const contents = window.webContents as typeof window.webContents & { getLastWebPreferences(): Electron.WebPreferences }; const prefs = contents.getLastWebPreferences();
          return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
        }) }));
      expect(security.noSandbox).toBe(false); for (const prefs of security.windows) expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
      launches.push({ identity, security }); order.push({ action: 'launch-owned-main', pid: security.pid });
      if (scenario === 'old-backup-restore') await application.evaluate(({ app, dialog }, path) => {
        app.relaunch = () => undefined;
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      }, backupPath);
    };
    const disk = async (): Promise<PersistentState> => application!.evaluate(({ app, safeStorage }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Wrong E-P4 synthetic profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof Fs; const crypto = runtime.mainModule.require('node:crypto') as typeof Crypto;
      const envelope = JSON.parse(fs.readFileSync(`${expectedProfile}/profile.enc.json`, 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
      const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${expectedProfile}/vault/vault-key.safe`)), 'base64');
      try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as PersistentState;
      } finally { key.fill(0); }
    }, profile);
    const checkpoint = async (phase: string): Promise<PersistentState> => { const state = await disk(); checkpoints.push({ phase, state });
      await copyFile(join(profile, 'profile.enc.json'), join(directory, `${phase}.enc.json`)); await writeFile(join(directory, `${phase}.state.json`), JSON.stringify(state, null, 2)); return state; };
    const jobs = (): WireRecord[] => requests.filter((record) => record.body.tool_choice === 'none');
    const chats = (): WireRecord[] => requests.filter((record) => record.body.tool_choice !== 'none');
    const get = async (id: string): Promise<ConsolidationBatch> => page!.evaluate((id) => window.deskpet.consolidation.get(id), id);
    const preview = async (indices = [0, 1], selectedProviderId = providerId): Promise<ConsolidationBatch> => {
      const input: ConsolidationPreviewInput = { operationId: randomUUID(), sessionId, memoryIds: indices.map((index) => sourceIds[index]!), providerId: selectedProviderId, model: 'ep4-fixture' };
      return page!.evaluate((value) => window.deskpet.consolidation.preview(value), input);
    };
    const generate = async (batch: ConsolidationBatch): Promise<ConsolidationBatch> => {
      await page!.evaluate((id) => window.deskpet.consolidation.generate({ id, operationId: crypto.randomUUID() }), batch.id);
      await expect.poll(async () => (await get(batch.id)).status).not.toBe('generating'); return get(batch.id);
    };
    const ready = async (indices = [0, 1]): Promise<ConsolidationBatch> => { nextReply = summary(indices); responseMode = 'json'; return generate(await preview(indices)); };
    const apply = async (batch: ConsolidationBatch, operationId = randomUUID()): Promise<ConsolidationBatch> => page!.evaluate((input) => window.deskpet.consolidation.apply(input), {
      id: batch.id, operationId, expectedVersion: batch.candidateVersion, fidelityReviewed: true as const, enableRepresentation: true,
    });
    const freshChat = async (query = `What are the saved facts for ${marker}?`): Promise<WireRecord> => {
      const id = await page!.evaluate(async () => (await window.deskpet.chat.createSession({ title: 'E-P4 independent recall', kind: 'normal' })).id);
      const before = chats().length; await page!.evaluate((input) => window.deskpet.chat.send(input), { sessionId: id, content: query, providerId, model: 'ep4-fixture' });
      await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.chat.listMessages(id), id)).at(-1)?.status).toBe('complete');
      expect(chats()).toHaveLength(before + 1); return chats().at(-1)!;
    };
    const update = async (index: number, text: string, privacy: 'local-only' | 'cloud-allowed' = 'local-only'): Promise<void> => {
      const current = (await page!.evaluate(() => window.deskpet.memory.list())).find((item) => item.id === sourceIds[index])!;
      await page!.evaluate((input) => window.deskpet.memory.upsert(input), { id: current.id, text, tags: current.tags, expectedRevision: current.contextMetadata?.revision ?? 0,
        operationId: randomUUID(), privacy, scope: { kind: 'global' as const } });
    };
    const installFault = async (batchId: string, target: 'review' | 'applied', uncertain = false): Promise<void> => {
      faultArmed = true; await application!.evaluate(({ app, safeStorage }, config) => {
        if (app.isPackaged || app.getPath('userData') !== config.profile) throw new Error('Fault probe outside owned synthetic profile');
        const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
        const fs = runtime.mainModule.require('node:fs') as typeof Fs; const fsp = runtime.mainModule.require('node:fs/promises') as typeof Fsp; const crypto = runtime.mainModule.require('node:crypto') as typeof Crypto;
        const originalRename = fsp.rename; const originalRead = fsp.readFile;
        const probe = { hit: false, readBlocked: false, release: () => { fsp.rename = originalRename; fsp.readFile = originalRead; } };
        (globalThis as typeof globalThis & { __ep4Fault?: typeof probe }).__ep4Fault = probe;
        fsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
          if (probe.readBlocked && String(args[0]) === `${config.profile}/profile.enc.json`) throw new Error('synthetic.authorityUnreadable');
          return originalRead(...args);
        }) as typeof fsp.readFile;
        fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
          await originalRename(...args); if (String(args[1]) !== `${config.profile}/profile.enc.json` || probe.hit) return;
          const envelope = JSON.parse(fs.readFileSync(String(args[1]), 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
          const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${config.profile}/vault/vault-key.safe`)), 'base64');
          let state: { consolidationBatches?: Array<{ id: string; status: string }> };
          try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
            state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as typeof state;
          } finally { key.fill(0); }
          if (!state.consolidationBatches?.some((batch) => batch.id === config.batchId && batch.status === config.target)) return;
          probe.hit = true;
          if (config.uncertain) { probe.readBlocked = true; throw new Error('synthetic.commitAckLost'); }
          await new Promise<void>(() => undefined);
        };
      }, { profile, batchId, target, uncertain });
    };
    const faultHit = async (): Promise<boolean> => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep4Fault?: { hit: boolean } }).__ep4Fault?.hit));
    const killOwned = async (): Promise<void> => {
      const metrics = await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      const pid = application!.process().pid; if (!pid) throw new Error('Missing owned Electron pid'); order.push({ action: 'owned-processes-before-SIGKILL', metrics });
      const closed = application!.waitForEvent('close'); process.kill(pid, 'SIGKILL'); await closed; order.push({ action: 'actual-main-SIGKILL', pid }); application = undefined; page = undefined; faultArmed = false;
    };
    try {
      await launch();
      sessionId = await page!.evaluate(async (config) => {
        for (const [index, id] of config.ids.entries()) await window.deskpet.providers.upsert({ id, kind: 'ollama', name: index ? 'Synthetic unknown execution destination' : 'Synthetic E-P4 local service',
          baseUrl: `${config.endpoint}/${index ? 'remote' : 'local'}/v1`, model: 'ep4-fixture', enabled: true, supportsTools: config.supportsTools, localExecutionConfirmed: !index,
          contextWindowTokens: 32768, maxOutputTokens: 1024, apiKey: config.credential });
        await window.deskpet.providers.select(config.ids[0]!); return (await window.deskpet.chat.createSession({ title: 'E-P4 source selection', kind: 'normal' })).id;
      }, { ids: [providerId, remoteId], endpoint: `http://127.0.0.1:${address.port}`, credential: fakeCredential, supportsTools: scenario !== 'ancestor-revocation-final-send' });
      for (const [index, id] of sourceIds.entries()) await page!.evaluate((input) => window.deskpet.memory.upsert(input), { id, text: originals[index]!, tags: ['synthetic-ep4'], privacy: 'local-only' as const, scope: { kind: 'global' as const } });
      await page!.evaluate((text) => window.deskpet.memory.upsert({ id: crypto.randomUUID(), text, tags: [], privacy: 'local-only', scope: { kind: 'global' as const } }), unselected);
      const before = await checkpoint('initial-sources'); const originalFacts = invariantFacts(before.memories);
      if (scenario === 'manual-flow') {
        await page!.locator('nav').getByRole('button', { name: 'Memory', exact: true }).click();
        await page!.getByRole('tab', { name: 'Manual consolidation', exact: true }).click();
        const region = page!.getByRole('region', { name: 'Manual memory consolidation', exact: true }); await expect(region).toBeVisible();
        for (const id of sourceIds.slice(0, 2)) await region.getByRole('checkbox', { name: `Select source ${id}`, exact: true }).check();
        await region.getByLabel('Consolidation provider', { exact: true }).selectOption(providerId); await region.getByLabel('Consolidation model', { exact: true }).fill('ep4-fixture');
        await region.getByRole('button', { name: 'Review selected sources', exact: true }).click();
        const previewRegion = region.getByRole('region', { name: 'Consolidation material and binding', exact: true }); await expect(previewRegion).toContainText(originals[0]!);
        await expect(previewRegion).toContainText('ep4-fixture'); expect(jobs()).toHaveLength(0); await page!.screenshot({ path: join(directory, 'preview.png'), fullPage: true });
        await region.getByRole('button', { name: 'Generate candidate once', exact: true }).click();
        await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.consolidation.list(id), sessionId))[0]?.status).toBe('review');
        let current = (await page!.evaluate((id) => window.deskpet.consolidation.list(id), sessionId))[0]!;
        const preApplyWire = await freshChat(); expect(JSON.stringify(preApplyWire.body)).toContain('RAW_RECORD_0_'); expect((await get(current.id)).active).toBe(false);
        await page!.locator('nav').getByRole('button', { name: 'Memory', exact: true }).click(); await page!.getByRole('tab', { name: 'Manual consolidation', exact: true }).click();
        await region.locator(`[data-consolidation-id="${current.id}"]`).getByRole('button', { name: 'Review batch', exact: true }).click();
        const review = region.getByRole('region', { name: 'Consolidation candidate review', exact: true }); await expect(review).toBeVisible();
        await review.getByRole('checkbox', { name: 'I compared this version with every source, including conditions and conflicts', exact: true }).check();
        await review.getByRole('checkbox', { name: 'Use this summary for eligible requests', exact: true }).check();
        const confirm = review.getByRole('button', { name: 'Confirm reviewed version', exact: true }); await confirm.scrollIntoViewIfNeeded();
        const receivesPointer = await confirm.evaluate((node) => { const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit === node || (hit !== null && node.contains(hit)); });
        expect(receivesPointer).toBe(true); await page!.screenshot({ path: join(directory, 'reviewed-candidate.png'), fullPage: true }); await confirm.click();
        await expect.poll(async () => (await get(current.id)).status).toBe('applied'); current = await get(current.id); expect(current.active).toBe(true);
        const wire = await freshChat(); const memorySystem = wire.body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
        expect(memorySystem).toContain(facts[0]!); expect(memorySystem).toContain(facts[1]!); expect(memorySystem).not.toContain('RAW_RECORD_0_'); expect(memorySystem).not.toContain('RAW_RECORD_1_');
        expect(memorySystem).toContain('RAW_RECORD_2_'); expect(memorySystem.split(facts[0]!).length - 1).toBe(1);
        const applied = await checkpoint('applied-after-final-http'); expect(invariantFacts(applied.memories)).toEqual(originalFacts);
        await application!.close(); application = undefined; page = undefined; await launch(); current = await get(current.id); expect(current.active).toBe(true); expect(jobs()).toHaveLength(1);
        await page!.evaluate((id) => window.deskpet.consolidation.disable({ id, operationId: crypto.randomUUID() }), current.id);
        const disabled = await freshChat(); expect(JSON.stringify(disabled.body)).toContain('RAW_RECORD_0_'); expect((await get(current.id)).active).toBe(false);
        expect(invariantFacts((await checkpoint('new-process-disabled')).memories)).toEqual(originalFacts);
      } else if (scenario === 'source-mutation') {
        const stale = await ready(); await update(0, `CURRENT_CORRECTION_${marker}: Aster setting is 73 mL only during bench testing.`);
        await expect(apply(stale)).rejects.toThrow(); expect((await get(stale.id)).active).toBe(false);
        facts[0] = `CURRENT_CORRECTION_${marker}: Aster setting is 73 mL only during bench testing.`;
        const current = await ready(); await apply(current); await checkpoint('applied-corrected-source');
        await page!.evaluate((id) => window.deskpet.memory.remove(id, { operationId: crypto.randomUUID() }), sourceIds[1]!);
        const invalid = await get(current.id); expect(invalid.active).toBe(false); expect(invalid.status).toBe('invalid');
        await page!.evaluate((id) => window.deskpet.consolidation.disable({ id, operationId: crypto.randomUUID() }).catch(() => undefined), current.id);
        const state = await checkpoint('deleted-derived-copies'); const relevantJobs = state.backgroundJobs.filter((job) => job.consolidation?.batchId === current.id || job.consolidation?.batchId === stale.id);
        expect(JSON.stringify(relevantJobs)).not.toContain(facts[1]!); expect(JSON.stringify(state.consolidationBatches)).not.toContain(facts[1]!);
        const wire = await freshChat(); expect(JSON.stringify(wire.body)).not.toContain(facts[1]!); expect(JSON.stringify(wire.body)).not.toContain('RAW_RECORD_0_');
        expect(JSON.stringify(wire.body)).toContain('CURRENT_CORRECTION_'); await expect(apply(current)).rejects.toThrow(); expect(jobs()).toHaveLength(2);
        await page!.locator(`[data-session-id="${sessionId}"] .session-item`).click(); await page!.locator('nav').getByRole('button', { name: 'Memory', exact: true }).click(); await page!.getByRole('tab', { name: 'Manual consolidation', exact: true }).click();
        const card = page!.locator(`[data-consolidation-id="${current.id}"]`); await expect(card).toHaveAttribute('data-consolidation-status', 'invalid'); await card.getByRole('button', { name: 'Review batch', exact: true }).click();
        const review = page!.getByRole('region', { name: 'Consolidation candidate review', exact: true }); await expect(review).toContainText('Invalidated'); await expect(review.getByRole('button', { name: 'Confirm reviewed version', exact: true })).toHaveCount(0);
      } else if (scenario === 'privacy') {
        const good = await ready(); expect(good.status).toBe('review'); expect(jobs()).toHaveLength(1); await apply(good);
        await expect(preview([0, 1], remoteId)).rejects.toThrow(); expect(requests.filter((record) => record.path.includes('/remote/'))).toHaveLength(0);
        await update(0, originals[0]!, 'cloud-allowed'); await update(1, originals[1]!, 'cloud-allowed');
        nextReply = summary([0, 1]); const allowedRemote = await generate(await preview([0, 1], remoteId)); expect(allowedRemote.status).toBe('review');
        expect(requests.filter((record) => record.path.includes('/remote/'))).toHaveLength(1);
        await update(0, originals[0]!, 'local-only'); await expect(apply(allowedRemote)).rejects.toThrow();
        await checkpoint('privacy-revoked');
      } else if (scenario === 'overlap-competition') {
        const first = await ready([0, 1]); const stale = await ready([1, 2]); await apply(first);
        await expect(apply(stale)).rejects.toThrow(); expect((await get(stale.id)).status).toBe('review');
        const second = await ready([1, 2]); await freshChat('Unrelated ordinary foreground write'); await apply(second);
        const wire = await freshChat(); const text = wire.body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
        expect(text).toContain('RAW_RECORD_0_'); expect(text).not.toContain('RAW_RECORD_1_'); expect(text).not.toContain('RAW_RECORD_2_');
        expect(text.split(facts[1]!).length - 1).toBe(1); expect(text.split(facts[2]!).length - 1).toBe(1);
        const partial = await preview([0, 1]); nextReply = { segments: [{ text: facts[0]!, sourceIds: [sourceIds[0]!] }], coveredMemoryIds: [sourceIds[0]!], uncoveredMemoryIds: [sourceIds[1]!], conflicts: [] };
        const partialReady = await generate(partial); await apply(partialReady); const partialWire = await freshChat();
        expect(JSON.stringify(partialWire.body)).toContain('RAW_RECORD_0_'); expect(JSON.stringify(partialWire.body)).toContain('RAW_RECORD_1_');
        expect(invariantFacts((await checkpoint('overlap-partial-no-evidence-change')).memories)).toEqual(originalFacts);
      } else if (scenario === 'duplicate-edit') {
        const input: ConsolidationPreviewInput = { operationId: randomUUID(), sessionId, memoryIds: sourceIds.slice(0, 2), providerId, model: 'ep4-fixture' };
        const [a, b] = await page!.evaluate(async (input) => Promise.all([window.deskpet.consolidation.preview(input), window.deskpet.consolidation.preview(input)]), input); expect(a.id).toBe(b.id);
        await expect(page!.evaluate((input) => window.deskpet.consolidation.preview({ ...input, memoryIds: input.memoryIds.slice(0, 1) }), input)).rejects.toThrow();
        const generateOp = randomUUID(); await page!.evaluate(async (input) => Promise.all([window.deskpet.consolidation.generate(input), window.deskpet.consolidation.generate(input)]), { id: a.id, operationId: generateOp });
        await expect.poll(async () => (await get(a.id)).status).toBe('review'); expect(jobs()).toHaveLength(1); const generated = await get(a.id);
        const edit = summary([0, 1]); edit.segments[0]!.text = edit.segments[0]!.text.replace('pump setting is', 'pump setting equals');
        const edited = await page!.evaluate((input) => window.deskpet.consolidation.edit(input), { id: a.id, operationId: randomUUID(), expectedVersion: generated.candidateVersion, candidate: edit });
        expect(edited.candidateVersion).toBeGreaterThan(generated.candidateVersion); await expect(apply(generated)).rejects.toThrow();
        const op = randomUUID(); await apply(edited, op); const committed = await checkpoint('applied-once');
        await apply(edited, op); await expect(page!.evaluate((input) => window.deskpet.consolidation.apply(input), { id: edited.id, operationId: op, expectedVersion: edited.candidateVersion, fidelityReviewed: true as const, enableRepresentation: false })).rejects.toThrow();
        await page!.evaluate((id) => window.deskpet.consolidation.disable({ id, operationId: crypto.randomUUID() }), edited.id); await apply(edited, op);
        expect((await get(edited.id)).active).toBe(false); const after = await checkpoint('receipt-replay-does-not-reactivate'); expect(invariantFacts(after.memories)).toEqual(originalFacts);
        expect(committed.backgroundJobs).toHaveLength(1); expect(after.backgroundJobs).toHaveLength(1); expect(jobs()).toHaveLength(1);
      } else if (scenario === 'protocol-failures') {
        for (const mode of ['malformed', 'truncated', 'tool'] as const) {
          responseMode = mode; const batch = await generate(await preview()); expect(batch.status).toBe('failed'); expect(batch.candidate).toBeNull(); await expect(apply(batch)).rejects.toThrow();
          order.push({ action: 'protocol-failure', mode, batchId: batch.id, completionReason: batch.completionReason, jobStatus: batch.jobStatus });
        }
        responseMode = 'json'; nextReply = { ...summary([0, 1]), segments: [{ text: 'UNSUPPORTED_SOURCE', sourceIds: [randomUUID()] }] };
        const badRefs = await generate(await preview()); expect(badRefs.status).toBe('failed'); expect(badRefs.candidate).toBeNull(); expect(jobs()).toHaveLength(4);
        const state = await checkpoint('four-failed-one-attempt-jobs'); expect(invariantFacts(state.memories)).toEqual(originalFacts);
        await expect(readFile(join(profile, 'workspace/ep4-forbidden.txt'))).rejects.toThrow();
      } else if (scenario === 'candidate-crash') {
        const draft = await preview(); await installFault(draft.id, 'review');
        await page!.evaluate((id) => window.deskpet.consolidation.generate({ id, operationId: crypto.randomUUID() }), draft.id); await expect.poll(faultHit).toBe(true);
        const persisted = await checkpoint('candidate-published-before-process-interruption'); expect(persisted.consolidationBatches.find((batch) => batch.id === draft.id)?.candidate).not.toBeNull();
        await killOwned(); await launch(); const restored = await get(draft.id); expect(restored.status).toBe('review'); expect(restored.candidate).toEqual(summary([0, 1]));
        expect(jobs()).toHaveLength(1); expect(invariantFacts((await checkpoint('candidate-new-process')).memories)).toEqual(originalFacts);
      } else if (scenario === 'apply-ack-crash') {
        const batch = await ready(); const op = randomUUID(); await installFault(batch.id, 'applied');
        await page!.evaluate((input) => { void window.deskpet.consolidation.apply(input).catch(() => undefined); }, { id: batch.id, operationId: op, expectedVersion: batch.candidateVersion, fidelityReviewed: true as const, enableRepresentation: true });
        await expect.poll(faultHit).toBe(true); const published = await checkpoint('apply-published-before-caller-ack');
        expect(published.consolidationBatches.find((value) => value.id === batch.id)?.receipts.some((receipt) => receipt.operationId === op)).toBe(true);
        await killOwned(); await launch(); const restored = await get(batch.id); expect(restored.status).toBe('applied'); expect(restored.active).toBe(true);
        await apply(batch, op); const wire = await freshChat(); expect(JSON.stringify(wire.body)).not.toContain('RAW_RECORD_0_'); expect(jobs()).toHaveLength(1);
        expect(invariantFacts((await checkpoint('apply-new-process-reused-original-receipt')).memories)).toEqual(originalFacts);
      } else if (scenario === 'old-backup-restore') {
        const batch = await ready(); await apply(batch); await checkpoint('before-old-backup');
        await page!.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click(); await page!.getByRole('tab', { name: 'Privacy and data', exact: true }).click();
        const password = 'SYNTHETIC_EP4_BACKUP_PASSWORD'; await page!.getByLabel('Backup password', { exact: true }).fill(password); await page!.getByLabel('Confirm password for a new backup', { exact: true }).fill(password);
        await page!.getByRole('button', { name: 'Create encrypted backup', exact: true }).click(); await expect(page!.getByText('Encrypted backup saved', { exact: true })).toBeVisible();
        await copyFile(backupPath, join(directory, 'old-applied-backup.deskpet-backup'));
        await page!.evaluate((id) => window.deskpet.memory.remove(id, { operationId: crypto.randomUUID() }), sourceIds[1]!); await checkpoint('newer-delete-before-restore');
        await page!.getByLabel('Backup password', { exact: true }).fill(password);
        await page!.getByRole('button', { name: 'Restore backup', exact: true }).click(); await expect(page!.getByRole('button', { name: /Restart and restore/ })).toBeVisible();
        await page!.screenshot({ path: join(directory, 'old-backup-prepared-with-deletion-protection.png'), fullPage: true });
        const child = application!.process(); await page!.getByRole('button', { name: /Restart and restore/ }).click(); await expect.poll(() => child.exitCode).toBe(0);
        application = undefined; page = undefined; await launch(); const restored = await get(batch.id); expect(restored.active).toBe(false); expect(restored.status).toBe('invalid');
        const state = await checkpoint('old-backup-new-process-invalid-derived'); expect(state.memories.some((memory) => memory.id === sourceIds[1])).toBe(false);
        expect(JSON.stringify(state.consolidationBatches)).not.toContain(facts[1]!); expect(JSON.stringify(state.backgroundJobs)).not.toContain(facts[1]!); await expect(apply(batch)).rejects.toThrow();
        const wire = await freshChat(); expect(JSON.stringify(wire.body)).not.toContain(facts[1]!); expect(JSON.stringify(wire.body)).toContain('RAW_RECORD_0_'); expect(jobs()).toHaveLength(1);
      } else if (scenario === 'late-generation-invalid') {
        const draft = await preview(); responseMode = 'held';
        await page!.evaluate((id) => window.deskpet.consolidation.generate({ id, operationId: crypto.randomUUID() }), draft.id); await expect.poll(() => held.length).toBe(1);
        await update(0, `LATE_CURRENT_${marker}: Aster setting is now 73 mL only during bench tests.`);
        for (const response of held) {
          order.push({ action: 'attempt-delivery-of-stale-completion-after-source-correction', socketAlreadyClosed: response.destroyed });
          if (!response.destroyed) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(requests[0]!.responseBody); }
        }
        const invalid = await get(draft.id); expect(invalid.status).toBe('invalid'); expect(invalid.candidate).toBeNull(); expect(invalid.rawResponse).toBeNull(); await expect(apply(invalid)).rejects.toThrow();
        const wire = await freshChat(); expect(JSON.stringify(wire.body)).not.toContain(facts[0]!); expect(JSON.stringify(wire.body)).toContain('LATE_CURRENT_'); expect(jobs()).toHaveLength(1);
        const state = await checkpoint('late-result-source-invalid-no-publication'); expect(JSON.stringify(state.consolidationBatches)).not.toContain(facts[0]!);
        expect(JSON.stringify(state.backgroundJobs)).not.toContain(facts[0]!);
      } else if (scenario === 'ancestor-revocation-final-send') {
        const batch = await ready(); await apply(batch);
        const sendInSourceSession = async (content: string): Promise<void> => {
          await page!.evaluate((input) => window.deskpet.chat.send(input), { sessionId, content, providerId, model: 'ep4-fixture' });
          await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.status).toBe('complete');
        };
        const firstQuestion = `FIRST_HISTORY_${marker} ${'x'.repeat(19_000)}`; await sendInSourceSession(firstQuestion);
        const firstState = await checkpoint('ancestor-first-summary-request');
        const firstAssistant = firstState.chatMessages.filter((message) => message.sessionId === sessionId && message.role === 'assistant').at(-1)!;
        expect(firstAssistant.contextTrace?.representationReferences?.some((reference) => reference.batchId === batch.id)).toBe(true);
        for (let index = 0; index < 3; index++) await page!.evaluate((input) => window.deskpet.memory.upsert(input), {
          id: randomUUID(), text: `FILLER_ONLY ${'f'.repeat(2200)} ${index}`, tags: ['FILLER_ONLY'], privacy: 'local-only' as const, scope: { kind: 'global' as const },
        });
        await sendInSourceSession(`FILLER_ONLY follow-up ${'y'.repeat(6_000)}`); const secondWire = chats().at(-1)!;
        expect(secondWire.body.messages.some((message) => message.role === 'user' && message.content === firstQuestion)).toBe(true);
        expect(secondWire.body.messages.some((message) => message.content.startsWith('Reviewed derived memory representation'))).toBe(false);
        const secondState = await checkpoint('ancestor-second-history-only-request');
        const secondAssistant = secondState.chatMessages.filter((message) => message.sessionId === sessionId && message.role === 'assistant').at(-1)!;
        expect(secondAssistant.contextTrace?.representationReferences?.some((reference) => reference.batchId === batch.id)).toBe(true);
        const prefix = `FILLER_ONLY FINAL_HELD_${randomUUID()}`; const thirdQuestion = `${prefix} ${'z'.repeat(14_000)}`;
        faultArmed = true;
        await application!.evaluate(({ app, safeStorage }, config) => {
          if (app.isPackaged || app.getPath('userData') !== config.profile) throw new Error('Ancestor probe outside owned profile');
          const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
          const fs = runtime.mainModule.require('node:fs') as typeof Fs; const fsp = runtime.mainModule.require('node:fs/promises') as typeof Fsp; const crypto = runtime.mainModule.require('node:crypto') as typeof Crypto;
          const originalRename = fsp.rename; const originalRead = fsp.readFile; let releaseCredential!: () => void;
          const probe = { prepared: false, held: false, release: () => { fsp.rename = originalRename; fsp.readFile = originalRead; releaseCredential?.(); } };
          (globalThis as typeof globalThis & { __ep4Ancestor?: typeof probe }).__ep4Ancestor = probe;
          const secretPath = `${config.profile}/vault/provider-secrets/${crypto.createHash('sha256').update(config.providerId).digest('hex')}.safe`;
          fsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
            const value = await originalRead(...args); if (String(args[0]) === secretPath && probe.prepared && !probe.held) { probe.held = true; await new Promise<void>((resolve) => { releaseCredential = resolve; }); } return value;
          }) as typeof fsp.readFile;
          fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
            await originalRename(...args); if (String(args[1]) !== `${config.profile}/profile.enc.json` || probe.prepared) return;
            const envelope = JSON.parse(fs.readFileSync(String(args[1]), 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
            const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${config.profile}/vault/vault-key.safe`)), 'base64');
            try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
              const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as PersistentState;
              const user = state.chatMessages.find((message) => message.role === 'user' && message.content.startsWith(config.prefix));
              probe.prepared = Boolean(user && state.chatMessages.some((message) => message.role === 'assistant' && message.requestReceipts?.some((receipt) => receipt.userMessageId === user.id && receipt.phase === 'prepared')));
            } finally { key.fill(0); }
          };
        }, { profile, providerId, prefix });
        const beforeThird = chats().length; await page!.evaluate((input) => window.deskpet.chat.send(input), { sessionId, content: thirdQuestion, providerId, model: 'ep4-fixture' });
        await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep4Ancestor?: { held: boolean } }).__ep4Ancestor?.held))).toBe(true);
        const prepared = await checkpoint('ancestor-final-prepared-before-disable'); const receipt = prepared.chatMessages.filter((message) => message.role === 'assistant' && message.sessionId === sessionId).at(-1)!.requestReceipts!.at(-1)!;
        expect(receipt.phase).toBe('prepared'); expect(receipt.contextTrace.privacy).toBe('local-only');
        expect(receipt.contextTrace.historyMessageIds).toEqual(expect.arrayContaining([firstAssistant.id, secondAssistant.id]));
        expect(receipt.contextTrace.summaryReferences).toContainEqual({messageId:firstAssistant.id, contentSHA256:hash(firstAssistant.content)});
        expect(receipt.excludedContext?.summarizedCount).toBe(2);
        expect(receipt.contextTrace.representationReferences).toContainEqual({batchId:batch.id, candidateVersion:batch.candidateVersion});
        await page!.evaluate((id) => window.deskpet.consolidation.disable({ id, operationId: crypto.randomUUID() }), batch.id);
        await application!.evaluate(() => (globalThis as typeof globalThis & { __ep4Ancestor?: { release: () => void } }).__ep4Ancestor?.release()); faultArmed = false;
        await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.status).toBe('failed');
        const revoked = await checkpoint('ancestor-revoked-final-zero-HTTP');
        const failed = revoked.chatMessages.filter(message => message.sessionId === sessionId && message.role === 'assistant').at(-1)!;
        expect(revoked.consolidationBatches.find(item => item.id === batch.id)?.status).toBe('disabled');
        expect(failed.errorCode).toBe('chat.contextStale'); expect(failed.requestReceipts?.at(-1)?.phase).toBe('prepared');
        expect(chats()).toHaveLength(beforeThird); order.push({ action: 'ancestor-derived-history-final-send-denied', actualHTTPBefore: beforeThird, actualHTTPAfter: chats().length });
      } else {
        const batch = await ready(); const op = randomUUID(); await installFault(batch.id, 'applied', true);
        await expect(apply(batch, op)).rejects.toThrow('repository.commitUncertain'); expect(await faultHit()).toBe(true);
        const durable = await checkpoint('uncertain-durable-authority'); expect(durable.consolidationBatches.find((value) => value.id === batch.id)?.status).toBe('applied');
        const count = requests.length; await expect(get(batch.id)).rejects.toThrow('repository.commitUncertain'); await expect(freshChat()).rejects.toThrow(); expect(requests).toHaveLength(count);
        await application!.evaluate(() => (globalThis as typeof globalThis & { __ep4Fault?: { release: () => void } }).__ep4Fault?.release()); faultArmed = false;
        const recovered = await get(batch.id); expect(recovered.status).toBe('applied'); await apply(batch, op); expect(jobs()).toHaveLength(1);
        expect(invariantFacts((await checkpoint('uncertain-recovered-original-receipt')).memories)).toEqual(originalFacts);
      }
      for (const request of jobs()) { expect(request.body.tools).toBeUndefined(); expect(request.body.tool_choice).toBe('none'); expect(request.fakeCredentialMatches).toBe(true);
        expect(JSON.stringify(request.body)).not.toContain(unselected); expect(JSON.stringify(request.body)).not.toContain(fakeCredential); }
      expect(JSON.stringify(checkpoints)).not.toContain(fakeCredential);
      const metrics = await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      order.push({ action: 'final-actual-process-metrics', metrics }); expect(JSON.stringify(order)).toContain('DeskPet Provider Runtime');
      await page!.screenshot({ path: join(directory, 'final.png'), fullPage: true }); verdict = 'PASS';
    } catch (error) {
      verdict = 'FAIL'; failure = error instanceof Error ? error.stack ?? error.message : String(error);
      try { await page?.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); } catch { /* Process fault may have closed renderer. */ }
      if (application) { try { await checkpoint('failure'); } catch { /* Preserve other independent observations. */ } } throw error;
    } finally {
      if (application) {
        try { order.push({ action: 'pre-close-owned-processes', metrics: await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName }))) }); } catch { /* Already stopped. */ }
        const pid = application.process().pid;
        if (faultArmed && pid) { try { process.kill(pid, 'SIGKILL'); order.push({ action: 'fault-cleanup-owned-main-SIGKILL', pid }); } catch { /* Already exited. */ } }
        else try { await application.close(); } catch { if (pid) { try { process.kill(pid, 'SIGKILL'); order.push({ action: 'cleanup-owned-main-SIGKILL', pid }); } catch { /* Already exited. */ } } }
      }
      for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeFile(join(directory, 'evidence.json'), JSON.stringify({ scenario, verdict, failure, root, profile, entry, mainBundleSHA256, utilityBundleSHA256, launches,
        configuration: { normalRendererSecurity: true, isolatedProfile: true, controlledHTTP: true, providerUtilityBypassed: false, actualModelCalls: 0,
          instrumentation: scenario === 'candidate-crash' || scenario === 'apply-ack-crash' ? 'AES authenticated fs.rename post-publication acknowledgement barrier + actual owned SIGKILL + new process' : scenario === 'commit-uncertain' ? 'actual post-rename exception and authoritative read fault, released to recover receipt' : scenario === 'old-backup-restore' ? 'native file picker and restore confirmation mocked to own synthetic backup; actual Settings save/restore/restart path' : scenario === 'ancestor-revocation-final-send' ? 'real credential read barrier after prepared receipt, history budget retains ancestor by hashed excerpt, actual summary disable before final utility dispatch' : null },
        syntheticInputs: { marker, sourceIds, facts, originals, unselected, sessionId, providerId, remoteId }, requests, metadata, order, checkpoints,
        closure: { recordingServerClosed: !server.listening, profileRetained: true } }, null, 2));
      await info.attach('consolidation-evidence', { path: join(directory, 'evidence.json'), contentType: 'application/json' });
    }
  });
}
