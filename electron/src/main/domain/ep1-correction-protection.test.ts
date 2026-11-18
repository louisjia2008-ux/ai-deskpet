// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { buildChatContext } from './chat-context';
import { memoryAllowedForContext } from './chat-context-policy';
import { quarantineRestoredMemories } from './memory-commit';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-ep1-correction-guard-')); roots.push(root);
  const path = join(root, 'profile.enc.json'); const vault = { getVaultKey: async () => Buffer.alloc(32, 96) };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); const chat = new ChatService(repository); const memory = new MemoryService(repository);
  const session = await chat.createSession('Synthetic correction protection', 'normal');
  const turn = async (text: string) => {
    await chat.addMessage({ sessionId: session.id, role: 'user', content: text, status: 'complete', errorCode: null });
    return chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
  };
  const context = (repo: DomainRepository) => buildChatContext({
    binding: { providerId: 'ep1-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic', localExecutionConfirmed: true },
    sessionId: session.id, locale: 'en', query: 'What is the synthetic saved fact?', history: [], memories: repo.snapshot().memories,
  });
  return { repository, memory, turn, reopen, session, context };
};

describe('E-P1 ordinary correction preserves deletion and unknown protection', () => {
  it('rejects an ordinary manual correction into another deleted fact across restart and request construction', async () => {
    const f = await fixture();
    const deleted = await f.memory.upsert({ id: randomUUID(), text: 'EP1_DELETED_OTHER_ROW_FACT', tags: [] });
    const other = await f.memory.upsert({ id: randomUUID(), text: 'EP1_OTHER_INDEPENDENT_FACT', tags: [] });
    await f.memory.remove(deleted.id, { expectedRevision: 1, operationId: randomUUID() });
    const before = f.repository.snapshot();
    await expect(f.memory.upsert({ id: other.id, text: deleted.text, tags: [], expectedRevision: 1, operationId: randomUUID() })).rejects.toThrow('memory.editStale');
    expect(f.repository.snapshot()).toEqual(before);
    expect(JSON.stringify(f.context(f.repository))).not.toContain(deleted.text);
    const reopened = await f.reopen();
    expect(reopened.snapshot().memories).toEqual(before.memories);
    expect(JSON.stringify(f.context(reopened))).not.toContain(deleted.text);
  });

  it('keeps an ordinary new chat correction into another deleted fact out of automatic context', async () => {
    const f = await fixture();
    const deleted = await f.memory.upsert({ id: randomUUID(), text: 'EP1_CHAT_DELETED_OTHER_FACT', tags: [] });
    const other = await f.memory.upsert({ id: randomUUID(), text: 'EP1_CHAT_EXISTING_OTHER_FACT', tags: [] });
    await f.memory.remove(deleted.id, { expectedRevision: 1, operationId: randomUUID() });
    const reply = await f.turn(`把 ${other.text} 改成 ${deleted.text}`);
    const before = f.repository.snapshot();
    await expect(f.memory.editFromChat(reply.id, other.text, deleted.text)).rejects.toThrow('memory.editStale');
    expect(f.repository.snapshot()).toEqual(before);
    // A fresh request contains no prior command text and cannot retrieve A.
    expect(JSON.stringify(f.context(f.repository))).not.toContain(deleted.text);
    const reopened = await f.reopen();
    expect(JSON.stringify(f.context(reopened))).not.toContain(deleted.text);
  });

  for (const temporary of [false, true]) {
    it(`rejects ${temporary ? 'temporary overlay' : 'ordinary'} chat correction of protection-unknown restored data without implicit review`, async () => {
      const f = await fixture();
      const item = await f.memory.upsert({ id: randomUUID(), text: 'EP1_RESTORED_UNKNOWN_ORIGINAL', tags: [] });
      await f.repository.transaction((state) => quarantineRestoredMemories(state));
      const replacement = temporary ? '今天使用 EP1_UNKNOWN_TEMP_OVERLAY' : 'EP1_UNKNOWN_UPDATED_FACT';
      const reply = await f.turn(`把 ${item.text} 改成 ${replacement}`);
      const before = f.repository.snapshot();
      expect(before.memories[0]?.contextMetadata).toMatchObject({ trust: 'unverified', reviewReason: 'protection-unknown' });
      expect(memoryAllowedForContext(before.memories[0]!, f.session.id, 'local')).toBe(false);
      await expect(f.memory.editFromChat(reply.id, item.text, replacement)).rejects.toThrow('memory.editStale');
      expect(f.repository.snapshot()).toEqual(before);
      expect(JSON.stringify(f.context(f.repository))).not.toContain(item.text);
      expect(JSON.stringify(f.context(f.repository))).not.toContain(replacement);
      const reopened = await f.reopen();
      expect(reopened.snapshot().memories).toEqual(before.memories);
      expect(JSON.stringify(f.context(reopened))).not.toContain(replacement);
    });
  }
});
