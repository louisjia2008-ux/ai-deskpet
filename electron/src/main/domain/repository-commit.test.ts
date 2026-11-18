// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import type * as AtomicFile from '../persistence/atomic-file';
import { TaskService } from './task-service';
import { TimerService } from './timer-service';

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'after' }));
vi.mock('../persistence/atomic-file', async (original) => {
  const actual = await original<typeof AtomicFile>();
  return { ...actual, atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
    const mode = fault.mode; fault.mode = 'none';
    if (mode === 'before') throw new Error('fixture.before-rename');
    await actual.atomicWriteFile(...args);
    if (mode === 'after') throw new Error('fixture.after-rename');
  } };
});
const roots: string[] = [];
afterEach(async () => {
  fault.mode = 'none'; vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-p1-commit-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 41) };
  const reopen = async () => { const repo = new DomainRepository(path, vault); await repo.initialize(); return repo; };
  const repo = await reopen(); const chat = new ChatService(repo); const memory = new MemoryService(repo);
  const session = await chat.createSession('Synthetic commit acceptance', 'normal');
  const turn = async (text: string) => {
    await chat.addMessage({ sessionId: session.id, role: 'user', content: text, status: 'complete', errorCode: null });
    return chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
  };
  return { repo, chat, memory, turn, path, reopen };
};

describe('authoritative Electron memory commit recovery', () => {
  it('persists a new default profile on its first transaction even when the mutation is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-first-commit-')); roots.push(root);
    const path = join(root, 'profile.enc.json');
    const vault = { getVaultKey: async () => Buffer.alloc(32, 42) };
    const repo = new DomainRepository(path, vault); await repo.initialize();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await repo.transaction(() => undefined);
    const bytes = await readFile(path);
    await repo.transaction(() => undefined);
    expect(await readFile(path)).toEqual(bytes);
    const reopened = new DomainRepository(path, vault); await reopened.initialize();
    const save = vi.spyOn(EncryptedJsonStore.prototype, 'save');
    await reopened.transaction(() => undefined);
    expect(save).not.toHaveBeenCalled();
  });
  it('does not write no-op transactions, including serialized contenders, and isolates narrow reads', async () => {
    const f = await fixture();
    const bytes = await readFile(f.path);
    const save = vi.spyOn(EncryptedJsonStore.prototype, 'save');
    await Promise.all(Array.from({ length: 5 }, () => f.repo.transaction(state => { state.relationship.nickname = ''; })));
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(bytes);
    const value = f.repo.read('relationship'); value.nickname = 'DO_NOT_PUBLISH';
    expect(f.repo.read('relationship').nickname).toBe('');
    await f.repo.transaction(state => { state.relationship.nickname = 'COMMITTED'; });
    expect(save).toHaveBeenCalledOnce();
    expect((await f.reopen()).read('relationship').nickname).toBe('COMMITTED');
  });

  it('uses no whole-state snapshot or disk write for idle focus and timer checks', async () => {
    const f = await fixture();
    const snapshot = vi.spyOn(f.repo, 'snapshot');
    const save = vi.spyOn(EncryptedJsonStore.prototype, 'save');
    const notify = vi.fn(); const timers = new TimerService(f.repo, notify); const tasks = new TaskService(f.repo);
    for (let i = 0; i < 10; i++) { expect(await timers.tick()).toBe(0); expect(await tasks.completeDueFocus()).toBeNull(); }
    expect(snapshot).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('publishes no fact, receipt, revision or deletion on a pre-rename failure and can retry', async () => {
    const f = await fixture(); const reply = await f.turn('请记住：P1_SYNTHETIC_FACT');
    const before = f.repo.snapshot(); const bytes = await readFile(f.path);
    fault.mode = 'before'; await expect(f.memory.saveFromChat(reply.id, 'P1_SYNTHETIC_FACT')).rejects.toThrow('before-rename');
    expect(f.repo.snapshot()).toEqual(before); expect(await readFile(f.path)).toEqual(bytes);
    expect((await f.reopen()).snapshot()).toEqual(before);
    const saved = await f.memory.saveFromChat(reply.id, 'P1_SYNTHETIC_FACT');
    const forget = await f.turn('忘记 P1_SYNTHETIC_FACT'); const beforeDelete = f.repo.snapshot();
    fault.mode = 'before'; await expect(f.memory.forgetFromChat(forget.id, 'P1_SYNTHETIC_FACT')).rejects.toThrow('before-rename');
    expect(f.repo.snapshot()).toEqual(beforeDelete);
    const reload = await f.reopen(); expect(reload.snapshot().memories[0]?.id).toBe(saved.memoryId);
    expect(reload.snapshot().chatMessages.find((item) => item.id === forget.id)?.memoryForget).toBeUndefined();
    await expect(f.memory.forgetFromChat(forget.id, 'P1_SYNTHETIC_FACT')).resolves.toMatchObject({ kind: 'deleted' });
    expect((await f.reopen()).snapshot().memories).toEqual([]);
  });

  it('recovers a committed write with lost acknowledgement by reading authenticated authority and never adds evidence twice', async () => {
    const f = await fixture(); const reply = await f.turn('请记住：P1_ACK_FACT');
    fault.mode = 'after'; const receipt = await f.memory.saveFromChat(reply.id, 'P1_ACK_FACT');
    const committed = f.repo.snapshot(); expect(committed.memories).toHaveLength(1);
    expect(committed.chatMessages.find((item) => item.id === reply.id)?.memoryReceipts).toEqual([receipt]);
    const reload = await f.reopen(); const service = new MemoryService(reload);
    expect(await service.saveFromChat(reply.id, 'P1_ACK_FACT')).toEqual(receipt);
    expect(reload.snapshot().memories).toEqual(committed.memories);
    expect(reload.snapshot().memoryRevision).toBe(committed.memoryRevision);
    expect(reload.snapshot().memoryOperations).toEqual(committed.memoryOperations);
    expect(reload.snapshot().memories[0]?.contextMetadata?.sourceEventIds).toHaveLength(1);
    await expect(service.saveFromChat(reply.id, 'DIFFERENT_PAYLOAD_FOR_SAME_CHAT_OPERATION')).rejects.toThrow('memory.operationConflict');
    const forget = await f.turn('忘记 P1_ACK_FACT'); fault.mode = 'after';
    const deleted = await f.memory.forgetFromChat(forget.id, 'P1_ACK_FACT');
    const reopened = await f.reopen(); expect(reopened.snapshot().memories).toEqual([]);
    expect(await new MemoryService(reopened).forgetFromChat(forget.id, 'P1_ACK_FACT')).toEqual(deleted);
    expect(reopened.snapshot().memoryTombstones).toHaveLength(1);
  });

  it('fails closed while write outcome is unreadable and refreshes authority before the next mutation', async () => {
    const f = await fixture(); const reply = await f.turn('请记住：P1_UNCERTAIN_FACT');
    const read = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValueOnce(new Error('fixture.read-unavailable'));
    fault.mode = 'after'; await expect(f.memory.saveFromChat(reply.id, 'P1_UNCERTAIN_FACT')).rejects.toThrow('repository.commitUncertain');
    expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain');
    expect(() => f.repo.read('memories')).toThrow('repository.commitUncertain');
    expect(read).toHaveBeenCalledOnce();
    read.mockRejectedValue(new Error('fixture.read-unavailable'));
    let enteredMutation = false;
    await expect(f.repo.transaction(() => { enteredMutation = true; })).rejects.toThrow('repository.commitUncertain');
    expect(enteredMutation).toBe(false);
    await expect(f.repo.recoverAuthority()).rejects.toThrow('repository.commitUncertain');
    expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain');
    read.mockRestore();
    // The IPC boundary invokes this before any snapshot-based UI read/retry.
    await f.repo.recoverAuthority();
    expect(f.repo.snapshot().memories).toHaveLength(1);
    const recovered = await f.memory.saveFromChat(reply.id, 'P1_UNCERTAIN_FACT');
    expect(f.repo.snapshot().memories).toHaveLength(1);
    expect(f.repo.snapshot().chatMessages.find((item) => item.id === reply.id)?.memoryReceipts).toEqual([recovered]);
    expect((await f.reopen()).snapshot().memories).toEqual(f.repo.snapshot().memories);
  });


  it('recovers an existing interrupted chat reply from its authoritative receipt without another memory mutation', async () => {
    const f = await fixture(); const reply = await f.turn('请记住：P1_UPPER_STATE_RECOVERY');
    await f.chat.updateMessage(reply.id, { status: 'streaming', content: '', errorCode: null });
    const receipt = await f.memory.saveFromChat(reply.id, 'P1_UPPER_STATE_RECOVERY');
    const authoritative = f.repo.snapshot();
    expect(authoritative.chatMessages.find((item) => item.id === reply.id)?.status).toBe('streaming');
    const reload = await f.reopen(); const chat = new ChatService(reload); const memory = new MemoryService(reload);
    expect(chat.listMessages(reply.sessionId).find((item) => item.id === reply.id)).toMatchObject({
      status: 'failed', errorCode: 'chat.interrupted', memoryReceipts: [receipt],
    });
    const recovered = await memory.saveFromChat(reply.id, 'P1_UPPER_STATE_RECOVERY');
    expect(recovered).toEqual(receipt);
    await chat.updateMessage(reply.id, { status: 'complete', errorCode: null, content: `Recovered original receipt ${receipt.memoryId}` });
    expect(reload.snapshot().memories).toEqual(authoritative.memories);
    expect(reload.snapshot().memoryOperations).toEqual(authoritative.memoryOperations);
    expect(reload.snapshot().memoryRevision).toBe(authoritative.memoryRevision);
  });


  it('keeps a missing authoritative profile unknown after a possibly committed write', async () => {
    const f = await fixture(); const reply = await f.turn('请记住：P1_MISSING_AUTHORITY_FACT');
    const read = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockResolvedValue(null);
    fault.mode = 'after';
    await expect(f.memory.saveFromChat(reply.id, 'P1_MISSING_AUTHORITY_FACT')).rejects.toThrow('repository.commitUncertain');
    expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain');
    let mutationEntered = false;
    await expect(f.repo.transaction(() => { mutationEntered = true; })).rejects.toThrow('repository.commitUncertain');
    expect(mutationEntered).toBe(false);
    await expect(f.repo.recoverAuthority()).rejects.toThrow('repository.commitUncertain');
    read.mockRestore();
    await f.repo.recoverAuthority();
    const authoritative = f.repo.snapshot();
    expect(authoritative.memories).toHaveLength(1);
    const receipt = await f.memory.saveFromChat(reply.id, 'P1_MISSING_AUTHORITY_FACT');
    expect(authoritative.chatMessages.find((item) => item.id === reply.id)?.memoryReceipts).toEqual([receipt]);
    expect(f.repo.snapshot().memories).toEqual(authoritative.memories);
    expect(f.repo.snapshot().memoryOperations).toEqual(authoritative.memoryOperations);
    expect(f.repo.snapshot().memoryRevision).toBe(authoritative.memoryRevision);
  });


  it('binds historical chat correction and deletion receipts to the original operation payload', async () => {
    const f = await fixture();
    const original = await f.memory.upsert({ id: 'a01e7bde-eaf6-4cb1-8c07-e84dd795434c', text: 'P1_CORRECTION_ORIGINAL', tags: [] });
    const editReply = await f.turn('把 P1_CORRECTION_ORIGINAL 改成 P1_CORRECTION_UPDATED');
    const edited = await f.memory.editFromChat(editReply.id, 'P1_CORRECTION_ORIGINAL', 'P1_CORRECTION_UPDATED');
    const afterEdit = f.repo.snapshot();
    expect(await f.memory.editFromChat(editReply.id, 'P1_CORRECTION_ORIGINAL', 'P1_CORRECTION_UPDATED')).toEqual(edited);
    expect(f.repo.snapshot().memories).toEqual(afterEdit.memories);
    expect(f.repo.snapshot().memoryOperations).toEqual(afterEdit.memoryOperations);
    await expect(f.memory.editFromChat(editReply.id, 'P1_CORRECTION_ORIGINAL', 'CONFLICTING_REPLACEMENT')).rejects.toThrow('memory.operationConflict');
    await expect(f.memory.editFromChat(editReply.id, 'CONFLICTING_QUERY', 'P1_CORRECTION_UPDATED')).rejects.toThrow('memory.operationConflict');
    const forgetReply = await f.turn('忘记 P1_CORRECTION_UPDATED');
    const deleted = await f.memory.forgetFromChat(forgetReply.id, 'P1_CORRECTION_UPDATED');
    expect(deleted).toMatchObject({ kind: 'deleted', memoryId: original.id });
    const afterDelete = f.repo.snapshot();
    expect(await f.memory.forgetFromChat(forgetReply.id, 'P1_CORRECTION_UPDATED')).toEqual(deleted);
    await expect(f.memory.forgetFromChat(forgetReply.id, 'CONFLICTING_QUERY')).rejects.toThrow('memory.operationConflict');
    // A valid historical receipt can be returned without restoring its content.
    expect(await f.memory.editFromChat(editReply.id, 'P1_CORRECTION_ORIGINAL', 'P1_CORRECTION_UPDATED')).toEqual(edited);
    expect(f.repo.snapshot().memories).toEqual([]);
    expect(f.repo.snapshot().memoryOperations).toEqual(afterDelete.memoryOperations);
    expect(f.repo.snapshot().memoryRevision).toBe(afterDelete.memoryRevision);
    expect((await f.reopen()).snapshot().memories).toEqual([]);
  });

  it('serializes failed and successful contenders without publishing the failed draft', async () => {
    const f = await fixture(); const first = await f.turn('请记住：FAILED_CONTENDER'); const second = await f.turn('请记住：WINNING_CONTENDER');
    fault.mode = 'before'; const results = await Promise.allSettled([
      f.memory.saveFromChat(first.id, 'FAILED_CONTENDER'), f.memory.saveFromChat(second.id, 'WINNING_CONTENDER'),
    ]);
    expect(results.map((item) => item.status)).toEqual(['rejected', 'fulfilled']);
    expect(f.memory.list().map((item) => item.text)).toEqual(['WINNING_CONTENDER']);
    expect((await f.reopen()).snapshot().memories).toEqual(f.memory.list());
  });
});
