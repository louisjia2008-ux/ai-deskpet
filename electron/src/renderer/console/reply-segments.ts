import type { ReplySegment } from '../../shared/automation';

const MAX_SEGMENTS = 6;
const MARKDOWN_BLOCK = /^ {0,3}(?:#{1,6} |[-*+] |\d{1,3}[.)] |\||>)/mu;
const fenceStart = (line: string): { character: string; length: number } | null => {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match?.[1] ? { character: match[1][0]!, length: match[1].length } : null;
};
const closesFence = (line: string, fence: { character: string; length: number }): boolean => {
  const match = /^ {0,3}(`+|~+)\s*$/u.exec(line);
  return match?.[1]?.[0] === fence.character && match[1].length >= fence.length;
};
const paragraphs = (content: string): string[] => {
  const result: string[] = [];
  let current = '', fence: { character: string; length: number } | null = null;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    current += line;
    if (fence !== null) { if (closesFence(line, fence)) fence = null; continue; }
    const opening = fenceStart(line);
    if (opening !== null) { fence = opening; continue; }
    if (line.trim().length === 0 && current.trim().length > 0) { result.push(current); current = ''; }
  }
  if (current.trim().length > 0) result.push(current);
  else if (current.length > 0 && result.length > 0) result[result.length - 1] += current;
  return result;
};

/** Long plain paragraphs may split at sentence endings, never at a token limit
 * or inside a fenced block. Concatenating the output preserves the source text. */
const sentences = (paragraph: string): string[] => {
  if (paragraph.length <= 240 || /^ {0,3}(?:`{3,}|~{3,})/mu.test(paragraph)) return [paragraph];
  const result: string[] = [];
  let start = 0;
  for (const match of paragraph.matchAll(/[.!?]["”’）)]*[ \t]+|[。！？]["”’）)]*/gu)) {
    const end = match.index + match[0].length;
    if (end - start >= 100 && paragraph.slice(end).trim().length > 0) { result.push(paragraph.slice(start, end)); start = end; }
  }
  if (start < paragraph.length) result.push(paragraph.slice(start));
  return result;
};
const expressionFor = (text: string): ReplySegment['expression'] => {
  if (/^ {0,3}(?:`{3,}|~{3,})/mu.test(text)) return 'neutral';
  if (/[?？]\s*$/u.test(text.trim())) return 'curious';
  if (/\b(?:no rush|take your time|one step at a time)\b|慢慢来|别着急|一步一步/iu.test(text)) return 'reassuring';
  if (/\b(?:glad|congratulations|well done|thank you)\b|太好了|谢谢|恭喜/iu.test(text)) return 'happy';
  return 'neutral';
};

/** Local presentation only. The message, request, evidence and usage identities
 * remain owned by the parent assistant turn. No protocol markers are executed. */
export const segmentAssistantReply = (messageId: string, content: string): ReplySegment[] => {
  if (content.trim().length === 0) return [];
  // Tables, lists and headings read as one document; splitting would break them.
  if (MARKDOWN_BLOCK.test(content)) return [{ id: `${messageId}:segment:0`, text: content, expression: 'neutral' }];
  const chunks = paragraphs(content).flatMap(sentences);
  const bounded = chunks.length > MAX_SEGMENTS
    ? [...chunks.slice(0, MAX_SEGMENTS - 1), chunks.slice(MAX_SEGMENTS - 1).join('')]
    : chunks;
  return bounded.map((text, index) => ({ id: `${messageId}:segment:${index}`, text, expression: expressionFor(text) }));
};
