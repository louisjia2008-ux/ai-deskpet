import type { ProviderConfig, ProviderRequestObservation, UsageEvent, UsagePriceSnapshot, UsageRate, UsageRateInput, UsageRateTarget, UsageSnapshot } from '../../shared';
import { usagePriceSnapshotSchema, usageRateInputSchema, usageRateSchema, usageRateTargetSchema } from '../../shared/automation-schemas';
import { normalizedProviderBaseUrl } from '../providers/request-budget';
import { selectUsageRate } from './usage-projection';
import type { ProviderDispatchHooks } from '../providers/provider-service';
import type { DomainRepository } from './repository';
import type { PersistentState } from './schemas';

type Prepared = Parameters<ProviderDispatchHooks['prepared']>[0];
export type UsagePriceResolver = (providerId: string, model: string, endpoint?: string) => UsagePriceSnapshot | undefined;
const order = { prepared: 0, 'fetch-invoked': 1, 'response-received': 2, terminal: 3 };
const recordedEndpoint = (provider?: ProviderConfig): string | undefined => {
  if (!provider) return undefined;
  try { return normalizedProviderBaseUrl(provider).toString(); } catch { return undefined; }
};
const rateTarget = (providerId: string, model: string, endpoint?: string): string => JSON.stringify([providerId, model, endpoint]);
/** Catalogs are disposable cache entries. They must never consume a manual
 * price's slot or make an otherwise valid model-list response fail to persist. */
const boundCatalogRates = (state: PersistentState): void => {
  if (state.usageRates.length <= 1000) return;
  const retained = state.usageRates.filter(rate => !('price' in rate) || rate.price.source !== 'provider-api');
  const current = new Set(state.providers.map(provider => rateTarget(provider.id, provider.model, recordedEndpoint(provider))));
  const used = new Set(state.usageEvents.map(event => rateTarget(event.providerId, event.model, event.endpoint)));
  for (const job of state.backgroundJobs) used.add(rateTarget(job.binding.provider.id, job.binding.model, recordedEndpoint(job.binding.provider)));
  const automatic = state.usageRates.filter((rate): rate is Extract<UsageRate, { price: UsagePriceSnapshot }> => 'price' in rate && rate.price.source === 'provider-api');
  const priority = (rate: typeof automatic[number]): number => {
    const exact = rateTarget(rate.providerId, rate.model, rate.price.endpoint), legacy = rateTarget(rate.providerId, rate.model);
    return current.has(exact) ? 0 : used.has(exact) || used.has(legacy) ? 1 : 2;
  };
  automatic.sort((left, right) => priority(left) - priority(right)
    || right.price.checkedAt.localeCompare(left.price.checkedAt) || right.updatedAt.localeCompare(left.updatedAt)
    || rateTarget(left.providerId, left.model, left.price.endpoint).localeCompare(rateTarget(right.providerId, right.model, right.price.endpoint)));
  // More than 1000 explicitly saved prices remains the existing validation
  // limit; never silently delete one to accommodate another manual mutation.
  state.usageRates = [...retained, ...automatic.slice(0, Math.max(0, 1000 - retained.length))];
};
/** One encrypted authoritative row per actual provider request identity, never per bubble/batch. */
export class UsageLedger {
  constructor(private readonly repository: DomainRepository, private readonly now: () => number = Date.now, private readonly resolvePrice?: UsagePriceResolver) {}
  #endpoint(state: PersistentState, providerId: string): string | undefined {
    return recordedEndpoint(state.providers.find(value => value.id === providerId));
  }
  #reference(providerId: string, model: string, endpoint?: string): UsagePriceSnapshot | undefined {
    try {
      const value = this.resolvePrice?.(providerId, model, endpoint);
      const parsed = usagePriceSnapshotSchema.safeParse(value);
      return parsed.success && (endpoint === undefined || parsed.data.endpoint === endpoint) ? parsed.data : undefined;
    } catch { return undefined; }
  }
  snapshot(): UsageSnapshot {
    // Catalog enrichment is a read-only view; no request or historical snapshot is rewritten.
    const state = this.repository.snapshot();
    const rates: UsageRate[] = structuredClone(state.usageRates);
    const targets = [...state.usageEvents.map(event => ({ providerId: event.providerId, model: event.model, endpoint: event.endpoint })),
      ...state.providers.map(provider => ({ providerId: provider.id, model: provider.model, endpoint: this.#endpoint(state, provider.id) }))];
    const visited = new Set<string>();
    for (const target of targets) {
      const key = JSON.stringify(target);
      if (visited.has(key)) continue;
      visited.add(key);
      const price = this.#reference(target.providerId, target.model, target.endpoint);
      if (price && !rates.some(rate => rate.providerId === target.providerId && rate.model === target.model && 'price' in rate && rate.price.endpoint === price.endpoint && rate.price.source === price.source))
        rates.push({ providerId: target.providerId, model: target.model, price, updatedAt: price.checkedAt });
    }
    return { events: state.usageEvents, rates };
  }
  async upsertRate(input: UsageRateInput): Promise<UsageSnapshot> {
    const parsed = usageRateInputSchema.parse(input);
    await this.repository.transaction(state => {
      const endpoint = this.#endpoint(state, parsed.providerId);
      if (!endpoint) throw new Error('provider.unavailable');
      const { providerId, model, ...values } = parsed;
      const updatedAt = new Date(this.now()).toISOString();
      const price = usagePriceSnapshotSchema.parse({ ...values, endpoint, source: 'manual', checkedAt: updatedAt });
      state.usageRates = state.usageRates.filter(rate => rate.providerId !== providerId || rate.model !== model || ('price' in rate && rate.price.source !== 'manual'));
      state.usageRates.push({ providerId, model, price, updatedAt });
      boundCatalogRates(state);
    });
    return this.snapshot();
  }
  async removeRate(input: UsageRateTarget): Promise<UsageSnapshot> {
    const target = usageRateTargetSchema.parse(input);
    await this.repository.transaction(state => {
      state.usageRates = state.usageRates.filter(rate => rate.providerId !== target.providerId || rate.model !== target.model || ('price' in rate && rate.price.source !== 'manual'));
    });
    return this.snapshot();
  }
  /** Cache only discovery prices from the still-current endpoint; never displace a manual edit. */
  async cacheRates(inputs: UsageRate[]): Promise<void> {
    const rates = inputs.map(input => usageRateSchema.parse(input));
    await this.repository.transaction(state => {
      const automatic = new Map(state.usageRates.flatMap(rate => 'price' in rate && rate.price.source === 'provider-api'
        ? [[rateTarget(rate.providerId, rate.model, rate.price.endpoint), rate] as const] : []));
      for (const rate of rates) {
        if (!('price' in rate) || rate.price.source !== 'provider-api' || rate.price.endpoint !== this.#endpoint(state, rate.providerId)) continue;
        const key = rateTarget(rate.providerId, rate.model, rate.price.endpoint);
        const old = automatic.get(key);
        if (old && old.updatedAt > rate.updatedAt) continue;
        automatic.set(key, rate);
      }
      state.usageRates = [...state.usageRates.filter(rate => !('price' in rate) || rate.price.source !== 'provider-api'), ...automatic.values()];
      boundCatalogRates(state);
    });
  }
  /** An authoritative discovery response may remove models or withdraw unsupported prices. */
  async replaceCatalog(providerId: string, endpoint: string, inputs: UsageRate[]): Promise<void> {
    usageRateTargetSchema.parse({ providerId, model: 'catalog' });
    const rates = inputs.map(input => usageRateSchema.parse(input));
    if (rates.some(rate => rate.providerId !== providerId || !('price' in rate) || rate.price.source !== 'provider-api' || rate.price.endpoint !== endpoint))
      throw new Error('provider.invalidUsageCatalog');
    await this.repository.transaction(state => {
      if (this.#endpoint(state, providerId) !== endpoint) return;
      const current = state.usageRates.filter(rate => rate.providerId === providerId && 'price' in rate && rate.price.source === 'provider-api' && rate.price.endpoint === endpoint);
      // A delayed older response must not replace a more recently accepted catalog.
      if (rates.length > 0 && current.some(old => old.updatedAt > rates.reduce((latest, rate) => rate.updatedAt > latest ? rate.updatedAt : latest, ''))) return;
      state.usageRates = state.usageRates.filter(rate => !(rate.providerId === providerId && 'price' in rate && rate.price.source === 'provider-api' && rate.price.endpoint === endpoint));
      // Both sources remain available; selectUsageRate gives manual edits precedence.
      // Removing a manual edit can therefore reveal the last cached API price immediately.
      state.usageRates.push(...rates);
      boundCatalogRates(state);
    });
  }
  #event(s: PersistentState, record: Prepared): UsageEvent {
    const job = s.backgroundJobs.find(value => value.attemptId === record.requestId);
    const trigger = job && s.automationTriggers.find(value => value.id === job.automaticTriggerId && value.id === job.operationId);
    const message = s.chatMessages.find(value => value.requestReceipts?.some(receipt => receipt.requestId === record.requestId));
    const endpoint = record.endpoint ?? this.#endpoint(s, record.providerId);
    const saved = selectUsageRate(s.usageRates, record.providerId, record.model, endpoint);
    const priceSnapshot = saved.price ?? this.#reference(record.providerId, record.model, endpoint) ?? null;
    return { requestId: record.requestId, ownerId: trigger?.id ?? job?.id ?? message?.id ?? record.requestId,
      scope: trigger?.kind ?? (job?.delegation ? 'delegation' : job?.consolidation ? 'consolidation' : job ? 'background-job' : message ? 'chat' : 'other'),
      batchId: job?.delegation?.batchId ?? job?.consolidation?.batchId ?? null, providerId: record.providerId, model: record.model,
      preparedAt: new Date(this.now()).toISOString(), dispatchedAt: null, terminalAt: null, phase: 'prepared', outcome: null,
      inputEstimate: record.inputEstimate, maxOutputTokens: record.maxOutputTokens, inputTokens: null, outputTokens: null, tokenSource: 'unknown', reportedCostUSD: null, endpoint, priceSnapshot,
      ...(priceSnapshot === null ? { pricingUnavailableReason: saved.reason ?? 'missing-rate' } : {}) };
  }
  async prepare(record: Prepared): Promise<void> {
    await this.repository.transaction((s) => {
      const old = s.usageEvents.find((v) => v.requestId === record.requestId);
      if (old) {
        if (old.providerId !== record.providerId || old.model !== record.model || old.inputEstimate !== record.inputEstimate || old.maxOutputTokens !== record.maxOutputTokens || (record.endpoint !== undefined && old.endpoint !== undefined && old.endpoint !== record.endpoint)) throw new Error('provider.usageIdentityConflict');
        if (old.dispatchedAt === null && old.phase === 'terminal') throw new Error('provider.requestRecordFailed');
        return;
      }
      s.usageEvents.push(this.#event(s, record));
    });
  }
  assertDispatch(requestId: string): void {
    const s = this.repository.snapshot(), row = s.usageEvents.find((v) => v.requestId === requestId);
    if (!row) throw new Error('provider.usageNotPrepared');
    if (row.dispatchedAt === null && row.phase === 'terminal') throw new Error('provider.requestRecordFailed');
  }
  /** Only the host's pre-adapter path can prove no dispatch was attempted.
   * Never turn an entered transport into an undispatched attempt when usage is unknown. */
  async releaseUndispatched(record: Prepared, outcome: 'failed' | 'aborted'): Promise<void> {
    await this.repository.transaction(state => {
      let row = state.usageEvents.find(event => event.requestId === record.requestId);
      if (!row) {
        // A preparation failure can precede the ledger row while chat already
        // has a receipt. Preserve the no-dispatch terminal state so restart
        // import cannot resurrect this attempt.
        row = this.#event(state, record); state.usageEvents.push(row);
      }
      if (row.providerId !== record.providerId || row.model !== record.model) throw new Error('provider.usageIdentityConflict');
      if (row.dispatchedAt !== null || row.phase !== 'prepared') return;
      row.phase = 'terminal'; row.outcome = outcome;
      row.terminalAt = new Date(this.now()).toISOString();
    });
  }
  async observe(observation: ProviderRequestObservation): Promise<void> {
    await this.repository.transaction((state) => {
      const row = state.usageEvents.find((v) => v.requestId === observation.requestId);
      if (!row) throw new Error('provider.usageNotPrepared');
      const time = new Date(this.now()).toISOString();
      // All phases after the fetch observation also prove that a dispatch occurred.
      row.dispatchedAt ??= time;
      if (order[observation.phase] >= order[row.phase]) row.phase = observation.phase;
      if (observation.usage.inputTokens !== null) row.inputTokens = observation.usage.inputTokens;
      if (observation.usage.outputTokens !== null) row.outputTokens = observation.usage.outputTokens;
      if (observation.usage.source === 'provider-reported') row.tokenSource = 'provider-reported';
      if (observation.usage.reportedCostUSD != null) row.reportedCostUSD = observation.usage.reportedCostUSD;
      if (observation.usage.tokenDetailsInvalid) row.tokenDetailsInvalid = true;
      if (observation.usage.source === 'provider-reported') {
        if (observation.usage.cachedInputTokens != null) row.cachedInputTokens = observation.usage.cachedInputTokens;
        if (observation.usage.cacheWriteInputTokens != null) row.cacheWriteInputTokens = observation.usage.cacheWriteInputTokens;
        if (observation.usage.reasoningOutputTokens != null) row.reasoningOutputTokens = observation.usage.reasoningOutputTokens;
      }
      if (observation.phase === 'terminal') { row.terminalAt ??= time; row.outcome ??= observation.outcome; }
    });
  }
  /** Backfill historical transport receipts without inventing request/cost observations. */
  async importReceipts(): Promise<void> {
    const initial = this.repository.snapshot();
    if (!initial.chatMessages.some((m) => m.requestReceipts?.some((r) => !initial.usageEvents.some((v) => v.requestId === r.requestId)))
      && !initial.backgroundJobs.some((j) => j.request && !initial.usageEvents.some((v) => v.requestId === j.request?.requestId))) return;
    await this.repository.transaction((s) => {
      const add = (input: UsageEvent): void => { if (!s.usageEvents.some((v) => v.requestId === input.requestId)) s.usageEvents.push(input); };
      for (const m of s.chatMessages) for (const r of m.requestReceipts ?? []) {
        const observations = r.observations, last = observations.at(-1), usage = mergeObservedUsage(observations);
        add({ requestId: r.requestId, ownerId: m.id, scope: 'chat', batchId: null, providerId: r.contextBinding?.providerId ?? '00000000-0000-4000-8000-000000000000', model: r.contextBinding?.model ?? 'unknown',
          preparedAt: r.preparedAt, dispatchedAt: observations[0]?.observedAt ?? null, terminalAt: last?.phase === 'terminal' ? last.observedAt : null, phase: r.phase, outcome: last?.outcome ?? null,
          inputEstimate: r.inputEstimate, maxOutputTokens: r.maxOutputTokens, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, tokenSource: usage.source, reportedCostUSD: usage.reportedCostUSD ?? null,
          cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens, tokenDetailsInvalid: usage.tokenDetailsInvalid });
      }
      for (const j of s.backgroundJobs) if (j.request) {
        const r = j.request, last = r.observations.at(-1), usage = mergeObservedUsage(r.observations);
        const trigger = s.automationTriggers.find((v) => v.id === j.automaticTriggerId && v.id === j.operationId);
        add({ requestId: r.requestId, ownerId: trigger?.id ?? j.id, scope: trigger?.kind ?? (j.delegation ? 'delegation' : j.consolidation ? 'consolidation' : 'background-job'), batchId: j.delegation?.batchId ?? j.consolidation?.batchId ?? null,
          providerId: j.binding.provider.id, model: j.binding.model, preparedAt: r.dispatchIntentAt, dispatchedAt: r.observations[0]?.observedAt ?? null, terminalAt: last?.phase === 'terminal' ? last.observedAt : null,
          phase: last?.phase ?? 'prepared', outcome: last?.outcome ?? null, inputEstimate: r.inputEstimate, maxOutputTokens: r.maxOutputTokens,
          inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, tokenSource: usage.source, reportedCostUSD: usage.reportedCostUSD ?? null,
          cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens, tokenDetailsInvalid: usage.tokenDetailsInvalid,
          endpoint: recordedEndpoint(j.binding.provider) });
      }
    });
  }
}

/** Preserve independently reported fields when a terminal observation omits earlier usage. */
const mergeObservedUsage = (observations: readonly ProviderRequestObservation[]): ProviderRequestObservation['usage'] => {
  const result: ProviderRequestObservation['usage'] = { inputTokens: null, outputTokens: null, source: 'unknown' };
  for (const { usage } of observations) {
    if (usage.reportedCostUSD != null) result.reportedCostUSD = usage.reportedCostUSD;
    if (usage.tokenDetailsInvalid) result.tokenDetailsInvalid = true;
    if (usage.source !== 'provider-reported') continue;
    result.source = 'provider-reported';
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const)
      if (usage[field] != null) result[field] = usage[field];
  }
  return result;
};
