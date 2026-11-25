import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { backgroundModelIdSchema } from '../shared/auto-memory';
import type { ProviderConfig } from '../shared';
import { providerEndpointIdentity } from './providers/request-budget';

/**
 * The model the background memory tasks (reading conversations for lasting facts, the nightly tidy-up) use instead of
 * the chat model. It applies only to the provider entry it was chosen for, and only while that entry still points at
 * the same service, so a conversation is still read only by the service that answered it. Kept in its own file: older
 * builds never see it, and a missing or unreadable file means "same as chat".
 */
export interface BackgroundMemoryModel { providerId: string; model: string }

const fileSchema = z.object({
  version: z.literal(1),
  providerId: z.string().uuid(),
  endpoint: z.string().min(1).max(2_000),
  model: backgroundModelIdSchema,
}).strict();

const endpointOf = (provider: ProviderConfig): string | null => { try { return providerEndpointIdentity(provider); } catch { return null; } };

export class BackgroundMemoryModelStore {
  #value: z.infer<typeof fileSchema> | null = null;

  constructor(private readonly path: string) {
    try { this.#value = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { this.#value = null; }
  }

  get(): BackgroundMemoryModel | null { return this.#value ? { providerId: this.#value.providerId, model: this.#value.model } : null; }

  /** The model to use with this provider, or undefined to keep the chat model. */
  modelFor(provider: ProviderConfig): string | undefined {
    const value = this.#value;
    return value && value.providerId === provider.id && endpointOf(provider) === value.endpoint ? value.model : undefined;
  }

  set(provider: ProviderConfig, model: string): BackgroundMemoryModel | null;
  set(provider: null): null;
  set(provider: ProviderConfig | null, model?: string): BackgroundMemoryModel | null {
    if (provider === null) {
      this.#write(null);
      this.#value = null;
      return null;
    }
    const endpoint = endpointOf(provider);
    if (endpoint === null) throw new Error('provider.invalidEndpoint');
    const parsed = fileSchema.parse({ version: 1, providerId: provider.id, endpoint, model });
    this.#write(parsed);
    this.#value = parsed;
    return this.get();
  }

  #write(value: z.infer<typeof fileSchema> | null): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, value === null ? '{}\n' : `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
