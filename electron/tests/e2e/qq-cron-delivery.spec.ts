import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTelegram } from './support/fake-telegram';

interface FakeClient { on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; close(): void; readyState: number }
interface FakeServer { on(event: 'connection', listener: (client: FakeClient) => void): void; once(event: 'listening', listener: () => void): void; address(): { port: number }; close(): void }
const { Server } = createRequire(join(process.cwd(), 'package.json'))('ws') as { Server: new (options: { host: string; port: number }) => FakeServer };
const OWNER = 1000000001, SELF = 2000000001;

// Wall time, the model and NapCat are synthetic. The schedule is made through a real
// desktop tool approval and runs on the host's own timer; QQ gets only the opted-in run.
// eslint-disable-next-line no-empty-pattern
test('a desktop schedule sends its result to the bound QQ private chat only while the owner has it switched on', async ({}) => {
  test.setTimeout(120_000);
  const f = await fakeTelegram({ cron: true });
  // Add protocol controls and evidence at the fake model boundary, not in the
  // channel sender: the real cron/chat/filter/outbox pipeline must project them.
  const source = '来源：合成天气网 https://weather.example.invalid/today';
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(f.base + request.url, { method: request.method ?? 'GET', headers: { 'content-type': 'application/json' },
      ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const body = (await upstream.text()).split('\n').map(line => {
      if (!line.startsWith('data: {')) return line;
      const event = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
      for (const choice of event.choices ?? []) if (choice.delta?.content?.startsWith('Fixture scheduled result ')) choice.delta.content = `[sticker:none]\n${choice.delta.content}\n${source}`;
      return 'data: ' + JSON.stringify(event);
    }).join('\n');
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }); response.end(body);
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw Error('Missing fake model port');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-qq-cron-')));
  const token = `synthetic-${randomUUID()}`;
  const sent: Array<{ user_id?: number; message: Array<{ data: { text?: string } }> }> = [], clients = new Set<FakeClient>();
  let sequence = 0;
  const napcat = new Server({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => { napcat.once('listening', resolve); });
  napcat.on('connection', client => {
    clients.add(client);
    client.on('message', data => {
      const call = JSON.parse(String(data)) as { action: string; params: typeof sent[number]; echo: string };
      if (call.action === 'send_private_msg') sent.push(call.params);
      const result = call.action === 'get_login_info' ? { user_id: SELF, nickname: 'alt' } : call.action === 'get_status' ? { online: true, good: true } : { message_id: ++sequence };
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: result, echo: call.echo }));
    });
  });
  const event = (text: string) => {
    const body = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: OWNER, time: 1_793_000_000 + ++sequence,
      message_id: sequence, message: [{ type: 'text', data: { text } }], raw_message: text });
    for (const client of clients) if (client.readyState === 1) client.send(body);
  };
  const texts = () => sent.filter(item => item.user_id === OWNER).map(item => item.message.map(segment => segment.data.text).join(''));
  const entry = join(root, 'boot.cjs');
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await writeFile(entry, [
    "const {dialog,Notification}=require('electron');",
    'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};',
    "const OriginalDate=Date;let clockDelta=OriginalDate.parse('2026-11-04T02:00:10Z')-OriginalDate.now();const clock=()=>OriginalDate.now()+clockDelta;global.__fixtureCronClock=ms=>{clockDelta=ms-OriginalDate.now();};",
    "global.Date=new Proxy(OriginalDate,{construct:(t,args)=>Reflect.construct(t,args.length?args:[clock()]),get:(t,k)=>k==='now'?clock:Reflect.get(t,k)});",
    'const interval=global.setInterval;global.setInterval=(cb,ms,...args)=>interval(cb,ms===15000?250:ms,...args);',
    'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
  ].join('\n'));
  let app: ElectronApplication | undefined;
  try {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    const provider = await page.evaluate(baseUrl => window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Scheduled fixture',
      baseUrl, model: 'controlled', enabled: true, supportsTools: true, localExecutionConfirmed: true }), `http://127.0.0.1:${modelAddress.port}/v1`);
    const state = () => page.evaluate(() => window.deskpet.qq.getState());
    await page.evaluate(input => window.deskpet.qq.configure(input), { transport: 'onebot' as const, onebotUrl: `ws://127.0.0.1:${napcat.address().port}`, appSecret: token, providerId: provider.id, model: provider.model });
    await page.evaluate(() => window.deskpet.qq.configure({ enabled: true }));
    const { code } = await page.evaluate(() => window.deskpet.qq.startPairing());
    await expect.poll(state).toMatchObject({ connection: 'online' });
    event('/pair ' + code);
    await expect.poll(async () => (await state()).pairingCandidate?.id).toBeTruthy();
    const bound = await page.evaluate(id => window.deskpet.qq.confirmPairing(id), (await state()).pairingCandidate!.id);
    expect(bound.privateBindingId).toBeTruthy();

    const session = await page.evaluate(() => window.deskpet.chat.createSession({ kind: 'normal', title: '早安' }));
    await page.evaluate(input => window.deskpet.chat.send(input), { sessionId: session.id, providerId: provider.id, content: 'Create fixture recurring check' });
    const interaction = () => page.evaluate(id => window.deskpet.chat.getInteraction(id), session.id);
    await expect.poll(async () => (await interaction())?.approval?.toolId).toBe('cron.create');
    const approval = (await interaction())!.approval!;
    await page.evaluate(input => window.deskpet.chat.resolveApproval(input), { runId: approval.runId, approvalId: approval.id, sessionId: session.id, decision: 'allow-once' as const });
    const schedules = () => page.evaluate(id => window.deskpet.chatWork.listCron(id), session.id);
    await expect.poll(async () => (await schedules()).length).toBe(1);
    await expect.poll(async () => !(await interaction())).toBe(true);
    const runNext = async (n: number) => {
      const due = (await schedules())[0]!.nextRunAt!;
      await app!.evaluate((_, ms) => (globalThis as unknown as { __fixtureCronClock: (time: number) => void }).__fixtureCronClock(ms), Date.parse(due) + 1000);
      await expect.poll(() => page.evaluate(({ id, answer }) => window.deskpet.chat.listMessages(id).then(messages =>
        messages.some(message => message.role === 'assistant' && message.status === 'complete' && message.content === answer)), { id: session.id, answer: `[sticker:none]\nFixture scheduled result ${n}\n${source}` }), { timeout: 20_000 }).toBe(true);
    };
    const delivered = (n: number) => texts().filter(text => text === `Fixture scheduled result ${n}\n（合成天气网说的）`);

    await runNext(1);
    await page.locator('nav').getByRole('button', { name: '日程', exact: true }).click();
    const toggle = page.getByRole('checkbox', { name: /将结果发送到我的 QQ 私聊/u });
    await toggle.click();
    await expect.poll(async () => (await schedules())[0]!.qqDelivery?.bindingId).toBe(bound.privateBindingId);
    await runNext(2);
    await expect.poll(() => delivered(2).length, { timeout: 12_000 }).toBe(1);
    expect(texts().join('\n')).not.toContain('[sticker:'); expect(texts().join('\n')).not.toContain('weather.example.invalid');
    expect(delivered(1)).toHaveLength(0);
    await expect(toggle).toBeChecked(); await toggle.click();
    await expect.poll(async () => (await schedules())[0]!.qqDelivery).toBeUndefined();
    await runNext(3);
    await page.waitForTimeout(1_500);
    expect(delivered(3)).toHaveLength(0);
    // The QQ conversation itself holds nothing from the desktop schedule.
    const qqSession = (await page.evaluate(() => window.deskpet.chat.listSessions())).find(item => item.title === 'QQ')!;
    expect(JSON.stringify(await page.evaluate(id => window.deskpet.chat.listMessages(id), qqSession.id))).not.toContain('Fixture scheduled result');
  } finally {
    await app?.close().catch(() => undefined);
    napcat.close(); await f.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
