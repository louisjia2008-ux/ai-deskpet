import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';

interface Request { messages: Array<{ role: string; content: string }>; tools?: unknown[] }
const harness = async (reply: (request: Request) => string) => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-edit-import-e2e-')); const requests: Request[] = [];
  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request; if (isRecentSummary(data)) { answerRecentSummary(response); return; } requests.push(data);
      const content = reply(data); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  let application: ElectronApplication | undefined; let page: Page; let launches = 0;
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } }); launches++;
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  };
  const stop = async (): Promise<void> => { await application?.close(); application = undefined; };
  const newChat = async (): Promise<void> => { await page.locator('nav').getByRole('button', { name: '新建对话', exact: true }).click(); };
  const send = async (text: string): Promise<void> => {
    const count = await page.locator('.message.assistant').count(); await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(count + 1); await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
  };
  const configure = async (): Promise<void> => {
    await page.evaluate(async (baseUrl) => { await window.deskpet.app.setLocale('zh-CN'); await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Memory acceptance model', baseUrl, model: 'fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512 }); await window.deskpet.permissions.request({ capabilityId: 'web.read', duration: 'always' }); }, `http://127.0.0.1:${address.port}/v1`);
  };
  const report = async (info: TestInfo, data: unknown): Promise<void> => { await writeFile(info.outputPath('evidence.json'), JSON.stringify({ launches, requests, data }, null, 2)); };
  const clean = async (): Promise<void> => { await stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); };
  return { launch, stop, newChat, send, configure, clean, report, requests, profile, page: () => page, application: () => application!, memories: () => page.evaluate(() => window.deskpet.memory.list()) };
};

// eslint-disable-next-line no-empty-pattern
test('edits one selected memory and uses only its new content across fresh chats and two restarts', async ({}, info) => {
  test.setTimeout(120_000);
  const a = '验收地点甲是青柠岛-2176'; const b = '验收地点乙是银杏港-6842'; const next = '验收地点乙是枫叶湾-5038'; const other = '验收饮品是桃子茶-9053';
  const h = await harness((request) => {
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    return [a, system.includes(next) ? next : b, other].filter((text) => system.includes(text)).join('；');
  });
  const recall = async (): Promise<void> => {
    await h.newChat(); await h.send('我已保存的两个地点和饮品分别是什么？');
    await expect(h.page().locator('.chat-reply').last()).toHaveText([a, next, other].join('；'));
    expect(JSON.stringify(h.requests.at(-1))).not.toContain('银杏港-6842'); expect(h.requests.at(-1)?.messages.filter((message) => message.role !== 'system')).toHaveLength(1);
  };
  try {
    await h.launch(); await h.configure(); await h.newChat();
    for (const fact of [a, b, other]) await h.send(`请记住：${fact}`);
    const before = await h.memories(); await h.newChat(); await h.send(`把“验收地点”改成“${next}”`);
    await expect(h.page().locator('.memory-edit .memory-forget-choices li')).toHaveCount(2); expect(await h.memories()).toEqual(before); expect(h.requests).toHaveLength(0);
    const session = await h.page().locator('.session-control select').inputValue(); await h.page().screenshot({ path: info.outputPath('edit-choices.png') });
    await h.stop(); await h.launch(); await h.page().locator(`[data-session-id="${session}"] .session-item`).click();
    await h.page().getByRole('listitem', { name: b, exact: true }).getByRole('button', { name: '修改这条记忆' }).click();
    await expect(h.page().locator('.memory-edit')).toContainText('已修改长期记忆');
    const after = await h.memories(); expect(after).toHaveLength(3); expect(after[0]).toEqual(before[0]); expect(after[2]).toEqual(before[2]); expect(after[1]).toMatchObject({ id: before[1]!.id, text: next });
    await recall(); await h.page().screenshot({ path: info.outputPath('edit-recall.png') }); await h.stop(); await h.launch(); await recall();
    await h.newChat(); const calls = h.requests.length; await h.send(`把“${other}”改成“验收饮品是桂花茶-8081”`); expect(h.requests).toHaveLength(calls);
    await expect(h.page().locator('.memory-edit')).toContainText('桂花茶-8081');
    const final = await h.memories(); await h.send('把“没有这条记忆”改成“不能新增”'); expect(await h.memories()).toEqual(final);
    expect((await h.page().evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'web.read')?.state).toBe('always');
    await h.report(info, { before, after, final, choicesPersistedAcrossRestart: true, freshRecallAfterRestart: true });
  } finally { await h.clean(); }
});

// eslint-disable-next-line no-empty-pattern
test('previews WeChat imports, distills selected samples, applies only checked facts and voice and preserves them after restart', async ({}, info) => {
  test.setTimeout(120_000);
  const h = await harness((request) => {
    if (request.messages[0]?.content.startsWith('Analyze chat samples')) {
      const source = JSON.parse(request.messages[1]!.content) as { samples: Array<{ id: string; text: string }> };
      return JSON.stringify({ style: { tone: 'warm', length: 'brief', sentences: 'short', emoji: 'light', phrases: ['好呀'] }, memories: [
        { text: '导入验收饮品是梅子茶-6729', evidenceIds: [source.samples[0]!.id] }, { text: '喜欢短句', evidenceIds: [source.samples[2]!.id] },
      ] });
    }
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    return `${system.includes('Style settings:') ? '好呀，' : ''}${system.includes('梅子茶-6729') ? '梅子茶-6729' : '没有'}。`;
  });
  try {
    await h.launch(); await h.configure(); await h.newChat(); await h.send('请记住：原有独立记忆'); const original = await h.memories();
    const file = join(h.profile, 'wechat-test.json');
    const data = { chatlab: { version: '0.0.2' }, members: [{ platformId: 'a', accountName: '测试说话人' }, { platformId: 'b', accountName: '我' }], messages: [
      { sender: 'a', type: 0, content: '好呀，我的导入验收饮品是梅子茶-6729' }, { sender: 'b', type: 0, content: '这句不应该交给模型' },
      { sender: 'a', type: 0, content: '好呀，慢慢来' }, { sender: 'a', type: 0, content: '我喜欢短句' }, { sender: 'a', type: 1, content: '[图片]' },
    ] };
    await writeFile(file, JSON.stringify(data));
    await h.application().evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
    await h.page().getByRole('navigation').getByRole('button', { name: '记忆', exact: true }).click();
    await h.page().getByRole('tab', { name: '微信导入与语气' }).click();
    await h.page().getByRole('button', { name: '选择导出文件' }).click();
    await expect(h.page().locator('.import-preview')).toContainText('测试说话人'); expect(await h.memories()).toEqual(original); expect(h.requests).toHaveLength(0);
    await h.page().getByRole('button', { name: '保存这份导入记录' }).click();
    await h.page().getByLabel('学习哪位说话人').selectOption('a');
    await h.page().getByRole('button', { name: '发送所选消息并蒸馏' }).click();
    await expect(h.page().locator('.import-fact')).toHaveCount(2); expect(await h.memories()).toEqual(original);
    expect(h.requests).toHaveLength(1); expect(JSON.stringify(h.requests[0])).not.toContain('这句不应该交给模型'); expect(h.requests[0]?.tools).toBeUndefined();
    await expect(h.page().getByRole('button', { name: '应用选中的记忆和语气' })).toBeDisabled();
    await h.page().locator('.import-fact').first().getByRole('checkbox', { name: '保存这条记忆' }).check();
    await h.page().getByRole('checkbox', { name: '启用这份语气（替换当前语气）' }).check();
    await h.page().screenshot({ path: info.outputPath('import-review.png') });
    await h.page().getByRole('button', { name: '应用选中的记忆和语气' }).click();
    await expect(h.page().locator('.import-voice')).toBeVisible(); const applied = await h.memories(); expect(applied).toHaveLength(2); expect(applied[0]).toEqual(original[0]); expect(applied.some((item) => item.text.includes('喜欢短句'))).toBe(false);
    await h.newChat(); await h.send('测试说话人的导入验收饮品是什么？'); await expect(h.page().locator('.chat-reply').last()).toHaveText('好呀，梅子茶-6729。');
    expect(JSON.stringify(h.requests.at(-1))).not.toContain('慢慢来');
    await h.stop(); await h.launch(); await h.newChat(); await h.send('测试说话人的导入验收饮品是什么？'); await expect(h.page().locator('.chat-reply').last()).toHaveText('好呀，梅子茶-6729。');
    const persisted = await h.page().evaluate(() => window.deskpet.imports.getState()); expect(persisted.records).toHaveLength(1); expect(persisted.activeStyle?.enabled).toBe(true); const recalled = await h.memories();
    expect(recalled.map((item) => ({ ...item, contextMetadata: { ...item.contextMetadata, sentCount: 0, lastSentAt: null } }))).toEqual(applied);
    expect(recalled.map((item) => item.contextMetadata?.revision)).toEqual(applied.map((item) => item.contextMetadata?.revision));
    expect(recalled.find((item) => item.text.includes('梅子茶'))?.contextMetadata?.sentCount).toBe(2);
    await h.page().getByRole('navigation').getByRole('button', { name: '记忆', exact: true }).click(); await h.page().getByRole('tab', { name: '微信导入与语气' }).click();
    await h.page().getByRole('checkbox', { name: '启用学习到的语气' }).uncheck(); await h.page().getByRole('button', { name: '保存语气设置' }).click();
    await expect(h.page().getByText('语气设置已保存。')).toBeVisible(); await h.stop(); await h.launch(); await h.newChat(); await h.send('测试说话人的导入验收饮品是什么？'); await expect(h.page().locator('.chat-reply').last()).toHaveText('梅子茶-6729。');
    expect((await h.page().evaluate(() => window.deskpet.permissions.list())).find((item) => item.capabilityId === 'web.read')?.state).toBe('always');
    await h.page().screenshot({ path: info.outputPath('import-recall-after-restart.png') }); await h.report(info, { persisted, applied, previewDidNotSave: true, uncheckedFactExcluded: true, voiceTogglePersisted: true });
  } finally { await h.clean(); }
});
