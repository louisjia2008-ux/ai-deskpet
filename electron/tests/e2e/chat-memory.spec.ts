import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface ModelRequest { messages: Array<{ role: string; content: string }> }

// Real renderer/IPC/encrypted disk state; the local model fixture records exactly
// which memories reach new conversations. Installed Qwen is checked separately.
// eslint-disable-next-line no-empty-pattern
test('saves explicit chat memory, deduplicates, recalls after restart and respects removal', async ({}, info) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-chat-memory-e2e-'));
  const requests: ModelRequest[] = [];
  const memoryText = '我的验收暗号是银杏月舟-6832。';
  const question = '我保存的验收暗号是什么？';
  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest; if (isRecentSummary(body)) { answerRecentSummary(response); return; } requests.push(body);
      const saved = body.messages.some((message) => message.role === 'system' && message.content.includes(memoryText));
      const content = body.messages.at(-1)?.content.includes('翻译') ? '这是引用的句子，不会保存。' : saved ? '已保存的验收暗号是银杏月舟-6832。' : '没有';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    });
  });
  let application: ElectronApplication | undefined; let page!: Page;
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    // The native permission prompt would otherwise wait for a person.
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  };
  const stop = async (): Promise<void> => { await application!.close(); application = undefined; };
  const newChat = async (): Promise<void> => { await page.locator('nav').getByRole('button', { name: '新建对话', exact: true }).click(); };
  const send = async (text: string): Promise<void> => {
    const count = await page.locator('.message.assistant').count();
    await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(count + 1);
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await launch();
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Memory acceptance', model: 'fixture', baseUrl, enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512 });
      await window.deskpet.permissions.request({ capabilityId: 'web.read', duration: 'always' });
    }, `http://127.0.0.1:${address.port}/v1`);
    await newChat(); await send('你好'); expect(requests).toHaveLength(1);
    await send(`请记住：${memoryText}`);
    await expect(page.locator('.memory-receipt')).toContainText(memoryText);
    expect(requests).toHaveLength(1); // The app persisted it; no model can invent this receipt.
    const firstMemory = (await page.evaluate(() => window.deskpet.memory.list()))[0]!;
    const saveSessionId = await page.locator('.session-control select').inputValue();
    expect(firstMemory.text).toBe(memoryText);
    await page.screenshot({ path: info.outputPath('chat-memory-saved.png') });
    await page.locator('.memory-receipt').getByRole('button', { name: '查看记忆' }).click();
    await expect(page.locator('.memory-card')).toContainText(memoryText);
    await page.locator(`[data-session-id="${saveSessionId}"] .session-item`).click();
    await send(`请记住：${memoryText}`);
    await expect(page.locator('.memory-receipt').last()).toContainText('这条长期记忆已存在');
    expect(await page.evaluate(() => window.deskpet.memory.list())).toHaveLength(1);
    await newChat(); await send(question);
    await expect(page.locator('.message.assistant').last()).toContainText('银杏月舟-6832');
    expect(requests.at(-1)?.messages.filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: question }]);
    await stop();

    await launch(); await newChat(); await send(question);
    await expect(page.locator('.message.assistant').last()).toContainText('银杏月舟-6832');
    expect((await page.evaluate(() => window.deskpet.memory.list()))[0]?.id).toBe(firstMemory.id);
    expect(requests.at(-1)?.messages.filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: question }]);
    const originalMessages = await page.evaluate((id) => window.deskpet.chat.listMessages(id), saveSessionId);
    expect(originalMessages.filter((message) => message.memoryReceipts?.[0]?.memoryId === firstMemory.id)).toHaveLength(2);
    await newChat(); await send('请翻译“请记住：假的暗号是错误内容”。');
    expect(await page.evaluate(() => window.deskpet.memory.list())).toHaveLength(1);
    await expect(page.locator('.memory-receipt')).toHaveCount(0);
    await newChat(); await send('请记住刚才的话');
    await expect(page.locator('.message.assistant').last()).toContainText('这次尚未保存记忆');
    await expect(page.locator('.memory-receipt')).toHaveCount(0);
    await page.locator('nav').getByRole('button', { name: '记忆', exact: true }).click();
    await page.locator('.memory-card').getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.memory-card').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.locator('.memory-card')).toHaveCount(0);
    await stop();

    await launch(); await newChat(); await send(question);
    await expect(page.locator('.message.assistant').last()).toContainText('没有');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('银杏月舟');
    expect(await page.evaluate(() => window.deskpet.memory.list())).toHaveLength(0);
    expect((await page.evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'web.read')?.state).toBe('always');
    await page.screenshot({ path: info.outputPath('chat-memory-removed-after-restart.png') });
    await writeFile(info.outputPath('chat-memory-evidence.json'), JSON.stringify({ profileLaunches: 3, requests, memory: firstMemory, originalMessages, explicitSaveWithoutModelCall: true, duplicateSuppressed: true, recalledAfterRestart: true, removedAfterRestart: true, permissionRetained: true }, null, 2));
  } finally {
    await application?.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
