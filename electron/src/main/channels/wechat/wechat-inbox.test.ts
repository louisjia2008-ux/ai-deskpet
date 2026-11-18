import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { WeChatInboxInput } from '../../../shared/wechat-inbox';
import { WeChatInbox, inboxAcceptsCommand } from './wechat-inbox';

const owner = 'a'.repeat(64);
const other = 'b'.repeat(64);
const event = (index: number): string => index.toString(16).padStart(64, '0');
const article = (title: string, index = 1): WeChatInboxInput => ({
  title, kind: 'article', source: 'Fixture source', at: 500, summary: 'Fixture reading summary.',
  url: `https://mp.weixin.qq.com/s/fixture-${index}`,
});
const file = (title: string, at = 600): WeChatInboxInput => ({ title, kind: 'file', source: 'Fixture chat', at, summary: 'A Markdown file.' });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options?: ConstructorParameters<typeof WeChatInbox>[2]) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-inbox-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'inbox.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 42) };
  const reopen = () => new WeChatInbox(path, vault, options);
  return { inbox: reopen(), reopen, path };
}

it('keeps candidates distinct from saved items and expires unsaved content', async () => {
  let now = 1000;
  const { inbox, reopen, path } = await fixture({ now: () => now, candidateTtlMs: 50 });
  await inbox.remember(owner, event(1), file('Fixture note'));
  expect(await inbox.list(owner)).toEqual([]);
  expect(await inbox.hasCandidate(owner)).toBe(true);
  expect(await inbox.hasCandidate(other)).toBe(false);
  expect(await inbox.save(other)).toBeNull();
  now += 49;
  const item = await inbox.save(owner);
  expect(item?.title).toBe('Fixture note');
  expect(await reopen().list(owner, 'NOTE')).toEqual([item]);
  expect(await reopen().list(other, 'NOTE')).toEqual([]);
  expect(await readFile(path, 'utf8')).not.toContain('Fixture note');
  now += 1;
  expect(await inbox.hasCandidate(owner)).toBe(false);
  expect(await inbox.save(owner)).toBeNull();
  expect(await inbox.list(owner)).toEqual([item]);
});

it('stores a quoted item once even when the retry gets a new timestamp', async () => {
  const { inbox, reopen } = await fixture();
  await inbox.remember(owner, event(1), file('Fixture candidate'));
  const quoted = { kind: 'quote', title: 'Fixture quote', source: 'Fixture chat', at: 600, summary: 'Quoted excerpt' } as const;
  const reply = await inbox.handle(owner, event(2), '存', quoted);
  expect(reply).toContain('Fixture quote');
  expect(await reopen().handle(owner, event(2), '存', { ...quoted, at: 900 })).toBe(reply);
  await expect(inbox.handle(owner, event(2), '存', { ...quoted, summary: 'Different evidence' })).rejects.toThrow('wechat.inboxCommandConflict');
  const [saved] = await inbox.list(owner);
  expect(saved).toMatchObject(quoted);
  await inbox.remove(owner, saved!.id);
  expect(await inbox.handle(owner, event(2), '存', quoted)).toBe('收件箱已更新，请重新查看。');
  expect(await inbox.list(owner)).toEqual([]);
});

it('migrates legacy articles by binding, honors old IDs, and leaves deletions deleted', async () => {
  const { inbox, reopen } = await fixture();
  const old = { ...article('Fixture archived article'), legacyId: event(401) };
  const archive = Array.from({ length: 1000 }, (_, index) => index === 999 ? old : article(`Fixture title ${index}`, index + 2));
  await inbox.migrate(owner, archive);
  await inbox.migrate(other, [article('Fixture other article', 1002)]);
  expect(await inbox.list(owner)).toHaveLength(1000);
  expect(await inbox.list(other)).toHaveLength(1);
  expect(await inbox.handle(owner, event(3), '收藏列表')).toContain('Fixture archived article');
  expect(await inbox.handle(owner, event(4), `打开收藏 ${old.legacyId}`)).toContain('Fixture archived article');
  const [saved] = await inbox.list(owner, 'archived');
  await inbox.remove(owner, saved!.id);
  await reopen().migrate(owner, archive);
  expect(await reopen().list(owner, 'archived')).toEqual([]);
  expect(await reopen().list(owner)).toHaveLength(999);
});

it('serializes concurrent saves, deduplicates links, and keeps newest entries at the retention limit', async () => {
  const { inbox } = await fixture({ maxItems: 2 });
  const first = article('Fixture first');
  const sameTarget = { ...first, title: 'Duplicate title', url: first.url + '#fragment' };
  const results = await Promise.all([inbox.save(owner, first), inbox.save(owner, sameTarget), inbox.save(owner, file('Fixture new'))]);
  expect(results[0]).toEqual(results[1]);
  expect((await inbox.list(owner)).map(item => item.title)).toEqual(['Fixture new', 'Fixture first']);
  await inbox.save(owner, file('Most recent fixture'));
  expect((await inbox.list(owner)).map(item => item.title)).toEqual(['Most recent fixture', 'Fixture new']);
});

it('expands the item from the previous filtered list even if a new item was saved', async () => {
  const { inbox } = await fixture();
  await inbox.save(owner, file('Fixture apple', 123));
  await inbox.save(owner, file('Fixture orange', 456));
  expect(await inbox.handle(owner, event(1), '找 apple')).toContain('1. Fixture apple');
  await inbox.save(owner, file('Fixture pineapple', 789));
  expect(await inbox.handle(owner, event(2), '收件箱 1')).toContain('Fixture apple');
  expect(await inbox.handle(owner, event(3), '收件箱 2')).toContain('没有这个编号');
  for (const command of ['收藏', '收藏列表 2', '收件箱', '找 apple', '存一下']) expect(inboxAcceptsCommand(command)).toBe(true);
  expect(inboxAcceptsCommand('你能从收件箱帮我找水果吗')).toBe(false);
});

it('checks the owner guard before committing, and keeps an encrypted save when vault export fails', async () => {
  const exportNew = vi.fn(async () => { throw Error('fixture vault failure'); });
  const { inbox, reopen } = await fixture({ onSaved: exportNew });
  const grant = '00000000-0000-4000-8000-000000000001';
  expect(await inbox.exportGrant(owner)).toBeNull();
  await inbox.setExportGrant(owner, grant);
  expect(await reopen().exportGrant(owner)).toBe(grant);
  expect(await inbox.exportGrant(other)).toBeNull();

  const revoked = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('revoked'));
  await expect(inbox.save(owner, file('Denied fixture'), revoked)).rejects.toThrow('revoked');
  expect(await inbox.list(owner)).toEqual([]);
  expect(exportNew).not.toHaveBeenCalled();
  const saved = await inbox.save(owner, file('Owner saved fixture'));
  expect(exportNew).toHaveBeenCalledExactlyOnceWith(owner, saved);
  expect(await reopen().list(owner)).toEqual([saved]);
  await inbox.setExportGrant(owner, null);
  expect(await reopen().exportGrant(owner)).toBeNull();
});
