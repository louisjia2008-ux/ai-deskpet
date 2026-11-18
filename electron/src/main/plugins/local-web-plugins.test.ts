// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LocalWebPlugins } from './local-web-plugins';
import { defaultPluginSettings } from '../../shared/plugins';
import { registerBuiltinTools } from '../tools/builtins';
import { SecureWebReader } from '../tools/web-reader';
import { ToolRegistry } from '../runtime/tool-registry';
import type { WorkspaceAccess } from '../tools/workspace';

const signal = (): AbortSignal => new AbortController().signal;
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const hit = (url = 'https://example.org/guide', title = 'A guide', content = 'Verified page excerpt.') => ({ url, title, content });
const crawl = (text = 'Page content', extra: Record<string, unknown> = {}) => ({ success: true, results: [{ url: 'https://example.org/guide', success: true, markdown: { fit_markdown: text, raw_markdown: 'Raw navigation and content' }, html: '<h1>Raw source</h1>', ...extra }] });
const fixture = (responses: Response[] = []) => {
  const settings = defaultPluginSettings(); settings.web.enabled = true;
  const fetcher = vi.fn<typeof fetch>(async () => responses.shift() ?? json({ results: [hit()] }));
  const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
  const token = vi.fn(async () => 'test-fixture-token');
  const service = new LocalWebPlugins({ getSettings: () => settings, getCrawl4aiToken: token, fetch: fetcher, resolver });
  return { service, settings, fetcher, resolver, token };
};

describe('local web plugins', () => {
  it('uses only the configured local SearXNG JSON API and enforces site restrictions before the result limit', async () => {
    const f = fixture([json({ results: [hit('https://evil.example/?docs.python.org'), hit('https://docs.python.org.attacker.example/'), hit('https://docs.python.org/3/tutorial/'), hit('https://docs.python.org/2/'), hit('https://docs.python.org/3/library/')] })]);
    f.settings.web.searxngUrl = 'http://localhost:18888';
    const result = await f.service.search('Python site:docs.python.org/3/ -site:docs.python.org/3/library/', 1, signal());
    expect(result).toMatchObject({ engine: 'SearXNG', results: [{ url: 'https://docs.python.org/3/tutorial/' }], truncated: false,
      siteFilter: { include: ['docs.python.org/3/'], exclude: ['docs.python.org/3/library/'], removedResultCount: 4 } });
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe('http://127.0.0.1:18888');
    expect(new URL(String(url)).searchParams.get('q')).toBe('Python site:docs.python.org/3/ -site:docs.python.org/3/library/');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
    expect(f.token).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled();
  });

  it('bounds snippets, deduplicates fragment URLs and drops unsafe result URLs without following any result', async () => {
    const f = fixture([json({ results: [hit('https://example.org/guide#one', 'Title', 'x'.repeat(8000)), hit('https://example.org/guide#two'), hit('file:///etc/passwd'), hit('https://127.0.0.1/'), hit('https://user:pass@example.org/'), hit('https://example.org:8443/'), hit('https://localhost/'), hit('https://example.net/other')] })]);
    f.settings.web.maxCharacters = 1000;
    const result = await f.service.search('test', 2, signal());
    expect(result.results.map((r) => r.url)).toEqual(['https://example.org/guide', 'https://example.net/other']);
    expect(result.results[0]!.snippet).toHaveLength(500); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('rejects malformed site operators and non-loopback endpoints before network access', async () => {
    const f = fixture();
    await expect(f.service.search('site:', 5, signal())).rejects.toMatchObject({ code: 'tool.invalidArguments' });
    for (const url of ['https://remote.example/', 'http://127.0.0.1:8080/execute', 'http://user:pass@localhost:8080/', 'http://127.0.0.1:8080/?command=x']) {
      f.settings.web.searxngUrl = url;
      await expect(f.service.search('test', 5, signal())).rejects.toThrow();
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('reports engine failures separately from actual empty search results', async () => {
    const f = fixture([json({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] }), json({ results: [], unresponsive_engines: [] })]);
    await expect(f.service.search('test', 5, signal())).rejects.toMatchObject({ code: 'tool.searchUnavailable', pluginCode: 'plugin.searchEnginesUnavailable' });
    expect(await f.service.search('test', 5, signal())).toMatchObject({ results: [], truncated: false });
    const partial = fixture([json({ results: [hit()], unresponsive_engines: [['brave', 'too many requests'], ['secret:token', 'no raw text']] })]);
    expect(await partial.service.search('test', 3, signal())).toMatchObject({ degraded: true, unavailableEngines: [{ engine: 'brave', reason: 'rate-limited' }] });
  });

  it('sends a fixed single-page Crawl4AI payload and keeps Bearer credentials out of the result', async () => {
    const f = fixture([json(crawl('正文\n'.repeat(2000)))]); f.settings.web.maxCharacters = 1000;
    const result = await f.service.read('https://example.org/guide', 'text', { maxCharacters: 8000 }, signal());
    expect(result).toMatchObject({ engine: 'Crawl4AI', extraction: 'filtered-markdown', truncated: true, nextOffset: 1000, contentType: 'text/markdown' });
    expect(result.text).toHaveLength(1000); expect(JSON.stringify(result)).not.toContain('test-fixture-token');
    const [url, init] = f.fetcher.mock.calls[0]!; expect(url).toBe('http://127.0.0.1:11235/crawl');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-fixture-token' });
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ urls: ['https://example.org/guide'], browser_config: { type: 'BrowserConfig', params: { headless: true, accept_downloads: false } }, crawler_config: { type: 'CrawlerRunConfig', params: { stream: false, page_timeout: 40000 } } });
    expect(JSON.stringify(payload)).not.toContain('js_code'); expect(JSON.stringify(payload)).not.toContain('llm');
    const next = await f.service.read('https://example.org/guide', 'text', { offset: result.nextOffset!, maxCharacters: 500 }, signal());
    expect(next.sourceSHA256).toBe(result.sourceSHA256); expect(next.offset).toBe(1000); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('supports raw HTML explicitly and falls back to raw Markdown when fit Markdown is empty', async () => {
    const f = fixture([json(crawl('')), json(crawl())]);
    expect(await f.service.read('https://example.org/guide', 'text', {}, signal())).toMatchObject({ text: 'Raw navigation and content', format: 'text', extraction: 'raw-markdown' });
    expect(await f.service.read('https://example.org/guide', 'html', {}, signal())).toMatchObject({ text: '<h1>Raw source</h1>', format: 'html', contentType: 'text/html', extraction: 'raw-html' });
  });

  it('fetches a page again when a slow reader returns with a cursor after it expired', async () => {
    const f = fixture([json(crawl('a'.repeat(2000))), json(crawl('b'.repeat(2000)))]); f.settings.web.maxCharacters = 1000;
    const now = vi.spyOn(Date, 'now');
    try {
      await f.service.read('https://example.org/slow', 'text', {}, signal());
      now.mockReturnValue(Date.now() + 6 * 60_000);
      expect(await f.service.read('https://example.org/slow', 'text', { offset: 1000 }, signal())).toMatchObject({ text: 'b'.repeat(1000), offset: 1000 });
    } finally { now.mockRestore(); }
  });

  it('reports a missing page separately from a crawl failure', async () => {
    const f = fixture([json({ success: true, results: [{ success: false, status_code: 404, url: 'https://example.org/gone', markdown: '' }] }), json({ success: true, results: [{ success: false, status_code: 500, url: 'https://example.org/broken', markdown: '' }] })]);
    await expect(f.service.read('https://example.org/gone', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.pluginResponse', detail: 'plugin.pageNotFound' });
    await expect(f.service.read('https://example.org/broken', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.pluginResponse', detail: 'plugin.pageServerError' });
  });

  it('rejects non-public input and private DNS before sending anything to Crawl4AI', async () => {
    const f = fixture();
    for (const url of ['file:///etc/passwd', 'http://example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:pass@example.org/', 'https://example.org:8443/']) {
      await expect(f.service.read(url, 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.webTarget' });
    }
    f.resolver.mockResolvedValue([{ address: '10.1.1.1', family: 4 }]);
    await expect(f.service.read('https://internal.example/', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.webTarget' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });

  it('does not publish a result that claims a private redirect or failed HTTP fetch', async () => {
    const f = fixture([json(crawl('secret', { redirected_url: 'https://localhost/' })), json(crawl('denied', { status_code: 403 }))]);
    await expect(f.service.read('https://example.org/guide', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.webTarget' });
    await expect(f.service.read('https://example.org/guide', 'text', {}, signal())).rejects.toMatchObject({ pluginCode: 'plugin.pageAccessDenied' });
  });

  it.each([
    [404, 'plugin.pageNotFound'], [410, 'plugin.pageNotFound'],
    [401, 'plugin.pageAccessDenied'], [403, 'plugin.pageAccessDenied'],
    [429, 'plugin.pageRateLimited'], [503, 'plugin.pageServerError'],
  ])('rejects an HTTP %s error page even if the crawler says success and returns Markdown', async (status, detail) => {
    const f = fixture([json(crawl('Error page title and text', { status_code: status }))]);
    await expect(f.service.read('https://example.org/error', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.pluginResponse', detail });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['dns-unavailable', 'tool.network', 'plugin.dnsUnavailable'],
    ['public-address-required', 'tool.webTarget', 'plugin.nonPublicAddress'],
    ['public-https-required', 'tool.webTarget', 'plugin.invalidTarget'],
    ['response-too-large', 'tool.pluginResponse', 'plugin.responseTooLarge'],
    ['redirect-limit', 'tool.pluginResponse', 'plugin.redirectLimit'],
    ['navigation-failed', 'tool.pluginResponse', 'plugin.navigationFailed'],
    ['extraction-failed', 'tool.pluginResponse', 'plugin.extractionFailed'],
    ['browser-failed', 'tool.pluginResponse', 'plugin.browserFailed'],
    ['timeout', 'tool.timeout', 'tool.timeout'],
  ])('uses only fixed adapter reason %s for both HTTP and result failures', async (reason, code, detail) => {
    const f = fixture([new Response('PRIVATE_RESPONSE_BODY', { status: 502, headers: { 'X-DeskPet-Crawl-Error': reason } }),
      json({ success: false, results: [{ success: false, status_code: null, error_code: reason, error_message: 'PRIVATE_EXCEPTION_BODY' }] })]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error: unknown = await f.service.read('https://example.org/failure', 'text', {}, signal()).catch((value: unknown) => value);
      expect(error).toMatchObject({ code, detail });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    }
  });

  it('ignores unknown adapter diagnostics and does not reinterpret local authentication errors as page errors', async () => {
    const f = fixture([new Response('PRIVATE_RESPONSE_BODY', { status: 502, headers: { 'X-DeskPet-Crawl-Error': 'PRIVATE_SECRET', 'X-DeskPet-Crawl-Stage': 'PRIVATE_STAGE' } }),
      json({ success: false, results: [{ success: false, error_code: 'constructor', error_message: 'PRIVATE_SECRET' }] }),
      new Response('PRIVATE_AUTH_BODY', { status: 401, headers: { 'X-DeskPet-Crawl-Error': 'navigation-failed' } })]);
    expect(await f.service.probe('crawl4ai', signal())).toMatchObject({ ok: false, code: 'plugin.crawlHttp502' });
    expect(await f.service.probe('crawl4ai', signal())).toMatchObject({ ok: false, code: 'plugin.crawlFailed' });
    expect(await f.service.probe('crawl4ai', signal())).toMatchObject({ ok: false, code: 'plugin.authenticationFailed' });
  });

  it('keeps mixed public/private DNS blocked and classifies unresolved DNS before local dispatch', async () => {
    const f = fixture();
    f.resolver.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(f.service.read('https://example.org/mixed', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.webTarget', detail: 'web.nonPublicAddress' });
    f.resolver.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_DNS_DETAIL'), { code: 'ENOTFOUND' }));
    await expect(f.service.read('https://example.org/unresolved', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.network', detail: 'web.dnsUnavailable' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });

  it('rejects empty extraction and invalid HTTP metadata instead of recording successful sources', async () => {
    const f = fixture([json(crawl('', { markdown: { fit_markdown: ' ', raw_markdown: '' } })), json(crawl('Ignored', { html: ' ' })), json(crawl('Error body', { status_code: '404' }))]);
    await expect(f.service.read('https://example.org/empty', 'text', {}, signal())).rejects.toMatchObject({ detail: 'plugin.emptyContent' });
    await expect(f.service.read('https://example.org/empty', 'html', {}, signal())).rejects.toMatchObject({ detail: 'plugin.emptyContent' });
    await expect(f.service.read('https://example.org/invalid', 'text', {}, signal())).rejects.toMatchObject({ detail: 'plugin.invalidResponse' });
  });

  it('does not downgrade a blocked navigation to a recoverable missing-page error', async () => {
    const f = fixture([json({ success: false, results: [{ success: false, status_code: 404,
      error_code: 'public-address-required', markdown: 'Unverified page body' }] })]);
    await expect(f.service.read('https://example.org/blocked', 'text', {}, signal())).rejects.toMatchObject({ code: 'tool.webTarget', detail: 'plugin.nonPublicAddress' });
  });

  it('shows only the failing HTTP status and an allowlisted crawler stage', async () => {
    const f = fixture(['navigation', 'untrusted diagnostic contents'].map(stage => new Response('untrusted response body', {
      status: 502, headers: {'X-DeskPet-Crawl-Stage': stage},
    })));
    expect((await f.service.probe('crawl4ai', signal())).code).toBe('plugin.crawlHttp502.navigation');
    expect((await f.service.probe('crawl4ai', signal())).code).toBe('plugin.crawlHttp502');
  });
  it('returns useful safe probes while the plugin is disabled and never returns server error text', async () => {
    const f = fixture([new Response('secret-token and server stack trace', { status: 403 }), json({ detail: 'secret-token' }, 401), new Response('login HTML', { headers: { 'content-type': 'text/html' } })]);
    f.settings.web.enabled = false;
    expect(await f.service.probe('searxng', signal())).toMatchObject({ ok: false, code: 'plugin.jsonDisabled' });
    expect(await f.service.probe('crawl4ai', signal())).toMatchObject({ ok: false, code: 'plugin.authenticationFailed' });
    const result = await f.service.probe('searxng', signal());
    expect(result).toMatchObject({ ok: false, code: 'plugin.jsonRequired' }); expect(JSON.stringify(result)).not.toContain('secret-token');
    const pass = fixture([json({ results: [hit()] })]); pass.settings.web.enabled = false;
    expect(await pass.service.probe('searxng', signal())).toMatchObject({ ok: true, code: 'plugin.ok', resultCount: 1 });
  });

  it('bounds response streams and reports malformed JSON/response shapes', async () => {
    const f = fixture([new Response('{bad', { headers: { 'content-type': 'application/json' } }), json({ error: 'not a result' })]);
    expect(await f.service.probe('searxng', signal())).toMatchObject({ code: 'plugin.invalidResponse' });
    expect(await f.service.probe('searxng', signal())).toMatchObject({ code: 'plugin.invalidResponse' });
    const limited = new LocalWebPlugins({ getSettings: () => defaultPluginSettings(), getCrawl4aiToken: async () => null,
      maxResponseBytes: 30, fetch: async () => json({ results: [hit()] }) });
    expect(await limited.probe('searxng', signal())).toMatchObject({ code: 'plugin.responseTooLarge' });
  });

  it('bounds stalled fetches, propagates cancellation and rejects permission revocation before dispatch', async () => {
    const settings = defaultPluginSettings(), fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const service = new LocalWebPlugins({ getSettings: () => settings, getCrawl4aiToken: async () => null, fetch: fetcher, timeoutMs: 10 });
    expect(await service.probe('searxng', signal())).toMatchObject({ code: 'plugin.timeout' });
    const controller = new AbortController(); const pending = service.search('test', 3, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const before = fetcher.mock.calls.length;
    await expect(service.search('test', 3, signal(), () => { throw new Error('permission revoked'); })).rejects.toThrow('permission revoked');
    expect(fetcher.mock.calls.length).toBe(before);
  });

  it('rejects results after the plugin is disabled or its endpoint changes during a request', async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => { f.settings.web.enabled = false; return json({ results: [hit()] }); });
    await expect(f.service.search('test', 3, signal())).rejects.toMatchObject({ pluginCode: 'plugin.configurationChanged' });
    f.fetcher.mockImplementationOnce(async () => { f.settings.web.searxngUrl = 'http://127.0.0.1:19999'; return json({ results: [hit()] }); });
    await expect(f.service.search('test', 3, signal())).rejects.toMatchObject({ pluginCode: 'plugin.configurationChanged' });
  });

  it('cancels active HTTP immediately and clears pagination when configuration is invalidated', async () => {
    const f = fixture([json(crawl('x'.repeat(2000)))]); f.settings.web.maxCharacters = 1000;
    await f.service.read('https://example.org/guide', 'text', {}, signal());
    f.fetcher.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = f.service.search('pending', 3, signal()); f.service.invalidate();
    await expect(pending).rejects.toMatchObject({ pluginCode: 'plugin.configurationChanged' });
    f.fetcher.mockResolvedValueOnce(json(crawl('y'.repeat(2000))));
    expect(await f.service.read('https://example.org/guide', 'text', { offset: 1000 }, signal())).toMatchObject({ text: 'y'.repeat(1000), offset: 1000 });
  });

  it('stops before dispatch if permission or configuration changes during token retrieval', async () => {
    const f = fixture();
    f.token.mockImplementationOnce(async () => { f.settings.web.enabled = false; return 'test-fixture-token'; });
    await expect(f.service.read('https://example.org/guide', 'text', {}, signal())).rejects.toMatchObject({ pluginCode: 'plugin.configurationChanged' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not dispatch after stalled DNS is cancelled and validates pagination bounds', async () => {
    const f = fixture(); f.resolver.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController(); const pending = f.service.read('https://example.org/guide', 'text', {}, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetcher).not.toHaveBeenCalled();
    for (const page of [{ offset: -1 }, { maxCharacters: 0 }, { maxCharacters: 16001 }]) {
      await expect(f.service.read('https://example.org/guide', 'text', page, signal())).rejects.toMatchObject({ code: 'tool.invalidArguments' });
    }
  });

  it('routes enabled builtins through plugins without a silent Bing fallback, and preserves the old backend when disabled', async () => {
    const f = fixture([json({ results: [hit()] })]);
    const web = new SecureWebReader({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], requester: vi.fn() });
    const direct = vi.spyOn(web, 'read').mockResolvedValue({ url: 'https://example.org/guide', contentType: 'text/plain', text: 'Direct reader' });
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { workspace: {} as WorkspaceAccess, web, webPlugins: f.service, notify: async () => undefined, createTimer: async () => ({ timerId: 'fixture' }) });
    const context = { runId: 'fixture', taskId: 'fixture', signal: signal() };
    expect(await registry.get('web.search').execute({ query: 'test' }, context)).toMatchObject({ engine: 'SearXNG' }); expect(direct).not.toHaveBeenCalled();
    f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(registry.get('web.search').execute({ query: 'test' }, context)).rejects.toMatchObject({ code: 'tool.pluginUnavailable' }); expect(direct).not.toHaveBeenCalled();
    f.settings.web.enabled = false;
    expect(await registry.get('web.read').execute({ url: 'https://example.org/guide' }, context)).toMatchObject({ text: 'Direct reader' }); expect(direct).toHaveBeenCalledOnce();
  });
});
