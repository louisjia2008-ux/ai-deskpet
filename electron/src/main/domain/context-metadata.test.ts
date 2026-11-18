import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequestPreparation, ContextTrace, MemoryItem, ProviderRequestObservation } from '../../shared';
import { memoryInputSchema, providerInputSchema } from '../../shared';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { buildChatContext, prepareChatContext } from './chat-context';
import { chatRequestPreparationSchema } from './schemas';
import { mergeTurnContextTrace } from '../providers/chat-request-policy';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const localBinding = { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true } as const;
const remoteBinding = { ...localBinding, kind: 'openai-compatible', baseUrl: 'https://provider.example.invalid/v1', localExecutionConfirmed: false } as const;
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-context-metadata-')); roots.push(root);
  const path = join(root, 'profile.enc.json'); let locked = false;
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture locked'); return Buffer.alloc(32, 73); } };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); const chat = new ChatService(repository); const memory = new MemoryService(repository);
  const session = await chat.createSession('Synthetic context', 'normal');
  const turn = async (content: string, sessionId = session.id) => {
    const user = await chat.addMessage({ sessionId, role: 'user', content, status: 'complete', errorCode: null });
    const assistant = await chat.addMessage({ sessionId, role: 'assistant', content: '', status: 'streaming', errorCode: null });
    return { user, assistant };
  };
  return { path, repository, chat, memory, session, turn, reopen, lock: (value: boolean) => { locked = value; } };
};

const traceFor = (memories: MemoryItem[] = [], historyMessageIds: string[] = []): ContextTrace => ({
  version: 1, memoryReferences: memories.map((memory) => ({ id: memory.id, revision: memory.contextMetadata!.revision })), historyMessageIds,
  privacy: memories.some((memory) => memory.contextMetadata?.privacy === 'local-only') ? 'local-only' : 'cloud-allowed',
  scope: memories.find((memory) => memory.contextMetadata?.scope.kind === 'session')?.contextMetadata?.scope ?? { kind: 'global' }, lineage: 'complete',
});
const preparationFor = (contextTrace: ContextTrace): ChatRequestPreparation => ({
  requestId: randomUUID(), bindingDigest: 'a'.repeat(64), expectedBodySHA256: 'b'.repeat(64), inputEstimate: 24,
  maxInputTokens: 1024, maxOutputTokens: 128, capacitySource: 'configured', contextTrace,
});
const observationFor = (preparation: ChatRequestPreparation, phase: ProviderRequestObservation['phase'] = 'fetch-invoked'): ProviderRequestObservation => ({
  requestId: preparation.requestId, bindingDigest: preparation.bindingDigest, bodySHA256: preparation.expectedBodySHA256,
  inputEstimate: preparation.inputEstimate, phase, httpStatus: phase === 'fetch-invoked' ? null : 200,
  outcome: phase === 'terminal' ? 'completed' : null, usage: { inputTokens: null, outputTokens: null, source: 'unknown' },
  finishReason: phase === 'terminal' ? 'stop' : null,
});

it('retains WeChat digest lineage for same-day owner follow-ups and rechecks expiry at dispatch', async () => {
  const f = await fixture();
  const cutoff = '2026-11-16T16:00:00.000Z';
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(cutoff) - 1_000);
  try {
    const turn = await f.turn('What did the digest say?');
    const trace: ContextTrace = { ...traceFor(), scope: { kind: 'session', sessionId: f.session.id }, wechatDigestUntil: cutoff };
    const first = { ...preparationFor(trace), runId: randomUUID() };
    await f.chat.prepareRequest(turn.assistant.id, first);
    expect(() => f.chat.assertPreparedRequest(turn.assistant.id, first.requestId)).not.toThrow();
    await expect(f.chat.prepareRequest(turn.assistant.id, { ...preparationFor({ ...trace, wechatDigestUntil: undefined }), runId: first.runId }))
      .rejects.toThrow('chat.contextStale');
    const nextTrace = mergeTurnContextTrace(trace, { ...trace, wechatDigestUntil: '2026-11-17T16:00:00.000Z' });
    expect(nextTrace.wechatDigestUntil).toBe(cutoff);
    await f.chat.updateMessage(turn.assistant.id, { content: 'Digest-derived answer', status: 'complete', errorCode: null });
    const history = (await f.reopen()).snapshot().chatMessages;
    expect(history.map(message => message.contextTrace?.wechatDigestUntil)).toEqual([cutoff, cutoff]);
    const prepare = (allowWeChatDigestContext: boolean) => prepareChatContext({
      sessionId: f.session.id, binding: remoteBinding, history, memories: [], query: 'Can you elaborate?', locale: 'en',
      requiredMessages: [{ role: 'user', content: 'Can you elaborate?' }], maxOutputTokens: 512,
      contextBudget: { contextWindowTokens: 16_000, safetyMarginTokens: 256, capacitySource: 'configured' }, allowWeChatDigestContext,
    });
    expect(prepare(false).messages.some(message => message.content === 'Digest-derived answer')).toBe(false);
    const next = prepare(true);
    expect(next.messages.some(message => message.content === 'Digest-derived answer')).toBe(true);
    expect(next.projection.wechatDigestUntil).toBe(cutoff);
    expect(() => f.chat.assertMessageContextCurrent(turn.assistant.id)).not.toThrow();
    const followUp = await f.turn('Can you elaborate?');
    const second = preparationFor(next.projection);
    await f.chat.prepareRequest(followUp.assistant.id, second);
    clock.mockReturnValue(Date.parse(cutoff));
    expect(prepare(true).messages.some(message => message.content === 'Digest-derived answer')).toBe(false);
    expect(() => f.chat.assertPreparedRequest(followUp.assistant.id, second.requestId)).toThrow('chat.contextStale');
    expect(() => f.chat.assertMessageContextCurrent(turn.assistant.id)).toThrow('chat.contextStale');
  } finally { clock.mockRestore(); }
});

describe('host-owned memory provenance', () => {
  it('persists Telegram consent on the reviewed revision and removes it on narrowing scope or replacing the fact', async () => {
    const f = await fixture();
    const base = { id: randomUUID(), text: 'Synthetic shared fact', tags: [], privacy: 'cloud-allowed' as const };
    const original = await f.memory.upsert(base);
    const approved = await f.memory.upsert({ ...base, telegramAllowed:true, expectedRevision: original.contextMetadata!.revision });
    expect(approved.contextMetadata).toMatchObject({ telegramAllowed:true, revision:2 });
    const reloaded = new MemoryService(await f.reopen());
    expect(reloaded.list()[0]?.contextMetadata?.telegramAllowed).toBe(true);
    const narrowed = await reloaded.upsert({ ...base, telegramAllowed:true, scope:{kind:'session',sessionId:f.session.id} });
    expect(narrowed.contextMetadata?.telegramAllowed).toBeUndefined();
    await reloaded.upsert({ ...base, telegramAllowed:true, scope:{kind:'global'} });
    const edited = await reloaded.upsert({ ...base, text:'Replacement fact' });
    expect(edited.contextMetadata?.telegramAllowed).toBeUndefined();
  });

  it('keeps legacy text and original source unchanged and requires explicit review before automatic context use', async () => {
    const f = await fixture();
    const old: MemoryItem = { id: randomUUID(), text: 'LEGACY_SYNTHETIC_FACT', tags: [], source: 'migration', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await f.repository.transaction((state) => { state.memories.push(old); });
    const bytes = await readFile(f.path); const loaded = await f.reopen();
    expect(await readFile(f.path)).toEqual(bytes);
    expect(loaded.snapshot().memories).toEqual([old]);
    const context = () => buildChatContext({ binding: localBinding, sessionId: f.session.id, history: [], memories: f.memory.list(), query: 'fact', locale: 'en' });
    expect(JSON.stringify(context())).not.toContain(old.text);
    const sharingOnly = await f.memory.upsert({ id: old.id, text: old.text, tags: [], privacy: 'cloud-allowed' });
    expect(sharingOnly.contextMetadata?.trust).toBe('unverified');
    expect(sharingOnly.contextMetadata?.sourceReferences).toEqual([]);
    expect(JSON.stringify(context())).not.toContain(old.text);
    const reviewed = await f.memory.upsert({ id: old.id, text: old.text, tags: [], confirmForChat: true });
    expect(reviewed.source).toBe('migration'); expect(reviewed.text).toBe(old.text);
    expect(reviewed.contextMetadata).toMatchObject({ trust: 'host-confirmed', origin: 'manual-review', privacy: 'cloud-allowed', revision: 2, sentCount: 0 });
    expect(reviewed.contextMetadata?.sourceReferences.at(-1)?.kind).toBe('manual-review');
    expect(reviewed.contextMetadata?.sourceReferences).toHaveLength(1);
    expect(JSON.stringify(context())).toContain(old.text);
  });

  it('preserves original chat evidence through sharing, scope and label changes but attributes actual edits to a new manual source', async () => {
    const f = await fixture(); const project = await f.chat.createSession('Synthetic owner', 'project');
    const saved = await f.turn('请记住：ORIGINAL_CHAT_SOURCE_FACT');
    const receipt = await f.memory.saveFromChat(saved.assistant.id, 'ORIGINAL_CHAT_SOURCE_FACT');
    let memory = f.memory.list().find((item) => item.id === receipt.memoryId)!;
    const sourceReferences = [{ kind: 'chat-user', sessionId: f.session.id, messageId: saved.user.id }];
    const sent = await f.turn('Use the recorded fact'); const preparation = preparationFor(traceFor([memory]));
    await f.chat.prepareRequest(sent.assistant.id, preparation); await f.chat.observeRequest(sent.assistant.id, observationFor(preparation));
    expect(f.memory.list()[0]?.contextMetadata?.sentCount).toBe(1);
    const changes = [{ privacy: 'local-only' as const }, { scope: { kind: 'session' as const, sessionId: project.id } }, { tags: ['relabelled'] }];
    for (const [index, change] of changes.entries()) {
      memory = await f.memory.upsert({ id: memory.id, text: memory.text, tags: memory.tags, ...change, confirmForChat: false });
      expect(memory.contextMetadata).toMatchObject({ origin: 'chat-user', trust: 'host-confirmed', revision: index + 2, sentCount: 0, lastSentAt: null });
      expect(memory.contextMetadata?.sourceReferences).toEqual(sourceReferences);
    }
    expect(memory.contextMetadata).toMatchObject({ privacy: 'local-only', scope: { kind: 'session', sessionId: project.id } });
    const reloaded = await f.reopen(); const preserved = reloaded.snapshot().memories.find((item) => item.id === memory.id)!;
    expect(preserved).toEqual(memory);
    expect(reloaded.snapshot().chatMessages.find((item) => item.id === saved.user.id)?.content).toBe('请记住：ORIGINAL_CHAT_SOURCE_FACT');
    const edited = await new MemoryService(reloaded).upsert({ id: memory.id, text: 'MANUALLY_EDITED_FACT', tags: memory.tags });
    expect(edited.contextMetadata).toMatchObject({ origin: 'manual-user', trust: 'host-confirmed', revision: 5 });
    expect(edited.contextMetadata?.sourceReferences).toEqual([{ kind: 'manual-user', actionId: expect.any(String) }]);
    expect(edited.contextMetadata?.sourceReferences).not.toEqual(sourceReferences);
  });

  it('retains known evidence when explicitly reviewing an unverified record', async () => {
    const f = await fixture(); const saved = await f.turn('请记住：REVIEWABLE_SOURCE_FACT');
    const receipt = await f.memory.saveFromChat(saved.assistant.id, 'REVIEWABLE_SOURCE_FACT');
    await f.repository.transaction((state) => { state.memories.find((item) => item.id === receipt.memoryId)!.contextMetadata!.trust = 'unverified'; });
    const memory = f.memory.list()[0]!; const sources = memory.contextMetadata!.sourceReferences;
    const reviewed = await f.memory.upsert({ id: memory.id, text: memory.text, tags: memory.tags, confirmForChat: true });
    expect(reviewed.contextMetadata).toMatchObject({ origin: 'manual-review', trust: 'host-confirmed', revision: 2 });
    expect(reviewed.contextMetadata?.sourceReferences).toEqual([...sources, { kind: 'manual-review', actionId: expect.any(String) }]);
  });

  it('rejects renderer authority fields while accepting bounded provider budgets and explicit sharing choices', () => {
    const input = { id: randomUUID(), text: 'Synthetic fact', tags: [] };
    expect(memoryInputSchema.safeParse({ ...input, contextMetadata: { trust: 'host-confirmed' } }).success).toBe(false);
    expect(memoryInputSchema.safeParse({ ...input, source: 'user', sentCount: 10 }).success).toBe(false);
    expect(memoryInputSchema.safeParse({ ...input, privacy: 'cloud-allowed', scope: { kind: 'session', sessionId: randomUUID() }, confirmForChat: true }).success).toBe(true);
    const provider = { id: randomUUID(), kind: 'ollama', name: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', enabled: true, supportsTools: false };
    expect(providerInputSchema.safeParse({ ...provider, localExecutionConfirmed: true, contextWindowTokens: 4096, maxOutputTokens: 512, outputTokenParameter: 'max_tokens' }).success).toBe(true);
    expect(providerInputSchema.safeParse({ ...provider, contextWindowTokens: 511 }).success).toBe(false);
    expect(providerInputSchema.safeParse({ ...provider, maxOutputTokens: 32_768 }).success).toBe(true);
    expect(providerInputSchema.safeParse({ ...provider, maxOutputTokens: 32_769 }).success).toBe(false);
  });

  it('lets a new memory reach cloud models unless its conversation is local-only', async () => {
    const f = await fixture();
    const open = await f.turn('请记住：SHAREABLE_FACT');
    const shared = await f.memory.saveFromChat(open.assistant.id, 'SHAREABLE_FACT');
    await f.repository.transaction((state) => { state.chatSessions.find((item) => item.id === f.session.id)!.historyPrivacy = 'local-only'; });
    const closed = await f.turn('请记住：PRIVATE_SESSION_FACT');
    const kept = await f.memory.saveFromChat(closed.assistant.id, 'PRIVATE_SESSION_FACT');
    const privacy = (id: string) => f.memory.list().find((item) => item.id === id)?.contextMetadata?.privacy;
    expect(privacy(shared.memoryId)).toBe('cloud-allowed');
    expect(privacy(kept.memoryId)).toBe('local-only');
  });

  it('owns explicit chat sources and keeps identical project facts separate from other projects and global facts', async () => {
    const f = await fixture(); const projectA = await f.chat.createSession('A', 'project'); const projectB = await f.chat.createSession('B', 'project');
    const text = 'PROJECT_SCOPED_SYNTHETIC_FACT';
    const a = await f.turn(`请记住：${text}`, projectA.id); const first = await f.memory.saveFromChat(a.assistant.id, text);
    const b = await f.turn(`请记住：${text}`, projectB.id); const second = await f.memory.saveFromChat(b.assistant.id, text);
    const global = await f.turn(`请记住：${text}`); const third = await f.memory.saveFromChat(global.assistant.id, text);
    expect(new Set([first.memoryId, second.memoryId, third.memoryId]).size).toBe(3);
    const memoryA = f.memory.list().find((memory) => memory.id === first.memoryId)!;
    expect(memoryA.contextMetadata).toMatchObject({ trust: 'host-confirmed', origin: 'chat-user', scope: { kind: 'session', sessionId: projectA.id }, privacy: 'cloud-allowed', revision: 1, sentCount: 0 });
    expect(memoryA.contextMetadata?.sourceReferences).toEqual([{ kind: 'chat-user', sessionId: projectA.id, messageId: a.user.id }]);
    expect(f.memory.list().find((memory) => memory.id === third.memoryId)?.contextMetadata?.scope).toEqual({ kind: 'global' });
    const repeated = await f.turn(`请记住：${text}`, projectA.id);
    expect(await f.memory.saveFromChat(repeated.assistant.id, text)).toMatchObject({ memoryId: first.memoryId, reused: true });
    expect(f.memory.list()).toHaveLength(3);
    expect(f.chat.listMessages(projectA.id).find((message) => message.id === a.user.id)?.contextTrace?.memoryReferences).toEqual([{ id: first.memoryId, revision: 1 }]);
  });

  it('invalidates original user and receipt history after correction and deletion without deleting the visible transcript', async () => {
    const f = await fixture(); const saved = await f.turn('请记住：ORIGINAL_SYNTHETIC_FACT');
    const receipt = await f.memory.saveFromChat(saved.assistant.id, 'ORIGINAL_SYNTHETIC_FACT');
    await f.chat.updateMessage(saved.assistant.id, { content: 'Saved ORIGINAL_SYNTHETIC_FACT', status: 'complete', errorCode: null });
    const edit = await f.turn('把 ORIGINAL_SYNTHETIC_FACT 改成 CORRECTED_SYNTHETIC_FACT');
    await f.memory.editFromChat(edit.assistant.id, 'ORIGINAL_SYNTHETIC_FACT', 'CORRECTED_SYNTHETIC_FACT');
    await f.chat.updateMessage(edit.assistant.id, { content: 'Updated', status: 'complete', errorCode: null });
    expect(f.memory.list()[0]?.contextMetadata?.revision).toBe(2);
    const context = () => buildChatContext({ binding: localBinding, sessionId: f.session.id, history: f.chat.listMessages(f.session.id),
      historyPrivacy: 'local-only', memories: f.memory.list(), query: 'fact', locale: 'en' });
    expect(JSON.stringify(context())).not.toContain('ORIGINAL_SYNTHETIC_FACT');
    expect(JSON.stringify(context())).toContain('CORRECTED_SYNTHETIC_FACT');
    expect(f.chat.listMessages(f.session.id).some((message) => message.content.includes('ORIGINAL_SYNTHETIC_FACT'))).toBe(true);
    await f.memory.remove(receipt.memoryId);
    expect(JSON.stringify(context())).not.toContain('CORRECTED_SYNTHETIC_FACT');
    const reloaded = await f.reopen();
    expect(reloaded.snapshot().memories).toEqual([]);
    expect(reloaded.snapshot().chatMessages.some((message) => message.contextTrace?.memoryReferences.some((reference) => reference.id === receipt.memoryId))).toBe(true);
  });
});

describe('prepared request and actual transport receipts', () => {
  it('freezes explicit binding and omitted-context counts in the receipt identity while leaving older missing values unknown', async () => {
    const f = await fixture(); const oldTurn = await f.turn('Older request'); const legacy = preparationFor(traceFor());
    const oldReceipt = await f.chat.prepareRequest(oldTurn.assistant.id, legacy);
    expect(oldReceipt).not.toHaveProperty('contextBinding'); expect(oldReceipt).not.toHaveProperty('excludedContext');
    const turn = await f.turn('Current request');
    const preparation: ChatRequestPreparation = { ...preparationFor(traceFor()),
      contextBinding: { providerId: randomUUID(), model: 'frozen-fixture-model', destination: 'local', localExecutionDeclared: true },
      excludedContext: { memoryCount: 2, historyCount: 4 } };
    const receipt = await f.chat.prepareRequest(turn.assistant.id, preparation);
    expect(receipt.contextBinding).toEqual(preparation.contextBinding); expect(receipt.excludedContext).toEqual(preparation.excludedContext);
    await expect(f.chat.prepareRequest(turn.assistant.id, structuredClone(preparation))).resolves.toEqual(receipt);
    const before = f.repository.snapshot();
    await expect(f.chat.prepareRequest(turn.assistant.id, { ...preparation, contextBinding: { ...preparation.contextBinding!, model: 'replacement-model' } })).rejects.toThrow('chat.contextReceiptConflict');
    await expect(f.chat.prepareRequest(turn.assistant.id, { ...preparation, excludedContext: { memoryCount: 1, historyCount: 4 } })).rejects.toThrow('chat.contextReceiptConflict');
    expect(f.repository.snapshot()).toEqual(before);
    expect(chatRequestPreparationSchema.safeParse({ ...preparation, contextBinding: { ...preparation.contextBinding, providerId: 'not-a-uuid' } }).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse({ ...preparation, contextBinding: { ...preparation.contextBinding, destination: 'inferred-local' } }).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse({ ...preparation, contextBinding: { ...preparation.contextBinding, extra: true } }).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse({ ...preparation, excludedContext: { memoryCount: -1, historyCount: 0 } }).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse({ ...preparation, excludedContext: { memoryCount: 0, historyCount: 1.5 } }).success).toBe(false);
    await f.chat.updateMessage(oldTurn.assistant.id, { content: 'Older completed response', status: 'complete', errorCode: null });
    await f.chat.updateMessage(turn.assistant.id, { content: 'Current completed response', status: 'complete', errorCode: null });
    const bytes = await readFile(f.path); const reloaded = await f.reopen(); expect(await readFile(f.path)).toEqual(bytes);
    const messages = new ChatService(reloaded).listMessages(f.session.id);
    expect(messages.find((item) => item.id === oldTurn.assistant.id)?.requestReceipts?.[0]).toEqual(oldReceipt);
    expect(messages.find((item) => item.id === turn.assistant.id)?.requestReceipts?.[0]).toEqual(receipt);
  });

  it('atomically stamps both messages before dispatch and counts each observed matching request once across restart', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'SYNTHETIC_LOCAL_FACT', tags: [], privacy: 'local-only' });
    const turn = await f.turn('Use the synthetic fact'); const preparation = preparationFor(traceFor([memory]));
    const prepared = await f.chat.prepareRequest(turn.assistant.id, preparation);
    expect(prepared.phase).toBe('prepared'); expect(prepared.observations).toEqual([]); expect(prepared.sentCountRecorded).toBe(false);
    expect(f.memory.list()[0]?.contextMetadata?.sentCount).toBe(0);
    for (const id of [turn.user.id, turn.assistant.id]) expect(f.chat.listMessages(f.session.id).find((message) => message.id === id)?.contextTrace).toEqual(preparation.contextTrace);
    expect(f.repository.snapshot().chatSessions[0]?.historyPrivacy).toBe('local-only');
    expect(() => f.chat.assertPreparedRequest(turn.assistant.id, preparation.requestId)).not.toThrow();
    const fetch = observationFor(preparation); await f.chat.observeRequest(turn.assistant.id, fetch); await f.chat.observeRequest(turn.assistant.id, fetch);
    await f.chat.observeRequest(turn.assistant.id, observationFor(preparation, 'response-received'));
    const terminal = { ...observationFor(preparation, 'terminal'), usage: { inputTokens: 21, outputTokens: 7, source: 'provider-reported' as const } };
    await f.chat.observeRequest(turn.assistant.id, terminal);
    expect(f.memory.list()[0]?.contextMetadata).toMatchObject({ sentCount: 1, revision: 1 });
    const reloaded = await f.reopen(); const chat = new ChatService(reloaded); await chat.observeRequest(turn.assistant.id, terminal);
    const receipt = chat.listMessages(f.session.id).find((message) => message.id === turn.assistant.id)?.requestReceipts?.[0];
    expect(receipt?.phase).toBe('terminal'); expect(receipt?.observations).toHaveLength(3);
    expect(receipt?.observations[0]?.usage).toEqual({ inputTokens: null, outputTokens: null, source: 'unknown' });
    expect(receipt?.observations[2]?.usage).toEqual(terminal.usage);
    expect(reloaded.snapshot().memories[0]?.contextMetadata?.sentCount).toBe(1);
  });

  it('rejects stale sources before dispatch and never attributes late transport to a changed or deleted memory revision', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'BEFORE_CHANGE', tags: [] });
    const turn = await f.turn('Synthetic prompt'); const preparation = preparationFor(traceFor([memory]));
    await f.chat.prepareRequest(turn.assistant.id, preparation);
    await f.memory.upsert({ id: memory.id, text: 'AFTER_CHANGE', tags: [] });
    expect(() => f.chat.assertPreparedRequest(turn.assistant.id, preparation.requestId)).toThrow('chat.contextStale');
    await f.chat.observeRequest(turn.assistant.id, observationFor(preparation));
    expect(f.memory.list()[0]?.contextMetadata).toMatchObject({ revision: 2, sentCount: 0 });
    await f.memory.remove(memory.id); await f.chat.observeRequest(turn.assistant.id, observationFor(preparation, 'response-received'));
    expect(f.memory.list()).toEqual([]);
    const staleTurn = await f.turn('New request'); const snapshot = f.repository.snapshot();
    await expect(f.chat.prepareRequest(staleTurn.assistant.id, preparationFor(traceFor([memory])))).rejects.toThrow('chat.contextStale');
    expect(f.repository.snapshot()).toEqual(snapshot);
  });

  it('requires same-run tool rounds to retain earlier causal sources and permits a clean explicitly new retry run', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'ROUND_ONE_FACT', tags: [] });
    const turn = await f.turn('Use the fact and then continue'); const runId = randomUUID();
    const first = { ...preparationFor(traceFor([memory])), runId };
    await f.chat.prepareRequest(turn.assistant.id, first); await f.chat.observeRequest(turn.assistant.id, observationFor(first));
    const dropped = { ...preparationFor(traceFor()), runId }; const before = f.repository.snapshot();
    await expect(f.chat.prepareRequest(turn.assistant.id, dropped)).rejects.toThrow('chat.contextStale');
    expect(f.repository.snapshot()).toEqual(before);
    const changed = await f.memory.upsert({ id: memory.id, text: 'ROUND_TWO_CHANGED_FACT', tags: [] });
    const rewritten = { ...preparationFor(traceFor([changed])), runId };
    await expect(f.chat.prepareRequest(turn.assistant.id, rewritten)).rejects.toThrow('chat.contextStale');
    const freshRetry = { ...preparationFor(traceFor([changed])), runId: randomUUID() };
    await expect(f.chat.prepareRequest(turn.assistant.id, freshRetry)).resolves.toMatchObject({ runId: freshRetry.runId, phase: 'prepared' });
    expect(() => f.chat.assertPreparedRequest(turn.assistant.id, freshRetry.requestId)).not.toThrow();
    const receipts = f.chat.listMessages(f.session.id).find((message) => message.id === turn.assistant.id)?.requestReceipts;
    expect(receipts).toHaveLength(2); expect(receipts?.[0]?.contextTrace.memoryReferences).toEqual([{ id: memory.id, revision: 1 }]);
    expect(receipts?.[1]?.contextTrace.memoryReferences).toEqual([{ id: memory.id, revision: 2 }]);
  });

  it('continues a second tool round after durable send accounting without changing fact revisions', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'TOOL_CONTINUATION_FACT', tags: [] });
    const turn = await f.turn('Use the fact in two tool rounds'); const runId = randomUUID();
    const first = { ...preparationFor(traceFor([memory])), runId };
    await f.chat.prepareRequest(turn.assistant.id, first);
    await f.chat.observeRequest(turn.assistant.id, observationFor(first));
    expect(f.memory.list()[0]?.contextMetadata).toMatchObject({ revision: 1, sentCount: 1 });
    const second = { ...preparationFor(traceFor(f.memory.list())), runId };
    await expect(f.chat.prepareRequest(turn.assistant.id, second)).resolves.toMatchObject({ phase: 'prepared' });
    expect(() => f.chat.assertPreparedRequest(turn.assistant.id, second.requestId)).not.toThrow();
    await f.chat.observeRequest(turn.assistant.id, observationFor(second));
    expect(f.memory.list()[0]?.contextMetadata).toMatchObject({ revision: 1, sentCount: 2 });
  });

  it('expires temporary facts in both new context projections and a previously prepared request', async () => {
    const f = await fixture();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const memory = await f.memory.upsert({ id: randomUUID(), text: 'EXPIRING_SYNTHETIC_FACT', tags: [], expiresAt, scope: { kind: 'session', sessionId: f.session.id } });
    const turn = await f.turn('Use the temporary fact'); const preparation = preparationFor(traceFor([memory]));
    await f.chat.prepareRequest(turn.assistant.id, preparation);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1);
    try {
      expect(() => f.chat.assertPreparedRequest(turn.assistant.id, preparation.requestId)).toThrow('chat.contextStale');
      expect(JSON.stringify(buildChatContext({ binding: localBinding, sessionId: f.session.id, history: [], memories: f.memory.list(), query: 'fact', locale: 'en' }))).not.toContain(memory.text);
    } finally { clock.mockRestore(); }
  });

  it('keeps preparation and accounting absent after storage failure and rejects mismatched actual bodies', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'ATOMIC_SYNTHETIC_FACT', tags: [] });
    const turn = await f.turn('Synthetic prompt'); const preparation = preparationFor(traceFor([memory])); const before = f.repository.snapshot();
    f.lock(true); await expect(f.chat.prepareRequest(turn.assistant.id, preparation)).rejects.toThrow('Fixture locked');
    expect(f.repository.snapshot()).toEqual(before); f.lock(false);
    await f.chat.prepareRequest(turn.assistant.id, preparation); const prepared = f.repository.snapshot();
    await expect(f.chat.observeRequest(turn.assistant.id, { ...observationFor(preparation), bodySHA256: 'c'.repeat(64) })).rejects.toThrow('chat.contextReceiptConflict');
    expect(f.repository.snapshot()).toEqual(prepared);
    f.lock(true); await expect(f.chat.observeRequest(turn.assistant.id, observationFor(preparation))).rejects.toThrow('Fixture locked');
    expect(f.repository.snapshot()).toEqual(prepared); f.lock(false);
    await f.chat.observeRequest(turn.assistant.id, observationFor(preparation)); expect(f.memory.list()[0]?.contextMetadata?.sentCount).toBe(1);
    await expect(f.chat.prepareRequest(turn.assistant.id, { ...preparation, bindingDigest: 'd'.repeat(64) })).rejects.toThrow('chat.contextReceiptConflict');
  });

  it('permits a clean current cloud request in a sticky local conversation while retaining restricted future history', async () => {
    const f = await fixture(); const local = await f.memory.upsert({ id: randomUUID(), text: 'LOCAL_HISTORY_SECRET', tags: [], privacy: 'local-only' });
    const first = await f.turn('Use local detail'); await f.chat.prepareRequest(first.assistant.id, preparationFor(traceFor([local])));
    await f.chat.updateMessage(first.assistant.id, { content: 'LOCAL_HISTORY_SECRET', status: 'complete', errorCode: null });
    const next = await f.turn('NEW_EXPLICIT_CLOUD_INPUT'); const clean = preparationFor(traceFor());
    const receipt = await f.chat.prepareRequest(next.assistant.id, clean);
    expect(receipt.contextTrace.privacy).toBe('cloud-allowed'); expect(receipt.contextTrace.historyMessageIds).toEqual([]);
    expect(() => f.chat.assertPreparedRequest(next.assistant.id, clean.requestId)).not.toThrow();
    const stored = f.chat.listMessages(f.session.id);
    expect(stored.find((message) => message.id === next.user.id)?.contextTrace?.privacy).toBe('local-only');
    expect(stored.find((message) => message.id === next.assistant.id)?.contextTrace?.privacy).toBe('local-only');
    const context = buildChatContext({ binding: remoteBinding, sessionId: f.session.id, history: stored, historyPrivacy: 'local-only', memories: f.memory.list(), query: 'NEW_EXPLICIT_CLOUD_INPUT', locale: 'en' });
    expect(context.filter((message) => message.role !== 'system')).toEqual([]);
    expect(JSON.stringify(context)).not.toContain('LOCAL_HISTORY_SECRET');
  });

  it('retains deterministic host timer replies as history without inventing an HTTP request or memory usage', async () => {
    const f = await fixture(); const memory = await f.memory.upsert({ id: randomUUID(), text: 'UNUSED_FACT', tags: [] });
    const turn = await f.turn('Create a 60-second synthetic timer');
    await f.chat.addTimerReceipt(turn.assistant.id, { timerId: randomUUID(), label: 'Synthetic timer', seconds: 60, dueAt: new Date().toISOString(), timeZone: 'UTC' });
    await f.chat.stampHostReply(turn.assistant.id);
    await f.chat.updateMessage(turn.assistant.id, { content: 'HOST_TIMER_REPLY', status: 'complete', errorCode: null });
    const message = f.chat.listMessages(f.session.id).find((item) => item.id === turn.assistant.id)!;
    expect(message.contextTrace).toMatchObject({ lineage: 'complete', historyMessageIds: [turn.user.id] });
    expect(message.requestReceipts).toBeUndefined(); expect(f.memory.list().find((item) => item.id === memory.id)?.contextMetadata?.sentCount).toBe(0);
    const context = buildChatContext({ binding: localBinding, sessionId: f.session.id, history: f.chat.listMessages(f.session.id), memories: [], query: 'What timer?', locale: 'en' });
    expect(JSON.stringify(context)).toContain('HOST_TIMER_REPLY'); expect(JSON.stringify(context)).toContain('Confirmed timer');
    await f.chat.stampHostReply(turn.assistant.id); expect(f.chat.listMessages(f.session.id).find((item) => item.id === turn.assistant.id)?.contextTrace).toEqual(message.contextTrace);
  });
});
