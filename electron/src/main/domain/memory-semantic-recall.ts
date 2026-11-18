import type { MemoryItem } from '../../shared';
import type { KnowledgeEmbeddings } from '../knowledge/ollama-embedding';
import { projectContextMemories } from './chat-context-policy';
import type { ContextDestination } from './chat-context-policy';
import { memoryRecallCorpusDigest, memoryRecallDigest, memoryRelevantForPublicLookup, MIN_MEMORY_SIMILARITY, rankRelevantMemories, recallTextDigest } from './memory-retrieval';
import type { MemoryRecallHints } from './memory-retrieval';
import type { MemoryRecallSearchResult, MemoryRecallUnavailableReason } from '../../shared/memory-recall';

export interface MemoryRecallInput {
  sessionId: string;
  destination: ContextDestination;
  query: string;
  /** Already filtered for suppression and channel disclosure by the host. The
   * ordinary context scope/privacy/expiry projection is repeated here. */
  memories: readonly MemoryItem[];
  signal: AbortSignal;
}
interface CacheEntry { vector: readonly number[]; expiresAt: number }

export const MEMORY_RECALL_LIMITS = {
  maxCandidates: 96, maxMatches: 6, maxCharacters: 3_200, batchSize: 16,
  cacheEntries: 384, cacheLifetimeMs: 5 * 60_000, failureBackoffMs: 30_000,
} as const;

/** Build the desktop preview from a fresh, host-filtered snapshot after await.
 * Deleted/revised/expired/suppressed memories are never recovered from hints. */
export const memoryRecallSearchResult = (input: MemoryRecallInput, hints: MemoryRecallHints): MemoryRecallSearchResult => {
  input.signal.throwIfAborted();
  const eligible = projectContextMemories(input.memories, input.sessionId, input.destination)
    .filter(memory => memoryRelevantForPublicLookup(memory, input.query));
  const currentHints = hints.queryDigest === recallTextDigest(input.query) && hints.sessionId === input.sessionId && hints.destination === input.destination
    && hints.corpusDigest === memoryRecallCorpusDigest(eligible);
  const matches = new Map(currentHints ? hints.matches.map(match => [match.id, match]) : []);
  return {
    query: input.query, mode: currentHints ? hints.mode : 'lexical', reason: currentHints ? hints.reason : 'unavailable',
    ...(currentHints && hints.unavailableReason ? { unavailableReason: hints.unavailableReason } : {}),
    consideredCount: currentHints ? Math.min(hints.consideredCount, eligible.length) : 0, eligibleCount: eligible.length,
    matches: rankRelevantMemories(eligible, input.query, { ...(currentHints ? { hints } : {}), sessionId: input.sessionId, destination: input.destination, includeStandingPreferences: false }).slice(0, 12).map(memory => {
      const match = matches.get(memory.id), valid = match && match.revision === memory.contextMetadata!.revision && match.digest === memoryRecallDigest(memory)
        && Number.isFinite(match.similarity) && match.similarity >= MIN_MEMORY_SIMILARITY && match.similarity <= 1;
      return { id: memory.id, revision: memory.contextMetadata!.revision, text: memory.text, tags: [...memory.tags], privacy: memory.contextMetadata!.privacy,
        sourceCount: memory.contextMetadata!.sourceReferences.length, ...(valid ? { similarity: match.similarity } : {}) };
    }),
  };
};

const normalized = (vector: readonly number[]): number[] | null => {
  if (!vector.length || vector.length > 4096 || !vector.every(Number.isFinite)) return null;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Number.isFinite(magnitude) && magnitude > 0 ? vector.map(value => value / magnitude) : null;
};
const similarity = (left: readonly number[], right: readonly number[]): number => left.length === right.length
  ? Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index]!, 0))) : -1;
const unavailableReason = (error: unknown): MemoryRecallUnavailableReason => {
  const code = error instanceof Error ? error.message : '';
  if (code === 'knowledge.localModelBusy') return 'model-busy';
  if (code === 'knowledge.embeddingModelMissing') return 'model-missing';
  if (code === 'knowledge.embeddingNotLocal') return 'not-local';
  if (code === 'knowledge.invalidEmbeddingResponse' || code === 'memory.invalidEmbedding') return 'invalid-response';
  return 'unavailable';
};

/** Uses the same verified loopback/GGUF embedding adapter and local-model slot
 * as the knowledge vault. This class never chooses a URL, downloads a model,
 * evicts a chat model, writes an index to disk, or sends a remote request.
 * Cache values contain vectors and hashes only and expire within five minutes.
 * The context builder still owns final eligibility, provenance and token budget.
 */
export class LocalMemoryRecall {
  readonly #cache = new Map<string, CacheEntry>();
  #generation = 0;
  #retryAfter = 0;
  #unavailable: MemoryRecallUnavailableReason | undefined;
  #running = false;
  constructor(private readonly embeddings: KnowledgeEmbeddings, private readonly now: () => number = Date.now) {}

  /** Call on profile teardown or a local embedding model/configuration change. */
  clear(): void { this.#generation++; this.#cache.clear(); this.#retryAfter = 0; this.#unavailable = undefined; }

  #get(key: string): readonly number[] | undefined {
    const value = this.#cache.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= this.now()) { this.#cache.delete(key); return undefined; }
    this.#cache.delete(key); this.#cache.set(key, value);
    return value.vector;
  }
  #put(key: string, vector: readonly number[]): void {
    this.#cache.delete(key);
    this.#cache.set(key, { vector, expiresAt: this.now() + MEMORY_RECALL_LIMITS.cacheLifetimeMs });
    while (this.#cache.size > MEMORY_RECALL_LIMITS.cacheEntries) this.#cache.delete(this.#cache.keys().next().value!);
  }

  /** Foreground path: never dispatch an embedding request. The shared Ollama
   * adapter intentionally retains its model slot for a dispatched batch even
   * after cancellation. Racing that promise would only hide a 100s admission
   * delay from chat, so use ready entries or the deterministic fallback. */
  retrieve(input: MemoryRecallInput): MemoryRecallHints {
    input.signal.throwIfAborted();
    const eligible = projectContextMemories(input.memories, input.sessionId, input.destination)
      .filter(memory => memoryRelevantForPublicLookup(memory, input.query));
    const query = this.#get('query:' + recallTextDigest(input.query));
    const base = { sessionId: input.sessionId, destination: input.destination, queryDigest: recallTextDigest(input.query), corpusDigest: memoryRecallCorpusDigest(eligible), eligibleCount: eligible.length };
    if (!query) return { ...base, mode: 'lexical', reason: !eligible.length ? 'empty' : 'unavailable', consideredCount: 0, matches: [] };
    let consideredCount = 0;
    const matches = eligible.flatMap(memory => {
      const digest = memoryRecallDigest(memory), vector = this.#get('document:' + memory.id + ':' + digest);
      if (!vector || vector.length !== query.length) return [];
      consideredCount++;
      const score = similarity(query, vector);
      return score >= MIN_MEMORY_SIMILARITY ? [{ id: memory.id, revision: memory.contextMetadata!.revision, digest, similarity: score }] : [];
    }).sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, MEMORY_RECALL_LIMITS.maxMatches);
    return { ...base, mode: consideredCount === eligible.length ? 'semantic' : 'partial', reason: consideredCount === eligible.length ? 'ready' : 'limit', consideredCount, matches };
  }

  /** Explicit preparation/background maintenance only, outside a foreground
   * chat request. The caller must coordinate idle admission with the same local
   * model pool; never launch this as an unawaited side effect of retrieve(). */
  async warm(input: MemoryRecallInput): Promise<MemoryRecallHints> {
    input.signal.throwIfAborted();
    const eligible = projectContextMemories(input.memories, input.sessionId, input.destination)
      .filter(memory => memoryRelevantForPublicLookup(memory, input.query));
    const result = (reason: MemoryRecallHints['reason'], matches: MemoryRecallHints['matches'] = [], consideredCount = 0): MemoryRecallHints => ({
      sessionId: input.sessionId, destination: input.destination, queryDigest: recallTextDigest(input.query), corpusDigest: memoryRecallCorpusDigest(eligible),
      mode: reason === 'ready' ? 'semantic' : reason === 'limit' ? 'partial' : 'lexical',
      reason, consideredCount, eligibleCount: eligible.length, matches,
      ...((reason === 'unavailable' || reason === 'backoff') && this.#unavailable ? { unavailableReason: this.#unavailable } : {}),
    });
    if (!input.query.trim() || input.query.length > MEMORY_RECALL_LIMITS.maxCharacters || !eligible.length) return result('empty');
    if (this.#running || this.now() < this.#retryAfter) return result('backoff');
    const generation = this.#generation;
    const current = (): void => {
      input.signal.throwIfAborted();
      if (generation !== this.#generation) throw new Error('memory.recallInvalidated');
    };
    // Bound expensive cold indexing. Known lexical hits go first, followed by
    // other current memories. The result exposes partial coverage, never claims
    // that an unembedded memory was searched semantically.
    const lexical = rankRelevantMemories(eligible, input.query), seen = new Set(lexical.map(memory => memory.id));
    const documents = [...lexical, ...eligible.filter(memory => !seen.has(memory.id))]
      .filter(memory => memory.text.trim() && memory.text.length <= MEMORY_RECALL_LIMITS.maxCharacters)
      .map(memory => ({ memory, key: 'document:' + memory.id + ':' + memoryRecallDigest(memory), text: 'search_document: ' + memory.text }));
    if (!documents.length) return result('empty');
    // Forget stale/deleted/other-scope vector entries. They can never enter a
    // result merely by remaining in this cache.
    const liveKeys = new Set(documents.map(document => document.key));
    for (const key of this.#cache.keys()) if (key.startsWith('document:') && !liveKeys.has(key)) this.#cache.delete(key);
    const queryKey = 'query:' + recallTextDigest(input.query);
    const pending = [
      ...(!this.#get(queryKey) ? [{ key: queryKey, text: 'search_query: ' + input.query }] : []),
      ...documents.filter(document => !this.#get(document.key)).slice(0, MEMORY_RECALL_LIMITS.maxCandidates).map(({ key, text }) => ({ key, text })),
    ];
    const staged = new Map<string, readonly number[]>();
    let dimensions = this.#get(queryKey)?.length;
    this.#running = true;
    try {
      for (let start = 0; start < pending.length; start += MEMORY_RECALL_LIMITS.batchSize) {
        current();
        const batch = pending.slice(start, start + MEMORY_RECALL_LIMITS.batchSize);
        const vectors = await this.embeddings.embed(batch.map(item => item.text), input.signal);
        current();
        if (vectors.length !== batch.length) throw new Error('memory.invalidEmbedding');
        const prepared = vectors.map(normalized);
        if (prepared.some(vector => vector === null) || prepared.some(vector => vector!.length !== prepared[0]!.length)) throw new Error('memory.invalidEmbedding');
        dimensions ??= prepared[0]!.length;
        if (prepared.some(vector => vector!.length !== dimensions)) throw new Error('memory.invalidEmbedding');
        for (let index = 0; index < batch.length; index++) staged.set(batch[index]!.key, prepared[index]!);
      }
      current();
      // Promote a whole completed preparation together. A cancelled operation
      // cannot silently leave its new query or a half-prepared index behind.
      for (const [key, vector] of staged) this.#put(key, vector);
      if (!this.#get(queryKey)) throw new Error('memory.invalidEmbedding');
      return this.retrieve(input);
    } catch (error) {
      input.signal.throwIfAborted();
      if (generation === this.#generation) { this.#retryAfter = this.now() + MEMORY_RECALL_LIMITS.failureBackoffMs; this.#unavailable = unavailableReason(error); }
      return result('unavailable');
    } finally { this.#running = false; }
  }
}
