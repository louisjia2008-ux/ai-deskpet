import { describe, expect, it, vi } from 'vitest';
import { parseSearchResults, searchWeb } from './web-search';
import { SecureWebReader } from './web-reader';

const result = (url: string, title = 'Example &amp; facts', snippet = 'Some <b>facts</b>.') => `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><div class="b_caption"><p>${snippet}</p></div></li>`;
const readerWithResults = (html: string) => {
  const requester = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { yield Buffer.from(html); })() }));
  return { requester, web: new SecureWebReader({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], requester }) };
};

describe('web search', () => {
  it('extracts ranked HTTPS source links and snippets, decodes wrapped URLs, deduplicates and bounds results', () => {
    const encoded = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.org/guide').toString('base64url')}&amp;ntb=1`;
    const html = `<script>doNotRun()</script><ol>${result('https://example.com/')} ${result('https://example.com/#same')} ${result(encoded)} ${result('javascript:alert(1)')}${result('https://user:pass@example.net/')}${result('https://example.net:8443/')}</ol>`;
    expect(parseSearchResults(html, 'https://cn.bing.com/search?q=test', 1)).toEqual({
      results: [{ title: 'Example & facts', url: 'https://example.com/', snippet: 'Some facts.' }], truncated: true,
    });
    expect(parseSearchResults(html, 'https://www.bing.com/search?q=test', 5).results.map((item) => item.url)).toEqual(['https://example.com/', 'https://example.org/guide']);
  });
  it('distinguishes a genuine empty result from challenges, login pages and changed layouts', () => {
    expect(parseSearchResults('<li class="b_no">There are no results for this query.</li>', 'https://www.bing.com/search', 5)).toEqual({ results: [], truncated: false });
    for (const html of ['<form id="b_captcha">Verify</form>', '<title>Sign in</title>', '<div>Changed layout</div>', '<li class="b_no">Service unavailable</li>', '<form id="b_captcha"></form>' + result('https://example.org/')]) {
      expect(() => parseSearchResults(html, 'https://www.bing.com/search', 5)).toThrow(expect.objectContaining({ code: 'tool.searchUnavailable' }));
    }
  });
  it('uses the secure reader, encodes only the query and never automatically fetches result links', async () => {
    const requester = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: (async function* () { yield Buffer.from(result('https://example.org/')); })() }));
    const web = new SecureWebReader({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], requester });
    const response = await searchWeb(web, '猫 & site:example.org', 5, new AbortController().signal);
    expect(response).toMatchObject({ engine: 'Bing', query: '猫 & site:example.org', results: [{ url: 'https://example.org/' }] });
    expect(requester).toHaveBeenCalledOnce();
    const url = (requester.mock.calls as unknown as Array<[URL]>)[0]![0];
    expect(url.hostname).toBe('www.bing.com'); expect([...url.searchParams]).toEqual([['q', '猫 & site:example.org']]);
  });
  it('preserves private-target and cancellation protection', async () => {
    const requester = vi.fn();
    const web = new SecureWebReader({ resolver: async () => [{ address: '127.0.0.1', family: 4 }], requester });
    await expect(searchWeb(web, 'test', 5, new AbortController().signal)).rejects.toMatchObject({ code: 'tool.webTarget' });
    const controller = new AbortController(); controller.abort();
    await expect(searchWeb(web, 'test', 5, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(requester).not.toHaveBeenCalled();
  });
  it('enforces site restrictions on decoded destination hosts before limiting ranked results', async () => {
    const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://docs.python.org/3/reference/').toString('base64url')}`;
    const { web, requester } = readerWithResults([
      result('https://python.org/'), result('https://docs.python.org.attacker.example/'),
      result('https://notdocs.python.org/'), result('https://example.org/?target=docs.python.org', 'docs.python.org'),
      result('https://example.org/docs.python.org/'), result('https://docs.python.org/3/tutorial/'),
      result(wrapped), result('https://preview.docs.python.org/guide'),
    ].join(''));
    const response = await searchWeb(web, 'Python official tutorial site:docs.python.org', 2, new AbortController().signal);
    expect(response.results.map((item) => item.url)).toEqual(['https://docs.python.org/3/tutorial/', 'https://docs.python.org/3/reference/']);
    expect(response).toMatchObject({ truncated: true, siteFilter: { include: ['docs.python.org'], exclude: [], removedResultCount: 5 } });
    expect(requester).toHaveBeenCalledOnce();
  });
  it('returns an explicit empty filtered result when Bing only returns off-site links', async () => {
    const { web } = readerWithResults(result('https://python.org/') + result('https://python.org/downloads/') + result('https://pythonlang.cn/'));
    const response = await searchWeb(web, 'Python official tutorial site:docs.python.org', 3, new AbortController().signal);
    expect(response).toMatchObject({ results: [], truncated: false, siteFilter: { include: ['docs.python.org'], removedResultCount: 3 } });
    expect(response.note).toContain('Never substitute off-site links');
  });
  it('computes truncation from matching links, not discarded off-site links', async () => {
    const { web } = readerWithResults(result('https://python.org/') + result('https://docs.python.org/3/tutorial/') + result('https://pythonlang.cn/'));
    expect(await searchWeb(web, 'site:docs.python.org', 1, new AbortController().signal)).toMatchObject({
      results: [{ url: 'https://docs.python.org/3/tutorial/' }], truncated: false,
    });
  });
  it.each([
    ['SITE:"DOCS.PYTHON.ORG."', ['https://docs.python.org/3/tutorial/', 'https://docs.python.org/2/']],
    ['site:https://docs.python.org/3/', ['https://docs.python.org/3/tutorial/']],
    ['(site:docs.python.org OR site:python.org) -site:python.org/2/', ['https://docs.python.org/3/tutorial/', 'https://python.org/']],
    ['"site:docs.python.org" -site:python.org', ['https://example.org/']],
    ['"the word site:docs.python.org"', ['https://docs.python.org/3/tutorial/', 'https://docs.python.org/2/', 'https://python.org/', 'https://example.org/']],
  ])('honors normalized, excluded and quoted scopes for %s', async (query, expected) => {
    const { web } = readerWithResults(['https://docs.python.org/3/tutorial/', 'https://docs.python.org/2/', 'https://python.org/', 'https://example.org/'].map((url) => result(url)).join(''));
    expect((await searchWeb(web, query, 10, new AbortController().signal)).results.map((item) => item.url)).toEqual(expected);
  });
  it.each(['site:', 'site:docs.python.org:8443', 'site:https://user:pass@docs.python.org', 'site:docs.python.org?query=1'])('rejects a malformed site restriction before any request: %s', async (query) => {
    const { web, requester } = readerWithResults(result('https://example.org/'));
    await expect(searchWeb(web, query, 5, new AbortController().signal)).rejects.toMatchObject({ code: 'tool.invalidArguments' });
    expect(requester).not.toHaveBeenCalled();
  });
});
