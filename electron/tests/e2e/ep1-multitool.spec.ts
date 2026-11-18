import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeFs from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentState } from '../../src/main/domain/schemas';

interface WireRequest {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}
type Scenario = 'telemetry-only' | 'correction' | 'deletion' | 'privacy-revocation' | 'capability-revocation';
const archive = '/private/tmp/deskpet/output/deskpet-electron-p1-closeout-20261028/multitool';
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const scenarios: Scenario[] = ['telemetry-only', 'correction', 'deletion', 'privacy-revocation', 'capability-revocation'];

for (const scenario of scenarios) {
  // eslint-disable-next-line no-empty-pattern
  test(`E-P1 production utility tool rounds: ${scenario}`, async ({}, info) => {
    test.setTimeout(120_000);
    const profile = await mkdtemp(join(tmpdir(), 'deskpet-ep1-multitool-'));
    const artifactRoot = join(archive, `${new Date().toISOString().replaceAll(':', '-')}-${scenario}`); await mkdir(artifactRoot, { recursive: true });
    const marker = `E_P1_MULTITOOL_${scenario.replaceAll('-', '_').toUpperCase()}_ORIGINAL`;
    const requests: Array<{ receivedAt: string; path: string; bodySHA256: string; body: WireRequest }> = [];
    const auxiliaryRequests: Array<{ path: string; raw: string }> = [];
    const checkpoints: Array<{ phase: string; state: PersistentState }> = [];
    const launches: unknown[] = [];
    let application: ElectronApplication | undefined; let page: Page | undefined;
    let held: ServerResponse | undefined; let first: WireRequest | undefined;
    let verdict = 'RUNNING'; let failure: string | undefined;
    const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainBundleSHA256 = sha256(await readFile(entry));
    const toolReply = (response: ServerResponse, request: WireRequest, round: number): void => {
      const name = request.tools?.find((tool) => tool.function.description.startsWith('Current time.'))?.function.name;
      if (!name) { response.writeHead(500); response.end('Expected authorized time tool'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `ep1_time_${round}`, function: { name, arguments: '{"timezone":"UTC"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!request.url?.endsWith('/chat/completions')) {
          auxiliaryRequests.push({ path: request.url ?? '', raw });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(request.url?.endsWith('/api/show')
            ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } }
            : { data: [{ id: 'ep1-synthetic-tools', object: 'model' }] })); return;
        }
        const body = JSON.parse(raw) as WireRequest;
        requests.push({ receivedAt: new Date().toISOString(), path: request.url ?? '', bodySHA256: sha256(raw), body });
        if (requests.length === 1) { first = body; held = response; return; }
        if (requests.length === 2) { toolReply(response, body, 2); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'E_P1_TWO_TOOL_ROUNDS_COMPLETE' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const launch = async (): Promise<void> => {
      application = await electron.launch({ args: [entry], cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
      await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible();
      await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
      await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const identity = await page.evaluate(() => window.deskpet.app.getDiagnostics());
      expect(identity.runtimeIdentity!.dataDirectory).toBe(profile);
      expect(identity.runtimeIdentity!.mainBundleSHA256).toBe(mainBundleSHA256);
      launches.push(identity.runtimeIdentity);
      const security = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => {
        const contents = window.webContents as typeof window.webContents & { getLastWebPreferences(): Electron.WebPreferences };
        const p = contents.getLastWebPreferences();
        return { sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, webSecurity: p.webSecurity };
      }));
      for (const config of security) expect(config).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
    };
    const disk = async (): Promise<PersistentState> => application!.evaluate(({ app, safeStorage }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Wrong isolated profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFs;
      const crypto = runtime.mainModule.require('node:crypto') as typeof NodeCrypto;
      const envelope = JSON.parse(fs.readFileSync(`${expectedProfile}/profile.enc.json`, 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
      const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${expectedProfile}/vault/vault-key.safe`)), 'base64');
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as PersistentState;
      } finally { key.fill(0); }
    }, profile);
    const checkpoint = async (phase: string): Promise<PersistentState> => {
      const state = await disk(); checkpoints.push({ phase, state });
      await copyFile(join(profile, 'profile.enc.json'), join(artifactRoot, `${phase}.enc.json`)); return state;
    };
    try {
      await launch();
      const providerId = randomUUID(); const memoryId = randomUUID();
      await page!.evaluate(async ({ providerId, baseUrl, memoryId, marker }) => {
        await window.deskpet.providers.upsert({ id: providerId, kind: 'ollama', name: 'E-P1 controlled HTTP tool fixture', baseUrl,
          model: 'ep1-synthetic-tools', enabled: true, supportsTools: true, localExecutionConfirmed: false, contextWindowTokens: 32768, maxOutputTokens: 512 });
        await window.deskpet.providers.select(providerId);
        await window.deskpet.permissions.request({ capabilityId: 'time.read', duration: 'always' });
        await window.deskpet.memory.upsert({ id: memoryId, operationId: crypto.randomUUID(), text: marker, tags: ['ep1-synthetic'], privacy: 'cloud-allowed' });
      }, { providerId, baseUrl: `http://127.0.0.1:${address.port}/v1`, memoryId, marker });
      const initial = await checkpoint('initial'); const memory = initial.memories.find((item) => item.id === memoryId)!;
      const revision = memory.contextMetadata!.revision;
      await page!.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click();
      await page!.locator('.composer textarea').fill(`E_P1_SYNTHETIC_TOOL_ROUND_PROBE ${marker}`);
      await page!.locator('.composer textarea').press('Enter');
      await expect.poll(() => requests.length).toBe(1);
      expect(JSON.stringify(requests[0]!.body)).toContain(marker);
      await expect.poll(async () => (await disk()).memories.find((item) => item.id === memoryId)?.contextMetadata?.sentCount).toBe(1);
      const sent = await checkpoint('first-http-observed');
      expect(sent.memories.find((item) => item.id === memoryId)?.contextMetadata).toMatchObject({ revision, sentCount: 1 });
      expect(sent.memoryRevision).toBe(initial.memoryRevision);
      expect(sent.memories.find((item) => item.id === memoryId)?.contextMetadata?.lastSentAt).not.toBeNull();
      const utility = await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      expect(utility.some((metric) => metric.name === 'DeskPet Provider Runtime' || metric.serviceName === 'DeskPet Provider Runtime')).toBe(true);
      await writeFile(join(artifactRoot, 'utility-process.json'), JSON.stringify(utility, null, 2));
      if (scenario === 'correction' || scenario === 'privacy-revocation') {
        await page!.evaluate(({ id, revision, text, privacy }) => window.deskpet.memory.upsert({ id, expectedRevision: revision, operationId: crypto.randomUUID(), text, tags: ['ep1-synthetic'], privacy }),
          { id: memoryId, revision, text: scenario === 'correction' ? `${marker}_CORRECTED` : marker, privacy: scenario === 'privacy-revocation' ? 'local-only' as const : 'cloud-allowed' as const });
      } else if (scenario === 'deletion') {
        await page!.evaluate(({ id, revision }) => window.deskpet.memory.remove(id, { expectedRevision: revision, operationId: crypto.randomUUID() }), { id: memoryId, revision });
      } else if (scenario === 'capability-revocation') await page!.evaluate(() => window.deskpet.permissions.revoke('time.read'));
      await checkpoint('before-response-release');
      if (!held || !first) throw new Error('Missing held production request');
      toolReply(held, first, 1); held = undefined;
      if (scenario === 'capability-revocation') {
        // Revoked mid-request: nothing runs, the host asks again, and denying ends the run.
        const card = page!.getByRole('region', { name: 'This step needs your approval', exact: true });
        await expect(card).toBeVisible(); await card.getByRole('button', { name: 'Deny' }).click();
      }
      const allowed = scenario === 'telemetry-only';
      await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', allowed ? 'complete' : 'failed');
      const final = await checkpoint('completed');
      const reply = final.chatMessages.filter((message) => message.role === 'assistant').at(-1)!;
      if (allowed) {
        expect(requests).toHaveLength(3); expect(reply.content).toBe('E_P1_TWO_TOOL_ROUNDS_COMPLETE');
        expect(reply.requestReceipts).toHaveLength(3);
        expect(final.memories.find((item) => item.id === memoryId)?.contextMetadata).toMatchObject({ revision, sentCount: 3 });
        expect(final.memoryRevision).toBe(initial.memoryRevision);
        for (const request of requests) expect(JSON.stringify(request.body)).toContain(marker);
        expect(requests[1]!.body.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
        expect(requests[2]!.body.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
      } else {
        expect(requests).toHaveLength(1); expect(reply.requestReceipts).toHaveLength(1);
        expect(reply.errorCode).toBe(scenario === 'capability-revocation' ? 'chat.approvalDenied' : 'chat.contextStale');
        await expect(page!.getByRole('alert')).toBeVisible();
      }
      for (const receipt of reply.requestReceipts ?? []) {
        expect(receipt.phase).toBe('terminal');
        expect(requests.some((request) => request.bodySHA256 === receipt.expectedBodySHA256)).toBe(true);
        expect(receipt.observations.some((observation) => observation.phase === 'fetch-invoked')).toBe(true);
        expect(receipt.observations.some((observation) => observation.phase === 'response-received')).toBe(true);
      }
      await page!.screenshot({ path: join(artifactRoot, 'gui-result.png'), fullPage: true });
      await application!.close(); application = undefined; await launch();
      const restarted = await checkpoint('new-process-read');
      expect(restarted.memoryRevision).toBe(final.memoryRevision);
      expect(restarted.memories).toEqual(final.memories);
      expect(restarted.chatMessages.find((message) => message.id === reply.id)).toEqual(reply);
      expect(await page!.evaluate(() => window.deskpet.memory.list())).toEqual(final.memories);
      verdict = 'PASS';
    } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
    finally {
      if (verdict !== 'PASS') verdict = 'FAIL';
      const evidence = { scenario, verdict, failure, profile, entry, mainBundleSHA256, launches, syntheticInput: marker,
        operationOrder: ['create synthetic cloud-allowed memory', 'send renderer chat through preload/IPC/utility', 'observe transport telemetry', scenario,
          'release tool call', 'allow two tool rounds or reject continuation', 'restart and read encrypted authority'], requests, auxiliaryRequests, checkpoints,
        configuration: { securityOverrides: [], providerEndpoint: 'controlled loopback HTTP', realModelCalls: 0, personalProfileUsed: false } };
      await writeFile(join(artifactRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
      await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
      held?.destroy(); await application?.close(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Retain this synthetic isolated profile and encrypted snapshots for recovery evidence.
    }
  });
}
