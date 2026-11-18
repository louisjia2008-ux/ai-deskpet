import { memoryRecallInputs } from '../../shared/memory-recall';
import type { MemoryRecallSearchInput, MemoryRecallSearchResult } from '../../shared/memory-recall';
import { recallTextDigest } from './memory-retrieval';
import { memoryRecallSearchResult } from './memory-semantic-recall';
import type { LocalMemoryRecall, MemoryRecallInput } from './memory-semantic-recall';
import type { DomainRepository } from './repository';

export const MEMORY_RECALL_OPERATION_LIMIT = 4;
interface RecallOperation {
  digest: string;
  controller: AbortController;
  promise: Promise<MemoryRecallSearchResult>;
}

/** Desktop-only host boundary for explicit, local memory preparation. Retained
 * operations contain no result cache: every completed retry reads current
 * authority again, including deletion suppression and the current profile. */
export class MemoryRecallService {
  readonly #operations = new Map<string, RecallOperation>();
  #generation = 0;
  #stopped = false;
  constructor(
    private readonly repository: DomainRepository,
    private readonly recall: LocalMemoryRecall,
    private readonly available: () => boolean = () => true,
  ) {}

  /** Remains true while a cancelled embedding batch still owns its model slot. */
  get active(): boolean { return this.#operations.size > 0; }

  #snapshot(input: MemoryRecallSearchInput, signal: AbortSignal, profileId?: string): { profileId: string; input: MemoryRecallInput } {
    signal.throwIfAborted();
    if (this.#stopped || !this.available()) throw new Error('memory.recallUnavailable');
    const state = this.repository.snapshot();
    if (profileId !== undefined && state.profileId !== profileId) throw new Error('memory.recallInvalidated');
    const session = state.chatSessions.find(item => item.id === input.sessionId);
    if (!session || session.deletedAt || session.archivedAt || session.channelBindingId || session.analysisSource) {
      throw new Error('chat.sessionUnavailable');
    }
    return { profileId: state.profileId, input: {
      sessionId: input.sessionId, destination: 'local', query: input.query,
      memories: state.memories.filter(memory => !this.repository.isMemoryRecallSuppressed(memory.id)), signal,
    } };
  }

  search(raw: MemoryRecallSearchInput): Promise<MemoryRecallSearchResult> {
    try {
      const parsed = memoryRecallInputs['memory-recall:search'].safeParse(raw);
      if (!parsed.success) throw new Error('memory.recallInvalidInput');
      const input = parsed.data, controller = new AbortController();
      const initial = this.#snapshot(input, controller.signal);
      const digest = recallTextDigest(JSON.stringify([initial.profileId, input.sessionId, input.query]));
      const previous = this.#operations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) throw new Error('memory.recallOperationConflict');
        return previous.promise;
      }
      if (this.#operations.size >= MEMORY_RECALL_OPERATION_LIMIT) throw new Error('memory.recallBusy');
      const generation = this.#generation;
      const promise = this.#run(input, initial, generation).finally(() => this.#operations.delete(input.operationId));
      this.#operations.set(input.operationId, { digest, controller, promise });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  async #run(input: MemoryRecallSearchInput, initial: { profileId: string; input: MemoryRecallInput }, generation: number): Promise<MemoryRecallSearchResult> {
    const hints = await this.recall.warm(initial.input);
    initial.input.signal.throwIfAborted();
    if (generation !== this.#generation) throw new Error('memory.recallInvalidated');
    // Never publish text copied before an async model request. Changed scopes,
    // revisions, expiry, suppression and deletion are projected anew here.
    const current = this.#snapshot(input, initial.input.signal, initial.profileId);
    return memoryRecallSearchResult(current.input, hints);
  }

  async cancel(raw: { operationId: string }): Promise<void> {
    const parsed = memoryRecallInputs['memory-recall:cancel'].safeParse(raw);
    if (!parsed.success) throw new Error('memory.recallInvalidInput');
    this.#operations.get(parsed.data.operationId)?.controller.abort(new Error('memory.recall.cancelled'));
  }

  /** Invalidate on profile/model changes; abort prevents a late vector commit. */
  invalidate(): void {
    this.#generation++;
    for (const operation of this.#operations.values()) operation.controller.abort(new Error('memory.recall.cancelled'));
    this.recall.clear();
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.invalidate();
    // The embedding adapter intentionally holds its local model slot until a
    // dispatched request finishes. Do not detach it or pretend teardown ended.
    await Promise.allSettled([...this.#operations.values()].map(operation => operation.promise));
    this.recall.clear();
  }
}
