import { z } from 'zod';

import { localDay } from '../../shared/character';
import { AtomicJsonStore } from '../persistence';

export type MinecraftModelReason = 'player_chat' | 'task_completed' | 'death' | 'task_failure' | 'stuck';
export type MinecraftModelPresence = 'online' | 'offline' | 'unavailable';

interface ModelContext {
  presence: MinecraftModelPresence;
  reason: MinecraftModelReason;
  limit: number;
}

const usageSchema = z.object({ day: z.union([z.iso.date(), z.literal('')]), count: z.number().int().nonnegative() }).strict();
type Usage = z.infer<typeof usageSchema>;
type Reservation = { day: string } | null;

export class MinecraftOfflineModelBudget {
  readonly #store: AtomicJsonStore<Usage>;
  #usage: Usage | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.#store = new AtomicJsonStore({ path, schemaVersion: 1, schema: usageSchema, defaultValue: () => ({ day: '', count: 0 }) });
  }

  async initialize(): Promise<void> { this.#usage = await this.#store.load(); }

  #day(): string { return localDay(this.now(), Intl.DateTimeFormat().resolvedOptions().timeZone); }

  used(): number { return this.#usage?.day === this.#day() ? this.#usage.count : 0; }

  denial({ presence, reason, limit }: ModelContext): string | null {
    if (presence === 'online') return null;
    if (presence === 'unavailable') return 'world_unavailable';
    if (reason !== 'death' && reason !== 'task_failure' && reason !== 'stuck') return 'owner_offline';
    if (this.#usage === null) return 'quota_unavailable';
    return this.used() >= limit ? 'daily_limit' : null;
  }

  /** The callback reads presence and settings after waiting for other reservations. */
  reserve(current: () => ModelContext): Promise<Reservation> {
    const operation = this.#queue.then(async (): Promise<Reservation> => {
      const context = current();
      const denied = this.denial(context);
      if (denied) throw new Error(`minecraft.model.${denied}`);
      if (context.presence === 'online') return null;
      const next = { day: this.#day(), count: this.used() + 1 };
      try { await this.#store.save(next); }
      catch { this.#usage = null; throw new Error('minecraft.model.quota_unavailable'); }
      this.#usage = next;
      return { day: next.day };
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  assertReserved(reservation: Reservation, { presence, limit }: ModelContext): void {
    if (presence === 'unavailable') throw new Error('minecraft.model.world_unavailable');
    if (presence === 'offline' && reservation?.day !== this.#day()) throw new Error('minecraft.model.presence_changed');
    if (presence === 'offline' && this.used() > limit) throw new Error('minecraft.model.daily_limit');
  }
}
