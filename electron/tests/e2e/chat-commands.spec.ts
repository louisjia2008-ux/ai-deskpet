import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface Request { model: string; messages: Array<{ role: string; content: string }> }
// Isolated profile and provider fixture; real main/preload/renderer and persistence.
// eslint-disable-next-line no-empty-pattern
test('answers /model and /provider in desktop chat without a model request, then sends with the new choice', async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-chat-commands-e2e-'));
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/api/show')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return; }
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request; if (isRecentSummary(body)) { answerRecentSummary(response); return; } requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Reply from ${body.model}.` }, finish_reason: null }] })}\n\n`);
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  let application: ElectronApplication | undefined; let page: Page;
  try {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    const ids = await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('en');
      const first = crypto.randomUUID(); const second = crypto.randomUUID();
      for (const [id, name] of [[first, 'First service'], [second, 'Second service']] as const) {
        await window.deskpet.providers.upsert({ id, kind: 'ollama', name, baseUrl, model: 'alpha', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768 });
      }
      await window.deskpet.providers.select(first);
      return { first, second };
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const composer = page.locator('.composer textarea');
    const say = async (text: string, reply: string | RegExp): Promise<void> => {
      await composer.fill(text); await composer.press('Enter');
      await expect(page.locator('.chat-reply').last()).toContainText(reply);
      await expect(composer).toBeEnabled();
    };
    await say('/model', 'Now: First service · alpha');
    // The reply is rendered as Markdown, so its numbers become a list.
    await say('/models', /alpha \(current\)\s*beta/u);
    await say('/model 2', 'Switched: First service · beta');
    expect(requests).toHaveLength(0);
    await say('Hello there', 'Reply from beta.');
    expect(requests.at(-1)?.model).toBe('beta');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Switched:');
    await say('/provider second', 'Switched: Second service · alpha');
    // A switch applies only to this conversation; the default provider stays as it was.
    await expect.poll(() => page.evaluate(async () => (await window.deskpet.chat.listSessions()).find((session) => session.modelSelection)?.modelSelection?.providerId)).toBe(ids.second);
    expect(await page.evaluate(async () => (await window.deskpet.app.getState()).activeProviderId)).toBe(ids.first);
    await say('Hello again', 'Reply from alpha.');
    expect(requests).toHaveLength(2);
    await say('/model gamma', 'Second service has no such model');
    await info.attach('requests', { body: JSON.stringify(requests.map((item) => item.model)), contentType: 'application/json' });
  } finally {
    await application?.close().catch(() => undefined);
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await rm(profile, { recursive: true, force: true });
  }
});
