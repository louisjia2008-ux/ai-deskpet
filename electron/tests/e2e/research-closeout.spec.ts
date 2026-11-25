import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/shared';
import type { ChatWorkTask } from '../../src/shared/chat-work';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface WireMessage { role: string; content: string; tool_call_id?: string }
interface Wire { messages: WireMessage[]; tools?: Array<{ function: { name: string; description: string } }> }
interface Source { url: string; text: string; sourceSHA256: string; truncated: boolean }
type Scenario = 'allow' | 'deny' | 'followup' | 'missing-receipt';
const host = 'research-closeout.fixture.example';
const sourceUrl = `https://${host}/verified-source`;
const sourceText = 'Title: Verified closeout fixture\n\nCLOSEOUT_VERIFIED_SOURCE: The synthetic survey measured 37 units. This observation is fixture data, not a public factual claim.\n';
const followup = '不要写文件，只给聊天摘要。';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const titles = { read: 'Read HTTPS page.', write: 'Write workspace file.', update: 'Update current task plan.' };
const has = (body: Wire, title: string): boolean => body.tools?.some(item => item.function.description.startsWith(title)) ?? false;
const result = <T>(body: Wire, id: string): T | undefined => {
  const message = body.messages.find(item => item.role === 'tool' && item.tool_call_id === id);
  return message ? JSON.parse(message.content) as T : undefined;
};
const finish = (response: ServerResponse, content: string): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`);
};
const call = (response: ServerResponse, body: Wire, title: string, id: string, input: unknown): void => {
  const descriptor = body.tools?.find(item => item.function.description.startsWith(title));
  if (!descriptor) throw new Error(`Missing declared fixture tool ${title}`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: descriptor.function.name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
};

const descriptions: Record<Scenario, string> = {
  allow: 'research failures reserve a real approved workspace write and record a partial draft',
  deny: 'denying the closing write creates no file or artifact receipt',
  followup: 'a user instruction during closing-write approval cancels the old file goal',
  'missing-receipt': 'a premature saved-file claim gets one bounded correction and remains unfinished without a write receipt',
};

/** Real Electron, renderer/preload IPC, LocalWebPlugins, runtime, permissions,
 * task evidence and filesystem. The configured Crawl4AI endpoint and provider
 * are deterministic loopback HTTP fixtures; only target DNS is pinned to a
 * synthetic public address. No real page, model, account or credential is used. */
for (const scenario of ['allow', 'deny', 'followup', 'missing-receipt'] as const) {
  // eslint-disable-next-line no-empty-pattern
  test(descriptions[scenario], async ({}, info) => {
    test.setTimeout(90_000);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-research-closeout-'))), profile = join(root, 'profile');
    await mkdir(join(profile, 'workspace'), { recursive: true });
    await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
    const path = `reports/research-${scenario}.md`, absolute = join(profile, 'workspace', path);
    const requests: Wire[] = [], pluginReads: string[] = [], errors: string[] = [];
    let closeoutRequests = 0, prematureFinals = 0, expectedFile = '', application: ElectronApplication | undefined;
    let final: ChatMessage | undefined, task: ChatWorkTask | undefined, identity: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          if (request.url === '/crawl') {
            const input = JSON.parse(Buffer.concat(chunks).toString()) as { urls: string[] };
            expect(input.urls).toHaveLength(1);
            const url = input.urls[0]!; pluginReads.push(url);
            expect(new URL(url).hostname).toBe(host);
            const successful = url === sourceUrl;
            if (!successful) expect(new URL(url).pathname).toMatch(/^\/unavailable-[1-4]$/u);
            // The adapter HTTP succeeded, while the fetched page itself returned
            // 503. Error-page Markdown must never become a verified source.
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ success: true, results: [{ url, success: successful, status_code: successful ? 200 : 503,
              ...(successful ? {} : { error_code: 'server_error' }),
              markdown: { raw_markdown: successful ? sourceText : 'UNVERIFIED_ERROR_PAGE_MUST_NOT_BECOME_EVIDENCE', fit_markdown: successful ? sourceText : '' },
              html: successful ? '<html><body>Synthetic verified source</body></html>' : '<html><body>503 Service unavailable</body></html>',
            }] })); return;
          }
          if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
          if (!request.url?.endsWith('/chat/completions')) throw new Error(`Unexpected fixture route ${request.url}`);
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Wire; if (isRecentSummary(body)) { answerRecentSummary(response); return; } requests.push(body);
          if (requests.length > 12) throw new Error('Bounded closeout exceeded the fixture request limit');
          const source = result<Source>(body, 'source-read');
          if (!source) { call(response, body, titles.read, 'source-read', { url: sourceUrl, maxCharacters: 4000 }); return; }
          expect(source.url).toBe(sourceUrl); expect(source.text).toBe(sourceText); expect(source.sourceSHA256).toBe(hash(sourceText)); expect(source.truncated).toBe(false);
          const newest = body.messages.filter(message => message.role === 'user').at(-1)?.content;
          if (newest === followup) {
            expect(scenario).toBe('followup');
            expect(result(body, 'closing-write')).toMatchObject({ ok: false, skipped: true, error: { code: 'tool.superseded' } });
            expect(has(body, titles.read)).toBe(true);
            expect(body.messages.filter(message => message.role === 'system').some(message => message.content.startsWith('The host is closing this file task.'))).toBe(false);
            finish(response, `CLOSEOUT_CHAT_SUMMARY: ${source.text}\nOpened source: ${source.url}. Four further reads failed; those claims remain unverified. The requested file was cancelled.`); return;
          }
          const restricted = has(body, titles.write) && !has(body, titles.read);
          if (restricted) {
            closeoutRequests++;
            expect(body.tools).toHaveLength(2);
            expect(has(body, titles.update)).toBe(true);
            expect(body.tools?.every(item => [titles.write, titles.update].some(title => item.function.description.startsWith(title)))).toBe(true);
            if (scenario === 'missing-receipt') {
              finish(response, 'CLOSEOUT_STILL_NO_WRITE: The file was not written in this correction.'); return;
            }
            const failures = body.messages.filter(message => message.role === 'tool' && message.tool_call_id?.startsWith('unavailable-'));
            expect(failures).toHaveLength(4);
            expect(failures.every(message => JSON.parse(message.content).ok === false)).toBe(true);
            expectedFile = `# Partial research draft\n\n${source.text}\nActually opened source: ${source.url}\n\nUnresolved: four further sources returned HTTP 503. Their content and claims were not verified.\n`;
            const written = result<{ written: boolean; path: string; bytes: number; sha256: string }>(body, 'closing-write');
            if (!written) { call(response, body, titles.write, 'closing-write', { path, content: expectedFile }); return; }
            expect(written).toEqual({ written: true, path, bytes: Buffer.byteLength(expectedFile), sha256: hash(expectedFile) });
            finish(response, `CLOSEOUT_PARTIAL_SAVED: ${path}. Used ${source.url}; four other reads failed and remain unverified.`); return;
          }
          if (scenario === 'missing-receipt') {
            prematureFinals++;
            finish(response, `CLOSEOUT_PREMATURE_CLAIM: Saved ${path} successfully.`); return;
          }
          expect(has(body, titles.read)).toBe(true);
          const count = body.messages.filter(message => message.role === 'tool' && message.tool_call_id?.startsWith('unavailable-')).length;
          expect(count).toBeLessThan(4);
          call(response, body, titles.read, `unavailable-${count + 1}`, { url: `https://${host}/unavailable-${count + 1}` });
        } catch (error) {
          errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"error":"Synthetic closeout fixture assertion failed"}');
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
      const origin = `http://127.0.0.1:${address.port}`, compiled = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
      const mainHash = hash(await readFile(compiled)), entry = join(root, 'boot.cjs');
      await writeFile(entry, [
        "const {dialog,Notification}=require('electron'); dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};",
        "const dns=require('node:dns/promises');const lookup=dns.lookup;",
        `dns.lookup=(hostname,options)=>hostname===${JSON.stringify(host)}?Promise.resolve([{address:'93.184.216.34',family:4}]):lookup(hostname,options);`,
        'require(' + JSON.stringify(compiled) + ');',
      ].join('\n'));
      const env: Record<string, string> = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
      application = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], cwd: process.cwd(), env });
      await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
      const page = application.windows().find(window => window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible();
      const runtime = (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity;
      expect(runtime?.dataDirectory).toBe(profile); expect(runtime?.mainBundleSHA256).toBe(mainHash);
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(false); identity = runtime;
      const providerId = randomUUID();
      await page.evaluate(async ({ origin, providerId }) => {
        await window.deskpet.app.setLocale('en');
        await window.deskpet.providers.upsert({ id: providerId, name: 'Research closeout fixture', model: 'closeout-fixture', kind: 'lm-studio',
          baseUrl: origin + '/v1', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 1024 });
        await window.deskpet.providers.select(providerId);
        const plugins = await window.deskpet.plugins.getState();
        await window.deskpet.plugins.configure({ settings: { ...plugins.settings, web: { enabled: true, searxngUrl: origin, crawl4aiUrl: origin, maxCharacters: 4000 } } });
        await window.deskpet.permissions.request({ capabilityId: 'web.read', duration: 'session' });
      }, { origin, providerId });
      await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
      await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
      await page.locator('#main-content').getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.locator('.composer textarea').fill(`Research the synthetic sources and write ${path} with the actual opened source URLs and all unresolved claims.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toHaveCount(1);
      const sessionId = await page.locator('.session-control select').inputValue();
      const messages = () => page.evaluate(id => window.deskpet.chat.listMessages(id), sessionId);
      const approval = page.getByRole('region', { name: 'This step needs your approval', exact: true });
      if (scenario !== 'missing-receipt') {
        await expect(approval).toBeVisible({ timeout: 25_000 }); await expect(approval).toContainText(path);
        const waiting = await page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId);
        expect(waiting?.approval?.toolId).toBe('workspace.write'); expect(closeoutRequests).toBe(1);
        await expect(readFile(absolute, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await page.screenshot({ path: info.outputPath('closing-write-awaiting-approval.png') });
        if (scenario === 'allow') await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
        else if (scenario === 'deny') await approval.getByRole('button', { name: 'Deny', exact: true }).click();
        else {
          await page.locator('.composer textarea').fill(followup);
          await page.getByRole('button', { name: 'Add instruction', exact: true }).click();
          await expect(page.locator('.message.user[data-followup-to]')).toContainText(followup);
        }
      }
      await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', scenario === 'deny' ? 'failed' : 'complete', { timeout: 25_000 });
      await expect.poll(() => page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId)).toBeNull();
      final = (await messages()).find(message => message.role === 'assistant')!;
      const runId = final.requestReceipts?.[0]?.runId; expect(runId).toBeTruthy();
      const currentTask = async () => (await page.evaluate(id => window.deskpet.chatWork.list(id), sessionId)).find(item => item.runId === runId);
      await expect.poll(async () => (await currentTask())?.status).toBe(scenario === 'deny' ? 'failed' : scenario === 'followup' ? 'completed' : 'interrupted');
      task = (await currentTask())!;
      expect(task.sources).toEqual([{ url: sourceUrl, title: 'Verified closeout fixture', sha256: hash(sourceText) }]);
      expect(new Set(final.requestReceipts?.map(receipt => receipt.runId))).toEqual(new Set([runId]));
      if (scenario === 'allow') {
        const actual = await readFile(absolute, 'utf8'); expect(actual).toBe(expectedFile);
        expect(actual).not.toContain('UNVERIFIED_ERROR_PAGE');
        expect(task.artifacts).toEqual([{ path, bytes: Buffer.byteLength(actual), sha256: hash(actual) }]);
        expect(final.content).toContain('CLOSEOUT_PARTIAL_SAVED'); expect(final.content).toContain('partial draft');
        expect(closeoutRequests).toBe(2); expect(requests).toHaveLength(7);
      } else {
        await expect(readFile(absolute, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }); expect(task.artifacts).toEqual([]);
        expect(closeoutRequests).toBe(1);
        if (scenario === 'deny') { expect(final.errorCode).toBe('chat.approvalDenied'); expect(requests).toHaveLength(6); }
        if (scenario === 'followup') {
          expect(final.errorCode).toBeNull(); expect(final.content).toContain('CLOSEOUT_CHAT_SUMMARY');
          expect((await messages()).filter(message => message.followupToMessageId)).toHaveLength(1);
          await expect(approval).toHaveCount(0); expect(requests).toHaveLength(7);
        }
        if (scenario === 'missing-receipt') {
          expect(prematureFinals).toBe(1); expect(requests).toHaveLength(3);
          expect(final.content).toContain('no successful write receipt');
        }
      }
      expect(pluginReads).toEqual(scenario === 'missing-receipt' ? [sourceUrl] : [sourceUrl, ...[1, 2, 3, 4].map(index => `https://${host}/unavailable-${index}`)]);
      const events = (await page.evaluate(() => window.deskpet.tasks.listRunEvents())).filter(event => event.runId === runId);
      expect(events.filter(event => event.metadata.recovery !== undefined && event.metadata.toolId === 'web.read')).toHaveLength(scenario === 'missing-receipt' ? 0 : 4);
      expect(events.filter(event => event.type === 'effect' && event.metadata.toolId === 'workspace.write')).toHaveLength(scenario === 'allow' ? 1 : 0);
      expect(events.filter(event => event.summary === 'Bounded file delivery started.')).toHaveLength(1);
      await page.screenshot({ path: info.outputPath('terminal-research-closeout.png') });
      expect(errors).toEqual([]);
    } finally {
      await writeFile(info.outputPath('research-closeout-evidence.json'), JSON.stringify({ scenario,
        scope: 'Isolated development Electron with synthetic loopback provider/Crawl4AI and DNS, real host permissions, file/task persistence and receipts. No live model or public-page acceptance.',
        identity, final, task, requests, pluginReads, closeoutRequests, prematureFinals, fixtureErrors: errors,
      }, null, 2));
      await application?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
