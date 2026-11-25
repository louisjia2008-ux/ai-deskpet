import { createHash, randomUUID } from 'node:crypto';
import type { ContextScope, MemoryContextMetadata, MemoryItem, MemorySourceReference } from '../../shared';
import { confirmedMemoryMetadata, DEFAULT_MEMORY_PRIVACY, isExcludedFromMemory, memoryPrivacy, memoryScope, sameContextScope } from './context-provenance';
import { MERGE_LINEAGE_LIMIT, type PersistentState } from './schemas';
import { importedMessageSourceEventId } from './conversation-import-parser';
import { mergeLinks } from './companion-recent-state';

type MemoryTombstone = PersistentState['memoryTombstones'][number];

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
/** The owner confirmed or rewrote this memory, so it is theirs now: later changes to what it was once folded into
 * no longer reach it, including after a restore. Earlier ones still cover the chat it came from. */
export const releaseMergedMemory = (state: PersistentState, memoryId: string, now: Date): void => {
  const at = now.toISOString();
  for (const link of mergeLinks(state.memorySleep)) {
    if (link.memoryId !== memoryId || link.undoneAt || link.releasedAt) continue;
    const stored = state.memorySleep.mergeLineage.find((item) => item.memoryId === link.memoryId && item.resultId === link.resultId && item.at === link.at);
    if (stored) stored.releasedAt = at; else state.memorySleep.mergeLineage.push({ ...link, releasedAt: at });
  }
  state.memorySleep.mergeLineage = state.memorySleep.mergeLineage.slice(-MERGE_LINEAGE_LIMIT);
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
  // The recent summary may rest on a deletion this backup never saw. It covers only the last day and a half; start it again.
  state.companionRecent = { ...state.companionRecent, entries: [], summary: null, sharedSummary: null, clearedAt: new Date().toISOString() };
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
  // A backup from before a nightly merge holds the duplicate as an ordinary memory. Keep the merges either side
  // knows of (older ones only in its undo reports), so a deletion or correction of the memory it was folded into
  // still reaches it. A merge undone on either side stays undone.
  result.memorySleep.mergeLineage = mergeLinks(restored.memorySleep, current.memorySleep).slice(-MERGE_LINEAGE_LIMIT);
  // The guards on whatever this memory was folded into, recorded after every merge along the way.
  const foldedGuards = (memory: MemoryItem): MemoryTombstone[] => {
    const found: MemoryTombstone[] = [], seen = new Set<string>();
    const pending: Array<{ id: string; since: number }> = [{ id: memory.id, since: -Infinity }];
    while (pending.length) {
      const { id, since } = pending.pop()!;
      for (const link of result.memorySleep.mergeLineage) {
        // A released duplicate was reviewed by the owner; its merge no longer guards it.
        if (link.undoneAt || link.releasedAt || link.memoryId !== id || seen.has(`${link.resultId}@${link.at}`)) continue;
        seen.add(`${link.resultId}@${link.at}`);
        const after = Math.max(since, Date.parse(link.at));
        found.push(...result.memoryTombstones.filter((guard) => guard.memoryId === link.resultId && Date.parse(guard.deletedAt) >= after));
        pending.push({ id: link.resultId, since: after });
      }
    }
    return found;
  };
  // Folded guards cover a duplicate with sources of its own (folded into a handwritten memory). Parts of a merged
  // memory share its sources, so the source rule below drops them once the merged memory is deleted or corrected,
  // and a correction carries on as the current row.
  const folded = new Set<string>();
  // A row the current profile still holds unchanged was kept by the owner after every guard there; another fact drawn
  // from the same message as a deleted or corrected one is not dropped with it.
  const live = new Map(current.memories.map((memory) => [memory.id, memory]));
  const keptLive = (memory: MemoryItem, sources: string[]): boolean => {
    const row = live.get(memory.id);
    return row !== undefined && memoryTextDigest(row.text) === memoryTextDigest(memory.text)
      && JSON.stringify(memoryEventIds(row, current).sort()) === JSON.stringify([...sources].sort());
  };
  const protect = (memory: MemoryItem): boolean => {
    for (const guard of foldedGuards(memory)) {
      folded.add(memory.id);
      if (guard.kind === 'deleted') return false;
      if (!memory.contextMetadata?.protectionAcknowledgements?.includes(guard.id)) requireMemoryReview(memory, 'protection-conflict');
    }
    const sources = memoryEventIds(memory, result);
    for (const guard of result.memoryTombstones) {
      // Source identity and deleted row identity dominate clocks and revisions.
      if (guard.memoryId === memory.id && guard.kind === 'deleted') return false;
      if (guard.sourceEventIds.some((source) => sources.includes(source)) && (guard.memoryId === memory.id || !keptLive(memory, sources))) return false;
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
  // The merges follow the restored memories. A duplicate the restore brings back untouched stands on its own again,
  // so its merge counts as undone; one brought back for review because what it was folded into changed keeps the
  // merge, so that change still covers its chat. A merge undone after the backup is in effect again when the
  // restored profile holds the merged result: the kept memory without the duplicate.
  const linkKey = (link: { memoryId: string; resultId: string; at: string }): string => `${link.memoryId}>${link.resultId}@${link.at}`;
  const activeInBackup = new Set(mergeLinks(restored.memorySleep).filter((link) => !link.undoneAt).map(linkKey));
  const present = new Set(result.memories.map((memory) => memory.id)), restoredAt = new Date().toISOString();
  result.memorySleep.mergeLineage = result.memorySleep.mergeLineage.map((link) => {
    if (link.releasedAt) return link;
    if (!link.undoneAt) return present.has(link.memoryId) && !folded.has(link.memoryId) ? { ...link, undoneAt: restoredAt } : link;
    if (present.has(link.memoryId) || !present.has(link.resultId) || !activeInBackup.has(linkKey(link))) return link;
    const active = { ...link }; delete active.undoneAt; return active;
  });
  // Deletions newer than the backup may rest on cleanup history it never saw; the recent summary covers only the
  // last day and a half, so it starts again rather than trust a summary written before them.
  const known = new Set(restored.memoryTombstones.map((item) => item.id));
  if (current.memoryTombstones.some((item) => !known.has(item.id))) {
    result.companionRecent = { ...result.companionRecent, entries: [], summary: null, sharedSummary: null, clearedAt: new Date().toISOString() };
  }
  result.memoryRevision = Math.max(restored.memoryRevision, current.memoryRevision) + 1;
  return result;
};
