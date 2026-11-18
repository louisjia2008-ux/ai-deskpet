import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RequestBody { messages: Array<{ role: string; content: string }> }

// A disposable profile verifies the real renderer, IPC, encryption and restarts.
// The fixture records model input; live Qwen recall is checked separately in the installed app.
// eslint-disable-next-line no-empty-pattern
test('manages conversations and verifies memory isolation across three process launches', async ({}, info) => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-conversation-memory-'));
  const requests: RequestBody[] = [];
  const snapshots: unknown[] = [];
  const memoryText = '【临时测试】记忆验收暗号：薄荷星舟-7249';
  const question = '记忆功能验收：保存的验收暗号是什么？';
  const renamed = '记忆与会话验收';
  let heldConnectionClosed = false;
  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
      requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      if (body.messages.at(-1)?.content === 'Wait for cancellation') {
        response.once('close', () => { heldConnectionClosed = true; }); return;
      }
      const saved = body.messages.some((message) => message.role === 'system' && message.content.includes(memoryText));
      const content = saved ? '已保存的记忆是：薄荷星舟-7249。' : '当前没有保存这个验收暗号。';
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    });
  });
  let application: ElectronApplication | undefined;
  let page!: Page;
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  };
  const stop = async (): Promise<void> => { await application!.close(); application = undefined; };
  const nav = (name: string) => page.locator('nav').getByRole('button', { name, exact: true });
  const manage = async (): Promise<void> => { await nav('管理对话').click(); await expect(page.getByRole('heading', { name: '管理对话' })).toBeVisible(); };
  const headerAction = async (name: string): Promise<void> => {
    await page.locator('.chat-header .conversation-menu-trigger').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  const send = async (content: string): Promise<void> => {
    await page.locator('.composer textarea').fill(content);
    await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port is unavailable.');
    await launch();
    const seeded = await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Conversation acceptance', model: 'fixture', baseUrl, enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512 });
      await window.deskpet.permissions.request({ capabilityId: 'web.read', duration: 'always' });
      const untouched = await window.deskpet.chat.createSession({ title: '保留的另一段对话', kind: 'normal' });
      const archived = await window.deskpet.chat.createSession({ title: '归档阅读测试', kind: 'normal' });
      await window.deskpet.chat.setArchived(archived.id, true);
      return { untouched, archived };
    }, `http://127.0.0.1:${address.port}/v1`);
    await nav('记忆').click();
    await page.getByRole('textbox', { name: '内容', exact: true }).fill(memoryText);
    await page.getByRole('textbox', { name: '标签（用逗号分隔）' }).fill('功能测试');
    await page.getByRole('button', { name: '添加记忆' }).click();
    await expect(page.locator('.memory-card')).toContainText(memoryText);
    await page.locator('nav').getByRole('button', { name: '新建对话', exact: true }).click();
    await send(question);
    await expect(page.locator('.message.assistant').last()).toContainText('薄荷星舟-7249');
    expect(requests[0]?.messages.filter((message) => message.role === 'user')).toEqual([{ role: 'user', content: question }]);
    expect(requests[0]?.messages.some((message) => message.role === 'system' && message.content.includes(memoryText))).toBe(true);
    await headerAction('重命名对话');
    await page.getByRole('dialog').getByRole('textbox', { name: '标题' }).fill(renamed);
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.chat-header h1')).toHaveText(renamed);
    await headerAction('置顶对话');
    const conversation = await page.evaluate(async (title) => (await window.deskpet.chat.listSessions()).find((item) => item.title === title)!, renamed);
    await expect.poll(async () => (await page.evaluate(() => window.deskpet.chat.listSessions()))[0]?.id).toBe(conversation.id);
    await expect(page.locator(`[data-session-id="${conversation.id}"]`)).toBeVisible();
    await page.screenshot({ path: info.outputPath('conversation-pinned.png') });
    snapshots.push({ stage: 'renamed-and-pinned', sessions: await page.evaluate(() => window.deskpet.chat.listSessions({ scope: 'all' })) });
    await stop();

    await launch();
    const reloaded = await page.evaluate(() => window.deskpet.chat.listSessions());
    expect(reloaded[0]).toMatchObject({ id: conversation.id, title: renamed });
    expect(reloaded[0]?.pinnedAt).toBeTruthy();
    expect((await page.evaluate(() => window.deskpet.memory.list()))[0]?.text).toBe(memoryText);
    expect((await page.evaluate(() => window.deskpet.chat.listSessions({ scope: 'archived' })))[0]?.id).toBe(seeded.archived.id);
    await manage();
    await page.getByRole('searchbox').fill('薄荷星舟');
    await expect(page.getByRole('tabpanel').getByRole('listitem', { name: renamed, exact: true }).locator('.conversation-open')).toBeVisible();
    await expect(page.getByRole('tabpanel')).not.toContainText(seeded.untouched.title);
    await page.getByRole('searchbox').fill('');
    await page.getByRole('tab', { name: '已归档', exact: true }).click();
    await page.getByRole('tabpanel').getByRole('button', { name: seeded.archived.title, exact: true }).click();
    await expect(page.locator('.composer textarea')).toBeDisabled();
    await page.locator('.archived-conversation-note').getByRole('button', { name: '取消归档' }).click();
    await expect(page.locator('.composer textarea')).toBeEnabled();
    await page.locator(`[data-session-id="${conversation.id}"] .session-item`).click();
    await expect(page.locator('.message.assistant')).toContainText('薄荷星舟-7249');
    await headerAction('删除');
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.chat-header h1')).toHaveText(renamed);
    await headerAction('删除');
    await page.screenshot({ path: info.outputPath('delete-confirmation.png') });
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.locator('.chat-header h1')).toHaveText('新对话');
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(page.locator(`[data-session-id="${conversation.id}"]`)).toHaveCount(0);
    expect(await page.evaluate(async (id) => { try { await window.deskpet.chat.listMessages(id); return 'visible'; } catch { return 'hidden'; } }, conversation.id)).toBe('hidden');
    expect((await page.evaluate(() => window.deskpet.memory.list()))[0]?.text).toBe(memoryText);
    expect((await page.evaluate(() => window.deskpet.chat.listSessions())).some((item) => item.id === seeded.untouched.id)).toBe(true);
    await manage(); await page.getByRole('tab', { name: '最近删除', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText(renamed);
    await page.screenshot({ path: info.outputPath('recently-deleted.png') });
    await stop();

    await launch(); await manage();
    await page.getByRole('searchbox').fill('薄荷星舟');
    await expect(page.getByRole('tabpanel')).toContainText('没有找到符合条件的对话');
    await page.getByRole('searchbox').fill('');
    await page.getByRole('tab', { name: '最近删除', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText(renamed);
    await page.getByRole('tabpanel').getByRole('button', { name: '恢复对话', exact: true }).click();
    await expect(page.getByRole('tabpanel')).not.toContainText(renamed);
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await page.getByRole('tabpanel').getByRole('button', { name: renamed, exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('薄荷星舟-7249');
    snapshots.push({ stage: 'restored-after-restart', sessions: await page.evaluate(() => window.deskpet.chat.listSessions({ scope: 'all' })), messages: await page.evaluate((id) => window.deskpet.chat.listMessages(id), conversation.id) });

    await nav('记忆').click();
    await page.locator('.memory-card').getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.locator('.memory-card')).toHaveCount(0);
    await page.locator('nav').getByRole('button', { name: '新建对话', exact: true }).click();
    await send(question);
    await expect(page.locator('.message.assistant')).toContainText('当前没有保存这个验收暗号');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('薄荷星舟');
    expect(requests.at(-1)?.messages.filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: question }]);

    await page.locator('.composer textarea').fill('Wait for cancellation');
    await page.locator('.composer textarea').press('Enter');
    await expect.poll(() => requests.at(-1)?.messages.at(-1)?.content).toBe('Wait for cancellation');
    await expect(page.locator('.chat-header .conversation-menu-trigger')).toBeDisabled();
    const currentId = await page.locator('.session-control select').inputValue();
    expect(await page.evaluate(async (id) => { try { await window.deskpet.chat.removeSession(id); return 'unexpected deletion'; } catch (error) { return String(error); } }, currentId)).toContain('chat.sessionBusy');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'cancelled');
    await expect.poll(() => heldConnectionClosed).toBe(true);
    await send('Continue after cancellation');
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    expect((await page.evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'web.read')?.state).toBe('always');
    await manage();
    await application!.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/main_window/')); main?.setSize(860, 720); });
    await expect(page.getByRole('searchbox')).toBeVisible();
    await expect(nav('管理对话')).toBeVisible();
    await page.screenshot({ path: info.outputPath('conversation-manager-narrow.png') });
    await writeFile(info.outputPath('conversation-memory-evidence.json'), JSON.stringify({ profileLaunches: 3, requests, snapshots, permissionsPreserved: true, deletedRestored: true, removedMemoryExcludedFromFreshChat: true, busyConversationProtected: true }, null, 2));
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
