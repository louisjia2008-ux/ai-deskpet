// Keep the exact authorized source. Each bubble is a contiguous slice and
// concatenating the slices reproduces it, including newlines and punctuation.
const LATIN_SOFT_LENGTH = 120;
const EAST_ASIAN_SOFT_LENGTH = 62;
const eastAsianText = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const listItem = /^\s*(?:[-+*•]|\d+[.)、])\s+/u;
const fence = /^ {0,3}(`{3,}|~{3,})/u;

function proseBubbles(line: string): string[] {
  const length = line.trimEnd().length;
  const eastAsianCharacters = line.match(eastAsianText)?.length ?? 0;
  const preferred = eastAsianCharacters >= length / 4 ? EAST_ASIAN_SOFT_LENGTH : LATIN_SOFT_LENGTH;
  if (length <= preferred) return [line];
  const results: string[] = [];
  let start = 0, sentenceEnd = 0, phraseEnd = 0, fallback = 0;
  // A URL or inline code span counts as one unit even when it exceeds the
  // preferred bubble size. Grapheme boundaries keep emoji families together.
  const tokens = /https?:\/\/[^\s<>`，。！？]+|`[^`\r\n]+`/gu;
  function consume(end: number, boundary?: 'sentence' | 'phrase'): void {
    if (end - start > preferred) {
      let cut = sentenceEnd;
      // Avoid an isolated short opening such as “好。” if a later phrase fits.
      if (cut - start < preferred / 3 && phraseEnd > cut) cut = phraseEnd;
      if (cut <= start) cut = fallback;
      if (cut > start) { results.push(line.slice(start, cut)); start = cut; }
    }
    if (boundary === 'sentence') sentenceEnd = end;
    if (boundary === 'phrase') phraseEnd = end;
    if (fallback <= start && end - start >= preferred) fallback = end;
  }
  function plain(from: number, to: number): void {
    for (const {index, segment} of graphemes.segment(line.slice(from, to))) {
      const end = from + index + segment.length;
      if (/^[。！？!?；;]$/u.test(segment) || segment === '.' && /\s/u.test(line[end] ?? '')) consume(end, 'sentence');
      else if (/^[\s，,、：:]$/u.test(segment)) consume(end, 'phrase');
      else consume(end);
    }
  }
  let position = 0;
  for (const match of line.matchAll(tokens)) {
    plain(position, match.index);
    position = match.index + match[0].length;
    consume(position, 'phrase');
  }
  plain(position, line.length);
  results.push(line.slice(start));
  return results;
}

/** Over-budget paragraphs merge without truncating the tail or spending
 * additional replies as proactive messages. Prefer breaks near equal lengths. */
function fitBubbles(pieces: string[], max: number): string[] {
  if (pieces.length <= max) return pieces;
  const offsets = [0];
  for (const piece of pieces) offsets.push(offsets[offsets.length - 1]! + piece.length);
  const total = offsets[offsets.length - 1]!;
  const bubbles: string[] = [];
  let start = 0;
  for (let part = 1; part < max; part++) {
    let end = start + 1;
    const last = pieces.length - (max - part), target = total * part / max;
    while (end < last && Math.abs(offsets[end + 1]! - target) < Math.abs(offsets[end]! - target)) end++;
    bubbles.push(pieces.slice(start, end).join('')); start = end;
  }
  bubbles.push(pieces.slice(start).join(''));
  return bubbles;
}

export function qqChatBubbles(content: string, maximum: number): string[] {
  if (!content.trim() || !Number.isInteger(maximum) || maximum < 1) return [];
  if (maximum === 1) return [content];
  const pieces: string[] = [];
  let codeFence = '', list = false, leading = '';
  for (const line of content.match(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu) ?? []) {
    if (!line) continue;
    const marker = fence.exec(line)?.[1];
    if (codeFence) {
      pieces[pieces.length - 1] += line;
      if (marker?.startsWith(codeFence) && line.trim() === marker) codeFence = '';
    } else if (!line.trim()) {
      if (pieces.length) pieces[pieces.length - 1] += line;
      else leading += line;
      list = false;
    } else if (marker) {
      codeFence = marker; pieces.push(line); list = false;
    } else if (listItem.test(line) || list && /^\s+\S/u.test(line)) {
      if (list) pieces[pieces.length - 1] += line;
      else pieces.push(line);
      list = true;
    } else {
      for (const piece of proseBubbles(line)) {
        if (piece.trim()) pieces.push(piece);
        else if (pieces.length) pieces[pieces.length - 1] += piece;
        else leading += piece;
      }
      list = false;
    }
  }
  if (leading) pieces[0] = leading + pieces[0]!;
  return fitBubbles(pieces, maximum);
}
