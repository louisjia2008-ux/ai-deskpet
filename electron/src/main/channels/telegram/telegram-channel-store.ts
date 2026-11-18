import { defaultTelegramState, telegramStateSchema } from '../../../shared/telegram-channel';
import type { TelegramState } from '../../../shared/telegram-channel';
import { EncryptedJsonStore, type VaultKeyProvider } from '../../persistence/encrypted-json-store';

export class TelegramChannelStore {
  readonly #disk: EncryptedJsonStore<TelegramState>;
  #state: TelegramState | null = null;
  #queue = Promise.resolve();

  constructor(path: string, vault: VaultKeyProvider) {
    this.#disk = new EncryptedJsonStore({ path, vault, schema: telegramStateSchema, defaultValue: defaultTelegramState });
  }
  async initialize(): Promise<void> {
    this.#state = await this.#disk.load();
  }
  // Idle polling must not clone retained local replies (or the host profile) every second.
  get hasInboxWork(): boolean {
    return this.#state?.inbox.some((x) => x.status === 'queued') ?? false;
  }
  get hasOutboxWork(): boolean {
    const now = Date.now();
    return (
      this.#state?.outbox.some((x) => x.status === 'pending' && (x.retryAt ?? 0) <= now) === true ||
      this.#state?.approvals.some((a) => !!a.outboxId && a.expiresAt > 0 && a.expiresAt <= now) === true
    );
  }
  snapshot(): TelegramState {
    if (!this.#state) throw new Error('telegram.uninitialized');
    return structuredClone(this.#state);
  }
  update<T>(mutation: (draft: TelegramState) => T): Promise<T> {
    const work = this.#queue.then(async () => {
      const draft = this.snapshot();
      const result = mutation(draft);
      await this.#disk.save(draft);
      this.#state = draft;
      return result;
    });
    this.#queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}
