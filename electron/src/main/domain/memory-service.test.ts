import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { buildChatContext } from './chat-context';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
const binding = { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true } as const;

it('persists saved memory across reload, uses edits in a fresh conversation, and stops injecting removed memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-memory-lifecycle-'));
  const path = join(root, 'domain.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 19) };
  const reopen = async (): Promise<DomainRepository> => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const id = randomUUID();
  try {
    const first = await reopen();
    const oldChat = await new ChatService(first).createSession('Old memory check', 'normal');
    await new MemoryService(first).upsert({ id, text: '验收暗号：薄荷星舟-7249', tags: ['验收'] });
    await new ChatService(first).addMessage({ sessionId: oldChat.id, role: 'assistant', content: '验收暗号：薄荷星舟-7249', status: 'complete', errorCode: null });
    expect(await readFile(path, 'utf8')).not.toContain('薄荷星舟');

    const second = await reopen();
    const newChat = await new ChatService(second).createSession('Fresh memory check', 'normal');
    const context = () => buildChatContext({ binding, sessionId: newChat.id, locale: 'zh-CN', query: '验收暗号是什么？', history: second.snapshot().chatMessages, memories: new MemoryService(second).list() });
    expect(JSON.stringify(context())).toContain('薄荷星舟-7249');
    expect(context().filter((message) => message.role === 'assistant')).toEqual([]);
    await new MemoryService(second).upsert({ id, text: '验收暗号已更新：蓝莓小岛-5831', tags: ['验收'] });
    expect(new MemoryService(second).list()).toHaveLength(1);
    expect(JSON.stringify(context())).toContain('蓝莓小岛-5831');
    expect(JSON.stringify(context())).not.toContain('薄荷星舟-7249');
    await new MemoryService(second).remove(id);

    const third = await reopen();
    expect(new MemoryService(third).list()).toEqual([]);
    const afterDelete = buildChatContext({ binding, sessionId: newChat.id, locale: 'zh-CN', query: '验收暗号是什么？', history: third.snapshot().chatMessages, memories: new MemoryService(third).list() });
    expect(JSON.stringify(afterDelete)).not.toMatch(/薄荷星舟|蓝莓小岛/u);
    expect(new ChatService(third).listMessages(oldChat.id)[0]?.content).toContain('薄荷星舟');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('allows every local-only memory for cloud models in one step, keeping revisions and private replies as they were', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-memory-share-all-'));
  const remote = { providerId: 'test-cloud', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'fixture' } as const;
  try {
    const repository = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 23) });
    await repository.initialize();
    const memory = new MemoryService(repository);
    const session = await new ChatService(repository).createSession('Cloud check', 'normal');
    const local = await memory.upsert({ id: randomUUID(), text: '我喜欢茉莉花茶。', tags: [], privacy: 'local-only' });
    const open = await memory.upsert({ id: randomUUID(), text: '我住在上海。', tags: [] });
    const context = () => JSON.stringify(buildChatContext({ binding: remote, sessionId: session.id, locale: 'zh-CN', query: '我喜欢喝什么茶？', history: [], memories: memory.list() }));
    expect(context()).not.toContain('茉莉花茶');
    const before = repository.snapshot().memoryRevision;
    expect(await memory.shareAllWithCloud()).toBe(1);
    expect(context()).toContain('茉莉花茶');
    expect(memory.list().map((item) => [item.id, item.contextMetadata?.privacy, item.contextMetadata?.revision])).toEqual(
      [local, open].map((item) => [item.id, 'cloud-allowed', item.contextMetadata?.revision]));
    expect(repository.snapshot().memoryRevision).toBe(before + 1);
    expect(await memory.shareAllWithCloud()).toBe(0);
    expect(repository.snapshot().memoryRevision).toBe(before + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
