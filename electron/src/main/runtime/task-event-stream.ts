import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { TaskRunEvent, TaskRunStatus } from '../../shared';
import { JsonlEventStore } from '../persistence';

const taskRunEventSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    type: z.enum(['state', 'model', 'tool', 'approval', 'effect', 'error']),
    status: z.enum(['queued', 'running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled', 'missed']),
    summary: z.string().max(4_096),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export class TaskEventStream {
  readonly #store: JsonlEventStore<TaskRunEvent>;
  readonly #sequences = new Map<string, number>();

  constructor(path: string) {
    this.#store = new JsonlEventStore(path, taskRunEventSchema);
  }

  async initialize(): Promise<void> {
    for (const event of await this.#store.readAll()) {
      this.#sequences.set(event.runId, Math.max(this.#sequences.get(event.runId) ?? 0, event.sequence));
    }
    if (this.#store.recovery !== null) {
      await this.emit(randomUUID(), 'error', 'failed', 'An interrupted event log was repaired. Its valid prefix and original file were preserved.', { retainedEvents: this.#store.recovery.retained });
    }
  }

  async emit(
    runId: string,
    type: TaskRunEvent['type'],
    status: TaskRunStatus,
    summary: string,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): Promise<TaskRunEvent> {
    const sequence = (this.#sequences.get(runId) ?? 0) + 1;
    const event: TaskRunEvent = {
      id: randomUUID(),
      runId,
      sequence,
      createdAt: now.toISOString(),
      type,
      status,
      summary,
      metadata,
    };
    await this.#store.append(event);
    this.#sequences.set(runId, sequence);
    return event;
  }

  readAll(): Promise<TaskRunEvent[]> {
    return this.#store.readAll();
  }

  /** UI reads are bounded and happen only when the activity page is opened.
   * Keep the store's validated-prefix/quarantine behavior for every disk read. */
  async readPage({ limit = 100, beforeId }: { limit?: number | undefined; beforeId?: string | undefined } = {}): Promise<TaskRunEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('events.invalidPage');
    const events = await this.#store.readAll();
    const end = beforeId === undefined ? events.length : events.findIndex(event => event.id === beforeId);
    if (end < 0) return [];
    return events.slice(Math.max(0, end - limit), end);
  }
}
