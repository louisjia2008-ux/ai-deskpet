import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { ToolFailure } from '../../runtime/tool-failure';
import { createPinnedRequester, SecureWebReader } from '../../tools/web-reader';
import type { WebReaderOptions } from '../../tools/web-reader';

const origin = 'https://mp.weixin.qq.com';
const articleFields = ['__biz', 'mid', 'idx', 'sn', 'chksm'] as const;
const maxArticleCharacters = 12_000;

export const normalizeWeChatArticleUrl = (input: string): string | null => {
  const raw = input.trim();
  if (raw.length > 4_096 || !/^https?:\/\/mp\.weixin\.qq\.com\//iu.test(raw)) return null;
  const url = URL.parse(raw);
  if (!url || url.username || url.password || url.host !== 'mp.weixin.qq.com') return null;
  if (/^\/s\/[A-Za-z0-9_-]{10,80}$/u.test(url.pathname)) return origin + url.pathname;
  if (url.pathname !== '/s' && url.pathname !== '/s/') return null;

  const clean = new URL(url.pathname, origin);
  for (const field of articleFields) {
    const values = url.searchParams.getAll(field);
    const value = values[0];
    if (!value && field === 'chksm' && values.length === 0) continue;
    if (values.length !== 1 || !value || !/^[A-Za-z0-9_+/=-]{1,160}$/u.test(value)) return null;
    clean.searchParams.set(field, value);
  }
  return clean.href.length <= 500 ? clean.href : null;
};

export type WeChatArticleReadResult =
  | { status: 'ok'; url: string; title: string; account: string; body: string; truncated: boolean; hasImages: boolean }
  | { status: 'invalid-link' | 'verification-required' | 'unavailable' | 'image-only' | 'network-error' };

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const attr = (element: Element, name: string): string | undefined => element.attrs.find(item => item.name === name)?.value;
const skippedTags = new Set(['audio', 'button', 'embed', 'form', 'iframe', 'input', 'nav', 'noscript', 'object', 'script', 'style', 'svg', 'template', 'textarea', 'video']);
const blockTags = new Set(['article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
const stripInvisible = (value: string): string => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, '');
const singleLine = (value: string): string => stripInvisible(value).replace(/\s+/gu, ' ').trim();

const isHidden = (node: Element): boolean =>
  attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true'
  || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?=\s*(?:!important)?\s*(?:;|$))/iu.test(attr(node, 'style') ?? '');

function* elements(root: Node): Generator<Element> {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ('tagName' in node) {
      if (skippedTags.has(node.tagName)) continue;
      yield node;
    }
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]!);
    }
  }
}

const articleText = (root: Element): { text: string; images: number } => {
  const chunks: string[] = [];
  // WeChat's article container can start hidden and get revealed by its scripts.
  const stack: (Node | string)[] = [...root.childNodes].reverse();
  let images = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node === 'string') { chunks.push(node); continue; }
    if ('value' in node) { chunks.push(stripInvisible(node.value).replace(/\s+/gu, ' ')); continue; }
    if (!('tagName' in node) || skippedTags.has(node.tagName) || isHidden(node)) continue;
    const tag = node.tagName;
    if (tag === 'img' || tag === 'mp-img') { images++; continue; }
    if (tag === 'br') { chunks.push('\n'); continue; }
    if (blockTags.has(tag)) {
      chunks.push(tag === 'li' ? '\n• ' : '\n');
      stack.push('\n');
    }
    if (tag === 'td' || tag === 'th') stack.push('\t');
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]!);
  }
  const text = chunks.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n[ \t]+/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  return { text, images };
};

const extractArticle = (html: string, url: string): WeChatArticleReadResult => {
  let content: Element | undefined;
  let openGraphTitle = '';
  let visibleTitle = '';
  let account = '';
  for (const node of elements(parse(html))) {
    if (node.tagName === 'meta' && attr(node, 'property') === 'og:title') {
      openGraphTitle ||= singleLine(attr(node, 'content') ?? '');
    }
    const id = attr(node, 'id');
    if (id === 'js_content') content ??= node;
    if (id === 'activity-name') visibleTitle ||= singleLine(articleText(node).text);
    if (id === 'js_name') account ||= singleLine(articleText(node).text);
    if (content && (openGraphTitle || visibleTitle) && account) break;
  }
  const title = openGraphTitle || visibleTitle;
  if (!title || !content) {
    return { status: /当前环境异常|完成验证后即可|请在微信客户端打开/iu.test(html) ? 'verification-required' : 'unavailable' };
  }
  const { text, images } = articleText(content);
  const meaningfulText = text.replace(/[^\p{L}\p{N}]/gu, '');
  if (images > 0 && meaningfulText.length < 16) return { status: 'image-only' };
  if (!meaningfulText) return { status: 'unavailable' };
  const truncated = text.length > maxArticleCharacters;
  return {
    status: 'ok', url, title: title.slice(0, 200), account: account.slice(0, 100),
    body: truncated ? text.slice(0, maxArticleCharacters).trimEnd() : text,
    truncated, hasImages: images > 0,
  };
};

const requestArticle = createPinnedRequester({
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'zh-CN,zh;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

export const createWeChatArticleReader = (transport: Pick<WebReaderOptions, 'requester' | 'resolver'> = {}) => {
  const reader = new SecureWebReader({
    requester: requestArticle,
    ...transport,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 12_000,
    maxRedirects: 3,
    normalizeTarget: (url) => {
      if (url.origin === origin && url.pathname === '/mp/wappoc_appmsgcaptcha') {
        throw new ToolFailure('tool.webTarget', 'WeChat verification required.', 'wechat.articleVerification');
      }
      const clean = normalizeWeChatArticleUrl(url.href);
      if (!clean) throw new ToolFailure('tool.webTarget', 'Unsupported WeChat article redirect.', 'wechat.articleRedirect');
      return new URL(clean);
    },
  });
  return async (input: string, signal?: AbortSignal): Promise<WeChatArticleReadResult> => {
    signal?.throwIfAborted();
    const url = normalizeWeChatArticleUrl(input);
    if (!url) return { status: 'invalid-link' };
    try {
      const response = await reader.read(url, signal);
      if (response.contentType !== 'text/html') return { status: 'unavailable' };
      return extractArticle(response.text, response.url);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ToolFailure) {
        if (error.detail === 'wechat.articleVerification') return { status: 'verification-required' };
        if (['wechat.articleRedirect', 'web.pageNotFound', 'web.pageAccessDenied', 'web.emptyContent', 'web.unsupportedContent', 'web.responseTooLarge'].includes(error.detail ?? '')) {
          return { status: 'unavailable' };
        }
      }
      return { status: 'network-error' };
    }
  };
};

export const readWeChatArticle = createWeChatArticleReader();
