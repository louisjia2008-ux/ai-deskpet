import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ModelRequest { messages: Array<{ role: string; content: string }> }

// eslint-disable-next-line no-empty-pattern
test('forgets from chat, preserves unrelated memories and choices across restart, and never recalls deleted memory in fresh chats', async ({}, info) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-chat-forget-e2e-'));
  const requests: ModelRequest[] = [];
  const secret = '我的验收暗号是青柠山川-5914。'; const retained = '我喜欢中文交流。';
  const question = '我已保存的验收暗号是什么？';
  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest; requests.push(body);
      const content = body.messages.some((message) => message.role === 'system' && message.content.includes(secret)) ? '青柠山川-5914' : '没有';
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
  const memories = () => page.evaluate(() => window.deskpet.memory.list());
  const assertForgotten = async (): Promise<void> => {
    await newChat(); await send(question);
    await expect(page.locator('.chat-reply').last()).toHaveText('没有');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('青柠山川');
    expect(requests.at(-1)?.messages.filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: question }]);
    expect((await memories()).map((item) => item.text)).toContain(retained);
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await launch();
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Forget acceptance', model: 'fixture', baseUrl, enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512 });
      await window.deskpet.permissions.request({ capabilityId: 'web.read', duration: 'always' });
    }, `http://127.0.0.1:${address.port}/v1`);
    await newChat(); await send(`请记住：${secret}`); await send(`请记住：${retained}`);
    expect(requests).toHaveLength(0); const beforeDelete = await memories();
    await newChat(); await send(question); await expect(page.locator('.chat-reply').last()).toHaveText('青柠山川-5914');
    await newChat(); const requestCount = requests.length; await send('请忘记我的验收暗号');
    await expect(page.locator('.memory-forget')).toContainText('已删除长期记忆');
    await expect(page.locator('.memory-forget')).toContainText(secret);
    expect(requests).toHaveLength(requestCount); expect((await memories()).map((item) => item.text)).toEqual([retained]);
    const deleteSessionId = await page.locator('.session-control select').inputValue();
    await page.screenshot({ path: info.outputPath('chat-memory-forgotten.png') });
    await assertForgotten();

    await newChat(); await send('请记住：我的测试饮品甲是绿茶。'); await send('请记住：我的测试饮品乙是咖啡。');
    await newChat(); await send('忘记我的测试饮品');
    await expect(page.locator('.memory-forget-choices li')).toHaveCount(2); expect(await memories()).toHaveLength(3);
    const choiceSessionId = await page.locator('.session-control select').inputValue();
    await page.screenshot({ path: info.outputPath('chat-memory-forget-choices.png') });
    await stop();

    await launch(); await assertForgotten();
    await page.locator(`[data-session-id="${choiceSessionId}"] .session-item`).click();
    await expect(page.locator('.memory-forget-choices li')).toHaveCount(2);
    await page.getByRole('listitem', { name: '我的测试饮品乙是咖啡。', exact: true }).getByRole('button', { name: '删除这条记忆' }).click();
    await expect(page.locator('.memory-forget')).toContainText('已删除长期记忆');
    expect((await memories()).map((item) => item.text)).toEqual([retained, '我的测试饮品甲是绿茶。']);
    await newChat(); await send('忘记不存在的记忆内容');
    await expect(page.locator('.chat-reply').last()).toContainText('没有找到匹配');
    // A bare 「忘记X」 that names no memory, or a report of forgetting, is ordinary chat.
    for (const chat of ['忘记带伞，淋成落汤鸡', '忘记带伞了']) {
      await send(chat); await expect(page.locator('.chat-reply').last()).toHaveText('没有');
      expect(requests.some((body) => body.messages.some((message) => message.role === 'user' && message.content === chat))).toBe(true);
    }
    await send('忘记全部'); await expect(page.locator('.chat-reply').last()).toContainText('这次尚未删除记忆');
    expect(await memories()).toHaveLength(2);
    await newChat(); await send('请翻译“忘记我喜欢中文交流”'); expect(await memories()).toHaveLength(2);
    await stop();

    await launch(); await assertForgotten();
    const savedDelete = await page.evaluate((id) => window.deskpet.chat.listMessages(id), deleteSessionId);
    expect(savedDelete.find((item) => item.role === 'assistant')?.memoryForget).toMatchObject({ kind: 'deleted', text: secret });
    const savedSelection = await page.evaluate((id) => window.deskpet.chat.listMessages(id), choiceSessionId);
    expect(savedSelection.find((item) => item.role === 'assistant')?.memoryForget).toMatchObject({ kind: 'deleted', text: '我的测试饮品乙是咖啡。' });
    expect((await page.evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'web.read')?.state).toBe('always');
    await page.screenshot({ path: info.outputPath('chat-memory-forget-after-restart.png') });
    await writeFile(info.outputPath('chat-memory-forget-evidence.json'), JSON.stringify({ profileLaunches: 3, requests, beforeDelete, remainingMemories: await memories(), savedDelete, savedSelection, deletionWithoutModelCall: true, noRecallAcrossNewChatsAndRestart: true, permissionRetained: true }, null, 2));
  } finally {
    await application?.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
