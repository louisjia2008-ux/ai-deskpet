import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * The model the background memory tasks (reading conversations for lasting facts, the nightly tidy-up) use instead of
 * the chat model. It only applies to the provider it was chosen for, so a conversation is still read only by the
 * provider that answered it. Kept in its own file: older builds never see it, and a missing or unreadable file means
 * "same as chat".
 */
export interface BackgroundMemoryModel { providerId: string; model: string }

const fileSchema = z.object({
  version: z.literal(1),
  providerId: z.string().uuid(),
  model: z.string().trim().min(1).max(200).regex(/^[^\p{Cc}]+$/u),
}).strict();

export class BackgroundMemoryModelStore {
  #value: BackgroundMemoryModel | null = null;

  constructor(private readonly path: string) {
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      this.#value = { providerId: parsed.providerId, model: parsed.model };
    } catch { this.#value = null; }
  }

  get(): BackgroundMemoryModel | null { return this.#value ? { ...this.#value } : null; }

  /** The model to use for this provider, or undefined to keep the chat model. */
  modelFor(providerId: string): string | undefined {
    return this.#value?.providerId === providerId ? this.#value.model : undefined;
  }

  set(value: BackgroundMemoryModel | null): BackgroundMemoryModel | null {
    if (value === null) {
      this.#write(null);
      this.#value = null;
      return null;
    }
    const parsed = fileSchema.parse({ version: 1, providerId: value.providerId, model: value.model.trim() });
    this.#write(parsed);
    this.#value = { providerId: parsed.providerId, model: parsed.model };
    return this.get();
  }

  #write(value: z.infer<typeof fileSchema> | null): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, value === null ? '{}\n' : `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
