import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContextScope, MemoryContextMetadata, MemoryEditResult, MemoryForgetResult, MemoryInput, MemoryItem, MemoryReceipt } from '../../shared';
import { acknowledgeMemoryProtection, assertOrdinaryMemoryProtection, commitMemoryCandidate, memoryDigest, recordMemorySupersession, releaseMergedMemory, stableMemorySources } from './memory-commit';
import { isExcludedFromMemory, sourceUserBefore } from './context-provenance';

const isTemporary = (text: string): boolean => /(?:今天|这次|本次|本轮|当前会话|today|this (?:session|time|conversation))/iu.test(text);
import { CHAT_MEMORY_MAX_CHARACTERS } from './chat-memory-command';
import { matchingMemories } from './chat-memory-forget';
import type { DomainRepository } from './repository';
import { chatMemorySource, confirmedMemoryMetadata, memoryInSession, memoryPrivacy, memoryScope, sameContextScope, stampMemoryCommandTrace, withholdMemoryCommandTrace } from './context-provenance';

export class MemoryService {
  constructor(private readonly repository: DomainRepository) {}

  list(): MemoryItem[] {
    return this.repository.read('memories');
  }

  /** Whether a chat forget/edit query names at least one memory visible in this session. */
  /** A message shaped like a memory command that the host gave to the model. Recorded before the request, so a retry
   * of its reply goes to the model again however far the first attempt got. */
  async recordModelRoute(assistantId: string, now = new Date()): Promise<void> {
    const operationId = `chat-model-route:${assistantId}`;
    await this.repository.transaction((state) => {
      if (state.memoryOperations.some((item) => item.operationId === operationId)) return;
      state.memoryOperations.push({ operationId, digest: memoryDigest('model'), status: 'committed', memoryId: null, revision: state.memoryRevision, committedAt: now.toISOString() });
    });
  }
  routedToModel(assistantId: string): boolean {
    return this.repository.read('memoryOperations').some((item) => item.operationId === `chat-model-route:${assistantId}`);
  }

  /** The candidate a committed chat deletion used, so a retry of its reply finds the same receipt. */
  recordedForgetQuery(messageId: string, candidates: readonly string[]): string | undefined {
    const operation = this.repository.read('memoryOperations').find((item) => item.operationId === `chat-forget:${messageId}`);
    return operation && candidates.find((query) => memoryDigest(query.trim()) === operation.digest);
  }

  matchesInSession(sessionId: string, query: string, exactOnly = false): boolean {
    return matchingMemories(this.repository.read('memories').filter((item) => memoryInSession(item, sessionId)), query, exactOnly).length > 0;
  }

  /** `notAfter` limits a retried command to memories as they stood when the owner first sent it. */
  async editFromChat(messageId: string, query: string, replacement: string, signal?: AbortSignal, now = new Date(), notAfter?: string): Promise<MemoryEditResult> {
    if (query.trim().length < 2 || query.length > CHAT_MEMORY_MAX_CHARACTERS || !replacement.trim() || replacement.length > CHAT_MEMORY_MAX_CHARACTERS) throw new Error('memory.editFailed');
    return this.repository.transaction((state) => {
      signal?.throwIfAborted();
      const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
      const session = state.chatSessions.find((item) => item.id === message?.sessionId);
      if (!message || !session || session.archivedAt || session.deletedAt) throw new Error('memory.editFailed');
      const operationId = `chat-edit:${message.id}`;
      const digest = memoryDigest(JSON.stringify([query.trim(), replacement.trim()]));
      const previous = state.memoryOperations.find((item) => item.operationId === operationId);
      if (message.memoryEdit) {
        if (!previous || previous.digest !== digest) throw new Error('memory.operationConflict');
        return structuredClone(message.memoryEdit);
      }
      const matches = matchingMemories(state.memories.filter((item) => memoryInSession(item, message.sessionId) && (notAfter === undefined || item.updatedAt <= notAfter)), query);
      const previousMemory = matches.length === 1 ? structuredClone(matches[0]!) : undefined;
      let result: MemoryEditResult;
      if (matches.length === 1) {
        const memory = matches[0]!;
        this.assertCurrentCommand(state, message, memory);
        const before = memory.text;
        const updated = this.replaceFromChat(state, message, memory, replacement.trim(), now);
        result = { kind: 'updated', memoryId: updated.id, before, after: updated.text, updatedAt: updated.updatedAt, scope: memoryScope(updated), expiresAt: updated.contextMetadata?.expiresAt ?? null };
      } else if (matches.length === 0) result = { kind: 'not-found', query };
      else result = { kind: 'choices', query, replacement: replacement.trim(), candidates: matches.slice(0, 5).map((item) => ({ id: item.id, text: item.text, updatedAt: item.updatedAt, revision: item.contextMetadata?.revision ?? 0 })), totalMatches: matches.length };
      message.memoryEdit = result;
      state.memoryOperations.push({ operationId, digest, status: 'committed', memoryId: result.kind === 'updated' ? result.memoryId : null, revision: state.memoryRevision, committedAt: now.toISOString() });
      const affected = result.kind === 'updated' ? state.memories.filter((item) => item.id === result.memoryId) : matches.slice(0, 5);
      if (result.kind === 'not-found') withholdMemoryCommandTrace(state, message);
      else stampMemoryCommandTrace(state, message, affected, previousMemory);
      return structuredClone(result);
    });
  }

  async chooseEditFromChat(messageId: string, memoryId: string, reply: string, now = new Date()): Promise<ChatMessage> {
    return this.repository.transaction((state) => {
      const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
      const session = state.chatSessions.find((item) => item.id === message?.sessionId);
      if (!message || message.status !== 'complete' || !session || session.archivedAt || session.deletedAt) throw new Error('memory.editStale');
      if (message.memoryEdit?.kind === 'updated' && message.memoryEdit.memoryId === memoryId) return structuredClone(message);
      const choices = message.memoryEdit?.kind === 'choices' ? message.memoryEdit : undefined;
      const candidate = choices?.candidates.find((item) => item.id === memoryId);
      const memory = state.memories.find((item) => item.id === memoryId);
      if (!choices || !candidate || !memory || !memoryInSession(memory, message.sessionId) || memory.text !== candidate.text || memory.updatedAt !== candidate.updatedAt || candidate.revision !== (memory.contextMetadata?.revision ?? 0)) throw new Error('memory.editStale');
      this.assertCurrentCommand(state, message, memory);
      const previousMemory = structuredClone(memory);
      const updated = this.replaceFromChat(state, message, memory, choices.replacement, now);
      message.memoryEdit = { kind: 'updated', memoryId: updated.id, before: previousMemory.text, after: updated.text, updatedAt: updated.updatedAt, scope: memoryScope(updated), expiresAt: updated.contextMetadata?.expiresAt ?? null };
      message.content = reply;
      stampMemoryCommandTrace(state, message, updated, previousMemory);
      return structuredClone(message);
    });
  }

  /** `exactOnly`: a report-like request reaches only a memory that is word for word its target, even if that one is gone by now. */
  async forgetFromChat(messageId: string, query: string, signal?: AbortSignal, now = new Date(), exactOnly = false, notAfter?: string): Promise<MemoryForgetResult> {
    if (query.trim().length < 2 || query.length > CHAT_MEMORY_MAX_CHARACTERS) throw new Error('memory.forgetFailed');
    let suppressedId: string | undefined;
    try {
      const output = await this.repository.transaction((state) => {
        signal?.throwIfAborted();
        const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
        const session = state.chatSessions.find((item) => item.id === message?.sessionId);
        if (!message || !session || session.archivedAt || session.deletedAt) throw new Error('memory.forgetFailed');
        // A retry uses its original result, even if a new matching memory exists.
        const operationId = `chat-forget:${message.id}`;
        const digest = memoryDigest(query.trim());
        const previous = state.memoryOperations.find((item) => item.operationId === operationId);
        if (message.memoryForget) {
          if (!previous || previous.digest !== digest) throw new Error('memory.operationConflict');
          return structuredClone(message.memoryForget);
        }
        const matches = matchingMemories(state.memories.filter((item) => memoryInSession(item, message.sessionId) && (notAfter === undefined || item.updatedAt <= notAfter)), query, exactOnly);
        let result: MemoryForgetResult;
        if (matches.length === 1) {
          const memory = matches[0]!;
          this.assertCurrentCommand(state, message, memory);
          suppressedId = memory.id; this.repository.suppressMemoryRecall([memory.id]);
          recordMemorySupersession(state, memory, 'deleted', now);
          state.memoryRevision += 1;
          state.memories = state.memories.filter((item) => item.id !== memory.id);
          result = { kind: 'deleted', memoryId: memory.id, text: memory.text, deletedAt: now.toISOString() };
        } else if (matches.length === 0) { result = { kind: 'not-found', query }; withholdMemoryCommandTrace(state, message); }
        else result = { kind: 'choices', query, candidates: matches.slice(0, 5).map((item) => ({ id: item.id, text: item.text, updatedAt: item.updatedAt, revision: item.contextMetadata?.revision ?? 0 })), totalMatches: matches.length };
        message.memoryForget = result;
        state.memoryOperations.push({ operationId, digest, status: 'committed', memoryId: result.kind === 'deleted' ? result.memoryId : null, revision: state.memoryRevision, committedAt: now.toISOString() });
        stampMemoryCommandTrace(state, message, matches.slice(0, 5));
        return structuredClone(result);
      });
      if (output.kind === 'deleted') this.repository.clearMemoryRecallSuppression([output.memoryId]);
      return output;
    } catch (error) {
      if (suppressedId && error instanceof Error) Object.assign(error, { memoryRecallSuppressed: true });
      throw error;
    }
  }

  async chooseForgetFromChat(messageId: string, memoryId: string, reply: string, now = new Date()): Promise<ChatMessage> {
    let suppressedId: string | undefined;
    try {
      const output = await this.repository.transaction((state) => {
        const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
        const session = state.chatSessions.find((item) => item.id === message?.sessionId);
        if (!message || message.status !== 'complete' || !session || session.archivedAt || session.deletedAt) throw new Error('memory.forgetStale');
        if (message.memoryForget?.kind === 'deleted' && message.memoryForget.memoryId === memoryId) return structuredClone(message);
        const candidate = message.memoryForget?.kind === 'choices' ? message.memoryForget.candidates.find((item) => item.id === memoryId) : undefined;
        const memory = state.memories.find((item) => item.id === memoryId);
        // A stale card cannot delete a subsequently edited or different memory.
        if (!candidate || !memory || !memoryInSession(memory, message.sessionId) || memory.text !== candidate.text || memory.updatedAt !== candidate.updatedAt || candidate.revision !== (memory.contextMetadata?.revision ?? 0)) throw new Error('memory.forgetStale');
        this.assertCurrentCommand(state, message, memory);
        suppressedId = memory.id; this.repository.suppressMemoryRecall([memory.id]);
        recordMemorySupersession(state, memory, 'deleted', now);
        state.memoryRevision += 1;
        state.memories = state.memories.filter((item) => item.id !== memoryId);
        message.memoryForget = { kind: 'deleted', memoryId, text: memory.text, deletedAt: now.toISOString() };
        message.content = reply;
        stampMemoryCommandTrace(state, message, memory);
        return structuredClone(message);
      });
      if (output.memoryForget?.kind === 'deleted') this.repository.clearMemoryRecallSuppression([output.memoryForget.memoryId]);
      return output;
    } catch (error) {
      if (suppressedId && error instanceof Error) Object.assign(error, { memoryRecallSuppressed: true });
      throw error;
    }
  }

  // Persist the memory and its chat receipt together. Retrying an interrupted
  // acknowledgement cannot create a duplicate or resurrect a deleted memory.
  async saveFromChat(messageId: string, text: string, signal?: AbortSignal, now = new Date()): Promise<MemoryReceipt> {
    const value = text.trim();
    if (!value || value.length > CHAT_MEMORY_MAX_CHARACTERS) throw new Error('memory.saveFailed');
    return this.repository.transaction((state) => {
      signal?.throwIfAborted();
      const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
      const session = state.chatSessions.find((item) => item.id === message?.sessionId);
      if (!message || !session || session.deletedAt || session.archivedAt) throw new Error('memory.saveFailed');
      const previous = message.memoryReceipts?.[0];
      if (previous) {
        if (previous.text !== value) throw new Error('memory.operationConflict');
        if (!state.memories.some((item) => item.id === previous.memoryId)) throw new Error('memory.removed');
        return structuredClone(previous);
      }
      this.assertCurrentCommand(state, message);
      const temporary = isTemporary(value);
      const desiredScope: ContextScope = session.kind === 'project' || temporary ? { kind: 'session', sessionId: session.id } : { kind: 'global' };
      const evidence = chatMemorySource(state, message);
      const sourceEventIds = stableMemorySources(evidence.sourceReferences);
      const existingIds = new Set(state.memories.map((item) => item.id));
      const result = commitMemoryCandidate(state, { operationId: `chat-save:${message.id}`, text: value, tags: ['chat'],
        ...evidence, sourceEventIds, scope: desiredScope, authority: 'explicit-user', now,
        ...(session.historyPrivacy === 'local-only' ? { privacy: 'local-only' as const } : {}),
        ...(temporary ? { expiresAt: new Date(Date.parse(sourceUserBefore(state, message)?.createdAt ?? now.toISOString()) + 24 * 60 * 60_000).toISOString() } : {}) });
      if (result.status === 'blocked' || !result.memoryId) throw new Error('memory.removed');
      const memory = state.memories.find((item) => item.id === result.memoryId);
      if (!memory) throw new Error('memory.removed');
      const receipt: MemoryReceipt = { memoryId: memory.id, text: value, savedAt: now.toISOString(), reused: existingIds.has(memory.id), scope: memoryScope(memory), expiresAt: memory.contextMetadata?.expiresAt ?? null };
      message.memoryReceipts = [receipt];
      stampMemoryCommandTrace(state, message, memory);
      return structuredClone(receipt);
    });
  }

  async upsert(
    input: MemoryInput,
    source: MemoryItem['source'] = 'user',
    now = new Date(),
  ): Promise<MemoryItem> {
    return this.repository.transaction((state) => {
      const operationId = input.operationId ?? (state.memories.some((item) => item.id === input.id) ? randomUUID() : `manual-create:${input.id}`);
      const digest = memoryDigest(JSON.stringify({ id: input.id, text: input.text, tags: input.tags, privacy: input.privacy, scope: input.scope, confirmForChat: input.confirmForChat, telegramAllowed: input.telegramAllowed, wechatAllowed: input.wechatAllowed, identity: input.identity, expiresAt: input.expiresAt }));
      const priorOperation = state.memoryOperations.find((item) => item.operationId === operationId);
      if (priorOperation) {
        if (priorOperation.digest !== digest) throw new Error('memory.operationConflict');
        const item = state.memories.find((memory) => memory.id === priorOperation.memoryId);
        if (!item) throw new Error('memory.removed');
        return structuredClone(item);
      }
      const finish = (item: MemoryItem): MemoryItem => {
        state.memoryOperations.push({ operationId, digest, status: 'committed', memoryId: item.id, revision: state.memoryRevision, committedAt: now.toISOString() });
        return structuredClone(item);
      };
      const requestedScope = input.scope;
      if (requestedScope?.kind === 'session' && !state.chatSessions.some((session) => session.id === requestedScope.sessionId && !session.deletedAt && !session.archivedAt)) throw new Error('memory.invalidScope');
      const existing = state.memories.find((item) => item.id === input.id);
      if (existing !== undefined) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== (existing.contextMetadata?.revision ?? 0)) throw new Error('memory.editStale');
        if (source !== 'user' && existing.contextMetadata?.trust === 'host-confirmed') throw new Error('memory.editStale');
        const previous = existing.contextMetadata;
        const scope = input.scope ?? memoryScope(existing);
        const privacy = input.privacy ?? memoryPrivacy(existing);
        const textChanged = existing.text !== input.text;
        const reviewing = input.confirmForChat === true && previous?.trust !== 'host-confirmed';
        const telegramAllowed = source === 'user' && privacy === 'cloud-allowed' && scope.kind === 'global'
          && (reviewing || previous?.trust === 'host-confirmed')
          && (input.telegramAllowed ?? (!textChanged && previous?.telegramAllowed === true));
        const wechatAllowed = source === 'user' && scope.kind === 'global'
          && (reviewing || previous?.trust === 'host-confirmed')
          && (input.wechatAllowed ?? (!textChanged && previous?.wechatAllowed === true));
        const changed = telegramAllowed !== (previous?.telegramAllowed === true) || wechatAllowed !== (previous?.wechatAllowed === true)
          || textChanged || JSON.stringify(existing.tags) !== JSON.stringify(input.tags)
          || !sameContextScope(scope, memoryScope(existing)) || privacy !== memoryPrivacy(existing)
          || (input.identity !== undefined && JSON.stringify(input.identity) !== JSON.stringify(previous?.identity))
          || (input.expiresAt !== undefined && input.expiresAt !== previous?.expiresAt);
        if (changed || reviewing) {
          if (textChanged) recordMemorySupersession(state, existing, 'corrected', now);
          state.memoryRevision += 1;
          // Sharing and labels do not change where the fact came from. A new
          // revision still invalidates old context without erasing its evidence.
          const preserveSource = !textChanged && previous !== undefined && !reviewing;
          const sourceReferences = reviewing
            ? [...(previous?.sourceReferences ?? []), { kind: 'manual-review' as const, actionId: input.operationId ?? randomUUID() }]
            : preserveSource ? previous.sourceReferences
              : textChanged && source === 'user' ? [{ kind: 'manual-user' as const, actionId: input.operationId ?? randomUUID() }] : [];
          const origin: MemoryContextMetadata['origin'] = reviewing ? 'manual-review'
            : preserveSource ? previous.origin
              : textChanged && source === 'user' ? 'manual-user'
                : source === 'assistant' ? 'assistant-candidate' : 'legacy-unknown';
          const confirmed = source === 'user' && (reviewing || previous?.trust === 'host-confirmed');
          const metadata: MemoryContextMetadata = confirmedMemoryMetadata({
            origin, scope, privacy, sourceReferences,
            ...(previous ? { previous } : {}),
          });
          if (telegramAllowed) metadata.telegramAllowed = true;
          if (wechatAllowed) metadata.wechatAllowed = true;
          if (!confirmed) { metadata.trust = 'unverified'; if (previous?.reviewReason) metadata.reviewReason = previous.reviewReason; }
          metadata.sourceEventIds = preserveSource ? [...(previous?.sourceEventIds ?? stableMemorySources(sourceReferences))] : stableMemorySources(sourceReferences);
          if (input.identity ?? previous?.identity) metadata.identity = structuredClone(input.identity ?? previous!.identity!);
          if (input.expiresAt !== undefined || previous?.expiresAt !== undefined) metadata.expiresAt = input.expiresAt !== undefined ? input.expiresAt : previous!.expiresAt;
          existing.contextMetadata = metadata;
          Object.assign(existing, { text: input.text, tags: [...input.tags], updatedAt: now.toISOString() });
          acknowledgeMemoryProtection(state, existing, reviewing ? 'save' : 'correct');
          if (source === 'user' && (reviewing || textChanged)) releaseMergedMemory(state, existing.id, now);
          assertOrdinaryMemoryProtection(state, existing);
        }
        return finish(existing);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new Error('memory.editStale');
      if (state.memoryTombstones.some((item) => item.memoryId === input.id)) throw new Error('memory.removed');
      const metadata = confirmedMemoryMetadata({ origin: source === 'user' ? 'manual-user' : source === 'assistant' ? 'assistant-candidate' : 'legacy-unknown',
        sourceReferences: source === 'user' ? [{ kind: 'manual-user', actionId: input.operationId ?? randomUUID() }] : [],
        ...(input.scope ? { scope: input.scope } : {}), ...(input.privacy ? { privacy: input.privacy } : {}) });
      metadata.sourceEventIds = stableMemorySources(metadata.sourceReferences);
      if (input.identity) metadata.identity = structuredClone(input.identity);
      if (input.expiresAt !== undefined) metadata.expiresAt = input.expiresAt;
      if (source === 'user' && input.telegramAllowed === true && metadata.privacy === 'cloud-allowed' && metadata.scope.kind === 'global') metadata.telegramAllowed = true;
      if (source === 'user' && input.wechatAllowed === true && metadata.scope.kind === 'global') metadata.wechatAllowed = true;
      if (source !== 'user') metadata.trust = 'unverified';
      const item: MemoryItem = { id: input.id, text: input.text, tags: [...input.tags], source, createdAt: now.toISOString(), updatedAt: now.toISOString(), contextMetadata: metadata };
      if (source === 'user') acknowledgeMemoryProtection(state, item, 'save');
      state.memories.push(item);
      state.memoryRevision += 1;
      return finish(item);
    });
  }

  /** The owner's one decision for every memory still marked local-only. A memory's own
   * revision stays: widening changes no fact, and an earlier reply that used the memory
   * keeps the local-only mark it was given at the time. */
  async shareAllWithCloud(): Promise<number> {
    return this.repository.transaction((state) => {
      const local = state.memories.filter((item) => item.contextMetadata?.privacy === 'local-only');
      for (const item of local) item.contextMetadata!.privacy = 'cloud-allowed';
      // An edit form opened before this must reload rather than write the old mark back.
      if (local.length) state.memoryRevision += 1;
      return local.length;
    });
  }

  async remove(id: string, options: { expectedRevision?: number; operationId?: string } = {}): Promise<void> {
    let suppressed = false;
    try {
      await this.repository.transaction((state) => {
        const operationId = options.operationId ?? `manual-delete:${id}`;
        const digest = memoryDigest(`delete:${id}`);
        const previous = state.memoryOperations.find((item) => item.operationId === operationId);
        if (previous) { if (previous.digest !== digest) throw new Error('memory.operationConflict'); return; }
        const memory = state.memories.find((item) => item.id === id);
        if (memory) {
          if (options.expectedRevision !== undefined && options.expectedRevision !== (memory.contextMetadata?.revision ?? 0)) throw new Error('memory.forgetStale');
          this.repository.suppressMemoryRecall([id]); suppressed = true;
          recordMemorySupersession(state, memory, 'deleted');
          state.memories = state.memories.filter((item) => item.id !== id);
          state.memoryRevision += 1;
        }
        state.memoryOperations.push({ operationId, digest, status: 'committed', memoryId: id, revision: state.memoryRevision, committedAt: new Date().toISOString() });
      });
      this.repository.clearMemoryRecallSuppression([id]);
    } catch (error) {
      if (suppressed && error instanceof Error) Object.assign(error, { memoryRecallSuppressed: true });
      throw error;
    }
  }

  private replaceFromChat(state: ReturnType<DomainRepository['snapshot']>, message: ChatMessage, memory: MemoryItem, replacement: string, now: Date): MemoryItem {
    if (memory.contextMetadata?.reviewReason) throw new Error('memory.editStale');
    const evidence = chatMemorySource(state, message);
    if (isTemporary(replacement) && memoryScope(memory).kind === 'global') {
      const result = commitMemoryCandidate(state, { operationId: `chat-temporary-edit:${message.id}`, text: replacement, tags: [...memory.tags],
        ...evidence, sourceEventIds: stableMemorySources(evidence.sourceReferences), authority: 'explicit-user',
        scope: { kind: 'session', sessionId: message.sessionId }, privacy: memoryPrivacy(memory), now,
        ...(memory.contextMetadata?.identity ? { identity: memory.contextMetadata.identity } : {}),
        expiresAt: new Date(Date.parse(sourceUserBefore(state, message)?.createdAt ?? now.toISOString()) + 24 * 60 * 60_000).toISOString() });
      const overlay = state.memories.find((item) => item.id === result.memoryId);
      if (!overlay?.contextMetadata) throw new Error('memory.editStale');
      overlay.contextMetadata.overridesMemory = { id: memory.id, revision: memory.contextMetadata?.revision ?? 1 };
      // The replacement is an ordinary correction even when represented by a
      // session overlay; it must not acquire new-save authority over guards.
      overlay.contextMetadata.protectionAcknowledgements = [...(memory.contextMetadata?.protectionAcknowledgements ?? [])];
      assertOrdinaryMemoryProtection(state, overlay);
      return overlay;
    }
    recordMemorySupersession(state, memory, 'corrected', now);
    state.memoryRevision += 1;
    memory.text = replacement; memory.updatedAt = now.toISOString();
    memory.contextMetadata = { ...confirmedMemoryMetadata({ ...evidence,
      ...(memory.contextMetadata ? { previous: memory.contextMetadata } : {}) }), sourceEventIds: stableMemorySources(evidence.sourceReferences) };
    acknowledgeMemoryProtection(state, memory, 'correct');
    assertOrdinaryMemoryProtection(state, memory);
    if (isTemporary(replacement)) memory.contextMetadata.expiresAt = new Date(Date.parse(sourceUserBefore(state, message)?.createdAt ?? now.toISOString()) + 24 * 60 * 60_000).toISOString();
    return memory;
  }

  private assertCurrentCommand(state: ReturnType<DomainRepository['snapshot']>, message: ChatMessage, memory?: MemoryItem): void {
    const source = sourceUserBefore(state, message);
    const base = source?.memoryBaseRevision;
    if (base !== undefined && base !== state.memoryRevision) throw new Error('memory.editStale');
    if (!source) return;
    if (isExcludedFromMemory(source)) throw new Error('memory.editStale');
    const incomingIndex = state.chatMessages.findIndex((item) => item.id === source.id);
    const newerSource = memory?.contextMetadata?.sourceReferences.some((reference) => reference.kind === 'chat-user'
      && state.chatMessages.findIndex((item) => item.id === reference.messageId) > incomingIndex);
    if (newerSource) throw new Error('memory.editStale');
  }
}
