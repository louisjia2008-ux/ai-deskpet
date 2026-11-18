import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { textPage } from './text-page';
import type { TextPageOptions } from './text-page';
import { ToolFailure } from '../runtime/tool-failure';

type Node = DefaultTreeAdapterMap['node'];
const blocks = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tr', 'ul']);

// Parse only; never execute scripts or load subresources. Retain all document
// text (including navigation), links, tables, code and structured data. The
// tool then returns explicit literal pages with a cursor and a source hash.
export const readableHtml = (html: string, pageUrl: string): string => {
  const document = parse(html);
  let baseUrl = pageUrl;
  let foundBase = false;
  const chunks: Array<{ text: string; pre: boolean }> = [];
  const stack: Array<{ node?: Node; text?: string; pre: boolean }> = [{ node: document, pre: false }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.text !== undefined) { chunks.push({ text: entry.text, pre: entry.pre }); continue; }
    const node = entry.node!;
    if ('value' in node) { chunks.push({ text: entry.pre ? node.value : node.value.replace(/\s+/gu, ' '), pre: entry.pre }); continue; }
    if (!('childNodes' in node)) continue;
    const tag = 'tagName' in node ? node.tagName : '';
    const attr = (name: string): string => 'attrs' in node ? node.attrs.find((item) => item.name === name)?.value ?? '' : '';
    if (tag === 'base' && !foundBase && attr('href')) {
      foundBase = true;
      try { const base = new URL(attr('href'), pageUrl); if (['http:', 'https:'].includes(base.protocol)) baseUrl = base.href; }
      catch { /* Invalid base URLs use the page URL. */ }
    }
    if (tag === 'style' || tag === 'template' || (tag === 'script' && attr('type').trim().toLowerCase() !== 'application/ld+json')) continue;
    let before = blocks.has(tag) ? '\n' : '';
    let after = before;
    if (tag === 'br') before = '\n';
    if (/^h[1-6]$/u.test(tag)) { before = `\n${'#'.repeat(Number(tag[1]))} `; after = '\n'; }
    if (tag === 'title') { before = '\nTitle: '; after = '\n'; }
    if (tag === 'td' || tag === 'th') after = '\t';
    if (tag === 'li') before = '\n- ';
    if (tag === 'pre') { before = '\n```\n'; after = '\n```\n'; }
    if (tag === 'script') { before = '\nStructured data:\n'; after = '\n'; }
    if (tag === 'img' && attr('alt')) before = attr('alt');
    if (tag === 'meta' && attr('name').toLowerCase() === 'description') before = `\nDescription: ${attr('content')}\n`;
    if (tag === 'a' && attr('href')) {
      try {
        const link = new URL(attr('href'), baseUrl);
        if (['http:', 'https:', 'mailto:'].includes(link.protocol)) after = ` (${link.href})`;
      } catch { /* Keep the link text even for malformed URLs. */ }
    }
    chunks.push({ text: before, pre: entry.pre });
    if (after) stack.push({ text: after, pre: entry.pre });
    const pre = entry.pre || tag === 'pre' || tag === 'script';
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push({ node: node.childNodes[index]!, pre });
  }
  const normalize = (text: string) => text.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n');
  let output = ''; let normal = '';
  for (const chunk of chunks) {
    if (chunk.pre) { output += normalize(normal) + chunk.text; normal = ''; }
    else normal += chunk.text;
  }
  return (output + normalize(normal)).trim();
};

export const webToolContent = (response: { url: string; contentType: string; text: string }, format: 'text' | 'html' = 'text', page: TextPageOptions = {}) => {
  if (response.contentType !== 'text/html' || format === 'html') return { ...response, ...textPage(response.text, page), format: response.contentType === 'text/html' ? 'html' : 'text' };
  const text = readableHtml(response.text, response.url);
  if (!text.trim()) throw new ToolFailure('tool.network', 'tool.network', 'web.emptyContent');
  return { ...response, ...textPage(text, page), format: 'text', sourceCharacters: response.text.length };
};
