import { createHash } from 'node:crypto';
import type { DomainRepository, SideEffectRecord } from '../domain';
import { ToolFailure } from './tool-failure';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;

export class EffectLedger {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly repository: DomainRepository) {}

  async execute(key: string, runId: string, toolId: string, input: unknown, operation: () => Promise<unknown>, scope?: string): Promise<unknown> {
    const normalized = canonical(input);
    const inputHash = createHash('sha256').update(JSON.stringify(scope === undefined ? normalized : { input: normalized, scope })).digest('hex');
    const pending = this.#pending.get(key) ?? Promise.resolve();
    const next = pending.catch(() => undefined).then(async () => {
      const existing = this.find(key);
      if (existing !== null) {
        if (existing.toolId !== toolId || existing.inputHash !== inputHash) throw new ToolFailure('tool.effectConflict');
        return existing.output;
      }
      const output = await operation();
      await this.record({ key, runId, toolId, inputHash, completedAt: new Date().toISOString(), output });
      return output;
    });
    this.#pending.set(key, next);
    try { return await next; }
    finally { if (this.#pending.get(key) === next) this.#pending.delete(key); }
  }

  find(key: string): SideEffectRecord | null {
    return this.repository.snapshot().sideEffects.find((item) => item.key === key) ?? null;
  }

  async record(record: SideEffectRecord): Promise<SideEffectRecord> {
    return this.repository.transaction((state) => {
      const existing = state.sideEffects.find((item) => item.key === record.key);
      if (existing !== undefined) {
        return structuredClone(existing);
      }
      state.sideEffects.push(record);
      return record;
    });
  }
}
