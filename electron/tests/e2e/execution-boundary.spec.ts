import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeFs from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentState } from '../../src/main/domain/schemas';

interface Wire { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }
interface ToolCall { name: string; input: unknown; id?: string }
type Scenario = 'native-and-allowed' | 'write-traversal' | 'write-symlink' | 'read-traversal' | 'read-symlink'
  | 'tools-disabled' | 'unknown-tool' | 'same-batch-private-web' | 'wrapped-next-round-web' | 'local-history-remote'
  | 'clear-credential' | 'revoke-before-response' | 'cancel-issued-request';
const scenarios: Scenario[] = ['native-and-allowed', 'write-traversal', 'write-symlink', 'read-traversal', 'read-symlink',
  'tools-disabled', 'unknown-tool', 'same-batch-private-web', 'wrapped-next-round-web', 'local-history-remote',
  'clear-credential', 'revoke-before-response', 'cancel-issued-request'];
const archive = '/private/tmp/deskpet/output/deskpet-electron-tool-boundary-20261028/execution-boundary/e2e';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

for (const scenario of scenarios) {
  // eslint-disable-next-line no-empty-pattern
  test(`production execution boundary: ${scenario}`, async ({}, info) => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-execution-e2e-'));
    const profile = join(root, 'profile'); const aRoot = join(profile, 'workspace'); const bRoot = join(root, 'outside-B');
    await mkdir(aRoot, { recursive: true }); await mkdir(bRoot);
    const aMarker = `SYNTHETIC_ALLOWED_A_${scenario}`; const bMarker = `SYNTHETIC_DENIED_B_${scenario}`;
    await writeFile(join(aRoot, 'allowed.txt'), aMarker); await writeFile(join(bRoot, 'secret.txt'), bMarker);
    await symlink(bRoot, join(aRoot, 'shortcut'));
    const directory = join(archive, `${new Date().toISOString().replaceAll(':', '-')}-${scenario}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { recursive: true });
    const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js'); const mainBundleSHA256 = hash(await readFile(entry));
    const requests: Array<{ path: string; body: Wire; bodySHA256: string; authorizationPresent: boolean; fakeCredentialMatches: boolean }> = [];
    const auxiliary: Array<{ path: string; bodySHA256: string }> = [];
    const receiverRequests: Array<{ path: string; bodySHA256: string }> = [];
    const checkpoints: Array<{ phase: string; state: PersistentState }> = [];
    const launches: unknown[] = []; const order: unknown[] = [];
    const fakeCredential = `FAKE_ONLY_BOUNDARY_${randomUUID()}`;
    let application: ElectronApplication | undefined; let page: Page | undefined;
    let held: ServerResponse | undefined; let first: Wire | undefined; let responseClosed = false;
    let verdict = 'RUNNING'; let failure: string | undefined; let providerId = ''; let localExecutionConfirmed = true;
    const wireName = (body: Wire, internal: string): string => {
      const description = internal === 'workspace.write' ? 'Write workspace file.' : internal === 'workspace.read' ? 'Read workspace file.'
        : internal === 'web.read' ? 'Read HTTPS page.' : internal === 'time.current' ? 'Current time.' : '';
      const found = body.tools?.find((tool) => tool.function.description.startsWith(description));
      if (!found) throw new Error(`Fixture expected declared ${internal}`); return found.function.name;
    };
    const reply = (response: ServerResponse, calls?: ToolCall[], content = 'SYNTHETIC_BOUNDARY_COMPLETE'): void => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = calls ? { tool_calls: calls.map((call, index) => ({ index, id: call.id ?? `untrusted-model-label-${index}`, function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : { content };
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    };
    const chooseResponse = (body: Wire, response: ServerResponse, round: number): void => {
      const call = (internal: string, input: unknown, id?: string): ToolCall => ({ name: wireName(body, internal), input, ...(id ? { id } : {}) });
      const externalUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/tool-exfil?marker=${aMarker}`;
      if (round === 1) {
        if (scenario === 'clear-credential' || scenario === 'revoke-before-response' || scenario === 'cancel-issued-request') {
          first = body; held = response; response.once('close', () => { responseClosed = true; }); return;
        }
        if (scenario === 'tools-disabled') { reply(response, [{ name: 'workspace.write', input: { path: 'allowed.txt', content: 'UNEXPECTED_DISABLED_WRITE' } }]); return; }
        if (scenario === 'unknown-tool') { reply(response, [{ name: 'not_a_registered_or_declared_tool', input: { owner: 'forged', sessionId: 'forged' } }]); return; }
        if (scenario === 'same-batch-private-web') {
          reply(response, [call('workspace.read', { path: 'allowed.txt' }, 'wrapped-source-id'), call('web.read', { url: externalUrl }, 'fresh-external-id')]); return;
        }
        if (scenario === 'wrapped-next-round-web' || scenario === 'local-history-remote') { reply(response, [call('workspace.read', { path: 'allowed.txt' }, 'old-source-id')]); return; }
        if (scenario === 'write-traversal') { reply(response, [call('workspace.write', { path: '../../outside-B/secret.txt', content: 'UNEXPECTED_OUTSIDE_WRITE' })]); return; }
        if (scenario === 'write-symlink') { reply(response, [call('workspace.write', { path: 'shortcut/new/nested/target.txt', content: 'UNEXPECTED_OUTSIDE_WRITE' })]); return; }
        if (scenario === 'read-traversal') { reply(response, [call('workspace.read', { path: '../../outside-B/secret.txt' })]); return; }
        if (scenario === 'read-symlink') { reply(response, [call('workspace.read', { path: 'shortcut/secret.txt' })]); return; }
        reply(response, [call('workspace.write', { path: 'allowed.txt', content: `${aMarker}_WRITTEN` })]); return;
      }
      if (scenario === 'native-and-allowed' && round === 2) { reply(response, [call('workspace.read', { path: 'allowed.txt' }, 'new-read-object-id')]); return; }
      if (scenario === 'wrapped-next-round-web' && round === 2) {
        // Canonical ID plus a fresh model label cannot turn local material into
        // an authorized network action after its declaration was removed.
        reply(response, [{ name: 'web.read', input: { url: externalUrl }, id: 'brand-new-wrapper-id' }]); return;
      }
      reply(response, undefined, scenario === 'local-history-remote' && round === 2 ? `LOCAL_DERIVED_${aMarker}` : 'SYNTHETIC_BOUNDARY_COMPLETE');
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (request.url?.startsWith('/tool-exfil')) { receiverRequests.push({ path: request.url, bodySHA256: hash(raw) }); response.end('unexpected receiver request'); return; }
        if (!request.url?.endsWith('/chat/completions')) {
          auxiliary.push({ path: request.url ?? '', bodySHA256: hash(raw) }); response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } } : { data: [{ id: 'boundary-synthetic' }] })); return;
        }
        const body = JSON.parse(raw) as Wire;
        requests.push({ path: request.url ?? '', body, bodySHA256: hash(raw), authorizationPresent: typeof request.headers.authorization === 'string', fakeCredentialMatches: request.headers.authorization === `Bearer ${fakeCredential}` });
        chooseResponse(body, response, requests.length);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
    const bSnapshot = async (): Promise<{ entries: string[]; text: string; sha256: string }> => {
      const entries: string[] = []; const walk = async (path: string, prefix: string): Promise<void> => {
        for (const name of await readdir(path, { withFileTypes: true })) { const relative = `${prefix}${name.name}`; entries.push(relative + (name.isDirectory() ? '/' : '')); if (name.isDirectory()) await walk(join(path, name.name), `${relative}/`); }
      }; await walk(bRoot, ''); const text = await readFile(join(bRoot, 'secret.txt'), 'utf8'); return { entries: entries.sort(), text, sha256: hash(text) };
    };
    const beforeB = await bSnapshot();
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
    const setDialogResponse = async (response: number): Promise<void> => application!.evaluate((_electron, value) => {
      const globals = globalThis as typeof globalThis & { __boundaryDialogs: { responses: number[]; calls: unknown[] } }; globals.__boundaryDialogs.responses.push(value);
    }, response);
    const grant = async (capabilityId: string): Promise<void> => { await setDialogResponse(1); await page!.evaluate((id) => window.deskpet.permissions.request({ capabilityId: id, duration: 'always' }), capabilityId); order.push({ action: 'native-confirmed-grant', capabilityId }); };
    const send = async (text: string, status: 'complete' | 'failed' | 'cancelled'): Promise<void> => {
      const count = await page!.locator('.message.assistant').count(); await page!.locator('.composer textarea').fill(text); await page!.locator('.composer textarea').press('Enter');
      await expect(page!.locator('.message.assistant')).toHaveCount(count + 1); await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', status); order.push({ action: 'gui-send-finished', text, status });
    };
    try {
      const launchEnvironment: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) launchEnvironment[key] = process.env[key]!;
      application = await electron.launch({ args: [entry], cwd: process.cwd(), env: launchEnvironment });
      await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible();
      await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const identity = await page.evaluate(() => window.deskpet.app.getDiagnostics()); expect(identity.runtimeIdentity!.dataDirectory).toBe(profile); expect(identity.runtimeIdentity!.mainBundleSHA256).toBe(mainBundleSHA256); launches.push(identity.runtimeIdentity);
      const security = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => {
        const webContents = window.webContents as typeof window.webContents & { getLastWebPreferences(): Electron.WebPreferences }; const prefs = webContents.getLastWebPreferences();
        return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
      }));
      for (const prefs of security) expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
      await writeFile(join(directory, 'security-preferences.json'), JSON.stringify(security, null, 2));
      await application.evaluate(({ dialog, app }, expectedProfile) => {
        if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Dialog instrumentation outside isolated profile');
        const globals = globalThis as typeof globalThis & { __boundaryDialogs: { responses: number[]; calls: unknown[] } };
        globals.__boundaryDialogs = { responses: [], calls: [] };
        dialog.showMessageBox = async (...args: unknown[]) => { const options = args.at(-1); const response = globals.__boundaryDialogs.responses.shift() ?? 0; globals.__boundaryDialogs.calls.push({ options, response }); return { response, checkboxChecked: false }; };
      }, profile);
      providerId = randomUUID();
      await page.evaluate(async (config) => { await window.deskpet.providers.upsert(config); await window.deskpet.providers.select(config.id); }, {
        id: providerId, kind: 'ollama' as const, name: 'Controlled execution boundary provider', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'boundary-synthetic', enabled: true,
        supportsTools: scenario !== 'tools-disabled', localExecutionConfirmed, contextWindowTokens: 32768, maxOutputTokens: 512, apiKey: fakeCredential,
      });
      if (scenario === 'native-and-allowed') {
        await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
        const article = page.getByRole('article', { name: 'Write workspace files', exact: true });
        await setDialogResponse(0); await article.getByRole('button', { name: 'Always allow', exact: true }).click();
        await expect(article.locator('[data-permission-state]')).toHaveAttribute('data-permission-state', 'not-requested');
        await expect(article.getByRole('alert')).toBeVisible(); order.push({ action: 'native-cancel-refused-write-grant' });
        await setDialogResponse(1); await article.getByRole('button', { name: 'Always allow', exact: true }).click();
        await expect(article.locator('[data-permission-state]')).toHaveAttribute('data-permission-state', 'always');
        const unknown = await page.evaluate(async () => { try { await window.deskpet.permissions.request({ capabilityId: 'forged.shell', duration: 'always' }); return 'UNEXPECTED'; } catch (error) { return (error as Error).message; } });
        expect(unknown).toContain('tool.permission');
      } else await grant('workspace.write');
      await grant('workspace.read');
      if (scenario.includes('web')) await grant('web.read');
      if (scenario === 'clear-credential') await grant('time.read');
      await checkpoint('before-request');
      await page.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click();
      if (scenario === 'clear-credential' || scenario === 'revoke-before-response' || scenario === 'cancel-issued-request') {
        await page.locator('.composer textarea').fill('SYNTHETIC_BOUNDARY_HELD_REQUEST'); await page.locator('.composer textarea').press('Enter');
        await expect.poll(() => requests.length).toBe(1); const issued = await checkpoint('request-issued');
        if (scenario === 'clear-credential') { await page.evaluate((id) => window.deskpet.providers.clearSecret(id), providerId); order.push({ action: 'clear-current-provider-fake-credential' }); }
        if (scenario === 'revoke-before-response') { await page.evaluate(() => window.deskpet.permissions.revoke('workspace.write')); order.push({ action: 'revoke-after-issued-before-tool-returned' }); }
        if (scenario === 'cancel-issued-request') {
          const runId = issued.chatMessages.filter((message) => message.role === 'assistant').at(-1)!.requestReceipts!.at(-1)!.runId;
          if (!runId) throw new Error('Missing host run identity');
          await page.evaluate((id) => window.deskpet.chat.cancel(id), runId); order.push({ action: 'cancel-after-receiver-observed-request', runId });
          await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'cancelled');
          await expect.poll(() => responseClosed).toBe(true);
        } else {
          if (!held || !first) throw new Error('Missing held request');
          reply(held, [{ name: wireName(first, scenario === 'clear-credential' ? 'time.current' : 'workspace.write'), input: scenario === 'clear-credential' ? { timezone: 'UTC' } : { path: 'allowed.txt', content: 'UNEXPECTED_REVOKED_WRITE' } }]); held = undefined;
          if (scenario === 'revoke-before-response') {
            // Revoked mid-request: nothing runs, the host asks again, and denying ends the run.
            const card = page.getByRole('region', { name: 'This step needs your approval', exact: true });
            await expect(card).toBeVisible(); expect(await readFile(join(aRoot, 'allowed.txt'), 'utf8')).toBe(aMarker);
            await card.getByRole('button', { name: 'Deny' }).click();
          }
          await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'failed');
        }
        expect(requests).toHaveLength(1); expect(await readFile(join(aRoot, 'allowed.txt'), 'utf8')).toBe(aMarker);
      } else {
        const allowed = scenario === 'native-and-allowed' || scenario === 'local-history-remote' || scenario === 'same-batch-private-web';
        await send(`SYNTHETIC_EXECUTION_BOUNDARY_${scenario}`, allowed ? 'complete' : 'failed');
      }
      let final = await checkpoint('completed'); let assistant = final.chatMessages.filter((message) => message.role === 'assistant').at(-1)!;
      const errors: Partial<Record<Scenario, string>> = { 'write-traversal': 'tool.fileAccess', 'write-symlink': 'tool.fileAccess', 'read-traversal': 'tool.fileAccess', 'read-symlink': 'tool.fileAccess',
        'tools-disabled': 'tool.notDeclared', 'unknown-tool': 'tool.notDeclared', 'wrapped-next-round-web': 'tool.notDeclared', 'clear-credential': 'provider.bindingMismatch', 'revoke-before-response': 'chat.approvalDenied' };
      if (errors[scenario]) { expect(assistant.errorCode).toBe(errors[scenario]); await expect(page.getByRole('alert')).toBeVisible(); }
      if (scenario === 'native-and-allowed') {
        expect(requests).toHaveLength(3); expect(await readFile(join(aRoot, 'allowed.txt'), 'utf8')).toBe(`${aMarker}_WRITTEN`);
        expect(JSON.stringify(requests[2]!.body.messages.filter((message) => message.role === 'tool'))).toContain(`${aMarker}_WRITTEN`);
      } else if (scenario !== 'local-history-remote') expect(await readFile(join(aRoot, 'allowed.txt'), 'utf8')).toBe(aMarker);
      if (scenario === 'same-batch-private-web') {
        // The read runs, the web call in the same batch is declined and the model is told. Nothing reaches the receiver.
        expect(requests).toHaveLength(2); const events = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
        expect(events.some((event) => event.metadata.toolId === 'web.read' && event.metadata.errorCode === 'tool.contextPrivacyBlocked')).toBe(true);
        expect(events.some((event) => event.metadata.toolId === 'web.read' && event.status === 'running' && event.summary.includes('completed'))).toBe(false);
        expect(JSON.stringify(requests[1]!.body.messages.filter((message) => message.role === 'tool'))).toContain('tool.contextPrivacyBlocked');
      }
      if (scenario === 'wrapped-next-round-web') { expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1]!.body)).toContain(aMarker); expect(requests[1]!.body.tools?.some((tool) => tool.function.description.startsWith('Read HTTPS page.'))).toBe(false); }
      if (scenario === 'local-history-remote') {
        expect(requests).toHaveLength(2); expect(assistant.contextTrace?.privacy).toBe('local-only');
        expect(requests[1]!.body.messages.some((message) => message.role === 'tool' && message.content.includes(aMarker))).toBe(true);
        const current = await page.evaluate((id) => window.deskpet.providers.list().then((providers) => providers.find((provider) => provider.id === id)!), providerId);
        localExecutionConfirmed = false; await page.evaluate(({ secretState, ...config }) => { void secretState; return window.deskpet.providers.upsert({ ...config, localExecutionConfirmed: false }); }, current);
        await send('SYNTHETIC_INDEPENDENT_FOLLOWUP_WITHOUT_LOCAL_CONTENT', 'complete');
        expect(requests).toHaveLength(3); expect(JSON.stringify(requests[2]!.body)).not.toContain(aMarker); expect(JSON.stringify(requests[2]!.body)).not.toContain('LOCAL_DERIVED_');
        final = await checkpoint('remote-unknown-followup'); assistant = final.chatMessages.filter((message) => message.role === 'assistant').at(-1)!;
      }
      expect(await bSnapshot()).toEqual(beforeB); expect(receiverRequests).toEqual([]);
      for (const request of requests) expect(JSON.stringify(request.body)).not.toContain(bMarker);
      expect(requests.every((request) => request.fakeCredentialMatches)).toBe(true);
      expect(requests.every((request) => request.authorizationPresent)).toBe(true);
      for (const receipt of assistant.requestReceipts ?? []) if (receipt.phase === 'terminal') expect(requests.some((request) => request.bodySHA256 === receipt.expectedBodySHA256)).toBe(true);
      const utility = await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      expect(utility.some((metric) => metric.name === 'DeskPet Provider Runtime' || metric.serviceName === 'DeskPet Provider Runtime')).toBe(true);
      await writeFile(join(directory, 'utility-process.json'), JSON.stringify(utility, null, 2));
      const confirmation = await application.evaluate(() => (globalThis as typeof globalThis & { __boundaryDialogs: { responses: number[]; calls: Array<{ options: { defaultId?: number; cancelId?: number; buttons?: string[] }; response: number }> } }).__boundaryDialogs);
      expect(confirmation.responses).toEqual([]);
      for (const call of confirmation.calls) expect(call.options).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Allow'] });
      if (scenario === 'native-and-allowed') expect(confirmation.calls.map((call) => call.response)).toEqual([0, 1, 1]);
      await page.screenshot({ path: join(directory, 'gui-result.png'), fullPage: true }); verdict = 'PASS';
    } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
    finally {
      const dialogs = application ? await application.evaluate(() => (globalThis as typeof globalThis & { __boundaryDialogs?: unknown }).__boundaryDialogs).catch(() => null) : null;
      if (verdict !== 'PASS') { verdict = 'FAIL'; await page?.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => undefined); }
      const evidence = { scenario, verdict, failure, root, profile, entry, mainBundleSHA256, launches, configuration: { normalProductSecurity: true, isolatedProfile: true, nativeDialogResponsesOnlyStubbed: true, providerTransport: 'production utility process -> controlled HTTP', realModelCalls: 0 },
        syntheticInputs: { aMarker, bMarker, initialA: 'allowed.txt', outsideB: 'outside-B/secret.txt' }, order, dialogs, requests, auxiliary, receiverRequests, responseClosed, checkpoints,
        independentOutsideBefore: beforeB, independentOutsideAfter: await bSnapshot(), independentAllowedAfter: await readFile(join(aRoot, 'allowed.txt'), 'utf8') };
      await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
      held?.destroy(); await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      // Only synthetic profiles are retained; no vault key is exported.
    }
  });
}
