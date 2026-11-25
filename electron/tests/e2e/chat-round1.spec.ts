import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatApprovalRequest, ChatMessage } from '../../src/shared';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface WireMessage { role: string; content: string; tool_call_id?: string }
interface Wire {
  model: string;
  messages: WireMessage[];
  tools?: Array<{ function: { name: string; description: string } }>;
}
interface Call { id: string; tool: 'math.calculate' | 'workspace.read' | 'workspace.write' | 'shell.run'; input: unknown }
type ModelFixture = (body: Wire, response: ServerResponse, round: number) => void;
interface Fixture {
  application: ElectronApplication;
  page: Page;
  profile: string;
  requests: Wire[];
  send(content: string): Promise<void>;
  currentMessages(): Promise<ChatMessage[]>;
  grantSession(capabilityId: string): Promise<void>;
  capture(name: string): Promise<void>;
}

const titles: Record<Call['tool'], string> = {
  'math.calculate': 'Calculate expression.', 'workspace.read': 'Read workspace file.', 'workspace.write': 'Write workspace file.', 'shell.run': 'Run a restricted workspace text pipeline.',
};
const toolName = (body: Wire, tool: Call['tool']): string => {
  const descriptor = body.tools?.find((item) => item.function.description.startsWith(titles[tool]));
  if (!descriptor) throw new Error(`Fixture did not receive declared ${tool}`);
  return descriptor.function.name;
};
const reply = (response: ServerResponse, body: Wire, calls?: Call[], content = 'ROUND1_FIXTURE_COMPLETE'): void => {
  if (response.destroyed) return;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = calls ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, function: {
    name: toolName(body, call.tool), arguments: JSON.stringify(call.input),
  } })) } : { content };
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`);
};

/** Real Electron renderer/IPC/runtime/encrypted state with a disposable profile.
 * Only the loopback provider is synthetic. No installed profile or real provider
 * is read, and web-tool presence checks never execute a web request. */
const inFixture = async (info: TestInfo, model: ModelFixture, verify: (fixture: Fixture) => Promise<void>, options: { localExecutionConfirmed?: boolean } = {}): Promise<void> => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-round1-e2e-'));
  await mkdir(join(profile, 'workspace'), { recursive: true });
  const requests: Wire[] = [], metadataPaths: string[] = [], fixtureErrors: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        if (request.url?.endsWith('/api/show')) {
          metadataPaths.push(request.url);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return;
        }
        if (request.url?.endsWith('/models')) {
          metadataPaths.push(request.url);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'round1-fixture' }] })); return;
        }
        if (!request.url?.endsWith('/chat/completions')) throw new Error(`Unexpected fixture path ${request.url}`);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
        if (isRecentSummary(body)) { answerRecentSummary(response); return; } requests.push(body); model(body, response, requests.length);
      } catch (error) {
        fixtureErrors.push(error instanceof Error ? error.message : String(error));
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic fixture assertion failed' }));
      }
    });
  });
  let application: ElectronApplication | undefined, page: Page | undefined;
  let failure: string | null = null;
  let identity: unknown;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
    const entry = join(process.cwd(), '.webpack', 'arm64', 'main', 'index.js');
    const expectedMainHash = createHash('sha256').update(await readFile(entry)).digest('hex');
    const env: Record<string, string> = { NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    application = await electron.launch({ args: [entry], cwd: process.cwd(), env });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ app }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Refusing non-fixture application');
    }, profile);
    const diagnostics = await page.evaluate(() => window.deskpet.app.getDiagnostics());
    expect(diagnostics.runtimeIdentity?.dataDirectory).toBe(profile);
    expect(diagnostics.runtimeIdentity?.mainBundleSHA256).toBe(expectedMainHash);
    identity = diagnostics.runtimeIdentity;
    await page.evaluate(async (config) => {
      await window.deskpet.app.setLocale('en');
      await window.deskpet.providers.upsert(config); await window.deskpet.providers.select(config.id);
    }, { id: randomUUID(), name: 'Round one local fixture', kind: 'ollama' as const,
      model: 'round1-fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, supportsTools: true,
      localExecutionConfirmed: options.localExecutionConfirmed ?? true, contextWindowTokens: 32768, maxOutputTokens: 1024 });
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    const f: Fixture = {
      application, page, profile, requests,
      send: async (content) => {
        await page!.locator('.composer textarea').fill(content);
        await page!.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page!.locator('.message.assistant')).toHaveCount(1);
      },
      currentMessages: async () => {
        const id = await page!.locator('.session-control select').inputValue();
        return page!.evaluate((sessionId) => window.deskpet.chat.listMessages(sessionId), id);
      },
      grantSession: async (capabilityId) => {
        // Test setup only: exercise the real permission IPC with a deterministic
        // native-dialog result; never alters the inline-approval decision path.
        await application!.evaluate(({ app, dialog }, expectedProfile) => {
          if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Wrong permission fixture');
          dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        }, profile);
        await page!.evaluate((id) => window.deskpet.permissions.request({ capabilityId: id, duration: 'session' }), capabilityId);
      },
      capture: async (name) => {
        const path = info.outputPath(`${name}.png`); await page!.screenshot({ path });
        await info.attach(name, { path, contentType: 'image/png' });
      },
    };
    await verify(f);
    expect(fixtureErrors).toEqual([]);
    expect(requests.every((request) => request.messages.every((message) => !Object.hasOwn(message, 'hostToolResult')))).toBe(true);
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
  finally {
    let state: unknown = null;
    if (page && !page.isClosed()) {
      state = await page.evaluate(async () => {
        const sessions = await window.deskpet.chat.listSessions();
        return { sessions, messages: await Promise.all(sessions.map((session) => window.deskpet.chat.listMessages(session.id))),
          permissions: await window.deskpet.permissions.list(), memories: await window.deskpet.memory.list(), events: await window.deskpet.tasks.listRunEvents() };
      }).catch((error: unknown) => ({ snapshotError: String(error) }));
      await page.screenshot({ path: info.outputPath(failure ? 'failure.png' : 'final.png') }).catch(() => undefined);
    }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ scope: 'Isolated development Electron with loopback deterministic model; not installed-app or real-provider acceptance',
      identity, failure, fixtureErrors, metadataPaths, requests, state }, null, 2));
    await info.attach('evidence', { path: info.outputPath('evidence.json'), contentType: 'application/json' });
    if (application) {
      const child = application.process();
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5_000);
      try { await application.close(); } catch { /* Preserve the first failure evidence above. */ } finally { clearTimeout(timeout); }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
};

// eslint-disable-next-line no-empty-pattern
test('a mood tag becomes a reaction and never reaches the reply or history', async ({}, info) => {
  await inFixture(info, (body, response) => reply(response, body, undefined, '[mood:shy] 才不是呢。'), async ({ page, requests, send, currentMessages }) => {
    await send('你想我了吗');
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.chat-reply').last()).toHaveText('才不是呢。');
    expect((await currentMessages()).at(-1)?.content).toBe('才不是呢。');
    expect(JSON.stringify(requests[0]!.messages)).toContain('[mood:happy]');
  });
});

// eslint-disable-next-line no-empty-pattern
test('repeats a model call that broke before producing anything, and renders Markdown replies', async ({}, info) => {
  await inFixture(info, (body, response, count) => {
    if (count === 1) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); setTimeout(() => response.destroy(), 50); return; }
    reply(response, body, undefined, '**重点**\n\n| 工具 | 价格 |\n|---|---|\n| 文档助手 | ¥90.00 |');
  }, async ({ page, requests, send, currentMessages }) => {
    await send('换算价格');
    await expect(page.locator('.chat-markdown table')).toContainText('¥90.00');
    await expect(page.locator('.chat-markdown strong')).toHaveText('重点');
    await expect(page.locator('.chat-reply').last()).not.toContainText('**');
    expect(requests).toHaveLength(2);
    expect((await currentMessages()).at(-1)).toMatchObject({ status: 'complete', errorCode: null });
  });
});

// eslint-disable-next-line no-empty-pattern
test('inline allow-once resumes the same math run without creating a reusable permission', async ({}, info) => {
  await inFixture(info, (body, response, round) => {
    if (round === 1) reply(response, body, [{ id: 'math-first', tool: 'math.calculate', input: { expression: '7 * 6' } }]);
    else {
      expect(JSON.parse(body.messages.find((message) => message.tool_call_id === 'math-first')!.content).result).toBe(42);
      reply(response, body, undefined, 'ROUND1_MATH_RESULT_42');
    }
  }, async (f) => {
    const permission = () => f.page.evaluate(async () => (await window.deskpet.permissions.list()).find((item) => item.capabilityId === 'math.calculate'));
    expect((await permission())?.state).toBe('not-requested');
    await f.send('Calculate the fixture expression seven times six.');
    const card = f.page.getByRole('region', { name: 'This step needs your approval', exact: true });
    await expect(card).toBeVisible(); await expect(card).toContainText('7 * 6');
    const sessionId = await f.page.locator('.session-control select').inputValue();
    const pending = await f.page.evaluate((id) => window.deskpet.chat.getInteraction(id), sessionId);
    expect(pending?.approval?.toolId).toBe('math.calculate'); expect(f.requests).toHaveLength(1);
    await f.capture('math-inline-approval');
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(f.page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(f.page.locator('.message.assistant')).toContainText('ROUND1_MATH_RESULT_42');
    expect((await permission())?.state).toBe('not-requested');
    const final = (await f.currentMessages()).find((message) => message.role === 'assistant')!;
    expect(new Set(final.requestReceipts?.map((receipt) => receipt.runId))).toEqual(new Set([pending!.runId]));
    expect(final.requestReceipts).toHaveLength(2); expect(f.requests).toHaveLength(2);
    await expect(card).toHaveCount(0);
  });
});

// eslint-disable-next-line no-empty-pattern
test('a missing file returns a safe tool error and the same run reads the corrected file', async ({}, info) => {
  await inFixture(info, (body, response, round) => {
    if (round === 1) reply(response, body, [{ id: 'missing-read', tool: 'workspace.read', input: { path: 'not-present.txt' } }]);
    else if (round === 2) {
      const error = body.messages.find((message) => message.tool_call_id === 'missing-read')!;
      expect(JSON.parse(error.content)).toMatchObject({ ok: false, error: { code: 'tool.fileMissing', retryable: true } });
      expect(error.content).not.toMatch(/deskpet-round1-e2e|stack|ENOENT/u);
      expect(body.tools?.some((tool) => tool.function.description.startsWith('Search web.'))).toBe(true);
      reply(response, body, [{ id: 'corrected-read', tool: 'workspace.read', input: { path: 'exists.txt' } }]);
    } else {
      expect(body.messages.find((message) => message.tool_call_id === 'corrected-read')?.content).toContain('SYNTHETIC_CORRECT_FILE');
      expect(body.tools?.some((tool) => tool.function.description.startsWith('Search web.'))).toBe(false);
      reply(response, body, undefined, 'ROUND1_CORRECTED_FILE_READ');
    }
  }, async (f) => {
    await writeFile(join(f.profile, 'workspace', 'exists.txt'), 'SYNTHETIC_CORRECT_FILE');
    await f.grantSession('workspace.read');
    await f.send('Read the fixture document and correct a missing path if necessary.');
    await expect(f.page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(f.page.locator('.message.assistant')).toContainText('ROUND1_CORRECTED_FILE_READ');
    const final = (await f.currentMessages()).find((message) => message.role === 'assistant')!;
    expect(final.errorCode).toBeNull(); expect(final.requestReceipts).toHaveLength(3);
    expect(final.contextTrace?.privacy).toBe('local-only');
    expect(new Set(final.requestReceipts!.map((receipt) => receipt.runId)).size).toBe(1);
    const events = await f.page.evaluate(() => window.deskpet.tasks.listRunEvents());
    expect(events.some((event) => event.metadata.errorCode === 'tool.fileMissing' && event.metadata.recovery === 1)).toBe(true);
    expect(f.requests).toHaveLength(3); await f.capture('corrected-read-complete');
  });
});

// eslint-disable-next-line no-empty-pattern
test('an instruction sent while the model runs skips every old write before execution', async ({}, info) => {
  let held: { body: Wire; response: ServerResponse } | undefined;
  await inFixture(info, (body, response, round) => {
    if (round === 1) { held = { body, response }; return; }
    const results = body.messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.tool_call_id)).toEqual(['old-write-1', 'old-write-2']);
    expect(results.every((message) => JSON.parse(message.content).skipped === true)).toBe(true);
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'Do not write any file. Explain only.' });
    expect(body.tools?.some((tool) => tool.function.description.startsWith('Search web.'))).toBe(true);
    reply(response, body, undefined, 'ROUND1_NO_WRITES_EXPLANATION');
  }, async (f) => {
    await writeFile(join(f.profile, 'workspace', 'unchanged.txt'), 'SYNTHETIC_BEFORE');
    // A missing permission must not be what prevents the old writes: the
    // follow-up itself must supersede actions that otherwise could execute.
    await f.grantSession('workspace.write');
    await f.send('Prepare the fixture file changes.');
    await expect.poll(() => held !== undefined).toBe(true);
    await f.page.locator('.composer textarea').fill('Do not write any file. Explain only.');
    await f.page.getByRole('button', { name: 'Add instruction', exact: true }).click();
    await expect(f.page.locator('.message.user[data-followup-to]')).toContainText('Do not write any file. Explain only.');
    await expect(f.page.getByText('Received; will apply at the next step', { exact: false })).toBeVisible();
    await expect(f.page.locator('.composer textarea')).toHaveValue('');
    await f.capture('followup-received-before-tool-batch');
    reply(held!.response, held!.body, [
      { id: 'old-write-1', tool: 'workspace.write', input: { path: 'unchanged.txt', content: 'UNEXPECTED_OVERWRITE' } },
      { id: 'old-write-2', tool: 'workspace.write', input: { path: 'unexpected.txt', content: 'UNEXPECTED_NEW_FILE' } },
    ]);
    await expect(f.page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(f.page.locator('.message.assistant')).toContainText('ROUND1_NO_WRITES_EXPLANATION');
    expect(await readFile(join(f.profile, 'workspace', 'unchanged.txt'), 'utf8')).toBe('SYNTHETIC_BEFORE');
    expect(await readdir(join(f.profile, 'workspace'))).toEqual(['unchanged.txt']);
    await expect(f.page.locator('.chat-approval')).toHaveCount(0);
    const messages = await f.currentMessages();
    expect(messages.filter((message) => message.followupToMessageId)).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.find((message) => message.role === 'assistant')?.contextTrace?.privacy).toBe('cloud-allowed');
    expect(f.requests).toHaveLength(2);
  });
});

for (const action of ['deny', 'cancel', 'expire'] as const) {
  // eslint-disable-next-line no-empty-pattern
  test(`a pending approval survives renderer reload; ${action} and replay never execute the write`, async ({}, info) => {
    await inFixture(info, (body, response) => {
      reply(response, body, [{ id: 'review-write', tool: 'workspace.write', input: { path: 'unchanged.txt', content: 'UNEXPECTED_WRITE' } }]);
    }, async (f) => {
      await writeFile(join(f.profile, 'workspace', 'unchanged.txt'), 'SYNTHETIC_BEFORE');
      await f.send('Write the fixture file only if the action is approved.');
      await expect(f.page.locator('.chat-approval')).toBeVisible();
      const sessionId = await f.page.locator('.session-control select').inputValue();
      const before = (await f.page.evaluate((id) => window.deskpet.chat.getInteraction(id), sessionId))!.approval!;
      await f.page.reload(); await expect(f.page.locator('.app-shell')).toBeVisible();
      await f.page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
      const card = f.page.getByRole('region', { name: 'This step needs your approval', exact: true });
      await expect(card).toBeVisible(); await expect(card.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled();
      const restored = (await f.page.evaluate((id) => window.deskpet.chat.getInteraction(id), sessionId))!.approval!;
      expect(restored.id).toBe(before.id); expect(restored.runId).toBe(before.runId);
      await f.capture(`restored-${action}-approval`);
      if (action === 'deny') await card.getByRole('button', { name: 'Deny', exact: true }).click();
      else if (action === 'cancel') await f.page.getByRole('button', { name: 'Stop', exact: true }).click();
      else {
        // Advance only this disposable Electron host's clock to verify its
        // expiry check without waiting five minutes or touching user settings.
        await f.application.evaluate((_electron, expiresAt) => {
          const globals = globalThis as typeof globalThis & { __round1DateNow?: () => number };
          globals.__round1DateNow = Date.now; Date.now = () => Date.parse(expiresAt) + 1;
        }, restored.expiresAt);
        try {
          const expiry = await f.page.evaluate(async (approval: ChatApprovalRequest) => {
            try { await window.deskpet.chat.resolveApproval({ runId: approval.runId, sessionId: approval.sessionId, approvalId: approval.id, decision: 'allow-once' }); return 'UNEXPECTED_APPROVAL'; }
            catch (error) { return (error as Error).message; }
          }, restored);
          expect(expiry).toContain('chat.approvalExpired');
        } finally {
          await f.application.evaluate(() => {
            const globals = globalThis as typeof globalThis & { __round1DateNow?: () => number };
            if (globals.__round1DateNow) { Date.now = globals.__round1DateNow; delete globals.__round1DateNow; }
          });
        }
      }
      await expect(f.page.locator('.message.assistant')).toHaveAttribute('data-status', action === 'cancel' ? 'cancelled' : 'failed');
      if (action !== 'cancel') {
        const final = (await f.currentMessages()).find((message) => message.role === 'assistant')!;
        expect(final.errorCode).toBe(action === 'deny' ? 'chat.approvalDenied' : 'chat.approvalExpired');
        await expect(f.page.getByRole('button', { name: 'Open permissions', exact: true })).toHaveCount(0);
      }
      const replay = await f.page.evaluate(async (approval: ChatApprovalRequest) => {
        try { await window.deskpet.chat.resolveApproval({ runId: approval.runId, sessionId: approval.sessionId, approvalId: approval.id, decision: 'allow-once' }); return 'UNEXPECTED_APPROVAL'; }
        catch (error) { return (error as Error).message; }
      }, restored);
      expect(replay).toContain('chat.approvalExpired');
      expect(await readFile(join(f.profile, 'workspace', 'unchanged.txt'), 'utf8')).toBe('SYNTHETIC_BEFORE');
      expect(f.requests).toHaveLength(1);
      expect((await f.page.evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'workspace.write')?.state).toBe('not-requested');
      await expect(f.page.locator('.chat-approval')).toHaveCount(0);
      await f.capture(`${action}-approval-resolved`);
    });
  });
}

// eslint-disable-next-line no-empty-pattern
test('an unrelated saved private memory is omitted from a fresh public query while web tools remain declared', async ({}, info) => {
  const secret = 'SYNTHETIC_PRIVATE_TEA_NOTE_7291';
  await inFixture(info, (body, response) => {
    expect(JSON.stringify(body.messages)).not.toContain(secret);
    expect(body.tools?.some((tool) => tool.function.description.startsWith('Search web.'))).toBe(true);
    expect(body.tools?.some((tool) => tool.function.description.startsWith('Read HTTPS page.'))).toBe(true);
    reply(response, body, undefined, 'ROUND1_PUBLIC_CONTEXT_ISOLATED');
  }, async (f) => {
    const memory = await f.page.evaluate((text) => window.deskpet.memory.upsert({ id: crypto.randomUUID(), text,
      tags: [], privacy: 'local-only', scope: { kind: 'global' } }), `My favourite jasmine tea preference: ${secret}`);
    expect(memory.contextMetadata?.privacy).toBe('local-only'); expect(memory.contextMetadata?.trust).toBe('host-confirmed');
    await f.send('Find the latest quantum computing news from public sources.');
    await expect(f.page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(f.page.locator('.message.assistant')).toContainText('ROUND1_PUBLIC_CONTEXT_ISOLATED');
    const final = (await f.currentMessages()).find((message) => message.role === 'assistant')!;
    expect(final.contextTrace?.privacy).toBe('cloud-allowed');
    expect(final.contextTrace?.memoryReferences).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect((await f.page.evaluate(() => window.deskpet.memory.list()))[0]?.id).toBe(memory.id);
    await f.capture('public-query-omits-private-note');
  });
});

const approvalCard = (f: Fixture) => f.page.getByRole('region', { name: 'This step needs your approval', exact: true });
const lastAssistant = (f: Fixture) => f.page.locator('.message.assistant').last();

// eslint-disable-next-line no-empty-pattern
test('one task-long approval covers several writes without creating a saved permission', async ({}, info) => {
  await inFixture(info, (body, response, round) => {
    if (round <= 3) reply(response, body, [{ id: `write-${round}`, tool: 'workspace.write', input: { path: `part-${round}.txt`, content: `PART_${round}` } }]);
    else reply(response, body, undefined, 'BATCH1_WROTE_THREE');
  }, async (f) => {
    await f.send('Write the three fixture parts.');
    const card = approvalCard(f);
    await expect(card).toContainText('part-1.txt');
    await f.capture('task-long-approval');
    await card.getByRole('button', { name: 'Allow for this task', exact: true }).click();
    await expect(lastAssistant(f)).toHaveAttribute('data-status', 'complete');
    await expect(lastAssistant(f)).toContainText('BATCH1_WROTE_THREE');
    for (const part of [1, 2, 3]) expect(await readFile(join(f.profile, 'workspace', `part-${part}.txt`), 'utf8')).toBe(`PART_${part}`);
    const permission = await f.page.evaluate(async () => (await window.deskpet.permissions.list()).find((item) => item.capabilityId === 'workspace.write'));
    expect(permission?.state).toBe('not-requested');
  });
});

// eslint-disable-next-line no-empty-pattern
test('a non-local model reads a local file only after naming the recipient, and the release ends when the model changes', async ({}, info) => {
  const secret = 'BATCH1_LOCAL_FILE_SECRET';
  await inFixture(info, (body, response, round) => {
    if (round === 1) { reply(response, body, [{ id: 'cloud-read', tool: 'workspace.read', input: { path: 'notes.txt' } }]); return; }
    if (round === 2) {
      expect(body.messages.find((message) => message.tool_call_id === 'cloud-read')?.content).toContain(secret);
      expect(body.tools?.some((tool) => /^Search web|^Read HTTPS/u.test(tool.function.description))).toBe(false);
      reply(response, body, undefined, 'BATCH1_SUMMARY_OF_NOTES'); return;
    }
    if (round === 3) {
      expect(JSON.stringify(body.messages)).toContain('BATCH1_SUMMARY_OF_NOTES');
      expect(body.tools?.some((tool) => /^Search web|^Read HTTPS/u.test(tool.function.description))).toBe(false);
      reply(response, body, undefined, 'BATCH1_FOLLOWUP_USES_HISTORY'); return;
    }
    expect(JSON.stringify(body.messages)).not.toContain('BATCH1_SUMMARY_OF_NOTES');
    expect(JSON.stringify(body.messages)).not.toContain(secret);
    reply(response, body, undefined, 'BATCH1_OTHER_MODEL_SEES_NOTHING');
  }, async (f) => {
    await writeFile(join(f.profile, 'workspace', 'notes.txt'), secret);
    await f.grantSession('workspace.read');
    await f.send('Summarize notes.txt.');
    const card = approvalCard(f);
    await expect(card.getByRole('note')).toContainText('cannot confirm');
    await expect(card.getByRole('note')).toContainText('round1-fixture');
    expect(f.requests).toHaveLength(1);
    await f.capture('cloud-disclosure-approval');
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(lastAssistant(f)).toHaveAttribute('data-status', 'complete');
    await expect(lastAssistant(f)).toContainText('BATCH1_SUMMARY_OF_NOTES');
    const reply1 = (await f.currentMessages()).find((message) => message.role === 'assistant')!;
    expect(reply1.contextTrace?.privacy).toBe('local-only');
    expect(f.requests).toHaveLength(2);

    const ask = async (content: string, count: number): Promise<void> => {
      await f.page.locator('.composer textarea').fill(content);
      await f.page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(f.page.locator('.message.assistant')).toHaveCount(count);
      await expect(lastAssistant(f)).toHaveAttribute('data-status', 'complete');
    };
    await ask('Shorten that summary.', 2);
    await expect(lastAssistant(f)).toContainText('BATCH1_FOLLOWUP_USES_HISTORY');

    await f.page.evaluate(async () => {
      const provider = (await window.deskpet.providers.list())[0]!;
      const { secretState, ...config } = provider; void secretState;
      await window.deskpet.providers.upsert({ ...config, model: 'round1-other-fixture' });
    });
    await ask('What did the notes say?', 3);
    await expect(lastAssistant(f)).toContainText('BATCH1_OTHER_MODEL_SEES_NOTHING');
    expect(f.requests).toHaveLength(4);
  }, { localExecutionConfirmed: false });
});

// eslint-disable-next-line no-empty-pattern
test('denying a non-local read sends nothing and executes nothing', async ({}, info) => {
  const secret = 'BATCH1_DENIED_FILE_SECRET';
  await inFixture(info, (body, response) => {
    reply(response, body, [{ id: 'denied-read', tool: 'workspace.read', input: { path: 'denied.txt' } }]);
  }, async (f) => {
    await writeFile(join(f.profile, 'workspace', 'denied.txt'), secret);
    await f.send('Summarize denied.txt.');
    const card = approvalCard(f);
    await expect(card.getByRole('note')).toBeVisible();
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(lastAssistant(f)).toHaveAttribute('data-status', 'failed');
    expect((await f.currentMessages()).find((message) => message.role === 'assistant')?.errorCode).toBe('chat.approvalDenied');
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests)).not.toContain(secret);
  }, { localExecutionConfirmed: false });
});

// eslint-disable-next-line no-empty-pattern
test('a run at its step limit reports progress with one tool-free request', async ({}, info) => {
  await inFixture(info, (body, response, round) => {
    if (body.tools?.length) reply(response, body, [{ id: `step-${round}`, tool: 'math.calculate', input: { expression: `${round} + 1` } }]);
    else reply(response, body, undefined, 'BATCH1_PROGRESS_REPORT');
  }, async (f) => {
    await f.grantSession('math.calculate');
    await f.send('Keep calculating forever.');
    await expect(lastAssistant(f)).toHaveAttribute('data-status', 'complete', { timeout: 40_000 });
    await expect(lastAssistant(f)).toContainText('BATCH1_PROGRESS_REPORT');
    await expect(lastAssistant(f)).toContainText('step limit');
    expect(f.requests).toHaveLength(25);
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('step budget');
    expect(f.requests.at(-1)).toMatchObject({ reasoning_effort: 'none' });
    expect(f.requests.at(-2)).not.toHaveProperty('reasoning_effort');
    expect(f.requests.at(-2)!.tools?.length).toBeGreaterThan(0);
  });
});

// eslint-disable-next-line no-empty-pattern
test('several unrelated read failures do not end the run', async ({}, info) => {
  await inFixture(info, (body, response, round) => {
    if (round <= 4) reply(response, body, [{ id: `missing-${round}`, tool: 'workspace.read', input: { path: `missing-${round}.txt` } }]);
    else if (round === 5) reply(response, body, [{ id: 'found', tool: 'workspace.read', input: { path: 'present.txt' } }]);
    else {
      expect(body.messages.find((message) => message.tool_call_id === 'found')?.content).toContain('BATCH1_PRESENT');
      reply(response, body, undefined, 'BATCH1_RECOVERED_AFTER_FOUR');
    }
  }, async (f) => {
    await writeFile(join(f.profile, 'workspace', 'present.txt'), 'BATCH1_PRESENT');
    await f.grantSession('workspace.read');
    await f.send('Find the file that exists.');
    await expect(lastAssistant(f)).toHaveAttribute('data-status', 'complete');
    await expect(lastAssistant(f)).toContainText('BATCH1_RECOVERED_AFTER_FOUR');
    expect(f.requests).toHaveLength(6);
  });
});


// eslint-disable-next-line no-empty-pattern
test('restricted desktop shell requires a fresh approval even with a standing grant', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'macOS sandbox is required');
  await inFixture(info, (body, response) => {
    if (body.messages.at(-1)?.role === 'tool') return reply(response,body,undefined,'Shell finished.');
    return reply(response,body,[{id:'sort-once',tool:'shell.run',input:{command:'sort | uniq',inputPath:'input.txt',outputPath:'sorted.txt'}}]);
  }, async f => {
    const dest = join(f.profile,'workspace/sorted.txt');
    await writeFile(join(f.profile,'workspace/input.txt'),'z\na\na\n'); await f.grantSession('shell.run');
    await f.send('Sort the test workspace input using the restricted pipeline.');
    const card=f.page.locator('.chat-approval');await expect(card).toBeVisible();
    await expect(card).toContainText('sorted.txt');await expect(readFile(dest)).rejects.toMatchObject({code:'ENOENT'});
    await expect(card.getByRole('button',{name:/allow.*task/i})).toHaveCount(0);
    await card.getByRole('button',{name:'Allow once',exact:true}).click();
    await expect.poll(()=>readFile(dest,'utf8').catch(()=>null)).toBe('a\nz\n');
  },{localExecutionConfirmed:true});
});
