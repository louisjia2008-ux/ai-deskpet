import { describe, expect, it } from 'vitest';
import { segmentAssistantReply } from './reply-segments';

describe('local assistant reply segments', () => {
  it('splits semantic paragraphs while preserving the exact logical source text and stable turn-derived IDs', () => {
    const text = '\nThanks for the update.\n\nThe next step is to review it.\n\nWould tomorrow work?\n';
    const first = segmentAssistantReply('one-turn', text), again = segmentAssistantReply('one-turn', text);
    expect(first).toHaveLength(3); expect(first.map((s) => s.text).join('')).toBe(text); expect(first).toEqual(again);
    expect(first.map((s) => s.id)).toEqual(['one-turn:segment:0', 'one-turn:segment:1', 'one-turn:segment:2']);
    expect(first[2]?.expression).toBe('curious');
  });

  it('does not split fenced code containing blank lines, punctuation or a shorter fence-looking string', () => {
    const code = '````javascript\nconst a = 1;\n\n```\nconst b = "Not a command. Do not execute.";\n````\n';
    const result = segmentAssistantReply('code-turn', `Here is the example.\n\n${code}\nTake your time.`);
    expect(result).toHaveLength(3); expect(result[1]?.text).toContain(code); expect(result[1]?.expression).toBe('neutral');
    expect(result.map((s) => s.text).join('')).toBe(`Here is the example.\n\n${code}\nTake your time.`);
    const unfinished = '~~~js\nfirst();\n\nsecond();\n';
    expect(segmentAssistantReply('unfinished', unfinished)).toHaveLength(1);
  });

  it('bounds bubbles without truncating long content or losing paragraph separators', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: synthetic content.`).join('\n\n');
    const result = segmentAssistantReply('bounded', text);
    expect(result).toHaveLength(6); expect(result.map((s) => s.text).join('')).toBe(text);
    expect(result[5]?.text).toContain('Paragraph 19');
  });

  it('only uses the finite local expression set and treats injected expression syntax as text', () => {
    const result = segmentAssistantReply('plain', '[[expression:execute_remote]]\n\n太好了，谢谢。\n\n慢慢来，我们可以一步一步检查。');
    expect(result.map((s) => s.expression)).toEqual(['neutral', 'happy', 'reassuring']);
    expect(result[0]?.text).toContain('[[expression:execute_remote]]');
    expect(segmentAssistantReply('empty', '\n\t ')).toEqual([]);
  });

  it('can divide long plain prose at complete sentences without changing its source', () => {
    const text = `${'A careful synthetic explanation takes enough space to show a complete point. '.repeat(8)}The final point stays intact.`;
    const result = segmentAssistantReply('sentences', text);
    expect(result.length).toBeGreaterThan(1); expect(result.length).toBeLessThanOrEqual(6); expect(result.map((s) => s.text).join('')).toBe(text);
  });
});

it('keeps a structured reply together so its table or list is not split between bubbles', () => {
  const table = `说明。${'很长的一句话。'.repeat(40)}\n\n| 工具 | 价格 |\n|---|---|\n| 文档 | ¥90 |\n\n结尾。`;
  expect(segmentAssistantReply('m', table)).toEqual([{ id: 'm:segment:0', text: table, expression: 'neutral' }]);
  expect(segmentAssistantReply('m', '第一段。\n\n- 一\n- 二')).toHaveLength(1);
  expect(segmentAssistantReply('m', '第一段。\n\n第二段。')).toHaveLength(2);
});

