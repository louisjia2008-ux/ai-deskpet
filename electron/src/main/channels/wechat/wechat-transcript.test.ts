// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatService } from '../../domain/chat-service';
import { DomainRepository } from '../../domain/repository';
import { assertSessionChannel, DESKTOP_CHANNEL } from '../../security/execution-context';
import { WeChatTranscript, wechatChannelBindingId, wechatSessionId } from './wechat-transcript';

const roots: string[] = [];
const vault = { getVaultKey: async () => Buffer.alloc(32, 67) };
const privateBinding = 'a'.repeat(64);
const groupBinding = 'b'.repeat(64);
const friendBinding = 'f'.repeat(64);
const incoming = { id: 'c'.repeat(64), binding: privateBinding, scope: 'private', title: 'Owner fixture', role: 'user',
  text: '私聊秘密 fixture 004', at: 1_800_000_000 };
const outgoing = { ...incoming, role: 'assistant', text: '已确认的回复 fixture 005', at: 1_800_000_001 };
const groupIncoming = { ...incoming, binding: groupBinding, id: 'd'.repeat(64), scope: 'group', title: 'Group fixture',
  text: '群聊消息 fixture 006', at: null, sender: 'Member fixture' };
const friendIncoming = { ...incoming, binding: friendBinding, id: 'e'.repeat(64), scope: 'friend', title: 'Friend fixture',
  text: '好友消息 fixture 007', wechatFriend: true };
const friendOutgoing = { ...friendIncoming, role: 'assistant', text: '好友回执 fixture 008', at: friendIncoming.at + 1 };

async function fixture(entries: object[]) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-transcript-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen();
  const chat = new ChatService(repository);
  const source = {
    readTranscript: vi.fn(async (): Promise<unknown> => ({ version: 1, entries, more: false })),
    acknowledgeTranscript: vi.fn<(input: object) => Promise<unknown>>(async () => ({ ok: true })),
  };
  const host = { available: () => true, locale: () => 'zh-CN' as const, changed: vi.fn() };
  return { chat, repository, path, reopen, source, host, sync: new WeChatTranscript(repository, source, host) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('persists accepted incoming and confirmed outgoing only, in distinct read-only encrypted sessions', async () => {
  const f = await fixture([incoming, outgoing, groupIncoming]);
  const desktop = await f.chat.createSession('Existing desktop', 'normal');
  const qq = await f.chat.createSession('Existing QQ', 'normal', new Date(), '542bd3df-7376-4dd0-8d3e-0500d0ef8c09');
  await f.sync.sync();
  const stored = new ChatService(await f.reopen());
  const sessions = stored.listSessions();
  expect(sessions).toHaveLength(4);
  expect(sessions).toEqual(expect.arrayContaining([desktop, qq]));
  const privateId = wechatSessionId(privateBinding);
  const groupId = wechatSessionId(groupBinding);
  expect(sessions.find(session => session.id === privateId)).toMatchObject({
    title: '微信私聊 · Owner fixture', channelBindingId: wechatChannelBindingId(privateBinding), historyPrivacy: 'local-only',
    wechatTranscript: 'private',
  });
  expect(sessions.find(session => session.id === groupId)).toMatchObject({ title: '微信群 · Group fixture', wechatTranscript: 'group' });
  expect(stored.listMessages(privateId)).toEqual([
    expect.objectContaining({ role: 'user', content: incoming.text, createdAt: new Date(incoming.at * 1_000).toISOString() }),
    expect.objectContaining({ role: 'assistant', content: outgoing.text }),
  ]);
  expect(stored.listMessages(groupId)).toEqual([expect.objectContaining({ role: 'user', content: groupIncoming.text, wechatSender: 'Member fixture' })]);
  expect(stored.listSessions({ query: incoming.text }).map(session => session.id)).toEqual([privateId]);
  expect(stored.listMessages(privateId)[0]?.contextTrace).toBeUndefined();
  expect(stored.listMessages(groupId)[0]?.nightlyEligible).toBeUndefined();
  expect(() => stored.beginTurn(privateId)).toThrow('chat.sessionUnavailable');
  expect(() => assertSessionChannel(wechatChannelBindingId(privateBinding), DESKTOP_CHANNEL)).toThrow();
  await expect(stored.addMessage({ sessionId: groupId, content: 'Do not append', role: 'assistant', status: 'complete', errorCode: null })).rejects.toThrow();
  const encrypted = await readFile(f.path, 'utf8');
  expect(encrypted).not.toContain(incoming.text);
  expect(encrypted).not.toContain(groupIncoming.text);
  expect(f.host.changed).toHaveBeenCalledTimes(1);
});

it('replays safely after an acknowledgement failure and keeps archived or deleted conversations hidden', async () => {
  const f = await fixture([incoming, outgoing]);
  f.source.acknowledgeTranscript.mockRejectedValueOnce(new Error('helper interrupted'));
  await expect(f.sync.sync()).rejects.toThrow('helper interrupted');
  const repository = await f.reopen();
  const chat = new ChatService(repository);
  const privateId = wechatSessionId(privateBinding);
  const before = chat.listMessages(privateId);
  await chat.setArchived(privateId, true);
  const importer = new WeChatTranscript(repository, f.source, f.host);
  await importer.sync();
  expect(chat.listMessages(privateId)).toEqual(before);
  expect(chat.listSessions()).toEqual([]);
  expect(f.source.acknowledgeTranscript).toHaveBeenLastCalledWith({ version: 1, entries: [
    { id: incoming.id, role: 'user' }, { id: outgoing.id, role: 'assistant' },
  ] });
  expect(f.host.changed).toHaveBeenCalledTimes(1);
  await chat.removeSession(privateId);
  f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [{ ...incoming, id: 'e'.repeat(64) }], more: false });
  await importer.sync();
  expect(chat.listSessions()).toEqual([]);
  expect(chat.listSessions({ scope: 'deleted' })).toHaveLength(1);
  await chat.restoreSession(privateId);
  expect(chat.listMessages(privateId)).toHaveLength(3);
});

it('reopens a full owner message and retains the shorter transcript bounds for other roles and scopes', async () => {
  const text = '😀'.repeat(1_000);
  const f = await fixture([{ ...incoming, text }, { ...outgoing, text: '🙂'.repeat(500) }]);
  await f.sync.sync();
  const chat = new ChatService(await f.reopen());
  expect(chat.listMessages(wechatSessionId(privateBinding))).toEqual([
    expect.objectContaining({ role: 'user', content: text }),
    expect.objectContaining({ role: 'assistant', content: '🙂'.repeat(500) }),
  ]);
  expect(f.source.acknowledgeTranscript).toHaveBeenCalledTimes(1);

  for (const entry of [
    { ...incoming, text: '字'.repeat(1_001) }, { ...incoming, text: text + '😀' }, { ...incoming, text: '\ud800' },
    ...[outgoing, groupIncoming, friendIncoming].map(entry => ({ ...entry, text: '字'.repeat(501) })),
  ]) {
    f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [entry], more: false });
    await expect(f.sync.sync()).rejects.toThrow();
  }
  expect(f.source.acknowledgeTranscript).toHaveBeenCalledTimes(1);
});

it('marks both sides of a friend transcript, preserves the marker on restart, and rejects scope substitution', async () => {
  const f = await fixture([incoming, friendIncoming, friendOutgoing]);
  await f.sync.sync();
  const stored = new ChatService(await f.reopen());
  const friendId = wechatSessionId(friendBinding);
  const ownerId = wechatSessionId(privateBinding);
  expect(stored.listSessions().find(session => session.id === friendId)).toMatchObject({
    title: '微信好友 · Friend fixture', wechatTranscript: 'friend', historyPrivacy: 'local-only',
    channelBindingId: wechatChannelBindingId(friendBinding),
  });
  expect(stored.listMessages(friendId)).toEqual([
    expect.objectContaining({ role: 'user', content: friendIncoming.text, wechatFriend: true }),
    expect.objectContaining({ role: 'assistant', content: friendOutgoing.text, wechatFriend: true }),
  ]);
  expect(stored.listMessages(ownerId)).toEqual([expect.objectContaining({ content: incoming.text })]);
  expect(stored.listMessages(ownerId)[0]?.wechatFriend).toBeUndefined();
  expect(() => stored.beginTurn(friendId)).toThrow('chat.sessionUnavailable');
  expect(await readFile(f.path, 'utf8')).not.toContain(friendIncoming.text);

  for (const entry of [
    { ...friendIncoming, wechatFriend: undefined },
    { ...friendIncoming, scope: 'private' },
    { ...friendIncoming, binding: privateBinding },
  ]) {
    f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [entry], more: false });
    await expect(f.sync.sync()).rejects.toThrow();
  }
  expect(f.source.acknowledgeTranscript).toHaveBeenCalledTimes(1);
});

it('coalesces concurrent reads, drains more pages, and never acknowledges an invalid or conflicting batch', async () => {
  const f = await fixture([incoming]);
  f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [incoming], more: true })
    .mockResolvedValueOnce({ version: 1, entries: [outgoing], more: false });
  await Promise.all([f.sync.sync(), f.sync.sync()]);
  expect(f.source.readTranscript).toHaveBeenCalledTimes(2);
  expect(f.source.acknowledgeTranscript).toHaveBeenCalledTimes(2);
  const groupId = wechatSessionId(groupBinding);
  f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [groupIncoming, { ...incoming, text: 'Unexpected duplicate' }], more: false });
  await expect(f.sync.sync()).rejects.toThrow('wechat.transcriptConflict');
  expect(() => f.chat.listMessages(groupId)).toThrow('chat.sessionUnavailable');
  f.source.readTranscript.mockResolvedValueOnce({ version: 1, entries: [{ ...groupIncoming, scope: 'unbound' }], more: false });
  await expect(f.sync.sync()).rejects.toThrow();
  expect(f.source.acknowledgeTranscript).toHaveBeenCalledTimes(2);
});
