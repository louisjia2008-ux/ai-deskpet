import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';


test.setTimeout(240_000);
const terminal = (response: ServerResponse, text: string) => response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);

// eslint-disable-next-line no-empty-pattern
test('accepts provider switching, a 64-second reply, crash recovery and graceful shutdown', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-daily-recovery-')); const profile = join(root, 'profile');
  let application: ElectronApplication | undefined; let page: Page;
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  let interruptions = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'primary' }, { id: 'alternate' }] })); return; }
    const buffers: Buffer[] = [];
    request.on('data', (data: Buffer) => buffers.push(data));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
      const body = JSON.parse(Buffer.concat(buffers).toString()) as typeof requests[number]; requests.push(body);
      const prompt = body.messages.filter((message) => message.role === 'user').at(-1)?.content;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (prompt === 'A long reply') {
        response.write('data: {"choices":[{"delta":{"content":"Beginning"},"finish_reason":null}]}\n\n');
        const started = Date.now();
        const timer = setInterval(() => {
          if (Date.now() - started >= 64_000) { clearInterval(timer); terminal(response, ' Long reply finished.'); }
          else response.write('data: {"choices":[{"delta":{"content":" ·"},"finish_reason":null}]}\n\n');
        }, 2_000);
        response.once('close', () => clearInterval(timer));
      } else if (prompt === 'Interrupt this question' && interruptions++ === 0 || prompt === 'Graceful close') {
        response.write('data: {"choices":[{"delta":{"content":"Persist this partial answer"},"finish_reason":null}]}\n\n');
      } else terminal(response, `Reply from ${body.model}.`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('No fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const launch = async () => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    await application.evaluate(({ Notification }) => { Notification.prototype.show = () => undefined; });
  };
  const navigate = async (name: string) => { await page.locator('nav').getByRole('button', { name, exact: true }).click(); };
  const send = async (content: string) => { await page.getByRole('textbox', { name: 'Message your companion…' }).fill(content); await page.getByRole('button', { name: 'Send', exact: true }).click(); };
  try {
    await launch();
    const ids = await page!.evaluate(async (url) => {
      const first = crypto.randomUUID(); const second = crypto.randomUUID();
      for (const [id, name, model] of [[first, 'Primary fixture', 'primary'], [second, 'Alternate fixture', 'alternate']] as const) await window.deskpet.providers.upsert({ id, kind: 'ollama', name, baseUrl: url, model, enabled: true, supportsTools: false });
      return { first, second };
    }, baseUrl);
    await navigate('Chat');
    await page!.locator('.chat-model-picker > summary').click();
    await page!.getByRole('combobox', { name: 'Chat provider' }).selectOption(ids.second);
    await send('Switch provider');
    await expect(page!.locator('.chat-reply').last()).toHaveText('Reply from alternate.');
    expect(requests.at(-1)?.model).toBe('alternate');
    await navigate('Settings'); await page!.getByRole('tab', { name: 'Providers' }).click();
    const alternate = page!.getByRole('article', { name: 'Alternate fixture', exact: true });
    await alternate.getByRole('button', { name: 'Edit', exact: true }).click();
    await page!.locator('.provider-advanced > summary').click();
    await page!.getByRole('textbox', { name: 'Name', exact: true }).fill('Alternate edited');
    await page!.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page!.getByRole('article', { name: 'Alternate edited', exact: true })).toBeVisible();
    await page!.getByRole('checkbox', { name: 'Enabled Alternate edited', exact: true }).uncheck();
    await expect(page!.getByRole('checkbox', { name: 'Enabled Alternate edited', exact: true })).not.toBeChecked();
    await page!.getByRole('checkbox', { name: 'Enabled Alternate edited', exact: true }).check();
    await page!.getByRole('article', { name: 'Primary fixture', exact: true }).getByRole('button', { name: 'Use for chat' }).click();
    await expect.poll(() => page!.evaluate(() => window.deskpet.app.getState()).then((state) => state.activeProviderId)).toBe(ids.first);
    await navigate('Chat');
    await send('A long reply');
    await expect(page!.locator('.chat-reply').last()).toContainText('Long reply finished.', { timeout: 75_000 });
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await send('Interrupt this question');
    await expect(page!.locator('.chat-reply').last()).toContainText('Persist this partial answer');
    await expect.poll(async () => page!.evaluate(async () => {
      const session = (await window.deskpet.chat.listSessions())[0]!;
      return (await window.deskpet.chat.listMessages(session.id)).at(-1)?.content;
    })).toBe('Persist this partial answer');
    const killedChild = application!.process();
    killedChild.kill('SIGKILL');
    application = undefined;
    await expect.poll(() => killedChild.signalCode).toBe('SIGKILL');
    await launch(); await navigate('Chat');
    await expect(page!.getByText(/This reply was interrupted/)).toBeVisible();
    await expect(page!.locator('.chat-reply').last()).toContainText('Persist this partial answer');
    await expect(page!.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await page!.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    expect(requests.at(-1)?.messages.filter((message) => message.role === 'user').at(-1)?.content).toBe('Interrupt this question');
    const userCopies = await page!.evaluate(async () => {
      const session = (await window.deskpet.chat.listSessions())[0]!;
      return (await window.deskpet.chat.listMessages(session.id)).filter((message) => message.role === 'user' && message.content === 'Interrupt this question').length;
    }); expect(userCopies).toBe(1);
    await send('Graceful close');
    await expect(page!.locator('.chat-reply').last()).toContainText('Persist this partial answer');
    const child = application!.process(); await application!.evaluate(({ app }) => app.quit());
    await expect.poll(() => child.exitCode).toBe(0); application = undefined;
    await launch(); await navigate('Chat');
    await expect(page!.locator('.message.assistant').last()).toHaveAttribute('data-status', 'cancelled');
    await expect(page!.locator('.chat-reply').last()).toContainText('Persist this partial answer');
    await page!.locator('.chat-model-picker > summary').click();
    await expect(page!.getByRole('combobox', { name: 'Chat provider' })).toHaveValue(ids.second);
    expect((await page!.evaluate(() => window.deskpet.app.getState())).activeProviderId).toBe(ids.first);
    await page!.screenshot({ path: info.outputPath('daily-recovery-accepted.png') });
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

// eslint-disable-next-line no-empty-pattern
test('keeps corrupted profiles in recovery across launches, rejects a wrong backup password and restores backup and local snapshot', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-startup-recovery-')); const profile = join(root, 'profile'); const archive = join(root, 'test.deskpet-backup');
  let application: ElectronApplication | undefined; let page: Page;
  const launch = async (recovery = false) => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await application.evaluate(({ app, dialog }, paths) => {
      if (app.getPath('userData') !== paths.profile) throw new Error('Wrong profile');
      app.relaunch = () => undefined;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.archive });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.archive] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, { profile, archive });
    if (recovery) await expect(page.locator('.startup-recovery')).toBeVisible();
    else { await expect(page.locator('.app-shell')).toBeVisible(); await page.evaluate(() => window.deskpet.app.setLocale('en')); }
  };
  const quit = async () => { const child = application!.process(); await application!.evaluate(({ app }) => app.quit()); await expect.poll(() => child.exitCode).toBe(0); application = undefined; };
  const restart = async () => { const child = application!.process(); await page.getByRole('button', { name: /Restart and restore|重启并恢复/ }).click(); await expect.poll(() => child.exitCode).toBe(0); application = undefined; await launch(); };
  try {
    await launch();
    await page!.evaluate(async () => { await window.deskpet.relationship.setNickname('Recovery Kitty'); await window.deskpet.chat.createSession({ title: 'Keep this conversation', kind: 'normal' }); });
    await page!.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click(); await page!.getByRole('tab', { name: 'Privacy and data' }).click();
    await page!.getByLabel('Backup password', { exact: true }).fill('fixture-backup-password'); await page!.getByLabel('Confirm password for a new backup').fill('fixture-backup-password');
    await page!.getByRole('button', { name: 'Create encrypted backup' }).click(); await expect(page!.getByText('Encrypted backup saved', { exact: true })).toBeVisible();
    await quit();
    await writeFile(join(profile, 'profile.enc.json'), '{corrupt fixture');
    await launch(true);
    await expect(page!.locator('.app-shell')).toHaveCount(0);
    const files = await readdir(profile); const quarantine = files.find((name) => name.startsWith('profile.enc.json.corrupt-'))!; expect(quarantine).toBeTruthy();
    await quit(); await launch(true);
    expect(await readFile(join(profile, quarantine), 'utf8')).toBe('{corrupt fixture');
    const password = page!.getByLabel(/Backup password|备份密码/, { exact: true });
    await password.fill('wrong-fixture-password'); await page!.getByRole('button', { name: /Restore backup|恢复备份/, exact: true }).click();
    await expect(page!.getByRole('alert')).toBeVisible();
    await password.fill('fixture-backup-password'); await page!.getByRole('button', { name: /Restore backup|恢复备份/, exact: true }).click();
    await expect(page!.getByRole('button', { name: /Restart and restore|重启并恢复/ })).toBeVisible();
    await restart();
    expect((await page!.evaluate(() => window.deskpet.relationship.get())).nickname).toBe('Recovery Kitty');
    expect((await page!.evaluate(() => window.deskpet.chat.listSessions())).map((item) => item.title)).toContain('Keep this conversation');
    await quit();
    const id = randomUUID(); const previous = join(profile, 'recovery', id, 'previous'); await mkdir(previous, { recursive: true });
    await cp(join(profile, 'profile.enc.json'), join(previous, 'profile.enc.json')); await cp(join(profile, 'vault'), join(previous, 'vault'), { recursive: true });
    await writeFile(join(profile, 'profile.enc.json'), '{second corruption');
    await launch(true);
    const state = await page!.evaluate(() => window.deskpet.recovery.getState());
    const snapshot = state!.snapshots.find((item) => item.label.includes(id))!; expect(snapshot).toBeTruthy();
    await page!.getByRole('combobox').selectOption(snapshot.id); await page!.getByRole('button', { name: /Restore selected snapshot|恢复所选快照/ }).click();
    await expect(page!.getByRole('button', { name: /Restart and restore|重启并恢复/ })).toBeVisible();
    await restart();
    expect((await page!.evaluate(() => window.deskpet.relationship.get())).nickname).toBe('Recovery Kitty');
    await page!.screenshot({ path: info.outputPath('startup-recovery-accepted.png') });
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});
