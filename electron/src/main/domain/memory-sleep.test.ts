// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { ProviderAdapter, ProviderChatRequest } from '../providers/types';
import { ChatService } from './chat-service';
import { commitMemoryCandidate, stableMemorySources } from './memory-commit';
import { rankRelevantMemories } from './memory-retrieval';
import { DEEP_LIMIT, MemorySleepService } from './memory-sleep';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const provider: ProviderConfig = { id: '11111111-1111-4111-8111-111111111111', enabled: true, name: 'Fixture', model: 'm',
  kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', supportsTools: false, secretState: 'missing' };
interface Entry { n: number; kind: string; text: string; days: number }

async function fixture(plan: (entries: Entry[]) => unknown, destination: 'local' | 'remote' = 'remote') {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-memory-sleep-'));
  roots.push(dir);
  const repo = new DomainRepository(join(dir, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 9) });
  await repo.initialize();
  let time = Date.parse('2026-11-12T10:00:00Z'), fail: string | false = false;
  const seen: Entry[][] = [];
  const adapter = { async *streamChat(request: ProviderChatRequest) {
    if (fail) throw new Error(fail);
    const entries = (JSON.parse(request.messages[1]!.content as string) as { entries: Entry[] }).entries;
    seen.push(entries);
    yield { type: 'text', text: JSON.stringify(plan(entries)) }; yield { type: 'done', finishReason: 'stop' };
  } } as unknown as ProviderAdapter;
  const service = new MemorySleepService(repo, { available: () => true, provider: () => ({ provider, model: 'm', destination }), adapter: async () => adapter, now: () => new Date(time) });
  const chat = new ChatService(repo), session = await chat.createSession('Conversation', 'normal');
  const memory = new MemoryService(repo);
  /** What auto memory stores after a conversation. */
  const learn = async (text: string, options: { layer?: 'shallow' | 'deep'; privacy?: 'local-only' } = {}): Promise<string> => {
    const message = await chat.addMessage({ sessionId: session.id, role: 'user', content: text, status: 'complete', errorCode: null });
    return repo.transaction((state) => {
      const references = [{ kind: 'chat-user' as const, sessionId: session.id, messageId: message.id }];
      const result = commitMemoryCandidate(state, { operationId: 'auto-profile:' + message.id, text, tags: ['auto'], sourceReferences: references,
        sourceEventIds: stableMemorySources(references), origin: 'auto-profile', authority: 'reviewed-import', now: new Date(time), ...(options.privacy ? { privacy: options.privacy } : {}) });
      const item = state.memories.find((value) => value.id === result.memoryId)!;
      item.contextMetadata!.layer = options.layer ?? 'shallow';
      return item.id;
    });
  };
  const write = async (text: string): Promise<string> => (await memory.upsert({ id: crypto.randomUUID(), text, tags: [] })).id;
  const n = (entries: Entry[], text: string): number => entries.find((entry) => entry.text === text)!.n;
  const texts = (): string[] => memory.list().map((item) => item.text).sort();
  const layer = (text: string): string | undefined => memory.list().find((item) => item.text === text)?.contextMetadata?.layer;
  return { repo, service, memory, learn, write, n, texts, layer, seen, later: (days: number) => { time += days * 86_400_000; }, offline: (value: boolean | string) => { fail = value === true ? 'offline' : value; } };
}

it('merges, promotes and lets go in one night, and each step can be undone', async () => {
  const f = await fixture((entries) => ({
    merge: [{ ids: [f.n(entries, '用户住在北京'), f.n(entries, '用户搬到了上海')], text: '用户现在住在上海（之前在北京）', deep: true }],
    promote: [f.n(entries, '用户喜欢简短的回答')], drop: [f.n(entries, '用户今天在调试一个 CSS 问题')],
  }));
  await f.learn('用户住在北京'); await f.learn('用户搬到了上海'); await f.learn('用户喜欢简短的回答'); await f.learn('用户今天在调试一个 CSS 问题');
  const status = await f.service.runNow();
  expect(f.texts()).toEqual(['用户喜欢简短的回答', '用户现在住在上海（之前在北京）']);
  expect([f.layer('用户喜欢简短的回答'), f.layer('用户现在住在上海（之前在北京）')]).toEqual(['deep', 'deep']);
  expect(status).toMatchObject({ shallow: 0, deep: 2, lastError: null });
  expect(status.reports[0]!.changes.map((change) => [change.kind, change.before, change.after])).toEqual([
    ['merge', ['用户住在北京', '用户搬到了上海'], '用户现在住在上海（之前在北京）'],
    ['promote', ['用户喜欢简短的回答'], '用户喜欢简短的回答'],
    ['drop', ['用户今天在调试一个 CSS 问题'], null],
  ]);
  // The deep profile accompanies a turn that matches none of its words; a typed search does not list it.
  const options = { sessionId: 's', destination: 'remote' as const };
  expect(rankRelevantMemories(f.memory.list(), '帮我写一封邮件', { ...options, includeProfile: true })).toHaveLength(2);
  expect(rankRelevantMemories(f.memory.list(), '帮我写一封邮件', options)).toHaveLength(0);
  const report = status.reports[0]!;
  for (const change of report.changes) await f.service.undo({ reportId: report.id, changeId: change.id });
  expect(f.texts()).toEqual(['用户今天在调试一个 CSS 问题', '用户住在北京', '用户喜欢简短的回答', '用户搬到了上海']);
  // What the owner brought back is theirs now: no layer, so the next night does not offer it for change.
  expect(f.memory.list().every((item) => item.contextMetadata?.layer === undefined)).toBe(true);
  await expect(f.service.undo({ reportId: report.id, changeId: report.changes[0]!.id })).rejects.toThrow('sleep.undoStale');
  f.later(1); await f.service.runNow();
  expect(f.seen).toHaveLength(1);
});

it('never rewrites what the owner wrote: a duplicate folds into it, and it cannot be dropped or promoted', async () => {
  const f = await fixture((entries) => ({
    merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: '用户对花生和坚果过敏', deep: true }],
    promote: [f.n(entries, '我在准备大学申请')], drop: [f.n(entries, '我在准备大学申请'), 99],
  }));
  await f.write('我对花生过敏'); await f.write('我在准备大学申请'); await f.learn('用户对花生过敏');
  const status = await f.service.runNow();
  expect(f.seen[0]!.map((entry) => entry.kind).sort()).toEqual(['fixed', 'fixed', 'shallow']);
  expect(f.texts()).toEqual(['我在准备大学申请', '我对花生过敏']);
  expect(status.reports[0]!.changes.map((change) => [change.kind, change.after])).toEqual([['merge', '我对花生过敏']]);
});

it('keeps local-only memories away from a cloud model and keeps a merged result as private as its parts', async () => {
  const plan = (entries: Entry[]) => ({ merge: entries.length >= 2 ? [{ ids: [entries[0]!.n, entries[1]!.n], text: '用户在上海读高三' }] : [] });
  const cloud = await fixture(plan);
  await cloud.learn('用户在上海上学', { privacy: 'local-only' }); await cloud.learn('用户读高三');
  await cloud.service.runNow();
  expect(cloud.seen[0]!.map((entry) => entry.text)).toEqual(['用户读高三']);
  expect(cloud.texts()).toEqual(['用户在上海上学', '用户读高三']);
  const local = await fixture(plan, 'local');
  await local.learn('用户在上海上学', { privacy: 'local-only' }); await local.learn('用户读高三');
  await local.service.runNow();
  expect(local.memory.list().map((item) => [item.text, item.contextMetadata?.privacy])).toEqual([['用户在上海读高三', 'local-only']]);
});

it.each(['wechatDigest', 'wechatFriend'] as const)('excludes %s sources from every nightly operation and rejects new memory commits', async marker => {
  const f = await fixture(entries => ({ promote: entries.map(entry => entry.n) }));
  const excluded = '不参与夜间整理的合成微信内容';
  const saved = await f.learn(excluded);
  await f.repo.transaction(state => {
    const memory = state.memories.find(item => item.id === saved)!;
    const source = memory.contextMetadata!.sourceReferences[0]!;
    if (source.kind !== 'chat-user') throw new Error('Expected a chat source');
    const message = state.chatMessages.find(item => item.id === source.messageId)!;
    message[marker] = true;
    expect(commitMemoryCandidate(state, {
      operationId: 'wechat-regression:' + message.id, text: message.content, tags: ['auto'], sourceReferences: [source],
      sourceEventIds: stableMemorySources([source]), origin: 'auto-profile', authority: 'reviewed-import',
    })).toEqual({ status: 'blocked', memoryId: null });
  });
  f.later(31);
  await f.learn('用户喜欢绿茶');
  const status = await f.service.runNow();
  expect(f.seen[0]!.map(entry => entry.text)).toEqual(['用户喜欢绿茶']);
  expect(f.texts()).toContain(excluded);
  expect(f.layer(excluded)).toBe('shallow');
  expect(status).toMatchObject({ shallow: 0, deep: 1 });
});

it('lets an unconfirmed shallow memory fade after 30 days without asking a model, and keeps the deep profile short', async () => {
  const f = await fixture((entries) => ({ promote: entries.filter((entry) => entry.kind === 'shallow').map((entry) => entry.n) }));
  await f.learn('用户上周在找一家餐厅');
  f.later(31);
  for (let index = 0; index < DEEP_LIMIT + 2; index++) await f.learn(`用户的长期偏好第 ${index} 条`);
  const status = await f.service.runNow();
  expect(status.deep).toBe(DEEP_LIMIT);
  expect(status.shallow).toBe(2);
  expect(f.texts()).not.toContain('用户上周在找一家餐厅');
  expect(status.reports[0]!.changes.filter((change) => change.kind === 'expire')).toHaveLength(1);
});

it('runs once per night at its hour, catches up after a missed night, and gives up on a broken provider after three tries', async () => {
  const f = await fixture(() => ({}));
  await f.service.configure({ enabled: true, hour: 3, timezone: 'UTC' });
  await f.learn('用户喜欢喝茶');
  // A profile that has never been tidied starts with the night already past.
  await f.service.tick(); await f.service.tick();
  expect(f.seen).toHaveLength(1);
  await f.learn('用户喜欢咖啡');
  f.later(1); await f.service.tick(); await f.service.tick();
  expect(f.seen).toHaveLength(2);
  f.later(3); f.offline(true);
  for (let attempt = 0; attempt < 3; attempt++) { await f.service.tick(); f.later(1 / 24); }
  f.offline(false); await f.service.tick();
  expect(f.seen).toHaveLength(2);
  expect(f.service.status()).toMatchObject({ lastError: 'sleep.failed', lastFailureAt: expect.any(String) });
  f.later(1); await f.service.tick();
  expect(f.seen).toHaveLength(3);
  // A provider's own code says why, so the status page can tell the owner.
  await f.learn('用户喜欢绿茶');
  f.later(1); f.offline('provider.unsupportedParameter'); await f.service.tick();
  expect(f.service.status().lastError).toBe('provider.unsupportedParameter');
  f.offline(false); f.later(1 / 24); await f.service.tick();
  expect(f.service.status().lastError).toBeNull();
  const runs = f.seen.length;
  await f.service.configure({ enabled: false, hour: 3, timezone: 'UTC' });
  f.later(1); await f.service.tick();
  expect(f.seen).toHaveLength(runs);
});

it('keeps what a duplicate was folded into after the undo reports expire, and undo marks it undone', async () => {
  const { supersededChat } = await import('./companion-recent-state');
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 && entries.some((entry) => entry.text === '用户对花生过敏')
    ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused', deep: true }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const source = f.repo.snapshot().chatMessages.find((message) => message.content === '用户对花生过敏')!;
  const beforeMerge = f.repo.snapshot();
  const status = await f.service.runNow();
  expect(f.repo.snapshot().memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, resultId: kept }]);
  // Undo marks the link undone (kept, so an older backup cannot revive it); merge again for the rest of the test.
  await f.service.undo({ reportId: status.reports[0]!.id, changeId: status.reports[0]!.changes[0]!.id });
  expect(f.repo.snapshot().memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, resultId: kept, undoneAt: expect.any(String) }]);
  await f.repo.transaction((state) => { state.memories.find((item) => item.id === duplicate)!.contextMetadata!.layer = 'shallow'; });
  f.later(1); await f.service.runNow();
  f.later(40); await f.service.runNow();
  expect(f.repo.snapshot().memorySleep.reports).toEqual([]);
  await f.memory.remove(kept);
  expect(supersededChat(f.repo.snapshot()).get(source.id)).toBe('deleted');
  // A backup from before the merge brings the duplicate back as an ordinary memory; the deletion still reaches it.
  expect(reconcileMemoryProtection(beforeMerge, f.repo.snapshot()).memories.map((item) => item.id)).not.toContain(duplicate);
});

it('asks for review of a duplicate restored from before the merge when the memory it was folded into was corrected', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  f.later(1); await f.memory.upsert({ id: kept, text: '我对花生不过敏', tags: [] });
  const restored = reconcileMemoryProtection(beforeMerge, f.repo.snapshot()).memories.find((item) => item.id === duplicate);
  expect(restored?.contextMetadata).toMatchObject({ trust: 'unverified', reviewReason: 'protection-conflict' });
});

it('does not let a backup taken before an undo revive the merge', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const status = await f.service.runNow();
  const afterMerge = f.repo.snapshot();
  await f.service.undo({ reportId: status.reports[0]!.id, changeId: status.reports[0]!.changes[0]!.id });
  f.later(1); await f.memory.remove(kept);
  await f.memory.upsert({ id: duplicate, text: '用户对花生和芝麻过敏', tags: [] });
  const restored = reconcileMemoryProtection(afterMerge, f.repo.snapshot());
  expect(restored.memories.map((item) => [item.id, item.text])).toEqual([[duplicate, '用户对花生和芝麻过敏']]);
});

it('follows a merge recorded only in an undo report from before the lineage existed', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const { supersededChat } = await import('./companion-recent-state');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const source = f.repo.snapshot().chatMessages.find((message) => message.content === '用户对花生过敏')!;
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  await f.repo.transaction((state) => { state.memorySleep.mergeLineage = []; });
  f.later(1); await f.memory.remove(kept);
  expect(supersededChat(f.repo.snapshot()).get(source.id)).toBe('deleted');
  const restored = reconcileMemoryProtection(beforeMerge, f.repo.snapshot());
  expect(restored.memories.map((item) => item.id)).not.toContain(duplicate);
  expect(restored.memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, resultId: kept }]);
});

it('drops the parts of a corrected merged memory restored from before the merge, and keeps the correction', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '用户住在北京'), f.n(entries, '用户搬到了上海')], text: '用户现在住在上海' }] } : {});
  const first = await f.learn('用户住在北京'); const second = await f.learn('用户搬到了上海');
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  const merged = f.memory.list().find((item) => item.text === '用户现在住在上海')!;
  f.later(1); await f.memory.upsert({ id: merged.id, text: '用户现在住在杭州', tags: [] });
  // The parts stand on the very evidence the owner corrected; the corrected memory carries on in their place.
  const restored = reconcileMemoryProtection(beforeMerge, f.repo.snapshot()).memories;
  expect(restored.map((item) => item.id)).not.toContain(first);
  expect(restored.map((item) => item.id)).not.toContain(second);
  expect(restored.map((item) => item.text)).toContain('用户现在住在杭州');
});

it('records an undo of a merge known only from its report, so an old backup cannot revive it once the report expires', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const status = await f.service.runNow();
  // As if merged by a version without the lineage.
  await f.repo.transaction((state) => { state.memorySleep.mergeLineage = []; });
  const afterMerge = f.repo.snapshot();
  await f.service.undo({ reportId: status.reports[0]!.id, changeId: status.reports[0]!.changes[0]!.id });
  expect(f.repo.snapshot().memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, resultId: kept, undoneAt: expect.any(String) }]);
  f.later(1); await f.memory.remove(kept);
  await f.memory.upsert({ id: duplicate, text: '用户对花生和芝麻过敏', tags: [] });
  f.later(40); await f.service.runNow();
  expect(f.repo.snapshot().memorySleep.reports).toEqual([]);
  expect(reconcileMemoryProtection(afterMerge, f.repo.snapshot()).memories.map((item) => item.text)).toEqual(['用户对花生和芝麻过敏']);
});

it('restoring a backup taken while merged puts the merge back in effect when its duplicate does not come back', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const { supersededChat } = await import('./companion-recent-state');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const source = f.repo.snapshot().chatMessages.find((message) => message.content === '用户对花生过敏')!;
  const status = await f.service.runNow();
  const afterMerge = f.repo.snapshot();
  await f.service.undo({ reportId: status.reports[0]!.id, changeId: status.reports[0]!.changes[0]!.id });
  const restored = reconcileMemoryProtection(afterMerge, f.repo.snapshot());
  expect(restored.memories.map((item) => item.id)).toEqual([kept]);
  expect(restored.memorySleep.mergeLineage).toEqual([expect.not.objectContaining({ undoneAt: expect.anything() })]);
  // Deleting the kept memory afterwards still reaches the duplicate's chat.
  const deletedAt = new Date(Date.parse(restored.memorySleep.mergeLineage[0]!.at) + 1).toISOString();
  const deleted = { ...restored, memoryTombstones: [...restored.memoryTombstones, { id: crypto.randomUUID(), memoryId: kept, textDigest: 'a'.repeat(64),
    sourceEventIds: [], identityKey: null, scope: { kind: 'global' as const }, deletedAt, kind: 'deleted' as const }] };
  expect(restored.memorySleep.mergeLineage[0]!.memoryId).toBe(duplicate);
  expect(supersededChat(deleted).get(source.id)).toBe('deleted');
});

it('lets a duplicate brought back by a pre-merge restore stand on its own again', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const { supersededChat } = await import('./companion-recent-state');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const source = f.repo.snapshot().chatMessages.find((message) => message.content === '用户对花生过敏')!;
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  const restored = reconcileMemoryProtection(beforeMerge, f.repo.snapshot());
  expect(restored.memories.map((item) => item.id).sort()).toEqual([kept, duplicate].sort());
  expect(restored.memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, undoneAt: expect.any(String) }]);
  // Deleting the kept memory afterwards leaves the duplicate's chat alone.
  const deleted = { ...restored, memoryTombstones: [...restored.memoryTombstones, { id: crypto.randomUUID(), memoryId: kept, textDigest: 'a'.repeat(64),
    sourceEventIds: [], identityKey: null, scope: { kind: 'global' as const }, deletedAt: new Date(Date.now() + 1000).toISOString(), kind: 'deleted' as const }] };
  expect(supersededChat(deleted).get(source.id)).toBeUndefined();
});

it('keeps the merge of a duplicate restored for review, so the correction still covers its chat', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const { supersededChat } = await import('./companion-recent-state');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const source = f.repo.snapshot().chatMessages.find((message) => message.content === '用户对花生过敏')!;
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  f.later(1); await f.memory.upsert({ id: kept, text: '我对花生不过敏', tags: [] });
  const restored = reconcileMemoryProtection(beforeMerge, f.repo.snapshot());
  expect(restored.memories.find((item) => item.id === duplicate)?.contextMetadata?.reviewReason).toBe('protection-conflict');
  expect(restored.memorySleep.mergeLineage).toEqual([expect.not.objectContaining({ undoneAt: expect.anything() })]);
  expect(supersededChat(restored).get(source.id)).toBe('corrected');
});

it('does not put a merge back in effect when the memory it was folded into is gone', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  const afterMerge = f.repo.snapshot();
  // Back to before the merge, delete only the kept memory, then to after the merge and before it again.
  await f.repo.transaction((state) => { Object.assign(state, reconcileMemoryProtection(beforeMerge, f.repo.snapshot())); });
  f.later(1); await f.memory.remove(kept);
  await f.repo.transaction((state) => { Object.assign(state, reconcileMemoryProtection(afterMerge, f.repo.snapshot())); });
  expect(f.repo.snapshot().memories.map((item) => item.id)).toEqual([]);
  const last = reconcileMemoryProtection(beforeMerge, f.repo.snapshot());
  expect(last.memories.map((item) => item.id)).toEqual([duplicate]);
});

it('lets a duplicate the owner confirmed after a restore stand on its own through later restores', async () => {
  const { reconcileMemoryProtection } = await import('./memory-commit');
  const f = await fixture((entries) => entries.length >= 2 ? { merge: [{ ids: [f.n(entries, '我对花生过敏'), f.n(entries, '用户对花生过敏')], text: 'unused' }] } : {});
  const kept = await f.write('我对花生过敏'); const duplicate = await f.learn('用户对花生过敏');
  const beforeMerge = f.repo.snapshot();
  await f.service.runNow();
  f.later(1); await f.memory.upsert({ id: kept, text: '我对花生不过敏', tags: [] });
  await f.repo.transaction((state) => { Object.assign(state, reconcileMemoryProtection(beforeMerge, f.repo.snapshot())); });
  const review = f.memory.list().find((item) => item.id === duplicate)!;
  expect(review.contextMetadata?.reviewReason).toBe('protection-conflict');
  await f.memory.upsert({ id: duplicate, text: review.text, tags: review.tags, confirmForChat: true });
  expect(f.repo.snapshot().memorySleep.mergeLineage).toMatchObject([{ memoryId: duplicate, undoneAt: expect.any(String) }]);
  const confirmed = f.repo.snapshot();
  f.later(1); await f.memory.remove(kept);
  const restored = reconcileMemoryProtection(confirmed, f.repo.snapshot()).memories.find((item) => item.id === duplicate);
  expect(restored?.text).toBe('用户对花生过敏');
  expect(restored?.contextMetadata?.reviewReason).toBeUndefined();
});
