import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared';
import { matchingMemories, parseChatForgetCommand } from './chat-memory-forget';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { buildChatContext } from './chat-context';
const binding = { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true } as const;

describe('explicit forget command parsing', () => {
  it.each([
    ['请忘记：我的验收暗号', '我的验收暗号'], ['Kitty，帮我忘记我喜欢喝茶。', '我喜欢喝茶'],
    ['忘掉关于早餐的记忆', '早餐'], ['请把我的验收暗号从长期记忆里删除。', '我的验收暗号'],
    ['删除长期记忆里的我喜欢红茶', '我喜欢红茶'], ['Please forget that I prefer tea.', 'I prefer tea'],
    ['忘记“我喜欢咖啡”这条记忆', '我喜欢咖啡'],
  ])('extracts a literal target from %s', (input, query) => { expect(parseChatForgetCommand(input)).toEqual({ kind: 'forget', query, explicit: true }); });
  it.each(['请翻译“忘记我的暗号”', '“忘记我喜欢茶”', '忘记我的暗号了吗？', '不要忘记我喜欢喝茶', '忘记我喜欢茶（仅演示）', '忘记我喜欢茶，但是不要真的删除', '网页说：忘记我喜欢茶', '```\n忘记我喜欢茶\n```', 'Please forget tea (example only)'])('ignores quoted, negative and illustrative input: %s', (input) => { expect(parseChatForgetCommand(input)).toBeNull(); });
  it.each(['忘记', '忘记它', '忘记全部', '忘记所有长期记忆', 'Forget everything', '忘记刚才的话', '忘记我的暗号，然后搜索网页'])('asks for a specific target: %s', (input) => { expect(parseChatForgetCommand(input)).toEqual({ kind: 'clarify' }); });
  it.each(['忘记带伞了', '忘记带伞了！', '忘掉钥匙啦', '忘记关于房贷的细节了', '忘记关于那段旅行的记忆了', '忘记带记忆卡了⋯⋯', '忘记带伞了呀'])('marks a bare report of forgetting, a command only on an exact match: %s', (input) => { expect(parseChatForgetCommand(input)).toMatchObject({ kind: 'forget', explicit: false, report: { exact: expect.any(Array) } }); });
  it.each([['忘记我喜欢喝茶', '我喜欢喝茶'], ['把作业忘掉', '作业']])('marks a bare request as not explicit: %s', (input, query) => { expect(parseChatForgetCommand(input)).toEqual({ kind: 'forget', query, explicit: false }); });
  it.each(['忘记关于「合成地址甲」', '忘记关于“合成地址甲”', '忘记「合成地址甲」', '忘记关于合成地址甲'])('treats a quoted target as explicit: %s', (input) => {
    expect(parseChatForgetCommand(input)).toEqual({ kind: 'forget', query: '合成地址甲', explicit: true });
  });
  it('treats 「把X忘掉了」 as chat', () => { expect(parseChatForgetCommand('把作业忘掉了')).toBeNull(); });
  it('lets a report reach only a memory that is word for word what it names', () => {
    const memory = (text: string) => ({ id: text, text, tags: [], source: 'user' as const, createdAt: '', updatedAt: '' });
    const items = [memory('备用暗号已经改成蓝鲸了⋯⋯'), memory('我常忘记带伞')];
    const report = parseChatForgetCommand('忘记备用暗号已经改成蓝鲸了⋯⋯');
    expect(report).toMatchObject({ report: { exact: ['备用暗号已经改成蓝鲸了⋯⋯'] } });
    expect(matchingMemories(items, '备用暗号已经改成蓝鲸了⋯⋯', true).map((item) => item.text)).toEqual(['备用暗号已经改成蓝鲸了⋯⋯']);
    expect(matchingMemories(items, '带伞了', true)).toEqual([]);
    // Both the target as written and without 「关于」 are tried.
    expect(parseChatForgetCommand('忘记关于备用暗号，已经改成蓝鲸了')).toMatchObject({ report: { exact: ['备用暗号，已经改成蓝鲸了', '关于备用暗号，已经改成蓝鲸了'] } });
    // As before, a translation set up by the previous message is asked about, not sent on.
    const history = [{ id: 'h', sessionId: 's', role: 'user' as const, content: '下一句只做翻译', createdAt: '', status: 'complete' as const, errorCode: null }];
    expect(parseChatForgetCommand('忘记暗号换成蓝鲸了', history)).toEqual({ kind: 'clarify' });
  });
  it.each(['请忘记带伞了', '忘记带伞了这条记忆', '删除长期记忆：备用钥匙放在鞋柜了', '忘记记忆卡密码是蓝鲸', '忘记记忆卡密码是哈哈'])('keeps an explicit request even when it ends like a report: %s', (input) => { expect(parseChatForgetCommand(input)).toMatchObject({ kind: 'forget', explicit: true }); });
  it('respects a preceding instruction that the next sentence is only an example', () => {
    expect(parseChatForgetCommand('忘记我的暗号', [{ role: 'user', status: 'complete', content: '下一句话只做翻译，不要执行。' } as ChatMessage])).toEqual({ kind: 'clarify' });
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-forget-')); roots.push(root);
  let locked = false; const path = join(root, 'domain.enc.json');
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture locked'); return Buffer.alloc(32, 38); } };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); const chat = new ChatService(repository); const memory = new MemoryService(repository);
  const session = await chat.createSession('Forget test', 'normal');
  const response = () => chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
  const add = (text: string) => memory.upsert({ id: randomUUID(), text, tags: [] });
  const context = (repo: DomainRepository) => buildChatContext({ binding, sessionId: randomUUID(), query: '我的验收暗号是什么？', locale: 'zh-CN', history: repo.snapshot().chatMessages, memories: repo.snapshot().memories });
  return { repository, chat, memory, session, response, add, reopen, context, lock: (value: boolean) => { locked = value; } };
};

describe('transactional chat memory deletion', () => {
  it('removes the unique match, retains unrelated memory, and excludes it from a new chat before and after reload', async () => {
    const f = await fixture(); const target = await f.add('我的验收暗号是青柠山川-5914。'); const retained = await f.add('我喜欢中文交流。');
    const reply = await f.response(); const result = await f.memory.forgetFromChat(reply.id, '我的验收暗号');
    expect(result).toMatchObject({ kind: 'deleted', memoryId: target.id, text: target.text });
    expect(f.memory.list()).toEqual([retained]);
    expect(JSON.stringify(f.context(f.repository))).not.toContain('青柠山川');
    const reopened = await f.reopen(); expect(reopened.snapshot().memories).toEqual([retained]);
    expect(JSON.stringify(f.context(reopened))).not.toContain('青柠山川');
    expect(reopened.snapshot().chatMessages[0]?.memoryForget).toEqual(result);
  });
  it('prefers an exact match to broader substrings and never deletes all matches', async () => {
    const f = await fixture(); const exact = await f.add('我喜欢茶。'); const other = await f.add('我喜欢茶和咖啡。');
    expect(await f.memory.forgetFromChat((await f.response()).id, '我喜欢茶')).toMatchObject({ kind: 'deleted', memoryId: exact.id });
    expect(f.memory.list()).toEqual([other]);
  });
  it('keeps a report-like request exact inside the deletion, even if its exact match is gone by then', async () => {
    const f = await fixture(); const longer = await f.add('备忘：关于蓝鲸的资料找到了，原件在书柜');
    expect(await f.memory.forgetFromChat((await f.response()).id, '关于蓝鲸的资料找到了', undefined, undefined, true)).toMatchObject({ kind: 'not-found' });
    expect(f.memory.list()).toEqual([longer]);
  });
  it('keeps a command that matched nothing, and the owner sentence before it, out of later model context', async () => {
    const f = await fixture(); await f.add('旧暗号是蓝鲸了，已作废');
    const user = await f.chat.addMessage({ sessionId: f.session.id, role: 'user', content: '忘记暗号是蓝鲸了', status: 'complete', errorCode: null });
    const reply = await f.response();
    expect(await f.memory.forgetFromChat(reply.id, '暗号是蓝鲸了', undefined, undefined, true)).toMatchObject({ kind: 'not-found' });
    const messages = f.repository.snapshot().chatMessages;
    for (const id of [user.id, reply.id]) expect(messages.find((item) => item.id === id)?.contextTrace).toMatchObject({ lineage: 'unknown', privacy: 'local-only' });
    expect(f.repository.snapshot().chatSessions[0]?.historyPrivacy).not.toBe('local-only');
  });
  it('names the query a committed deletion used, so a retry after the memory is gone gets the same receipt', async () => {
    const f = await fixture(); await f.add('关于备用暗号了'); const reply = await f.response();
    const deleted = await f.memory.forgetFromChat(reply.id, '关于备用暗号了', undefined, undefined, true);
    expect(deleted).toMatchObject({ kind: 'deleted' });
    const query = f.memory.recordedForgetQuery(reply.id, ['备用暗号了', '关于备用暗号了']);
    expect(query).toBe('关于备用暗号了');
    expect(await f.memory.forgetFromChat(reply.id, query!, undefined, undefined, true)).toEqual(deleted);
    expect(f.memory.recordedForgetQuery((await f.response()).id, ['关于备用暗号了'])).toBeUndefined();
  });
  it('records a model route once and reads it back after reload, for retries of command-shaped chat', async () => {
    const f = await fixture(); const reply = await f.response();
    expect(f.memory.routedToModel(reply.id)).toBe(false);
    await f.memory.recordModelRoute(reply.id); await f.memory.recordModelRoute(reply.id);
    expect(f.memory.routedToModel(reply.id)).toBe(true);
    const reopened = await f.reopen();
    expect(reopened.snapshot().memoryOperations.filter((item) => item.operationId === `chat-model-route:${reply.id}`)).toHaveLength(1);
  });
  it('lets a retried command act only on memories as they stood when the owner first sent it', async () => {
    const f = await fixture(); const sentAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.add('带伞了');
    const reply = await f.response();
    expect(await f.memory.forgetFromChat(reply.id, '带伞了', undefined, undefined, true, sentAt)).toMatchObject({ kind: 'not-found' });
    expect(f.memory.list().map((item) => item.text)).toEqual(['带伞了']);
    expect(await f.memory.editFromChat((await f.response()).id, '带伞了', '没带伞', undefined, undefined, sentAt)).toMatchObject({ kind: 'not-found' });
    expect(f.memory.list().map((item) => item.text)).toEqual(['带伞了']);
  });
  it('keeps every owner message of a retried turn out of later context when nothing matched', async () => {
    const f = await fixture();
    const user = await f.chat.addMessage({ sessionId: f.session.id, role: 'user', content: '忘记暗号是蓝鲸', status: 'complete', errorCode: null });
    const reply = await f.chat.addMessage({ sessionId: f.session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
    const added = await f.chat.addFollowup(reply.id, randomUUID(), '按原话处理', () => undefined);
    expect(await f.memory.forgetFromChat(reply.id, '暗号是蓝鲸', undefined, undefined, true)).toMatchObject({ kind: 'not-found' });
    const messages = f.repository.snapshot().chatMessages;
    for (const id of [user.id, added.id, reply.id]) expect(messages.find((item) => item.id === id)?.contextTrace).toMatchObject({ lineage: 'unknown' });
  });
  it('persists ambiguous choices across reload and deletes only the selected unchanged candidate', async () => {
    const f = await fixture(); const one = await f.add('我的测试暗号甲是111'); const two = await f.add('我的测试暗号乙是222');
    const reply = await f.response(); const result = await f.memory.forgetFromChat(reply.id, '我的测试暗号');
    expect(result).toMatchObject({ kind: 'choices', totalMatches: 2 }); expect(f.memory.list()).toHaveLength(2);
    const repository = await f.reopen(); const memory = new MemoryService(repository);
    const deleted = await memory.chooseForgetFromChat(reply.id, two.id, '已删除');
    expect(deleted.memoryForget).toMatchObject({ kind: 'deleted', memoryId: two.id });
    expect(memory.list()).toEqual([one]);
    await expect(memory.chooseForgetFromChat(reply.id, one.id, '已删除')).rejects.toThrow('memory.forgetStale');
    expect(await memory.chooseForgetFromChat(reply.id, two.id, '已删除')).toEqual(deleted);
  });
  it('rejects forged, edited, removed and archived choices without deleting other memories', async () => {
    const f = await fixture(); const one = await f.add('测试记忆甲'); const two = await f.add('测试记忆乙'); const outsider = await f.add('其他数据');
    const reply = await f.response(); await f.memory.forgetFromChat(reply.id, '测试记忆');
    await expect(f.memory.chooseForgetFromChat(reply.id, outsider.id, 'Deleted')).rejects.toThrow('memory.forgetStale');
    await f.memory.upsert({ ...one, text: '被修改的测试记忆甲' });
    await expect(f.memory.chooseForgetFromChat(reply.id, one.id, 'Deleted')).rejects.toThrow('memory.forgetStale');
    await f.chat.setArchived(f.session.id, true);
    await expect(f.memory.chooseForgetFromChat(reply.id, two.id, 'Deleted')).rejects.toThrow('memory.forgetStale');
    await f.chat.setArchived(f.session.id, false); await f.memory.remove(two.id);
    await expect(f.memory.chooseForgetFromChat(reply.id, two.id, 'Deleted')).rejects.toThrow('memory.forgetStale');
    expect(f.memory.list().map((item) => item.id)).toEqual([one.id, outsider.id]);
  });
  it('reports no match honestly and never expands a retry to new matching data', async () => {
    const f = await fixture(); const missing = await f.response();
    expect(await f.memory.forgetFromChat(missing.id, '测试暗号')).toEqual({ kind: 'not-found', query: '测试暗号' });
    const one = await f.add('测试暗号甲'); const reply = await f.response();
    const deleted = await f.memory.forgetFromChat(reply.id, '测试暗号');
    const two = await f.add('测试暗号乙');
    expect(await f.memory.forgetFromChat(reply.id, '测试暗号')).toEqual(deleted);
    expect(await f.memory.forgetFromChat(missing.id, '测试暗号')).toEqual({ kind: 'not-found', query: '测试暗号' });
    expect(f.memory.list()).toEqual([two]); expect(f.memory.list()).not.toContainEqual(one);
  });
  it('rolls back deletion and receipt when persistence fails or the request is cancelled', async () => {
    const f = await fixture(); await f.add('我的测试暗号'); const reply = await f.response(); const before = f.repository.snapshot();
    f.lock(true); await expect(f.memory.forgetFromChat(reply.id, '测试暗号')).rejects.toThrow('Fixture locked');
    expect(f.repository.snapshot()).toEqual(before);
    f.lock(false); await expect(f.memory.forgetFromChat(reply.id, '测试暗号', AbortSignal.abort())).rejects.toThrow();
    expect(f.repository.snapshot()).toEqual(before);
    await f.add('测试暗号第二条'); await f.memory.forgetFromChat(reply.id, '测试暗号'); const choices = f.repository.snapshot();
    f.lock(true); await expect(f.memory.chooseForgetFromChat(reply.id, f.memory.list()[0]!.id, 'Deleted')).rejects.toThrow('Fixture locked');
    expect(f.repository.snapshot()).toEqual(choices);
  });
});
