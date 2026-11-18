import { expect, it, vi } from 'vitest';
import { generateWeChatGroupDigest, packWeChatDigestLines } from './wechat-group-digest';

const fixture = () => {
  const signal = new AbortController();
  const context = { binding: 'c'.repeat(64), dueAt: 6000, now: 6000, signal: signal.signal,
    assertCurrent: async () => signal.signal.throwIfAborted() };
  const settings = { time: '21:30', keywords: ['示例主题'], provider: null, groups: [{ id: 'a'.repeat(64), cloud: false }, { id: 'b'.repeat(64), cloud: true }] };
  const roster = vi.fn(async () => [{ id: settings.groups[0]!.id, title: '合成群' }]);
  const read = vi.fn(async () => ({ rows: [{ text: '示例主题 https://example.com/note', at: 5000, mentionsOwner: true }], truncated: true }));
  const complete = vi.fn(async () =>
    JSON.stringify({ points: ['合成要点', '伪造 https://example.net/unsafe'], questions: ['合成问题'] }));
  return { context, host: { settings, roster, read, complete }, signal };
};
it('omits non-roster groups and includes only real links, mentions, and bounded partial results', async () => {
  const { host, context } = fixture();
  const result = await generateWeChatGroupDigest(host, context);
  expect(host.read).toHaveBeenCalledTimes(1);
  expect(host.complete).toHaveBeenCalledWith({ id: host.settings.groups[0]!.id, cloud: false }, expect.any(String), expect.any(String), context);
  expect(result).toMatchObject({ issue: 'read', failures: 1 });
  expect(result.entries[0]?.detail).toContain('提到你或关键词');
  expect(result.entries[0]?.detail).toContain('待回应：合成问题');
  expect(result.messages.join(' ')).toContain('https://example.com/note');
  expect(result.messages.join(' ')).not.toContain('https://example.net/unsafe');
  expect(JSON.stringify(result)).not.toContain('示例主题 https://example.com/note');
});
it('never asks the model after authority is revoked by the source read', async () => {
  const { host, context, signal } = fixture();
  host.read.mockImplementationOnce(async () => { signal.abort(); return { rows: [], truncated: false }; });
  await expect(generateWeChatGroupDigest(host, context)).rejects.toThrow();
  expect(host.complete).not.toHaveBeenCalled();
  const parts = packWeChatDigestLines(['🐈'.repeat(700), 'next']);
  expect(parts).toHaveLength(2);
  expect(parts[0]).toHaveLength(460);
});

it('caps a full roster at four private bubbles while retaining all group details', async () => {
  const { host, context } = fixture();
  const groups = Array.from({ length: 12 }, (_, index) => ({ id: String(index).padStart(64, '0'), cloud: false }));
  host.settings.groups = groups;
  host.roster.mockResolvedValue(groups.map(({ id }, index) => ({ id, title: `测试群 ${index + 1} ${'长'.repeat(100)}` })));
  host.complete.mockResolvedValue(JSON.stringify({ points: Array.from({ length: 8 }, (_, index) => `${index + 1} ${'要点'.repeat(45)}`), questions: [] }));
  const result = await generateWeChatGroupDigest(host, context);
  expect(result.entries).toHaveLength(12);
  expect(result.entries[11]?.detail).toContain('8. 8 要点');
  expect(result.messages.length).toBeLessThanOrEqual(4);
  expect(result.messages.join(' ')).toContain('测试群 12');
  expect(result.messages.join(' ')).toContain('动态');
  expect(result.messages.join(' ')).toContain('展开 群 1');
});
