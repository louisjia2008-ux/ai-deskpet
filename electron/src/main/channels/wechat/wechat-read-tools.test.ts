import { expect, it, vi } from 'vitest';
import { SecureWebReader, type PinnedRequester } from '../../tools/web-reader';
import { commandFromScheduledTool, matchWeChatReadTool, WeChatReadTools } from './wechat-read-tools';

const publicAddress = { address: '93.184.216.34', family: 4 } as const;
const response = (body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html' }) => ({
  status, headers, body: (async function* () { yield Buffer.from(body); })(),
});
const result = (url: string, title: string) => `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>公开摘要。</p></li>`;

it('recognizes only bounded complete read-only commands, including the native mention prefix', () => {
  expect(matchWeChatReadTool('@小桌宠 /search 中国航天 NASA site:nasa.gov', '小桌宠')).toEqual({
    toolId: 'web.search', input: { query: '中国航天 NASA site:nasa.gov' },
  });
  expect(matchWeChatReadTool('帮我搜索这个聊天记录')).toBeNull();
  expect(matchWeChatReadTool('例子：/search 中国航天')).toBeNull();
  expect(matchWeChatReadTool('/search 公共消息\n下一条私聊')).toBe('invalid');
  expect(matchWeChatReadTool('/search 查询手机号 13812345678')).toBe('invalid');
  expect(matchWeChatReadTool('/search 查询 somebody@example.com')).toBe('invalid');
  expect(matchWeChatReadTool('/search API_KEY=example123')).toBe('invalid');
  expect(matchWeChatReadTool('/search site:localhost 联系方式')).toBe('invalid');
  expect(matchWeChatReadTool('/search site:127.0.0.1 公开新闻')).toBe('invalid');
  expect(matchWeChatReadTool('/read https://example.org/?token=abc')).toBe('invalid');
  expect(matchWeChatReadTool('/read http://example.org')).toBe('invalid');
  expect(matchWeChatReadTool('/time Pacific/Nowhere')).toBe('invalid');
  expect(commandFromScheduledTool('workspace.read', { path: '/tmp/private' })).toBeNull();
  expect(commandFromScheduledTool('web.search', { query: 'public search', history: ['private'] })).toBeNull();
  expect(matchWeChatReadTool('现在北京时间')).toEqual({ toolId: 'time.current', input: { timezone: 'Asia/Shanghai' } });
});

it('uses existing secure search, sends only the command query and labels excerpts and source URLs', async () => {
  const requester = vi.fn<PinnedRequester>(async () => response([
    result('https://example.org/report?utm_source=test', '一则新闻'),
    result('https://private.example.net/?token=fixture', '不要展示的链接'),
    result('https://other.example.org/article', '另一则消息'),
  ].join('')));
  const web = new SecureWebReader({ resolver: async () => [publicAddress], requester });
  const tools = new WeChatReadTools({ web });
  const authorize = vi.fn(async () => undefined);
  const consume = vi.fn(() => true);
  const text = await tools.run({ toolId: 'web.search', input: { query: '本周公共航天新闻' } }, { authorize, consume });
  expect(requester).toHaveBeenCalledOnce();
  expect([...requester.mock.calls[0]![0].searchParams]).toEqual([['q', '本周公共航天新闻']]);
  expect(consume).toHaveBeenCalledExactlyOnceWith('web.search');
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(text).toContain('摘要未经核验');
  expect(text).toContain('https://example.org/report');
  expect(text).not.toContain('https://other.example.org/article');
  expect(text).not.toMatch(/fixture|utm_source|不要展示/u);
  expect([...text].length).toBeLessThanOrEqual(480);
});

it('uses the configured local search plugin without unplanned fallback and honors per-run budget', async () => {
  const requester = vi.fn<PinnedRequester>();
  const web = new SecureWebReader({ requester });
  const search = vi.fn(async () => { throw new Error('synthetic backend failure'); });
  const tools = new WeChatReadTools({ web, webPlugins: { enabled: true, search } });
  const command = { toolId: 'web.search', input: { query: '公共新闻' } } as const;
  await expect(tools.runTask(command, { consume: () => false })).rejects.toMatchObject({ code: 'tool.webBudgetExceeded' });
  expect(search).not.toHaveBeenCalled();
  await expect(tools.runTask(command)).rejects.toThrow('synthetic backend failure');
  expect(search).toHaveBeenCalledOnce();
  expect(requester).not.toHaveBeenCalled();
});

it('rejects private DNS redirects and rechecks live authorization at the request and result boundaries', async () => {
  const requester = vi.fn<PinnedRequester>(async () => response('', 302, { location: 'https://private.example.net/hidden' }));
  const web = new SecureWebReader({ resolver: async host => host.startsWith('private.')
    ? [{ address: '127.0.0.1', family: 4 }] : [publicAddress], requester });
  const tools = new WeChatReadTools({ web });
  const command = { toolId: 'web.read', input: { url: 'https://example.org/article' } } as const;
  await expect(tools.runTask(command)).rejects.toMatchObject({ code: 'tool.webTarget' });
  expect(requester).toHaveBeenCalledOnce();
  await expect(tools.runTask(command, { assertCurrent: () => { throw new Error('authority changed'); } }))
    .rejects.toThrow('authority changed');
  expect(requester).toHaveBeenCalledOnce();

  requester.mockImplementation(async () => response('<p>一段公开网页证据。</p>'));
  const authorize = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('before dispatch'));
  await expect(tools.runTask(command, { authorize })).rejects.toThrow('before dispatch');
  expect(requester).toHaveBeenCalledOnce();
  authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('after dispatch'));
  await expect(tools.runTask(command, { authorize })).rejects.toThrow('after dispatch');
  expect(requester).toHaveBeenCalledTimes(2);
  await expect(tools.runTask(command)).resolves.toEqual({ kind: 'page-excerpt', source: command.input.url,
    excerpt: '一段公开网页证据。', truncated: false });
});

it('uses the existing calculator and time formatter without accessing the network', async () => {
  const requester = vi.fn<PinnedRequester>();
  const tools = new WeChatReadTools({ web: new SecureWebReader({ requester }), timezone: () => 'Asia/Shanghai',
    now: () => new Date('2026-11-13T12:00:00.000Z') });
  await expect(tools.run({ toolId: 'math.calculate', input: { expression: '2 × (3 + 4)' } })).resolves.toBe('计算结果：14');
  await expect(tools.run({ toolId: 'time.current', input: {} })).resolves.toContain('2026-11-13 20:00:00 (Asia/Shanghai');
  await expect(tools.run('invalid')).resolves.toContain('/search 公共关键词');
  expect(requester).not.toHaveBeenCalled();
});
