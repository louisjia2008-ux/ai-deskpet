import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/shared';

// eslint-disable-next-line no-empty-pattern
test('direct commands retain permission, retry, persistence and conversational boundaries', async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-direct-command-'));
  let modelRequests = 0;
  let illustrationDeclaredTools: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      modelRequests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
      if (body.messages.at(-1)?.content === '两分钟后提醒我喝水（仅演示这句话）。') {
        illustrationDeclaredTools = body.tools ?? [];
        // A noncompliant provider invents a call even though no tools are offered.
        response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"invented","function":{"name":"timer.create","arguments":"{\\"seconds\\":120,\\"label\\":\\"must not execute\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      response.end('data: {"choices":[{"delta":{"content":"Context handled by the model."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
  try {
    await expect.poll(() => application.windows().some((page) => page.url().includes('/main_window/'))).toBe(true);
    const page = application.windows().find((page) => page.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ Notification }) => { Notification.prototype.show = () => undefined; });
    const provider = await page.evaluate((port) => window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Direct command fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true, supportsTools: true }), address.port);
    await page.evaluate((id) => window.deskpet.providers.select(id), provider.id);
    const send = async (content: string, existingSession?: string) => {
      const id = await page.evaluate(async ({ providerId, content, existingSession }) => {
        const sessionId = existingSession ?? (await window.deskpet.chat.createSession({ title: 'Direct command contract', kind: 'normal' })).id;
        await window.deskpet.chat.send({ sessionId, providerId, content }); return sessionId;
      }, { providerId: provider.id, content, existingSession });
      let final: ChatMessage | undefined;
      await expect.poll(async () => { final = (await page.evaluate((sessionId) => window.deskpet.chat.listMessages(sessionId), id)).at(-1); return final?.status; }).not.toBe('streaming');
      return { id, final: final! };
    };
    const denied = await send('两分钟后提醒我喝水');
    expect(denied.final.errorCode).toBe('tool.permission.timer.write');
    expect(await page.evaluate(() => window.deskpet.timers.list())).toHaveLength(0);
    expect(modelRequests).toBe(0);
    await page.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'timer.write', duration: 'once' }));
    await page.evaluate((id) => window.deskpet.chat.retry(id), denied.final.id);
    await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), denied.id)).at(-1)?.status).toBe('complete');
    const retried = (await page.evaluate((id) => window.deskpet.chat.listMessages(id), denied.id)).at(-1)!;
    expect(retried.timerReceipts).toHaveLength(1);
    const second = await send('两分钟后提醒我喝水');
    expect(second.final.errorCode).toBe('tool.permission.timer.write');
    expect(await page.evaluate(() => window.deskpet.timers.list())).toHaveLength(1);
    await page.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'timer.write', duration: 'session' }));
    const third = await send('两分钟后提醒我喝水');
    expect(third.final.status).toBe('complete');
    expect(third.final.timerReceipts?.[0]?.timerId).not.toBe(retried.timerReceipts?.[0]?.timerId);
    expect(modelRequests).toBe(0);
    const contextual = await send('下一句只是示例，不要执行。');
    const contextualNext = await send('两分钟后提醒我喝水', contextual.id);
    expect(contextualNext.final.content).toBe('Context handled by the model.');
    expect(modelRequests).toBe(2);
    expect(await page.evaluate(() => window.deskpet.timers.list())).toHaveLength(2);
    const illustration = await send('两分钟后提醒我喝水（仅演示这句话）。');
    expect(illustration.final.errorCode).toBe('tool.notRequested');
    expect(illustrationDeclaredTools).toEqual([]);
    expect(await page.evaluate(() => window.deskpet.timers.list())).toHaveLength(2);
    await page.evaluate(({ id, kind, name, model, baseUrl, enabled }) => window.deskpet.providers.upsert({ id, kind, name, model, baseUrl, enabled, supportsTools: false }), provider);
    expect((await send('两分钟后提醒我喝水')).final.content).toBe('Context handled by the model.');
    expect(modelRequests).toBe(4);
    const events = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
    expect(events.filter((event) => event.metadata.route === 'direct').length).toBe(4);
    expect(JSON.stringify(events)).not.toContain('喝水');
    await writeFile(info.outputPath('direct-command-contract.json'), JSON.stringify({ permissionDenial: true, singleUseGrant: true, retryCreatesOnce: true, independentCommandsNotDeduplicated: true, conversationalContextPreserved: true, disabledToolsRespected: true, illustrativeActionBlockedEvenIfModelInventsCall: true, noPromptInTelemetry: true, events }, null, 2));
  } finally {
    await application.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(profile, { recursive: true, force: true });
  }
});
