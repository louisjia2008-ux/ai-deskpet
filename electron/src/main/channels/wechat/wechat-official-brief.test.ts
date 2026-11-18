// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { defaultWeChatOfficialBriefSettings } from '../../../shared/wechat-digests';
import type { WeChatDigestContext } from './wechat-digest-scheduler';
import { generateWeChatOfficialBrief } from './wechat-official-brief';
import type { WeChatOfficialArticle, WeChatOfficialBriefHost } from './wechat-official-brief';

const dueAt = Date.parse('2026-11-16T08:30:00+08:00');
const href = (index: number) => `https://mp.weixin.qq.com/s/?__biz=Fixture&mid=${index}&idx=1&sn=TestToken`;
const article = (index: number, title: string, at = dueAt - index * 1000): WeChatOfficialArticle =>
  ({ title, account: '合成订阅号', url: href(index), at });
const digest = (item: WeChatOfficialArticle) => ({
  title: item.title, summary: '这是合成的两句话。简要描述文章。', detail: '合成订阅号与简要描述。', url: item.url,
});

function fixture(articles: WeChatOfficialArticle[], truncated = false) {
  const context = {
    binding: 'a'.repeat(64), dueAt, now: dueAt, signal: new AbortController().signal,
    assertCurrent: vi.fn<WeChatDigestContext['assertCurrent']>(async () => undefined),
  };
  const host = {
    settings: { ...defaultWeChatOfficialBriefSettings(), enabled: true, keywords: ['城市'] },
    read: vi.fn<WeChatOfficialBriefHost['read']>(async () => ({ articles, truncated })),
    summarize: vi.fn<WeChatOfficialBriefHost['summarize']>(async item => digest(item)),
    memoryHints: vi.fn(() => ['偏好：海洋、海岸']),
    seenUrls: [href(7) + '&scene=old'],
  };
  return { context, host };
}

it('ranks explicit interests before private hints, deduplicates known aliases and selects five', async () => {
  const f = fixture([
    article(1, '近期快讯'), article(2, '海洋观察'), article(3, '城市设计'),
    { ...article(3, '旧版城市标题', dueAt - 600_000), url: href(3) + '&chksm=OldAlias' },
    article(4, '街道记录'), article(5, '本周摘要'), article(6, '近期简讯'),
    article(7, '以前读过的城市设计'), article(8, '城市建设预告', dueAt + 1000),
    article(9, '城市建设旧文', dueAt - 2 * 86_400_000),
  ], true);
  const result = await generateWeChatOfficialBrief(f.host, f.context);
  expect(result.entries.map(item => item.title)).toEqual(['城市设计', '海洋观察', '近期快讯', '街道记录', '本周摘要']);
  expect(f.host.summarize.mock.calls.map(([item]) => item.url)).toEqual([3, 2, 1, 4, 5].map(href));
  expect(f.host.summarize.mock.calls.every(([item]) => Object.keys(item).sort().join() === 'account,at,title,url')).toBe(true);
  const message = result.messages.join(' ');
  expect(message).toContain('1. 城市设计');
  expect(message).toContain('5. 本周摘要');
  expect(message).toContain('只整理了本机可见的一部分推送。');
  expect(message).toContain('「收藏 1」「展开 1」');
  expect(result.messages.every(item => item.length <= 460 && !item.includes('\n'))).toBe(true);
  expect(result.issue).toBeUndefined();
});

it('keeps usable summaries and reports safe codes when sources cannot be read or summarized', async () => {
  const f = fixture([article(1, '城市设计'), article(2, '次篇文章'), article(3, '可读的文章'),
    { ...article(4, '外部链接'), url: 'https://example.test/a' }]);
  f.host.summarize.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('private fixture detail'));
  const result = await generateWeChatOfficialBrief(f.host, f.context);
  expect(result.entries).toEqual([digest(article(3, '可读的文章'))]);
  expect(result.messages.join(' ')).toContain('1. 可读的文章');
  expect(result).toMatchObject({ issue: 'read', failures: 3 });
  expect(JSON.stringify(result)).not.toContain('private fixture detail');
});

it('stops before summarization when the read authorization changes', async () => {
  const f = fixture([article(1, '城市设计')]);
  f.context.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(generateWeChatOfficialBrief(f.host, f.context)).rejects.toThrow('revoked');
  expect(f.host.read).toHaveBeenCalledOnce();
  expect(f.host.summarize).not.toHaveBeenCalled();
});

it('does not read or summarize when the briefing is disabled', async () => {
  const f = fixture([article(1, '城市设计')]);
  f.host.settings.enabled = false;
  await expect(generateWeChatOfficialBrief(f.host, f.context)).resolves.toEqual({ entries: [], messages: [] });
  expect(f.host.read).not.toHaveBeenCalled();
  expect(f.host.summarize).not.toHaveBeenCalled();
});
