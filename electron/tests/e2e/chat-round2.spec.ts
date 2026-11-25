import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/shared';
import type { ChatWorkTask } from '../../src/shared/chat-work';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface WireMessage { role: string; content: string; tool_call_id?: string }
interface Wire { model: string; messages: WireMessage[]; tools?: Array<{ function: { name: string; description: string } }> }
type Tool = 'task.update' | 'web.search' | 'web.read' | 'workspace.write' | 'math.calculate' | 'history.search' | 'history.read' | 'cron.create';
const titles: Record<Tool, string> = {
  'task.update': 'Update current task plan.', 'web.search': 'Search web.', 'web.read': 'Read HTTPS page.', 'workspace.write': 'Write workspace file.',
  'history.search': 'Search permitted conversation history.', 'history.read': 'Read permitted conversation message.', 'cron.create': 'Create recurring chat task.', 'math.calculate': 'Calculate expression.',
};
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sourceUrl = 'https://round2.fixture.example/article';
const sourceHtml = '<!doctype html><html><head><title>Round two fixture evidence</title></head><body><h1>Fixture observations</h1><p>ROUND2_SOURCE_LITERAL: The synthetic observatory measured 37 units on Monday.</p><p>The measured value is fixture data for a reproducible test.</p></body></html>';
const researchPrompt = 'ROUND2_RESEARCH: Search the fixture observations, read the source, and write reports/round2-summary.md with the observed content and source URL.';
const researchFinal = 'ROUND2_RESEARCH_COMPLETE: Saved reports/round2-summary.md from the source actually read.';
const historyPrompt = 'ROUND2_HISTORY: Find the earlier message containing ROUND2_RESEARCH_COMPLETE and read it before answering.';
const cronPrompt = 'ROUND2_CRON: Create a fixture check every minute in UTC, using only math.calculate and workspace.write.';
const cronInstruction = 'ROUND2_CRON_EXECUTE: Calculate six times seven and save the result to reports/round2-scheduled.md.';
const cronFile = '# Scheduled fixture\n\nThe calculated result is 42.\n';
const cronFinal = 'ROUND2_SCHEDULED_COMPLETE: Saved reports/round2-scheduled.md with the calculated result 42.';

const reply = (response: ServerResponse, body: Wire, call?: { tool: Tool; id: string; input: unknown }, content = ''): void => {
  const descriptor = call && body.tools?.find((item) => item.function.description.startsWith(titles[call.tool]));
  if (call && !descriptor) throw new Error(`Expected declared tool ${call.tool}`);
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, function: { name: descriptor!.function.name, arguments: JSON.stringify(call.input) } }] } : { content };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`);
};
const result = <T>(body: Wire, id: string): T | undefined => {
  const found = body.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  return found ? JSON.parse(found.content) as T : undefined;
};

/** End-to-end deterministic acceptance: real renderer, IPC, runtime, permissions,
 * encrypted persistence and filesystem. The model and HTTP response bodies are
 * synthetic loopback fixtures. The temporary launch wrapper routes exactly two
 * public-looking hosts to the fixture server before the production bundle loads;
 * it does not modify the production reader or weaken its target validation. */
// eslint-disable-next-line no-empty-pattern
test('same conversation research writes real content and records evidence; history and approved cron remain manageable', async ({}, info) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-round2-e2e-'));
  await mkdir(join(profile, 'workspace'), { recursive: true });
  const requests: Wire[] = [], webRequests: Array<{ host: string; path: string }> = [], errors: string[] = [];
  let expectedFile = '', historyRead = '', application: ElectronApplication | undefined, page: Page | undefined;
  let failure: string | null = null, identity: unknown, researchTask: ChatWorkTask | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const host = request.headers['x-round2-web-host'];
        if (host !== undefined) {
          if (typeof host !== 'string') throw new Error('Invalid fixture host');
          webRequests.push({ host, path: request.url ?? '' });
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          if (host === 'www.bing.com' && request.url?.startsWith('/search?')) {
            response.end(`<html><body><ol><li class="b_algo"><h2><a href="${sourceUrl}">Round two fixture evidence</a></h2><div class="b_caption"><p>A synthetic source available for verification.</p></div></li></ol></body></html>`); return;
          }
          if (host === 'round2.fixture.example' && request.url === '/article') { response.end(sourceHtml); return; }
          throw new Error(`Unexpected synthetic web request ${host}${request.url}`);
        }
        if (request.url?.endsWith('/api/show')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return;
        }
        if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'round2-fixture' }] })); return; }
        if (!request.url?.endsWith('/chat/completions')) throw new Error(`Unexpected fixture route ${request.url}`);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; if (isRecentSummary(body)) { answerRecentSummary(response); return; } requests.push(body);
        const prompt = body.messages.slice().reverse().find((message) => message.role === 'user')?.content ?? '';
        if (prompt.includes('ROUND2_RESEARCH:')) {
          if (!result(body, 'r2-plan')) { reply(response, body, { tool: 'task.update', id: 'r2-plan', input: { plan: ['Search the fixture source', 'Read the returned page', 'Save the observed content'], notes: 'Use only returned source text.', nextStep: 'Search the fixture source.' } }); return; }
          const search = result<{ results: Array<{ url: string }> }>(body, 'r2-search');
          if (!search) { reply(response, body, { tool: 'web.search', id: 'r2-search', input: { query: 'fixture observations site:round2.fixture.example', limit: 3 } }); return; }
          expect(search.results).toHaveLength(1); expect(search.results[0]!.url).toBe(sourceUrl);
          const source = result<{ text: string; url: string; sourceSHA256: string }>(body, 'r2-read');
          if (!source) { reply(response, body, { tool: 'web.read', id: 'r2-read', input: { url: search.results[0]!.url } }); return; }
          expect(source.text).toContain('ROUND2_SOURCE_LITERAL'); expect(source.text).toContain('37 units'); expect(source.url).toBe(sourceUrl);
          expectedFile = `# Fixture report\n\n${source.text}\n\nSource: ${source.url}\n`;
          const written = result<{ written: boolean; path: string; sha256: string }>(body, 'r2-write');
          if (!written) { reply(response, body, { tool: 'workspace.write', id: 'r2-write', input: { path: 'reports/round2-summary.md', content: expectedFile } }); return; }
          expect(written.written).toBe(true); expect(written.sha256).toBe(hash(expectedFile)); reply(response, body, undefined, researchFinal); return;
        }
        if (prompt.includes('ROUND2_HISTORY:')) {
          const found = result<{ items: Array<{ messageId: string; snippet: string }> }>(body, 'r2-history-search');
          if (!found) { reply(response, body, { tool: 'history.search', id: 'r2-history-search', input: { query: 'ROUND2_RESEARCH_COMPLETE', limit: 10 } }); return; }
          const match = found.items.find((item) => item.snippet.includes(researchFinal));
          expect(match).toBeDefined();
          const read = result<{ text: string }>(body, 'r2-history-read');
          if (!read) { reply(response, body, { tool: 'history.read', id: 'r2-history-read', input: { messageId: match!.messageId, maxCharacters: 2000 } }); return; }
          historyRead = read.text; expect(historyRead).toBe(researchFinal);
          reply(response, body, undefined, 'ROUND2_HISTORY_COMPLETE: The earlier saved-file result was read from conversation history.'); return;
        }
        if (prompt.includes('ROUND2_CRON:')) {
          if (!result(body, 'r2-cron-create')) {
            reply(response, body, { tool: 'cron.create', id: 'r2-cron-create', input: { title: 'Round two minute fixture check', instruction: cronInstruction, expression: '* * * * *', timezone: 'UTC', allowedCapabilities: ['math.calculate', 'workspace.write'], missedPolicy: 'skip' } }); return;
          }
          reply(response, body, undefined, 'ROUND2_CRON_COMPLETE: The approved recurring report has been saved in this conversation.'); return;
        }
        if (prompt.includes('ROUND2_CRON_EXECUTE:')) {
          const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
          expect(system).toContain('automatic run of a recurring task that already exists'); expect(system).not.toContain('use cron.create');
          expect(body.tools?.every((item) => ['task.update', 'math.calculate', 'workspace.write'].some((id) => item.function.description.startsWith(titles[id as Tool])))).toBe(true);
          const calculated = result<{ result: number }>(body, 'r2-scheduled-math');
          if (!calculated) { reply(response, body, { tool: 'math.calculate', id: 'r2-scheduled-math', input: { expression: '6 * 7' } }); return; }
          expect(calculated.result).toBe(42);
          const written = result<{ written: boolean; sha256: string }>(body, 'r2-scheduled-write');
          if (!written) { reply(response, body, { tool: 'workspace.write', id: 'r2-scheduled-write', input: { path: 'reports/round2-scheduled.md', content: cronFile } }); return; }
          expect(written.written).toBe(true); expect(written.sha256).toBe(hash(cronFile)); reply(response, body, undefined, cronFinal); return;
        }
        throw new Error('Missing known round-two fixture prompt');
      } catch (error) {
        errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic round-two fixture assertion failed' }));
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const entry = join(process.cwd(), '.webpack', process.arch, 'main', 'index.js');
    const mainHash = hash(await readFile(entry));
    const wrapper = join(profile, 'round2-bootstrap.cjs');
    await writeFile(wrapper, `
'use strict';
if (process.env.NODE_ENV !== 'test' || process.env.DESKPET_E2E_USER_DATA !== ${JSON.stringify(profile)}) throw new Error('Refusing non-fixture launch');
const dns = require('node:dns/promises');
const https = require('node:https');
const http = require('node:http');
const hosts = new Set(['www.bing.com', 'round2.fixture.example']);
const lookup = dns.lookup;
dns.lookup = async (hostname, options) => hosts.has(hostname) ? [{ address: '93.184.216.34', family: 4 }] : lookup(hostname, options);
const request = https.request;
https.request = (options, callback) => {
  if (!options || !hosts.has(options.servername)) return request(options, callback);
  if (options.hostname !== '93.184.216.34' || options.port !== 443 || options.protocol !== 'https:') throw new Error('Unexpected fixture pin');
  return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: ${address.port}, headers: { ...options.headers, 'x-round2-web-host': options.servername } }, callback);
};
require(${JSON.stringify(entry)});
`);
    const env: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    application = await electron.launch({ args: [wrapper], cwd: process.cwd(), env });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ Notification }) => {
      const shown: Array<{ title: string; body: string }> = []; (globalThis as { round2Notifications?: typeof shown }).round2Notifications = shown;
      Notification.prototype.show = function show(this: { title: string; body: string }) { shown.push({ title: this.title, body: this.body }); };
    });
    await application.evaluate(({ app, dialog }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Refusing non-fixture application');
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, profile);
    const diagnostics = await page.evaluate(() => window.deskpet.app.getDiagnostics());
    identity = diagnostics.runtimeIdentity; expect(diagnostics.runtimeIdentity?.dataDirectory).toBe(profile); expect(diagnostics.runtimeIdentity?.mainBundleSHA256).toBe(mainHash);
    await page.evaluate(async (provider) => {
      await window.deskpet.app.setLocale('en'); await window.deskpet.providers.upsert(provider); await window.deskpet.providers.select(provider.id);
      for (const capabilityId of ['task.records', 'web.search', 'web.read', 'history.read']) await window.deskpet.permissions.request({ capabilityId, duration: 'session' });
    }, { id: randomUUID(), kind: 'ollama' as const, name: 'Round two loopback fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'round2-fixture', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 1024 });
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    const send = async (content: string): Promise<void> => {
      const before = await page!.locator('.message.assistant').count();
      await page!.locator('.composer textarea').fill(content); await page!.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page!.locator('.message.assistant')).toHaveCount(before + 1);
    };
    const session = async (): Promise<string> => page!.locator('.session-control select').inputValue();
    const messages = async (sessionId: string): Promise<ChatMessage[]> => page!.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId);
    await send(researchPrompt);
    const approval = page.getByRole('region', { name: 'This step needs your approval', exact: true });
    await expect(approval).toBeVisible(); await expect(approval).toContainText('reports/round2-summary.md');
    const researchSession = await session();
    const waiting = await page.evaluate((id) => window.deskpet.chat.getInteraction(id), researchSession);
    expect(waiting?.approval?.toolId).toBe('workspace.write'); expect(requests).toHaveLength(4);
    await expect.poll(async () => readFile(join(profile, 'workspace/reports/round2-summary.md'), 'utf8').catch(() => null)).toBe(null);
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant')).toContainText(researchFinal);
    expect(await session()).toBe(researchSession);
    const actual = await readFile(join(profile, 'workspace/reports/round2-summary.md'), 'utf8');
    expect(actual).toBe(expectedFile); expect(actual).toContain('ROUND2_SOURCE_LITERAL');
    expect(webRequests).toEqual([{ host: 'www.bing.com', path: expect.stringContaining('/search?') }, { host: 'round2.fixture.example', path: '/article' }]);
    const originalMessages = await messages(researchSession), originalFinal = originalMessages.find((item) => item.role === 'assistant')!;
    expect(originalFinal.requestReceipts).toHaveLength(5); expect(new Set(originalFinal.requestReceipts?.map((item) => item.runId))).toEqual(new Set([waiting!.runId]));
    researchTask = (await page.evaluate((id) => window.deskpet.chatWork.list(id), researchSession)).find((item) => item.runId === waiting!.runId);
    expect(researchTask).toMatchObject({ sessionId: researchSession, assistantMessageId: originalFinal.id, status: 'completed', goal: researchPrompt, plan: ['Search the fixture source', 'Read the returned page', 'Save the observed content'] });
    expect(researchTask!.sources).toEqual([{ url: sourceUrl, title: 'Round two fixture evidence', sha256: expect.any(String) }]);
    expect(researchTask!.artifacts).toEqual([{ path: 'reports/round2-summary.md', bytes: Buffer.byteLength(actual), sha256: hash(actual) }]);
    await page.getByText('Tasks, history & schedules', { exact: true }).click();
    await page.locator(`[data-task-id="${researchTask!.id}"] > summary`).click();
    await expect(page.locator('.chat-work-panel')).toContainText('reports/round2-summary.md');
    await page.screenshot({ path: info.outputPath('research-task-evidence.png') });
    await page.locator(`[data-task-id="${researchTask!.id}"] .chat-work-source`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('research-source-record.png') });
    await page.locator(`[data-task-id="${researchTask!.id}"] .chat-work-artifacts li`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('research-artifact-record.png') });
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    expect((await page.evaluate((id) => window.deskpet.chatWork.list(id), researchSession)).find((item) => item.id === researchTask!.id)).toEqual(researchTask);

    await page.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click();
    await send(historyPrompt); await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant')).toContainText('ROUND2_HISTORY_COMPLETE'); expect(historyRead).toBe(researchFinal);
    const historySession = await session(); expect(historySession).not.toBe(researchSession);
    await page.getByText('Tasks, history & schedules', { exact: true }).click();
    await page.getByLabel('History query').fill('ROUND2_RESEARCH_COMPLETE'); await page.getByRole('button', { name: 'Search', exact: true }).click();
    const historyHit = page.locator(`[data-history-message-id="${originalFinal.id}"]`);
    await expect(historyHit).toBeVisible(); await historyHit.getByRole('button', { name: 'Read excerpt' }).click();
    await expect(page.locator(`[data-history-excerpt-id="${originalFinal.id}"] pre`)).toHaveText(researchFinal);
    await page.locator(`[data-history-excerpt-id="${originalFinal.id}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-history-excerpt-id="${originalFinal.id}"] pre`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('history-source-excerpt.png') });
    await historyHit.getByRole('button', { name: 'Open conversation' }).click(); await expect(page.locator('.session-control select')).toHaveValue(researchSession);

    await send(cronPrompt); await expect(approval).toBeVisible(); await expect(approval).toContainText('* * * * *');
    expect(await page.evaluate((id) => window.deskpet.chatWork.listCron(id), researchSession)).toEqual([]);
    expect((await page.evaluate((id) => window.deskpet.chat.getInteraction(id), researchSession))?.approval?.toolId).toBe('cron.create');
    await page.screenshot({ path: info.outputPath('cron-create-approval.png') });
    await approval.getByRole('button', { name: 'Confirm recurring settings', exact: true }).click();
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant').last()).toContainText('ROUND2_CRON_COMPLETE');
    const schedules = await page.evaluate((id) => window.deskpet.chatWork.listCron(id), researchSession);
    expect(schedules).toHaveLength(1); expect(schedules[0]).toMatchObject({ sessionId: researchSession, expression: '* * * * *', timezone: 'UTC', allowedCapabilities: ['math.calculate', 'workspace.write'], enabled: true, cancelledAt: null });
    const panel = page.locator('.chat-work-panel'); if (!await panel.getAttribute('open').then((value) => value !== null)) await page.getByText('Tasks, history & schedules', { exact: true }).click();
    const cron = page.locator(`[data-cron-id="${schedules[0]!.id}"]`); await expect(cron).toBeVisible();
    await expect(panel).toContainText('they do not run after the app exits');
    await cron.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(cron.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await cron.getByRole('button', { name: 'Resume', exact: true }).click(); await expect(cron.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // Wait for the real next minute and the host's normal scheduler tick. No
    // clock substitution, direct scheduler call or private state mutation.
    await expect.poll(async () => (await messages(researchSession)).filter((item) => item.role === 'assistant' && item.status === 'complete' && item.content === cronFinal).length, { timeout: 90_000, intervals: [1000] }).toBe(1);
    await expect(page.locator('.message.assistant').last()).toContainText(cronFinal);
    await expect(approval).toHaveCount(0); expect(await session()).toBe(researchSession);
    const scheduledFile = await readFile(join(profile, 'workspace/reports/round2-scheduled.md'), 'utf8'); expect(scheduledFile).toBe(cronFile);
    const scheduledMessage = (await messages(researchSession)).find((item) => item.role === 'assistant' && item.content === cronFinal)!;
    expect(scheduledMessage.requestReceipts).toHaveLength(3);
    await expect.poll(() => application!.evaluate(() => (globalThis as { round2Notifications?: Array<{ title: string; body: string }> }).round2Notifications))
      .toContainEqual({ title: 'Round two minute fixture check', body: cronFinal });
    const scheduledTask = (await page.evaluate((id) => window.deskpet.chatWork.list(id), researchSession)).find((item) => item.assistantMessageId === scheduledMessage.id)!;
    expect(scheduledTask).toMatchObject({ goal: cronInstruction, sessionId: researchSession, status: 'completed', sources: [], artifacts: [{ path: 'reports/round2-scheduled.md', bytes: Buffer.byteLength(cronFile), sha256: hash(cronFile) }] });
    expect((await page.evaluate(() => window.deskpet.permissions.list())).filter((item) => ['math.calculate', 'workspace.write'].includes(item.capabilityId)).every((item) => item.state === 'not-requested')).toBe(true);
    await page.locator('.message.assistant').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('cron-real-scheduled-result.png') });
    await cron.getByRole('button', { name: 'Cancel schedule', exact: true }).click(); await cron.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await expect(cron).toContainText('Cancelled');
    const cancelled = (await page.evaluate((id) => window.deskpet.chatWork.listCron(id), researchSession))[0]!;
    expect(cancelled.cancelledAt).not.toBeNull(); expect(cancelled.enabled).toBe(false); expect(cancelled.nextRunAt).toBeNull();
    await page.screenshot({ path: info.outputPath('cron-cancelled-record.png') });
    expect(errors).toEqual([]);
    expect(requests.every((request) => request.messages.every((message) => !Object.hasOwn(message, 'hostToolResult')))).toBe(true);
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
  finally {
    let state: unknown = null;
    if (page && !page.isClosed()) {
      state = await page.evaluate(async () => {
        const sessions = await window.deskpet.chat.listSessions();
        return { sessions, messages: await Promise.all(sessions.map((item) => window.deskpet.chat.listMessages(item.id))),
          tasks: await Promise.all(sessions.map((item) => window.deskpet.chatWork.list(item.id))), cron: await Promise.all(sessions.map((item) => window.deskpet.chatWork.listCron(item.id))),
          permissions: await window.deskpet.permissions.list(), events: await window.deskpet.tasks.listRunEvents() };
      }).catch((error: unknown) => ({ error: String(error) }));
      await page.screenshot({ path: info.outputPath(failure ? 'failure.png' : 'final.png') }).catch(() => undefined);
    }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ scope: 'Isolated development Electron with deterministic loopback model and web responses, real workspace writes and saved state; not installed-app, real-provider or live-web acceptance.',
      identity, failure, errors, requests, webRequests, sourceHtml, expectedFile, fileSHA256: hash(expectedFile), cronFile, cronFileSHA256: hash(cronFile), historyRead, researchTask, state }, null, 2));
    await info.attach('evidence', { path: info.outputPath('evidence.json'), contentType: 'application/json' });
    if (application) {
      const child = application.process(), timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
      try { await application.close(); } catch { /* Keep the first failure. */ } finally { clearTimeout(timeout); }
    }
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
