import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from 'node:console';
import { formatTimerDeadline } from '../../src/shared/timer-time';

interface Call { id: string; name: string; arguments: string }
interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}
interface Capture { request: WireRequest; calls: Call[]; finish: string | null; status: number; error?: string; startedAt: string; elapsedMs?: number; firstChunkMs?: number; firstTextMs?: number; firstToolMs?: number; reasoningCharacters: number; usage?: unknown }
interface Scenario { id: string; prompt: string; tools: string[]; args?: Record<string, unknown>; denied?: boolean; direct?: boolean; expectedTimers?: Array<{ label: string; seconds: number }>; answer?: string[]; sessionOf?: string }
const titles: Record<string, string> = { 'Current time': 'time.current', 'System summary': 'system.summary', 'Create timer': 'timer.create', 'Send notification': 'notification.send', 'Read workspace file': 'workspace.read', 'Write workspace file': 'workspace.write', 'Read HTTPS page': 'web.read', 'Search web': 'web.search', 'Calculate expression': 'math.calculate', 'List workspace directory': 'workspace.list', 'Search workspace text': 'workspace.search' };
const cases: Scenario[] = [
  { id: 'web-search', prompt: '请上网搜索 IANA 保留域名的官方说明，给我搜索结果里的标题和来源链接。', tools: ['web.search'], answer: ['iana.org'] },
  { id: 'search-read', prompt: '请先上网搜索 IANA 保留域名的官方说明，再读取找到的官方网页，回答 example.com 能否用于文档举例，并给出来源链接。', tools: ['web.search', 'web.read'], answer: ['example.com', 'iana.org'] },
  { id: 'calculator-tool', prompt: '请使用计算器精确核对 (37*24-128)/8 的计算结果，告诉我结果。', tools: ['math.calculate'], args: { expression: '(37*24-128)/8' }, answer: ['95'] },
  { id: 'list-workspace', prompt: '列出工作区根目录下的文件名，先实际浏览目录，不要猜有哪些文件。', tools: ['workspace.list'], answer: ['tool-eval-source.txt'] },
  { id: 'search-workspace', prompt: '在工作区搜索文字“蓝色风铃”，告诉我匹配文件的相对路径和行号。', tools: ['workspace.search'], args: { query: '蓝色风铃' }, answer: ['tool-eval-source.txt'] },
  { id: 'greeting', prompt: 'Kitty，晚上好，今天辛苦了。请用一句话回应。', tools: [] },
  { id: 'arithmetic', prompt: '17 加 28 等于多少？直接回答，不需要查询外部信息。', tools: [] },
  { id: 'timer-example-only', prompt: '给我一句设置倒计时的示例说法，只要例句。不要真的创建计时器，也不要发通知。', tools: [] },
  { id: 'clock', prompt: '帮我查一下现在上海的准确日期和时间。', tools: ['time.current'], args: { timezone: 'Asia/Shanghai' }, direct: true },
  { id: 'system', prompt: '查询这台电脑的操作系统、CPU 数量和总内存，告诉我查询结果。', tools: ['system.summary'] },
  { id: 'timer-first', prompt: '从现在开始计时 2 分钟，到时提醒我喝水，提醒名叫“测试喝水”。请现在创建计时器。', tools: ['timer.create'], args: { seconds: 120, label: '测试喝水' }, direct: true },
  { id: 'timer-second', prompt: '从现在开始计时 3 分钟，到时提醒我伸展，提醒名叫“测试伸展”。请现在创建计时器。', tools: ['timer.create'], args: { seconds: 180, label: '测试伸展' }, direct: true },
  { id: 'notification', prompt: '现在发送一条桌面通知，标题是“工具验收”，内容是“通知测试完成”。', tools: ['notification.send'], args: { title: '工具验收', body: '通知测试完成' } },
  { id: 'read-file', prompt: '读取工作区 tool-eval-source.txt，告诉我里面的验收暗号，不要猜。', tools: ['workspace.read'], args: { path: 'tool-eval-source.txt' } },
  { id: 'context-recall', prompt: '刚才读到的验收暗号是什么？根据我们这段对话回答即可，不必再读文件。', tools: [], answer: ['蓝色风铃 29'], sessionOf: 'read-file' },
  { id: 'write-file', prompt: '在工作区创建 tool-eval-note.txt，内容只写“蓝色风铃 29”，不要加任何其他内容。完成后告诉我。', tools: ['workspace.write'], args: { path: 'tool-eval-note.txt', content: '蓝色风铃 29' } },
  { id: 'web-read', prompt: '读取 https://www.iana.org/domains/reserved ，原样给出页面的英文主标题。', tools: ['web.read'], args: { url: 'https://www.iana.org/domains/reserved' } },
  { id: 'web-source', prompt: '用 web.read 的 html 模式读取 https://www.iana.org/domains/reserved 的原始 HTML。只原样返回第一个 h1 标签及内容（含开始和结束标签），不要用正文提取模式。', tools: ['web.read'], args: { url: 'https://www.iana.org/domains/reserved', format: 'html' }, answer: ['<h1>', 'IANA-managed Reserved Domains', '</h1>'] },
  { id: 'ambiguous-timer', prompt: '过一会提醒我喝水。先问我多久以后再创建，不要自行决定时间。', tools: [] },
  { id: 'unsupported-action', prompt: '帮我给微信里的小王发消息说晚上好。如果你没有微信工具，请直接说明不能发送。', tools: [] },
  { id: 'multi-step-math', prompt: '请算出 (37×24−128)÷8，写出每一步中间结果。不需要查询外部资料。', tools: [], answer: ['888', '760', '95'] },
  { id: 'conditional-true', prompt: '读取工作区 tool-eval-yes.json。只有 remind 为 true 时才根据 seconds 和 label 创建计时器，否则不要创建。不要猜文件内容。', tools: ['workspace.read', 'timer.create'], expectedTimers: [{ seconds: 75, label: '条件提醒' }] },
  { id: 'conditional-false', prompt: '读取工作区 tool-eval-no.json。只有 remind 为 true 时才根据 seconds 和 label 创建计时器，否则不要创建。不要猜文件内容。', tools: ['workspace.read'], expectedTimers: [] },
  { id: 'two-timers', prompt: '创建两个不同的计时器：30 秒后提醒我喝水，名字叫“第一提醒”；45 秒后提醒我伸展，名字叫“第二提醒”。两个都现在开始。', tools: ['timer.create', 'timer.create'], expectedTimers: [{ seconds: 30, label: '第一提醒' }, { seconds: 45, label: '第二提醒' }] },
  { id: 'mixed-tools-math', prompt: '查询上海现在的准确时间，创建一个名为“组合提醒”的 90 秒计时器，然后告诉我 17×23 的结果。全部完成后简短回复。', tools: ['time.current', 'timer.create'], expectedTimers: [{ seconds: 90, label: '组合提醒' }], answer: ['391'] },
  { id: 'quoted-command', prompt: '“两分钟后提醒我喝水”这句话自然吗？只评价语气，不要实际设置提醒。', tools: [], expectedTimers: [] },
  { id: 'parenthetical-example', prompt: '两分钟后提醒我喝水（仅演示这句话）。', tools: [], expectedTimers: [] },
  { id: 'short-command', prompt: 'Kitty，两分钟后提醒我喝水。', tools: ['timer.create'], args: { seconds: 120, label: '喝水' }, direct: true },
  { id: 'revoked-permission', prompt: '请创建一个 2 分钟的倒计时，名字叫“权限撤销测试”。', tools: ['timer.create'], args: { seconds: 120, label: '权限撤销测试' }, denied: true, direct: true },
];

// Opt-in real-model evaluation. All app data, workspace files, and intercepted
// notifications belong to this temporary profile. No cloud credentials used.
// eslint-disable-next-line no-empty-pattern
test('evaluates real local model tool selection, arguments, execution and restraint', async ({}, info) => {
  test.skip(process.env.DESKPET_TOOL_EVAL !== '1', 'Explicit opt-in required for live local inference.');
  const model = process.env.DESKPET_TOOL_MODEL ?? 'kitty-qwen-27b:latest';
  const root = await mkdtemp(join(tmpdir(), 'deskpet-tool-eval-')); const profile = join(root, 'profile');
  await mkdir(join(profile, 'workspace'), { recursive: true });
  await writeFile(join(profile, 'workspace/tool-eval-source.txt'), '验收暗号：蓝色风铃 29\n');
  await writeFile(join(profile, 'workspace/tool-eval-yes.json'), JSON.stringify({ remind: true, seconds: 75, label: '条件提醒' }));
  await writeFile(join(profile, 'workspace/tool-eval-no.json'), JSON.stringify({ remind: false, seconds: 75, label: '禁止创建' }));
  const selectedCases = process.env.DESKPET_TOOL_CASES ? cases.filter((item) => process.env.DESKPET_TOOL_CASES!.split(',').includes(item.id)) : cases;
  let application: ElectronApplication | undefined;
  const captured: Capture[] = []; const results: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const buffers: Buffer[] = []; request.on('data', (data: Buffer) => buffers.push(data));
    request.on('end', () => { void (async () => {
      const body = JSON.parse(Buffer.concat(buffers).toString()) as WireRequest;
      const requestStarted = Date.now();
      const capture: Capture = { request: body, calls: [], finish: null, status: 0, startedAt: new Date(requestStarted).toISOString(), reasoningCharacters: 0 }; captured.push(capture);
      const controller = new AbortController(); response.on('close', () => controller.abort());
      try {
        const upstream = await fetch('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        capture.status = upstream.status; response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' });
        const reader = upstream.body!.getReader(); const decoder = new TextDecoder(); let text = '';
        const callMap = new Map<number, Call>();
        while (true) {
          const item = await reader.read(); if (item.done) break;
          capture.firstChunkMs ??= Date.now() - requestStarted;
          response.write(item.value); text += decoder.decode(item.value, { stream: true });
          const lines = text.split('\n'); text = lines.pop() ?? '';
          for (const line of lines) if (line.startsWith('data:') && !line.includes('[DONE]')) {
            const chunk = JSON.parse(line.slice(5)) as { usage?: unknown; choices?: Array<{ finish_reason?: string; delta?: { content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
            if (chunk.usage) capture.usage = chunk.usage;
            for (const choice of chunk.choices ?? []) {
              capture.finish = choice.finish_reason ?? capture.finish;
              capture.reasoningCharacters += choice.delta?.reasoning?.length ?? 0;
              if (choice.delta?.content) capture.firstTextMs ??= Date.now() - requestStarted;
              if (choice.delta?.tool_calls?.length) capture.firstToolMs ??= Date.now() - requestStarted;
              for (const delta of choice.delta?.tool_calls ?? []) {
                const call = callMap.get(delta.index) ?? { id: '', name: '', arguments: '' };
                call.id += delta.id ?? ''; call.name += delta.function?.name ?? ''; call.arguments += delta.function?.arguments ?? ''; callMap.set(delta.index, call);
              }
            }
            capture.calls = [...callMap.values()];
          }
        }
        response.end();
      } catch (error) { capture.error = error instanceof Error ? error.name : 'error'; response.destroy(); }
      finally { capture.elapsedMs = Date.now() - requestStarted; }
    })(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No capture port');
  try {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    const page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ Notification }) => {
      const state = globalThis as typeof globalThis & { toolEvalNotifications: Array<{ title: string; body: string }> };
      state.toolEvalNotifications = []; Notification.prototype.show = function () { state.toolEvalNotifications.push({ title: this.title, body: this.body }); };
    });
    const providerId = await page.evaluate(async ({ model, baseUrl }) => {
      await window.deskpet.app.setLocale('zh-CN');
      const provider = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Isolated tool evaluation', model, baseUrl, enabled: true, supportsTools: true });
      for (const capabilityId of ['time.read', 'system.read', 'timer.write', 'notification.write', 'workspace.read', 'workspace.write', 'web.read', 'web.search', 'math.calculate']) await window.deskpet.permissions.request({ capabilityId, duration: 'session' });
      return provider.id;
    }, { model, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const sessions = new Map<string, string>();
    for (const item of selectedCases) {
      const started = Date.now(); const startCapture = captured.length;
      if (item.denied) await page.evaluate(() => window.deskpet.permissions.revoke('timer.write'));
      const before = await page.evaluate(async () => ({ timers: await window.deskpet.timers.list(), events: await window.deskpet.tasks.listRunEvents() }));
      const sessionId = await page.evaluate(async ({ item, providerId, existingSessionId }) => {
        const id = existingSessionId ?? (await window.deskpet.chat.createSession({ title: `工具验收 ${item.id}`, kind: 'normal' })).id;
        await window.deskpet.chat.send({ sessionId: id, providerId, content: item.prompt }); return id;
      }, { item, providerId, existingSessionId: item.sessionOf ? sessions.get(item.sessionOf) : undefined });
      sessions.set(item.id, sessionId);
      let timedOut = false;
      try { await expect.poll(async () => (await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId)).at(-1)?.status, { timeout: 180_000, intervals: [500] }).not.toBe('streaming'); }
      catch { timedOut = true; }
      const messages = await page.evaluate((id) => window.deskpet.chat.listMessages(id), sessionId);
      const turns = captured.slice(startCapture);
      const calls = turns.flatMap((turn) => turn.calls.map((call) => {
        const title = turn.request.tools?.find((tool) => tool.function.name === call.name)?.function.description.split('.')[0] ?? '';
        let args: unknown; try { args = JSON.parse(call.arguments); } catch { args = null; }
        return { ...call, toolId: titles[title] ?? call.name, args };
      }));
      const after = await page.evaluate(async () => ({ timers: await window.deskpet.timers.list(), events: await window.deskpet.tasks.listRunEvents() }));
      const addedTimers = after.timers.filter((timer) => !before.timers.some((old) => old.id === timer.id));
      const events = after.events.filter((event) => !before.events.some((old) => old.id === event.id));
      const direct = item.direct === true && process.env.DESKPET_TOOL_BASELINE !== '1';
      const routeEvent = events.find((event) => event.metadata.route === 'direct');
      const durationOf = (timer: typeof addedTimers[number]) => (Date.parse(timer.dueAt) - Date.parse(timer.createdAt)) / 1_000;
      const observedCalls = direct && routeEvent ? [{ toolId: routeEvent.metadata.toolId, args: routeEvent.metadata.toolId === 'time.current' ? { timezone: routeEvent.metadata.timeZone } : { label: addedTimers[0]?.label, seconds: addedTimers[0] && durationOf(addedTimers[0]) } }] : calls;
      const routeMatches = direct ? turns.length === 0 && routeEvent !== undefined : turns.length > 0 && routeEvent === undefined;
      const verifiedWrite = item.id === 'write-file' && calls.length === 2 && calls[0]?.toolId === 'workspace.write'
        && calls[1]?.toolId === 'workspace.read' && (calls[1].args as Record<string, unknown> | null)?.path === item.args?.path;
      const searchThenRead = item.id === 'search-read' && observedCalls[0]?.toolId === 'web.search'
        && observedCalls.some((call) => call.toolId === 'web.read')
        && observedCalls.every((call) => call.toolId === 'web.search' || call.toolId === 'web.read');
      const searchOnly = item.id === 'web-search' && observedCalls.length > 0 && observedCalls.every((call) => call.toolId === 'web.search');
      const selectionMatches = verifiedWrite || searchThenRead || searchOnly || JSON.stringify(observedCalls.map((call) => call.toolId).sort()) === JSON.stringify([...item.tools].sort());
      const argumentsMatch = (direct && item.denied) || !item.args || Object.entries(item.args).every(([key, value]) => {
        const actual = (observedCalls[0]?.args as Record<string, unknown> | null)?.[key];
        return actual === value || (item.id === 'short-command' && key === 'label' && actual === '喝水提醒');
      });
      let effectMatches = true;
      if (item.id.startsWith('timer-') && item.tools.length) effectMatches = addedTimers.length === 1 && addedTimers[0]?.label === item.args?.label;
      if (item.id === 'short-command') effectMatches = addedTimers.length === 1 && ['喝水', '喝水提醒'].includes(addedTimers[0]?.label ?? '') && durationOf(addedTimers[0]!) === 120;
      if (item.expectedTimers) effectMatches = addedTimers.length === item.expectedTimers.length && item.expectedTimers.every((expected) => addedTimers.some((timer) => timer.label === expected.label && durationOf(timer) === expected.seconds));
      if (item.id === 'write-file') effectMatches = await readFile(join(profile, 'workspace/tool-eval-note.txt'), 'utf8').then((text) => text === '蓝色风铃 29').catch(() => false);
      if (item.id === 'notification') effectMatches = await application.evaluate(() => (globalThis as typeof globalThis & { toolEvalNotifications: Array<{ title: string; body: string }> }).toolEvalNotifications.some((notification) => notification.title === '工具验收' && notification.body === '通知测试完成'));
      if (item.denied) effectMatches = addedTimers.length === 0 && messages.at(-1)?.status === 'failed';
      let answerMatches = true;
      if (item.id === 'arithmetic') answerMatches = messages.at(-1)?.content.includes('45') ?? false;
      if (item.id === 'read-file') answerMatches = messages.at(-1)?.content.includes('蓝色风铃 29') ?? false;
      if (item.id === 'web-read') answerMatches = messages.at(-1)?.content.includes('IANA-managed Reserved Domains') ?? false;
      if (item.answer) answerMatches = item.answer.every((part) => messages.at(-1)?.content.includes(part));
      if (item.id === 'parenthetical-example') {
        const reply = messages.at(-1)?.content ?? '';
        answerMatches = /示例|演示|说法|句|表达|用语/u.test(reply) && !/已(?:经)?(?:为你|帮你)?(?:设置|创建|设好)/u.test(reply);
      }
      if (item.id === 'timer-first' || item.id === 'timer-second') {
        const resultMessage = turns.flatMap((turn) => turn.request.messages).find((message) => message.role === 'tool');
        const receipt = messages.at(-1)?.timerReceipts?.[0];
        const timerResult = direct && receipt ? { ...receipt, localDueAt: formatTimerDeadline(receipt.dueAt, receipt.timeZone) } : JSON.parse(resultMessage?.content ?? '{}') as { localDueAt?: string; timeZone?: string; dueAt?: string };
        await page.locator('nav').getByRole('button', { name: '聊天', exact: true }).click();
        await page.getByRole('combobox', { name: '新对话', exact: true }).selectOption(sessionId);
        await expect(page.locator('.timer-receipt')).toContainText(timerResult.localDueAt ?? 'missing trusted deadline');
        await expect(page.locator('.timer-receipt time')).toHaveAttribute('datetime', timerResult.dueAt ?? 'missing deadline');
        await page.screenshot({ path: info.outputPath(`${item.id}-confirmation.png`) });
        const quotedTimes = (messages.at(-1)?.content ?? '').replace(/GMT[+-]\d{2}:\d{2}/gu, '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu) ?? [];
        const expectedTime = timerResult.localDueAt?.match(/\d{2}:\d{2}:\d{2}/u)?.[0] ?? '';
        answerMatches = receipt !== undefined && formatTimerDeadline(receipt.dueAt, receipt.timeZone) === timerResult.localDueAt
          && quotedTimes.every((value) => value === expectedTime || value === expectedTime.slice(0, 5));
        effectMatches = effectMatches && addedTimers[0]?.dueAt === timerResult.dueAt;
      }
      if (item.denied) answerMatches = messages.at(-1)?.errorCode === 'tool.permission.timer.write';
      const result = { id: item.id, prompt: item.prompt, expectedTools: item.tools, route: direct ? 'direct' : 'model', routeMatches, calls, selectionMatches, argumentsMatch, effectMatches, answerMatches, final: messages.at(-1), elapsedMs: Date.now() - started, timedOut, events, toolResults: turns.flatMap((turn) => turn.request.messages.filter((message) => message.role === 'tool')), pass: !timedOut && routeMatches && selectionMatches && argumentsMatch && effectMatches && answerMatches && (item.denied || messages.at(-1)?.status === 'complete') };
      results.push(result);
      await writeFile(info.outputPath('tool-evaluation.json'), JSON.stringify({ model, results, captures: captured }, null, 2));
      log(`TOOL_EVAL ${item.id}: selection=${selectionMatches} arguments=${argumentsMatch} effect=${effectMatches} answer=${answerMatches} status=${messages.at(-1)?.status} elapsed=${Math.round(result.elapsedMs / 1000)}s`);
      if (timedOut) break;
    }
    await writeFile(info.outputPath('summary.json'), JSON.stringify({ model, cases: results.length, passed: results.filter((item) => item.pass).length, failed: results.filter((item) => !item.pass).map((item) => item.id), complete: results.length === selectedCases.length }, null, 2));
    expect(results, 'All requested evaluation scenarios must execute').toHaveLength(selectedCases.length);
    expect(results.filter((item) => !item.pass).map((item) => item.id), 'Behavioral failures are findings, not an infrastructure pass').toEqual([]);
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
