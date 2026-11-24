import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** Every image is a small synthetic fixture. Neither purchased artwork nor the
 * daily profile, saved provider credentials, real OpenAI or QQ is accessed. */
const png = (rgb: [number, number, number]): Buffer => {
  const chunk = (name: string, data: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set([...rgb, 255], y * 65 + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
};
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const REPLY = '收到啦，明白你的意思。';
interface ImageRequest { url: string; body: { model: string; prompt: string; n: number }; fakeCredentialMatched: boolean }
interface NetworkFixture { imageRequests: ImageRequest[]; rejected: string[] }
interface ModelRequest { messages: Array<{ role: string; content: unknown }> }
type ModelReply = string | readonly string[];

const fixture = async (replies: ReadonlyMap<string, ModelReply> = new Map()) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-media-e2e-')));
  const first = png([60, 140, 220]), second = png([180, 100, 180]), generated = png([100, 180, 120]);
  const firstFile = join(root, '收到-ok.png'), secondFile = join(root, '晚安-sleep.png');
  await Promise.all([writeFile(firstFile, first), writeFile(secondFile, second),
    writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }))]);
  const wires: ModelRequest[] = [];
  const model = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest;
      wires.push(wire);
      const userText = wire.messages.filter(message => message.role === 'user').at(-1)?.content;
      const reply = typeof userText === 'string' ? replies.get(userText) ?? REPLY : REPLY;
      const deltas = typeof reply === 'string' ? [reply] : reply;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [index, content] of deltas.entries()) {
        const final = index === deltas.length - 1;
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: final ? 'stop' : null }],
          ...(final ? { usage: { prompt_tokens: 20, completion_tokens: 10 } } : {}) })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
    const address = model.address(); if (!address || typeof address === 'string') throw Error('Missing model fixture port');
    const origin = `http://127.0.0.1:${address.port}`, entry = join(root, 'boot.cjs');
    const fakeCredential = `synthetic-media-key-${randomUUID()}`;
    await writeFile(entry, [
      "const {dialog,net,Notification}=require('electron');",
      'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});Notification.prototype.show=function(){};',
      'const network={imageRequests:[],rejected:[]};globalThis.__mediaE2eNetwork=network;',
      'const original=net.fetch.bind(net);',
      `net.fetch=async(input,opts)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;const u=new URL(url);`,
      `if(url==='https://api.openai.com/v1/images/generations'){network.imageRequests.push({url,body:JSON.parse(opts.body),fakeCredentialMatched:new Headers(opts.headers).get('authorization')===${JSON.stringify(`Bearer ${fakeCredential}`)}});return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(generated.toString('base64'))}}]}),{status:200,headers:{'content-type':'application/json'}});}`,
      `if(u.protocol==='file:'||u.origin===${JSON.stringify(origin)})return original(input,opts);network.rejected.push(u.origin+u.pathname);throw Error('Unexpected test network destination');};`,
      'globalThis.fetch=net.fetch;',
      'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    application = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env, cwd: process.cwd(), timeout: 30_000 });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    const page = application.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    const provider = await page.evaluate(async baseUrl => {
      await window.deskpet.app.setLocale('zh-CN');
      const saved = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: '合成图片回复模型',
        baseUrl, model: 'media-fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 16384, maxOutputTokens: 512 });
      await window.deskpet.providers.select(saved.id); return saved;
    }, origin + '/v1');
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    return { root, application, page, provider, first, firstFile, firstId: hash(first), secondFile, generatedId: hash(generated), wires, fakeCredential,
      network: () => application!.evaluate(() => (globalThis as typeof globalThis & { __mediaE2eNetwork: NetworkFixture }).__mediaE2eNetwork),
      async dispose() { await application?.close().catch(() => undefined); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await application?.close().catch(() => undefined); model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); throw error; }
};
const openLibrary = async (page: Page): Promise<void> => {
  await page.locator('nav').getByRole('button', { name: '工具', exact: true }).click(); await page.getByRole('tab', { name: '表情图库', exact: true }).click();
  await expect(page.getByRole('region', { name: '表情图库', exact: true })).toBeVisible();
};
const renderedImage = async (image: Locator, id: string): Promise<void> => {
  await expect(image).toHaveAttribute('src', `deskpet://managed/reply-images/${id}.png`);
  await expect.poll(() => image.evaluate(element => { const actual = element as unknown as { complete: boolean; naturalWidth: number }; return actual.complete && actual.naturalWidth; })).toBe(16);
};
const importImages = async (application: ElectronApplication, page: Page, paths: string[]): Promise<void> => {
  await application.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
  await page.getByRole('button', { name: '导入图片', exact: true }).click();
};

// eslint-disable-next-line no-empty-pattern
test('managed image library imports, edits, restores, attaches, persists and generates without external services', async ({}, info) => {
  test.setTimeout(150_000);
  const f = await fixture();
  try {
    await openLibrary(f.page);
    await importImages(f.application, f.page, [f.firstFile, f.secondFile]);
    await expect(f.page.locator('.media-card')).toHaveCount(2);
    await expect(f.page.getByText('已导入 2 张，复用 0 张，跳过 0 个文件。')).toBeVisible();
    await renderedImage(f.page.getByRole('article', { name: '收到-ok', exact: true }).getByRole('img'), f.firstId);
    await importImages(f.application, f.page, [f.firstFile, f.secondFile]);
    await expect(f.page.getByText('已导入 0 张，复用 2 张，跳过 0 个文件。')).toBeVisible();
    await expect(f.page.locator('.media-card')).toHaveCount(2);
    await f.page.getByRole('article', { name: '收到-ok', exact: true }).getByRole('button', { name: '编辑图片信息' }).click();
    const editor = f.page.getByRole('form', { name: '编辑图片信息' });
    await editor.getByLabel('图片名称').fill('收到啦 · 中文表情');
    await editor.getByLabel('场景标签').fill('收到，确认，中文测试');
    await editor.getByLabel('允许 QQ 回复使用这张图片').check();
    await editor.getByRole('button', { name: '保存图片信息', exact: true }).click();
    const card = f.page.getByRole('article', { name: '收到啦 · 中文表情', exact: true });
    await expect(card).toContainText('收到 · 确认 · 中文测试');
    await expect(card).toContainText('允许 QQ 使用');
    await card.getByRole('button', { name: '移入回收站' }).click();
    await expect(f.page.locator('.media-card')).toHaveCount(1);
    await f.page.getByRole('button', { name: '回收站 1', exact: true }).click();
    await f.page.getByRole('article', { name: '收到啦 · 中文表情', exact: true }).getByRole('button', { name: '恢复图片' }).click();
    await expect(f.page.getByText('图片已恢复到图库。')).toBeVisible();
    await f.page.getByRole('button', { name: '图库 2', exact: true }).click();
    await expect(f.page.locator('.media-card')).toHaveCount(2);
    await card.getByRole('button', { name: '放入新对话' }).click();
    await renderedImage(f.page.locator('.message.user .chat-images img'), f.firstId);
    const attachedSession = (await f.page.evaluate(() => window.deskpet.chat.listSessions())).find(session => session.title === '图片对话')!;
    expect(attachedSession).toBeTruthy();
    const savedMessages = await f.page.evaluate(id => window.deskpet.chat.listMessages(id), attachedSession.id);
    expect(savedMessages.at(-1)).toMatchObject({ role: 'user', content: '收到啦 · 中文表情', attachments: [{ assetId: f.firstId, alt: '收到啦 · 中文表情' }] });
    await f.page.reload(); await expect(f.page.locator('.app-shell')).toBeVisible();
    await renderedImage(f.page.locator('.message.user .chat-images img'), f.firstId);
    await f.page.getByRole('button', { name: '放大图片：收到啦 · 中文表情', exact: true }).click();
    await expect(f.page.getByRole('dialog', { name: '图片预览：收到啦 · 中文表情', exact: true })).toBeVisible();
    await f.page.getByRole('button', { name: '关闭预览', exact: true }).click();

    await openLibrary(f.page);
    await f.page.getByLabel('桌面回复按场景配图', { exact: true }).check();
    await f.page.getByRole('button', { name: '保存图库设置', exact: true }).click();
    await expect(f.page.getByText('图库设置已保存。')).toBeVisible();
    const automaticSession = await f.page.evaluate(async () => {
      const session = await window.deskpet.chat.createSession({ title: '桌面自动配图测试', kind: 'normal' });
      await window.deskpet.chat.openSession(session.id); return session;
    });
    await expect(f.page.getByRole('heading', { name: '桌面自动配图测试', exact: true })).toBeVisible();
    await expect(f.page.locator('.composer textarea')).toBeVisible();
    await f.page.locator('.composer textarea').fill('请确认收到这句话。');
    await f.page.locator('.send-button').click();
    await expect.poll(async () => (await f.page.evaluate(id => window.deskpet.chat.listMessages(id), automaticSession.id)).find(message => message.role === 'assistant')?.attachments).toEqual([{ assetId: f.firstId, alt: '收到啦 · 中文表情' }]);
    await expect(f.page.locator('.message.assistant')).toContainText(REPLY);
    await renderedImage(f.page.locator('.message.assistant .chat-images img'), f.firstId);
    expect(f.wires).toHaveLength(1); expect(JSON.stringify(f.wires)).not.toContain(f.first.toString('base64'));
    await f.page.screenshot({ path: info.outputPath('desktop-text-and-image.png'), scale: 'css' });

    const imageProvider = await f.page.evaluate(async apiKey => window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'openai', name: '合成 OpenAI 图像模型',
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', enabled: true, supportsTools: true, apiKey }), f.fakeCredential);
    await openLibrary(f.page);
    await f.page.getByRole('combobox', { name: /^图片生成使用的模型服务/u }).selectOption(imageProvider.id);
    await f.page.getByRole('combobox', { name: /^图像模型/u }).selectOption('gpt-image-2');
    await f.page.getByLabel('想生成什么图片', { exact: true }).fill('原创几何图形测试，绿色方块，收到啦');
    await f.page.getByRole('button', { name: '生成一张并收藏', exact: true }).click();
    await expect(f.page.getByText('图片已生成并收藏到图库。')).toBeVisible();
    await expect(f.page.locator('.media-card')).toHaveCount(3);
    const generatedCard = f.page.getByRole('article', { name: '原创几何图形测试，绿色方块，收到啦', exact: true });
    await expect(generatedCard).toContainText('生成图片');
    await renderedImage(generatedCard.getByRole('img'), f.generatedId);
    const snapshot = await f.page.evaluate(() => window.deskpet.media!.snapshot());
    expect(snapshot.assets.find(asset => asset.id === f.firstId)).toMatchObject({ title: '收到啦 · 中文表情', tags: ['收到', '确认', '中文测试'], deletedAt: null, allowQq: true });
    expect(snapshot.assets.find(asset => asset.id === f.generatedId)).toMatchObject({ source: { kind: 'generated', model: 'gpt-image-2' } });
    expect(await f.network()).toEqual({ imageRequests: [{ url: 'https://api.openai.com/v1/images/generations', body: expect.objectContaining({ model: 'gpt-image-2', prompt: '原创几何图形测试，绿色方块，收到啦', n: 1 }), fakeCredentialMatched: true }], rejected: [] });
    expect(await readFile(f.firstFile)).toEqual(f.first);
    await f.page.screenshot({ path: info.outputPath('managed-library.png'), scale: 'css' });
  } finally { await f.dispose(); }
});

interface FakeClient { on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; close(): void; readyState: number }
interface FakeServer { on(event: 'connection', listener: (client: FakeClient, request: { url?: string }) => void): void; once(event: 'listening', listener: () => void): void; address(): { port: number }; close(): void }
interface OneBotSent { user_id?: number; group_id?: number; message: Array<{ type: string; data: { text?: string; file?: string } }> }
const { Server } = createRequire(join(process.cwd(), 'package.json'))('ws') as { Server: new (options: { host: string; port: number }) => FakeServer };

// eslint-disable-next-line no-empty-pattern
test('AppController selects a managed picture and sends typed image segments to paired private and group NapCat fixtures', async ({}) => {
  test.setTimeout(150_000);
  const f = await fixture(), OWNER = 1000000001, SELF = 2000000001, GROUP = 77777;
  const token = `synthetic-napcat-token-${randomUUID()}`, clients = new Set<FakeClient>(), sent: OneBotSent[] = [];
  const napcat = new Server({ host: '127.0.0.1', port: 0 });
  let sequence = 0;
  await new Promise<void>(resolve => napcat.once('listening', resolve));
  napcat.on('connection', (client, request) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token') !== token) { client.close(); return; }
    clients.add(client);
    client.on('message', data => {
      const call = JSON.parse(String(data)) as { action: string; params: OneBotSent; echo: string };
      if (call.action === 'send_private_msg' || call.action === 'send_group_msg') sent.push(call.params);
      const result = call.action === 'get_login_info' ? { user_id: SELF, nickname: 'synthetic' } : call.action === 'get_status' ? { online: true, good: true } : { message_id: ++sequence };
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: result, echo: call.echo }));
    });
  });
  const event = (text: string, group = false) => {
    const message = group ? [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text } }] : [{ type: 'text', data: { text } }];
    const body = { post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend', self_id: SELF,
      user_id: OWNER, ...(group ? { group_id: GROUP } : {}), message_id: ++sequence, time: 1_793_000_000 + sequence, message, raw_message: text };
    for (const client of clients) if (client.readyState === 1) client.send(JSON.stringify(body));
  };
  const images = (group = false) => sent.filter(item => (group ? item.group_id === GROUP : item.user_id === OWNER) && item.message[0]?.type === 'image');
  try {
    await openLibrary(f.page); await importImages(f.application, f.page, [f.firstFile]);
    await expect(f.page.locator('.media-card')).toHaveCount(1);
    await f.page.evaluate(async id => {
      await window.deskpet.media!.update({ id, title: '收到啦', tags: ['收到', '确认'], allowQq: true });
      const { settings } = await window.deskpet.media!.snapshot(); await window.deskpet.media!.configure({ ...settings, autoReplyQq: true });
    }, f.firstId);
    await f.page.evaluate(config => window.deskpet.qq.configure(config), { transport: 'onebot' as const, onebotUrl: `ws://127.0.0.1:${napcat.address().port}`,
      appSecret: token, enabled: true, providerId: f.provider.id, model: f.provider.model });
    const state = () => f.page.evaluate(() => window.deskpet.qq.getState());
    const pairing = await f.page.evaluate(() => window.deskpet.qq.startPairing());
    await expect.poll(state).toMatchObject({ connection: 'online' }); event(`/pair ${pairing.code}`);
    await expect.poll(state).toMatchObject({ pairingCandidate: { senderId: String(OWNER) } });
    const candidate = (await state()).pairingCandidate!;
    await f.page.evaluate(id => window.deskpet.qq.confirmPairing(id), candidate.id);
    await expect.poll(state).toMatchObject({ bound: true });
    event('私聊里请确认收到。');
    await expect.poll(() => images()).toHaveLength(1);
    expect(sent.filter(item => item.user_id === OWNER).map(item => item.message[0]?.type)).toEqual(['text', 'image']);
    expect(sent.find(item => item.user_id === OWNER && item.message[0]?.type === 'text')?.message).toEqual([{ type: 'text', data: { text: REPLY } }]);
    expect(images()[0]).toEqual({ user_id: OWNER, message: [{ type: 'image', data: { file: `base64://${f.first.toString('base64')}` } }] });

    const groupPairing = await f.page.evaluate(() => window.deskpet.qq.startGroupPairing()); event(`/pair ${groupPairing.code}`, true);
    await expect.poll(state).toMatchObject({ groupCandidate: { groupId: String(GROUP) } });
    await f.page.evaluate(id => window.deskpet.qq.confirmGroupPairing(id), (await state()).groupCandidate!.id);
    await expect.poll(state).toMatchObject({ groups: [{ groupId: String(GROUP), openToMembers: true }] });
    event('群聊里也请确认收到。', true);
    await expect.poll(() => images(true)).toHaveLength(1);
    expect(sent.filter(item => item.group_id === GROUP).map(item => item.message[0]?.type)).toEqual(['text', 'image']);
    expect(images(true)[0]).toEqual({ group_id: GROUP, message: [{ type: 'image', data: { file: `base64://${f.first.toString('base64')}` } }] });
    const channelMessages = await f.page.evaluate(async () => {
      const sessions = (await window.deskpet.chat.listSessions()).filter(session => session.channelBindingId);
      return (await Promise.all(sessions.map(session => window.deskpet.chat.listMessages(session.id)))).flat();
    });
    expect(channelMessages.filter(message => message.role === 'assistant' && message.attachments?.[0]?.assetId === f.firstId)).toHaveLength(2);
    expect(f.wires).toHaveLength(2); expect(JSON.stringify(f.wires)).not.toContain(f.first.toString('base64')); expect(JSON.stringify(f.wires)).not.toContain(token);
    expect(await f.network()).toEqual({ imageRequests: [], rejected: [] });
    await f.page.evaluate(() => window.deskpet.qq.stop());
    await expect.poll(state).toMatchObject({ stopped: true, connection: 'disabled', uncertainOutbox: 0, failedOutbox: 0 });
    const encrypted = await readFile(join(f.root, 'profile/qq-channel-state.enc.json'), 'utf8');
    expect(encrypted).not.toContain(token); expect(encrypted).not.toContain(f.first.toString('base64'));
  } finally { for (const client of clients) client.close(); napcat.close(); await f.dispose(); }
});

interface OfficialPost {
  path: string;
  method: string;
  authorized: boolean;
  body: { msg_seq?: number; msg_type?: number; msg_id?: string; content?: string };
}
interface OfficialHarness {
  posts: OfficialPost[];
  emit(content: string, scope: 'users' | 'groups'): string;
  acknowledgeText(): void;
}
type OfficialHarnessGlobal = typeof globalThis & { __officialMediaE2e: OfficialHarness };

const officialHarness = async (application: ElectronApplication, appId: string, secret: string) => {
  const owner = 'fixture-private-owner', group = 'fixture-group-openid', member = 'fixture-group-member';
  const token = `synthetic-official-token-${randomUUID()}`;
  await application.evaluate(({ net }, fixtureIds) => {
    const gateway = 'wss://api.bot.qq.com/websocket/';
    const posts: OfficialPost[] = [];
    const connection: { socket?: Socket } = {};
    let sequence = 0;
    let acknowledgeText: (() => void) | undefined;
    class Socket {
      closed = false;
      listeners = new Map<string, (event: { data: string }) => void>();
      constructor(url: string) {
        if (url !== gateway) throw new Error('Unexpected official QQ gateway in fixture');
        connection.socket = this;
        globalThis.queueMicrotask(() => this.frame({ op: 10, d: { heartbeat_interval: 45_000 } }));
      }
      addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
      frame(value: unknown) { if (!this.closed) this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
      send(raw: string) {
        const { op } = JSON.parse(raw) as { op: number };
        if (op === 2) globalThis.queueMicrotask(() => this.frame({ op: 0, t: 'READY', s: ++sequence, d: { session_id: 'fixture-session' } }));
        if (op === 1) globalThis.queueMicrotask(() => this.frame({ op: 11 }));
      }
      close() { this.closed = true; }
    }
    const original = net.fetch.bind(net);
    net.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.href === 'https://bots.qq.com/app/getAppAccessToken') {
        const request = JSON.parse(String(init?.body)) as { appId?: string; clientSecret?: string };
        if (init?.method !== 'POST' || request.appId !== fixtureIds.appId || request.clientSecret !== fixtureIds.secret) {
          throw new Error('Unexpected official QQ credentials in fixture');
        }
        return Response.json({ access_token: fixtureIds.token, expires_in: 7200 });
      }
      if (url.origin !== 'https://api.sgroup.qq.com') return original(input, init);
      const authorized = new Headers(init?.headers).get('authorization') === `QQBot ${fixtureIds.token}`;
      if (url.pathname === '/gateway' && init?.method === 'GET' && authorized) return Response.json({ url: gateway });
      const match = /^\/v2\/(users|groups)\/[^/]+\/(files|messages)$/u.exec(url.pathname);
      if (!match) return original(input, init);
      const body = JSON.parse(String(init?.body)) as OfficialPost['body'];
      posts.push({ path: url.pathname, method: init?.method ?? '', authorized, body });
      if (match[2] === 'files') return Response.json({ file_info: `fixture-file-info-${match[1]}`, ttl: 300, file_uuid: 'fixture-file-uuid' });
      if (body.msg_type === 0) await new Promise<void>(resolve => { acknowledgeText = resolve; });
      return Response.json({ id: `fixture-receipt-${posts.length}` });
    };
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = Socket;
    (globalThis as OfficialHarnessGlobal).__officialMediaE2e = {
      posts,
      emit(content, scope) {
        const socket = connection.socket;
        if (!socket || socket.closed) throw new Error('No active official QQ fixture connection');
        const id = `fixture-inbound-${++sequence}`;
        const frame = scope === 'groups'
          ? { t: 'GROUP_AT_MESSAGE_CREATE', d: { id, content: `<@fixture-bot> ${content}`, group_openid: fixtureIds.group, author: { member_openid: fixtureIds.member } } }
          : { t: 'C2C_MESSAGE_CREATE', d: { id, content, author: { user_openid: fixtureIds.owner } } };
        socket.frame({ op: 0, s: sequence, ...frame });
        return id;
      },
      acknowledgeText() { acknowledgeText?.(); acknowledgeText = undefined; },
    };
  }, { appId, secret, token, owner, group, member });
  return {
    owner, group, token,
    posts: () => application.evaluate(() => (globalThis as OfficialHarnessGlobal).__officialMediaE2e.posts),
    emit: (content: string, scope: 'users' | 'groups') => application.evaluate((_electron, args) => (globalThis as OfficialHarnessGlobal).__officialMediaE2e.emit(args.content, args.scope), { content, scope }),
    acknowledgeText: () => application.evaluate(() => (globalThis as OfficialHarnessGlobal).__officialMediaE2e.acknowledgeText()),
  };
};

const pairedOfficialFixture = async (replies: ReadonlyMap<string, ModelReply>, title: string, tags: string[]) => {
  const f = await fixture(replies);
  const appId = '123456789', secret = `synthetic-official-secret-${randomUUID()}`;
  const state = () => f.page.evaluate(() => window.deskpet.qq.getState());
  try {
    const qq = await officialHarness(f.application, appId, secret);
    await openLibrary(f.page);
    await importImages(f.application, f.page, [f.firstFile]);
    await expect(f.page.locator('.media-card')).toHaveCount(1);
    await f.page.evaluate(async asset => {
      await window.deskpet.media!.update({ ...asset, allowQq: true });
      const { settings } = await window.deskpet.media!.snapshot();
      await window.deskpet.media!.configure({ ...settings, autoReplyQq: true });
    }, { id: f.firstId, title, tags });
    await f.page.evaluate(config => window.deskpet.qq.configure(config), { transport: 'official' as const, appId,
      appSecret: secret, enabled: true, providerId: f.provider.id, model: f.provider.model });
    const pairing = await f.page.evaluate(() => window.deskpet.qq.startPairing());
    await expect.poll(state).toMatchObject({ connection: 'online', transport: 'official' });
    await qq.emit(`/pair ${pairing.code}`, 'users');
    await expect.poll(state).toMatchObject({ pairingCandidate: { senderId: qq.owner } });
    await f.page.evaluate(id => window.deskpet.qq.confirmPairing(id), (await state()).pairingCandidate!.id);
    await expect.poll(state).toMatchObject({ bound: true });
    return { ...f, qq, secret, state, async dispose() {
      await qq.acknowledgeText().catch(() => undefined);
      await f.dispose();
    } };
  } catch (error) { await f.dispose(); throw error; }
};

const settledQqOutbox = { pendingOutbox: 0, failedOutbox: 0, uncertainOutbox: 0 };
const officialUpload = (target: string, bytes: string) => ({ path: `${target}/files`, method: 'POST', authorized: true,
  body: { file_type: 1, file_name: 'deskpet-image.png', file_data: bytes, srv_send_msg: false } });
const officialText = (target: string, replyTo: string, content: string) => ({ path: `${target}/messages`, method: 'POST', authorized: true,
  body: { content, msg_type: 0, msg_id: replyTo, msg_seq: expect.any(Number) } });
const officialImage = (target: string, scope: 'users' | 'groups', replyTo?: string) => ({ path: `${target}/messages`, method: 'POST', authorized: true,
  body: { msg_type: 7, media: { file_info: `fixture-file-info-${scope}` }, msg_seq: expect.any(Number), ...(replyTo === undefined ? {} : { msg_id: replyTo }) } });

// eslint-disable-next-line no-empty-pattern
test('official QBot uses semantic private sticker choices and keeps paired group replies and diagnostics working', async ({}) => {
  test.setTimeout(90_000);
  const acknowledge = '请确认收到这句话。', celebrate = '最后那关我过啦！', celebrationReply = '这下总算能松口气了。';
  const optOut = '只用文字回我。', optOutReply = '好，这次用文字。';
  const f = await pairedOfficialFixture(new Map<string, ModelReply>([
    [optOut, `[sticker:with-text:celebrate]\n${optOutReply}`],
    [acknowledge, `[sticker:none]\n${REPLY}`],
    [celebrate, ['[sti', 'cker:with-text:celebrate]', `\n${celebrationReply}`]],
  ]), '收到啦', ['收到', '确认', '庆祝']);
  const { qq, state } = f;
  try {

    const groupPairing = await f.page.evaluate(() => window.deskpet.qq.startGroupPairing());
    await qq.emit(`/pair ${groupPairing.code}`, 'groups');
    await expect.poll(state).toMatchObject({ groupCandidate: { groupId: qq.group } });
    await f.page.evaluate(id => window.deskpet.qq.confirmGroupPairing(id), (await state()).groupCandidate!.id);
    await expect.poll(state).toMatchObject({ groups: [{ groupId: qq.group, openToMembers: true }] });

    const bytes = f.first.toString('base64'), privateTarget = `/v2/users/${qq.owner}`;
    const textOnlyPosts: Array<ReturnType<typeof officialText>> = [];
    // These requests can both match the eligible asset and run before any cooldown.
    for (const [inbound, draft] of [[optOut, optOutReply], [acknowledge, REPLY]] as const) {
      const replyTo = await qq.emit(inbound, 'users');
      textOnlyPosts.push(officialText(privateTarget, replyTo, draft));
      await expect.poll(qq.posts).toEqual(textOnlyPosts);
      await qq.acknowledgeText();
      await expect.poll(state).toMatchObject(settledQqOutbox);
      expect(await qq.posts()).toEqual(textOnlyPosts);
    }

    for (const [scope, recipient, inbound, draft] of [
      ['users', qq.owner, celebrate, celebrationReply],
      ['groups', qq.group, '群里也请确认收到。', REPLY],
    ] as const) {
      const start = (await qq.posts()).length;
      const replyTo = await qq.emit(inbound, scope);
      const target = `/v2/${scope}/${recipient}`;
      const replyPosts = async () => (await qq.posts()).slice(start);
      const text = officialText(target, replyTo, draft);
      await expect.poll(replyPosts).toEqual([text]);
      await qq.acknowledgeText();
      await expect.poll(replyPosts).toEqual([text, officialUpload(target, bytes), officialImage(target, scope, replyTo)]);
      const [textPost, , imagePost] = await replyPosts();
      expect(imagePost!.body.msg_seq).not.toBe(textPost!.body.msg_seq);
      await expect.poll(state).toMatchObject(settledQqOutbox);
    }
    expect(await qq.posts()).toHaveLength(8);
    const privateBindingId = (await state()).privateBindingId;
    await f.page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await f.page.getByRole('tab', { name: 'QQ 通道', exact: true }).click();
    await f.page.getByRole('button', { name: '向已绑定私聊发送测试表情', exact: true }).click();
    await expect(f.page.getByText('QQ 已确认发送测试表情 · 收到啦', { exact: true })).toBeVisible();
    expect((await qq.posts()).slice(8)).toEqual([officialUpload(privateTarget, bytes), officialImage(privateTarget, 'users')]);
    expect(await state()).toMatchObject({ privateBindingId, dailyRequests: 3, groupRequests: 1, ...settledQqOutbox });
    const channelMessages = await f.page.evaluate(async () => {
      const sessions = (await window.deskpet.chat.listSessions()).filter(session => session.channelBindingId);
      return (await Promise.all(sessions.map(session => window.deskpet.chat.listMessages(session.id)))).flat();
    });
    const replies = channelMessages.filter(message => message.role === 'assistant')
      .map(message => ({ content: message.content, attachments: message.attachments ?? [] }));
    const sticker = { assetId: f.firstId, alt: '收到啦' };
    expect(replies).toHaveLength(4);
    expect(replies).toEqual(expect.arrayContaining([
      { content: optOutReply, attachments: [] },
      { content: REPLY, attachments: [] },
      { content: celebrationReply, attachments: [sticker] },
      { content: REPLY, attachments: [sticker] },
    ]));
    expect(f.wires).toHaveLength(4);
    expect(f.wires.map(wire => wire.messages.some(message => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes('[sticker:none]')))).toEqual([false, true, true, false]);
    expect(JSON.stringify(f.wires.flatMap(wire => wire.messages.filter(message => message.role === 'assistant')))).not.toContain('[sticker:');
    const modelRequests = JSON.stringify(f.wires);
    expect(modelRequests).not.toContain(bytes);
    expect(modelRequests).not.toContain(f.secret);
    expect(modelRequests).not.toContain(qq.token);
    expect(await f.network()).toEqual({ imageRequests: [], rejected: [] });
    await f.page.evaluate(() => window.deskpet.qq.stop());
    await expect.poll(state).toMatchObject({ stopped: true, connection: 'disabled' });
  } finally { await f.dispose(); }
});

// eslint-disable-next-line no-empty-pattern
test('official QBot sends a single private sticker or its text fallback for an unavailable scene', async ({}) => {
  const missing = '今天有点闷。', fallback = '慢慢来，我陪着你。', greeting = '喂，是我呀。';
  const f = await pairedOfficialFixture(new Map([
    [missing, `[sticker:only:comfort]\n${fallback}`],
    [greeting, '[sticker:only:greeting]\n我在这儿。'],
  ]), '挥挥手', ['招手', '你好']);
  const { qq, state } = f;
  try {
    const target = `/v2/users/${qq.owner}`, bytes = f.first.toString('base64');
    const missingId = await qq.emit(missing, 'users');
    const missingReply = officialText(target, missingId, fallback);
    await expect.poll(qq.posts).toEqual([missingReply]);
    await qq.acknowledgeText();
    await expect.poll(state).toMatchObject(settledQqOutbox);

    const greetingId = await qq.emit(greeting, 'users');
    const expected = [missingReply, officialUpload(target, bytes), officialImage(target, 'users', greetingId)];
    await expect.poll(qq.posts).toEqual(expected);
    await expect.poll(state).toMatchObject({ dailyRequests: 2, ...settledQqOutbox });
    expect(await qq.posts()).toEqual(expected);

    const followUpId = await qq.emit('再回一句。', 'users');
    await expect.poll(qq.posts).toEqual([...expected, officialText(target, followUpId, REPLY)]);
    await qq.acknowledgeText();
    await expect.poll(state).toMatchObject({ dailyRequests: 3, ...settledQqOutbox });
    expect(f.wires).toHaveLength(3);
    expect(f.wires.at(-1)!.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '[Sticker reply]' }));
    expect(JSON.stringify(f.wires.at(-1))).not.toContain('我在这儿。');

    const replies = await f.page.evaluate(async () => {
      const session = (await window.deskpet.chat.listSessions()).find(item => item.channelBindingId)!;
      const messages = await window.deskpet.chat.listMessages(session.id);
      return messages.filter(message => message.role === 'assistant')
        .map(message => ({ content: message.content, attachments: message.attachments ?? [] }));
    });
    expect(replies).toEqual([
      { content: fallback, attachments: [] },
      { content: '', attachments: [{ assetId: f.firstId, alt: '挥挥手' }] },
      { content: REPLY, attachments: [] },
    ]);
    expect(await f.network()).toEqual({ imageRequests: [], rejected: [] });
  } finally { await f.dispose(); }
});

// eslint-disable-next-line no-empty-pattern
test('official QBot keeps the substantive text when the model suggests an image-only answer to a question', async ({}) => {
  const question = '你能解释这条记录为什么会失败吗？', answer = '先检查网络连接，再重试这条记录。';
  const f = await pairedOfficialFixture(new Map([[question, `[sticker:only:greeting]\n${answer}`]]), '挥挥手', ['招手']);
  const { qq, state } = f;
  try {
    const target = `/v2/users/${qq.owner}`, replyTo = await qq.emit(question, 'users');
    const text = officialText(target, replyTo, answer);
    await expect.poll(qq.posts).toEqual([text]);
    await qq.acknowledgeText();
    await expect.poll(state).toMatchObject({ dailyRequests: 1, ...settledQqOutbox });
    expect(await qq.posts()).toEqual([text]);
    expect(f.wires).toHaveLength(1);
  } finally { await f.dispose(); }
});
