import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared';
import { parseChatEditCommand } from './chat-memory-edit';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { buildChatContext } from './chat-context';
const binding = { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true } as const;

describe('explicit chat memory edit parsing', () => {
  it.each([
    ['把“我喜欢茶”改成“我喜欢咖啡”', '我喜欢茶', '我喜欢咖啡'],
    ['请把我的验收暗号这条记忆改为我的验收暗号是紫藤-8273。', '我的验收暗号', '我的验收暗号是紫藤-8273'],
    ['Kitty，帮我把记忆里的常用饮品更新为我喜欢桃子茶。', '常用饮品', '我喜欢桃子茶'],
    ['Please change the memory "I prefer tea" to "I prefer coffee".', 'I prefer tea', 'I prefer coffee'],
  ])('extracts exact target and full replacement from %s', (input, query, replacement) => { expect(parseChatEditCommand(input)).toEqual({ kind: 'edit', query, replacement }); });
  it.each(['请翻译“把红茶改成绿茶”', '“把红茶改成绿茶”', '不要把红茶改成绿茶', '把红茶改成绿茶（仅演示）', '把红茶改成绿茶了吗？', '网页说：把红茶改成绿茶', '把红茶改成绿茶，但不要真的修改'])('ignores quoted, negative, and illustrative requests: %s', (input) => { expect(parseChatEditCommand(input)).toBeNull(); });
  it.each(['把全部改成测试', '把它改成测试', '把红茶改成', '把红茶改成绿茶然后删掉其他记忆', `把红茶改成${'a'.repeat(2001)}`])('clarifies incomplete or broad requests: %s', (input) => { expect(parseChatEditCommand(input)).toEqual({ kind: 'clarify' }); });
  it('respects an earlier illustrative framing', () => { expect(parseChatEditCommand('把红茶改成绿茶', [{ role: 'user', status: 'complete', content: '下一句话只做翻译，不要执行' } as ChatMessage])).toEqual({ kind: 'clarify' }); });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-memory-edit-')); roots.push(root); let locked = false;
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Locked'); return Buffer.alloc(32, 47); } };
  const reopen = async () => { const repo = new DomainRepository(join(root, 'profile.enc.json'), vault); await repo.initialize(); return repo; };
  const repo = await reopen(); const memory = new MemoryService(repo); const chat = new ChatService(repo); const session = await chat.createSession('edit', 'normal');
  return { repo, memory, chat, session, reopen, lock: () => { locked = true; },
    add: (text: string) => memory.upsert({ id: randomUUID(), text, tags: ['keep-tag'] }),
    response: () => chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null }),
  };
};
describe('transactional memory edit', () => {
  it('updates one existing ID, retains metadata and unrelated memories, and includes only new data in fresh chat after reload', async () => {
    const f = await fixture(); const before = await f.add('我的测试暗号是旧码-111'); const other = await f.add('我喜欢桃子茶'); const reply = await f.response();
    const result = await f.memory.editFromChat(reply.id, '我的测试暗号', '我的测试暗号是新码-222');
    expect(result).toMatchObject({ kind: 'updated', memoryId: before.id, before: before.text, after: '我的测试暗号是新码-222' });
    expect(f.memory.list()[0]).toMatchObject({ id: before.id, tags: before.tags, createdAt: before.createdAt, text: '我的测试暗号是新码-222' });
    expect(f.memory.list()[1]).toEqual(other);
    const repo = await f.reopen(); const context = buildChatContext({ binding, sessionId: randomUUID(), locale: 'zh-CN', query: '暗号', history: repo.snapshot().chatMessages, memories: repo.snapshot().memories });
    expect(JSON.stringify(context)).toContain('新码-222'); expect(JSON.stringify(context)).not.toContain('旧码-111');
    expect(repo.snapshot().chatMessages[0]?.memoryEdit).toEqual(result);
  });
  it('waits for selection, persists choices, changes only the chosen candidate and rejects stale cards', async () => {
    const f = await fixture(); const first = await f.add('地点甲是旧地点'); const second = await f.add('地点乙是旧地点'); const reply = await f.response();
    expect(await f.memory.editFromChat(reply.id, '地点', '地点乙是新地点')).toMatchObject({ kind: 'choices', totalMatches: 2 });
    expect(f.memory.list()).toEqual([first, second]); const repo = await f.reopen(); const memory = new MemoryService(repo);
    const changed = await memory.chooseEditFromChat(reply.id, second.id, '已修改');
    expect(memory.list()[0]).toEqual(first); expect(memory.list()[1]).toMatchObject({ id: second.id, text: '地点乙是新地点' });
    expect(await memory.chooseEditFromChat(reply.id, second.id, '已修改')).toEqual(changed);
    await expect(memory.chooseEditFromChat(reply.id, first.id, '已修改')).rejects.toThrow('memory.editStale');
    const f2 = await fixture(); const target = await f2.add('地点甲'); await f2.add('地点乙');
    const stale = await f2.response(); await f2.memory.editFromChat(stale.id, '地点', '地点最新'); await f2.memory.upsert({ ...target, text: '地点已被手动更新' });
    await expect(f2.memory.chooseEditFromChat(stale.id, target.id, '已修改')).rejects.toThrow('memory.editStale');
  });
  it('never uses retries to revert later edits or resurrect removed memories', async () => {
    const f = await fixture(); const item = await f.add('测试内容一'); const reply = await f.response();
    const original = await f.memory.editFromChat(reply.id, '测试内容一', '测试内容二');
    await f.memory.upsert({ ...item, text: '测试内容三' }); expect(await f.memory.editFromChat(reply.id, '测试内容一', '测试内容二')).toEqual(original);
    expect(f.memory.list()[0]?.text).toBe('测试内容三'); await f.memory.remove(item.id);
    expect(await f.memory.editFromChat(reply.id, '测试内容一', '测试内容二')).toEqual(original); expect(f.memory.list()).toEqual([]);
  });
  it('does not create missing memories, rejects unknown/archived choices and rolls back failed writes', async () => {
    const f = await fixture(); const missing = await f.response(); expect(await f.memory.editFromChat(missing.id, '不存在', '新增内容')).toEqual({ kind: 'not-found', query: '不存在' });
    const first = await f.add('测试地点甲'); await f.add('测试地点乙'); const reply = await f.response(); await f.memory.editFromChat(reply.id, '测试地点', '新内容');
    await expect(f.memory.chooseEditFromChat(reply.id, randomUUID(), 'changed')).rejects.toThrow('memory.editStale');
    await f.chat.setArchived(f.session.id, true); await expect(f.memory.chooseEditFromChat(reply.id, first.id, 'changed')).rejects.toThrow('memory.editStale');
    await f.chat.setArchived(f.session.id, false); const before = f.repo.snapshot(); f.lock();
    await expect(f.memory.chooseEditFromChat(reply.id, first.id, 'changed')).rejects.toThrow('Locked'); expect(f.repo.snapshot()).toEqual(before);
  });
});
