import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ChatRequest {
  reasoning_effort?: string;
  messages: Array<{ role: string; content: string }>;
}

let application: ElectronApplication | undefined;
let page: Page;
let profile: string;
let baseUrl: string;
let firstResponse: ServerResponse | undefined;
let cancelled = false;
const requests: ChatRequest[] = [];
const server = createServer((request, response) => {
  if (request.url?.endsWith('/api/show') || request.url?.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.endsWith('/api/show')
      ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } }
      : { data: [{ id: 'fixture' }] }));
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest;
    requests.push(body);
    const content = body.messages.filter((message) => message.role === 'user').at(-1)?.content;
    if (content === 'Quota failure') {
      response.writeHead(402, { 'content-type': 'application/json' }).end('{"error":"private account details must stay hidden"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (content === '你好\nKitty') firstResponse = response;
    else if (content === 'Wait until cancelled') response.once('close', () => { cancelled = true; });
    else {
      sendText(response, 'Ready to chat again.');
      finish(response);
    }
  });
});

function sendText(response: ServerResponse, content: string): void {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
}
function finish(response: ServerResponse): void {
  response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'deskpet-chat-usability-'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local fixture port is unavailable.');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  application = await electron.launch({
    args: [join(process.cwd(), '.webpack', process.arch, 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile },
  });
  await expect.poll(() => application?.windows().map((window) => window.url())).toContain('deskpet://app/main_window/index.html');
  const selected = application.windows().find((window) => window.url() === 'deskpet://app/main_window/index.html');
  if (selected === undefined) throw new Error('DeskPet console did not open.');
  page = selected;
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.evaluate(async (endpoint) => {
    await window.deskpet.app.setLocale('en');
    await window.deskpet.providers.upsert({
      id: crypto.randomUUID(), name: 'Plain local chat', kind: 'ollama', model: 'fixture',
      baseUrl: endpoint, enabled: true, supportsTools: false,
    });
  }, baseUrl);
  await page.reload();
  await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
});

test.afterAll(async () => {
  try {
    if (application !== undefined) {
      const child = application.process();
      const exit = once(child, 'exit');
      void application.close().catch(() => undefined);
      const graceful = await Promise.race([exit.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!graceful) { child.kill('SIGKILL'); await exit; }
      expect(graceful, 'DeskPet should quit without forcing termination').toBe(true);
      expect(child.exitCode).toBe(0);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

test('sends with Enter, shows waiting and streaming, explains quota failures and recovers after cancellation', async () => {
  const composer = page.getByRole('textbox');
  await composer.fill('你好');
  await composer.press('Shift+Enter');
  await composer.press('K');
  await composer.press('i');
  await composer.press('t');
  await composer.press('t');
  await composer.press('y');
  await expect(composer).toHaveValue('你好\nKitty');
  expect(requests).toHaveLength(0);
  await composer.press('Enter');
  await expect(page.getByRole('status')).toContainText('Thinking');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('');
  await expect.poll(() => firstResponse !== undefined).toBe(true);
  expect(requests[0]).toMatchObject({ reasoning_effort: 'none' });
  if (firstResponse === undefined) throw new Error('The Enter key did not reach the provider.');
  sendText(firstResponse, `你好，我是 Kitty。\n${'A line of conversation history.\n'.repeat(40)}`);
  await expect(page.locator('.message.assistant').last()).toContainText('你好，我是 Kitty。');
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'streaming');
  await expect(page.getByRole('status')).toContainText('Writing a reply');
  const messageList = page.locator('.message-list');
  const distanceFromBottom = () => messageList.evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2);
  await messageList.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(distanceFromBottom).toBeGreaterThan(40);
  const readingPosition = await messageList.evaluate((list) => list.scrollTop);
  sendText(firstResponse, 'This new text should preserve the history reading position.');
  await expect(page.locator('.message.assistant').last()).toContainText('preserve the history reading position');
  expect(await messageList.evaluate((list) => list.scrollTop)).toBeCloseTo(readingPosition, 0);
  finish(firstResponse);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await composer.fill('Quota failure');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('quota is exhausted');
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2);
  await expect(page.locator('body')).not.toContainText('private account details');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await composer.fill('Wait until cancelled');
  await composer.press('Enter');
  await expect(page.getByRole('status')).toContainText('Thinking');
  await expect.poll(() => requests.some((request) => request.messages.at(-1)?.content === 'Wait until cancelled')).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => cancelled).toBe(true);
  await composer.fill('Recover after failure and cancellation');
  await composer.press('Enter');
  await expect(page.locator('.message.assistant').last()).toContainText('Ready to chat again.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => request.reasoning_effort === 'none')).toBe(true);
});
