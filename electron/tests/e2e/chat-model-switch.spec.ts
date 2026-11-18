import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Request { model: string; messages: Array<{ role: string; content: string }> }
// Isolated profile and provider fixture; real main/preload/renderer and persistence.
// eslint-disable-next-line no-empty-pattern
test('switches models during a reply, preserves draft/history and restores selection after restart', async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-model-switch-e2e-'));
  const requests: Request[] = []; let firstResponse: ServerResponse | undefined;
  const text = (response: ServerResponse, content: string): void => { response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`); };
  const finish = (response: ServerResponse): void => { response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/api/show')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return; }
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request; requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) { firstResponse = response; text(response, 'Alpha started. '); }
      else { text(response, `Reply from ${body.model}.`); finish(response); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  let application: ElectronApplication | undefined; let page: Page;
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    // This scenario verifies model selection; native permission choices have separate accepted evidence.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  };
  try {
    await launch();
    const ids = await page!.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('en');
      const first = crypto.randomUUID(); const second = crypto.randomUUID(); const disabled = crypto.randomUUID();
      for (const [id, name, enabled] of [[first, 'First service', true], [second, 'Second service', true], [disabled, 'Disabled service', false]] as const) {
        await window.deskpet.providers.upsert({ id, kind: 'ollama', name, baseUrl, model: 'alpha', enabled, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768 });
      }
      await window.deskpet.providers.select(first);
      await window.deskpet.permissions.request({ capabilityId: 'timer.write', duration: 'always' });
      return { first, second, disabled };
    }, `http://127.0.0.1:${address.port}/v1`);
    await page!.getByRole('button', { name: 'Chat', exact: true }).click();
    await page!.locator('.chat-model-picker > summary').click();
    const modelPicker = page!.getByRole('combobox', { name: 'Chat model', exact: true });
    await expect(modelPicker.locator('option[value="beta"]')).toHaveCount(1);
    await expect(page!.getByRole('combobox', { name: 'Chat provider' }).locator(`option[value="${ids.disabled}"]`)).toHaveCount(0);
    const composer = page!.locator('.composer textarea');
    await composer.fill('First turn'); await composer.press('Enter');
    await expect(page!.locator('.chat-reply').last()).toContainText('Alpha started.');
    await composer.fill('Continue with the next model');
    await expect(modelPicker).toBeEnabled(); await modelPicker.selectOption('beta');
    await expect(modelPicker).toHaveValue('beta');
    await expect(page!.getByText('This reply keeps the model it started with.', { exact: false })).toBeVisible();
    await expect(page!.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(composer).toHaveValue('Continue with the next model');
    expect(requests).toHaveLength(1); expect(requests[0]?.model).toBe('alpha');
    if (!firstResponse) throw new Error('First response was not observed');
    text(firstResponse, 'Alpha completed.'); finish(firstResponse);
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page!.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await composer.press('Enter');
    await expect(page!.locator('.chat-reply').last()).toHaveText('Reply from beta.');
    expect(requests[1]?.model).toBe('beta');
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'First turn' }, { role: 'assistant', content: 'Alpha started. Alpha completed.' }]));
    await page!.getByRole('combobox', { name: 'Chat provider' }).selectOption(ids.second);
    await expect(modelPicker).toHaveValue('alpha');
    await page!.getByText('Enter a model ID', { exact: true }).click();
    await page!.getByRole('textbox', { name: 'Model ID', exact: true }).fill('custom-gamma');
    await page!.getByRole('button', { name: 'Use this model', exact: true }).click();
    await expect(modelPicker).toHaveValue('custom-gamma');
    await composer.fill('Continue in the same conversation'); await composer.press('Enter');
    await expect(page!.locator('.chat-reply').last()).toHaveText('Reply from custom-gamma.');
    expect(requests[2]?.model).toBe('custom-gamma');
    expect(requests[2]?.messages.some((message) => message.content === 'Reply from beta.')).toBe(true);
    const before = await page!.evaluate(async () => ({ app: await window.deskpet.app.getState(), providers: await window.deskpet.providers.list(), sessions: await window.deskpet.chat.listSessions(), permissions: await window.deskpet.permissions.list() }));
    await page!.screenshot({ path: info.outputPath('model-switch.png') });
    await application!.close(); application = undefined; await launch();
    await page!.getByRole('button', { name: 'Chat', exact: true }).click();
    await page!.locator('.chat-model-picker > summary').click();
    await expect(page!.getByRole('combobox', { name: 'Chat provider' })).toHaveValue(ids.second);
    await expect(page!.getByRole('combobox', { name: 'Chat model', exact: true })).toHaveValue('custom-gamma');
    await expect(page!.locator('.message')).toHaveCount(6);
    const after = await page!.evaluate(async () => ({ app: await window.deskpet.app.getState(), providers: await window.deskpet.providers.list(), sessions: await window.deskpet.chat.listSessions(), permissions: await window.deskpet.permissions.list() }));
    expect(after.providers).toEqual(before.providers); expect(after.permissions).toEqual(before.permissions);
    expect(after.sessions.map((session) => session.id)).toEqual(before.sessions.map((session) => session.id));
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ configuration: { syntheticMetadata: true, nativePermissionChoice: 'mock allow', normalRendererSecurity: true }, requestModels: requests.map((request) => request.model), preservedDraft: true, preservedHistory: true, duringStream: true, restart: true, permissionsPreserved: true, sessionCount: after.sessions.length }, null, 2));
  } finally {
    await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(profile, { recursive: true, force: true });
  }
});
