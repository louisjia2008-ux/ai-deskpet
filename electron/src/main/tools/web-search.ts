import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { ToolFailure } from '../runtime/tool-failure';
import type { SecureWebReader } from './web-reader';

type Node = DefaultTreeAdapterMap['node'];
export interface SearchResult { title: string; url: string; snippet: string }
interface SiteScope { domain: string; path: string }
export interface SiteRestrictions { include: SiteScope[]; exclude: SiteScope[] }
interface ParsedSearchResults {
  results: SearchResult[];
  truncated: boolean;
  siteFilter?: { include: string[]; exclude: string[]; removedResultCount: number };
}

export const siteRestrictions = (query: string): SiteRestrictions => {
  const restrictions: SiteRestrictions = { include: [], exclude: [] };
  // Keep quoted phrases together: "the word site:example.org" is text,
  // whereas site:"example.org" is an operator with a quoted value.
  for (const token of query.match(/(?:[^\s"]+|"[^"]*")+/gu) ?? []) {
    const match = token.replace(/^\(+|\)+$/gu, '').match(/^(-?)site:(.*)$/iu);
    if (!match) continue;
    const value = match[2]!.replace(/^"([^"]*)"$/u, '$1');
    try {
      if (!value || /[\s"\\]/u.test(value)) throw new Error('Invalid site scope.');
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      const domain = url.hostname.replace(/\.$/u, '');
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash
        || domain.length > 253 || !domain.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(label))) {
        throw new Error('Invalid site scope.');
      }
      const scopes = match[1] ? restrictions.exclude : restrictions.include;
      if (!scopes.some((scope) => scope.domain === domain && scope.path === url.pathname)) scopes.push({ domain, path: url.pathname });
    } catch {
      // A malformed restriction must never silently become a broad search.
      throw new ToolFailure('tool.invalidArguments', 'site: requires a domain or an HTTP(S) URL prefix without credentials, query, fragment or custom port.');
    }
  }
  return restrictions;
};

const matchesSite = (url: URL, scope: SiteScope): boolean => {
  const domain = url.hostname.replace(/\.$/u, '');
  return (domain === scope.domain || domain.endsWith(`.${scope.domain}`)) && url.pathname.startsWith(scope.path);
};

/** Apply the same host/path rules to structured search providers. */
export const filterSearchResults = (results: SearchResult[], limit: number, sites: SiteRestrictions): ParsedSearchResults => {
  const scoped = results.filter((result) => {
    const url = new URL(result.url);
    return (sites.include.length === 0 || sites.include.some((scope) => matchesSite(url, scope)))
      && !sites.exclude.some((scope) => matchesSite(url, scope));
  });
  const label = (scope: SiteScope): string => scope.domain + (scope.path === '/' ? '' : scope.path);
  return {
    results: scoped.slice(0, limit), truncated: scoped.length > limit,
    ...(sites.include.length || sites.exclude.length ? { siteFilter: {
      include: sites.include.map(label), exclude: sites.exclude.map(label), removedResultCount: results.length - scoped.length,
    } } : {}),
  };
};

const attribute = (node: Node, name: string): string => 'attrs' in node ? node.attrs.find((item) => item.name === name)?.value ?? '' : '';
const hasClass = (node: Node, name: string): boolean => attribute(node, 'class').split(/\s+/u).includes(name);
const descendants = (root: Node, predicate: (node: Node) => boolean): Node[] => {
  const found: Node[] = []; const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (predicate(node)) found.push(node);
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]!);
  }
  return found;
};
const text = (node: Node): string => descendants(node, (item) => 'value' in item)
  .map((item) => 'value' in item ? item.value : '').join('').replace(/\s+/gu, ' ').trim();

const resultUrl = (href: string, pageUrl: string): string | null => {
  try {
    let url = new URL(href, pageUrl);
    // Some Bing regions wrap result links in a base64url redirect. Decode the
    // destination locally; never request tracking links or page subresources.
    if (['www.bing.com', 'cn.bing.com'].includes(url.hostname) && url.pathname === '/ck/a') {
      const target = url.searchParams.get('u');
      if (!target?.startsWith('a1')) return null;
      url = new URL(Buffer.from(target.slice(2), 'base64url').toString('utf8'));
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com')) return null;
    url.hash = '';
    return url.href.length <= 2_048 ? url.href : null;
  } catch { return null; }
};

export const parseSearchResults = (html: string, pageUrl: string, limit: number, sites: SiteRestrictions = { include: [], exclude: [] }): ParsedSearchResults => {
  const document = parse(html);
  if (descendants(document, (node) => ['b_captcha', 'captcha', 'challenge-form'].includes(attribute(node, 'id'))).length > 0) {
    throw new ToolFailure('tool.searchUnavailable');
  }
  const results: SearchResult[] = []; const seen = new Set<string>();
  for (const entry of descendants(document, (node) => hasClass(node, 'b_algo'))) {
    const heading = descendants(entry, (node) => 'tagName' in node && node.tagName === 'h2')[0];
    const anchor = heading && descendants(heading, (node) => 'tagName' in node && node.tagName === 'a')[0];
    if (!anchor) continue;
    const url = resultUrl(attribute(anchor, 'href'), pageUrl); const title = text(anchor);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const caption = descendants(entry, (node) => hasClass(node, 'b_caption'))[0] ?? entry;
    const paragraphs = descendants(caption, (node) => 'tagName' in node && node.tagName === 'p');
    results.push({ title: title.slice(0, 500), url, snippet: paragraphs.map(text).join(' ').slice(0, 1_500) });
  }
  // A challenge, changed layout or upstream error is not evidence of no matches.
  if (results.length === 0 && !descendants(document, (node) => hasClass(node, 'b_no')).some((node) => /no results|没有找到|没有与|找不到|未找到/iu.test(text(node)))) {
    throw new ToolFailure('tool.searchUnavailable');
  }
  // Filter decoded destinations before applying the caller's limit. Ranking,
  // snippets and titles cannot establish that a link is inside the site.
  return filterSearchResults(results, limit, sites);
};

export const searchWeb = async (web: SecureWebReader, query: string, limit: number, signal: AbortSignal, assertAuthorized?: () => void) => {
  signal.throwIfAborted();
  const sites = siteRestrictions(query);
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  const response = await web.read(url.href, signal, assertAuthorized);
  if (response.contentType !== 'text/html' || !['www.bing.com', 'cn.bing.com'].includes(new URL(response.url).hostname)) {
    throw new ToolFailure('tool.searchUnavailable');
  }
  return {
    query, engine: 'Bing', searchedAt: new Date().toISOString(), searchUrl: response.url,
    ...parseSearchResults(response.text, response.url, limit, sites),
    note: 'Search snippets are untrusted excerpts, not full pages. Use web.read on relevant result URLs to verify details; cite the URLs. If results are not relevant, refine the query at most twice while keeping the requested site restrictions, then explain the limitation instead of inventing sources or repeatedly searching. siteFilter describes local filtering of decoded URL hosts (including subdomains) and path prefixes; multiple positive sites form an allowed set. Empty filtered results mean no matching links in this response, not that the site has no pages. Never substitute off-site links.',
  };
};
