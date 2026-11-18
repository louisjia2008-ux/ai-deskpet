// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { defaultWeChatFriendsMomentsSettings } from '../../../shared/wechat-digests';
import type { WeChatDigestContext } from './wechat-digest-scheduler';
import { generateWeChatFriendsMoments } from './wechat-friends-moments';
import type { WeChatFriendsMomentPost, WeChatFriendsMomentsHost } from './wechat-friends-moments';

const dueAt = Date.parse('2026-11-16T20:00:00+08:00');
const day = 86_400_000;
const post = (author: string, text: string, images: number, ago: number): WeChatFriendsMomentPost =>
  ({ author, text, images, at: dueAt - ago });

function fixture(posts: WeChatFriendsMomentPost[], truncated = false) {
  const context = { binding: 'a'.repeat(64), dueAt, now: dueAt, signal: new AbortController().signal,
    assertCurrent: vi.fn<WeChatDigestContext['assertCurrent']>(async () => undefined) };
  const host = {
    settings: { ...defaultWeChatFriendsMomentsSettings(), enabled: true },
    read: vi.fn<WeChatFriendsMomentsHost['read']>(async () => ({ posts, truncated })),
    complete: vi.fn<WeChatFriendsMomentsHost['complete']>(async () => '{"posts":[]}'),
  };
  return { host, context };
}

it('uses source names and image counts while keeping each evidence excerpt out of the result', async () => {
  const f = fixture([
    post('合成作者一', '今天去海边旅行，天晴。 https://example.test/tracking', 2, 8_000),
    post('合成作者二', '', 4, 7_000),
    post('合成作者三', '下午搬家，傍晚整理书架。', 0, 9_000),
    post('超出当天的作者', '昨天生日', 3, day + 1),
  ], true);
  f.host.complete.mockResolvedValueOnce(JSON.stringify({
    posts: [{ id: 3, excerpt: '下午搬家', summary: '下午完成搬迁' }, { id: 2, excerpt: '海边旅行', summary: '在海边出游' }],
  }));
  const result = await generateWeChatFriendsMoments(f.host, f.context);
  expect(f.host.complete).toHaveBeenCalledOnce();
  const data = f.host.complete.mock.calls[0]![1];
  expect(JSON.parse(data)).toEqual([{ id: 2, text: '今天去海边旅行，天晴。' }, { id: 3, text: '下午搬家，傍晚整理书架。' }]);
  expect(data).not.toContain('合成作者');
  expect(data).not.toContain('tracking');
  expect(result.entries.map(item => [item.title, item.summary])).toEqual([
    ['合成作者二', '4 张图片'], ['合成作者一', '在海边出游，2 张图片'], ['合成作者三', '下午完成搬迁'],
  ]);
  expect(result.messages.join(' ')).toContain('动态提到旅行');
  expect(result.messages.join(' ')).toContain('动态提到搬家');
  expect(result.messages.join(' ')).toContain('只整理了本机可见的一部分动态');
  expect(JSON.stringify(result)).not.toContain('整理书架');
  expect(JSON.stringify(result)).not.toContain('海边旅行');
  expect(JSON.stringify(result)).not.toContain('下午搬家');
});

it('honors the seven day window and discards a fabricated or cross-post excerpt', async () => {
  const f = fixture([
    post('生日记录', '朋友本周过生日，聚餐顺利。', 0, 3 * day),
    post('工作记录', '今天正式入职，明天参加培训。', 1, 7000),
    post('过期记录', '最近外出旅行。', 3, 7 * day + 1),
    post('未来记录', '另一篇动态', 2, -1000),
  ]);
  f.host.settings.cadence = 'weekly';
  f.host.complete.mockResolvedValueOnce('{"posts":[{"id":1,"excerpt":"朋友本周过生日","summary":"庆祝生日"},{"id":2,"excerpt":"今天搬进新家","summary":"完成搬迁"}]}');
  const result = await generateWeChatFriendsMoments(f.host, f.context);
  expect(f.host.complete).toHaveBeenCalledOnce();
  expect(JSON.parse(f.host.complete.mock.calls[0]![1])).toEqual([
    { id: 1, text: '今天正式入职，明天参加培训。' }, { id: 2, text: '朋友本周过生日，聚餐顺利。' },
  ]);
  expect(result.entries).toEqual([{
    title: '工作记录', summary: '1 张图片', detail: '1 张图片。动态提到工作变动。',
  }]);
  expect(result.messages.join(' ')).toContain('朋友圈周报');
  expect(JSON.stringify(result)).not.toContain('朋友本周过生日');
  expect(JSON.stringify(result)).not.toContain('今天搬进新家');
  expect(result).toMatchObject({ issue: 'model', failures: 2 });
});

it('does not send text to a model if authorization changes during the cache read', async () => {
  const f = fixture([post('合成作者', '准备搬家。', 1, 5000)]);
  f.context.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(generateWeChatFriendsMoments(f.host, f.context)).rejects.toThrow('revoked');
  expect(f.host.read).toHaveBeenCalledOnce();
  expect(f.host.complete).not.toHaveBeenCalled();
});

it('skips reading when the feature is off and skips completion for images without text', async () => {
  const f = fixture([post('合成作者', '', 3, 5000)]);
  f.host.settings.enabled = false;
  await expect(generateWeChatFriendsMoments(f.host, f.context)).resolves.toEqual({ entries: [], messages: [] });
  expect(f.host.read).not.toHaveBeenCalled();
  f.host.settings.enabled = true;
  const result = await generateWeChatFriendsMoments(f.host, f.context);
  expect(result.entries).toEqual([{ title: '合成作者', summary: '3 张图片', detail: '3 张图片' }]);
  expect(f.host.complete).not.toHaveBeenCalled();
});
