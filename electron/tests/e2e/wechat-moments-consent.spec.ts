import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatMoments } from '../../src/main/channels/wechat/wechat-moments';
import type { WeChatMomentsHost } from '../../src/main/channels/wechat/wechat-moments';

// The chat has no desktop confirmation UI. Exercise its complete durable
// preview → owner reply → edit → reapproval → publication lifecycle. Physical
// WeChat is substituted here; the runtime authorization is tested with real SQLite.
// eslint-disable-next-line no-empty-pattern
test('a natural reply approves only the current Moments preview, never a question or an edit', async ({}) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-moment-consent-'));
  const posted: Parameters<WeChatMomentsHost['post']>[0][] = [];
  const notices: string[] = [], previews: string[] = [];
  const adjacent = async () => 'next' as const;
  const later = async () => 'later' as const;
  let now = Date.parse('2026-11-15T10:00:00Z');
  const path = join(root, 'state.json');
  const host: WeChatMomentsHost = {
    read: async () => readFile(path, 'utf8').catch(() => null),
    write: async value => writeFile(path, JSON.stringify(value), { mode: 0o600 }),
    enabled: async () => true, now: () => now, timezone: () => 'UTC',
    compose: async () => ({ text: '一片落叶做了书签。', imageIdea: 'A leaf bookmark.' }),
    previewIntro: async () => '我挑了张落叶的图，先给你看看呀。',
    rewrite: async () => ({ text: '落叶书签。', imageIdea: 'A leaf bookmark.' }),
    draw: async () => ({ assetId: 'a'.repeat(64) }),
    image: async () => ({ full: Buffer.from('synthetic image'), preview: Buffer.from('synthetic image') }),
    preview: async value => { previews.push(value.text); return 'sent'; },
    post: async value => { posted.push(value); return { status: 'posted' }; },
    notify: async value => { notices.push(value); }, record: async () => undefined, wait: async () => undefined,
  };
  try {
    let moments = new WeChatMoments(host);
    await moments.propose(await host.compose({ date: '2026-11-15', recent: [] }));
    expect(previews[0]).toContain('先给你看看');
    expect(previews[0]).toContain('一片落叶做了书签。');
    expect(await moments.answer('今天好累', adjacent)).toBeNull();
    expect(await moments.answer('好', later)).toBeNull();
    now += 3 * 3_600_000;
    expect(await moments.answer('好', adjacent)).toBeNull();
    for (const text of ['发什么', '发了吗']) {
      expect(await moments.answer(text, later)).toContain('还没发');
      expect(posted).toHaveLength(0);
    }
    for (const text of ['你觉得呢', '可以吗', '好？', '随便你']) {
      expect(await moments.answer(text, later)).toBeNull();
      expect(posted).toHaveLength(0);
    }
    expect(await moments.answer('把朋友圈草稿改成落叶书签', later)).toContain('等你点头');
    expect(previews[1]).toContain('落叶书签。');
    expect(previews[1]).not.toContain('可以跟我说');
    expect(posted).toHaveLength(0);
    // Restart after rewriting: the replacement draft and first-use hint survive.
    moments = new WeChatMoments(host);
    expect(await moments.answer('发，只给我看', later)).toContain('仅自己可见');
    await expect.poll(() => posted.length).toBe(1);
    await expect.poll(() => notices.length).toBe(1);
    expect(posted[0]).toMatchObject({ text: '落叶书签。', visibility: 'private' });
    expect(await moments.answer('发吧', later)).toBeNull();
    expect(posted).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
