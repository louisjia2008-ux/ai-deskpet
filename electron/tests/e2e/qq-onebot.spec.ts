import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeClient { on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; close(): void; readyState: number }
interface FakeServer { on(event: 'connection', listener: (client: FakeClient, request: { url?: string }) => void): void; once(event: 'listening', listener: () => void): void; address(): { port: number }; close(): void }
const { Server } = createRequire(join(process.cwd(), 'package.json'))('ws') as { Server: new (options: { host: string; port: number }) => FakeServer };
interface Sent { user_id?: number; group_id?: number; message: Array<{ type: string; data: { text?: string } }> }

const OWNER = 1000000001, INTRUDER = 1000000002, SELF = 2000000001;
const GROUP = 77777;

/** Real sockets and the real main-process WebSocket; only NapCat and the model
 * are synthetic. Auth and framing follow NapCat's websocket-server.ts. */
// eslint-disable-next-line no-empty-pattern
test('secondary-account OneBot pairing, replies and stop run over a real local WebSocket', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-qq-e2e-')));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const token = `synthetic-${randomUUID()}`;
  const paragraphs = ['[CQ:at,qq=all] 这是第一段。\n\n', '这是第二段。\n\n', '最后一段。'];
  const reply = paragraphs.join('');
  const sent: Sent[] = [], groupSent: Sent[] = [], clients = new Set<FakeClient>(), urls: string[] = [];
  let sequence = 0;
  const napcat = new Server({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => { napcat.once('listening', resolve); });
  napcat.on('connection', (client, request) => {
    urls.push(request.url ?? '');
    if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token') !== token) {
      client.send(JSON.stringify({ status: 'failed', retcode: 1403, data: null, message: 'token验证失败' })); client.close(); return;
    }
    clients.add(client);
    client.on('message', data => {
      const call = JSON.parse(String(data)) as { action: string; params: Sent; echo: string };
      if (call.action === 'send_private_msg') sent.push(call.params);
      if (call.action === 'send_group_msg') groupSent.push(call.params);
      const result = call.action === 'get_login_info' ? { user_id: SELF, nickname: 'alt' } : call.action === 'get_status' ? { online: true, good: true } : { message_id: ++sequence };
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: result, echo: call.echo }));
    });
  });
  const event = (text: string, patch: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: OWNER, time: 1_793_000_000 + ++sequence,
      message_id: sequence, message: [{ type: 'text', data: { text } }], raw_message: text, ...patch });
    for (const client of clients) if (client.readyState === 1) client.send(body);
  };
  const texts = () => sent.map(item => item.message.map(segment => segment.data.text).join(''));
  const exam = '我明天要考试';
  const examSummary = '主人明天要考试';
  const wires: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  const model = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[{"id":"qq-fixture-model"}]}'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof wires[number];
      wires.push(body);
      const input = body.messages.filter(message => message.role === 'user').at(-1)?.content;
      const content = body.messages[0]?.content.startsWith('Summarize the owner') ? JSON.stringify({ summary: examSummary })
        : input === exam ? '[mood:happy] 加油。' : reply;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
  const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw new Error('Missing fixture port');
  let application: ElectronApplication | undefined, page: Page;
  const state = () => page.evaluate(() => window.deskpet.qq.getState());
  const save = async (value: string) => {
    await page.getByLabel('OneBot access token (leave blank to keep saved token)').fill(value);
    await page.getByRole('button', { name: 'Save QQ settings', exact: true }).click();
    await expect.poll(state).toMatchObject({ transport: 'onebot', secretConfigured: true, stopped: true });
    await page.getByRole('button', { name: 'Enable experimental QQ', exact: true }).click();
    await expect.poll(state).toMatchObject({ enabled: true, stopped: false });
  };
  try {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    const executablePath = process.env.DESKPET_QQ_APP;
    application = await electron.launch({ env, cwd: process.cwd(), timeout: 30_000,
      ...(executablePath ? { executablePath, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'] }
        : { args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js'), `--deskpet-isolated-profile=${root}`] }) });
    await application.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(async () => { await window.deskpet.app.setLocale('en'); await window.deskpet.autoMemory.configure({ enabled: false }); }); // this test moves the clock and counts model requests
    const provider = await page.evaluate(async baseUrl => window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Synthetic OneBot provider',
      baseUrl, model: 'qq-fixture-model', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 16384, maxOutputTokens: 4096 }), `http://127.0.0.1:${modelAddress.port}/v1`);
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'QQ channel', exact: true }).click();
    await page.getByLabel('Connection method').selectOption('onebot');
    await expect(page.getByText(/secondary account you can afford to lose/u)).toBeVisible();
    await page.getByLabel('OneBot WebSocket address (this computer only)').fill(`ws://127.0.0.1:${napcat.address().port}`);
    await page.getByRole('combobox', { name: /^QQ provider/u }).selectOption(provider.id);

    await save('wrong-token');
    await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
    await expect.poll(state).toMatchObject({ lastError: 'qq.onebotAuthFailed' });
    await page.getByRole('button', { name: 'Refresh QQ status', exact: true }).click();
    await expect(page.getByText(/NapCat rejected the access token/u)).toBeVisible();
    expect(clients.size).toBe(0);

    await save(token);
    await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
    const command = await page.locator('.qq-pairing code').first().textContent(); expect(command).toMatch(/^\/pair \d{6}$/u);
    await expect.poll(state).toMatchObject({ connection: 'online', lastError: null });
    event(command!, { message_type: 'group', group_id: 1, sub_type: 'normal' });
    event(command!, { sub_type: 'group' });
    await page.waitForTimeout(300);
    expect((await state()).pairingCandidate).toBeNull();
    event(command!);
    await expect.poll(state).toMatchObject({ bound: false, pairingCandidate: { senderId: String(OWNER) } });
    await page.getByRole('button', { name: 'Refresh QQ status', exact: true }).click();
    await expect(page.getByText('Verify that this is your own QQ number before approving.')).toBeVisible();
    event('hello before desktop confirmation'); await page.waitForTimeout(300); expect(wires).toHaveLength(0);
    await page.getByRole('button', { name: 'Confirm this QQ identity', exact: true }).click();
    await expect.poll(state).toMatchObject({ bound: true, pairingCandidate: null });

    const desktopSession = await page.evaluate(() => window.deskpet.chat.createSession({ title: 'Fixture desktop', kind: 'normal' }));
    await page.evaluate(input => window.deskpet.chat.send(input), { sessionId: desktopSession.id, content: exam, providerId: provider.id });
    await expect.poll(() => page.evaluate(() => window.deskpet.companionRecent.status()), { timeout: 20_000 }).toMatchObject({ text: examSummary, localOnly: false });
    const overlay = application.windows().find(window => window.url().includes('/overlay_window/'))!;
    await expect.poll(() => overlay.evaluate(() => window.deskpet.character.getState())).toMatchObject({ mood: { name: 'happy' } });
    const desktopWire = wires.find(wire => wire.messages.some(message => message.role === 'user' && message.content === exam));
    expect(desktopWire).toBeDefined();

    event('/ping');
    await expect.poll(texts).toEqual(['pong']);
    expect(sent[0]).toEqual({ user_id: OWNER, message: [{ type: 'text', data: { text: 'pong' } }] });
    event('/ping', { user_id: INTRUDER }); await page.waitForTimeout(300); expect(sent).toHaveLength(1);
    event('Say something');
    await expect.poll(texts).toEqual(['pong', ...paragraphs]);
    const qqPrivateWire = wires.find(wire => wire.messages.some(message => message.role === 'user' && message.content === 'Say something'));
    expect(JSON.stringify(qqPrivateWire)).toContain(examSummary);
    expect(qqPrivateWire?.messages.some(message => message.content.includes('happy'))).toBe(true);
    expect(sent.slice(1).every(item => item.user_id === OWNER && item.message.length === 1 && item.message[0]?.type === 'text')).toBe(true);
    expect(JSON.stringify(wires)).not.toContain(token);

    const mention = (text: string, user = INTRUDER) => event(text, { message_type: 'group', sub_type: 'normal', group_id: GROUP, user_id: user,
      message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text } }] });
    mention('Before this group is approved'); await page.waitForTimeout(300); expect(groupSent).toHaveLength(0);
    await page.getByRole('button', { name: 'Generate group pairing code', exact: true }).click();
    const groupCommand = (await page.locator('.qq-groups .qq-pairing code').first().textContent())!;
    mention(groupCommand);
    await expect.poll(state).toMatchObject({ groupCandidate: { groupId: String(GROUP) } });
    await page.getByRole('button', { name: 'Refresh QQ status', exact: true }).click();
    await page.getByRole('button', { name: 'Allow this group', exact: true }).click();
    await expect.poll(state).toMatchObject({ groupCandidate: null, groups: [{ groupId: String(GROUP), openToMembers: true }] });
    const titles = await page.evaluate(async () => (await window.deskpet.chat.listSessions()).map(item => item.title));
    expect(titles).toContain('QQ'); expect(titles).toContain(`QQ group · ${GROUP}`);
    const before = wires.length;
    mention('Say something to the group');
    await expect.poll(() => groupSent.map(item => item.message[0]?.data.text)).toEqual(paragraphs);
    expect(groupSent.every(item => item.group_id === GROUP && item.message[0]?.type === 'text')).toBe(true);
    const wire = JSON.stringify(wires[before]);
    expect(wire).toContain('Say something to the group');
    expect(wire).not.toContain('Say something"');
    expect(wire).not.toContain(examSummary);
    if (process.env.DESKPET_QQ_EVIDENCE) {
      await mkdir(process.env.DESKPET_QQ_EVIDENCE, { recursive: true });
      await writeFile(join(process.env.DESKPET_QQ_EVIDENCE, 'phase-a-qq-wire.json'),
        JSON.stringify({ desktop: desktopWire, qqPrivate: qqPrivateWire, qqGroup: wires[before] }, null, 2), { mode: 0o600 });
    }
    await testInfo.attach('same-self-wire', { body: JSON.stringify({ desktop: desktopWire, qqPrivate: qqPrivateWire, qqGroup: wires[before] }), contentType: 'application/json' });
    expect((wires[before] as { tools?: unknown[] }).tools ?? []).toHaveLength(4);
    expect((wires[before] as { messages: Array<{ content: string }> }).messages.some(message => message.content.includes('hello before desktop confirmation'))).toBe(false);

    await page.locator('nav').getByRole('button', { name: 'Memory', exact: true }).click();
    const memory = page.getByRole('region', { name: 'Recent conversations with you' });
    await expect(memory.getByText(examSummary, { exact: true })).toBeVisible();
    await expect(memory.getByRole('checkbox', { name: 'Keep the summary local' })).not.toBeChecked();
    const memoryScreenshot = testInfo.outputPath('memory-recent.png');
    await page.screenshot({ path: memoryScreenshot, scale: 'css' });
    await testInfo.attach('memory-recent', { path: memoryScreenshot, contentType: 'image/png' });
    await memory.getByRole('button', { name: 'Clear summary', exact: true }).click();
    await memory.getByRole('button', { name: 'Confirm clear', exact: true }).click();
    await expect(memory.getByText('There is no summary for the last 36 hours yet.', { exact: true })).toBeVisible();
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'QQ channel', exact: true }).click();

    // Drive the normal host timer at an afternoon check-in window. No new
    // inbound QQ event or manual "send now" action initiates this message.
    await application.evaluate(({powerMonitor}) => {
      const Original = Date;
      const afternoon = new Original();
      afternoon.setUTCDate(afternoon.getUTCDate() + 1); afternoon.setUTCHours(15, 3, 0, 0);
      const offset = afternoon.getTime() - Original.now();
      globalThis.Date = new Proxy(Original, {
        construct(target, args) { return Reflect.construct(target, args.length ? args : [Original.now() + offset]); },
        get(target, key) { return key === 'now' ? () => Original.now() + offset : Reflect.get(target, key); },
      });
      powerMonitor.getSystemIdleTime = () => 1800;
    });
    await page.evaluate(async id => {
      await window.deskpet.permissions.request({ capabilityId: 'automation.text', duration: 'always' });
      const {revision, ...policy} = (await window.deskpet.automation.snapshot()).proactivePolicy;
      void revision;
      await window.deskpet.automation.configureProactive({ ...policy, enabled: true, mode: 'auto',
        eventKinds: ['explicit-check-in'], timezone:'UTC', quietStart:'00:00', quietEnd:'00:00',
        providerId: id, model:'qq-fixture-model' });
    },provider.id);
    const care = page.getByRole('checkbox',{name:'Send check-ins to my paired QQ private chat'});
    await care.click(); await expect(care).toBeChecked();
    const modelRequestsBeforeCare = wires.length;
    await expect.poll(() => texts().filter(text => text.startsWith('Good afternoon.')), {timeout:40_000}).toHaveLength(1);
    expect(sent.at(-1)?.user_id).toBe(OWNER);
    expect(groupSent).toHaveLength(paragraphs.length); expect(wires).toHaveLength(modelRequestsBeforeCare);
    await expect.poll(state).toMatchObject({lastPrivatePush:{status:'sent'}});

    await page.getByRole('button', { name: 'Emergency stop QQ', exact: true }).click();
    await expect.poll(state).toMatchObject({ stopped: true, connection: 'disabled' });
    await expect.poll(() => [...clients].every(client => client.readyState !== 1)).toBe(true);
    const encrypted = await readFile(join(root, 'profile/qq-channel-state.enc.json'), 'utf8');
    expect(encrypted).not.toContain(token); expect(encrypted).not.toContain(String(OWNER));
  } finally {
    await application?.close().catch(() => undefined);
    napcat.close(); model.close();
    await rm(root, { recursive: true, force: true });
  }
});
