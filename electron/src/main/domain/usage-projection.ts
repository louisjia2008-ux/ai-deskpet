import type { UsageCurrency, UsageEvent, UsagePriceSnapshot, UsageRate, UsageScope, UsageSnapshot } from '../../shared/automation';
import { usagePriceSnapshotSchema } from '../../shared/automation-schemas';

export type UsageCostReason = 'reported' | 'request-rate' | 'current-reference' | 'not-dispatched' | 'identity-conflict' | 'missing-usage'
  | 'missing-input-usage' | 'missing-output-usage' | 'missing-rate' | 'missing-rate-at-request' | 'endpoint-mismatch'
  | 'invalid-cache-usage' | 'missing-cache-rate' | 'invalid-rate';
export interface ProjectedUsageRequest {
  event: UsageEvent;
  dispatched: boolean;
  identityConflict: boolean;
  input: { value: number | null; source: 'provider-reported' | 'estimated' | 'unknown' };
  output: { value: number | null; source: 'provider-reported' | 'unknown' };
  cost: { amount: number | null; currency: UsageCurrency | null; usd: number | null; source: 'provider-reported' | 'estimated' | 'unknown'; reason: UsageCostReason;
    basis: 'reported' | 'request-snapshot' | 'current-reference' | null; rate?: UsagePriceSnapshot | undefined; cacheBreakdown: 'unknown' | 'reported' };
}
export interface UsageTotals {
  preparedRequests: number;
  dispatchedRequests: number;
  notDispatchedRequests: number;
  reportedTokens: number | null;
  peakReportedTokens: number | null;
  completeReportedRequests: number;
  incompleteReportedRequests: number;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  estimatedInputTokens: number | null;
  reportedInputRequests: number;
  reportedOutputRequests: number;
  estimatedInputRequests: number;
  unknownInputRequests: number;
  unknownOutputRequests: number;
  reportedUSD: number | null;
  estimatedUSD: number | null;
  reportedByCurrency: Partial<Record<UsageCurrency, number | null>>;
  estimatedByCurrency: Partial<Record<UsageCurrency, number | null>>;
  reportedCostRequestsByCurrency: Partial<Record<UsageCurrency, number>>;
  estimatedCostRequestsByCurrency: Partial<Record<UsageCurrency, number>>;
  reportedCostRequests: number;
  estimatedCostRequests: number;
  unknownCostRequests: number;
  identityConflicts: number;
}
export interface UsageGroup { id: string; requests: ProjectedUsageRequest[]; totals: UsageTotals }
export interface UsageProjection {
  requests: ProjectedUsageRequest[];
  summary: UsageTotals;
  byScope: UsageGroup[];
  byModel: UsageGroup[];
  batches: UsageGroup[];
}

const phases: Record<UsageEvent['phase'], number> = { prepared: 0, 'fetch-invoked': 1, 'response-received': 2, terminal: 3 };
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokenCount = (value: unknown): value is number => finiteNonnegative(value) && Number.isSafeInteger(value);
const at = (event: UsageEvent): number => {
  const value = Date.parse(event.terminalAt ?? event.dispatchedAt ?? event.preparedAt);
  return Number.isFinite(value) ? value : 0;
};
const precedence = (left: UsageEvent, right: UsageEvent): number => phases[left.phase] - phases[right.phase] || at(left) - at(right);
const pair = (providerId: string, model: string): string => JSON.stringify([providerId, model]);

/** Fold host lifecycle observations, never bubbles, batch parents or reasoning subtotals. */
const deduplicate = (events: readonly UsageEvent[]): Array<{ event: UsageEvent; conflict: boolean }> => {
  const grouped = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.requestId) ?? [];
    group.push(event); grouped.set(event.requestId, group);
  }
  return [...grouped.values()].map((group): { event: UsageEvent; conflict: boolean } => {
    const ordered = group.slice().sort(precedence);
    const final = ordered.at(-1)!;
    const endpoints = new Set(group.flatMap((event) => event.endpoint === undefined ? [] : [event.endpoint]));
    const conflict = endpoints.size > 1 || group.some((event) => event.providerId !== final.providerId || event.model !== final.model);
    const knownInput = ordered.filter((event) => event.tokenSource === 'provider-reported' && tokenCount(event.inputTokens)).at(-1);
    const knownOutput = ordered.filter((event) => event.tokenSource === 'provider-reported' && tokenCount(event.outputTokens)).at(-1);
    const knownCost = ordered.filter((event) => finiteNonnegative(event.reportedCostUSD)).at(-1);
    const detail = (field: 'cachedInputTokens' | 'cacheWriteInputTokens' | 'reasoningOutputTokens'): number | null | undefined =>
      ordered.filter((event) => event.tokenSource === 'provider-reported' && event[field] != null).at(-1)?.[field];
    const dispatch = ordered.find((event) => event.dispatchedAt !== null)?.dispatchedAt ?? null;
    const terminal = ordered.slice().reverse().find((event) => event.terminalAt !== null)?.terminalAt ?? null;
    // A later lifecycle record may omit price fields, but cannot revise the captured request price.
    const priceRecord = ordered.find((event) => event.priceSnapshot !== undefined);
    return { conflict, event: { ...final, dispatchedAt: dispatch, terminalAt: terminal,
      endpoint: ordered.find((event) => event.endpoint !== undefined)?.endpoint,
      priceSnapshot: priceRecord?.priceSnapshot,
      pricingUnavailableReason: priceRecord?.pricingUnavailableReason ?? final.pricingUnavailableReason,
      inputTokens: knownInput?.inputTokens ?? null, outputTokens: knownOutput?.outputTokens ?? null,
      cachedInputTokens: detail('cachedInputTokens'), cacheWriteInputTokens: detail('cacheWriteInputTokens'), reasoningOutputTokens: detail('reasoningOutputTokens'),
      ...(group.some(event => event.tokenDetailsInvalid) ? { tokenDetailsInvalid: true } : {}),
      tokenSource: knownInput !== undefined || knownOutput !== undefined ? 'provider-reported' : 'unknown',
      reportedCostUSD: knownCost?.reportedCostUSD ?? null } };
  }).sort((left, right) => at(right.event) - at(left.event) || left.event.requestId.localeCompare(right.event.requestId));
};

/** Legacy rates have no recorded endpoint; only legacy requests may use them as a labelled reference. */
export const priceFromUsageRate = (rate: UsageRate): UsagePriceSnapshot | undefined => {
  const price: UsagePriceSnapshot = 'price' in rate ? rate.price : { currency: 'USD', inputPerMillion: rate.inputUSDPerMillion,
    outputPerMillion: rate.outputUSDPerMillion, source: 'manual', checkedAt: rate.updatedAt, endpoint: 'legacy:unrecorded', note: 'Legacy manual rate; endpoint was not recorded.' };
  const parsed = usagePriceSnapshotSchema.safeParse(price);
  return parsed.success ? parsed.data : undefined;
};
const sourcePriority = { reference: 0, 'provider-api': 1, manual: 2 };
export const selectUsageRate = (rates: readonly UsageRate[], providerId: string, model: string, endpoint?: string): { price?: UsagePriceSnapshot; reason?: 'missing-rate' | 'endpoint-mismatch' | 'invalid-rate' } => {
  const matching = rates.filter((rate) => rate.providerId === providerId && rate.model === model);
  const parsed = matching.map((rate) => ({ rate, price: priceFromUsageRate(rate) }));
  const scoped = parsed.filter((item): item is { rate: UsageRate; price: UsagePriceSnapshot } => item.price !== undefined && (endpoint === undefined || item.price.endpoint === endpoint));
  const selected = scoped.sort((a, b) => sourcePriority[b.price.source] - sourcePriority[a.price.source] || b.rate.updatedAt.localeCompare(a.rate.updatedAt))[0];
  if (selected) return { price: selected.price };
  return { reason: matching.length === 0 ? 'missing-rate' : parsed.every((item) => item.price === undefined) ? 'invalid-rate' : 'endpoint-mismatch' };
};

const projectRequest = (record: { event: UsageEvent; conflict: boolean }, rates: readonly UsageRate[]): ProjectedUsageRequest => {
  const { event, conflict: identityConflict } = record;
  const dispatched = event.dispatchedAt !== null;
  const input: ProjectedUsageRequest['input'] = identityConflict ? { value: null, source: 'unknown' }
    : event.tokenSource === 'provider-reported' && tokenCount(event.inputTokens) ? { value: event.inputTokens, source: 'provider-reported' }
      : tokenCount(event.inputEstimate) ? { value: event.inputEstimate, source: 'estimated' } : { value: null, source: 'unknown' };
  const output: ProjectedUsageRequest['output'] = !identityConflict && event.tokenSource === 'provider-reported' && tokenCount(event.outputTokens)
    ? { value: event.outputTokens, source: 'provider-reported' } : { value: null, source: 'unknown' };
  const cacheBreakdown = event.cachedInputTokens != null || event.cacheWriteInputTokens != null ? 'reported' : 'unknown';
  const unknown = (reason: UsageCostReason, rate?: UsagePriceSnapshot): ProjectedUsageRequest['cost'] => ({ amount: null, currency: rate?.currency ?? null, usd: null,
    source: 'unknown', reason, basis: null, cacheBreakdown, ...(rate === undefined ? {} : { rate }) });
  let cost: ProjectedUsageRequest['cost'];
  if (identityConflict) cost = unknown('identity-conflict');
  else if (!dispatched) cost = unknown('not-dispatched');
  else if (finiteNonnegative(event.reportedCostUSD)) cost = { amount: event.reportedCostUSD, currency: 'USD', usd: event.reportedCostUSD, source: 'provider-reported', reason: 'reported', basis: 'reported', cacheBreakdown };
  else if (input.source !== 'provider-reported' || output.source !== 'provider-reported') cost = unknown(input.source !== 'provider-reported' && output.source !== 'provider-reported'
    ? 'missing-usage' : input.source !== 'provider-reported' ? 'missing-input-usage' : 'missing-output-usage');
  else {
    const captured = event.priceSnapshot;
    const resolved = captured == null ? selectUsageRate(rates, event.providerId, event.model, event.endpoint) : undefined;
    const parsed = captured == null ? undefined : usagePriceSnapshotSchema.safeParse(captured);
    const rate = parsed?.success ? parsed.data : resolved?.price;
    if (captured != null && !parsed?.success) cost = unknown('invalid-rate');
    else if (!rate) cost = unknown(resolved?.reason === 'missing-rate'
      ? event.pricingUnavailableReason !== undefined && event.pricingUnavailableReason !== 'missing-rate' ? event.pricingUnavailableReason
        : event.priceSnapshot === null ? 'missing-rate-at-request' : 'missing-rate'
      : resolved?.reason ?? 'missing-rate');
    else if (event.endpoint !== undefined && event.endpoint !== rate.endpoint) cost = unknown('endpoint-mismatch', rate);
    else {
      const cached = event.cachedInputTokens ?? 0, written = event.cacheWriteInputTokens ?? 0;
      const tier = rate.longContext !== undefined && input.value! > rate.longContext.inputThreshold ? rate.longContext : rate;
      if (event.tokenDetailsInvalid || !tokenCount(cached) || !tokenCount(written) || cached > input.value! || written > input.value! - cached
        || (event.reasoningOutputTokens != null && (!tokenCount(event.reasoningOutputTokens) || event.reasoningOutputTokens > output.value!))) cost = unknown('invalid-cache-usage', rate);
      else if ((cached > 0 && tier.cachedInputPerMillion == null) || (written > 0 && tier.cacheWriteInputPerMillion == null)) cost = unknown('missing-cache-rate', rate);
      else {
        const amount = ((input.value! - cached - written) * tier.inputPerMillion + cached * (tier.cachedInputPerMillion ?? 0)
          + written * (tier.cacheWriteInputPerMillion ?? 0) + output.value! * tier.outputPerMillion) / 1_000_000;
        cost = finiteNonnegative(amount) ? { amount, currency: rate.currency, usd: rate.currency === 'USD' ? amount : null,
          source: 'estimated', reason: captured == null ? 'current-reference' : 'request-rate', basis: captured == null ? 'current-reference' : 'request-snapshot', rate, cacheBreakdown }
          : unknown('invalid-rate', rate);
      }
    }
  }
  return { event, dispatched, identityConflict, input, output, cost };
};

const sum = (values: number[], integer = false): number | null => {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isFinite(result) || (integer && !Number.isSafeInteger(result))) return null;
  }
  return result;
};
const totals = (requests: readonly ProjectedUsageRequest[]): UsageTotals => {
  const sent = requests.filter((request) => request.dispatched);
  const complete = sent.filter((request) => request.input.source === 'provider-reported' && request.output.source === 'provider-reported');
  const reported = sent.flatMap((request) => [
    ...(request.input.source === 'provider-reported' ? [request.input.value!] : []),
    ...(request.output.source === 'provider-reported' ? [request.output.value!] : []),
  ]);
  const completeTotals = complete.map((request) => sum([request.input.value!, request.output.value!], true));
  const currencyTotals = (source: 'provider-reported' | 'estimated'): Partial<Record<UsageCurrency, number | null>> => Object.fromEntries(
    (['USD', 'CNY'] as const).flatMap((currency) => {
      const matching = sent.filter((request) => request.cost.source === source && request.cost.currency === currency);
      return matching.length === 0 ? [] : [[currency, sum(matching.map((request) => request.cost.amount!))]];
    }));
  const currencyCounts = (source: 'provider-reported' | 'estimated'): Partial<Record<UsageCurrency, number>> => Object.fromEntries(
    (['USD', 'CNY'] as const).flatMap((currency) => {
      const count = sent.filter((request) => request.cost.source === source && request.cost.currency === currency).length;
      return count === 0 ? [] : [[currency, count]];
    }));
  const reportedByCurrency = currencyTotals('provider-reported'), estimatedByCurrency = currencyTotals('estimated');
  return {
    reportedTokens: reported.length > 0 || sent.length === 0 ? sum(reported, true) : null,
    peakReportedTokens: completeTotals.length === 0 || completeTotals.some((value) => value === null) ? null : completeTotals.reduce<number>((peak, value) => Math.max(peak, value!), 0),
    completeReportedRequests: complete.length, incompleteReportedRequests: sent.length - complete.length,
    preparedRequests: requests.length, dispatchedRequests: sent.length, notDispatchedRequests: requests.length - sent.length,
    reportedInputTokens: sum(sent.filter((request) => request.input.source === 'provider-reported').map((request) => request.input.value!), true),
    reportedOutputTokens: sum(sent.filter((request) => request.output.source === 'provider-reported').map((request) => request.output.value!), true),
    estimatedInputTokens: sum(sent.filter((request) => request.input.source === 'estimated').map((request) => request.input.value!), true),
    reportedInputRequests: sent.filter((request) => request.input.source === 'provider-reported').length,
    reportedOutputRequests: sent.filter((request) => request.output.source === 'provider-reported').length,
    estimatedInputRequests: sent.filter((request) => request.input.source === 'estimated').length,
    unknownInputRequests: sent.filter((request) => request.input.source === 'unknown').length,
    unknownOutputRequests: sent.filter((request) => request.output.source === 'unknown').length,
    reportedUSD: reportedByCurrency.USD ?? null, estimatedUSD: estimatedByCurrency.USD ?? null,
    reportedByCurrency, estimatedByCurrency, reportedCostRequestsByCurrency: currencyCounts('provider-reported'), estimatedCostRequestsByCurrency: currencyCounts('estimated'),
    reportedCostRequests: sent.filter((request) => request.cost.source === 'provider-reported').length,
    estimatedCostRequests: sent.filter((request) => request.cost.source === 'estimated').length,
    unknownCostRequests: sent.filter((request) => request.cost.source === 'unknown').length,
    identityConflicts: requests.filter((request) => request.identityConflict).length,
  };
};
const group = (requests: ProjectedUsageRequest[], key: (request: ProjectedUsageRequest) => string | null): UsageGroup[] => {
  const groups = new Map<string, ProjectedUsageRequest[]>();
  for (const request of requests) {
    const id = key(request); if (id === null) continue;
    const items = groups.get(id) ?? []; items.push(request); groups.set(id, items);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([id, items]) => ({ id, requests: items, totals: totals(items) }));
};

/** Pure view of host receipts; request-time prices never change with today's catalog. */
export const projectUsage = (snapshot: UsageSnapshot): UsageProjection => {
  const requests = deduplicate(snapshot.events).map((record) => projectRequest(record, snapshot.rates));
  return { requests, summary: totals(requests), byScope: group(requests, (request): UsageScope => request.event.scope),
    byModel: group(requests, (request) => pair(request.event.providerId, request.event.model)),
    batches: group(requests, (request) => request.event.batchId) };
};
