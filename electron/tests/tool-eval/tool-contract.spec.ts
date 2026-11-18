import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line no-empty-pattern
test('audits production tool validation, permission denial and reused provider call IDs', async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-tool-contract-'));
  let application: ElectronApplication | undefined;
  const interrupted = new Set<string>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string; description: string } }> };
      const prompt = body.messages.find((message) => message.role === 'user')?.content ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const toolMessages = body.messages.filter((message) => message.role === 'tool');
      if (toolMessages.length > 0 && !(prompt === 'two-rounds' && toolMessages.length === 1)) {
        if (prompt.startsWith('retry-') && !interrupted.has(prompt)) { interrupted.add(prompt); response.end('data: {"choices":[{"delta":{"content":"Partial confirmation"}}]}\n\n'); return; }
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: prompt === 'empty-confirmation' ? '' : 'Tool confirmed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
      }
      const name = prompt === 'unknown' ? 'unregistered_tool' : body.tools.find((tool) => tool.function.description.startsWith('Create timer.'))!.function.name;
      const args = prompt === 'malformed' ? { seconds: '60', label: prompt } : { seconds: prompt === 'first' || (prompt === 'retry-conflict' && !interrupted.has(prompt)) ? 60 : 120, label: prompt === 'two-rounds' ? `round-${toolMessages.length}` : prompt };
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: interrupted.has(prompt) ? 'changed_id_on_retry' : 'call_1', function: { name, arguments: prompt === 'invalid-json' ? '{invalid' : JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  try {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    let page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    await application.evaluate(({ Notification }) => { Notification.prototype.show = () => undefined; });
    const providerId = await page.evaluate(async (baseUrl) => {
      const provider = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Contract fixture', model: 'fixture', baseUrl, enabled: true, supportsTools: true });
      return provider.id;
    }, `http://127.0.0.1:${address.port}/v1`);
    const results: Array<Record<string, unknown>> = [];
    for (const prompt of ['denied', 'malformed', 'invalid-json', 'unknown', 'first', 'second', 'two-rounds', 'empty-confirmation', 'retry-safe', 'retry-conflict']) {
      if (prompt === 'malformed') await page.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'timer.write', duration: 'session' }));
      const before = await page.evaluate(() => window.deskpet.timers.list());
      const sessionId = await page.evaluate(async ({ prompt }) => {
        const session = await window.deskpet.chat.createSession({ title: prompt, kind: 'normal' });
        return session.id;
      }, { prompt });
      await page.evaluate((id) => window.deskpet.providers.select(id), providerId);
      await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
      await page.getByRole('combobox', { name: 'New chat', exact: true }).selectOption(sessionId);
      await page.locator('.composer textarea').fill(prompt); await page.locator('.composer textarea').press('Enter');
      await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).length).toBe(2);
      await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.status).not.toBe('streaming');
      if (prompt.startsWith('retry-')) {
        await expect(page.getByRole('alert')).toContainText('connection ended before');
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        if (prompt === 'retry-safe') await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.status).toBe('complete');
        else await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.errorCode).toBe('tool.effectConflict');
        expect(await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).toHaveLength(2);
      }
      const final = (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1);
      const after = await page.evaluate(() => window.deskpet.timers.list());
      const added = after.filter((timer) => !before.some((old) => old.id === timer.id));
      const expectedError: Record<string, string> = { denied: 'tool.permission.timer.write', malformed: 'tool.invalidArguments', 'invalid-json': 'tool.invalidArguments', unknown: 'tool.unknown', 'retry-conflict': 'tool.effectConflict' };
      const error = expectedError[prompt];
      const pass = error ? final?.errorCode === error && added.length === (prompt === 'retry-conflict' ? 1 : 0)
        : final?.status === 'complete' && added.length === (prompt === 'two-rounds' ? 2 : 1);
      const receiptMatches = (final?.timerReceipts?.length ?? 0) === added.length;
      results.push({ prompt, final, added, pass: pass && receiptMatches });
      if (added.length > 0) {
        await expect(page.locator('.timer-receipt')).toHaveCount(added.length);
        await page.screenshot({ path: info.outputPath(`${prompt}-confirmed.png`) });
      }
      if (error) {
        await expect(page.getByRole('alert')).not.toContainText('The response failed');
        await page.screenshot({ path: info.outputPath(`${prompt}.png`) });
      }
      if (prompt === 'denied') {
        await page.getByRole('button', { name: 'Open permissions', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Tool permissions', exact: true })).toBeVisible();
      }
    }
    await application.close(); application = undefined;
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    const recovered = await page.evaluate(async () => {
      const session = (await window.deskpet.chat.listSessions()).find((item) => item.title === 'empty-confirmation')!;
      return { id: session.id, messages: await window.deskpet.chat.listMessages(session.id) };
    });
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('combobox', { name: 'New chat', exact: true }).selectOption(recovered.id);
    await expect(page.locator('.timer-receipt')).toHaveCount(1);
    expect(recovered.messages.at(-1)?.timerReceipts).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('receipt-after-restart.png') });
    await writeFile(info.outputPath('contract-evaluation.json'), JSON.stringify({ results, receiptRecoveredAfterRestart: true, reusedCallIdAcrossIndependentConversations: 'call_1' }, null, 2));
    expect(results.filter((item) => !item.pass).map((item) => item.prompt), 'Each independent approved action must execute, even if a provider reuses call IDs').toEqual([]);
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); }
});
