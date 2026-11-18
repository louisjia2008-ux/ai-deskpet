import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

interface Request { model: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }
const SCRIPT = 'whoami; uname -s; pwd; echo hello > /work/deskpet-e2e-check.txt; sudo -n true 2>/dev/null && echo SUDO; curl -s -m 3 -o /dev/null -w "host:%{http_code}\\n" http://192.168.5.2:11434; true';

// Runs commands in the real sandbox machine of this Mac user, so it is opt-in:
// DESKPET_E2E_VM=1. If the machine does not exist yet, the test sets it up from Settings first (about 10 minutes).
test.skip(process.env.DESKPET_E2E_VM !== '1', 'needs the real sandbox machine');
// eslint-disable-next-line no-empty-pattern
test('a model that is not local runs an approved command in the sandbox machine and gets its output', async ({}, info) => {
  test.setTimeout(30 * 60_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-vm-e2e-'));
  const shared = join(homedir(), 'DeskPet Sandbox', 'deskpet-e2e-check.txt');
  await rm(shared, { force: true });
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/api/show')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } })); return; }
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'alpha' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request; requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const name = body.tools?.map(tool => tool.function.name).find(value => /^vm[._]shell$/u.test(value));
      const answered = body.messages.some(message => message.role === 'tool');
      const delta = !answered && name ? { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: JSON.stringify({ command: SCRIPT }) } }] } : { content: answered ? 'Finished in the sandbox.' : 'No sandbox tool was offered.' };
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  let application: ElectronApplication | undefined; let page: Page;
  try {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile, DESKPET_E2E_VM: '1' } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    const state = await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('en');
      const id = crypto.randomUUID();
      await window.deskpet.providers.upsert({ id, kind: 'ollama', name: 'Not local', baseUrl, model: 'alpha', enabled: true, supportsTools: true, localExecutionConfirmed: false, contextWindowTokens: 32768 });
      await window.deskpet.providers.select(id);
      return (await window.deskpet.vmSandbox.status()).state;
    }, `http://127.0.0.1:${address.port}/v1`);
    if (state === 'absent') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Sandbox VM' }).click();
      const panel = page.getByRole('region', { name: 'Sandbox virtual machine' });
      await expect(panel.getByRole('status')).toHaveText('Not set up.');
      await panel.getByRole('button', { name: 'Set up', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Setting up');
      await expect(panel.getByRole('status')).toContainText('Running.', { timeout: 25 * 60_000 });
      await expect(panel.getByRole('button', { name: 'Stop now' })).toBeEnabled();
    } else expect(['running', 'stopped']).toContain(state);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const composer = page.locator('.composer textarea');
    await composer.fill('Check the sandbox.'); await composer.press('Enter');
    const approval = page.locator('.chat-approval');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText('Shell in the sandbox virtual machine');
    await expect(approval).toContainText('whoami');
    await approval.getByRole('button', { name: 'Allow for this task' }).click();
    await expect(page.locator('.chat-reply').last()).toContainText('Finished in the sandbox.', { timeout: 120_000 });
    const result = JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'tool'));
    for (const expected of ['agent', 'Linux', '/work', 'host:000']) expect(result).toContain(expected);
    expect(result).not.toContain('SUDO');
    expect(await readFile(shared, 'utf8')).toBe('hello\n');
    await info.attach('tool-result', { body: result, contentType: 'application/json' });
  } finally {
    await application?.close().catch(() => undefined);
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await rm(profile, { recursive: true, force: true });
    await rm(shared, { force: true });
  }
});
