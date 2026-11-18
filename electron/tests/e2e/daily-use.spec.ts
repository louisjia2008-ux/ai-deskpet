import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


interface FixtureRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ function: { name: string } }> }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

let application: ElectronApplication | undefined;
let page: Page;
let root: string;
let profile: string;
let baseUrl: string;
let executablePath: string;
let output = '';
let finishStream: (() => void) | null = null;
let cancelledStreams = 0;
const requests: FixtureRequest[] = [];
const errors: string[] = [];
const server = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'daily-use-fixture' }] }));
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureRequest;
    requests.push(body);
    if (!body.tools?.length || body.tools.some((tool) => !/^[A-Za-z0-9_-]{1,64}$/u.test(tool.function.name))) {
      errors.push('Invalid provider function declaration.');
      response.writeHead(400).end();
      return;
    }
    const userText = body.messages.filter((message) => message.role === 'user').at(-1)?.content;
    if (userText === 'Return a provider error.') {
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"Synthetic temporary failure"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (userText === 'My audit name is Ada.') {
      sendText(response, 'Hello Ada');
      finishStream = () => finishResponse(response, '.');
    } else if (userText === 'What name and tea preference did I give you?') {
      if (!body.messages.some((message) => message.content.includes('My audit name is Ada.'))
        || !body.messages.some((message) => message.role === 'system' && message.content.includes('jasmine tea'))) {
        errors.push('Missing conversation or saved memory in the provider request.');
      }
      sendText(response, 'You are Ada');
      finishStream = () => finishResponse(response, ' and you prefer jasmine tea.');
    } else if (userText === 'Use the current time tool.') {
      const toolResult = body.messages.find((message) => message.role === 'tool');
      const wireName = body.tools.find((tool) => tool.function.description.startsWith('Current time.'))?.function.name;
      if (wireName === undefined) { errors.push('Missing current-time tool.'); response.end(); return; }
      if (toolResult === undefined) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_daily_clock', function: { name: wireName.slice(0, 5), arguments: '{}' } }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: wireName.slice(5) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        if (toolResult.tool_call_id !== 'call_daily_clock'
          || body.messages.find((message) => message.tool_calls !== undefined)?.tool_calls?.[0]?.function.name !== wireName
          || typeof (JSON.parse(toolResult.content) as { iso?: unknown }).iso !== 'string') errors.push('Tool result did not round-trip through the agent.');
        finishResponse(response, 'The time tool completed.');
      }
    } else if (userText === 'Stream until I stop.') {
      sendText(response, 'Partial response');
      response.once('close', () => { cancelledStreams += 1; });
    } else {
      finishResponse(response, 'Recovered.');
    }
  });
});

function sendText(response: ServerResponse, content: string): void {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
}
function finishResponse(response: ServerResponse, content: string): void {
  sendText(response, content);
  response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  response.end('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  finishStream = null;
}

const launch = async (): Promise<void> => {
  application = await electron.launch({
    args: [join(process.cwd(), '.webpack', process.arch, 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile },
  });
  executablePath = application.process().spawnfile;
  output = '';
  application.process().stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); });
  application.process().stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); });
  await expect.poll(() => application?.windows().map((window) => window.url())).toContain('deskpet://app/main_window/index.html');
  const selected = application.windows().find((window) => window.url() === 'deskpet://app/main_window/index.html');
  if (selected === undefined) throw new Error('Console did not open.');
  page = selected;
  page.setDefaultTimeout(10_000);
  await expect(page.locator('.app-shell')).toBeVisible();
  await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await page.evaluate(() => window.deskpet.app.setLocale('en'));
  await expect(page.locator('nav').getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await application.evaluate(({ Notification }) => {
    const state = globalThis as typeof globalThis & { dailyUseNotifications: Array<{ title: string; body: string }> };
    state.dailyUseNotifications = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function () {
      state.dailyUseNotifications.push({ title: this.title, body: this.body });
      show.call(this);
    };
  });
};

const shutdown = async (): Promise<void> => {
  if (application === undefined) return;
  const current = application;
  const child = current.process();
  const exited = once(child, 'exit');
  void current.close().catch(() => undefined);
  try {
    await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 10_000 }).not.toBeNull();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(output).not.toMatch(/Uncaught Exception|uncaughtException|Object has been destroyed/iu);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    application = undefined;
  }
};
const navigate = async (name: string) => { await page.locator('nav').getByRole('button', { name, exact: true }).click(); };
const send = async (content: string): Promise<void> => {
  await page.getByRole('textbox').fill(content);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
};

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deskpet-daily-use-'));
  profile = join(root, 'profile');
  await mkdir(profile);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture HTTP port is unavailable.');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
test.afterAll(async () => {
  await shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

// eslint-disable-next-line no-empty-pattern -- Electron is launched directly; no browser fixture is needed.
test('uses the real desktop UI for provider setup, memory, streamed conversation, tools, tasks, focus and restart', async ({}, testInfo) => {
  await launch();
  expect((await page.evaluate(() => window.deskpet.app.getDiagnostics())).vault.state).toBe('ready');
  await navigate('Settings');
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.getByLabel('Provider type').selectOption('ollama');
  await page.locator('.provider-advanced > summary').click();
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue('http://127.0.0.1:11434/v1');
  await page.getByLabel('Name', { exact: true }).fill('Daily use fixture');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  const providerForm = page.getByRole('form', { name: 'Connect a provider' });
  await providerForm.locator('.manual-chat-model > summary').click();
  await providerForm.getByRole('textbox', { name: 'Model Model ID', exact: true }).fill('daily-use-fixture');
  await providerForm.getByRole('button', { name: 'Use this model', exact: true }).click();
  // Saved memories default to local-only, and this declaration is what lets them reach a local model.
  await providerForm.getByRole('checkbox', { name: 'This model runs on this device' }).check();
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  await expect(page.locator('.provider-list').getByText('Daily use fixture', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Connection succeeded');
  const provider = (await page.evaluate(() => window.deskpet.providers.list()))[0];
  expect(provider).toMatchObject({ kind: 'ollama', supportsTools: true });

  await navigate('Memory');
  await page.getByLabel('Text', { exact: true }).fill('I prefer jasmine tea.');
  await page.getByLabel('Tags, separated by commas', { exact: true }).fill('preference');
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  await expect(page.getByText('I prefer jasmine tea.', { exact: true })).toBeVisible();

  await navigate('Chat');
  await send('My audit name is Ada.');
  await expect(page.locator('.message.assistant').last()).toHaveText(/Hello Ada/u);
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'streaming');
  expect(finishStream).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath('chat-streaming.png') });
  finishStream?.();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await send('What name and tea preference did I give you?');
  await expect(page.locator('.message.assistant').last()).toContainText('You are Ada');
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'streaming');
  finishStream?.();
  await expect(page.locator('.message.assistant').last()).toContainText('you prefer jasmine tea.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await navigate('Settings');
  await page.getByRole('tab', { name: /permission/iu }).click();
  await page.locator('.permission-list article').filter({ hasText: 'time.read' }).getByRole('button', { name: 'Always allow', exact: true }).click();
  await navigate('Chat');
  await send('Use the current time tool.');
  await expect(page.locator('.message.assistant').last()).toContainText('The time tool completed.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await send('Stream until I stop.');
  await expect(page.locator('.message.assistant').last()).toContainText('Partial response');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => cancelledStreams).toBe(1);
  await send('Return a provider error.');
  await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'failed');
  await expect(page.getByRole('alert')).toContainText('model service is unavailable');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await send('Recover after failure.');
  await expect(page.locator('.message.assistant').last()).toContainText('Recovered.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);

  await navigate('Schedules'); await page.getByRole('tab', { name: 'Focus', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Daily use acceptance task');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Daily use acceptance task' });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.getByLabel('Duration in minutes', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(page.getByLabel('Time remaining', { exact: true })).not.toHaveText('01:00', { timeout: 5_000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await page.evaluate(() => window.deskpet.tasks.getFocus());
  await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
  expect(await page.evaluate(() => window.deskpet.tasks.getFocus())).toMatchObject({ status: 'paused', elapsedSeconds: paused?.elapsedSeconds });
  await expect(page.getByLabel('Time remaining', { exact: true })).toHaveText(`00:${(60 - (paused?.elapsedSeconds ?? 0)).toString().padStart(2, '0')}`);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.deskpet.tasks.getFocus())).toMatchObject({ status: 'running' });
  const beforeRestart = await page.evaluate(() => window.deskpet.tasks.getFocus());
  expect(beforeRestart?.status).toBe('running');
  await shutdown();
  await launch();
  expect((await page.evaluate(() => window.deskpet.tasks.list()))[0]?.status).toBe('done');
  expect((await page.evaluate(() => window.deskpet.memory.list()))[0]?.text).toBe('I prefer jasmine tea.');
  const sessions = await page.evaluate(() => window.deskpet.chat.listSessions());
  const history = await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessions[0]?.id as string);
  expect(history.some((message) => message.content === 'My audit name is Ada.')).toBe(true);
  expect(history.some((message) => message.status === 'cancelled' && message.content === 'Partial response')).toBe(true);
  await navigate('Schedules'); await page.getByRole('tab', { name: 'Focus', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.deskpet.tasks.getFocus()), { timeout: 75_000, intervals: [500] }).toMatchObject({ id: beforeRestart?.id, status: 'completed', elapsedSeconds: 60 });
  await expect(page.getByLabel('Time remaining', { exact: true })).toHaveText('00:00');
  await expect(page.getByText('Your focus session is complete.', { exact: true })).toBeVisible();
  const notifications = await application?.evaluate(() => (globalThis as typeof globalThis & { dailyUseNotifications: Array<{ title: string; body: string }> }).dailyUseNotifications);
  expect(notifications?.filter((item) => item.body === 'Your focus session is complete.')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('focus-completed.png') });
  const evidence = {
    provider: 'Loopback OpenAI-compatible fixture, no cloud API key',
    requestCount: requests.length, legalWireNames: requests[0]?.tools?.map((tool) => tool.function.name),
    multiTurnAndMemory: errors.length === 0, streamingBeforeCompletion: true,
    realToolRoundTrip: true, cancellation: true, providerFailureRecovery: true,
    taskCheckbox: 'done after restart', realFocusSeconds: 60, focusNotifications: notifications,
    persistedChatMessages: history.length,
  };
  await writeFile(testInfo.outputPath('usage-evidence.json'), JSON.stringify(evidence, null, 2));
  await testInfo.attach('daily use evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await shutdown();
});

// eslint-disable-next-line no-empty-pattern -- Electron is launched directly; no browser fixture is needed.
test('preserves the encrypted profile on a simulated vault-lock startup and recovers on the next real launch', async ({}, testInfo) => {
  const profileFile = join(profile, 'profile.enc.json');
  const original = await readFile(profileFile);
  const wrapper = join(root, 'locked-startup.cjs');
  await writeFile(wrapper, [
    "const { safeStorage, dialog } = require('electron');",
    "safeStorage.decryptString = () => { throw new Error('Synthetic temporary vault lock'); };",
    "dialog.showErrorBox = () => process.stdout.write('EXPECTED_TEMPORARY_VAULT_LOCK\\n');",
    `require(${JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main', 'index.js'))});`,
  ].join('\n'));
  const child = spawn(executablePath, [wrapper], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lockedOutput = '';
  child.stdout.on('data', (chunk: Buffer) => { lockedOutput = (lockedOutput + chunk.toString()).slice(-4_096); });
  child.stderr.on('data', () => undefined);
  try {
    await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 15_000 }).not.toBeNull();
    expect(lockedOutput).toContain('EXPECTED_TEMPORARY_VAULT_LOCK');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
  expect(await readFile(profileFile)).toEqual(original);
  expect((await readdir(profile)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  await launch();
  const task = (await page.evaluate(() => window.deskpet.tasks.list()))[0];
  expect(task).toMatchObject({ title: 'Daily use acceptance task', status: 'done' });
  expect((await page.evaluate(() => window.deskpet.memory.list()))[0]?.text).toBe('I prefer jasmine tea.');
  expect(await page.evaluate(() => window.deskpet.tasks.getFocus())).toMatchObject({ status: 'completed', elapsedSeconds: 60 });
  const notifications = await application?.evaluate(() => (globalThis as typeof globalThis & { dailyUseNotifications: unknown[] }).dailyUseNotifications);
  expect(notifications).toEqual([]);
  await testInfo.attach('vault recovery evidence', { body: JSON.stringify({ simulatedVaultLock: true, originalCiphertextUnchanged: true, quarantinedFiles: 0, taskRecovered: task?.status, duplicateFocusNotification: false }), contentType: 'application/json' });
});
