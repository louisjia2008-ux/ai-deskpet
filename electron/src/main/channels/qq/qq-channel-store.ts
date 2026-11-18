import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../../persistence/encrypted-json-store';
import { qqChannelStateSchema } from '../../../shared/qq-channel';
import type { QqChannelState } from '../../../shared/qq-channel';
import { defaultQqChannelState } from '../../../shared/qq-channel';

/** Encrypted state and a separate key; neither belongs in PROFILE_ROOTS. */
export class QqChannelStore {
  readonly #store: EncryptedJsonStore<QqChannelState>;
  #state: QqChannelState | null = null;
  #uncertain = false;
  #queue: Promise<QqChannelState> = Promise.resolve(defaultQqChannelState());

  constructor(path: string, vault: VaultKeyProvider) {
    this.#store = new EncryptedJsonStore({ path, vault, schema: qqChannelStateSchema, defaultValue: defaultQqChannelState });
  }

  async initialize(): Promise<QqChannelState> {
    this.#state = await this.#store.load();
    this.#uncertain = false;
    this.#queue = Promise.resolve(this.#state);
    return this.snapshot();
  }

  snapshot(): QqChannelState {
    if (this.#state === null) throw new Error('qq.storeUninitialized');
    return structuredClone(this.#state);
  }

  get privateCareGranted(): boolean {
    return !!this.#state?.binding?.privateCareGrant && this.#state.binding.privateCareGrant.authorityId === this.#state.authorityId;
  }

  hasDueReminder(at: number): boolean {
    return this.#state?.outbox.some(item=>item.status==='pending' && item.reminderDueAt !== undefined && Date.parse(item.reminderDueAt)<=at) ?? false;
  }

  /** Mutations are serialized and re-validated; the stored shape is authority. */
  update<T>(mutation: (draft: QqChannelState) => T): Promise<T> {
    const write = async (): Promise<T> => {
      if (this.#state === null) throw new Error('qq.storeUninitialized');
      // A failed acknowledgement can follow the atomic rename. Recover that
      // accepted queue item/dedup receipt before applying another mutation.
      if (this.#uncertain) {
        const persisted = await this.#store.readPersisted();
        if (persisted !== null) this.#state = persisted;
        this.#uncertain = false;
      }
      const draft = structuredClone(this.#state);
      const result = mutation(draft);
      const next = qqChannelStateSchema.parse(draft);
      try { await this.#store.save(next); }
      catch (error) { this.#uncertain = true; throw error; }
      this.#state = next;
      return result;
    };
    const queued = this.#queue.then(write, write);
    this.#queue = queued.then(() => this.snapshot(), () => this.snapshot());
    return queued;
  }
}
