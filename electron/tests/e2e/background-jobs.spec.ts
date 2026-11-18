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
import type { BackgroundJob, BackgroundJobInput } from '../../src/shared/background-jobs';
import type { PersistentState } from '../../src/main/domain/schemas';


interface Wire { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; tool_choice?: string }
interface RequestRecord { body: Wire; bodySHA256: string; authorizationPresent: boolean; fakeCredentialMatches: boolean; path: string }
type Scenario = 'normal-ui' | 'duplicate-submit' | 'tool-protocol' | 'legacy-tool-protocol' | 'cancel-first-chat-continues' | 'result-first' | 'queued-credential-revoked' | 'frozen-model'
  | 'commit-uncertain' | 'crash-dispatch-intent' | 'crash-http-received' | 'crash-result-committed' | 'crash-queued-resume';
const scenarios: Scenario[] = ['normal-ui', 'duplicate-submit', 'tool-protocol', 'legacy-tool-protocol', 'cancel-first-chat-continues', 'result-first', 'queued-credential-revoked', 'frozen-model',
  'commit-uncertain', 'crash-dispatch-intent', 'crash-http-received', 'crash-result-committed', 'crash-queued-resume'];
const archive = '/private/tmp/deskpet/output/deskpet-electron-ep2-20261028/e2e';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

for (const scenario of scenarios) {
  // eslint-disable-next-line no-empty-pattern
  test(`persistent background text job: ${scenario}`, async ({}, info) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-ep2-e2e-')); const profile = join(root, 'profile');
    await mkdir(join(profile, 'workspace'), { recursive: true });
    const marker = `EP2_JOB_${scenario}_${randomUUID()}`; const chatMarker = `EP2_CHAT_${randomUUID()}`;
    const unselected = `EP2_UNSELECTED_${randomUUID()}`; const fakeCredential = `FAKE_ONLY_EP2_${randomUUID()}`;
    const protectedFile = join(profile, 'workspace/untouched.txt'); await writeFile(protectedFile, unselected);
    const directory = join(archive, `${new Date().toISOString().replaceAll(':', '-')}-${scenario}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { recursive: true });
    await copyFile(join(process.cwd(), 'tests/e2e/background-jobs.spec.ts'), join(directory, 'test-spec.ts'));
    const entry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainBundleSHA256 = hash(await readFile(entry));
    const utilityBundleSHA256 = hash(await readFile(join(process.cwd(), '.webpack', process.arch, 'main/utility.js')));
    const requests: RequestRecord[] = []; const auxiliary: string[] = []; const held = new Map<string, ServerResponse>();
    const launches: unknown[] = []; const checkpoints: Array<{ phase: string; state: PersistentState }> = []; const order: unknown[] = [];
    let application: ElectronApplication | undefined; let page: Page | undefined; let verdict = 'RUNNING'; let failure: string | undefined;
    const reply = (response: ServerResponse, content: string, tool?: 'modern' | 'legacy'): void => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const fn = { name: 'workspace.write', arguments: JSON.stringify({ path: 'untouched.txt', content: 'UNAUTHORIZED_EP2_TOOL_WRITE' }) };
      const delta = tool === 'modern' ? { tool_calls: [{ index: 0, id: 'malicious-call', type: 'function', function: fn }] } : tool === 'legacy' ? { function_call: fn } : { content };
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? (tool === 'legacy' ? 'function_call' : 'tool_calls') : 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!request.url?.endsWith('/chat/completions')) {
          auxiliary.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } } : { data: [{ id: 'ep2-synthetic' }] })); return;
        }
        const body = JSON.parse(raw) as Wire;
        requests.push({ path: request.url ?? '', body, bodySHA256: hash(raw), authorizationPresent: typeof request.headers.authorization === 'string', fakeCredentialMatches: request.headers.authorization === `Bearer ${fakeCredential}` });
        const isJob = body.messages.some((message) => message.content.includes(marker));
        if (isJob && (scenario === 'normal-ui' || scenario === 'duplicate-submit' || scenario === 'cancel-first-chat-continues' || scenario === 'crash-http-received')) { held.set('job', response); return; }
        if (!isJob && (scenario === 'queued-credential-revoked' || scenario === 'frozen-model')) { held.set('chat', response); return; }
        reply(response, isJob ? `RESULT_${marker}\n<script>window.__ep2Executed=true</script>` : `RESULT_${chatMarker}`, isJob && scenario === 'tool-protocol' ? 'modern' : isJob && scenario === 'legacy-tool-protocol' ? 'legacy' : undefined);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const providerId = randomUUID();
    const input: BackgroundJobInput = { operationId: randomUUID(), instruction: `Summarize synthetic material ${marker}`, material: `SELECTED_MATERIAL_${marker}`, privacy: 'local-only', providerId, model: 'ep2-synthetic' };
    const jobRequests = (): RequestRecord[] => requests.filter((record) => record.body.messages.some((message) => message.content.includes(marker)));
    const launch = async (): Promise<void> => {
      const env: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
      application = await electron.launch({ args: [entry], cwd: process.cwd(), env });
      await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible(); await page.evaluate(() => window.deskpet.app.setLocale('en'));
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
    const installBarrier = async (status: string): Promise<void> => application!.evaluate(({ app, safeStorage }, config) => {
      if (app.isPackaged || app.getPath('userData') !== config.profile) throw new Error('Fault instrumentation outside own profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fs = runtime.mainModule.require('node:fs') as typeof NodeFs; const fsp = runtime.mainModule.require('node:fs/promises') as typeof NodePromises; const crypto = runtime.mainModule.require('node:crypto') as typeof NodeCrypto;
      const original = fsp.rename; const globals = globalThis as typeof globalThis & { __ep2Barrier?: { hit: boolean; status: string; state?: unknown } };
      globals.__ep2Barrier = { hit: false, status: config.status };
      fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
        await original(...args);
        if (String(args[1]) !== `${config.profile}/profile.enc.json` || globals.__ep2Barrier!.hit) return;
        const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${config.profile}/vault/vault-key.safe`)), 'base64');
        let state: { backgroundJobs?: BackgroundJob[] };
        try { const envelope = JSON.parse(fs.readFileSync(String(args[1]), 'utf8')) as { nonce: string; authenticationTag: string; ciphertext: string };
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
          state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as typeof state;
        } finally { key.fill(0); }
        if (state.backgroundJobs?.some((job) => job.instruction.includes(config.marker) && job.status === config.status)) {
          globals.__ep2Barrier!.hit = true; globals.__ep2Barrier!.state = state;
          await new Promise<void>(() => undefined);
        }
      };
    }, { profile, status, marker });
    const installUncertain = async (): Promise<void> => application!.evaluate(({ app }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Fault instrumentation outside own profile');
      const runtime = process as typeof process & { mainModule: { require(id: string): unknown } };
      const fsp = runtime.mainModule.require('node:fs/promises') as typeof NodePromises;
      const originalRename = fsp.rename, originalRead = fsp.readFile;
      const globals = globalThis as typeof globalThis & { __ep2Uncertain?: { hit: boolean; blocked: boolean } };
      globals.__ep2Uncertain = { hit: false, blocked: false };
      fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
        await originalRename(...args);
        if (String(args[1]) === `${expectedProfile}/profile.enc.json` && !globals.__ep2Uncertain!.hit) {
          globals.__ep2Uncertain!.hit = true; globals.__ep2Uncertain!.blocked = true;
          throw new Error('Synthetic write confirmation lost after actual rename');
        }
      };
      const read: typeof fsp.readFile = ((...args: Parameters<typeof fsp.readFile>) => {
        if (String(args[0]) === `${expectedProfile}/profile.enc.json` && globals.__ep2Uncertain!.blocked) return Promise.reject(new Error('Synthetic authoritative encrypted read unavailable'));
        return originalRead(...args);
      }) as typeof fsp.readFile;
      fsp.readFile = read;
    }, profile);
    const killOwned = async (): Promise<void> => {
      order.push({ action: 'pre-kill-owned-processes', metrics: await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName }))) });
      const pid = application!.process().pid; if (!pid) throw new Error('Missing owned Electron pid');
      const closed = application!.waitForEvent('close'); process.kill(pid, 'SIGKILL'); await closed; order.push({ action: 'actual-SIGKILL-owned-main', pid }); application = undefined; page = undefined;
    };
    const getJob = async (id: string): Promise<BackgroundJob> => page!.evaluate((jobId) => window.deskpet.jobs.get(jobId), id);
    const submit = async (): Promise<BackgroundJob> => page!.evaluate((value) => window.deskpet.jobs.submit(value), input);
    const waitStatus = async (id: string, status: BackgroundJob['status']): Promise<BackgroundJob> => { await expect.poll(async () => (await getJob(id)).status).toBe(status); return getJob(id); };
    const sendChat = async (): Promise<void> => {
      await page!.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click();
      await page!.locator('.composer textarea').fill(chatMarker); await page!.locator('.composer textarea').press('Enter');
      await expect(page!.locator('.message.assistant')).toHaveCount(1);
    };
    try {
      await launch();
      await page!.evaluate(async (config) => { await window.deskpet.providers.upsert(config); await window.deskpet.providers.select(config.id); }, {
        id: providerId, kind: 'ollama' as const, name: 'E-P2 controlled provider', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'ep2-synthetic', enabled: true, supportsTools: true,
        localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512, apiKey: fakeCredential,
      });
      // Synthetic unrelated data makes absence from the job's wire body observable.
      await page!.evaluate((text) => window.deskpet.memory.upsert({ id: crypto.randomUUID(), text, tags: [], privacy: 'local-only', scope: { kind: 'global' } }), unselected);
      await checkpoint('before');
      let job: BackgroundJob;
      if (scenario === 'queued-credential-revoked') {
        await sendChat(); await expect.poll(() => held.has('chat')).toBe(true);
        job = await submit(); expect(job.status).toBe('queued');
        await page!.evaluate((id) => window.deskpet.providers.clearSecret(id), providerId); order.push({ action: 'revoke-queued-job-credential' });
        reply(held.get('chat')!, `RESULT_${chatMarker}`); held.delete('chat');
        await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
        job = await waitStatus(job.id, 'blocked'); expect(jobRequests()).toHaveLength(0); expect(job.result).toBeNull();
      } else if (scenario === 'frozen-model') {
        await sendChat(); await expect.poll(() => held.has('chat')).toBe(true);
        job = await submit(); expect(job.status).toBe('queued');
        await page!.evaluate((id) => window.deskpet.providers.setModel(id, 'front-new-model'), providerId);
        reply(held.get('chat')!, `RESULT_${chatMarker}`); held.delete('chat');
        job = await waitStatus(job.id, 'succeeded'); expect(job.binding.model).toBe('ep2-synthetic'); expect(jobRequests()).toHaveLength(1); expect(jobRequests()[0]!.body.model).toBe('ep2-synthetic');
        await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
      } else if (scenario === 'commit-uncertain') {
        await installUncertain();
        const accepted = await submit().then(() => 'UNEXPECTED_SUCCESS', (error: Error) => error.message);
        expect(accepted).toContain('repository.commitUncertain'); expect(jobRequests()).toHaveLength(0);
        const unreadable = await page!.evaluate(async () => { try { await window.deskpet.jobs.list(); return 'UNEXPECTED_SUCCESS'; } catch (error) { return (error as Error).message; } });
        expect(unreadable).toContain('repository.commitUncertain'); expect(jobRequests()).toHaveLength(0);
        await checkpoint('commit-unknown-disk-independently-readable');
        await application!.evaluate(() => { (globalThis as typeof globalThis & { __ep2Uncertain: { blocked: boolean } }).__ep2Uncertain.blocked = false; });
        job = await submit(); job = await waitStatus(job.id, 'succeeded'); expect(jobRequests()).toHaveLength(1);
        expect(job.receipts.filter((receipt) => receipt.kind === 'accepted')).toHaveLength(1);
      } else if (scenario.startsWith('crash-')) {
        const barrier = scenario === 'crash-dispatch-intent' ? 'dispatching' : scenario === 'crash-result-committed' ? 'succeeded' : scenario === 'crash-queued-resume' ? 'queued' : null;
        if (barrier) await installBarrier(barrier);
        const submitting = submit().catch(() => null);
        if (barrier) await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep2Barrier?: { hit: boolean } }).__ep2Barrier?.hit))).toBe(true);
        else await expect.poll(() => jobRequests().length).toBe(1);
        const durable = await checkpoint('pre-kill'); job = (durable as PersistentState & { backgroundJobs: BackgroundJob[] }).backgroundJobs.find((item) => item.operationId === input.operationId)!;
        expect(job).toBeDefined();
        if (scenario === 'crash-dispatch-intent') { expect(job.status).toBe('dispatching'); expect(job.request).not.toBeNull(); expect(jobRequests()).toHaveLength(0); }
        if (scenario === 'crash-result-committed') { expect(job.status).toBe('succeeded'); expect(job.result).toContain(marker); expect(jobRequests()).toHaveLength(1); }
        const originalAttemptId = job.attemptId;
        await killOwned(); await submitting; for (const response of held.values()) response.destroy(); held.clear();
        await launch(); job = await getJob(job.id); expect(job.attemptId).toBe(originalAttemptId);
        if (scenario === 'crash-queued-resume') { job = await waitStatus(job.id, 'succeeded'); expect(jobRequests()).toHaveLength(1); }
        else if (scenario === 'crash-result-committed') { expect(job.status).toBe('succeeded'); expect(jobRequests()).toHaveLength(1); }
        else { expect(job.status).toBe('interrupted'); expect(job.result).toBeNull(); expect(jobRequests()).toHaveLength(scenario === 'crash-dispatch-intent' ? 0 : 1); }
        await checkpoint('new-process-recovery');
      } else if (scenario === 'normal-ui') {
        await page!.locator('nav').getByRole('button', { name: 'Tools', exact: true }).click(); await page!.getByRole('tab', { name: 'Background tasks', exact: true }).click();
        // The page also holds the research form, which has its own provider and model fields.
        const form = page!.getByRole('region', { name: 'Background text jobs' });
        await form.getByLabel('Task instruction', { exact: true }).fill(input.instruction); await form.getByLabel('Selected material (paste text)', { exact: true }).fill(input.material);
        await form.getByLabel('Provider', { exact: true }).selectOption(providerId); await form.getByLabel('Model', { exact: true }).fill(input.model);
        await form.getByRole('button', { name: 'Run in background', exact: true }).click();
        await expect.poll(() => jobRequests().length).toBe(1);
        const jobs = await page!.evaluate(() => window.deskpet.jobs.list()); job = jobs.find((item) => item.instruction === input.instruction)!;
        expect(job).toBeDefined();
        await sendChat(); await page!.reload(); await expect(page!.locator('.app-shell')).toBeVisible();
        expect(jobRequests()).toHaveLength(1); reply(held.get('job')!, `RESULT_${marker}\n<script>window.__ep2Executed=true</script>`); held.delete('job');
        job = await waitStatus(job.id, 'succeeded');
        await expect.poll(async () => {
          const sessions = await page!.evaluate(() => window.deskpet.chat.listSessions());
          const messages = await page!.evaluate((id) => window.deskpet.chat.listMessages(id), sessions[0]!.id);
          return messages.find((message) => message.role === 'assistant')?.status;
        }).toBe('complete');
        await page!.locator('nav').getByRole('button', { name: 'Tools', exact: true }).click(); await page!.getByRole('tab', { name: 'Background tasks', exact: true }).click();
        await expect(page!.getByText(`RESULT_${marker}`, { exact: false })).toHaveCount(0);
        await page!.getByRole('button', { name: 'View result', exact: true }).click();
        await expect(page!.getByRole('region', { name: 'Saved result', exact: true }).locator('pre')).toContainText(`RESULT_${marker}`);
        expect(await page!.evaluate(() => Boolean((window as unknown as { __ep2Executed?: boolean }).__ep2Executed))).toBe(false);
        await page!.screenshot({ path: join(directory, 'explicit-result.png'), fullPage: true });
        const completed = await checkpoint('completed-before-restart');
        expect(completed.chatMessages.some((message) => message.content.includes(`RESULT_${marker}`))).toBe(false);
        expect(completed.chatMessages.some((message) => message.content.includes(`RESULT_${chatMarker}`))).toBe(true);
        expect(completed.memories.some((memory) => memory.text.includes(`RESULT_${marker}`))).toBe(false);
        const count = requests.length; await application!.close(); application = undefined; await launch();
        const restarted = await getJob(job.id); expect(restarted.result).toBe(job.result); expect(restarted.attemptId).toBe(job.attemptId); expect(restarted.status).toBe('succeeded'); expect(requests).toHaveLength(count);
        await checkpoint('restart-result');
      } else {
        if (scenario === 'duplicate-submit') {
          const repeated = await Promise.all([submit(), submit()]); expect(repeated[0].id).toBe(repeated[1].id); job = repeated[0];
          const conflict = await page!.evaluate(async (value) => { try { await window.deskpet.jobs.submit({ ...value, instruction: `${value.instruction} DIFFERENT` }); return 'UNEXPECTED_SUCCESS'; } catch (error) { return (error as Error).message; } }, input);
          expect(conflict).toContain('job.operationConflict');
          await expect.poll(() => jobRequests().length).toBe(1); reply(held.get('job')!, `RESULT_${marker}`); held.delete('job');
        } else job = await submit();
        if (scenario === 'cancel-first-chat-continues') {
          await expect.poll(() => jobRequests().length).toBe(1); await sendChat();
          expect(requests).toHaveLength(1); job = await page!.evaluate((id) => window.deskpet.jobs.cancel(id), job.id); expect(job.status).toBe('cancelled'); expect(job.cancelRequestedAt).not.toBeNull();
          // The controlled receiver observed the issued request. A later local
          // cancel cannot establish that remote computation or billing ceased.
          reply(held.get('job')!, `LATE_RESULT_${marker}`); held.delete('job');
          await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
          job = await getJob(job.id); expect(job.status).toBe('cancelled'); expect(job.result).toBeNull(); expect(requests).toHaveLength(2);
        } else if (scenario === 'tool-protocol' || scenario === 'legacy-tool-protocol') {
          job = await waitStatus(job.id, 'failed'); expect(job.completionReason).toBe('job.toolsForbidden'); expect(job.result).toBeNull(); expect(jobRequests()).toHaveLength(1);
          const events = await page!.evaluate(() => window.deskpet.tasks.listRunEvents()); expect(events.some((event) => event.type === 'tool')).toBe(false);
        } else {
          job = await waitStatus(job.id, 'succeeded');
          if (scenario === 'result-first') { const cancelled = await page!.evaluate((id) => window.deskpet.jobs.cancel(id), job.id); expect(cancelled.status).toBe('succeeded'); expect(cancelled.result).toBe(job.result); expect(cancelled.cancelRequestedAt).toBeNull(); }
        }
      }
      const final = await checkpoint('final');
      const finalJobs = (final as PersistentState & { backgroundJobs: BackgroundJob[] }).backgroundJobs;
      expect(finalJobs.filter((item) => item.operationId === (scenario === 'normal-ui' ? job.operationId : input.operationId))).toHaveLength(1);
      expect(await readFile(protectedFile, 'utf8')).toBe(unselected);
      for (const record of jobRequests()) {
        expect(record.body.tools).toBeUndefined(); expect(record.body.tool_choice).toBe('none');
        expect(JSON.stringify(record.body)).not.toContain(unselected); expect(JSON.stringify(record.body)).not.toContain(chatMarker); expect(JSON.stringify(record.body)).not.toContain(fakeCredential);
        expect(record.fakeCredentialMatches).toBe(true); expect(record.authorizationPresent).toBe(true);
      }
      expect(JSON.stringify(final)).not.toContain(fakeCredential);
      const metrics = await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName })));
      if (requests.length > 0) expect(metrics.some((metric) => metric.name === 'DeskPet Provider Runtime' || metric.serviceName === 'DeskPet Provider Runtime')).toBe(true);
      await writeFile(join(directory, 'utility-process.json'), JSON.stringify(metrics, null, 2));
      await page!.screenshot({ path: join(directory, 'final-gui.png'), fullPage: true }); verdict = 'PASS';
    } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
    finally {
      if (verdict !== 'PASS') { verdict = 'FAIL'; await page?.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => undefined); }
      const evidence = { scenario, verdict, failure, root, profile, entry, mainBundleSHA256, utilityBundleSHA256, launches,
        configuration: { normalProductSecurity: true, isolatedProfile: true, syntheticProvider: true, realModelCalls: 0, productionTransport: 'renderer -> preload/IPC -> TypeScript -> provider utility -> controlled HTTP', faultInstrumentation: scenario.startsWith('crash-') ? 'after durable fs.rename Promise barrier or receiver-held response; actual SIGKILL, new process same profile' : null },
        syntheticInput: input, chatMarker, unselectedMarker: unselected, order, requests, auxiliary, checkpoints, protectedFileSHA256: hash(await readFile(protectedFile)) };
      await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
      for (const response of held.values()) response.destroy();
      if (application && scenario.startsWith('crash-')) {
        const blocked = await application.evaluate(() => Boolean((globalThis as typeof globalThis & { __ep2Barrier?: { hit: boolean } }).__ep2Barrier?.hit)).catch(() => false);
        if (blocked) { const pid = application.process().pid; const closed = application.waitForEvent('close'); if (pid) process.kill(pid, 'SIGKILL'); await closed.catch(() => undefined); application = undefined; }
      }
      await application?.close().catch(() => undefined); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
