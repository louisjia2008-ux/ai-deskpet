import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitMemoryCandidate, memoryDigest, memoryEventIds, reconcileMemoryProtection, recordMemorySupersession } from './memory-commit';
import { createDefaultState } from './schemas';
import { DomainRepository } from './repository';
import { MemoryService } from './memory-service';
import { ChatService } from './chat-service';
import { memoryAllowedForContext } from './chat-context-policy';

const candidate = (event = 'event-1', text = '用户：喜欢茶') => ({ operationId: randomUUID(), text, tags: ['test'],
  sourceReferences: [{ kind: 'manual-user' as const, actionId: randomUUID() }], sourceEventIds: [memoryDigest(event)],
  origin: 'import-reviewed' as const, authority: 'reviewed-import' as const, now: new Date('2026-10-27T00:00:00Z') });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-ep1-')); roots.push(root);
  const path = join(root, 'profile.enc.json'); const vault = { getVaultKey: async () => Buffer.alloc(32, 71) };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); return { repository, reopen, service: new MemoryService(repository), chat: new ChatService(repository) };
};

describe('E-P1 stable evidence and deterministic fact commits', () => {
  it('deduplicates old source across operations while retaining equal text independent events', () => {
    const state = createDefaultState(); const firstInput = candidate(); const first = commitMemoryCandidate(state, firstInput);
    const revision = state.memoryRevision;
    const replay = commitMemoryCandidate(state, { ...firstInput, operationId: randomUUID() });
    expect(replay).toEqual({ status: 'duplicate', memoryId: first.memoryId });
    expect(state.memoryRevision).toBe(revision); expect(memoryEventIds(state.memories[0]!)).toHaveLength(1);
    commitMemoryCandidate(state, candidate('event-2'));
    expect(state.memories).toHaveLength(1); expect(memoryEventIds(state.memories[0]!)).toHaveLength(2);
    expect(state.memoryRevision).toBe(revision + 1);
  });
  it('keeps distinct facts from one source and distinct explicit entity/key addresses', () => {
    const state = createDefaultState();
    commitMemoryCandidate(state, candidate()); commitMemoryCandidate(state, candidate('event-1', '用户：喜欢短回答'));
    commitMemoryCandidate(state, { ...candidate('event-2'), identity: { entity: 'user', key: 'tea' } });
    commitMemoryCandidate(state, { ...candidate('event-3'), identity: { entity: 'friend', key: 'tea' } });
    expect(state.memories).toHaveLength(4);
  });
  it('operation replay is idempotent, payload conflict fails and stale base epoch changes no facts', () => {
    const state = createDefaultState(); const input = candidate(); const first = commitMemoryCandidate(state, input);
    expect(commitMemoryCandidate(state, { ...input, expectedRevision: 999 })).toEqual(first);
    expect(() => commitMemoryCandidate(state, { ...input, text: 'changed' })).toThrow('memory.operationConflict');
    const memories = structuredClone(state.memories);
    expect(commitMemoryCandidate(state, { ...candidate('next'), expectedRevision: 0 }).status).toBe('stale');
    expect(state.memories).toEqual(memories);
  });
  it('fails closed at evidence bounds without forgetting early sources', () => {
    const state = createDefaultState(); const input = candidate(); commitMemoryCandidate(state, input);
    state.memories[0]!.contextMetadata!.sourceEventIds = Array.from({ length: 256 }, (_, index) => memoryDigest(`source-${index}`));
    expect(() => commitMemoryCandidate(state, candidate('source-256'))).toThrow('memory.evidenceLimit');
    expect(memoryEventIds(state.memories[0]!)).toContain(memoryDigest('source-0'));
  });
  it('deletion blocks replay with new batch IDs, paraphrases from old sources, and text from reordered unidentifiable old material', () => {
    const state = createDefaultState(); commitMemoryCandidate(state, candidate()); const memory = state.memories[0]!;
    recordMemorySupersession(state, memory, 'deleted'); state.memories = [];
    expect(commitMemoryCandidate(state, candidate()).status).toBe('blocked');
    expect(commitMemoryCandidate(state, candidate('event-1', '用户：偏好茶')).status).toBe('blocked');
    expect(commitMemoryCandidate(state, { ...candidate('event-1', '用户：偏好茶'), scope: { kind: 'session', sessionId: randomUUID() } }).status).toBe('blocked');
    expect(commitMemoryCandidate(state, candidate('reordered-source')).status).toBe('blocked');
    expect(commitMemoryCandidate(state, { ...candidate('event-1'), authority: 'explicit-user' }).status).toBe('blocked');
    expect(commitMemoryCandidate(state, { ...candidate('new-explicit-user'), authority: 'explicit-user' }).status).toBe('committed');
  });
  it('does not trust wall clock ordering for an old same-fact row with a different ID/source', () => {
    const deleted = createDefaultState(); commitMemoryCandidate(deleted, candidate('original'));
    const row = deleted.memories[0]!; recordMemorySupersession(deleted, row, 'deleted', new Date('2000-01-01T00:00:00Z')); deleted.memories = [];
    const oldBackup = createDefaultState(); commitMemoryCandidate(oldBackup, candidate('different-old-copy'));
    oldBackup.memories[0]!.updatedAt = '2099-01-01T00:00:00Z';
    const merged = reconcileMemoryProtection(oldBackup, deleted);
    expect(merged.memories.every((memory) => !memoryAllowedForContext(memory, randomUUID(), 'local'))).toBe(true);
  });
  it('restore cannot append a current correction around a newer deletion in the backup', () => {
    const current = createDefaultState(); commitMemoryCandidate(current, candidate()); const row = current.memories[0]!;
    recordMemorySupersession(current, row, 'corrected', new Date('2026-10-27T01:00:00Z'));
    row.text = '用户：喜欢咖啡'; row.contextMetadata!.sourceEventIds = [memoryDigest('correction')]; row.contextMetadata!.revision = 2;
    const deletedBackup = structuredClone(current);
    recordMemorySupersession(deletedBackup, deletedBackup.memories[0]!, 'deleted', new Date('2026-10-27T02:00:00Z')); deletedBackup.memories = [];
    expect(reconcileMemoryProtection(deletedBackup, current).memories).toEqual([]);
  });
  it('restore keeps a newer correction revision instead of replacing it with an older current correction', () => {
    const current = createDefaultState(); commitMemoryCandidate(current, candidate()); const row = current.memories[0]!;
    recordMemorySupersession(current, row, 'corrected', new Date('2026-10-27T01:00:00Z'));
    row.text = '用户：喜欢咖啡'; row.contextMetadata!.sourceEventIds = [memoryDigest('correction-2')]; row.contextMetadata!.revision = 2;
    const newer = structuredClone(current); const latest = newer.memories[0]!;
    recordMemorySupersession(newer, latest, 'corrected', new Date('2026-10-27T01:00:00Z'));
    latest.text = '用户：喜欢水'; latest.contextMetadata!.sourceEventIds = [memoryDigest('correction-3')]; latest.contextMetadata!.revision = 3;
    expect(reconcileMemoryProtection(newer, current).memories.map((item) => item.text)).toEqual(['用户：喜欢水']);
  });
  it('formal restore keeps newer tombstones and correction rows, and permits a later explicit new source', () => {
    const original = createDefaultState(); commitMemoryCandidate(original, candidate()); const backup = structuredClone(original);
    const old = original.memories[0]!; recordMemorySupersession(original, old, 'corrected', new Date('2026-10-27T01:00:00Z'));
    old.text = '用户：喜欢咖啡'; old.contextMetadata!.sourceEventIds = [memoryDigest('correction')]; old.contextMetadata!.revision += 1;
    expect(reconcileMemoryProtection(backup, original).memories.map((item) => item.text)).toEqual(['用户：喜欢咖啡']);
    recordMemorySupersession(original, old, 'deleted', new Date('2026-10-27T02:00:00Z')); original.memories = [];
    const restored = reconcileMemoryProtection(backup, original); expect(restored.memories).toEqual([]);
    commitMemoryCandidate(restored, { ...candidate('new-explicit-user'), authority: 'explicit-user', now: new Date('2026-10-27T03:00:00Z') });
    expect(reconcileMemoryProtection(restored, original).memories).toHaveLength(1);
  });
});

describe('E-P1 product memory mutation versions and scope', () => {
  it('manual optimistic revisions reject competing stale edits and cannot overwrite confirmed data as assistant', async () => {
    const f = await fixture(); const item = await f.service.upsert({ id: randomUUID(), text: '用户偏好茶', tags: [] });
    const revision = item.contextMetadata!.revision;
    const corrected = await f.service.upsert({ id: item.id, text: '用户偏好咖啡', tags: [], expectedRevision: revision, operationId: randomUUID() });
    await expect(f.service.upsert({ id: item.id, text: '用户偏好茶', tags: [], expectedRevision: revision, operationId: randomUUID() })).rejects.toThrow('memory.editStale');
    await expect(f.service.upsert({ id: item.id, text: '用户偏好茶', tags: [] }, 'assistant')).rejects.toThrow('memory.editStale');
    await expect(f.service.remove(item.id, { expectedRevision: revision })).rejects.toThrow('memory.forgetStale');
    expect(f.service.list()[0]?.text).toBe(corrected.text);
    const state = f.repository.snapshot(); expect(state.memoryTombstones).toHaveLength(1);
  });
  it('retries durable manual operations after restart without another evidence/revision increment', async () => {
    const f = await fixture(); const input = { id: randomUUID(), text: '用户偏好茶', tags: [], operationId: randomUUID() };
    const first = await f.service.upsert(input); const revision = f.repository.snapshot().memoryRevision;
    const reopened = await f.reopen(); const service = new MemoryService(reopened);
    expect(await service.upsert(input)).toEqual(first); expect(reopened.snapshot().memoryRevision).toBe(revision);
    await service.remove(first.id, { operationId: randomUUID() });
    await expect(service.upsert({ ...input, operationId: randomUUID() })).rejects.toThrow('memory.removed');
    expect(new MemoryService(await f.reopen()).list()).toEqual([]);
  });
  it('delete first rejects a late correction from the same old version, even with a fresh operation ID', async () => {
    const f = await fixture(); const item = await f.service.upsert({ id: randomUUID(), text: 'SYNTHETIC_SAME_BASE', tags: [] });
    const revision = item.contextMetadata!.revision;
    await f.service.remove(item.id, { expectedRevision: revision, operationId: randomUUID() });
    await expect(f.service.upsert({ id: item.id, text: 'SYNTHETIC_LATE_CORRECTION', tags: [], expectedRevision: revision, operationId: randomUUID() })).rejects.toThrow();
    const reopened = await f.reopen(); expect(reopened.snapshot().memories).toEqual([]);
    expect(reconcileMemoryProtection(reopened.snapshot(), f.repository.snapshot()).memories).toEqual([]);
  });
  it('failed deletion suppresses only process recall until a durable retry and never claims disk deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-ep1-suppress-')); roots.push(root); let locked = false;
    const path = join(root, 'profile.enc.json'); const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture locked'); return Buffer.alloc(32, 73); } };
    const repository = new DomainRepository(path, vault); await repository.initialize(); const service = new MemoryService(repository);
    const first = await service.upsert({ id: randomUUID(), text: '要删除的事实', tags: [] });
    const other = await service.upsert({ id: randomUUID(), text: '保留的事实', tags: [] });
    locked = true;
    await expect(service.remove(first.id)).rejects.toMatchObject({ message: 'Fixture locked', memoryRecallSuppressed: true });
    expect(repository.isMemoryRecallSuppressed(first.id)).toBe(true); expect(repository.isMemoryRecallSuppressed(other.id)).toBe(false);
    expect(repository.snapshot().memories).toHaveLength(2); expect(repository.snapshot().memoryTombstones).toEqual([]);
    locked = false; const restarted = new DomainRepository(path, vault); await restarted.initialize();
    expect(restarted.snapshot().memories).toHaveLength(2); expect(restarted.isMemoryRecallSuppressed(first.id)).toBe(false);
    await service.remove(first.id); expect(repository.isMemoryRecallSuppressed(first.id)).toBe(false);
    expect(repository.snapshot().memories.map((item) => item.id)).toEqual([other.id]);
  });
  it('explicitly correcting back to an older value has a fresh source and survives restore guards', async () => {
    const f = await fixture(); const id = randomUUID(); const input = { id, text: '用户偏好茶', tags: [] };
    await f.service.upsert(input, 'user', new Date('2026-10-27T00:00:00Z'));
    await f.service.upsert({ ...input, text: '用户偏好咖啡' }, 'user', new Date('2026-10-27T01:00:00Z'));
    await f.service.upsert(input, 'user', new Date('2026-10-27T02:00:00Z'));
    const state = f.repository.snapshot();
    expect(reconcileMemoryProtection(state, state).memories.map((item) => item.text)).toEqual(['用户偏好茶']);
  });
  it('temporary chat instruction is bounded to its session and cannot replace a global preference', async () => {
    const f = await fixture(); const session = await f.chat.createSession('Temporary', 'normal');
    await f.service.upsert({ id: randomUUID(), text: '长期喜欢详细回答', tags: [] });
    await f.chat.addMessage({ sessionId: session.id, role: 'user', content: '记住今天用简短回答', status: 'complete', errorCode: null });
    const response = await f.chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
    await f.service.saveFromChat(response.id, '今天用简短回答');
    const temporary = f.service.list().find((item) => item.text === '今天用简短回答')!;
    expect(temporary.contextMetadata?.scope).toEqual({ kind: 'session', sessionId: session.id });
    expect(temporary.contextMetadata?.expiresAt).toBeTruthy(); expect(f.service.list()).toHaveLength(2);
    expect(memoryAllowedForContext(temporary, randomUUID(), 'local')).toBe(false);
    temporary.contextMetadata!.expiresAt = '2000-01-01T00:00:00Z';
    expect(memoryAllowedForContext(temporary, session.id, 'local')).toBe(false);
  });
  it('rejects an older pending chat command after a manual correction even at an equal timestamp', async () => {
    const f = await fixture(); const session = await f.chat.createSession('Race', 'normal'); const now = new Date();
    const old = await f.service.upsert({ id: randomUUID(), text: '用户偏好茶', tags: [] }, 'user', now);
    await f.chat.addMessage({ sessionId: session.id, role: 'user', content: '把偏好改回旧值', status: 'complete', errorCode: null }, now);
    const reply = await f.chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null }, now);
    await f.service.upsert({ id: old.id, text: '用户偏好咖啡', tags: [] }, 'user', now);
    await expect(f.service.editFromChat(reply.id, '用户偏好', '用户偏好茶', undefined, now)).rejects.toThrow('memory.editStale');
    await expect(f.service.forgetFromChat(reply.id, '用户偏好', undefined, now)).rejects.toThrow('memory.editStale');
    await expect(f.service.saveFromChat(reply.id, '用户偏好茶', undefined, now)).rejects.toThrow('memory.editStale');
    expect(f.service.list()[0]?.text).toBe('用户偏好咖啡');
  });
  it('temporary chat correction creates a session overlay and retains the long-term global value', async () => {
    const f = await fixture(); const global = await f.service.upsert({ id: randomUUID(), text: '长期喜欢详细回答', tags: [] });
    const session = await f.chat.createSession('Temporary correction', 'normal');
    await f.chat.addMessage({ sessionId: session.id, role: 'user', content: '把详细回答改成今天简短回答', status: 'complete', errorCode: null });
    const response = await f.chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
    const result = await f.service.editFromChat(response.id, '详细回答', '今天简短回答');
    expect(result.kind).toBe('updated'); expect(f.service.list()).toHaveLength(2);
    expect(f.service.list().find((item) => item.id === global.id)?.text).toBe('长期喜欢详细回答');
    const overlay = f.service.list().find((item) => item.id !== global.id)!;
    expect(overlay.contextMetadata?.scope).toEqual({ kind: 'session', sessionId: session.id });
    expect(f.repository.snapshot().chatMessages.at(-1)?.contextTrace?.memoryReferences).toContainEqual({ id: overlay.id, revision: 1 });
  });
  it('choice revision rejects a value round-trip with an equal timestamp', async () => {
    const f = await fixture(); const now = new Date(); const first = await f.service.upsert({ id: randomUUID(), text: '地点甲', tags: [] }, 'user', now);
    await f.service.upsert({ id: randomUUID(), text: '地点乙', tags: [] }, 'user', now);
    const session = await f.chat.createSession('Choices', 'normal');
    const response = await f.chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null }, now);
    await f.service.editFromChat(response.id, '地点', '地点新', undefined, now);
    await f.service.upsert({ id: first.id, text: '地点临时', tags: [] }, 'user', now);
    await f.service.upsert({ id: first.id, text: first.text, tags: [] }, 'user', now);
    await expect(f.service.chooseEditFromChat(response.id, first.id, '已修改', now)).rejects.toThrow('memory.editStale');
  });
  it('preserves stable imported evidence on sharing edits'  , async () => {
    const f = await fixture(); await f.repository.transaction((state) => { commitMemoryCandidate(state, candidate()); });
    const item = f.service.list()[0]!;
    await f.service.upsert({ id: item.id, text: item.text, tags: item.tags, privacy: 'cloud-allowed' });
    expect(memoryEventIds(f.service.list()[0]!)).toEqual([memoryDigest('event-1')]);
  });
});
