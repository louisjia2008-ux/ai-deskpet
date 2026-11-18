import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

test.setTimeout(90_000);
interface RequestBody { messages: Array<{ role: string; content: string; tool_call_id?: string }>; tools?: Array<{ function: { name: string; description: string } }> }

// eslint-disable-next-line no-empty-pattern
test('detects premature stream endings, retries safely, and restores chat-created timers after offline expiry', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-p2-recovery-')); const profile = join(root, 'profile');
  const notifications = join(root, 'notifications.jsonl'); const wrapper = join(root, 'entry.cjs');
  await writeFile(notifications, '');
  await writeFile(wrapper, `const { Notification } = require('electron');\nconst fs = require('node:fs');\nNotification.prototype.show = function () { fs.appendFileSync(${JSON.stringify(notifications)}, JSON.stringify({title:this.title,body:this.body})+'\\n'); };\nrequire(${JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js'))});`);
  let application: ElectronApplication | undefined; let page!: Page; let retried = false;
  const requests: RequestBody[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: {} } : { data: [{ id: 'fixture' }] })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; requests.push(body);
      const prompt = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
      if (prompt === 'Premature reply' && !retried) { retried = true; emit({ content: 'Retain this partial reply' }); response.end(); return; }
      if (prompt === 'Truncated reply') { emit({ content: 'Token limited partial reply' }, 'length'); response.end('data: [DONE]\n\n'); return; }
      if (prompt.startsWith('Timer') || prompt === 'Premature tool') {
        const result = body.messages.find((message) => message.role === 'tool');
        if (!result) {
          const name = body.tools?.find((tool) => tool.function.description.startsWith('Create timer.'))?.function.name;
          emit({ tool_calls: [{ index: 0, id: `fixture_${prompt.replaceAll(' ', '_')}`, function: { name, arguments: JSON.stringify({ seconds: prompt === 'Timer cancel' ? 300 : 5, label: prompt }) } }] });
          if (prompt === 'Premature tool') { response.end(); return; }
          emit({}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
        }
        emit({ content: `Timer saved: ${result.content}` }, 'stop');
      } else emit({ content: 'Complete response after retry' }, 'stop');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const launch = async () => {
    application = await electron.launch({ args: [wrapper], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
  };
  const send = async (content: string) => {
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    await page.locator('#main-content').getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.locator('.composer textarea').fill(content); await page.locator('.composer textarea').press('Enter');
  };
  try {
    await launch();
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'P2 fixture', model: 'fixture', baseUrl, enabled: true, supportsTools: true });
      await window.deskpet.permissions.request({ capabilityId: 'timer.write', duration: 'session' });
    }, `http://127.0.0.1:${address.port}/v1`);
    await send('Premature reply');
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'failed');
    await expect(page.getByRole('alert')).toContainText('connection ended before');
    await expect(page.locator('.message.assistant')).toContainText('Retain this partial reply');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant')).toContainText('Complete response after retry');
    await expect(page.locator('.message.user')).toHaveCount(1);
    expect(requests[1]?.messages.at(-1)?.content).toBe('Premature reply');
    await send('Truncated reply'); await expect(page.getByRole('alert')).toContainText('model stopped before finishing');
    await send('Premature tool'); await expect(page.getByRole('alert')).toContainText('connection ended before');
    expect(await page.evaluate(() => window.deskpet.timers.list())).toEqual([]);
    await send('Timer cancel'); await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    await page.locator('nav').getByRole('button', { name: 'Schedules', exact: true }).click();
    const cancelRow = page.getByRole('listitem', { name: 'Timer cancel', exact: true });
    await cancelRow.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(cancelRow).toContainText('Cancelled');
    await send('Timer offline'); await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'complete');
    const saved = (await page.evaluate(() => window.deskpet.timers.list())).find((item) => item.label === 'Timer offline')!;
    expect(saved.status).toBe('pending');
    await application!.close(); application = undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Date.parse(saved.dueAt) - Date.now() + 500)));
    await launch();
    await expect.poll(() => page.evaluate(() => window.deskpet.timers.list())).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved.id, dueAt: saved.dueAt, status: 'completed' })]));
    const delivered = (await readFile(notifications, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { title: string });
    expect(delivered.map((entry) => entry.title)).toEqual(['Timer offline']);
    await page.locator('nav').getByRole('button', { name: 'Schedules', exact: true }).click();
    await expect(page.getByRole('listitem', { name: 'Timer offline', exact: true })).toContainText('Completed');
    await page.screenshot({ path: info.outputPath('restored-timer.png') });
    await application!.close(); application = undefined; await launch();
    expect((await readFile(notifications, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await page.evaluate(() => window.deskpet.timers.list())).find((item) => item.label === 'Timer cancel')?.status).toBe('cancelled');
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ prematureReplyRetained: true, retryOriginalQuestion: true, truncatedResponseFailed: true, incompleteToolNotExecuted: true, absoluteDeadline: saved.dueAt, overdueNotificationCount: delivered.length, noDuplicateAfterSecondRestart: true }, null, 2));
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

// eslint-disable-next-line no-empty-pattern
test('restores real Kitty after a valid ZIP contains unloadable model data and survives restart', async ({}, info) => {
  const core = process.env.DESKPET_LIVE2D_CORE; const model = process.env.DESKPET_LIVE2D_MODEL;
  test.skip(!core || !model, 'User-owned local Kitty and Core assets required.');
  const root = await mkdtemp(join(tmpdir(), 'deskpet-model-fallback-')); const profile = join(root, 'profile');
  const badZip = join(root, 'broken-kitty.zip');
  const zip = await JSZip.loadAsync(await readFile(model!));
  for (const name of Object.keys(zip.files)) if (name.endsWith('.moc3')) zip.file(name, Buffer.alloc(32));
  await writeFile(badZip, await zip.generateAsync({ type: 'nodebuffer' }));
  let application: ElectronApplication | undefined; let page!: Page; let overlay!: Page;
  const launch = async () => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/overlay_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!; overlay = application.windows().find((window) => window.url().includes('/overlay_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }); await page.evaluate(() => window.deskpet.app.setLocale('en'));
  };
  try {
    await launch();
    await application!.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()!] }); }, [core!, model!, badZip]);
    await page.evaluate(async () => { await window.deskpet.character.importCore(); await window.deskpet.character.importModel(); });
    await expect(overlay.locator('main')).toHaveAttribute('data-load-state', 'ready');
    await page.evaluate(async () => { await window.deskpet.character.setExpression('Watermark'); await window.deskpet.character.setScale(0.7); });
    const previous = await page.evaluate(() => window.deskpet.character.getState());
    await page.locator('nav').getByRole('button', { name: 'Companion', exact: true }).click();
    await page.getByRole('button', { name: 'Change model', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('previous model and its settings have been restored', { timeout: 40_000 });
    await expect(overlay.locator('main')).toHaveAttribute('data-load-state', 'ready');
    expect(await page.evaluate(() => window.deskpet.character.getState())).toMatchObject({ modelUrl: previous.modelUrl, scale: 0.7, expression: 'Watermark', pendingImportId: null });
    expect(await readdir(join(profile, 'managed/models/.staging'))).toEqual([]);
    // Wait for the restored expression fade and a rendered preview, not just
    // the model-loaded callback (which precedes the first visible frame).
    await overlay.waitForTimeout(1_600);
    await expect(page.locator('.companion-preview-card > .character-stage')).toHaveAttribute('data-preview-state', 'live');
    await expect.poll(async () => page.evaluate(async () => {
      const frame = await window.deskpet.character.getPreview(); if (frame === null) return 0;
      const image = new window.Image(); image.src = frame; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 32) opaque += 1;
      return opaque;
    })).toBeGreaterThan(10_000);
    await page.screenshot({ path: info.outputPath('kitty-rollback.png') });
    await application!.close(); application = undefined; await launch();
    await expect(overlay.locator('main')).toHaveAttribute('data-load-state', 'ready');
    expect(await page.evaluate(() => window.deskpet.character.getState())).toMatchObject({ modelUrl: previous.modelUrl, scale: 0.7, expression: 'Watermark' });
    await overlay.waitForTimeout(1_600);
    await overlay.screenshot({ path: info.outputPath('kitty-restored-after-restart.png'), omitBackground: true });
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});
