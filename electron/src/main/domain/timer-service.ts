import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatTimer } from '../../shared';
import type { DomainRepository } from './repository';
import { formatTimerDeadline } from '../../shared/timer-time';

export interface TimerCreationResult { timerId: string; label: string; seconds: number; dueAt: string; timeZone: string; localDueAt: string }

const inputSchema = z.object({ seconds: z.number().int().min(1).max(86_400), label: z.string().max(240) }).strict();

// Absolute deadlines survive process exits and sleep. The host checks on start
// and every second; only this serialized delivery path can complete a timer.
export class TimerService {
  #operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: DomainRepository, private readonly notify: (timer: ChatTimer) => Promise<void>, private readonly timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {}

  list(): ChatTimer[] { return this.repository.read('timers'); }

  async create(seconds: number, label: string, now = new Date(), assertAuthorized: () => void = () => undefined): Promise<TimerCreationResult> {
    inputSchema.parse({ seconds, label });
    const timer: ChatTimer = { id: randomUUID(), label, createdAt: now.toISOString(), dueAt: new Date(now.getTime() + seconds * 1_000).toISOString(), status: 'pending', completedAt: null };
    const timeZone = this.timeZone();
    const result = { timerId: timer.id, label, seconds, dueAt: timer.dueAt, timeZone, localDueAt: formatTimerDeadline(timer.dueAt, timeZone) };
    await this.repository.transaction((state) => { assertAuthorized(); state.timers.push(timer); });
    return result;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operations.then(operation, operation);
    this.#operations = next.catch(() => undefined);
    return next;
  }

  cancel(id: string): Promise<void> {
    return this.#serialize(() => this.repository.transaction((state) => {
      const timer = state.timers.find((item) => item.id === id);
      if (timer?.status === 'pending') timer.status = 'cancelled';
    }));
  }

  tick(now = new Date()): Promise<number> {
    return this.#serialize(async () => {
      let completed = 0;
      for (const timer of this.list().filter((item) => item.status === 'pending' && Date.parse(item.dueAt) <= now.getTime())) {
        // Persist after successful handoff; a failed notification stays pending.
        // OS delivery and a file commit cannot form one atomic transaction.
        await this.notify(timer);
        await this.repository.transaction((state) => {
          const current = state.timers.find((item) => item.id === timer.id);
          if (current?.status === 'pending') { current.status = 'completed'; current.completedAt = now.toISOString(); }
        });
        completed += 1;
      }
      return completed;
    });
  }
}
