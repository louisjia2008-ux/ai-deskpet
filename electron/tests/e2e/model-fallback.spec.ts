import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ProviderConfig } from '../../src/shared';

interface WireMessage { role: string; content: string; tool_call_id?: string }
interface Wire { model: string; messages: WireMessage[]; tools?: Array<{ function: { name: string; description: string } }> }
interface Request { body: Wire; path: string }
interface Fixture {
  app: ElectronApplication; page: Page; root: string; profile: string; requests: Request[];
  evidence: Record<string, unknown>;
  provider(model: string, destination?: 'local' | 'remote' | 'unknown'): Promise<ProviderConfig>;
  configure(ids: string[], enabled?: boolean): Promise<void>;
  session(title?: string): Promise<string>;
  send(sessionId: string, providerId: string, content: string): Promise<string>;
  terminal(sessionId: string, runId: string): Promise<ChatMessage>;
  grant(capabilityId: string): Promise<void>;
  advance(time: string): Promise<void>;
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const prompt = (body: Wire): string => body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
const httpFailure = (response: ServerResponse, status: number): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code: status === 429 ? 'rate_limit_exceeded' : 'synthetic_unavailable', message: 'Synthetic provider failure' } }));
};
const reply = (response: ServerResponse, content: string): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 } })}\n\ndata: [DONE]\n\n`);
};
const tool = (response: ServerResponse, body: Wire, title: string, id: string, input: unknown): void => {
  const descriptor = body.tools?.find(item => item.function.description.startsWith(title));
  if (!descriptor) throw new Error(`Fixture expected declared tool: ${title}`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: descriptor.function.name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
};

/** Real development Electron, renderer/preload IPC, provider utility, admission,
 * request receipts, permissions and encrypted persistence. Only provider HTTP,
 * native dialogs/notifications and the disposable host's scheduler clock are
 * synthetic. No real provider or channel credentials are read or supplied. */
async function withFixture(info: TestInfo, respond: (request: Request, response: ServerResponse) => void, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-model-fallback-'))), profile = join(root, 'profile');
  await mkdir(join(profile, 'workspace'), { recursive: true });
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const requests: Request[] = [], errors: string[] = [];
  const evidence: Record<string, unknown> = { scope: 'Development Electron with synthetic loopback model HTTP and isolated profile; no real-model, installed-app or real-channel acceptance.' };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        if (request.url?.endsWith('/api/show')) {
          const input = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { model?: string };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(input.model?.endsWith(':cloud') ? { remote_host: 'https://synthetic-cloud.invalid' } : { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return;
        }
        if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
        if (!request.url?.endsWith('/chat/completions')) throw new Error(`Unexpected fixture route ${request.url}`);
        const item = { body: JSON.parse(Buffer.concat(chunks).toString()) as Wire, path: request.url };
        requests.push(item);
        if (requests.length > 40) throw new Error('Synthetic fixture request limit exceeded');
        respond(item, response);
      } catch (error) {
        errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
        if (!response.headersSent) httpFailure(response, 500); else response.end();
      }
    });
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const entry = join(root, 'boot.cjs'), compiled = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainHash = hash(await readFile(compiled));
    await writeFile(entry, [
      "const {dialog,Notification}=require('electron'); dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};",
      'const OriginalDate=Date;let clockDelta=0;const clock=()=>OriginalDate.now()+clockDelta;global.__fallbackClock=ms=>{clockDelta=ms-OriginalDate.now();};',
      "global.Date=new Proxy(OriginalDate,{construct:(t,args)=>Reflect.construct(t,args.length?args:[clock()]),get:(t,k)=>k==='now'?clock:Reflect.get(t,k)});",
      'const interval=global.setInterval;global.setInterval=(cb,ms,...args)=>interval(cb,ms===15000?200:ms,...args);',
      'require(' + JSON.stringify(compiled) + ');',
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], cwd: process.cwd(), env });
    await expect.poll(() => app!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    const identity = (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity;
    expect(identity?.dataDirectory).toBe(profile); expect(identity?.mainBundleSHA256).toBe(mainHash);
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(false);
    evidence.identity = identity;
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    const fixture: Fixture = {
      app, page, root, profile, requests, evidence,
      provider: async (model, destination = 'local') => page.evaluate(config => window.deskpet.providers.upsert(config), {
        id: randomUUID(), name: `Synthetic ${model}`, model, baseUrl, enabled: true, supportsTools: true,
        kind: destination === 'remote' ? 'ollama' as const : 'lm-studio' as const,
        localExecutionConfirmed: destination === 'local', contextWindowTokens: 32768, maxOutputTokens: 512,
      }),
      configure: async (providerIds, enabled = true) => { await page.evaluate(value => window.deskpet.providers.setRouting(value), {
        enabled: false, localProviderId: null, cloudProviderId: null, fallback: { enabled, providerIds },
      }); },
      session: async (title = 'Model fallback fixture') => (await page.evaluate(title => window.deskpet.chat.createSession({ title, kind: 'normal' }), title)).id,
      send: async (sessionId, providerId, content) => (await page.evaluate(value => window.deskpet.chat.send(value), { sessionId, providerId, content })).runId,
      terminal: async (sessionId, runId) => {
        const state = () => page.evaluate(async ({ sessionId, runId }) => {
          const items = await window.deskpet.chat.listMessages(sessionId);
          const message = items.find(item => item.role === 'assistant' && item.requestReceipts?.some(receipt => receipt.runId === runId));
          return { message, finished: !!message && message.status !== 'streaming' && !(await window.deskpet.chat.getInteraction(sessionId)) };
        }, { sessionId, runId });
        await expect.poll(async () => (await state()).finished, { timeout: 25_000 }).toBe(true);
        const message = (await state()).message!;
        evidence.lastMessage = message;
        return message;
      },
      grant: async capabilityId => { await page.evaluate(capabilityId => window.deskpet.permissions.request({ capabilityId, duration: 'session' }), capabilityId); },
      advance: async time => { await app!.evaluate((_, time) => (globalThis as unknown as { __fallbackClock(time: number): void }).__fallbackClock(time), Date.parse(time) + 1000); },
    };
    await run(fixture);
    expect(errors).toEqual([]);
  } finally {
    evidence.requests = requests; evidence.fixtureErrors = errors;
    await writeFile(info.outputPath('fallback-evidence.json'), JSON.stringify(evidence, null, 2));
    await app?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

// eslint-disable-next-line no-empty-pattern
test('ordered fallback keeps one run and distinct receipts for primary 503, second 429 and third success', async ({}, info) => {
  test.setTimeout(90_000);
  await withFixture(info, ({ body }, response) => {
    if (body.model === 'ordered-primary') httpFailure(response, 503);
    else if (body.model === 'ordered-second') httpFailure(response, 429);
    else { expect(body.model).toBe('ordered-third'); reply(response, 'ORDERED_FALLBACK_COMPLETE'); }
  }, async f => {
    const primary = await f.provider('ordered-primary'), second = await f.provider('ordered-second'), third = await f.provider('ordered-third');
    await f.configure([second.id, third.id]);
    const sessionId = await f.session(), runId = await f.send(sessionId, primary.id, 'Answer the synthetic ordered fallback question.');
    const final = await f.terminal(sessionId, runId);
    expect(final.status).toBe('complete'); expect(final.content).toContain('ORDERED_FALLBACK_COMPLETE');
    expect(f.requests.map(item => item.body.model)).toEqual(['ordered-primary', 'ordered-second', 'ordered-third']);
    expect(final.requestReceipts).toHaveLength(3);
    expect(final.requestReceipts?.map(receipt => receipt.contextBinding?.providerId)).toEqual([primary.id, second.id, third.id]);
    expect(new Set(final.requestReceipts?.map(receipt => receipt.requestId)).size).toBe(3);
    expect(new Set(final.requestReceipts?.map(receipt => receipt.runId))).toEqual(new Set([runId]));
    const usage = (await f.page.evaluate(() => window.deskpet.usage.snapshot())).events.filter(event => final.requestReceipts?.some(receipt => receipt.requestId === event.requestId));
    expect(usage.map(event => [event.model, event.outcome])).toEqual([['ordered-primary', 'failed'], ['ordered-second', 'failed'], ['ordered-third', 'completed']]);
    expect(usage.slice(0, 2).every(event => event.inputTokens === null && event.outputTokens === null && event.tokenSource === 'unknown')).toBe(true);
    f.evidence.usage = usage;
    await f.page.evaluate(id => window.deskpet.chat.openSession(id), sessionId);
    await f.page.screenshot({ path: info.outputPath('ordered-fallback.png') });
  });
});

for (const partial of [false, true]) {
  // eslint-disable-next-line no-empty-pattern
  test(`an interrupted stream ${partial ? 'with partial output never changes provider' : 'without output may use the next configured provider'}`, async ({}, info) => {
    test.setTimeout(90_000);
    await withFixture(info, ({ body }, response) => {
      if (body.model === 'stream-primary') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: partial ? { content: 'PARTIAL_OUTPUT_MUST_REMAIN' } : {}, finish_reason: null }] })}\n\n`);
      } else { expect(body.model).toBe('stream-backup'); reply(response, 'EMPTY_STREAM_FALLBACK_COMPLETE'); }
    }, async f => {
      const primary = await f.provider('stream-primary'), backup = await f.provider('stream-backup');
      await f.configure([backup.id]);
      const sessionId = await f.session(), runId = await f.send(sessionId, primary.id, 'Explain the synthetic stream result.');
      const final = await f.terminal(sessionId, runId);
      expect(final.status).toBe(partial ? 'failed' : 'complete');
      expect(f.requests.map(item => item.body.model)).toEqual(partial ? ['stream-primary'] : ['stream-primary', 'stream-backup']);
      if (partial) { expect(final.errorCode).toBe('provider.streamInterrupted'); expect(final.content).toContain('PARTIAL_OUTPUT_MUST_REMAIN'); }
      else expect(final.content).toContain('EMPTY_STREAM_FALLBACK_COMPLETE');
    });
  });
}

// eslint-disable-next-line no-empty-pattern
test('a local private conversation never falls through to the configured cloud model', async ({}, info) => {
  test.setTimeout(90_000);
  await withFixture(info, ({ body }, response) => {
    expect(body.model).toBe('private-primary');
    if (prompt(body) === 'PRIVATE_SEED') {
      if (!body.messages.some(message => message.role === 'tool')) tool(response, body, 'Read workspace file.', 'private-read', { path: 'private.txt' });
      else reply(response, 'PRIVATE_SOURCE_READ');
    } else httpFailure(response, 503);
  }, async f => {
    const primary = await f.provider('private-primary'), cloud = await f.provider('private-backup:cloud', 'remote');
    await f.configure([cloud.id]); await f.grant('workspace.read');
    await writeFile(join(f.profile, 'workspace/private.txt'), 'SYNTHETIC_PRIVATE_SENTINEL');
    const sessionId = await f.session();
    const seed = await f.terminal(sessionId, await f.send(sessionId, primary.id, 'PRIVATE_SEED'));
    expect(seed.contextTrace?.privacy).toBe('local-only');
    const final = await f.terminal(sessionId, await f.send(sessionId, primary.id, 'PRIVATE_FAIL'));
    expect(final.status).toBe('failed'); expect(final.errorCode).toBe('provider.unavailable');
    expect(f.requests.every(item => item.body.model === 'private-primary')).toBe(true);
    expect(final.requestReceipts).toHaveLength(1); expect(final.requestReceipts?.[0]?.contextBinding?.destination).toBe('local');
  });
});

// eslint-disable-next-line no-empty-pattern
test('remote failure can fall back to local without carrying a cloud disclosure release', async ({}, info) => {
  test.setTimeout(90_000);
  await withFixture(info, ({ body }, response) => {
    if (body.model === 'remote-primary:cloud') httpFailure(response, 503);
    else { expect(body.model).toBe('local-backup'); reply(response, 'REMOTE_TO_LOCAL_COMPLETE'); }
  }, async f => {
    const primary = await f.provider('remote-primary:cloud', 'remote'), backup = await f.provider('local-backup');
    await f.configure([backup.id]);
    const sessionId = await f.session(), final = await f.terminal(sessionId, await f.send(sessionId, primary.id, 'Answer with the configured local backup if needed.'));
    expect(final.status).toBe('complete'); expect(final.content).toContain('REMOTE_TO_LOCAL_COMPLETE');
    expect(final.requestReceipts?.map(receipt => receipt.contextBinding?.destination)).toEqual(['remote', 'local']);
    expect(final.requestReceipts?.map(receipt => receipt.contextBinding?.providerId)).toEqual([primary.id, backup.id]);
  });
});

// eslint-disable-next-line no-empty-pattern
test('a model failure after a real workspace write never switches provider or replays that write', async ({}, info) => {
  test.setTimeout(90_000);
  await withFixture(info, ({ body }, response) => {
    expect(body.model).toBe('effect-primary');
    if (!body.messages.some(message => message.role === 'tool')) tool(response, body, 'Write workspace file.', 'write-once', { path: 'single.txt', content: 'SYNTHETIC_SINGLE_EFFECT' });
    else httpFailure(response, 503);
  }, async f => {
    const primary = await f.provider('effect-primary'), backup = await f.provider('effect-backup');
    await f.configure([backup.id]); await f.grant('workspace.write');
    const sessionId = await f.session(), runId = await f.send(sessionId, primary.id, 'Write the synthetic value to single.txt and report the result.');
    const final = await f.terminal(sessionId, runId);
    expect(final.status).toBe('failed'); expect(final.errorCode).toBe('provider.unavailable');
    expect(f.requests.map(item => item.body.model)).toEqual(['effect-primary', 'effect-primary']);
    const actual = await readFile(join(f.profile, 'workspace/single.txt'), 'utf8'); expect(actual).toBe('SYNTHETIC_SINGLE_EFFECT');
    const task = (await f.page.evaluate(id => window.deskpet.chatWork.list(id), sessionId)).find(item => item.runId === runId)!;
    expect(task.artifacts).toEqual([{ path: 'single.txt', bytes: Buffer.byteLength(actual), sha256: hash(actual) }]);
    const effects = (await f.page.evaluate(() => window.deskpet.tasks.listRunEvents())).filter(event => event.runId === runId && event.type === 'effect' && event.metadata.toolId === 'workspace.write');
    expect(effects).toHaveLength(1); f.evidence.task = task;
  });
});

for (const change of ['disabled', 'reordered', 'disabled then reenabled with the same order'] as const) {
  // eslint-disable-next-line no-empty-pattern
  test(`fallback ${change} while the first request is pending prevents every backup dispatch`, async ({}, info) => {
    test.setTimeout(90_000);
    let held: ServerResponse | undefined;
    await withFixture(info, ({ body }, response) => { expect(body.model).toBe('configuration-primary'); held = response; }, async f => {
      const primary = await f.provider('configuration-primary'), backup = await f.provider('configuration-backup'), last = await f.provider('configuration-last');
      await f.configure([backup.id, last.id]);
      const sessionId = await f.session(), runId = await f.send(sessionId, primary.id, 'Wait for this synthetic pending request.');
      await expect.poll(() => !!held).toBe(true);
      if (change === 'disabled then reenabled with the same order') {
        await f.configure([backup.id, last.id], false);
        await f.configure([backup.id, last.id], true);
      } else await f.configure(change === 'reordered' ? [last.id, backup.id] : [backup.id, last.id], change !== 'disabled');
      httpFailure(held!, 503);
      const final = await f.terminal(sessionId, runId);
      expect(final.status).toBe('failed'); expect(f.requests.map(item => item.body.model)).toEqual(['configuration-primary']);
    });
  });
}

// eslint-disable-next-line no-empty-pattern
test('a desktop recurring task uses the configured backup before producing any output', async ({}, info) => {
  test.setTimeout(90_000);
  await withFixture(info, ({ body }, response) => {
    if (prompt(body) === 'CREATE_FALLBACK_CRON') {
      if (!body.messages.some(message => message.role === 'tool')) tool(response, body, 'Create recurring chat task.', 'create-cron', {
        title: 'Synthetic fallback schedule', instruction: 'FALLBACK_CRON_EXECUTE', expression: '* * * * *', timezone: 'UTC', allowedCapabilities: ['math.calculate'], missedPolicy: 'skip',
      });
      else reply(response, 'FALLBACK_CRON_CREATED');
    } else if (body.model === 'cron-primary') httpFailure(response, 503);
    else { expect(body.model).toBe('cron-backup'); expect(prompt(body)).toBe('FALLBACK_CRON_EXECUTE'); reply(response, 'FALLBACK_CRON_EXECUTED'); }
  }, async f => {
    const primary = await f.provider('cron-primary'), backup = await f.provider('cron-backup');
    await f.configure([backup.id]);
    const sessionId = await f.session(), creating = await f.send(sessionId, primary.id, 'CREATE_FALLBACK_CRON');
    const interaction = () => f.page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId);
    await expect.poll(async () => (await interaction())?.approval?.toolId).toBe('cron.create');
    const approval = (await interaction())!.approval!;
    await f.page.evaluate(value => window.deskpet.chat.resolveApproval(value), { runId: approval.runId, sessionId, approvalId: approval.id, decision: 'allow-once' as const });
    expect((await f.terminal(sessionId, creating)).status).toBe('complete');
    const schedule = (await f.page.evaluate(id => window.deskpet.chatWork.listCron(id), sessionId))[0]!;
    expect(schedule.providerId).toBe(primary.id); expect(schedule.channel).toBeUndefined(); expect(schedule.telegramDelivery).toBeUndefined();
    await f.advance(schedule.nextRunAt!);
    const scheduled = () => f.page.evaluate(async id => (await window.deskpet.chat.listMessages(id)).find(message => message.role === 'assistant' && message.status === 'complete' && message.content.includes('FALLBACK_CRON_EXECUTED')), sessionId);
    await expect.poll(async () => !!(await scheduled()), { timeout: 25_000 }).toBe(true);
    const final = (await scheduled())!;
    expect(final.requestReceipts?.map(receipt => receipt.contextBinding?.providerId)).toEqual([primary.id, backup.id]);
    expect(f.requests.filter(item => prompt(item.body) === 'FALLBACK_CRON_EXECUTE').map(item => item.body.model)).toEqual(['cron-primary', 'cron-backup']);
    await f.page.evaluate(value => window.deskpet.chatWork.pauseCron(value), { sessionId, id: schedule.id });
    f.evidence.scheduledMessage = final;
  });
});

interface QqHarness { posts: Array<{ content: string }>; emit(content: string): void }

// eslint-disable-next-line no-empty-pattern
test('ordinary QQ chat may fall back, while its host-confirmed scheduled provider remains fixed', async ({}, info) => {
  test.setTimeout(120_000);
  await withFixture(info, ({ body }, response) => {
    const text = prompt(body);
    if (text === 'QQ_FALLBACK_QUESTION') {
      if (body.model === 'qq-primary') httpFailure(response, 503);
      else { expect(body.model).toBe('qq-backup'); reply(response, 'QQ_BACKUP_REPLY'); }
    } else if (text === 'QQ_FALLBACK_CREATE') {
      if (!body.messages.some(message => message.role === 'tool')) tool(response, body, 'Create recurring chat task.', 'qq-create', {
        title: 'Synthetic approved QQ fallback test', instruction: 'QQ_FALLBACK_SCHEDULED', expression: '0 9 * * *', timezone: 'UTC',
        allowedCapabilities: ['math.calculate'], missedPolicy: 'skip',
      });
      else reply(response, 'QQ_SCHEDULE_AWAITS_HOST_CONFIRMATION');
    } else {
      expect(text).toBe('QQ_FALLBACK_SCHEDULED'); expect(body.model).toBe('qq-primary'); httpFailure(response, 503);
    }
  }, async f => {
    const primary = await f.provider('qq-primary'), backup = await f.provider('qq-backup');
    await f.configure([backup.id]);
    await f.app.evaluate(({ net }) => {
      const state = { posts: [] as Array<{ content: string }>, sequence: 0, sockets: [] as Socket[] };
      class Socket {
        closed = false;
        listeners = new Map<string, Array<(event: { data?: string }) => void>>();
        constructor(url: string) {
          if (url !== 'wss://api.bot.qq.com/websocket/') throw new Error('Unexpected synthetic QQ gateway');
          state.sockets.push(this);
          globalThis.queueMicrotask(() => { this.dispatch('open'); this.frame({ op: 10, d: { heartbeat_interval: 45_000 } }); });
        }
        addEventListener(type: string, listener: (event: { data?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
        dispatch(type: string, event: { data?: string } = {}) { if (!this.closed) for (const callback of this.listeners.get(type) ?? []) callback(event); }
        frame(value: unknown) { this.dispatch('message', { data: JSON.stringify(value) }); }
        send(raw: string) {
          const value = JSON.parse(raw) as { op: number };
          if (value.op === 2) globalThis.queueMicrotask(() => this.frame({ op: 0, t: 'READY', s: ++state.sequence, d: { session_id: 'synthetic-fallback-session' } }));
          if (value.op === 1) globalThis.queueMicrotask(() => this.frame({ op: 11 }));
        }
        close() { this.closed = true; }
      }
      const originalFetch = net.fetch.bind(net);
      net.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.href === 'https://bots.qq.com/app/getAppAccessToken') return new Response('{"access_token":"synthetic-qq-token","expires_in":7200}', { status: 200 });
        if (url.href === 'https://api.sgroup.qq.com/gateway') return new Response('{"url":"wss://api.bot.qq.com/websocket/"}', { status: 200 });
        if (url.origin === 'https://api.sgroup.qq.com' && /^\/v2\/users\/[^/]+\/messages$/u.test(url.pathname)) {
          state.posts.push(JSON.parse(String(init?.body)) as { content: string });
          return new Response('{"id":"synthetic-delivery"}', { status: 200 });
        }
        if (url.protocol === 'file:' || url.protocol === 'deskpet:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
        throw new Error('Unexpected external network in synthetic QQ fallback fixture');
      };
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = Socket;
      (globalThis as unknown as { __fallbackQq: QqHarness }).__fallbackQq = {
        posts: state.posts,
        emit(content) { [...state.sockets].reverse().find(socket => !socket.closed)?.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: ++state.sequence,
          d: { id: `synthetic-fallback-${state.sequence}`, author: { user_openid: 'synthetic-fallback-owner' }, content } }); },
      };
    });
    const posts = () => f.app.evaluate(() => (globalThis as unknown as { __fallbackQq: QqHarness }).__fallbackQq.posts);
    const inbound = (content: string) => f.app.evaluate((_, content) => (globalThis as unknown as { __fallbackQq: QqHarness }).__fallbackQq.emit(content), content);
    const syntheticSecret = 'synthetic-only-' + randomUUID();
    await f.page.evaluate(value => window.deskpet.qq.configure(value), { enabled: true, transport: 'official' as const, appId: 'synthetic-fallback-app',
      appSecret: syntheticSecret, providerId: primary.id, model: primary.model });
    const pairing = await f.page.evaluate(() => window.deskpet.qq.startPairing());
    await expect.poll(() => f.page.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ connection: 'online' });
    await inbound('/pair ' + pairing.code);
    await expect.poll(async () => (await f.page.evaluate(() => window.deskpet.qq.getState())).pairingCandidate?.id).toBeTruthy();
    const candidate = (await f.page.evaluate(() => window.deskpet.qq.getState())).pairingCandidate!;
    await f.page.evaluate(id => window.deskpet.qq.confirmPairing(id), candidate.id);
    const sessionId = (await f.page.evaluate(() => window.deskpet.chat.listSessions())).find(session => !!session.channelBindingId)!.id;
    await inbound('QQ_FALLBACK_QUESTION');
    await expect.poll(async () => (await posts()).some(post => post.content.includes('QQ_BACKUP_REPLY')), { timeout: 25_000 }).toBe(true);
    const ordinary = (await f.page.evaluate(id => window.deskpet.chat.listMessages(id), sessionId)).find(message => message.role === 'assistant' && message.content.includes('QQ_BACKUP_REPLY'))!;
    expect(ordinary.status).toBe('complete');
    expect(ordinary.requestReceipts?.map(receipt => receipt.contextBinding?.providerId)).toEqual([primary.id, backup.id]);
    expect(ordinary.requestReceipts?.every(receipt => receipt.contextBinding?.destination === 'remote')).toBe(true);
    expect((await posts()).some(post => post.content.includes('Synthetic qq-') || post.content.includes('qq-backup'))).toBe(false);
    await expect.poll(() => f.page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId)).toBeNull();
    await inbound('QQ_FALLBACK_CREATE');
    try {
      await expect.poll(async () => (await posts()).some(post => /\n\/confirm [a-f0-9]{12}$/u.test(post.content))).toBe(true);
    } catch (error) {
      f.evidence.qqPosts = await posts();
      f.evidence.qqMessages = await f.page.evaluate(id => window.deskpet.chat.listMessages(id), sessionId);
      f.evidence.qqState = await f.page.evaluate(() => window.deskpet.qq.getState());
      throw error;
    }
    const notice = (await posts()).find(post => /\n\/confirm [a-f0-9]{12}$/u.test(post.content))!;
    const code = /\n\/confirm ([a-f0-9]{12})$/u.exec(notice.content)![1]!;
    await expect.poll(async () => (await posts()).some(post => post.content.includes('QQ_SCHEDULE_AWAITS_HOST_CONFIRMATION'))).toBe(true);
    await inbound('/confirm ' + code);
    await expect.poll(async () => (await f.page.evaluate(id => window.deskpet.chatWork.listCron(id), sessionId)).length).toBe(1);
    const schedule = (await f.page.evaluate(id => window.deskpet.chatWork.listCron(id), sessionId))[0]!;
    expect(schedule.providerId).toBe(primary.id); expect(schedule.channel?.approval?.providerDigest).toBeTruthy();
    expect(JSON.stringify(f.requests)).not.toContain(code); expect(JSON.stringify(f.requests)).not.toContain(syntheticSecret);
    await expect.poll(() => f.page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId)).toBeNull();
    const before = (await f.page.evaluate(id => window.deskpet.chat.listMessages(id), sessionId)).filter(message => message.role === 'assistant').length;
    await f.advance(schedule.nextRunAt!);
    const scheduled = () => f.page.evaluate(async ({ sessionId, before }) => {
      const assistants = (await window.deskpet.chat.listMessages(sessionId)).filter(message => message.role === 'assistant');
      return assistants.length > before ? assistants.at(-1) : undefined;
    }, { sessionId, before });
    await expect.poll(async () => (await scheduled())?.status, { timeout: 25_000 }).toBe('failed');
    const failed = (await scheduled())!;
    expect(failed.errorCode).toBe('provider.unavailable');
    expect(failed.requestReceipts?.map(receipt => receipt.contextBinding?.providerId)).toEqual([primary.id]);
    expect(f.requests.filter(item => prompt(item.body) === 'QQ_FALLBACK_SCHEDULED').map(item => item.body.model)).toEqual(['qq-primary']);
    f.evidence.qqOrdinaryMessage = ordinary; f.evidence.qqScheduledMessage = failed;
    await f.page.evaluate(() => window.deskpet.qq.stop());
  });
});
