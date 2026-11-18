import { createHash, randomUUID } from 'node:crypto';
import type { ContextScope, MemoryContextMetadata, MemoryItem, MemorySourceReference } from '../../shared';
import { confirmedMemoryMetadata, DEFAULT_MEMORY_PRIVACY, isExcludedFromMemory, memoryPrivacy, memoryScope, sameContextScope } from './context-provenance';
import type { PersistentState } from './schemas';
import { importedMessageSourceEventId } from './conversation-import-parser';

export const memoryDigest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const normalizeMemoryText = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(/[。.!！]+$/u, '');
export const memoryTextDigest = (value: string): string => memoryDigest(normalizeMemoryText(value));
export const memoryIdentityKey = (identity?: MemoryContextMetadata['identity']): string | null => identity
  ? JSON.stringify([identity.entity.normalize('NFKC').trim(), identity.key.normalize('NFKC').trim()]) : null;
export const stableMemorySources = (references: readonly MemorySourceReference[]): string[] => [...new Set(references.flatMap((source) => {
  if (source.kind === 'chat-user') return [memoryDigest(`chat:${source.sessionId}:${source.messageId}`)];
  if (source.kind === 'manual-user' || source.kind === 'manual-review') return [memoryDigest(`action:${source.actionId}`)];
  // Legacy import UUIDs are batch-local. They cannot manufacture stable evidence.
  return [];
}))];
export const memoryEventIds = (memory: MemoryItem, state?: PersistentState): string[] => {
  const stable = memory.contextMetadata?.sourceEventIds;
  if (stable?.length) return [...stable];
  const references = memory.contextMetadata?.sourceReferences ?? [];
  const resolved = references.flatMap((reference) => {
    if (reference.kind !== 'import-reviewed' || !state) return [];
    const record = state.conversationImports.find((item) => item.id === reference.importId);
    return record ? record.messages.flatMap((message, index) => reference.sourceMessageIds.includes(message.id)
      ? [importedMessageSourceEventId(record.messages, index)] : []) : [];
  });
  return [...new Set([...stableMemorySources(references), ...resolved])];
};

const bump = (state: PersistentState): void => { state.memoryRevision += 1; };
export const recordMemorySupersession = (state: PersistentState, memory: MemoryItem, kind: 'deleted' | 'corrected', now = new Date()): void => {
  const textDigest = memoryTextDigest(memory.text);
  if (!state.memoryTombstones.some((item) => item.memoryId === memory.id && item.kind === kind && item.textDigest === textDigest && item.memoryRevision === memory.contextMetadata?.revision)) {
    state.memoryTombstones.push({ id: randomUUID(), memoryId: memory.id, textDigest, sourceEventIds: memoryEventIds(memory, state),
      identityKey: memoryIdentityKey(memory.contextMetadata?.identity), scope: structuredClone(memoryScope(memory)), deletedAt: now.toISOString(), kind, ...(memory.contextMetadata ? { memoryRevision: memory.contextMetadata.revision } : {}) });
  }
};

/** A new explicit save can acknowledge guards already observed by the host.
 * Ordinary correction only advances its existing row; it cannot authorize a
 * different deleted row or an operation that has not yet been observed. */
export const acknowledgeMemoryProtection = (state: PersistentState, memory: MemoryItem, intent: 'save' | 'correct'): void => {
  if (!memory.contextMetadata) return;
  const known = new Set(memory.contextMetadata.protectionAcknowledgements ?? []);
  for (const guard of state.memoryTombstones) {
    if (intent === 'correct' ? guard.memoryId === memory.id && guard.kind === 'corrected'
      : sameContextScope(guard.scope, memoryScope(memory)) && (guard.textDigest === memoryTextDigest(memory.text)
        || (guard.identityKey !== null && guard.identityKey === memoryIdentityKey(memory.contextMetadata.identity)))) known.add(guard.id);
  }
  memory.contextMetadata.protectionAcknowledgements = [...known];
};
export const requireMemoryReview = (memory: MemoryItem, reason: NonNullable<MemoryContextMetadata['reviewReason']>): void => {
  memory.contextMetadata ??= { ...confirmedMemoryMetadata({ origin: 'legacy-unknown', sourceReferences: [] }), trust: 'unverified' };
  memory.contextMetadata.trust = 'unverified'; memory.contextMetadata.reviewReason = reason;
};

/** A correction is not a new save intention. Enforce the same guards before
 * publishing it, rather than waiting until a later restore to quarantine it. */
export const assertOrdinaryMemoryProtection = (state: PersistentState, memory: MemoryItem): void => {
  const sources = memoryEventIds(memory, state);
  for (const guard of state.memoryTombstones) {
    if ((guard.memoryId === memory.id && guard.kind === 'deleted')
      || guard.sourceEventIds.some((source) => sources.includes(source))) throw new Error('memory.editStale');
    if (!sameContextScope(guard.scope, memoryScope(memory))) continue;
    const sameFact = guard.textDigest === memoryTextDigest(memory.text)
      || (guard.identityKey !== null && guard.identityKey === memoryIdentityKey(memory.contextMetadata?.identity));
    if (sameFact && !memory.contextMetadata?.protectionAcknowledgements?.includes(guard.id)) throw new Error('memory.editStale');
  }
};

/** Unknown current authority invalidates old automatic intentions as well as
 * recall. Original material remains available for export and explicit review. */
export const quarantineRestoredMemories = (state: PersistentState): void => {
  for (const memory of state.memories) requireMemoryReview(memory, 'protection-unknown');
  for (const message of state.chatMessages) {
    if (message.role === 'user') message.memoryBaseRevision = state.memoryRevision;
    if (message.contextTrace) message.contextTrace.lineage = 'unknown';
  }
  for (const record of state.conversationImports) if (record.draft) record.draft.baseMemoryRevision = state.memoryRevision;
  state.memoryRevision += 1;
};

export interface MemoryCandidateCommit {
  operationId: string;
  text: string;
  tags: string[];
  sourceReferences: MemorySourceReference[];
  sourceEventIds: string[];
  origin: MemoryContextMetadata['origin'];
  scope?: ContextScope;
  privacy?: MemoryContextMetadata['privacy'];
  identity?: MemoryContextMetadata['identity'];
  expiresAt?: string | null;
  authority: 'explicit-user' | 'reviewed-import';
  expectedRevision?: number;
  now?: Date;
}
export type MemoryCommitResult = Pick<PersistentState['memoryOperations'][number], 'status' | 'memoryId'>;

/** This is a host API. Source identities are resolved from stored events by callers,
 * never accepted from distillation JSON or renderer-supplied provenance. */
export const commitMemoryCandidate = (state: PersistentState, input: MemoryCandidateCommit): MemoryCommitResult => {
  const now = input.now ?? new Date();
  const scope = input.scope ?? { kind: 'global' };
  const privacy = input.privacy ?? DEFAULT_MEMORY_PRIVACY;
  const sources = [...new Set(input.sourceEventIds)].sort();
  const digest = memoryDigest(JSON.stringify({ text: input.text.trim(), tags: input.tags, sources, scope, privacy,
    identity: input.identity ?? null, expiresAt: input.expiresAt ?? null, authority: input.authority }));
  const previous = state.memoryOperations.find((item) => item.operationId === input.operationId);
  if (previous) {
    if (previous.digest !== digest) throw new Error('memory.operationConflict');
    return { status: previous.status, memoryId: previous.memoryId };
  }
  const finish = (status: MemoryCommitResult['status'], memoryId: string | null): MemoryCommitResult => {
    state.memoryOperations.push({ operationId: input.operationId, digest, status, memoryId,
      revision: state.memoryRevision, committedAt: now.toISOString() });
    return { status, memoryId };
  };
  if (input.expectedRevision !== undefined && input.expectedRevision !== state.memoryRevision) return finish('stale', null);
  if (sources.length === 0) return finish('blocked', null);
  if (input.sourceReferences.some((source) => source.kind === 'chat-user' && state.chatMessages.some((message) =>
    message.id === source.messageId && message.sessionId === source.sessionId && isExcludedFromMemory(message)))) return finish('blocked', null);
  const textDigest = memoryTextDigest(input.text);
  const identityKey = memoryIdentityKey(input.identity);
  const blocked = state.memoryTombstones.some((item) => item.sourceEventIds.some((source) => sources.includes(source))
    || (sameContextScope(item.scope, scope) && input.authority !== 'explicit-user'
      && (item.textDigest === textDigest || (identityKey !== null && item.identityKey === identityKey))));
  if (blocked || (input.authority !== 'explicit-user' && state.memories.some((memory) => memory.contextMetadata?.reviewReason
    && (memoryEventIds(memory, state).some((source) => sources.includes(source)) || (sameContextScope(memoryScope(memory), scope)
      && (memoryTextDigest(memory.text) === textDigest || (identityKey !== null && memoryIdentityKey(memory.contextMetadata.identity) === identityKey))))))) return finish('blocked', null);
  const existing = state.memories.find((item) => !item.contextMetadata?.reviewReason && memoryTextDigest(item.text) === textDigest
    && sameContextScope(memoryScope(item), scope) && memoryPrivacy(item) === privacy
    && memoryIdentityKey(item.contextMetadata?.identity) === identityKey
    && (item.contextMetadata?.expiresAt ?? null) === (input.expiresAt ?? null));
  if (existing) {
    const known = memoryEventIds(existing, state);
    const added = sources.filter((source) => !known.includes(source));
    if (added.length > 0 || existing.contextMetadata?.trust !== 'host-confirmed') {
      const references = [...(existing.contextMetadata?.sourceReferences ?? [])];
      for (const reference of input.sourceReferences) if (!references.some((item) => JSON.stringify(item) === JSON.stringify(reference))) references.push(reference);
      if (new Set([...known, ...sources]).size > 256 || references.length > 64) throw new Error('memory.evidenceLimit');
      existing.contextMetadata = { ...confirmedMemoryMetadata({ origin: input.origin, sourceReferences: references,
        scope, privacy, ...(existing.contextMetadata ? { previous: existing.contextMetadata } : {}) }),
        sourceEventIds: [...new Set([...known, ...sources])],
        ...(input.identity ? { identity: structuredClone(input.identity) } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
      existing.updatedAt = now.toISOString(); bump(state);
    }
    return finish(added.length === 0 ? 'duplicate' : 'committed', existing.id);
  }
  const id = randomUUID();
  state.memories.push({ id, text: input.text.trim(), tags: [...input.tags], source: 'user', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    contextMetadata: { ...confirmedMemoryMetadata({ origin: input.origin, sourceReferences: input.sourceReferences, scope, privacy }), sourceEventIds: sources,
      ...(input.identity ? { identity: structuredClone(input.identity) } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) } });
  if (input.authority === 'explicit-user') acknowledgeMemoryProtection(state, state.memories.at(-1)!, 'save');
  bump(state); return finish('committed', id);
};

/** Merge guards from the current profile before a formal backup restore. A
 * directory replacement that loses this current profile has no such protection. */
export const reconcileMemoryProtection = (restored: PersistentState, current: PersistentState): PersistentState => {
  const result = structuredClone(restored);
  const tombstones = new Map([...restored.memoryTombstones, ...current.memoryTombstones].map((item) => [item.id, structuredClone(item)]));
  result.memoryTombstones = [...tombstones.values()];
  result.importedSourceEvents = [...new Map([...current.importedSourceEvents, ...restored.importedSourceEvents].map((item) => [JSON.stringify([item.sourceEventId, item.eventFingerprint, item.collectionId]), structuredClone(item)])).values()];
  const operations = new Map(restored.memoryOperations.map((item) => [item.operationId, item]));
  for (const operation of current.memoryOperations) {
    const prior = operations.get(operation.operationId);
    if (prior && prior.digest !== operation.digest) throw new Error('memory.operationConflict');
    operations.set(operation.operationId, structuredClone(operation));
  }
  result.memoryOperations = [...operations.values()];
  const protect = (memory: MemoryItem): boolean => {
    const sources = memoryEventIds(memory, result);
    for (const guard of result.memoryTombstones) {
      // Source identity and deleted row identity dominate clocks and revisions.
      if (guard.sourceEventIds.some((source) => sources.includes(source))
        || (guard.memoryId === memory.id && guard.kind === 'deleted')) return false;
      const sameRow = guard.memoryId === memory.id;
      if (!sameRow && !sameContextScope(guard.scope, memoryScope(memory))) continue;
      if (sameRow && guard.memoryRevision !== undefined && (memory.contextMetadata?.revision ?? 0) <= guard.memoryRevision) return false;
      const sameFact = guard.textDigest === memoryTextDigest(memory.text)
        || (guard.identityKey !== null && guard.identityKey === memoryIdentityKey(memory.contextMetadata?.identity));
      if (!sameRow && !sameFact) continue;
      if (memory.contextMetadata?.protectionAcknowledgements?.includes(guard.id)) continue;
      // A row revision advances only under the host's optimistic mutation rule.
      if (sameRow && guard.kind === 'corrected' && guard.memoryRevision !== undefined
        && (memory.contextMetadata?.revision ?? 0) > guard.memoryRevision) continue;
      requireMemoryReview(memory, 'protection-conflict');
    }
    return true;
  };
  result.memories = result.memories.filter(protect);
  for (const source of current.memories) {
    if (!current.memoryTombstones.some((item) => item.memoryId === source.id && item.kind === 'corrected')) continue;
    const memory = structuredClone(source);
    if (!protect(memory)) continue;
    const oldIndex = result.memories.findIndex((item) => item.id === memory.id);
    const restoredRow = result.memories[oldIndex];
    const revision = memory.contextMetadata?.revision ?? 0;
    const restoredRevision = restoredRow?.contextMetadata?.revision ?? 0;
    if (restoredRow && restoredRevision > revision) continue;
    if (restoredRow && restoredRevision === revision && (memoryTextDigest(restoredRow.text) !== memoryTextDigest(memory.text)
      || JSON.stringify(memoryEventIds(restoredRow).sort()) !== JSON.stringify(memoryEventIds(memory).sort()))) {
      requireMemoryReview(restoredRow, 'protection-conflict'); continue;
    }
    if (oldIndex >= 0) result.memories.splice(oldIndex, 1);
    result.memories.push(memory);
  }
  result.memories = result.memories.filter(protect);
  result.memoryRevision = Math.max(restored.memoryRevision, current.memoryRevision) + 1;
  return result;
};
