import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/shared';
import type { ChatWorkTask } from '../../src/shared/chat-work';

interface FakeClient {
  on(event: 'message', listener: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}
interface FakeServer {
  on(event: 'connection', listener: (client: FakeClient, request: { url?: string }) => void): void;
  once(event: 'listening', listener: () => void): void;
  address(): { port: number };
  close(callback: () => void): void;
}
interface SentMessage {
  user_id?: number;
  group_id?: number;
  message: Array<{ type: string; data: { text?: string } }>;
}
interface WireMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}
interface Wire {
  model: string;
  messages: WireMessage[];
  tools?: Array<{ function: { name: string; description: string } }>;
}
interface PageSource { url: string; text: string; sourceSHA256: string; truncated: boolean }
interface FailureResult { ok: false; skipped?: boolean; error: { code: string } }
interface RoundEvidence { round: number; prompt: string; choice: string; final: ChatMessage; task: ChatWorkTask; delivery: string; runId: string }

const { Server } = createRequire(join(process.cwd(), 'package.json'))('ws') as {
  Server: new (options: { host: string; port: number }) => FakeServer;
};
const OWNER = 1000000041, INTRUDER = 1000000042, SELF = 2000000041;
const host = 'qq-web-budget.fixture.example';
const sourceUrl = (round: number, index: number): string => `https://${host}/round-${round}/source-${index}`;
const sourceText = (round: number, index: number): string => `Title: Budget fixture ${round}.${index}\n\nQQ_BUDGET_VERIFIED_${round}_${index}: Synthetic source ${index} for round ${round}.\n`;
const callId = (round: number, index: number): string => `qq-budget-${round}-read-${index}`;
const question = (round: number): string => `QQ_WEB_BUDGET_ROUND_${round}: Read the four synthetic sources, summarize only pages actually opened, and list what is still unverified.`;
const partial = (round: number): string => `QQ_WEB_BUDGET_PARTIAL_${round}: Read sources 1 and 2 only.\n${sourceUrl(round, 1)}\n${sourceUrl(round, 2)}\nUnverified: source 3 was refused at the web-call limit; source 4 was skipped. The remaining research is unfinished.`;
const full = 'QQ_WEB_BUDGET_COMPLETE_2: Read all four synthetic sources after the owner explicitly allowed more web calls.\n'
  + [1, 2, 3, 4].map(index => sourceUrl(2, index)).join('\n');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const toolResult = <T>(wire: Wire, id: string): T | undefined => {
  const message = wire.messages.find(item => item.role === 'tool' && item.tool_call_id === id);
  return message ? JSON.parse(message.content) as T : undefined;
};
const finish = (response: ServerResponse, content: string): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
};

/** Real Electron, IPC, OneBot WebSocket, channel authority, SecureWebReader,
 * runtime and encrypted persistence. Model SSE and page HTTP are loopback
 * fixtures; only the synthetic host's pinned HTTPS transport is redirected. No
 * live QQ account, provider, public page or daily app profile is involved. */
// eslint-disable-next-line no-empty-pattern
test('QQ web limit asks its owner before continuing the same run or delivering partial progress', async ({}, info) => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-qq-web-budget-'))), profile = join(root, 'profile');
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const token = `synthetic-qq-budget-${randomUUID()}`;
  const sent: SentMessage[] = [], clients = new Set<FakeClient>(), requests: Wire[] = [], webReads: string[] = [], errors: string[] = [];
  const received: Array<{ id: number; sender: number; text: string }> = [];
  const rounds: RoundEvidence[] = [];
  let sequence = 0, application: ElectronApplication | undefined, page: Page | undefined, identity: unknown;
  const napcat = new Server({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => { napcat.once('listening', resolve); });
  napcat.on('connection', (client, request) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token') !== token) {
      errors.push('OneBot fixture received an unexpected synthetic token'); client.close(); return;
    }
    clients.add(client);
    client.on('message', data => {
      try {
        const call = JSON.parse(String(data)) as { action: string; params: SentMessage; echo: string };
        expect(['get_login_info', 'get_status', 'send_private_msg']).toContain(call.action);
        if (call.action === 'send_private_msg') sent.push(call.params);
        const result = call.action === 'get_login_info' ? { user_id: SELF, nickname: 'synthetic-budget-account' }
          : call.action === 'get_status' ? { online: true, good: true } : { message_id: ++sequence };
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: result, echo: call.echo }));
      } catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
    });
  });
  const inbound = (text: string, sender = OWNER): void => {
    const messageId = ++sequence;
    received.push({ id: messageId, sender, text });
    const frame = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: sender,
      time: Math.floor(Date.now() / 1000), message_id: messageId, message: [{ type: 'text', data: { text } }], raw_message: text });
    for (const client of clients) if (client.readyState === 1) client.send(frame);
  };
  const delivered = (offset: number): string => sent.slice(offset).map(item => item.message.map(segment => segment.data.text ?? '').join('')).join('');
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        if (request.headers['x-qq-budget-web-host'] === host) {
          expect(request.method).toBe('GET'); expect(request.headers.host).toBe(host);
          const target = new URL(request.url ?? '/', `https://${host}`), url = target.href;
          const path = /^\/round-([12])\/source-([1-4])$/u.exec(target.pathname);
          if (!path) throw new Error('Unexpected synthetic page path');
          const round = Number(path[1]), index = Number(path[2]);
          webReads.push(url);
          // This is also an external-observation ceiling: a refused or skipped
          // call must never reach even this loopback page endpoint.
          if (round === 1) expect(index).toBeLessThanOrEqual(2);
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(sourceText(round, index)); return;
        }
        if (request.url === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[{"id":"qq-web-budget-fixture"}]}'); return;
        }
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected fixture route ${request.url}`);
        const wire = JSON.parse(Buffer.concat(chunks).toString()) as Wire; requests.push(wire);
        expect(wire.model).toBe('qq-web-budget-fixture');
        expect(requests.length).toBeLessThanOrEqual(4);
        const prompt = wire.messages.filter(item => item.role === 'user').at(-1)?.content ?? '';
        const match = /QQ_WEB_BUDGET_ROUND_([12]):/u.exec(prompt);
        if (!match) throw new Error('Missing synthetic round marker');
        const round = Number(match[1]), first = toolResult<PageSource>(wire, callId(round, 1));
        if (!first) {
          const descriptor = wire.tools?.find(item => item.function.description.startsWith('Read HTTPS page.'));
          if (!descriptor) throw new Error('QQ web.read was not declared');
          const toolCalls = [1, 2, 3, 4].map((index, offset) => ({ index: offset, id: callId(round, index), type: 'function',
            function: { name: descriptor.function.name, arguments: JSON.stringify({ url: sourceUrl(round, index), maxCharacters: 4000 }) } }));
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        const toolMessages = wire.messages.filter(item => item.role === 'tool' && item.tool_call_id?.startsWith(`qq-budget-${round}-`));
        expect(toolMessages.map(item => item.tool_call_id)).toEqual([1, 2, 3, 4].map(index => callId(round, index)));
        expect(wire.messages.filter(item => item.role === 'assistant' && item.tool_calls?.some(call => call.id === callId(round, 1))).at(-1)?.tool_calls?.map(call => call.id))
          .toEqual([1, 2, 3, 4].map(index => callId(round, index)));
        for (const index of round === 1 ? [1, 2] : [1, 2, 3, 4]) {
          expect(toolResult<PageSource>(wire, callId(round, index))).toMatchObject({ url: sourceUrl(round, index), text: sourceText(round, index),
            sourceSHA256: hash(sourceText(round, index)), truncated: false });
        }
        if (round === 1) {
          expect(wire.tools ?? []).toHaveLength(0);
          expect(wire.messages.some(item => item.role === 'system' && item.content.includes('combined web search and page-read allowance is exhausted'))).toBe(true);
          expect(toolResult<FailureResult>(wire, callId(round, 3))).toMatchObject({ ok: false, error: { code: 'tool.webBudgetExceeded' } });
          expect(toolResult<FailureResult>(wire, callId(round, 4))).toMatchObject({ ok: false, skipped: true, error: { code: 'tool.batchReplan' } });
          finish(response, partial(round));
        } else {
          expect(wire.tools?.some(item => item.function.description.startsWith('Read HTTPS page.'))).toBe(true);
          expect(wire.messages.some(item => item.role === 'system' && item.content.includes('combined web search and page-read allowance is exhausted'))).toBe(false);
          finish(response, full);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"Synthetic QQ web-budget assertion failed"}');
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
    const origin = `http://127.0.0.1:${address.port}`, compiled = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
    const mainSHA256 = hash(await readFile(compiled)), bootstrap = join(root, 'qq-web-budget-bootstrap.cjs');
    await writeFile(bootstrap, [
      "'use strict';",
      `if (process.env.NODE_ENV !== 'test' || !process.argv.includes(${JSON.stringify('--deskpet-isolated-profile=' + root)})) throw new Error('Refusing non-isolated QQ fixture');`,
      "const {Notification}=require('electron'); Notification.prototype.show=function(){};",
      "const dns=require('node:dns/promises'); const lookup=dns.lookup;",
      `dns.lookup=(hostname,options)=>hostname===${JSON.stringify(host)}?Promise.resolve([{address:'93.184.216.34',family:4}]):lookup(hostname,options);`,
      "const https=require('node:https'),http=require('node:http'); const request=https.request;",
      'https.request=(options,callback)=>{',
      `if (!options || options.servername!==${JSON.stringify(host)}) return request(options,callback);`,
      "if (options.hostname!=='93.184.216.34' || options.port!==443 || options.protocol!=='https:') throw new Error('Unexpected synthetic page pin');",
      `return http.request({...options,protocol:'http:',hostname:'127.0.0.1',port:${address.port},headers:{...options.headers,'x-qq-budget-web-host':options.servername}},callback);`,
      '};',
      'require(' + JSON.stringify(compiled) + ');',
    ].join('\n'));
    const env: Record<string, string> = { NODE_ENV: 'test' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    application = await electron.launch({ args: [bootstrap, '--deskpet-isolated-profile=' + root], cwd: process.cwd(), env });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    identity = (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity;
    expect(identity).toMatchObject({ dataDirectory: profile, isPackaged: false, mainBundleSHA256: mainSHA256 });
    const providerId = randomUUID();
    await page.evaluate(async ({ origin, providerId, token, onebotUrl }) => {
      await window.deskpet.app.setLocale('en');
      await window.deskpet.providers.upsert({ id: providerId, kind: 'lm-studio', name: 'Synthetic QQ web-budget provider', baseUrl: origin + '/v1',
        model: 'qq-web-budget-fixture', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 1024 });
      await window.deskpet.qq.configure({ enabled: true, transport: 'onebot', onebotUrl, appSecret: token, providerId, model: 'qq-web-budget-fixture',
        dailyRequestLimit: 50, webCallLimit: 2 });
    }, { origin, providerId, token, onebotUrl: `ws://127.0.0.1:${napcat.address().port}` });
    const state = () => page!.evaluate(() => window.deskpet.qq.getState());
    const pairing = await page.evaluate(() => window.deskpet.qq.startPairing());
    await expect.poll(state).toMatchObject({ connection: 'online', webCallLimit: 2 });
    inbound('/pair ' + pairing.code);
    await expect.poll(state).toMatchObject({ pairingCandidate: { senderId: String(OWNER) } });
    const candidate = (await state()).pairingCandidate!;
    await page.evaluate(id => window.deskpet.qq.confirmPairing(id), candidate.id);
    await expect.poll(state).toMatchObject({ bound: true, pairingCandidate: null });
    const sessionId = (await page.evaluate(() => window.deskpet.chat.listSessions())).find(session => !!session.channelBindingId)!.id;
    const messages = () => page!.evaluate(id => window.deskpet.chat.listMessages(id), sessionId);
    for (const round of [1, 2]) {
      const beforeSent = sent.length, beforeReads = webReads.length, beforeRequests = requests.length;
      inbound(question(round));
      await expect.poll(() => delivered(beforeSent), { timeout: 25_000 }).toContain('是否再增加 20 次');
      await expect.poll(state).toMatchObject({ pendingOutbox: 0, failedOutbox: 0, uncertainOutbox: 0 });
      const prompt = delivered(beforeSent);
      expect(prompt).toContain('继续搜索'); expect(prompt).toContain('先给结果');
      expect(webReads.slice(beforeReads)).toEqual([sourceUrl(round, 1), sourceUrl(round, 2)]);
      expect(requests.slice(beforeRequests)).toHaveLength(1);
      const pending = (await messages()).filter(message => message.role === 'assistant').at(-1)!;
      const pendingRunId = pending.requestReceipts?.[0]?.runId; expect(pendingRunId).toBeTruthy();
      expect(pending.status).toBe('streaming');
      expect((await page!.evaluate(id => window.deskpet.chatWork.list(id), sessionId)).find(task => task.runId === pendingRunId)?.status).toBe('running');
      if (round === 1) {
        inbound('继续搜索', INTRUDER);
        // An unauthorized private sender gets no continuation authority. Give
        // the real WebSocket listener time to consume this inbound frame.
        await page!.waitForTimeout(300);
        expect(webReads.slice(beforeReads)).toHaveLength(2);
        expect(requests.slice(beforeRequests)).toHaveLength(1);
        expect(delivered(beforeSent)).toBe(prompt);
      }
      const beforeFinal = sent.length, choice = round === 1 ? '先给结果' : '继续搜索';
      inbound(choice);
      const finalText = round === 1 ? partial(round) : full;
      const finalMarker = round === 1 ? `QQ_WEB_BUDGET_PARTIAL_${round}:` : 'QQ_WEB_BUDGET_COMPLETE_2:';
      await expect.poll(async () => (await messages()).find(message => message.role === 'assistant' && message.content.includes(finalMarker))?.status,
        { timeout: 25_000 }).toBe('complete');
      await expect.poll(() => delivered(beforeFinal), { timeout: 25_000 }).toContain(finalText);
      await expect.poll(state).toMatchObject({ dailyRequests: round, pendingOutbox: 0, failedOutbox: 0, uncertainOutbox: 0 });
      await expect.poll(() => page!.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId)).toBeNull();
      const final = (await messages()).find(message => message.role === 'assistant' && message.content.includes(finalMarker))!;
      const runId = final.requestReceipts?.[0]?.runId; expect(runId).toBeTruthy();
      expect(runId).toBe(pendingRunId);
      expect(final.errorCode).toBeNull();
      if (round === 1) expect(final.content).toContain('web-call limit');
      else expect(final.content).toBe(full);
      expect(final.content).not.toContain('tool.channelBlocked');
      expect(delivered(beforeFinal)).toBe(final.content);
      expect(final.requestReceipts).toHaveLength(2);
      expect(new Set(final.requestReceipts?.map(receipt => receipt.runId))).toEqual(new Set([runId]));
      const currentTask = async () => (await page!.evaluate(id => window.deskpet.chatWork.list(id), sessionId)).find(task => task.runId === runId);
      await expect.poll(async () => (await currentTask())?.status).toBe(round === 1 ? 'interrupted' : 'completed');
      const task = (await currentTask())!;
      expect(task.artifacts).toEqual([]);
      const readIndices = round === 1 ? [1, 2] : [1, 2, 3, 4];
      expect(task.sources).toEqual(readIndices.map(index => ({ url: sourceUrl(round, index), title: `Budget fixture ${round}.${index}`, sha256: hash(sourceText(round, index)) })));
      expect(webReads.slice(beforeReads)).toEqual(readIndices.map(index => sourceUrl(round, index)));
      expect(requests.slice(beforeRequests)).toHaveLength(2);
      expect(sent.slice(beforeSent).every(item => item.user_id === OWNER && item.group_id === undefined && item.message.every(segment => segment.type === 'text'))).toBe(true);
      const events = (await page!.evaluate(() => window.deskpet.tasks.listRunEvents())).filter(event => event.runId === runId);
      expect(events.filter(event => event.summary === 'Tool web.read completed.').map(event => event.metadata.taskId)).toEqual(readIndices.map(index => callId(round, index)));
      expect(events.filter(event => event.metadata.errorCode === 'tool.webBudgetExceeded')).toHaveLength(round === 1 ? 1 : 0);
      expect(events.some(event => event.metadata.errorCode === 'tool.channelBlocked')).toBe(false);
      rounds.push({ round, prompt, choice, final, task, delivery: delivered(beforeFinal), runId: runId! });
      expect(errors).toEqual([]);
    }
    expect(new Set(rounds.map(round => round.runId)).size).toBe(2);
    expect(webReads).toHaveLength(6); expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests)).not.toContain(token);
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    await page.locator('.session-control select').selectOption(sessionId);
    await expect(page.locator('.message.assistant').last()).toContainText('QQ_WEB_BUDGET_COMPLETE_2:');
    await page.screenshot({ path: info.outputPath('qq-web-budget-owner-continuation.png') });
  } finally {
    await writeFile(info.outputPath('qq-web-budget-evidence.json'), JSON.stringify({
      scope: 'Isolated development Electron with synthetic OneBot, model SSE and pages. Synthetic host DNS and pinned HTTPS transport route to loopback; real SecureWebReader, channel authority, runtime, receipts and persistence. No live QQ or natural research acceptance.',
      identity, rounds, requests, webReads, received, sent, fixtureErrors: errors,
    }, null, 2));
    await application?.close().catch(() => undefined);
    for (const client of clients) client.close();
    await new Promise<void>(resolve => napcat.close(resolve));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
