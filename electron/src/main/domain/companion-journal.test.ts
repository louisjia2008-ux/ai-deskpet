// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession, ContextTrace, MemoryItem, ProviderConfig } from '../../shared';
import { birthdayPrompt, defaultCharacterProfile } from '../../shared/character';
import { qqGroupSender } from '../../shared/qq-channel';
import type { ProviderAdapter, ProviderChatRequest } from '../providers/types';
import { CompanionJournal, diaryMaterial } from './companion-journal';
import { createDefaultState } from './schemas';
import { prepareChatContext } from './chat-context';
import { selectAllowedHistory } from './chat-context-policy';
import { mergeTurnContextTrace } from '../providers/chat-request-policy';
import { assertProactiveContext, proactiveContext } from './proactive-context';
import { ChatService } from './chat-service';
import { DomainRepository } from './repository';
import { createHistoryLookupResolver, historyLookupReference } from './chat-history-lineage';
import { recentDigest } from './companion-recent-state';
import { MemorySleepService } from './memory-sleep';
import { MemoryService } from './memory-service';
import { assertDeliverableToQq } from '../security/channel-disclosure-policy';
import { qqChannel } from '../security/execution-context';

const roots: string[] = [], vault = { getVaultKey: async () => Buffer.alloc(32, 8) };
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const date = '2026-11-14', stamp = `${date}T12:00:00.000Z`;
const trace = (): ContextTrace => ({ version: 1, privacy: 'cloud-allowed', scope: { kind: 'global' }, lineage: 'complete', memoryReferences: [], historyMessageIds: [] });
const globalMemory = (text: string): MemoryItem => ({ id: randomUUID(), text, tags: [], source: 'user', createdAt: stamp, updatedAt: stamp,
  contextMetadata: { version: 1, revision: 1, origin: 'auto-profile', layer: 'shallow', trust: 'host-confirmed', privacy: 'cloud-allowed', scope: { kind: 'global' },
    sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], sentCount: 0, lastSentAt: null } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-diary-')); roots.push(root);
  const path = join(root, 'diary.enc.json'), journal = new CompanionJournal(path, vault); await journal.initialize();
  await journal.configure({ ...journal.preferences(), diaryEnabled: true });
  const state = createDefaultState(); state.memorySleep.settings.timezone = 'UTC';
  const session: ChatSession = { id: randomUUID(), title: 'Synthetic owner', kind: 'normal', companionScope: 'owner', createdAt: stamp, updatedAt: stamp };
  const message: ChatMessage = { id: randomUUID(), sessionId: session.id, role: 'user', content: '今天完成了合成测试，明天想散步。', createdAt: stamp, status: 'complete', errorCode: null, contextTrace: trace() };
  state.chatSessions.push(session); state.chatMessages.push(message);
  const complete = vi.fn(async () => ({ text: '今天听主人说完成了合成测试，我也替他开心。惦记着他明天想散步的事。', summary: '主人完成了测试，明天想散步。' }));
  const input = { now: Date.parse('2026-11-15T03:01:00Z'), timezone: 'UTC', available: () => true, state: () => state, suppressed: () => false, complete };
  return { journal, state, session, message, input, path, complete };
}

it('keeps startup usable and exposes an unreadable diary without overwriting encrypted data', async () => {
  const f = await fixture(), original = await readFile(f.path);
  const locked = new CompanionJournal(f.path, { getVaultKey: async () => { throw Error('synthetic locked vault'); } });
  await expect(locked.initialize()).resolves.toBeUndefined();
  expect(locked.status()).toMatchObject({ enabled: true, errorCode: 'diary.storage' });
  expect(locked.list()).toEqual([]);
  await expect(locked.configure(locked.preferences())).rejects.toThrow('diary.storage');
  await locked.tick(f.input); expect(f.complete).not.toHaveBeenCalled();
  expect(await readFile(f.path)).toEqual(original); await locked.shutdown();
});

it('uses the date the diary describes for birthday facts, not the next morning it generates', async () => {
  const f = await fixture();
  const onDiaryDate = vi.fn((entryDate: string) => birthdayPrompt({ today: entryDate,
    profile: { ...defaultCharacterProfile(), age: 16, ageSince: '2025-11-14', ownerBirthday: '11-14' }, addressUser: '队长' }));
  await f.journal.tick({ ...f.input, complete: async (_material, _signal, _assertCurrent, entryDate) => {
    const hints = onDiaryDate(entryDate);
    return { text: '合成记录', summary: hints };
  } });
  expect(onDiaryDate).toHaveBeenCalledExactlyOnceWith(date);
  expect(f.journal.list()[0]?.summary).toBe("Today is your birthday: you just turned 17. Today is 队长's birthday.");
});

it('includes a revocable diary only for owner private QQ and never includes local-only edits there', async () => {
  const f = await fixture();
  await f.journal.tick(f.input);
  const auth = { bindingId: randomUUID(), senderId: 'synthetic-owner', authorityId: randomUUID() };
  const privateChannel = qqChannel(auth), group = qqChannel({ ...auth, senderId: qqGroupSender('fixture') });
  const qqSession = { ...f.session, id: randomUUID(), channelBindingId: auth.bindingId };
  f.state.chatSessions.push(qqSession);
  const diary = f.journal.chatContext(privateChannel, f.state, 'remote', () => false)!;
  expect(diary.summaries).toHaveLength(1);
  expect(f.journal.chatContext(group, f.state, 'remote', () => false)).toBeUndefined();
  expect(f.journal.chatContext(qqChannel({ bindingId: auth.bindingId, senderId: auth.senderId }), f.state, 'remote', () => false)).toBeUndefined();
  expect(f.journal.chatContext({ origin: 'telegram', bindingId: auth.bindingId, chatId: 'fixture', userId: 'fixture', memoryAllowed: true },
    f.state, 'remote', () => false)).toBeUndefined();
  const current = (ref: typeof diary.references[number]) => f.journal.referenceCurrent(ref, f.state, 'remote', () => false);
  const prepare = (withDiary?: typeof diary) => prepareChatContext({ sessionId: qqSession.id, history: [], memories: [], query: '合成问候', locale: 'zh-CN',
    ...(withDiary ? { diary: withDiary } : {}), diaryAllowed: current,
    binding: { providerId: randomUUID(), kind: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' },
    requiredMessages: [{ role: 'user', content: 'SYNTHETIC_TURN' }], maxOutputTokens: 512,
    contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } });
  const request = prepare(diary);
  expect(request.messages.some(message => message.content.includes(diary.summaries[0]!))).toBe(true);
  expect(prepare().messages.some(message => message.content.includes(diary.summaries[0]!))).toBe(false);
  const answer = { contextTrace: request.projection };
  expect(() => assertDeliverableToQq(answer, f.state, qqSession.id)).toThrow('qq.disclosureBlocked');
  expect(() => assertDeliverableToQq(answer, f.state, qqSession.id, () => false, null, current)).not.toThrow();
  await f.journal.edit({ date, revision: 1, text: '合成本地修改' });
  for (const destination of ['local', 'remote'] as const)
    expect(f.journal.chatContext(privateChannel, f.state, destination, () => false)?.summaries).toEqual([]);
  expect(() => assertDeliverableToQq(answer, f.state, qqSession.id, () => false, null, current)).toThrow('qq.disclosureBlocked');
});

it('excludes unmarked/group/local/archived sessions, incomplete lineage and revoked memories before cloud generation', async () => {
  const f = await fixture();
  for (const change of [{ companionScope: undefined }, { companionScope: 'group' as const }, { historyPrivacy: 'local-only' as const }, { archivedAt: stamp }]) {
    const session = { ...f.session, ...change, id: randomUUID() }; f.state.chatSessions.push(session);
    f.state.chatMessages.push({ ...f.message, id: randomUUID(), sessionId: session.id, content: 'DO_NOT_UPLOAD' });
  }
  f.state.chatMessages.push({ ...f.message, id: randomUUID(), content: 'UNKNOWN_TRACE', contextTrace: { ...trace(), lineage: 'unknown' } });
  const memory: MemoryItem = { id: randomUUID(), text: 'ALLOWED_MEMORY', tags: [], source: 'user', createdAt: stamp, updatedAt: stamp,
    contextMetadata: { version: 1, revision: 1, origin: 'manual-user', trust: 'host-confirmed', privacy: 'cloud-allowed', scope: { kind: 'global' }, sourceReferences: [], sentCount: 0, lastSentAt: null } };
  f.state.memories.push(memory);
  const material = diaryMaterial(f.state, date, 'UTC', id => id === memory.id);
  expect(material.sources.map(item => item.id)).toEqual([f.message.id]); expect(material.memories).toEqual([]);
  await f.journal.tick(f.input); expect(f.complete).toHaveBeenCalledOnce();
  expect(f.complete.mock.calls[0]).not.toContain('DO_NOT_UPLOAD');
  expect(f.journal.list()).toHaveLength(1); expect(await readFile(f.path, 'utf8')).not.toContain('散步');
});

it('omits delivered WeChat summaries and their follow-ups from the diary', async () => {
  const f = await fixture();
  const scope = { kind: 'session' as const, sessionId: f.session.id };
  f.state.chatMessages.push(
    { ...f.message, id: randomUUID(), content: '今天发过的合成群精华', wechatDigest: true },
    { ...f.message, id: randomUUID(), content: '从合成群精华衍生的回答', role: 'assistant',
      contextTrace: { ...trace(), scope, wechatDigestUntil: new Date(Date.now() + 60_000).toISOString() } },
  );
  expect(diaryMaterial(f.state, date, 'UTC', () => false).sources.map(item => item.text)).toEqual([f.message.content]);
});

it('omits both sides of a marked WeChat friend chat from diary material', async () => {
  const f = await fixture();
  f.state.chatMessages.push(
    { ...f.message, id: randomUUID(), content: '合成好友的来信', wechatFriend: true },
    { ...f.message, id: randomUUID(), content: '给合成好友的回复', role: 'assistant', wechatFriend: true },
  );
  expect(diaryMaterial(f.state, date, 'UTC', () => false).sources.map(item => item.text)).toEqual([f.message.content]);
});

it('makes at most one catch-up attempt across concurrent ticks and restart, including a failed request', async () => {
  const f = await fixture(); f.complete.mockRejectedValueOnce(new Error('offline'));
  await Promise.all([f.journal.tick(f.input), f.journal.tick(f.input)]);
  expect(f.complete).toHaveBeenCalledOnce(); expect(f.journal.status()).toMatchObject({ errorCode: 'diary.failed' });
  const reopened = new CompanionJournal(f.path, vault); await reopened.initialize();
  await reopened.tick(f.input); expect(f.complete).toHaveBeenCalledOnce();
  await reopened.tick({ ...f.input, now: Date.parse('2026-11-20T03:01:00Z') });
  expect(f.complete).toHaveBeenCalledOnce(); // missed dates are never replayed as a burst
});

it('rechecks at the actual request boundary and discards a revoked in-flight diary', async () => {
  const f = await fixture();
  await f.journal.tick({ ...f.input, complete: async (_material, _signal, assertCurrent) => {
    f.session.historyPrivacy = 'local-only'; expect(assertCurrent).toThrow('diary.contextChanged');
    return { text: 'must not persist', summary: 'must not persist' };
  } });
  expect(f.journal.list()).toEqual([]); expect(f.journal.status().errorCode).toBe('diary.contextChanged');
});

it('edits with CAS, encrypts, persists, restricts edited text to local models, invalidates old references, and deletes', async () => {
  const f = await fixture(); await f.journal.tick(f.input);
  const original = f.journal.context(f.state, 'remote', () => false), entry = f.journal.list()[0]!;
  await f.journal.edit({ date, revision: entry.revision, text: 'EDITED_LOCAL_ONLY' });
  await expect(f.journal.edit({ date, revision: entry.revision, text: 'stale' })).rejects.toThrow('diary.stale');
  expect(f.journal.referenceCurrent(original.references[0]!, f.state, 'local', () => false)).toBe(false);
  expect(f.journal.context(f.state, 'remote', () => false).summaries).toEqual([]);
  expect(f.journal.context(f.state, 'local', () => false)).toMatchObject({ privacy: 'local-only', summaries: [`${date}: EDITED_LOCAL_ONLY`] });
  expect(await readFile(f.path, 'utf8')).not.toContain('EDITED_LOCAL_ONLY');
  const reopened = new CompanionJournal(f.path, vault); await reopened.initialize();
  expect(reopened.list()[0]?.text).toBe('EDITED_LOCAL_ONLY');
  await reopened.remove({ date, revision: 2 }); expect(reopened.list()).toEqual([]);
});

it('projects only current local diary copy material and withdraws archives, private sources and deleted entries', async () => {
  const f = await fixture();
  await f.journal.tick(f.input);
  const exportable = () => f.journal.exportableCopies(f.state, () => false);
  const entry = f.journal.list()[0]!;
  expect(exportable()).toEqual([{ date, createdAt: entry.createdAt, text: entry.text }]);
  f.session.archivedAt = stamp;
  expect(exportable()).toEqual([]);
  delete f.session.archivedAt;
  f.session.historyPrivacy = 'local-only';
  expect(exportable()).toEqual([]);
  delete f.session.historyPrivacy;
  await f.journal.remove({ date, revision: entry.revision });
  expect(exportable()).toEqual([]);
});

it('withdraws even edited local summaries when a source is deleted or made private', async () => {
  const f = await fixture(); await f.journal.tick(f.input); await f.journal.edit({ date, revision: 1, text: 'edited' });
  f.session.deletedAt = stamp;
  expect(f.journal.context(f.state, 'local', () => false).summaries).toEqual([]);
});

it('withdraws retained diary material when a rolling-summary dependency is cleared', async () => {
  const f = await fixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(f.input.now);
  try {
    await f.journal.tick(f.input);
    // Simulate an already-retained diary source with a valid summary dependency.
    const original = { ...f.message, id: randomUUID(), content: 'Synthetic continuity source.' };
    const revision = recentDigest('diary retained fixture revision');
    f.state.chatMessages.push(original);
    f.state.companionRecent.entries = [{ source: 'desktop', id: original.id, sessionId: original.sessionId,
      at: stamp, sha: recentDigest(original.content) }];
    f.state.companionRecent.summary = { revision, text: original.content, updatedAt: stamp, refs: [original.id], localOnly: false };
    f.message.contextTrace!.recentRevision = revision;
    expect(f.journal.context(f.state, 'remote', () => false).summaries).toHaveLength(1);
    f.state.companionRecent.summary = null;
    expect(f.journal.context(f.state, 'remote', () => false).summaries).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('puts diary summaries in the moment before the current turn and carries revocable provenance through history and tool rounds', async () => {
  const f = await fixture(); await f.journal.tick(f.input);
  const diary = f.journal.context(f.state, 'remote', () => false);
  const diaryAllowed = (ref: typeof diary.references[number]) => f.journal.referenceCurrent(ref, f.state, 'remote', () => false);
  const historyDiaryAllowed = (ref: typeof diary.references[number]) => f.journal.referenceRetained(ref, f.state, () => false);
  const result = prepareChatContext({ sessionId: f.session.id, history: [], memories: [], query: '你好', locale: 'zh-CN', moment: 'CURRENT_MOMENT', diary, diaryAllowed,
    binding: { providerId: randomUUID(), kind: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' },
    requiredMessages: [{ role: 'user', content: 'CURRENT_TURN' }], maxOutputTokens: 512, contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } });
  expect(result.messages.at(-2)?.content).toContain('明天想散步'); expect(result.messages.at(-1)?.content).toBe('CURRENT_TURN');
  expect(mergeTurnContextTrace(result.projection, trace()).diaryReferences).toEqual(diary.references);
  const answer = { ...f.message, id: randomUUID(), role: 'assistant' as const, contextTrace: result.projection };
  const allowed = () => selectAllowedHistory({ sessionId: f.session.id, history: [answer], memories: [], destination: 'remote', diaryAllowed: historyDiaryAllowed });
  const lookup = () => createHistoryLookupResolver({ sessionId: f.session.id, state: f.state, destination: 'remote', diaryAllowed: historyDiaryAllowed })(historyLookupReference(answer));
  f.state.chatMessages.push(answer);
  expect(allowed()).toEqual([answer]); expect(lookup()).toBe('cloud-allowed');
  await f.journal.edit({ date, revision: 1, text: '新编辑内容仅本地可见' });
  expect(f.journal.context(f.state, 'remote', () => false).summaries).toEqual([]);
  expect(allowed()).toEqual([answer]); expect(lookup()).toBe('cloud-allowed');
  const local = prepareChatContext({ sessionId: f.session.id, history: [{ ...f.message, id: randomUUID() }, answer], memories: [], query: '你好', locale: 'zh-CN',
    diary: f.journal.context(f.state, 'local', () => false), diaryAllowed: reference => f.journal.referenceCurrent(reference, f.state, 'local', () => false), historyDiaryAllowed,
    binding: { providerId: randomUUID(), kind: 'ollama', model: 'fixture', baseUrl: 'http://localhost:11434', localExecutionConfirmed: true },
    requiredMessages: [{ role: 'user', content: 'NEXT_TURN' }], maxOutputTokens: 512, contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } });
  expect(local.projection.diaryReferences?.map(reference => reference.revision)).toEqual([2]);
  expect(local.projection.historyMessageIds).toContain(answer.id);
  await f.journal.remove({ date, revision: 2 });
  expect(allowed()).toEqual([answer]); expect(lookup()).toBe('cloud-allowed');
  const reopened = new CompanionJournal(f.path, vault); await reopened.initialize();
  expect(reopened.referenceRetained(diary.references[0]!, f.state, () => false)).toBe(true);
  f.session.historyPrivacy = 'local-only';
  expect(allowed()).toEqual([]); expect(lookup()).toBeNull();
  expect(reopened.referenceRetained(diary.references[0]!, f.state, () => false)).toBe(false);
});

it('preserves a diary and its chat history when new memory shifts the window and nightly cleanup actually merges a referenced memory', async () => {
  const f = await fixture(), repository = new DomainRepository(f.path + '.profile', vault);
  await repository.initialize();
  const remembered = Array.from({ length: 30 }, (_, index) => globalMemory(`主人偏好 ${index + 1}：合成测试记录。`));
  f.state.memories.push(...remembered);
  await repository.transaction(state => { Object.assign(state, f.state); });
  const state = () => repository.snapshot();
  await f.journal.tick({ ...f.input, state });
  expect(f.journal.list()[0]!.memories).toHaveLength(30);
  const original = f.journal.context(state(), 'remote', () => false);
  const answer = { ...f.message, id: randomUUID(), role: 'assistant' as const, contextTrace: { ...trace(), diaryReferences: original.references } };
  const allowed = () => selectAllowedHistory({ sessionId: f.session.id, history: [answer], destination: 'remote', memories: state().memories,
    diaryAllowed: reference => f.journal.referenceRetained(reference, state(), () => false) });
  await repository.transaction(value => { value.memories.push(globalMemory('新增一条合成记忆。')); });
  expect(diaryMaterial(state(), date, 'UTC', () => false).memories.map(memory => memory.id)).not.toContain(remembered[0]!.id);
  expect(f.journal.context(state(), 'remote', () => false)).toEqual(original);
  expect(allowed()).toEqual([answer]);
  const provider: ProviderConfig = { id: randomUUID(), enabled: true, name: 'Synthetic Fixture', model: 'm', kind: 'openai-compatible',
    baseUrl: 'https://fixture.invalid/v1', supportsTools: false, secretState: 'missing' };
  const adapter = { async *streamChat(request: ProviderChatRequest) {
    const { entries } = JSON.parse(request.messages[1]!.content as string) as { entries: Array<{ n: number; text: string }> };
    const ids = remembered.slice(0, 2).map(memory => entries.find(entry => entry.text === memory.text)!.n);
    yield { type: 'text', text: JSON.stringify({ merge: [{ ids, text: '主人喜欢整理合成测试记录。' }] }) };
    yield { type: 'done', finishReason: 'stop' };
  } } as unknown as ProviderAdapter;
  const sleep = new MemorySleepService(repository, { available: () => true, provider: () => ({ provider, model: 'm', destination: 'remote' }),
    adapter: async () => adapter, now: () => new Date(f.input.now + 86_400_000) });
  const cleaned = await sleep.runNow();
  expect(cleaned.reports[0]?.changes.map(change => change.kind)).toEqual(['merge']);
  expect(state().memories.some(memory => memory.id === remembered[0]!.id)).toBe(false);
  await repository.transaction(value => { value.memorySleep.reports = []; });  // Undo history has a shorter lifetime than chat history.
  expect(f.journal.context(state(), 'remote', () => false)).toEqual(original);
  expect(allowed()).toEqual([answer]);
  const replacement = state().memorySleep.recallReplacements[remembered[0]!.id]!;
  expect(f.journal.context(state(), 'remote', id => id === replacement).summaries).toEqual([]);
  await new MemoryService(repository).remove(replacement);
  expect(f.journal.context(state(), 'remote', () => false).summaries).toEqual([]);
  expect(allowed()).toEqual([]);
});

it.each(['archive', 'private', 'delete'] as const)('stops injecting a summary when the source is %s and removes history only for privacy withdrawals', async change => {
  const f = await fixture(); await f.journal.tick(f.input);
  const [reference] = f.journal.context(f.state, 'remote', () => false).references;
  if (change === 'archive') f.session.archivedAt = stamp;
  if (change === 'private') f.session.historyPrivacy = 'local-only';
  if (change === 'delete') f.state.chatMessages = [];
  expect(f.journal.context(f.state, 'remote', () => false).summaries).toEqual([]);
  expect(f.journal.referenceRetained(reference!, f.state, () => false)).toBe(change === 'archive');
});

it('binds proactive context to current journal sources, privacy and identity at dispatch and publication', async () => {
  const f = await fixture(); await f.journal.tick(f.input);
  const policy = { ...f.state.proactivePolicy, privacy: 'cloud-allowed' as const };
  const input = { state: f.state, policy, journal: f.journal, identity: 'Synthetic companion', now: f.input.now, suppressed: () => false };
  const context = proactiveContext(input), material = JSON.stringify({ context });
  expect(context.diary).toHaveLength(1); expect(assertProactiveContext(material, input).diaryReferences).toEqual(context.trace.diaryReferences);
  expect(() => assertProactiveContext(material, { ...input, identity: 'changed' })).toThrow('automation.contextStale');
  f.session.historyPrivacy = 'local-only'; expect(() => assertProactiveContext(material, input)).toThrow('automation.contextStale');
});

it.each(['edit', 'delete', 'source-private'] as const)('withdraws a live ChatService request receipt after diary %s, even between tool rounds', async change => {
  const f = await fixture();
  const repository = new DomainRepository(f.path + '.profile', vault); await repository.initialize();
  await repository.transaction(state => { Object.assign(state, f.state); });
  await f.journal.tick({ ...f.input, state: () => repository.snapshot() });
  const chat = new ChatService(repository, {
    current: (reference, state, destination) => f.journal.referenceCurrent(reference, state, destination, () => false),
    retained: (reference, state) => f.journal.referenceRetained(reference, state, () => false),
  });
  const question = await chat.addMessage({ sessionId: f.session.id, role: 'user', content: 'Tell me about yesterday', status: 'complete', errorCode: null });
  const assistant = await chat.addMessage({ sessionId: f.session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  const contextTrace = { ...trace(), diaryReferences: f.journal.context(repository.snapshot(), 'remote', () => false).references };
  expect(contextTrace.diaryReferences).toHaveLength(1);
  const preparation = { requestId: randomUUID(), runId: randomUUID(), userMessageId: question.id, bindingDigest: 'a'.repeat(64), expectedBodySHA256: 'b'.repeat(64), inputEstimate: 24,
    maxInputTokens: 1024, maxOutputTokens: 128, capacitySource: 'configured' as const, contextTrace };
  await chat.prepareRequest(assistant.id, preparation);
  chat.assertPreparedRequest(assistant.id, preparation.requestId);
  const completed = await chat.addMessage({ sessionId: f.session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  await chat.prepareRequest(completed.id, { ...preparation, requestId: randomUUID(), runId: randomUUID() });
  await chat.updateMessage(completed.id, { content: 'Synthetic completed result', status: 'complete', errorCode: null });
  expect(() => chat.assertMessageContextCurrent(completed.id)).not.toThrow();
  // Consumers without the live encrypted journal cannot authorize these summaries.
  expect(() => new ChatService(repository).assertPreparedRequest(assistant.id, preparation.requestId)).toThrow('chat.contextStale');
  if (change === 'edit') await f.journal.edit({ date, revision: 1, text: 'changed local diary' });
  if (change === 'delete') await f.journal.remove({ date, revision: 1 });
  if (change === 'source-private') await repository.transaction(state => { state.chatSessions[0]!.historyPrivacy = 'local-only'; });
  expect(() => chat.assertPreparedRequest(assistant.id, preparation.requestId)).toThrow('chat.contextStale');
  expect(() => chat.assertMessageContextCurrent(completed.id)).toThrow('chat.contextStale');
  await expect(chat.prepareRequest(assistant.id, { ...preparation, requestId: randomUUID() })).rejects.toThrow('chat.contextStale');
  const nextQuestion = await chat.addMessage({ sessionId: f.session.id, role: 'user', content: 'A new turn', status: 'complete', errorCode: null });
  const nextAnswer = await chat.addMessage({ sessionId: f.session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  const next = { ...preparation, requestId: randomUUID(), runId: randomUUID(), userMessageId: nextQuestion.id,
    contextTrace: { ...trace(), historyMessageIds: [completed.id] } };
  if (change === 'source-private') {
    await expect(chat.prepareRequest(nextAnswer.id, next)).rejects.toThrow('chat.contextStale');
  } else {
    await chat.prepareRequest(nextAnswer.id, next);
    expect(() => chat.assertPreparedRequest(nextAnswer.id, next.requestId)).not.toThrow();
  }
});

it('stops injecting a diary built on a memory that was later corrected, while replies that used it stay valid', async () => {
  const f = await fixture();
  const memory = globalMemory('主人住在合成旧城。');
  f.state.memories.push(memory);
  await f.journal.tick(f.input);
  expect(f.journal.list()[0]!.memories.map(item => item.id)).toContain(memory.id);
  const [reference] = f.journal.context(f.state, 'remote', () => false).references;
  // As MemoryService records a correction: the guard holds the revision the old text had.
  f.state.memoryTombstones.push({ id: randomUUID(), memoryId: memory.id, textDigest: 'b'.repeat(64), sourceEventIds: [], identityKey: null,
    scope: { kind: 'global' }, deletedAt: stamp, kind: 'corrected', memoryRevision: 1 });
  memory.text = '主人住在合成新城。'; memory.contextMetadata!.revision = 2;
  expect(f.journal.context(f.state, 'remote', () => false).summaries).toEqual([]);
  expect(f.journal.referenceRetained(reference!, f.state, () => false)).toBe(true);
});
