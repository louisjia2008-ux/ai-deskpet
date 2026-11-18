import { describe, expect, it } from 'vitest';
import { QqStickerReplyFilter } from './qq-sticker-reply';
import type { QqStickerDecision, QqStickerScene } from './qq-sticker-reply';

function filterReply(chunks: string[]): { text: string; decision: QqStickerDecision | null } {
  const filter = new QqStickerReplyFilter();
  const text = chunks.map(chunk => filter.push(chunk)).join('') + filter.flush();
  return { text, decision: filter.decision };
}

describe('QQ private reply sticker hint', () => {
  const cases: Array<[string, QqStickerDecision]> = [
    ['[sticker:none]', { mode: 'text' }],
    ['[sticker:with-text:acknowledge]', { mode: 'with-text', scene: 'acknowledge' }],
    ['[sticker:only:noon]', { mode: 'sticker-only', scene: 'noon' }],
  ];

  it.each(cases)('decodes %s across every pair of chunk boundaries, including the line break', (hint, decision) => {
    const body = '收到啦 🐾\n这行也原样保留。';
    const wire = `${hint}\r\n${body}`;
    for (let split = 0; split <= wire.length; split++) {
      expect(filterReply([wire.slice(0, split), wire.slice(split)])).toEqual({ text: body, decision });
    }
    expect(filterReply(wire.split(''))).toEqual({ text: body, decision });
  });

  const scenes: QqStickerScene[] = ['greeting', 'noon', 'goodnight', 'amusement', 'celebrate', 'comfort', 'thanks', 'acknowledge', 'encourage', 'affection'];
  it.each(scenes)('accepts %s as a scene for both sticker modes', scene => {
    expect(filterReply([`[sticker:with-text:${scene}]\n正文`])).toEqual({ text: '正文', decision: { mode: 'with-text', scene } });
    expect(filterReply([`[sticker:only:${scene}]\n正文`])).toEqual({ text: '正文', decision: { mode: 'sticker-only', scene } });
  });

  it('does not delay ordinary streaming once the start cannot be a reserved hint', () => {
    const filter = new QqStickerReplyFilter();
    expect(filter.decision).toBeNull();
    expect(filter.push('[sti')).toBe('');
    expect(filter.push('ckers] 正文')).toBe('[stickers] 正文');
    expect(filter.decision).toEqual({ mode: 'text' });
    expect(filter.push('\n后续 [sticker:only:noon] 原样保留')).toBe('\n后续 [sticker:only:noon] 原样保留');
    expect(filter.flush()).toBe('');
  });

  it.each([' 正文', '\n[sticker:only:noon]\n逐字引用', '把 [sticker:none] 当作普通正文。', '[sticker', '[其他标记]'])('preserves ordinary output %j verbatim', text => {
    expect(filterReply(text.split(''))).toEqual({ text, decision: { mode: 'text' } });
  });

  it('removes only the first recognized hint and its optional single line separator', () => {
    expect(filterReply(['[sticker:none]', '\n', '\n  [sticker:only:noon]'])).toEqual({ text: '\n  [sticker:only:noon]', decision: { mode: 'text' } });
    expect(filterReply(['[sticker:with-text:thanks]谢谢'])).toEqual({ text: '谢谢', decision: { mode: 'with-text', scene: 'thanks' } });
  });

  it.each(['only:unknown', 'sticker-only:noon', 'WITH-TEXT:noon', 'with-text:noon ', 'none:thanks', ''])('hides malformed reserved hint %j and keeps its fallback text', hint => {
    expect(filterReply([`[sticker:${hint}]\n`, '自然正文。'])).toEqual({ text: '自然正文。', decision: { mode: 'text' } });
  });

  it('recovers at the next line when a reserved header is unclosed', () => {
    expect(filterReply(['[stick', 'er:only:noon', '\r', '\n午安。'])).toEqual({ text: '午安。', decision: { mode: 'text' } });
  });

  it('discards overlong reserved headers across chunks and never leaks them into the fallback', () => {
    const filter = new QqStickerReplyFilter();
    expect(filter.push('[sticker:with-text:')).toBe('');
    expect(filter.push('x'.repeat(100_000))).toBe('');
    expect(filter.push('y'.repeat(100_000))).toBe('');
    expect(filter.push(']\n保留正文。')).toBe('保留正文。');
    expect(filter.flush()).toBe('');
    expect(filter.decision).toEqual({ mode: 'text' });
  });

  it('flushes an incomplete ordinary prefix once and drops an unfinished reserved directive', () => {
    const literal = new QqStickerReplyFilter();
    expect(literal.push('[stic')).toBe('');
    expect(literal.flush()).toBe('[stic');
    expect(literal.flush()).toBe('');
    expect(filterReply(['[sticker:', 'only:noon'])).toEqual({ text: '', decision: { mode: 'text' } });
    expect(filterReply([])).toEqual({ text: '', decision: null });
  });

  it('exposes a complete hint before the fallback text arrives and never invents a fallback', () => {
    const filter = new QqStickerReplyFilter();
    expect(filter.push('[sticker:only:greeting]')).toBe('');
    expect(filter.decision).toEqual({ mode: 'sticker-only', scene: 'greeting' });
    expect(filter.flush()).toBe('');
  });
});
