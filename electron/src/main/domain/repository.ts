import { syncConsolidations } from './consolidation-state';
import { isDeepStrictEqual } from 'node:util';
import { EncryptedJsonStore } from '../persistence';
import type { VaultKeyProvider } from '../persistence';
import { EncryptedStoreWriteError } from '../persistence/encrypted-json-store';
import { createDefaultState, persistentStateSchema } from './schemas';
import type { PersistentState } from './schemas';

export class DomainRepository {
  readonly #store: EncryptedJsonStore<PersistentState>;
  #state: PersistentState | null = null;
  #mutationQueue: Promise<void> = Promise.resolve();
  #commitUncertain = false;
  readonly #suppressedMemoryRecall = new Set<string>();

  constructor(path: string, vault: VaultKeyProvider) {
    this.#store = new EncryptedJsonStore({ path, schema: persistentStateSchema, defaultValue: createDefaultState, vault });
  }

  async initialize(): Promise<void> {
    if (this.#state === null) {
      const loaded = await this.#store.load();
      const beforeConsolidations = JSON.stringify(loaded); syncConsolidations(loaded);
      if (beforeConsolidations !== JSON.stringify(loaded)) await this.#store.save(loaded);
      if (loaded.chatMessages.some((message) => message.status === 'streaming')) {
        for (const message of loaded.chatMessages) {
          if (message.status === 'streaming') { message.status = 'failed'; message.errorCode = 'chat.interrupted'; }
        }
        await this.#store.save(loaded);
      }
      // Publish recovery only after its durable write, just like ordinary transactions.
      this.#state = loaded;
    }
  }

  #current(): PersistentState {
    if (this.#commitUncertain) throw new Error('repository.commitUncertain');
    if (this.#state === null) {
      throw new Error('DomainRepository must be initialized before use.');
    }
    return this.#state;
  }

  snapshot(): PersistentState { return structuredClone(this.#current()); }

  /** Clone only the requested collection/value, never expose mutable authority. */
  read<K extends keyof PersistentState>(key: K): PersistentState[K] { return structuredClone(this.#current()[key]); }

  async flush(): Promise<void> { await this.#mutationQueue; }

  /** Re-enter through authenticated authority before a UI read or retry. */
  async recoverAuthority(): Promise<void> {
    const recover = async (): Promise<void> => {
      if (!this.#commitUncertain) return;
      let persisted: PersistentState | null;
      try { persisted = await this.#store.readPersisted(); }
      catch (cause) { throw new Error('repository.commitUncertain', { cause }); }
      if (persisted === null) throw new Error('repository.commitUncertain');
      this.#state = persisted; this.#commitUncertain = false;
    };
    this.#mutationQueue = this.#mutationQueue.then(recover, recover);
    await this.#mutationQueue;
  }

  /** Process-local privacy boundary after a requested deletion cannot be confirmed. */
  suppressMemoryRecall(ids: readonly string[]): void { for (const id of ids) this.#suppressedMemoryRecall.add(id); }
  clearMemoryRecallSuppression(ids: readonly string[]): void { for (const id of ids) this.#suppressedMemoryRecall.delete(id); }
  isMemoryRecallSuppressed(id: string): boolean { return this.#suppressedMemoryRecall.has(id); }
  memoryRecallSuppressionIds(): ReadonlySet<string> { return new Set(this.#suppressedMemoryRecall); }

  async transaction<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    let resolveResult: ((value: T) => void) | undefined;
    let rejectResult: ((reason: unknown) => void) | undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const execute = async (): Promise<void> => {
      try {
        if (this.#commitUncertain) {
          let recovered: PersistentState | null;
          try { recovered = await this.#store.readPersisted(); }
          catch (cause) { throw new Error('repository.commitUncertain', { cause }); }
          if (recovered === null) throw new Error('repository.commitUncertain');
          this.#state = recovered;
          this.#commitUncertain = false;
        }
        const current = this.snapshot();
        const output = await mutation(current);
        syncConsolidations(current);
        if (this.#store.hasPersistedValue && isDeepStrictEqual(current, this.#state)) { resolveResult?.(output); return; }
        const validated = persistentStateSchema.parse(current);
        try { await this.#store.save(validated); }
        catch (writeError) {
          if (!(writeError instanceof EncryptedStoreWriteError)) throw writeError;
          // The file rename may have committed even when acknowledgement failed.
          // Resolve only from authenticated disk state, never from the draft.
          let persisted: PersistentState | null;
          try { persisted = await this.#store.readPersisted(); }
          catch {
            this.#commitUncertain = true;
            throw new Error('repository.commitUncertain', { cause: writeError });
          }
          if (persisted === null) {
            this.#commitUncertain = true;
            throw new Error('repository.commitUncertain', { cause: writeError });
          }
          if (JSON.stringify(persisted) !== JSON.stringify(validated)) {
            this.#state = persisted;
            throw writeError;
          }
        }
        this.#state = validated;
        resolveResult?.(output);
      } catch (error) {
        rejectResult?.(error);
      }
    };
    this.#mutationQueue = this.#mutationQueue.then(execute, execute);
    await this.#mutationQueue;
    return result;
  }
}
