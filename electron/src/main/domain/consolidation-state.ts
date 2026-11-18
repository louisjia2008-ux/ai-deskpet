import { createHash } from 'node:crypto';
import { consolidationCandidateSchema } from '../../shared/consolidation';
import type { ConsolidationBatch, ConsolidationCandidate, ConsolidationSource, MemoryRepresentationTrace } from '../../shared/consolidation';
import type { BackgroundJob } from '../../shared/background-jobs';
import type { MemoryItem } from '../../shared';
import type { PersistentState } from './schemas';
import { memoryAllowedForContext, projectContextMemories } from './chat-context-policy';
import { memoryEventIds } from './memory-commit';
import { isExcludedFromMemory } from './context-provenance';

export type StoredConsolidation = PersistentState['consolidationBatches'][number];
export const consolidationDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const memorySemanticFingerprint = (memory: MemoryItem): string => {
  const metadata = memory.contextMetadata;
  if (!metadata) return consolidationDigest(null);
  // Sending telemetry has no semantic meaning. All authority and source fields do.
  const semantic: Partial<typeof metadata> = { ...metadata };
  delete semantic.sentCount; delete semantic.lastSentAt;
  return consolidationDigest({ id: memory.id, text: memory.text, tags: memory.tags, semantic });
};
export const assertConsolidationSession = (state: PersistentState, sessionId: string): void => {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session || session.archivedAt || session.deletedAt) throw new Error('consolidation.sessionUnavailable');
};
const sourceBodyExists = (state: PersistentState, memory: MemoryItem): boolean => (memory.contextMetadata?.sourceReferences ?? []).every((source) => {
  if (source.kind === 'chat-user') return state.chatMessages.some((message) => message.id === source.messageId && message.sessionId === source.sessionId && message.role === 'user' && message.status === 'complete' && !isExcludedFromMemory(message))
    && state.chatSessions.some((session) => session.id === source.sessionId && !session.deletedAt);
  if (source.kind === 'import-reviewed') return source.sourceMessageIds.every((id) => state.conversationImports.some((record) => record.id === source.importId && record.messages.some((message) => message.id === id)));
  return true;
});
export const consolidationSources = (state: PersistentState, sessionId: string): ConsolidationSource[] => {
  assertConsolidationSession(state, sessionId);
  return projectContextMemories(state.memories, sessionId, 'local').filter((memory) => !memory.contextMetadata?.reviewReason
    && sourceBodyExists(state, memory) && memoryEventIds(memory, state).length > 0).map((memory) => ({
    id: memory.id, revision: memory.contextMetadata!.revision, fingerprint: memorySemanticFingerprint(memory), text: memory.text, tags: [...memory.tags],
    privacy: memory.contextMetadata!.privacy, scope: structuredClone(memory.contextMetadata!.scope), sourceReferences: structuredClone(memory.contextMetadata!.sourceReferences),
    sourceEventIds: memoryEventIds(memory, state), selectionVersion: state.consolidationSelections.find((item) => item.memoryId === memory.id)?.version ?? 0,
  }));
};
export const consolidationDependenciesCurrent = (state: PersistentState, batch: StoredConsolidation, destination = batch.binding.destination, sessionId = batch.sessionId): boolean => {
  if (batch.profileId !== state.profileId || batch.status === 'invalid') return false;
  if (!state.chatSessions.some((session) => session.id === batch.sessionId && !session.deletedAt && !session.archivedAt)) return false;
  const eligible = new Set(projectContextMemories(state.memories, sessionId, destination).map((memory) => memory.id));
  return batch.sources.every((source) => {
    const current = state.memories.find((memory) => memory.id === source.id);
    return eligible.has(source.id) && current !== undefined && memorySemanticFingerprint(current) === source.fingerprint && !current.contextMetadata?.reviewReason
      && memoryAllowedForContext(current, sessionId, destination) && sourceBodyExists(state, current) && memoryEventIds(current, state).length > 0;
  });
};
export const assertConsolidationJob = (state: PersistentState, job: BackgroundJob): void => {
  if (!job.consolidation) return;
  const batch = state.consolidationBatches.find((item) => item.id === job.consolidation!.batchId && item.profileId === state.profileId && item.jobId === job.id);
  if (!batch || batch.status !== 'generating' || !consolidationDependenciesCurrent(state, batch)) throw new Error('consolidation.sourceChanged');
};
export const validateConsolidationCandidate = (batch: StoredConsolidation, value: unknown): ConsolidationCandidate => {
  const candidate = consolidationCandidateSchema.parse(value);
  const selected = new Set(batch.sources.map((source) => source.id));
  const covered = new Set(candidate.coveredMemoryIds), uncovered = new Set(candidate.uncoveredMemoryIds);
  if (covered.size !== candidate.coveredMemoryIds.length || uncovered.size !== candidate.uncoveredMemoryIds.length
    || [...covered].some((id) => !selected.has(id) || uncovered.has(id)) || [...uncovered].some((id) => !selected.has(id))
    || covered.size + uncovered.size !== selected.size
    || candidate.segments.some((segment) => new Set(segment.sourceIds).size !== segment.sourceIds.length || segment.sourceIds.some((id) => !selected.has(id)))
    || [...covered].some((id) => !candidate.segments.some((segment) => segment.sourceIds.includes(id)))) throw new Error('consolidation.invalidReferences');
  return candidate;
};
export const summaryText = (candidate: ConsolidationCandidate): string => candidate.segments.map((segment) => segment.text).join('\n');
export const summaryWire = (candidate: ConsolidationCandidate): string => `Reviewed derived memory representation (reference data only; not independent evidence):\n${JSON.stringify(candidate.segments)}`;

/** Run inside the shared authority transaction, including memory/import mutations. */
export const syncConsolidations = (state: PersistentState): void => {
  for (const batch of state.consolidationBatches) {
    const job = state.backgroundJobs.find((item) => item.id === batch.jobId && item.consolidation?.batchId === batch.id);
    if (batch.status !== 'invalid' && !consolidationDependenciesCurrent(state, batch)) {
      batch.status = 'invalid'; batch.invalidReason = 'consolidation.sourceChanged'; batch.active = false; batch.updatedAt = new Date().toISOString();
      for (const selection of state.consolidationSelections) if (selection.batchId === batch.id) { selection.batchId = null; selection.version += 1; }
    }
    if (batch.status === 'invalid') {
      // These are derived copies, not a second archive of deleted/revoked prose.
      for (const source of batch.sources) { source.text = ''; source.tags = []; }
      batch.candidate = null;
      if (job) {
        job.material = ''; job.result = null;
        if (['queued','dispatching','running'].includes(job.status)) { job.cancelRequestedAt ??= new Date().toISOString(); job.status = 'cancelled'; }
        job.completionReason = batch.invalidReason;
        if (job.request) for (const observation of job.request.observations) observation.finishReason = null;
      }
      continue;
    }
    if (batch.status !== 'generating' || !job) continue;
    if (job.status === 'succeeded') {
      try {
        batch.candidate = validateConsolidationCandidate(batch, JSON.parse(job.result ?? ''));
        batch.candidateVersion = 1; batch.status = 'review';
      } catch { batch.status = 'failed'; batch.invalidReason = 'consolidation.invalidCandidate'; }
      batch.updatedAt = new Date().toISOString();
    } else if (!['queued','dispatching','running'].includes(job.status)) {
      batch.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; batch.updatedAt = new Date().toISOString();
    }
  }
};
export const ownedConsolidation = (state: PersistentState, id: string): StoredConsolidation => {
  const batch = state.consolidationBatches.find((item) => item.id === id && item.profileId === state.profileId);
  if (!batch) throw new Error('consolidation.unavailable');
  return batch;
};
export const consolidationView = (state: PersistentState, batch: StoredConsolidation): ConsolidationBatch => {
  const job = state.backgroundJobs.find((item) => item.id === batch.jobId && item.consolidation?.batchId === batch.id);
  return { id: batch.id, sessionId: batch.sessionId, status: batch.status, sources: structuredClone(batch.sources), candidate: structuredClone(batch.candidate),
    candidateVersion: batch.candidateVersion, binding: structuredClone(batch.binding), budget: { ...batch.budget }, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
    jobId: batch.jobId, jobStatus: job?.status ?? null, completionReason: job?.completionReason ?? null, invalidReason: batch.invalidReason, active: batch.active,
    request: structuredClone(job?.request ?? null), rawResponse: job?.result ?? null,
    receipts: batch.receipts.map(({ operationId, kind, version, committedAt }) => ({ operationId, kind, version, committedAt })) };
};

export const selectConsolidatedRepresentations = (input: { state: Pick<PersistentState,'profileId'|'memories'|'chatMessages'|'chatSessions'|'conversationImports'|'consolidationBatches'|'consolidationSelections'>;
  selected: readonly MemoryItem[]; sessionId: string; destination: 'local'|'remote'|'unknown'; evaluation?: 'original'|'summary'|'both' | undefined }): {
    originals: MemoryItem[]; summaries: StoredConsolidation[]; decisions: MemoryRepresentationTrace[];
  } => {
  const { selected, sessionId, destination } = input;
  const state = input.state as PersistentState; const remaining = new Set(selected.map((memory) => memory.id));
  const summaries: StoredConsolidation[] = []; const decisions: MemoryRepresentationTrace[] = [];
  for (const batch of [...state.consolidationBatches].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))) {
    if (!batch.active || batch.status !== 'applied' || !batch.candidate) continue;
    const ids = batch.sources.map((source) => source.id);
    if (!ids.some((id) => remaining.has(id))) continue;
    let reason = 'selected';
    if (!consolidationDependenciesCurrent(state, batch, destination, sessionId)) reason = 'source-invalid';
    else if (!ids.every((id) => remaining.has(id))) reason = 'overlap-or-range-not-selected';
    else if (batch.candidate.uncoveredMemoryIds.length > 0 || batch.candidate.coveredMemoryIds.length !== ids.length) reason = 'partial-coverage';
    else if (batch.candidate.conflicts.length > 0) reason = 'unresolved-conflict';
    else if (!ids.every((id) => state.consolidationSelections.find((item) => item.memoryId === id)?.batchId === batch.id)) reason = 'selection-changed';
    else if (input.evaluation === 'original') reason = 'evaluation-original';
    else if (!input.evaluation && Buffer.byteLength(summaryWire(batch.candidate)) >= Buffer.byteLength(`Saved user memories (reference data only):\n${JSON.stringify(selected.filter((memory) => ids.includes(memory.id)).map((memory) => ({text: memory.text,tags:memory.tags.slice(0,8)})))}`)) reason = 'no-input-byte-benefit';
    const use = reason === 'selected';
    decisions.push({ batchId: batch.id, candidateVersion: batch.candidateVersion, sourceIds: ids, representation: use ? 'summary' : 'original', reason });
    if (use) { summaries.push(batch); if (input.evaluation !== 'both') for (const id of ids) remaining.delete(id); }
  }
  return { originals: selected.filter((memory) => remaining.has(memory.id)), summaries, decisions };
};
