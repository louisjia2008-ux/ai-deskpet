import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { buildChatContext } from './chat-context';
const binding = { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true } as const;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-chat-memory-')); roots.push(root);
  let locked = false;
  const path = join(root, 'domain.enc.json');
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture locked'); return Buffer.alloc(32, 29); } };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); const chat = new ChatService(repository); const memory = new MemoryService(repository);
  const session = await chat.createSession('Remember test', 'normal');
  const response = () => chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  return { repository, chat, memory, session, response, path, reopen, lock: (value: boolean) => { locked = value; } };
};

describe('chat memory persistence and receipts', () => {
  it('atomically persists the exact memory and receipt and recalls it in a fresh chat after reload', async () => {
    const f = await fixture(); const message = await f.response(); const text = '我的验收暗号是银杏月舟-6832。';
    const receipt = await f.memory.saveFromChat(message.id, text);
    expect(receipt).toMatchObject({ text, reused: false });
    expect(f.chat.listMessages(f.session.id)[0]?.memoryReceipts).toEqual([receipt]);
    expect(await readFile(f.path, 'utf8')).not.toContain('银杏月舟');
    const repository = await f.reopen();
    const fresh = await new ChatService(repository).createSession('Fresh recall', 'normal');
    const context = buildChatContext({ binding, sessionId: fresh.id, locale: 'zh-CN', query: '我的验收暗号是什么？', history: repository.snapshot().chatMessages, memories: new MemoryService(repository).list() });
    expect(context.some((item) => item.role === 'system' && item.content.includes(text))).toBe(true);
    expect(context.filter((item) => item.role !== 'system')).toEqual([]);
    expect(repository.snapshot().memories[0]).toMatchObject({ id: receipt.memoryId, text, source: 'user' });
  });

  it('deduplicates retries and concurrent repeated requests without overwriting an existing memory', async () => {
    const f = await fixture(); const first = await f.response(); const second = await f.response();
    const receipts = await Promise.all([f.memory.saveFromChat(first.id, '我喜欢茶。'), f.memory.saveFromChat(second.id, '我喜欢茶')]);
    expect(receipts[0]?.memoryId).toBe(receipts[1]?.memoryId);
    expect(receipts[1]?.reused).toBe(true);
    expect(await f.memory.saveFromChat(first.id, '我喜欢茶。')).toEqual(receipts[0]);
    expect(f.memory.list()).toHaveLength(1);
    expect(f.memory.list()[0]?.text).toBe('我喜欢茶。');
  });

  it('keeps both memory and receipt absent on persistence failure or cancellation', async () => {
    const f = await fixture(); const message = await f.response(); const before = f.repository.snapshot();
    f.lock(true);
    await expect(f.memory.saveFromChat(message.id, 'Must not appear')).rejects.toThrow('Fixture locked');
    expect(f.repository.snapshot()).toEqual(before);
    f.lock(false);
    await expect(f.memory.saveFromChat(message.id, 'Must not appear', AbortSignal.abort())).rejects.toThrow();
    expect(f.memory.list()).toEqual([]);
    expect(f.chat.listMessages(f.session.id)[0]?.memoryReceipts).toBeUndefined();
  });

  it('does not resurrect a removed memory on an old reply retry and excludes it from fresh model context', async () => {
    const f = await fixture(); const message = await f.response();
    const saved = await f.memory.saveFromChat(message.id, '临时暗号银杏月舟');
    await f.memory.remove(saved.memoryId);
    await expect(f.memory.saveFromChat(message.id, '临时暗号银杏月舟')).rejects.toThrow('memory.removed');
    const repository = await f.reopen(); const fresh = await new ChatService(repository).createSession('Fresh', 'normal');
    const context = buildChatContext({ binding, sessionId: fresh.id, locale: 'zh-CN', query: '暗号？', history: repository.snapshot().chatMessages, memories: new MemoryService(repository).list() });
    expect(JSON.stringify(context)).not.toContain('银杏月舟');
    expect(repository.snapshot().chatMessages[0]?.memoryReceipts).toEqual([saved]);
  });
});
