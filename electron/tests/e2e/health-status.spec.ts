import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface Request { model: string; messages: Array<{ role: string; content: string }> }
// Isolated profile and provider fixture; real main/preload/renderer, and auto memory's real quiet period.
// eslint-disable-next-line no-empty-pattern
test('a provider that refuses auto memory shows up on the status page with its reason and a badge', async ({}, info) => {
  test.setTimeout(420_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-health-e2e-'));
  let refused = 0;
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/api/show')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return; }
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'alpha' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
      if (isRecentSummary(body)) { answerRecentSummary(response); return; } 
      // What api.openai.com answered every auto memory read with until 2026-11-14.
      if (body.messages[0]?.content.startsWith('You keep the long-term profile')) {
        refused++;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'temperature', message: 'Unsupported parameter: temperature' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的，记住了。' }, finish_reason: null }] })}\n\n`);
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
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      const id = crypto.randomUUID();
      await window.deskpet.providers.upsert({ id, kind: 'ollama', name: '测试模型', baseUrl, model: 'alpha', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768 });
      await window.deskpet.providers.select(id);
    }, `http://127.0.0.1:${address.port}/v1`);
    const before = await page.evaluate(() => window.deskpet.attention.health!());
    expect(before.items.find((item) => item.feature === 'auto-memory')).toMatchObject({ state: 'waiting', sinceLaunch: true });
    expect(before.issues).toBe(0);

    await page.getByRole('button', { name: '聊天', exact: true }).click();
    const composer = page.locator('.composer textarea');
    await composer.fill('我平时最喜欢喝乌龙茶'); await composer.press('Enter');
    await expect(page.locator('.chat-reply').last()).toContainText('好的，记住了。');
    // Auto memory reads once the conversation has been quiet for three minutes.
    await expect.poll(() => refused, { timeout: 240_000, intervals: [5_000] }).toBe(1);
    await expect.poll(async () => (await page.evaluate(() => window.deskpet.attention.health!())).issues).toBe(1);

    // The badge refreshes once a minute.
    await expect(page.locator('nav').getByRole('button', { name: '动态', exact: true }).locator('strong')).toHaveText('1', { timeout: 70_000 });
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '运行状态 · 1', exact: true }).click();
    const card = page.locator('article.attention-card').first();
    await expect(card.getByRole('heading')).toHaveText('自动记忆');
    await expect(card).toContainText('异常');
    await expect(card).toContainText('模型不接受这次请求的参数设置');
    await expect(card).toContainText('provider.unsupportedParameter');
    await expect(card).toContainText('连续失败 1 次');
    await expect(card).toContainText('怎么处理：');
    await page.screenshot({ path: info.outputPath('health-status.png'), scale: 'css', animations: 'disabled' });
    // 「知道了」 clears the badges at once and survives the next read; the card stays, marked as seen.
    await card.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(page.getByRole('tab', { name: '运行状态', exact: true })).toBeVisible();
    await expect(page.locator('nav').getByRole('button', { name: '动态', exact: true }).locator('strong')).toHaveCount(0);
    await expect(card).toContainText('已知道');
    expect((await page.evaluate(() => window.deskpet.attention.health!())).issues).toBe(0);
    await card.getByRole('button', { name: '去设置', exact: true }).click();
    await expect(page.locator('nav').getByRole('button', { name: '记忆', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally { await application?.close(); server.close(); await rm(profile, { recursive: true, force: true }); }
});
