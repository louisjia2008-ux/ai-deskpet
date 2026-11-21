import {
  modelBindingFailureSchema, type DefaultModelChange, type DefaultModelImpact, type ModelBindingDisplay,
  type ModelBindingIssue, type ModelChangeConsent,
} from '../../shared/model-bindings';
import type { ProviderConfig } from '../../shared/contracts';
import { providerFailureCode } from '../../shared/provider-errors';
import type { DomainRepository } from '../domain/repository';

export interface ModelBinding extends ModelBindingDisplay {
  providerId: string | null;
  model: string | null;
  /** Recheck the selected provider and model inside the feature's write boundary. */
  follow(expected: { providerId: string; model: string }): Promise<boolean>;
}

interface Dependencies {
  repository: DomainRepository;
  list: () => Promise<ModelBinding[]>;
  changed: () => void;
}

export class ModelBindingService {
  #providerChanges: Promise<unknown> = Promise.resolve();
  readonly #pendingFailures = new Map<string, Promise<void>>();

  constructor(private readonly deps: Dependencies) {}

  async migrate(): Promise<void> {
    const { repository } = this.deps;
    let pending = repository.read('modelFollowMigration');
    if (pending === true) return;
    const bindings = new Map((await this.deps.list()).map(binding => [binding.id, binding]));
    if (!pending) {
      const defaults = new Map(repository.read('providers').map(provider => [provider.id, provider.model]));
      pending = [...bindings.values()].flatMap(({ id, providerId, model }) =>
        providerId && model && defaults.get(providerId) === model ? [{ id, providerId, model }] : []);
      // Persist the first-startup candidates before touching separate channel stores.
      if (pending.length > 0) await repository.transaction(state => { state.modelFollowMigration = pending; });
    }
    const remaining: typeof pending = [];
    for (const selection of pending) {
      const binding = bindings.get(selection.id);
      if (binding?.providerId !== selection.providerId || binding.model !== selection.model) continue;
      try {
        if (!await binding.follow(selection)) remaining.push(selection);
      } catch {
        remaining.push(selection);
      }
    }
    await repository.transaction(state => { state.modelFollowMigration = remaining.length > 0 ? remaining : true; });
  }

  async impact(providerId: string): Promise<DefaultModelImpact | null> {
    const provider = this.#provider(providerId);
    if (!provider) return null;
    const bindings = (await this.deps.list()).filter(binding => binding.providerId === providerId);
    return {
      previousModel: provider.model,
      followers: bindings.filter(binding => binding.model === null).length,
      pinned: bindings.filter(binding => binding.model === provider.model).map(({ id, feature, label }) => ({ id, feature, label })),
    };
  }

  /** Serialize provider changes from the console, with an explicit revision for a confirmed change. */
  change(
    providerId: string,
    model: string,
    consent: ModelChangeConsent | undefined,
    save: () => Promise<ProviderConfig>,
  ): Promise<ProviderConfig & { modelChange?: DefaultModelChange }> {
    const run = this.#providerChanges.then(async () => {
      const previous = this.#provider(providerId)?.model;
      if (consent && consent.previousModel !== previous) throw new Error('provider.defaultModelChanged');
      const bindings = previous && previous !== model ? await this.deps.list() : [];
      const selected = new Set(consent?.followIds);
      const result = await save();
      if (!previous || result.model === previous) return result;
      let followers = bindings.filter(binding => binding.providerId === providerId && binding.model === null).length;
      let failed = 0;
      for (const binding of bindings) {
        if (binding.providerId !== providerId || binding.model !== previous || !selected.has(binding.id)) continue;
        try {
          if (await binding.follow({ providerId, model: previous })) followers++;
          else failed++;
        } catch { failed++; }
      }
      this.deps.changed();
      return { ...result, modelChange: { followers, failed } };
    });
    this.#providerChanges = run.catch(() => undefined);
    return run;
  }

  failed(id: string, providerId: string, model: string, error: unknown): void {
    if ((typeof error === 'string' ? error : providerFailureCode(error, 'provider.failed')) !== 'provider.modelUnavailable') return;
    const failure = modelBindingFailureSchema.safeParse({ id, providerId, model, at: new Date().toISOString() });
    if (!failure.success) return;
    const key = JSON.stringify([id, providerId, model]);
    const write = this.deps.repository.transaction(state => {
      const failures = (state.modelBindingFailures ?? []).filter(item => item.id !== id || item.providerId !== providerId || item.model !== model);
      state.modelBindingFailures = [...failures.slice(-199), failure.data];
    });
    this.#pendingFailures.set(key, write);
    const clear = (): void => { if (this.#pendingFailures.get(key) === write) this.#pendingFailures.delete(key); };
    void write.then(() => { clear(); this.deps.changed(); }, clear);
  }

  succeeded(id: string, providerId: string, model: string): void {
    // A failure write from an overlapping request may still be queued.
    const same = (item: { id: string; providerId: string; model: string }) =>
      item.id === id && item.providerId === providerId && item.model === model;
    try {
      if (!this.#pendingFailures.has(JSON.stringify([id, providerId, model]))
        && !this.deps.repository.read('modelBindingFailures')?.some(same)) return;
    } catch { return; }
    void this.deps.repository.transaction(state => {
      if (!state.modelBindingFailures) return false;
      const next = state.modelBindingFailures.filter(item => !same(item));
      if (next.length === state.modelBindingFailures.length) return false;
      state.modelBindingFailures = next;
      return true;
    }).then(removed => { if (removed) this.deps.changed(); }, () => undefined);
  }

  async issues(): Promise<ModelBindingIssue[]> {
    const failures = this.deps.repository.read('modelBindingFailures') ?? [];
    if (!failures.length) return [];
    const bindings = new Map((await this.deps.list()).map(binding => [binding.id, binding]));
    return failures.slice().reverse().flatMap(failure => {
      const binding = bindings.get(failure.id), provider = this.#provider(failure.providerId);
      if (!binding || !provider?.enabled || binding.providerId !== provider.id || (binding.model ?? provider.model) !== failure.model) return [];
      return [{
        ...failure, feature: binding.feature, label: binding.label, providerName: provider.name,
        code: binding.model === null ? 'provider.modelUnavailable' : 'provider.pinnedModelUnavailable',
        followModel: binding.model !== null && binding.model !== provider.model ? provider.model : null,
      }];
    });
  }

  async followIssue({ id, providerId, model }: { id: string; providerId: string; model: string }): Promise<void> {
    const issue = (await this.issues()).find(item => item.id === id && item.providerId === providerId && item.model === model);
    const binding = issue?.followModel && (await this.deps.list()).find(item => item.id === id);
    if (!binding || !await binding.follow({ providerId, model })) throw new Error('provider.defaultModelChanged');
    this.succeeded(id, providerId, model);
    this.deps.changed();
  }

  #provider(id: string): ProviderConfig | undefined {
    return this.deps.repository.read('providers').find(provider => provider.id === id);
  }
}
