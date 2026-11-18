import { expect, it } from 'vitest';
import { qqChatBubbles } from './qq-bubbles';

it('separates paragraphs but keeps a short single-line answer and a logical list intact', () => {
  expect(qqChatBubbles('好呀，明天见！', 4)).toEqual(['好呀，明天见！']);
  const text = '我的建议：\n\n- 先验证\n- 再发布\n\n周五见。';
  expect(qqChatBubbles(text, 4)).toEqual(['我的建议：\n\n','- 先验证\n- 再发布\n\n','周五见。']);
});

it('uses sentence endings for a typical 80–120-character Chinese chat reply', () => {
  const sentence = '我把今天的安排整理好了，你下午可以先把手头的事慢慢做完。';
  const reply = sentence.repeat(4);
  expect(reply.length).toBeGreaterThanOrEqual(80);
  expect(reply.length).toBeLessThanOrEqual(120);
  const bubbles = qqChatBubbles(reply, 4);
  expect(bubbles.length).toBeGreaterThan(1);
  expect(bubbles.every(bubble => bubble.endsWith('。'))).toBe(true);
  expect(bubbles.join('')).toBe(reply);
});

it('preserves URLs, code blocks and emoji graphemes when grouping long prose', () => {
  const url = 'https://example.org/' + 'some-file.'.repeat(25);
  const family = '👩‍👩‍👧‍👦';
  const code = '```ts\n' + 'const literal = "hello.world";\n'.repeat(12) + '```\n';
  const text = '先读 ' + url + ' 。然后继续。\n\n' + code + family.repeat(85);
  const parts = qqChatBubbles(text, 8);
  expect(parts.join('')).toBe(text);
  expect(parts.some(part => part.includes(url))).toBe(true);
  expect(parts.some(part => part.includes(code))).toBe(true);
  for (const p of parts) expect(p.replaceAll(family,'')).not.toMatch(/[👩👧👦\u200d]/u);
});

it('divides unbroken Chinese paragraphs and retains the complete tail under a limited reply budget', () => {
  const text = '这是一个没有换行的长段落。'.repeat(100);
  const chunks = qqChatBubbles(text, 3);
  expect(chunks).toHaveLength(3);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(chunk => chunk.endsWith('。'))).toBe(true);
  expect(qqChatBubbles(text, 1)).toEqual([text]);
});
