import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Post { recipient: string; content: string; replyTo?: string; sequence: number }
interface Harness { posts: Post[]; tokenCalls: number; emit(sender: string, content: string): void }
interface Wire { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }

// Only the network boundaries are synthetic. Renderer, preload, IPC, channel
// policy, provider utility, encryption, pairing and confirmation use the app.
// No test hook is shipped in the product and no real QQ credentials are used.
// eslint-disable-next-line no-empty-pattern
test('isolated QQ settings, desktop pairing, confirmed Cron and emergency stop use real host gates', async ({}, info) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-qq-e2e-')));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const evidenceRoot = process.env.DESKPET_QQ_EVIDENCE ?? info.outputPath('qq-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const executablePath = process.env.DESKPET_QQ_APP;
  const secret = `synthetic-only-${randomUUID()}`;
  const wires: Wire[] = [], pageErrors: string[] = [];
  const identities: unknown[] = [];
  let releaseLate: (() => void) | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[{"id":"qq-fixture-model"}]}'); return; }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Wire; wires.push(body);
      const text = body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
      const toolFinished = body.messages.at(-1)?.role === 'tool';
      const send = (delta: unknown, reason = 'stop') => {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
      };
      if (text.includes('QQ_E2E_CREATE') && !toolFinished) {
        const name = body.tools?.find(tool => tool.function.description.startsWith('Create recurring chat task.'))?.function.name;
        if (!name) { response.writeHead(500).end('Fixture expected the host-declared Cron draft tool'); return; }
        // Leave 15–75 seconds to confirm the schedule, then let the real host
        // clock and its normal scheduler tick deliver it. This also works in an installed candidate.
        const next = new Date(Date.now() + 75_000);
        send({ tool_calls: [{ index: 0, id: 'qq-create', type: 'function', function: { name, arguments: JSON.stringify({
          title: 'Synthetic QQ task', instruction: 'Calculate 6 * 7 without files', expression: `${next.getUTCMinutes()} ${next.getUTCHours()} * * *`, timezone: 'UTC',
          allowedCapabilities: ['math.calculate'], missedPolicy: 'skip',
        }) } }] }, 'tool_calls');
      } else if (text === 'Calculate 6 * 7 without files') {
        send({content:'Scheduled fixture result: 42'});
      } else if (text.includes('QQ_E2E_WRITE')) {
        send({ tool_calls: [{ index: 0, id: 'blocked-write', type: 'function', function: { name: 'workspace.write',
          arguments: JSON.stringify({ path: 'qq-must-not-write.txt', content: 'blocked' }) } }] }, 'tool_calls');
      } else if (text.includes('QQ_E2E_WAIT')) releaseLate = () => send({ content: 'QQ_LATE_REPLY_MUST_NOT_SEND' });
      else send({ content: toolFinished ? 'The host draft is pending your direct confirmation.' : 'Synthetic private reply.' });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
  let application: ElectronApplication | undefined, page: Page;
  let processOutput = '';
  const launch = async () => {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    application = await electron.launch({ env, cwd: process.cwd(), timeout: 30_000,
      ...(executablePath ? { executablePath, args: [`--deskpet-isolated-profile=${root}`] }
        : { args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js'), `--deskpet-isolated-profile=${root}`] }) });
    application.process().stdout?.on('data', (chunk: Buffer) => { processOutput += chunk.toString(); });
    application.process().stderr?.on('data', (chunk: Buffer) => { processOutput += chunk.toString(); });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.locator('.app-shell')).toBeVisible();
    const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), dataDirectory: app.getPath('userData'), name: app.getName() }));
    expect(identity.dataDirectory).toBe(join(root, 'profile'));
    expect(identity.name).toBe('DeskPet Electron Candidate');
    if (executablePath) expect(identity.packaged).toBe(true);
    identities.push(identity, (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity);
    await application.evaluate(({ net, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      const state = { posts: [] as Post[], tokenCalls: 0, sequence: 0, sockets: [] as Socket[] };
      class Socket {
        closed = false;
        listeners = new Map<string, Array<(event: { data?: string }) => void>>();
        constructor(url: string) {
          if (url !== 'wss://api.bot.qq.com/websocket/') throw new Error('Unexpected fixture gateway');
          state.sockets.push(this);
          globalThis.queueMicrotask(() => { this.dispatch('open'); this.frame({ op: 10, d: { heartbeat_interval: 45_000 } }); });
        }
        addEventListener(type: string, listener: (event: { data?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
        dispatch(type: string, event: { data?: string } = {}) { if (!this.closed) for (const callback of this.listeners.get(type) ?? []) callback(event); }
        frame(value: unknown) { this.dispatch('message', { data: JSON.stringify(value) }); }
        send(raw: string) {
          const value = JSON.parse(raw) as { op: number };
          if (value.op === 2) globalThis.queueMicrotask(() => this.frame({ op: 0, t: 'READY', s: ++state.sequence, d: { session_id: 'synthetic-session' } }));
          if (value.op === 1) globalThis.queueMicrotask(() => this.frame({ op: 11 }));
        }
        close() { this.closed = true; }
      }
      const originalFetch = net.fetch.bind(net);
      net.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.href === 'https://bots.qq.com/app/getAppAccessToken') {
          state.tokenCalls++; return new Response(JSON.stringify({ access_token: 'synthetic-qq-token', expires_in: 7200 }), { status: 200 });
        }
        if (url.href === 'https://api.sgroup.qq.com/gateway') return new Response(JSON.stringify({ url: 'wss://api.bot.qq.com/websocket/' }), { status: 200 });
        if (url.origin === 'https://api.sgroup.qq.com' && /^\/v2\/users\/[^/]+\/messages$/u.test(url.pathname)) {
          const body = JSON.parse(String(init?.body)) as { content: string; msg_id?: string; msg_seq: number };
          state.posts.push({ recipient: decodeURIComponent(url.pathname.split('/')[3]!), content: body.content, sequence: body.msg_seq,
            ...(body.msg_id === undefined ? {} : { replyTo: body.msg_id }) });
          return new Response('{"id":"synthetic-delivery"}', { status: 200 });
        }
        if (url.protocol === 'file:' || url.protocol === 'deskpet:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
        throw new Error('Unexpected external network in isolated QQ fixture');
      };
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = Socket;
      (globalThis as unknown as { __qqE2E: Harness }).__qqE2E = { posts: state.posts, get tokenCalls() { return state.tokenCalls; },
        emit(sender, content) { [...state.sockets].reverse().find(socket => !socket.closed)?.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: ++state.sequence,
          d: { id: `synthetic-${state.sequence}`, author: { user_openid: sender }, content } }); } };
    });
  };
  const quit = async () => {
    const current = application!;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => current.process().once('exit', (code, signal) => resolve({ code, signal })));
    await current.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    expect(await exited).toEqual({ code: 0, signal: null }); application = undefined;
  };
  const posts = () => application!.evaluate(() => (globalThis as unknown as { __qqE2E: Harness }).__qqE2E.posts);
  const inbound = (content: string, sender = 'fixture-owner') => application!.evaluate(({ app }, value) => {
    if (!app.getPath('userData').includes('deskpet-qq-e2e-')) throw new Error('Refusing non-fixture profile');
    (globalThis as unknown as { __qqE2E: Harness }).__qqE2E.emit(value.sender, value.content);
  }, { sender, content });
  const settings = async () => {
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'QQ channel', exact: true }).click();
    await expect(page.locator('.qq-settings')).toBeVisible();
  };
  try {
    await launch();
    await page!.evaluate(() => window.deskpet.app.setLocale('en'));
    const initial = await page!.evaluate(() => window.deskpet.qq.getState());
    expect(initial).toMatchObject({ enabled: false, stopped: false, bound: false, appIdConfigured: false, secretConfigured: false, connection: 'disabled' });
    const surface = await page!.evaluate(() => ({ methods: Object.keys(window.deskpet.qq).sort(), node: typeof (globalThis as { require?: unknown }).require }));
    expect(surface).toEqual({ methods: ['configure', 'confirmGroupPairing', 'confirmPairing', 'getState', 'removeGroup', 'retryDeliveries', 'sendPrivateCareNow', 'sendPrivateImageTest', 'setCronDelivery', 'setGroupOpen', 'setPrivateCare', 'setPrivateReminders', 'startGroupPairing', 'startPairing', 'stop', 'unbind'], node: 'undefined' });
    const overlay = application!.windows().find(window => window.url().includes('/overlay_window/'))!;
    expect(await overlay.evaluate(async () => { try { await window.deskpet.qq.getState(); return 'unexpected'; } catch { return 'denied'; } })).toBe('denied');
    await settings();
    await expect(page!.getByRole('button', { name: 'Enable experimental QQ' })).toBeDisabled();
    await expect(page!.getByText(/QQ tasks pause after restart/u)).toBeVisible();
    expect(await application!.evaluate(() => (globalThis as unknown as { __qqE2E: Harness }).__qqE2E.tokenCalls)).toBe(0);
    const provider = await page!.evaluate(async baseUrl => window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Synthetic QQ E2E provider',
      baseUrl, model: 'qq-fixture-model', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 16384, maxOutputTokens: 4096 }), `http://127.0.0.1:${address.port}/v1`);
    await page!.reload(); await expect(page!.locator('.app-shell')).toBeVisible(); await settings();
    await page!.getByLabel('QQ AppID', { exact: true }).fill('synthetic-app');
    await page!.getByLabel('AppSecret (leave blank to keep saved secret)').fill(secret);
    await page!.getByRole('combobox', { name: /^QQ provider/u }).selectOption(provider.id);
    await page!.getByRole('button', { name: 'Save QQ settings', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ enabled: false, secretConfigured: true, providerId: provider.id, model: provider.model });
    await expect(page!.getByLabel('AppSecret (leave blank to keep saved secret)')).toHaveValue('');
    await page!.getByRole('button', { name: 'Enable experimental QQ', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ enabled: true, bound: false });
    expect(await application!.evaluate(() => (globalThis as unknown as { __qqE2E: Harness }).__qqE2E.tokenCalls)).toBe(0);
    await page!.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
    const command = await page!.locator('.qq-pairing code').first().textContent(); expect(command).toMatch(/^\/pair \d{6}$/u);
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ connection: 'online' });
    await inbound(command!);
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ bound: false, pairingCandidate: { senderId: 'fixture-owner' } });
    await inbound('hello before desktop confirmation'); expect(wires).toHaveLength(0);
    await page!.getByRole('button', { name: 'Refresh QQ status', exact: true }).click();
    await expect(page!.getByText('fixture-owner', { exact: true })).toBeVisible();
    await page!.getByRole('button', { name: 'Confirm this QQ identity', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ bound: true, pairingCandidate: null });
    const sessions = await page!.evaluate(() => window.deskpet.chat.listSessions());
    const session = sessions.find(item => item.channelBindingId)!; expect(session).toBeDefined();
    const reminderSwitch = page!.getByRole('checkbox', { name: 'Allow one-time reminders in my paired private chat' });
    await reminderSwitch.click(); await expect(reminderSwitch).toBeChecked();
    await inbound('1秒后提醒我喝水');
    await expect.poll(async () => (await posts()).find(p => p.content === '好，一秒后我提醒你喝水。')?.replyTo).toMatch(/^synthetic-/u);
    await expect.poll(async () => (await posts()).filter(p => p.content === '喝口水吧。')).toHaveLength(1);
    const pushed = (await posts()).find(p => p.content === '喝口水吧。')!;
    expect(pushed.recipient).toBe('fixture-owner'); expect(pushed.replyTo).toBeUndefined();
    expect(wires).toHaveLength(0);
    await inbound('QQ_E2E_CREATE');
    await expect.poll(async () => (await posts()).some(post => post.content.startsWith('【桌宠宿主确认'))).toBe(true);
    const notice = (await posts()).find(post => post.content.startsWith('【桌宠宿主确认'))!;
    const code = /\n\/confirm ([a-f0-9]{12})$/u.exec(notice.content)?.[1]; expect(code).toBeDefined();
    expect(await page!.evaluate(id => window.deskpet.chatWork.listCron(id), session.id)).toEqual([]);
    await expect.poll(async () => (await posts()).some(post => post.content === 'The host draft is pending your direct confirmation.')).toBe(true);
    expect(JSON.stringify(wires)).not.toContain(code!); expect(JSON.stringify(wires)).not.toContain(secret);
    const declared = wires.flatMap(wire => wire.tools?.map(tool => tool.function.description) ?? []);
    expect(declared.some(description => description.startsWith('Create recurring chat task.'))).toBe(true);
    expect(declared.some(description => description.includes('Capability: workspace.write.'))).toBe(false);
    await inbound(`/confirm ${code}`, 'intruder');
    await inbound(`/confirm ${code}`);
    await expect.poll(() => page!.evaluate(id => window.deskpet.chatWork.listCron(id), session.id)).toMatchObject([{ enabled: true, title: 'Synthetic QQ task', model: 'qq-fixture-model' }]);
    const count = wires.length; await inbound(`/confirm ${code}`);
    await expect.poll(async () => (await posts()).some(post => post.content.includes('确认码无效'))).toBe(true);
    expect(wires).toHaveLength(count);
    await expect.poll(async () => (await posts()).filter(p => p.content === 'Scheduled fixture result: 42'),
      {timeout:95_000}).toHaveLength(1);
    const cronPost = (await posts()).find(p => p.content === 'Scheduled fixture result: 42')!;
    expect(cronPost.recipient).toBe('fixture-owner'); expect(cronPost.replyTo).toBeUndefined();
    await inbound('QQ_E2E_WRITE');
    await expect.poll(async () => (await posts()).some(post => post.content === '这一轮没有完成，请在桌面查看错误详情后重试。')).toBe(true);
    await expect(readFile(join(root, 'profile/workspace/qq-must-not-write.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await inbound('QQ_E2E_WAIT'); await expect.poll(() => !!releaseLate).toBe(true);
    await page!.getByRole('button', { name: 'Emergency stop QQ', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ stopped: true, connection: 'disabled' });
    releaseLate!();
    await expect.poll(() => page!.evaluate(async id => (await window.deskpet.chat.listMessages(id)).some(message => message.status === 'streaming'), session.id)).toBe(false);
    expect((await posts()).some(post => post.content.includes('QQ_LATE_REPLY_MUST_NOT_SEND'))).toBe(false);
    expect((await posts()).every(post => post.recipient === 'fixture-owner')).toBe(true);
    expect((await page!.evaluate(id => window.deskpet.chatWork.listCron(id), session.id))[0]?.enabled).toBe(false);
    await page!.screenshot({ path: join(evidenceRoot, 'qq-en-stopped.png'), fullPage: true });
    const encrypted = await readFile(join(root, 'profile/qq-channel-state.enc.json'), 'utf8');
    expect(encrypted).not.toContain('fixture-owner'); expect(encrypted).not.toContain(secret);
    await quit(); await launch(); await settings();
    expect(await page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ stopped: true, secretConfigured: true, bound: true });
    expect(await application!.evaluate(() => (globalThis as unknown as { __qqE2E: Harness }).__qqE2E.tokenCalls)).toBe(0);
    await page!.getByRole('button', { name: 'Unbind and stop', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ bound: false, stopped: true });
    await page!.getByRole('button', { name: 'Clear saved AppSecret and stop', exact: true }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ secretConfigured: false, enabled: false });
    await page!.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await expect(page!.getByText(/重启后 QQ 任务暂停/u)).toBeVisible();
    await page!.screenshot({ path: join(evidenceRoot, 'qq-zh-disabled.png'), fullPage: true });
    expect(pageErrors).toEqual([]); expect(processOutput).not.toContain(secret);
    expect(processOutput).not.toMatch(/Uncaught Exception|uncaughtException|Object has been destroyed/iu);
    await quit();
    await writeFile(join(evidenceRoot, 'acceptance.json'), JSON.stringify({ status: 'passed', artifact: executablePath ? 'packaged-candidate' : 'development-bundle',
      storageEnvironment: executablePath ? 'platform-keychain' : 'standard-Playwright-test-keychain', transport: 'synthetic QQ gateway', model: 'loopback fixture',
      realQqVerified: false, executablePath: executablePath ?? null, identities, modelRequests: wires.length,
      independentEncryptedStateSHA256: createHash('sha256').update(encrypted).digest('hex'),
      cases: ['default-off', 'narrow-preload', 'overlay-denial', 'explicit-secret-save', 'desktop-pairing', 'host-cron-confirmation', 'no-code-in-model',
        'single-use-confirmation', 'local-write-denial', 'emergency-stop-late-reply-denial', 'encrypted-state', 'restart', 'unbind', 'clear-secret', 'bilingual-copy'] }, null, 2));
  } finally {
    releaseLate?.();
    await application?.close();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
