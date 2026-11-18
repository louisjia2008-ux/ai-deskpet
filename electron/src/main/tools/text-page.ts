import { createHash } from 'node:crypto';
import { z } from 'zod';

export const textPageShape = {
  offset: z.number().int().min(0).max(2_000_000).optional().describe('Character offset, normally the nextOffset returned by the previous page.'),
  maxCharacters: z.number().int().min(256).max(16_000).optional().describe('Maximum characters per page; defaults to 8000. Follow nextOffset to read more.'),
  find: z.string().trim().min(1).max(200).optional().describe('Literal text to locate, ignoring case. Returns the surrounding excerpt and offset of each match instead of a page. Prefer this to paging through a long source.'),
};
export interface TextPageOptions { offset?: number; maxCharacters?: number; find?: string }

const MAX_FIND_MATCHES = 8;
const FIND_CONTEXT_CHARACTERS = 500;

/** Excerpts around literal matches, in source order, within the page size. */
const findInText = (source: string, find: string, maxCharacters: number) => {
  const haystack = source.toLowerCase(), needle = find.toLowerCase();
  const matches: Array<{ offset: number; excerpt: string }> = [];
  let matchCount = 0, used = 0, shownUntil = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    matchCount += 1;
    if (at < shownUntil || matches.length >= MAX_FIND_MATCHES) continue;
    const start = Math.max(shownUntil, at - FIND_CONTEXT_CHARACTERS), end = Math.min(source.length, at + needle.length + FIND_CONTEXT_CHARACTERS);
    if (used + end - start > maxCharacters) continue;
    matches.push({ offset: at, excerpt: source.slice(start, end) });
    used += end - start; shownUntil = end;
  }
  return { matches, matchCount };
};

/** Literal, explicitly partial source pages. Never summarize or cut a result
 * after it has entered the required model/tool exchange. */
export const textPage = (source: string, options: TextPageOptions = {}) => {
  if (options.find !== undefined) {
    const found = findInText(source, options.find, options.maxCharacters ?? 8000);
    return { text: found.matches.map((match) => `[offset ${match.offset}]\n${match.excerpt}`).join('\n\n'), offset: 0, totalCharacters: source.length, nextOffset: null,
      truncated: true, sourceSHA256: createHash('sha256').update(source).digest('hex'), find: options.find, matchCount: found.matchCount, matchOffsets: found.matches.map((match) => match.offset) };
  }
  let offset = Math.min(options.offset ?? 0, source.length);
  if (offset > 0 && /[\uDC00-\uDFFF]/u.test(source[offset] ?? '') && /[\uD800-\uDBFF]/u.test(source[offset - 1]!)) offset--;
  let end = Math.min(source.length, offset + (options.maxCharacters ?? 8000));
  if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(source[end]!)) end--;
  return { text: source.slice(offset, end), offset, totalCharacters: source.length, nextOffset: end < source.length ? end : null,
    truncated: offset > 0 || end < source.length, sourceSHA256: createHash('sha256').update(source).digest('hex') };
};
