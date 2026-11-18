import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-conversations-'));
  roots.push(root);
  let locked = false;
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture vault locked'); return Buffer.alloc(32, 17); } };
  const reopen = async (): Promise<DomainRepository> => { const repository = new DomainRepository(join(root, 'domain.enc.json'), vault); await repository.initialize(); return repository; };
  const repository = await reopen();
  const chat = new ChatService(repository);
  const first = await chat.createSession('Older chat', 'normal', new Date('2026-10-20T00:00:00Z'));
  const second = await chat.createSession('Newer chat', 'normal', new Date('2026-10-22T00:00:00Z'));
  await chat.addMessage({ sessionId: first.id, role: 'user', content: '唯一检索词 薄荷 PaperTrail', status: 'complete', errorCode: null }, new Date('2026-10-20T00:00:01Z'));
  return { repository, chat, first, second, reopen, lock: (value: boolean) => { locked = value; } };
};

describe('persistent conversation management', () => {
  it('keeps old version-1 sessions, pins older chats, and persists a trimmed renamed title', async () => {
    const f = await fixture();
    expect(f.first).not.toHaveProperty('pinnedAt');
    expect(f.chat.listSessions().map((session) => session.id)).toEqual([f.second.id, f.first.id]);
    await f.chat.renameSession(f.first.id, '  记忆验收  ');
    await f.chat.setPinned(f.first.id, true, new Date('2026-10-23T01:00:00Z'));
    const restarted = new ChatService(await f.reopen());
    expect(restarted.listSessions()[0]).toMatchObject({ id: f.first.id, title: '记忆验收', pinnedAt: '2026-10-23T01:00:00.000Z' });
    expect(restarted.listMessages(f.first.id)[0]?.content).toBe('唯一检索词 薄荷 PaperTrail');
    await restarted.setPinned(f.first.id, false);
    expect(restarted.listSessions()[0]?.id).toBe(f.second.id);
  });

  it('upgrades only generic titles belonging to the exact QQ group bindings', async () => {
    const f = await fixture(), groupA = randomUUID(), groupB = randomUUID();
    const original = await f.chat.createSession('QQ', 'normal', new Date(), groupA);
    const renamed = await f.chat.createSession('Friends', 'normal', new Date(), groupB);
    const privateChat = await f.chat.createSession('QQ', 'normal', new Date(), randomUUID());
    await f.chat.migrateQqGroupTitles([
      { sessionId: original.id, bindingId: groupA, title: 'QQ group · A' },
      { sessionId: renamed.id, bindingId: groupB, title: 'QQ group · B' },
      { sessionId: privateChat.id, bindingId: groupA, title: 'Wrong owner' },
    ]);
    const sessions = new ChatService(await f.reopen()).listSessions();
    expect(sessions.find(item => item.id === original.id)?.title).toBe('QQ group · A');
    expect(sessions.find(item => item.id === renamed.id)?.title).toBe('Friends');
    expect(sessions.find(item => item.id === privateChat.id)?.title).toBe('QQ');
  });

  it('searches titles and messages literally and keeps archived and deleted results in their own lists', async () => {
    const f = await fixture();
    expect(f.chat.listSessions({ query: 'papertrail' }).map((session) => session.id)).toEqual([f.first.id]);
    expect(f.chat.listSessions({ query: ' 薄荷 ' })).toHaveLength(1);
    expect(f.chat.listSessions({ query: 'NEWER' })[0]?.id).toBe(f.second.id);
    expect(f.chat.listSessions({ query: '.*' })).toEqual([]);
    await f.chat.setPinned(f.first.id, true);
    await f.chat.setArchived(f.first.id, true);
    expect(f.chat.listSessions({ query: '薄荷' })).toEqual([]);
    expect(f.chat.listSessions({ scope: 'archived', query: '薄荷' })[0]).toMatchObject({ id: f.first.id, pinnedAt: null });
    expect(f.chat.listSessions({ scope: 'all' })).toHaveLength(2);
    expect(f.chat.listMessages(f.first.id)).toHaveLength(1);
    expect(() => f.chat.beginTurn(f.first.id)).toThrow('sessionUnavailable');
    await f.chat.removeSession(f.first.id);
    expect(f.chat.listSessions({ scope: 'all', query: '薄荷' })).toEqual([]);
    expect(f.chat.listSessions({ scope: 'archived' })).toEqual([]);
    expect(f.chat.listSessions({ scope: 'deleted', query: '薄荷' })[0]?.id).toBe(f.first.id);
    expect(() => f.chat.listMessages(f.first.id)).toThrow('sessionUnavailable');
  });

  it('restores deleted conversations after a real repository reload without changing messages, memories or permissions', async () => {
    const f = await fixture();
    const memory = new MemoryService(f.repository);
    await memory.upsert({ id: randomUUID(), text: 'Keep this saved memory independently', tags: ['fixture'] });
    await f.repository.transaction((state) => { state.persistentPermissionGrants.push({ capabilityId: 'web.read', scope: 'always', grantedAt: '2026-10-20T00:00:00Z', expiresAt: null, remainingUses: null }); });
    const before = f.repository.snapshot();
    await f.chat.setArchived(f.first.id, true);
    await f.chat.removeSession(f.first.id);
    const reloaded = await f.reopen();
    const chat = new ChatService(reloaded);
    expect(chat.listSessions().map((session) => session.id)).toEqual([f.second.id]);
    expect(chat.listSessions({ scope: 'deleted' })).toHaveLength(1);
    expect(() => chat.beginTurn(f.first.id)).toThrow('sessionUnavailable');
    await chat.restoreSession(f.first.id);
    const again = new ChatService(await f.reopen());
    expect(again.listSessions({ scope: 'deleted' })).toEqual([]);
    expect(again.listSessions().find((session) => session.id === f.first.id)).toMatchObject({ archivedAt: null, deletedAt: null, pinnedAt: null });
    expect(again.listMessages(f.first.id)).toEqual(before.chatMessages);
    expect(reloaded.snapshot().memories).toEqual(before.memories);
    expect(reloaded.snapshot().persistentPermissionGrants).toEqual(before.persistentPermissionGrants);
  });

  it('locks a conversation before provider setup and leaves unrelated conversations manageable', async () => {
    const f = await fixture();
    const release = f.chat.beginTurn(f.first.id);
    expect(() => f.chat.beginTurn(f.first.id)).toThrow('sessionBusy');
    await expect(f.chat.renameSession(f.first.id, 'Blocked')).rejects.toThrow('sessionBusy');
    await expect(f.chat.setPinned(f.first.id, true)).rejects.toThrow('sessionBusy');
    await expect(f.chat.setArchived(f.first.id, true)).rejects.toThrow('sessionBusy');
    await expect(f.chat.removeSession(f.first.id)).rejects.toThrow('sessionBusy');
    await f.chat.renameSession(f.second.id, 'Unrelated chat still works');
    release(); release();
    const nextRelease = f.chat.beginTurn(f.first.id);
    release(); // A stale cleanup must not unlock a later turn.
    await expect(f.chat.removeSession(f.first.id)).rejects.toThrow('sessionBusy');
    nextRelease();
    await f.chat.removeSession(f.first.id);
    expect(f.chat.listSessions({ scope: 'deleted' })).toHaveLength(1);
  });

  it('also rejects changes to a persisted streaming reply and rejects retries of hidden conversations', async () => {
    const f = await fixture();
    const reply = await f.chat.addMessage({ sessionId: f.first.id, role: 'assistant', content: 'Partial reply', status: 'streaming', errorCode: null });
    await expect(f.chat.removeSession(f.first.id)).rejects.toThrow('sessionBusy');
    await f.chat.updateMessage(reply.id, { content: 'Partial reply', status: 'cancelled', errorCode: null });
    await f.chat.setArchived(f.first.id, true);
    expect(() => f.chat.retryContext(reply.id)).toThrow('sessionUnavailable');
    await f.chat.setArchived(f.first.id, false);
    expect(f.chat.retryContext(reply.id).content).toContain('PaperTrail');
  });

  it('keeps the previous state when encrypted persistence fails and rejects invalid titles', async () => {
    const f = await fixture();
    const before = f.repository.snapshot();
    f.lock(true);
    await expect(f.chat.removeSession(f.first.id)).rejects.toThrow('Fixture vault locked');
    await expect(f.chat.renameSession(f.first.id, 'Lost title')).rejects.toThrow('Fixture vault locked');
    expect(f.repository.snapshot()).toEqual(before);
    f.lock(false);
    expect((await f.reopen()).snapshot()).toEqual(before);
    await expect(f.chat.renameSession(f.first.id, '  ')).rejects.toThrow('invalidTitle');
    await expect(f.chat.renameSession(f.first.id, 'x'.repeat(241))).rejects.toThrow('invalidTitle');
    await expect(f.chat.removeSession(randomUUID())).rejects.toThrow('sessionUnavailable');
  });
});
