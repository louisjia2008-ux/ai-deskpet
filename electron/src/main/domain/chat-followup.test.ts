import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatService } from './chat-service';
import { DomainRepository } from './repository';
import { MemoryService } from './memory-service';
import { buildChatContext } from './chat-context';
import { chatRequestPreparationSchema } from './schemas';
import type { ChatMessage, ChatRequestPreparation, ContextTrace } from '../../shared';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-chat-followup-')); roots.push(root);
  const path = join(root, 'profile.enc.json'); let locked = false;
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture vault locked'); return Buffer.alloc(32, 64); } };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(); const chat = new ChatService(repository);
  const session = await chat.createSession('Synthetic follow-up', 'normal');
  const question = await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Compare these sources.', status: 'complete', errorCode: null });
  const answer = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: 'Working draft', status: 'streaming', errorCode: null });
  return { repository, chat, session, question, answer, path, reopen, lock: (value: boolean) => { locked = value; } };
};
const preparationFor = (contextTrace: ContextTrace, userMessageIds?: string[]): ChatRequestPreparation => ({
  requestId: randomUUID(), bindingDigest: 'a'.repeat(64), expectedBodySHA256: 'b'.repeat(64), inputEstimate: 24,
  maxInputTokens: 1024, maxOutputTokens: 128, capacitySource: 'configured', contextTrace,
  ...(userMessageIds === undefined ? {} : { userMessageIds }),
});

describe('durable additions to an active chat answer', () => {
  it('persists ordered additions before the assistant with their own IDs and inherited privacy', async () => {
    const f = await fixture();
    await f.repository.transaction((state) => { state.chatSessions[0]!.historyPrivacy = 'local-only'; state.memoryRevision = 7; });
    const firstId = randomUUID(), secondId = randomUUID();
    const first = await f.chat.addFollowup(f.answer.id, firstId, '  Include official references.  ', () => undefined);
    const second = await f.chat.addFollowup(f.answer.id, secondId, 'Use Chinese.', () => undefined);
    expect(first).toMatchObject({ id: firstId, role: 'user', content: 'Include official references.', followupToMessageId: f.answer.id,
      memoryBaseRevision: 7, status: 'complete', contextTrace: { privacy: 'local-only', scope: { kind: 'session', sessionId: f.session.id }, lineage: 'complete' } });
    expect(f.chat.listMessages(f.session.id).map((message) => message.id)).toEqual([f.question.id, firstId, secondId, f.answer.id]);
    expect(await readFile(f.path, 'utf8')).not.toContain('Include official references.');
    await f.chat.updateMessage(f.answer.id, { content: 'Verified final answer.', status: 'complete', errorCode: null });
    const before = f.repository.snapshot(); const reopened = await f.reopen();
    expect(reopened.snapshot()).toEqual(before);
    expect(new ChatService(reopened).listMessages(f.session.id).filter((message) => message.followupToMessageId)).toEqual([first, second]);
  });

  it('deduplicates concurrent same-ID submissions and rejects changed content, owner, and ID collisions', async () => {
    const f = await fixture(); const operationId = randomUUID();
    const [first, duplicate] = await Promise.all([
      f.chat.addFollowup(f.answer.id, operationId, 'Keep it brief.', () => undefined),
      f.chat.addFollowup(f.answer.id, operationId, ' Keep it brief. ', () => undefined),
    ]);
    expect(first).toEqual(duplicate);
    expect(f.chat.listMessages(f.session.id).filter((message) => message.id === operationId)).toHaveLength(1);
    const before = f.repository.snapshot();
    await expect(f.chat.addFollowup(f.answer.id, operationId, 'Different text.', () => undefined)).rejects.toThrow('chat.followupConflict');
    await expect(f.chat.addFollowup(randomUUID(), operationId, 'Keep it brief.', () => undefined)).rejects.toThrow('chat.followupConflict');
    await expect(f.chat.addFollowup(f.answer.id, f.question.id, f.question.content, () => undefined)).rejects.toThrow('chat.followupConflict');
    expect(f.repository.snapshot()).toEqual(before);
  });

  it('enforces eight additions even under concurrent submissions without dropping accepted text', async () => {
    const f = await fixture(); const ids = Array.from({ length: 9 }, () => randomUUID());
    const results = await Promise.allSettled(ids.map((id, index) => f.chat.addFollowup(f.answer.id, id, `Requirement ${index}`, () => undefined)));
    expect(results.slice(0, 8).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(results[8]).toMatchObject({ status: 'rejected', reason: new Error('chat.followupLimit') });
    const additions = f.chat.listMessages(f.session.id).filter((message) => message.followupToMessageId);
    expect(additions.map((message) => message.id)).toEqual(ids.slice(0, 8));
    expect(additions.map((message) => message.content)).toEqual(Array.from({ length: 8 }, (_, index) => `Requirement ${index}`));
  });

  it('enforces the 8000-character item and 32000-character combined bounds', async () => {
    const f = await fixture();
    await expect(f.chat.addFollowup(f.answer.id, randomUUID(), ' '.repeat(8), () => undefined)).rejects.toThrow('chat.followupLimit');
    await expect(f.chat.addFollowup(f.answer.id, randomUUID(), 'x'.repeat(8001), () => undefined)).rejects.toThrow('chat.followupLimit');
    for (let index = 0; index < 4; index += 1) await f.chat.addFollowup(f.answer.id, randomUUID(), String(index).repeat(8000), () => undefined);
    await expect(f.chat.addFollowup(f.answer.id, randomUUID(), 'x', () => undefined)).rejects.toThrow('chat.followupLimit');
    expect(f.chat.listMessages(f.session.id).filter((message) => message.followupToMessageId).reduce((total, message) => total + message.content.length, 0)).toBe(32000);
  });

  it.each(['complete', 'cancelled', 'failed'] as const)('rejects new additions after %s while allowing a receipt replay without duplicate data', async (status) => {
    const f = await fixture(); const operationId = randomUUID();
    const accepted = await f.chat.addFollowup(f.answer.id, operationId, 'Retain this requirement.', () => undefined);
    await f.chat.updateMessage(f.answer.id, { content: 'Retained draft.', status, errorCode: null });
    await expect(f.chat.addFollowup(f.answer.id, randomUUID(), 'Too late.', () => undefined)).rejects.toThrow('chat.followupUnavailable');
    const replay = await f.chat.addFollowup(f.answer.id, operationId, accepted.content, () => { throw new Error('Admission closed'); });
    expect(replay).toEqual(accepted);
    expect(f.chat.listMessages(f.session.id).filter((message) => message.followupToMessageId)).toEqual([accepted]);
  });

  it('checks admission again when a queued transaction reaches the front', async () => {
    const f = await fixture(); let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const blocker = f.repository.transaction(async () => { await barrier; });
    let accepting = true;
    const addition = f.chat.addFollowup(f.answer.id, randomUUID(), 'Must not be committed after cancellation.', () => { if (!accepting) throw new Error('chat.followupUnavailable'); });
    const rejection = expect(addition).rejects.toThrow('chat.followupUnavailable');
    accepting = false; release(); await blocker; await rejection;
    expect(f.chat.listMessages(f.session.id).map((message) => message.id)).toEqual([f.question.id, f.answer.id]);
  });

  it('keeps the original question and ordered additions together on retry and retains only earlier history', async () => {
    const f = await fixture();
    const previous = { ...f.question, id: randomUUID(), content: 'An earlier question.' };
    const earlierAnswer = { ...f.answer, id: randomUUID(), content: 'An earlier answer.', status: 'complete' as const };
    await f.repository.transaction((state) => { state.chatMessages.unshift(previous, earlierAnswer); });
    const first = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Use only primary sources.', () => undefined);
    const second = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Keep the original date range.', () => undefined);
    await f.chat.updateMessage(f.answer.id, { content: 'Interrupted draft.', status: 'cancelled', errorCode: null });
    const retry = f.chat.retryContext(f.answer.id);
    expect(retry.content).toBe('Compare these sources.\n\nAdditional user requirements for this same task:\nUse only primary sources.\n\nKeep the original date range.');
    // Commands are decided from the owner's original message alone, as on the first attempt.
    expect(retry.original).toBe('Compare these sources.');
    expect(retry.history).toEqual([previous, earlierAnswer]);
    expect(retry.userMessageIds).toEqual([f.question.id, first.id, second.id]);
    expect(retry.message.content).toBe('Interrupted draft.');
    const reopened = await f.reopen();
    expect(new ChatService(reopened).retryContext(f.answer.id)).toEqual(retry);
  });

  it('loads legacy messages unchanged alongside new additions and retains them through interrupted-run recovery', async () => {
    const f = await fixture();
    const legacy: ChatMessage = { id: randomUUID(), sessionId: f.session.id, role: 'assistant', content: 'Legacy saved answer.',
      createdAt: '2026-01-01T00:00:00.000Z', status: 'complete', errorCode: null,
      timerReceipts: [{ timerId: randomUUID(), label: 'Legacy timer', seconds: 60, dueAt: '2026-01-01T00:01:00.000Z', timeZone: 'Asia/Shanghai' }] };
    await f.repository.transaction((state) => { state.chatMessages.unshift(legacy); });
    const addition = await f.chat.addFollowup(f.answer.id, randomUUID(), 'A durable new requirement.', () => undefined);
    const reopened = await f.reopen(); const messages = new ChatService(reopened).listMessages(f.session.id);
    expect(messages[0]).toEqual(legacy);
    expect(messages.find((message) => message.id === addition.id)).toEqual(addition);
    expect(messages.find((message) => message.id === f.answer.id)).toMatchObject({ content: f.answer.content, status: 'failed', errorCode: 'chat.interrupted' });
    expect(messages).toHaveLength(4);
  });

  it('does not acknowledge or mutate state on a storage failure, and the same operation can be retried', async () => {
    const f = await fixture(); const operationId = randomUUID(); const before = f.repository.snapshot(); f.lock(true);
    await expect(f.chat.addFollowup(f.answer.id, operationId, 'Persist me exactly once.', () => undefined)).rejects.toThrow('Fixture vault locked');
    expect(f.repository.snapshot()).toEqual(before); f.lock(false);
    await f.chat.addFollowup(f.answer.id, operationId, 'Persist me exactly once.', () => undefined);
    const reopened = await f.reopen();
    expect(reopened.snapshot().chatMessages.filter((message) => message.id === operationId)).toHaveLength(1);
  });
});

describe('actual current-turn input provenance', () => {
  it('uses the latest original question after an orphaned legacy user and rejects additions before that question', async () => {
    const f = await fixture();
    const orphan = { ...f.question, id: randomUUID(), content: 'An older user message whose assistant was never created.' };
    const earlierAddition = { ...f.question, id: randomUUID(), content: 'An addition preceding the actual original.', followupToMessageId: f.answer.id };
    await f.repository.transaction((state) => { state.chatMessages.unshift(orphan, earlierAddition); });
    const addition = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Current requirement after the actual original.', () => undefined);
    const trace = f.question.contextTrace!;
    const receipt = await f.chat.prepareRequest(f.answer.id, preparationFor(trace, [f.question.id, addition.id]));
    expect(receipt.userMessageIds).toEqual([f.question.id, addition.id]);
    expect(f.chat.listMessages(f.session.id).find((message) => message.id === orphan.id)).toEqual(orphan);
    expect(f.chat.listMessages(f.session.id).find((message) => message.id === earlierAddition.id)).toEqual(earlierAddition);
    const before = f.repository.snapshot();
    await expect(f.chat.prepareRequest(f.answer.id, preparationFor(trace, [orphan.id, earlierAddition.id, f.question.id, addition.id]))).rejects.toThrow('chat.contextStale');
    await expect(f.chat.prepareRequest(f.answer.id, preparationFor(trace, [f.question.id, earlierAddition.id, addition.id]))).rejects.toThrow('chat.contextStale');
    expect(f.repository.snapshot()).toEqual(before);
    await f.chat.updateMessage(f.answer.id, { content: 'Interrupted current answer.', status: 'cancelled', errorCode: null });
    const retry = f.chat.retryContext(f.answer.id);
    expect(retry.userMessageIds).toEqual([f.question.id, addition.id]);
    expect(retry.content).toContain(f.question.content); expect(retry.content).toContain(addition.content);
    expect(retry.content).not.toContain(orphan.content); expect(retry.content).not.toContain(earlierAddition.content);
  });

  it('freezes only adopted input IDs while queued additions remain unstamped until a later request uses them', async () => {
    const f = await fixture(); const memory = new MemoryService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'ADOPTED_CONTEXT_FACT', tags: [] });
    const trace: ContextTrace = { ...f.question.contextTrace!, memoryReferences: [{ id: fact.id, revision: fact.contextMetadata!.revision }], privacy: 'local-only' };
    const first = await f.chat.addFollowup(f.answer.id, randomUUID(), 'First requirement.', () => undefined);
    const runId = randomUUID(); const initial = { ...preparationFor(trace, [f.question.id]), runId };
    const receipt = await f.chat.prepareRequest(f.answer.id, initial);
    expect(receipt).toMatchObject({ userMessageId: f.question.id, userMessageIds: [f.question.id] });
    const second = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Second requirement.', () => undefined);
    await expect(f.chat.prepareRequest(f.answer.id, structuredClone(initial))).resolves.toEqual(receipt);
    const message = (id: string) => f.chat.listMessages(f.session.id).find((item) => item.id === id)!;
    expect(message(f.question.id).contextTrace?.memoryReferences).toEqual(trace.memoryReferences);
    expect(message(first.id).contextTrace).toEqual(first.contextTrace);
    expect(message(second.id).contextTrace).toEqual(second.contextTrace);
    const next = { ...preparationFor(trace, [f.question.id, first.id]), runId };
    await f.chat.prepareRequest(f.answer.id, next);
    expect(message(first.id).contextTrace?.memoryReferences).toEqual(trace.memoryReferences);
    expect(message(second.id).contextTrace).toEqual(second.contextTrace);
    await expect(f.chat.prepareRequest(f.answer.id, { ...preparationFor(trace, [f.question.id]), runId })).rejects.toThrow('chat.contextStale');
    const final = { ...preparationFor(trace, [f.question.id, first.id, second.id]), runId };
    await f.chat.prepareRequest(f.answer.id, final);
    for (const id of [f.question.id, first.id, second.id, f.answer.id]) {
      expect(message(id).contextTrace?.memoryReferences).toEqual(trace.memoryReferences);
      expect(message(id).contextTrace?.historyMessageIds).toEqual([]);
    }
    expect(() => f.chat.assertPreparedRequest(f.answer.id, final.requestId)).not.toThrow();
    const reopened = await f.reopen();
    expect(reopened.snapshot().chatMessages.find((item) => item.id === f.answer.id)?.requestReceipts).toEqual(message(f.answer.id).requestReceipts);
  });

  it.each(['correction', 'deletion'] as const)('invalidates all adopted additions after memory %s while retaining the visible transcript', async (change) => {
    const f = await fixture(); const memory = new MemoryService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'OUTDATED_FOLLOWUP_FACT', tags: [] });
    const first = await f.chat.addFollowup(f.answer.id, randomUUID(), 'First restatement of OUTDATED_FOLLOWUP_FACT.', () => undefined);
    const second = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Second restatement of OUTDATED_FOLLOWUP_FACT.', () => undefined);
    const trace: ContextTrace = { ...f.question.contextTrace!, memoryReferences: [{ id: fact.id, revision: fact.contextMetadata!.revision }], privacy: 'local-only' };
    await f.chat.prepareRequest(f.answer.id, preparationFor(trace, [f.question.id, first.id, second.id]));
    await f.chat.updateMessage(f.answer.id, { content: 'Answer using OUTDATED_FOLLOWUP_FACT.', status: 'complete', errorCode: null });
    const projected = () => JSON.stringify(buildChatContext({
      binding: { providerId: 'test-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true },
      sessionId: f.session.id, history: f.chat.listMessages(f.session.id), historyPrivacy: 'local-only', memories: memory.list(), query: 'fact', locale: 'en',
    }));
    expect(projected()).toContain(first.content); expect(projected()).toContain(second.content);
    if (change === 'correction') await memory.upsert({ id: fact.id, text: 'CORRECTED_FOLLOWUP_FACT', tags: [] });
    else await memory.remove(fact.id);
    expect(projected()).not.toContain('OUTDATED_FOLLOWUP_FACT');
    expect(f.chat.listMessages(f.session.id).find((item) => item.id === first.id)?.content).toBe(first.content);
    expect(f.chat.listMessages(f.session.id).find((item) => item.id === second.id)?.content).toBe(second.content);
  });

  it('rejects unrelated, unordered, incomplete and self-referential input IDs without mutating state', async () => {
    const f = await fixture(); const addition = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Current requirement.', () => undefined);
    const priorUser = { ...f.question, id: randomUUID() }, priorAnswer = { ...f.answer, id: randomUUID(), status: 'complete' as const };
    await f.repository.transaction((state) => { state.chatMessages.unshift(priorUser, priorAnswer); });
    const trace = f.question.contextTrace!; const before = f.repository.snapshot();
    for (const ids of [[priorUser.id], [f.question.id, priorUser.id], [f.question.id, f.answer.id], [addition.id, f.question.id], [f.question.id, randomUUID()]]) {
      await expect(f.chat.prepareRequest(f.answer.id, preparationFor(trace, ids))).rejects.toThrow('chat.contextStale');
    }
    for (const id of [f.question.id, addition.id, f.answer.id]) {
      await expect(f.chat.prepareRequest(f.answer.id, preparationFor({ ...trace, historyMessageIds: [id] }, [f.question.id, addition.id]))).rejects.toThrow('chat.contextStale');
    }
    expect(f.repository.snapshot()).toEqual(before);
    await f.repository.transaction((state) => { state.chatMessages.find((item) => item.id === addition.id)!.status = 'cancelled'; });
    await expect(f.chat.prepareRequest(f.answer.id, preparationFor(trace, [f.question.id, addition.id]))).rejects.toThrow('chat.contextStale');
    expect(chatRequestPreparationSchema.safeParse(preparationFor(trace, [f.question.id, f.question.id])).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse(preparationFor(trace, [])).success).toBe(false);
    expect(chatRequestPreparationSchema.safeParse(preparationFor(trace, Array.from({ length: 10 }, () => randomUUID()))).success).toBe(false);
  });

  it('rejects an indirect history cycle before stamping any adopted input', async () => {
    const f = await fixture(); const previous = { ...f.answer, id: randomUUID(), status: 'complete' as const, contextTrace: { ...f.question.contextTrace!, historyMessageIds: [f.question.id] } };
    await f.repository.transaction((state) => { state.chatMessages.unshift(previous); });
    const before = f.repository.snapshot();
    await expect(f.chat.prepareRequest(f.answer.id, preparationFor({ ...f.question.contextTrace!, historyMessageIds: [previous.id] }, [f.question.id]))).rejects.toThrow('chat.contextStale');
    expect(f.repository.snapshot()).toEqual(before);
  });

  it('preserves legacy receipt shape and single-source selection across reload', async () => {
    const f = await fixture();
    const addition = await f.chat.addFollowup(f.answer.id, randomUUID(), 'Legacy latest source.', () => undefined);
    const receipt = await f.chat.prepareRequest(f.answer.id, preparationFor(f.question.contextTrace!));
    expect(receipt.userMessageId).toBe(addition.id); expect(receipt).not.toHaveProperty('userMessageIds');
    await f.chat.updateMessage(f.answer.id, { content: 'Complete legacy request.', status: 'complete', errorCode: null });
    const bytes = await readFile(f.path); const reopened = await f.reopen();
    expect(await readFile(f.path)).toEqual(bytes);
    expect(reopened.snapshot().chatMessages.find((item) => item.id === f.answer.id)?.requestReceipts?.[0]).toEqual(receipt);
  });
});
