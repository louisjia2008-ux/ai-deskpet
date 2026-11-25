// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { ProviderAdapter, ProviderChatRequest, ProviderDispatchOptions, ProviderModelInspection } from '../providers/types';
import { ProviderService } from '../providers/provider-service';
import type { ProviderUtilityClient } from '../providers/utility-client';
import type { SafeStorageVault } from '../security';
import { answeringServiceIdentity, AutoMemoryService } from './auto-memory';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const provider: ProviderConfig = { id: '11111111-1111-4111-8111-111111111111', enabled: true, name: 'Fixture', model: 'm',
  kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', supportsTools: false, secretState: 'missing' };
const turn = { providerId: provider.id, model: 'm', destination: 'remote' as const };

async function fixture(reply: (request: ProviderChatRequest) => string) {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-auto-memory-'));
  roots.push(dir);
  const repo = new DomainRepository(join(dir, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 7) });
  await repo.initialize();
  const requests: ProviderChatRequest[] = [];
  let time = 0, fail: string | false = false;
  let config = structuredClone(provider), channelAllowed = false;
  const hooks: { beforeSend?: () => Promise<void>; afterSend?: () => Promise<void> } = {};
  const inspection: ProviderModelInspection = { contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' };
  const captureBinding = async () => {
    const captured = structuredClone(config);
    const adapter = { async *streamChat(request: ProviderChatRequest, signal?: AbortSignal, options?: ProviderDispatchOptions) {
    await hooks.beforeSend?.();
    await options?.validateBeforeSend?.();
    options?.assertCurrent?.();
    signal?.throwIfAborted();
    if (JSON.stringify(config) !== JSON.stringify(captured)) throw new Error('provider.bindingMismatch');
    requests.push(request);
    if (fail) throw new Error(fail);
    await hooks.afterSend?.();
    yield { type: 'text', text: reply(request) }; yield { type: 'done', finishReason: 'stop' };
    } } as unknown as ProviderAdapter;
    return { provider: captured, model: captured.model, inspection: structuredClone(inspection), adapter };
  };
  const saved = vi.fn();
  const service = new AutoMemoryService(repo, { available: () => true, captureBinding,
    channelSessionAllowed: () => channelAllowed, saved, now: () => time, idleMs: 1_000 });
  const chat = new ChatService(repo);
  const session = await chat.createSession('Conversation', 'normal');
  const say = (content: string, sessionId = session.id) => chat.addMessage({ sessionId, role: 'user', content, status: 'complete', errorCode: null });
  const quiet = async () => { time += 1_000; await service.tick(); };
  return { repo, service, chat, session, say, quiet, requests, saved, hooks, inspection,
    setProvider: (value: Partial<ProviderConfig>) => { config = { ...config, ...value }; },
    allowChannel: (value: boolean) => { channelAllowed = value; },
    memories: () => new MemoryService(repo).list(), offline: (value: boolean | string) => { fail = value === true ? 'offline' : value; } };
}
const sent = (request: ProviderChatRequest) => JSON.parse(request.messages[1]!.content as string) as { known: string[]; messages: Array<{ n: number; text: string }> };

it('keeps what the owner said once the conversation is quiet, and reads each message once', async () => {
  const f = await fixture(() => '```json\n{"memories":[{"text":"用户是高三学生，在准备美国大学申请","evidence":[1]}]}\n```');
  await f.say('我现在高三，在准备美国大学的申请');
  f.service.note(f.session.id, turn);
  await f.service.tick();
  expect(f.requests).toHaveLength(0);
  await f.quiet();
  expect(f.memories().map((item) => [item.text, item.tags, item.contextMetadata?.origin, item.contextMetadata?.trust, item.contextMetadata?.privacy]))
    .toEqual([['用户是高三学生，在准备美国大学申请', ['auto'], 'auto-profile', 'host-confirmed', 'cloud-allowed']]);
  expect(f.saved).toHaveBeenCalledExactlyOnceWith(1);
  await f.say('顺便说一下我更喜欢简短的回答');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[1]!)).toEqual({ known: ['用户是高三学生，在准备美国大学申请'], messages: [{ n: 1, text: '顺便说一下我更喜欢简短的回答' }] });
});

it('never reads a queued conversation with a provider entry since edited to point at another service', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户是高三学生","evidence":[1]}]}');
  await f.say('我现在高三');
  f.service.note(f.session.id, { ...turn, endpoint: answeringServiceIdentity({ provider })! });
  f.setProvider({ baseUrl: 'https://another-service.invalid/v1' });
  await f.quiet();
  expect(f.requests).toHaveLength(0); expect(f.memories()).toEqual([]);
  f.setProvider({ baseUrl: provider.baseUrl });
  f.service.note(f.session.id, { ...turn, endpoint: answeringServiceIdentity({ provider })! });
  await f.quiet();
  expect(f.requests).toHaveLength(1);
});

it('drops a queued read when the next turn cannot name the service that answered it', async () => {
  const f = await fixture(() => '{"memories":[]}');
  await f.say('我现在高三');
  f.service.note(f.session.id, turn);
  f.service.cancel(f.session.id);
  await f.quiet();
  expect(f.requests).toHaveLength(0);
});

it('treats another address, kind or credential behind the same provider entry as another recipient', () => {
  const base = answeringServiceIdentity({ provider, credentialRef: 'key-1' });
  expect(answeringServiceIdentity({ provider, credentialRef: 'key-1' })).toBe(base);
  expect(answeringServiceIdentity({ provider, credentialRef: 'key-2' })).not.toBe(base);
  expect(answeringServiceIdentity({ provider: { ...provider, baseUrl: 'https://another-service.invalid/v1' }, credentialRef: 'key-1' })).not.toBe(base);
  expect(answeringServiceIdentity({ provider: { ...provider, kind: 'deepseek' }, credentialRef: 'key-1' })).not.toBe(base);
});

it('never sends or keeps secrets, commands, or facts without a real source', async () => {
  const f = await fixture(() => JSON.stringify({ memories: [
    { text: '用户的密码是 hunter2', evidence: [1] }, { text: '用户住在火星', evidence: [9] }, { text: '用户喜欢喝茶', evidence: [1] },
  ] }));
  await f.say('我的密码是 hunter2');
  await f.say('/model 2');
  await f.say('我喜欢喝茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[0]!).messages).toEqual([{ n: 1, text: '我喜欢喝茶' }]);
  expect(f.memories().map((item) => item.text)).toEqual(['用户喜欢喝茶']);
});

it('skips delivered WeChat digests and digest-derived turns even while they are current', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  const normal = await f.say('我喜欢喝茶');
  const digest = await f.say('合成群精华');
  const derivative = await f.say('跟进合成群精华');
  await f.repo.transaction(state => {
    state.chatMessages.find(message => message.id === digest.id)!.wechatDigest = true;
    state.chatMessages.find(message => message.id === derivative.id)!.contextTrace = {
      version: 1, privacy: 'cloud-allowed', scope: { kind: 'session', sessionId: f.session.id }, lineage: 'complete',
      memoryReferences: [], historyMessageIds: [], wechatDigestUntil: new Date(Date.now() + 60_000).toISOString(),
    };
  });
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[0]!).messages).toEqual([{ n: 1, text: normal.content }]);
  expect(f.memories().map(item => item.text)).toEqual(['用户喜欢喝茶']);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(derivative.id);
});

it('excludes marked WeChat friend texts from automatic memory even in an otherwise eligible session', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  const normal = await f.say('我喜欢喝茶');
  const friend = await f.say('合成好友透露的个人信息');
  await f.repo.transaction(state => {
    state.chatMessages.find(message => message.id === friend.id)!.wechatFriend = true;
  });
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[0]!).messages).toEqual([{ n: 1, text: normal.content }]);
  expect(f.memories().map(item => item.text)).toEqual(['用户喜欢喝茶']);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(friend.id);
});

it('does not learn a deleted fact again', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户养了一只猫","evidence":[1]}]}');
  await f.say('我养了一只猫');
  f.service.note(f.session.id, turn);
  await f.quiet();
  await new MemoryService(f.repo).remove(f.memories()[0]!.id);
  await f.say('对，我养了一只猫');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.memories()).toEqual([]);
});

it('keeps a local-only conversation away from a cloud model, and marks what a local model learns as local-only', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户在上海上学","evidence":[1]}]}');
  await f.repo.transaction((state) => { state.chatSessions[0]!.historyPrivacy = 'local-only'; });
  await f.say('我在上海上学');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.requests).toHaveLength(0);
  f.setProvider({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', localExecutionConfirmed: true });
  f.service.note(f.session.id, { ...turn, destination: 'local' });
  await f.quiet();
  expect(f.memories().map((item) => item.contextMetadata?.privacy)).toEqual(['local-only']);
});

it('tries once more after a provider failure and does nothing when switched off', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户用 Mac","evidence":[1]}]}');
  await f.say('我平时用 Mac 写代码');
  f.offline(true);
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.memories()).toEqual([]);
  f.offline(false);
  await f.quiet();
  expect(f.memories().map((item) => item.text)).toEqual(['用户用 Mac']);
  await f.service.configure(false);
  await f.say('我还喜欢打高尔夫');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.requests).toHaveLength(2);
});

it('uses the current binding rather than a stale local destination, including cloud-backed local services', async () => {
  const f = await fixture(() => '{"memories":[]}');
  await f.repo.transaction(state => { state.chatSessions[0]!.historyPrivacy = 'local-only'; });
  await f.say('我在上海上学');
  f.service.note(f.session.id, { ...turn, destination: 'local' });
  await f.quiet();
  expect(f.requests).toEqual([]);
  f.setProvider({ baseUrl: 'http://localhost:11434', kind: 'ollama', localExecutionConfirmed: true });
  f.inspection.executionDestination = 'remote';
  f.service.note(f.session.id, { ...turn, destination: 'local' });
  await f.quiet();
  expect(f.requests).toEqual([]);
});

it('projects private known facts against the real ProviderService binding after an endpoint change', async () => {
  const f = await fixture(() => '{"memories":[]}');
  const calls: ProviderChatRequest[] = [];
  const adapter = { async *streamChat(request: ProviderChatRequest) {
    calls.push(request); yield { type: 'text', text: '{"memories":[]}' }; yield { type: 'done', finishReason: 'stop' };
  } } as ProviderAdapter;
  const providers = new ProviderService(f.repo, { getSecret: async () => null } as unknown as SafeStorageVault,
    { adapter: () => adapter } as unknown as ProviderUtilityClient);
  await f.repo.transaction(state => { state.providers.push({ ...provider, baseUrl: 'https://localhost/v1', localExecutionConfirmed: true }); });
  await new MemoryService(f.repo).upsert({ id: crypto.randomUUID(), text: 'LOCAL_ONLY_KNOWN_FACT', tags: [], privacy: 'local-only' });
  await f.say('我喜欢喝茶');
  const service = new AutoMemoryService(f.repo, { available: () => true, idleMs: 0,
    captureBinding: (id, model) => providers.captureBinding(id, model), channelSessionAllowed: () => false });
  service.note(f.session.id, { ...turn, destination: 'local' });
  await f.repo.transaction(state => { state.providers[0]!.baseUrl = 'https://remote-fixture.invalid/v1'; });
  await service.tick();
  expect(calls).toHaveLength(1);
  expect(sent(calls[0]!)).toEqual({ known: [], messages: [{ n: 1, text: '我喜欢喝茶' }] });
  expect(calls[0]!.executionMode).toBe('background-text');
  await service.shutdown();
});

it.each(['delete', 'edit', 'privacy', 'archive', 'scope', 'channel', 'cursor'] as const)('rechecks %s changes while waiting for dispatch', async change => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  f.hooks.beforeSend = async () => {
    await f.repo.transaction(state => {
      if (change === 'delete') state.chatMessages = [];
      if (change === 'edit') state.chatMessages[0]!.content = '我现在喜欢咖啡';
      if (change === 'privacy') state.chatSessions[0]!.historyPrivacy = 'local-only';
      if (change === 'archive') state.chatSessions[0]!.archivedAt = new Date().toISOString();
      if (change === 'scope') state.chatSessions[0]!.kind = 'project';
      if (change === 'channel') state.chatSessions[0]!.channelBindingId = '22222222-2222-4222-8222-222222222222';
      if (change === 'cursor') state.autoMemory.cursors[f.session.id] = state.chatMessages[0]!.id;
    });
  };
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.requests).toEqual([]);
  expect(f.memories()).toEqual([]);
});

it('rejects provider changes at dispatch and channel revocation after dispatch', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  f.hooks.beforeSend = async () => { f.setProvider({ baseUrl: 'https://changed.invalid/v1' }); };
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.requests).toEqual([]);
  delete f.hooks.beforeSend;
  f.allowChannel(true);
  await f.repo.transaction(state => { state.chatSessions[0]!.channelBindingId = '22222222-2222-4222-8222-222222222222'; });
  f.hooks.afterSend = async () => { f.allowChannel(false); };
  await f.quiet();
  expect(f.requests).toHaveLength(1);
  expect(f.memories()).toEqual([]);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBeUndefined();
});

it.each(['delete', 'edit', 'privacy'] as const)('does not commit after source %s during generation', async change => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  f.hooks.afterSend = async () => {
    await f.repo.transaction(state => {
      if (change === 'delete') state.chatMessages = [];
      if (change === 'edit') state.chatMessages[0]!.content = '我现在喜欢咖啡';
      if (change === 'privacy') state.chatMessages[0]!.contextTrace!.privacy = 'local-only';
    });
  };
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.memories()).toEqual([]);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBeUndefined();
});

it.each(['beforeSend', 'afterSend'] as const)('rechecks known memory revocation at %s', async stage => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  const memoryId = f.memories()[0]!.id;
  await f.say('我也喜欢乌龙茶');
  f.hooks[stage] = async () => { f.repo.suppressMemoryRecall([memoryId]); };
  f.service.note(f.session.id, turn);
  const cursor = f.repo.snapshot().autoMemory.cursors[f.session.id];
  await f.quiet();
  expect(f.requests).toHaveLength(stage === 'beforeSend' ? 1 : 2);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(cursor);
});

it.each([65, 125])('consumes %i messages in contiguous batches without skipping or duplicating', async count => {
  const f = await fixture(() => '{"memories":[]}');
  await f.repo.transaction(state => {
    for (let index = 0; index < count; index++) state.chatMessages.push({
      id: crypto.randomUUID(), sessionId: f.session.id, role: 'user', content: `我喜欢的颜色编号是 ${index}`, status: 'complete', errorCode: null,
      createdAt: new Date().toISOString(), contextTrace: { version: 1, lineage: 'complete', scope: { kind: 'session', sessionId: f.session.id },
        privacy: 'cloud-allowed', memoryReferences: [], historyMessageIds: [] },
    });
  });
  f.service.note(f.session.id, turn);
  for (let i = 0; i < 4; i++) await f.quiet();
  expect(f.requests.flatMap(request => sent(request).messages.map(item => item.text)))
    .toEqual(Array.from({ length: count }, (_, i) => `我喜欢的颜色编号是 ${i}`));
  expect(f.requests.every(request => request.executionMode === 'background-text')).toBe(true);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(f.repo.snapshot().chatMessages.at(-1)!.id);
});

it('honors the character limit and does not consume messages appended during generation', async () => {
  const f = await fixture(() => '{"memories":[]}');
  const texts = Array.from({ length: 5 }, (_, i) => `${i}我喜欢画画${'。'.repeat(3_000)}`);
  for (const text of texts) await f.say(text);
  f.hooks.afterSend = async () => { delete f.hooks.afterSend; await f.say('我还喜欢弹钢琴'); f.service.note(f.session.id, turn); };
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[0]!).messages).toHaveLength(3);
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(f.repo.snapshot().chatMessages[2]!.id);
  await f.quiet();
  expect(f.requests.flatMap(request => sent(request).messages.map(item => item.text))).toEqual([...texts, '我还喜欢弹钢琴']);
});

it.each(['disable', 'shutdown'] as const)('joins cancellation on %s without committing or retrying', async action => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hooks.afterSend = async () => { entered(); await gate; };
  f.service.note(f.session.id, turn);
  const running = f.quiet();
  await waiting;
  const cancelled = action === 'disable' ? f.service.configure(false) : f.service.shutdown();
  release();
  await Promise.all([running, cancelled]);
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.memories()).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

it('keeps the existing invalid-JSON skip semantics explicit', async () => {
  const f = await fixture(() => 'not JSON');
  const message = await f.say('我喜欢喝茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  await f.quiet();
  expect(f.repo.snapshot().autoMemory.cursors[f.session.id]).toBe(message.id);
  expect(f.requests).toHaveLength(1);
});

it('inherits local privacy and session scope from known context, and never sends untrusted or expired facts', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户也喜欢乌龙茶","evidence":[1]}]}');
  const memory = new MemoryService(f.repo);
  const known = await memory.upsert({ id: crypto.randomUUID(), text: '用户喜欢喝茶', tags: [] });
  await f.repo.transaction(state => {
    const metadata = state.memories.find(item => item.id === known.id)!.contextMetadata!;
    metadata.privacy = 'local-only'; metadata.scope = { kind: 'session', sessionId: f.session.id };
  });
  f.setProvider({ kind: 'ollama', baseUrl: 'http://localhost:11434', localExecutionConfirmed: true });
  await f.say('我也喜欢乌龙茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[0]!).known).toEqual(['用户喜欢喝茶']);
  expect(f.memories().find(item => item.text === '用户也喜欢乌龙茶')?.contextMetadata)
    .toMatchObject({ privacy: 'local-only', scope: { kind: 'session', sessionId: f.session.id } });
  await f.repo.transaction(state => {
    state.memories[0]!.contextMetadata!.expiresAt = '2000-01-01T00:00:00.000Z';
    state.memories[1]!.contextMetadata!.trust = 'unverified';
  });
  await f.say('我还喜欢绿茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(sent(f.requests[1]!).known).toEqual([]);
});

it('leaves sampling settings out on the OpenAI Responses API, which rejects them on reasoning models', async () => {
  const f = await fixture(() => '{"memories":[{"text":"用户喜欢喝茶","evidence":[1]}]}');
  await f.say('我喜欢喝茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.requests[0]).toMatchObject({ temperature: 0, reasoningEffort: 'none' });
  f.setProvider({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' });
  await f.say('我也喜欢咖啡');
  f.service.note(f.session.id, { ...turn, model: 'gpt-6.1-sol' });
  await f.quiet();
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).not.toHaveProperty('temperature');
  expect(f.requests[1]).not.toHaveProperty('reasoningEffort');
});

it('reports what its last read did, so a provider that keeps refusing is visible', async () => {
  const f = await fixture(() => '{"memories":[]}');
  expect(f.service.attempts()).toEqual({ lastSuccessAt: null, lastFailureAt: null, errorCode: null, failures: 0 });
  f.offline('provider.unsupportedParameter');
  await f.say('我喜欢喝茶');
  f.service.note(f.session.id, turn);
  await f.quiet(); await f.quiet();
  expect(f.service.attempts()).toMatchObject({ lastSuccessAt: null, errorCode: 'provider.unsupportedParameter', failures: 2 });
  f.offline('Unexpected token < in JSON at position 0');
  await f.say('我也喜欢咖啡');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.service.attempts()).toMatchObject({ errorCode: 'autoMemory.failed', failures: 3 });
  f.offline(false);
  await f.say('还有绿茶');
  f.service.note(f.session.id, turn);
  await f.quiet();
  expect(f.service.attempts()).toMatchObject({ lastSuccessAt: expect.any(String), errorCode: null, failures: 0 });
});
