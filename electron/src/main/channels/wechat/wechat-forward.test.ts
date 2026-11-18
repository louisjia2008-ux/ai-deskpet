import { describe, expect, test, vi } from 'vitest';
import type { WeChatRich } from '../../../shared/wechat-rich';
import { WeChatForwards } from './wechat-forward';

const binding = 'a'.repeat(64);
const eventId = 'b'.repeat(64);
const card = (key = 'c'.repeat(64)): WeChatRich => ({ kind: 'forward', evidence: '聊天记录', forwardKey: key,
  title: '合成卡片', record: { entries: [...Array.from({ length: 15 }, (_, i) => ({
    kind: 'text' as const, speaker: '成员甲', at: `周四 09:${i}`, text: `还在商量 ${i} ${'备选'.repeat(15)}`,
  })), { kind: 'text', text: '最后决定周五交，原话保留。', speaker: '成员乙', at: '周四 09:40' },
  { kind: 'forward' }, { kind: 'voice' }], truncated: false } });
const guard = { signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}) };
const host = () => ({ complete: vi.fn<(prompt: string, data: string) => Promise<string>>(async () => JSON.stringify({ answer: '周五交', sources: [16] })),
  save: vi.fn(async (item: unknown) => String(item && '已存进收件箱。')) });

describe('owner forwards', () => {
  test('paginates locally through the tail and shows unavailable media without calling a model or saving', async () => {
    const forwards = new WeChatForwards();
    const reply = host();
    const first = await forwards.receive({ binding, text: '[合并转发]', rich: card() }, reply, guard);
    expect(first).toContain('#1 成员甲 · 周四 09:0');
    const total = Number(/1\/(\d+)/u.exec(first)![1]);
    const parts = await Promise.all(Array.from({ length: total }, (_, index) => forwards.command({ binding, eventId,
      text: `读转发 cccccccc ${index + 1}` }, reply, guard)));
    expect(parts.join(' ')).toContain('#16 成员乙 · 周四 09:40 最后决定周五交');
    expect(parts.join(' ')).toContain('语音，正文未读取');
    expect(parts.join(' ')).toContain('嵌套聊天记录，正文未读取');
    expect(parts.every(part => part!.length <= 500)).toBe(true);
    expect(reply.complete).not.toHaveBeenCalled();
    expect(reply.save).not.toHaveBeenCalled();
  });

  test('uses the exact card and actual source row for a later quoted question, and saves only explicitly', async () => {
    const forwards = new WeChatForwards();
    const reply = host();
    await forwards.receive({ binding, text: '[合并转发]', rich: card() }, reply, guard);
    await forwards.receive({ binding, text: '[合并转发]', rich: { ...card('d'.repeat(64)), record: { entries: [{ kind: 'text', text: '无关卡片' }], truncated: false } } }, reply, guard);
    const quote = { kind: 'quote' as const, evidence: '引用：聊天记录', forwardKey: 'c'.repeat(64) };
    const answer = await forwards.receive({ binding, text: '最后哪天交？', rich: quote }, reply, guard);
    expect(answer).toBe('周五交 原话 #16 成员乙「最后决定周五交，原话保留。」');
    const payload = JSON.parse(reply.complete.mock.calls[0]![1]);
    expect(payload.source.some((row: { index: number }) => row.index === 16)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('无关卡片');
    await forwards.receive({ binding, text: '这句话前面呢？', rich: quote }, reply, guard);
    expect(JSON.parse(reply.complete.mock.calls[1]![1]).referencedRows).toEqual([16]);
    expect(reply.save).not.toHaveBeenCalled();
    expect(await forwards.receive({ binding, text: '存', rich: quote }, reply, guard)).toContain('已存进收件箱');
    expect(reply.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'forward', source: '微信私聊转发' }), guard);
  });

  test('rejects an invalid model citation and expired or cross-owner records', async () => {
    let now = 1000;
    const forwards = new WeChatForwards(() => now);
    const reply = host();
    await forwards.receive({ binding, text: '[合并转发]', rich: card() }, reply, guard);
    reply.complete.mockResolvedValueOnce(JSON.stringify({ answer: '合成捏造回答', sources: [80] }));
    expect(await forwards.command({ binding, eventId, text: '问转发 合成问题' }, reply, guard)).not.toContain('合成捏造回答');
    expect(await forwards.command({ binding: 'e'.repeat(64), eventId, text: '读转发 cccccccc' }, reply, guard)).toContain('找不到');
    now += 31 * 60 * 1_000;
    expect(await forwards.command({ binding, eventId, text: '读转发 cccccccc' }, reply, guard)).toContain('找不到');
  });

  test('reads deliberate single-message copies without inventing metadata', async () => {
    const reply = host();
    const text = await new WeChatForwards().command({ binding, eventId, text: '转发原文 /pause-queue' }, reply, guard);
    expect(text).toContain('发言人未知 · 时间未知 /pause-queue');
    expect(reply.complete).not.toHaveBeenCalled();
  });
});
