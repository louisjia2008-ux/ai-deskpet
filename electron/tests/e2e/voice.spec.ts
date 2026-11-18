import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL_DIR = 'models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-bf16';

// Stands in for the Python worker: logs what it is asked, streams a short tone, and holds the
// reply open until it is cancelled, so a second message has something to cut off.
const fakeWorker = (log: string): string => `
const fs = require('node:fs');
const write = (line) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(line) + '\\n');
write({ args: process.argv.slice(2), cwd: process.cwd(), offline: process.env.HF_HUB_OFFLINE, home: process.env.HF_HOME });
const tone = Buffer.alloc(9600); for (let i = 0; i < 4800; i += 1) tone.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
const say = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
say({ ready: true });
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data; const lines = buffer.split('\\n'); buffer = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line); write(message);
    if (message.text) say({ id: message.id, pcm: tone.toString('base64'), rate: 24000 });
    if (message.cancel) say({ id: message.cancel, done: true });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// eslint-disable-next-line no-empty-pattern
test('her desktop replies are spoken by the local worker in the chosen folder, and a new message cuts off the last', async ({}) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'deskpet-voice-e2e-'));
  const profile = join(root, 'profile'), runtime = join(root, 'voice runtime'), log = join(root, 'worker.log');
  await mkdir(join(runtime, '.venv', 'bin'), { recursive: true });
  await mkdir(join(runtime, 'hf', 'hub', MODEL_DIR, 'snapshots'), { recursive: true });
  await mkdir(join(runtime, 'voice'));
  await writeFile(join(runtime, 'voice', 'reference.wav'), 'RIFF');
  await writeFile(join(runtime, 'voice', 'reference.txt'), '你好');
  await writeFile(join(root, 'worker.cjs'), fakeWorker(log));
  await writeFile(join(runtime, '.venv', 'bin', 'python'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'worker.cjs'))} "$@"\n`);
  await chmod(join(runtime, '.venv', 'bin', 'python'), 0o755);
  let reply = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: {} } : { data: [{ id: 'fixture' }] })); return; }
      reply += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply === 1 ? '哥哥，**第一句**回复！`code`' : '第二句回复。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    const page: Page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, runtime);
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      const id = crypto.randomUUID();
      await window.deskpet.providers.upsert({ id, kind: 'ollama', name: 'Voice fixture', baseUrl, model: 'fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 16384 });
      await window.deskpet.providers.select(id);
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '陪伴', exact: true }).click();
    await page.getByRole('tab', { name: '声音', exact: true }).click();
    // The switch follows the saved setting, so it flips once the host has stored it.
    await page.getByRole('checkbox', { name: '朗读她的回复' }).click();
    await expect(page.getByRole('checkbox', { name: '朗读她的回复' })).toBeChecked();
    await expect(page.getByText('请选择语音文件夹。')).toBeVisible();
    await page.getByRole('button', { name: '选择文件夹' }).click();
    await expect(page.getByText('准备好了，下次回复时加载模型。')).toBeVisible();
    await page.locator('.page-scroll').screenshot({ path: test.info().outputPath('voice-settings.png') });

    await page.locator('nav').getByRole('button', { name: '聊天', exact: true }).click();
    const composer = page.locator('.composer textarea');
    await composer.fill('你好'); await composer.press('Enter');
    await expect(page.locator('.chat-reply').last()).toContainText('第一句');
    await expect.poll(async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length).toBe(2);
    await composer.fill('再说一句'); await composer.press('Enter');
    await expect(page.locator('.chat-reply').last()).toContainText('第二句回复。');
    await expect.poll(async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length).toBe(4);
    const [start, first, cancel, second] = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, string | string[]>);
    expect(start).toMatchObject({ cwd: await realpath(runtime), offline: '1', home: join(runtime, 'hf') });
    expect(start!.args).toEqual(['-I', '-B', expect.stringMatching(/voice-runtime\/tts_worker\.py$/u), 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16']);
    // Markdown and code are not read aloud.
    expect(first).toMatchObject({ text: '哥哥，第一句回复！' });
    expect(cancel).toEqual({ cancel: first!.id });
    expect(second).toMatchObject({ text: '第二句回复。' });
  } finally { await application?.close(); server.close(); await rm(root, { recursive: true, force: true }); }
});
