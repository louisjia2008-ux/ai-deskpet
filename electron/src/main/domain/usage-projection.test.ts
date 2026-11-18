import { describe, expect, it } from 'vitest';
import type { UsageEvent, UsagePriceSnapshot, UsageRate } from '../../shared/automation';
import { projectUsage } from './usage-projection';

it('keeps malformed optional details from becoming free or guessed costs while preserving reported money', () => {
  const invalid = event({ tokenDetailsInvalid: true, priceSnapshot: price() });
  const projected = projectUsage({ events: [invalid], rates: [] }).requests[0]!;
  expect(projected.input.value).toBe(invalid.inputTokens);
  expect(projected.cost).toMatchObject({ source: 'unknown', amount: null, reason: 'invalid-cache-usage' });
  expect(projectUsage({ events: [{ ...invalid, reportedCostUSD: 0 }], rates: [] }).requests[0]?.cost).toMatchObject({ amount: 0, source: 'provider-reported' });
});

const event = (patch: Partial<UsageEvent> = {}): UsageEvent => ({ requestId: 'request-one', ownerId: 'assistant-one', scope: 'chat', batchId: null,
  providerId: 'synthetic-provider', model: 'synthetic-model', preparedAt: '2026-10-29T00:00:00.000Z', dispatchedAt: '2026-10-29T00:00:01.000Z', terminalAt: '2026-10-29T00:00:02.000Z',
  phase: 'terminal', outcome: 'completed', inputEstimate: 320, maxOutputTokens: 4096, inputTokens: 100, outputTokens: 20, tokenSource: 'provider-reported', reportedCostUSD: null, ...patch });
const rate = (patch: Partial<UsageRate> = {}): UsageRate => ({ providerId: 'synthetic-provider', model: 'synthetic-model', inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: '2026-10-29T00:00:00.000Z', ...patch });

describe('request receipt usage projection', () => {
  it('folds lifecycle receipts by request identity and retains partial reported values without counting each observation', () => {
    const prepared = event({ phase: 'prepared', dispatchedAt: null, terminalAt: null, inputTokens: null, outputTokens: null, tokenSource: 'unknown' });
    const received = event({ phase: 'response-received', terminalAt: null, outputTokens: null });
    const terminal = event({ inputTokens: null, outputTokens: 25 });
    const state = { events: [terminal, prepared, received], rates: [rate()] };
    const untouched = structuredClone(state), result = projectUsage(state);
    expect(result.requests).toHaveLength(1); expect(result.summary.dispatchedRequests).toBe(1);
    expect(result.summary.reportedInputTokens).toBe(100); expect(result.summary.reportedOutputTokens).toBe(25);
    expect(result.summary.estimatedUSD).toBeCloseTo(0.00035); expect(state).toEqual(untouched);
  });

  it('counts distinct attempts even with identical model, owner and token counts, including aborted and failed attempts', () => {
    const result = projectUsage({ events: [event({ outcome: 'aborted' }), event({ requestId: 'request-two', outcome: 'failed' })], rates: [] });
    expect(result.summary.dispatchedRequests).toBe(2); expect(result.summary.reportedInputTokens).toBe(200);
    expect(result.summary.unknownCostRequests).toBe(2); expect(result.requests.map((r) => r.event.outcome)).toEqual(['aborted', 'failed']);
  });

  it('treats batch rows as views over unique child requests instead of adding a second parent charge', () => {
    const result = projectUsage({ events: [event({ scope: 'delegation', batchId: 'batch-a', requestId: 'child-a', reportedCostUSD: 0.4 }),
      event({ scope: 'delegation', batchId: 'batch-a', requestId: 'child-b', reportedCostUSD: 0.7 }),
      event({ scope: 'delegation', batchId: 'batch-a', requestId: 'child-b', reportedCostUSD: 0.7 })], rates: [] });
    expect(result.summary.preparedRequests).toBe(2); expect(result.summary.reportedUSD).toBeCloseTo(1.1);
    expect(result.batches).toHaveLength(1); expect(result.batches[0]?.totals.reportedUSD).toBeCloseTo(1.1);
    expect(result.byScope[0]?.totals.dispatchedRequests).toBe(2);
  });

  it('keeps partial usage and missing rates unknown rather than pricing the output budget as consumed output', () => {
    const result = projectUsage({ events: [event({ inputTokens: null, outputTokens: null, tokenSource: 'unknown', inputEstimate: 789, maxOutputTokens: 8192 })], rates: [rate()] });
    expect(result.requests[0]?.input).toEqual({ value: 789, source: 'estimated' });
    expect(result.requests[0]?.output).toEqual({ value: null, source: 'unknown' });
    expect(result.requests[0]?.cost).toMatchObject({ usd: null, source: 'unknown', reason: 'missing-usage' });
    expect(result.summary.unknownCostRequests).toBe(1); expect(result.summary.unknownOutputRequests).toBe(1);
    expect(projectUsage({ events: [event()], rates: [] }).requests[0]?.cost.reason).toBe('missing-rate');
  });

  it('preserves an explicit reported zero separately from unknown cost and ignores current price when cost is reported', () => {
    const result = projectUsage({ events: [event({ reportedCostUSD: 0, inputTokens: null, outputTokens: null, tokenSource: 'unknown' })], rates: [rate({ inputUSDPerMillion: 999 })] });
    expect(result.requests[0]?.cost).toMatchObject({ usd: 0, source: 'provider-reported', reason: 'reported' });
    expect(result.summary.reportedCostRequests).toBe(1); expect(result.summary.estimatedCostRequests).toBe(0); expect(result.summary.unknownCostRequests).toBe(0);
  });

  it('does not count prepared but never dispatched requests as spent, and does not silently trust conflicting identities', () => {
    const result = projectUsage({ events: [event({ requestId: 'not-sent', phase: 'prepared', dispatchedAt: null, terminalAt: null }),
      event({ reportedCostUSD: 0.2 }), event({ providerId: 'different-provider', reportedCostUSD: 0.5 })], rates: [rate()] });
    expect(result.summary.preparedRequests).toBe(2); expect(result.summary.dispatchedRequests).toBe(1); expect(result.summary.notDispatchedRequests).toBe(1);
    expect(result.summary.identityConflicts).toBe(1); expect(result.summary.reportedUSD).toBeNull(); expect(result.summary.unknownCostRequests).toBe(1);
    expect(result.requests.find((r) => r.event.requestId === 'request-one')?.cost.reason).toBe('identity-conflict');
  });

  it('uses the latest explicit rate and rejects malformed prices or overflow instead of manufacturing a numeric total', () => {
    const result = projectUsage({ events: [event()], rates: [rate({ inputUSDPerMillion: 7, updatedAt: '2026-10-30T00:00:00.000Z' }), rate(), rate({ inputUSDPerMillion: Number.NaN })] });
    expect(result.summary.estimatedUSD).toBeCloseTo(0.00082);
    const invalid = projectUsage({ events: [event()], rates: [rate({ outputUSDPerMillion: -1 })] });
    expect(invalid.requests[0]?.cost.source).toBe('unknown');
    const overflow = projectUsage({ events: [event({ inputTokens: Number.MAX_SAFE_INTEGER }), event({ requestId: 'overflow', inputTokens: Number.MAX_SAFE_INTEGER })], rates: [] });
    expect(overflow.summary.reportedInputTokens).toBeNull();
  });

  it('sums only dispatched reported sides and takes peaks only from complete unique requests', () => {
    const result = projectUsage({ events: [event(), event(),
      event({ requestId: 'partial', inputTokens: 700, outputTokens: null, inputEstimate: 10000 }),
      event({ requestId: 'estimated', inputTokens: null, outputTokens: null, tokenSource: 'unknown', inputEstimate: 50000 }),
      event({ requestId: 'never-sent', dispatchedAt: null, phase: 'prepared', inputTokens: 9000, outputTokens: 9000 })], rates: [] });
    expect(result.summary.reportedTokens).toBe(820);
    expect(result.summary.peakReportedTokens).toBe(120);
    expect(result.summary.completeReportedRequests).toBe(1);
    expect(result.summary.incompleteReportedRequests).toBe(2);
    expect(result.byModel).toHaveLength(1);
    expect(result.byModel[0]?.totals.reportedTokens).toBe(820);
  });

  it('distinguishes no usage data from an explicit reported zero and returns unknown on token overflow', () => {
    const unknown = projectUsage({ events: [event({ tokenSource: 'unknown', inputTokens: null, outputTokens: null })], rates: [] });
    expect(unknown.summary.reportedTokens).toBeNull(); expect(unknown.summary.peakReportedTokens).toBeNull();
    const zero = projectUsage({ events: [event({ inputTokens: 0, outputTokens: 0 })], rates: [] });
    expect(zero.summary.reportedTokens).toBe(0); expect(zero.summary.peakReportedTokens).toBe(0);
    const overflow = projectUsage({ events: [event({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })], rates: [] });
    expect(overflow.summary.reportedTokens).toBeNull(); expect(overflow.summary.peakReportedTokens).toBeNull();
  });

  it('separates the same model name used by different providers without altering the overall count', () => {
    const result = projectUsage({ events: [event(), event({ requestId: 'provider-two-request', providerId: 'provider-two' })], rates: [] });
    expect(result.byModel).toHaveLength(2); expect(result.summary.reportedTokens).toBe(240);
    expect(result.byModel.map((model) => model.totals.reportedTokens)).toEqual([120, 120]);
  });

  it('keeps cumulative reported and estimated costs separate, excludes unobserved dispatch and never counts a parent twice', () => {
    const result = projectUsage({ events: [
      event({ requestId: 'reported', batchId: 'batch', reportedCostUSD: 0.4 }),
      event({ requestId: 'reported', batchId: 'batch', reportedCostUSD: 0.4 }),
      event({ requestId: 'estimated', batchId: 'batch' }),
      event({ requestId: 'unknown-cost', providerId: 'unpriced-provider' }),
      event({ requestId: 'not-sent-cost', dispatchedAt: null, phase: 'prepared', reportedCostUSD: 5 }),
    ], rates: [rate()] });
    expect(result.summary.reportedUSD).toBe(0.4); expect(result.summary.reportedCostRequests).toBe(1);
    expect(result.summary.estimatedUSD).toBeCloseTo(0.00032); expect(result.summary.estimatedCostRequests).toBe(1);
    expect(result.summary.unknownCostRequests).toBe(1);
    expect(result.batches[0]?.totals.reportedUSD).toBe(0.4); expect(result.batches[0]?.totals.estimatedUSD).toBeCloseTo(0.00032);
    const missing = projectUsage({ events: [event({ providerId: 'unpriced-provider' })], rates: [] });
    expect(missing.summary.reportedUSD).toBeNull(); expect(missing.summary.estimatedUSD).toBeNull();
    expect(projectUsage({ events: [], rates: [] }).summary.reportedUSD).toBeNull();
  });

});

const price = (patch: Partial<UsagePriceSnapshot> = {}): UsagePriceSnapshot => ({ currency: 'USD', inputPerMillion: 2, outputPerMillion: 6,
  cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 3, source: 'reference', sourceUrl: 'https://example.com/pricing',
  checkedAt: '2026-11-02T00:00:00.000Z', endpoint: 'https://api.example.com/v1', ...patch });
const pricedRate = (snapshot: UsagePriceSnapshot): UsageRate => ({ providerId: 'synthetic-provider', model: 'synthetic-model', price: snapshot, updatedAt: snapshot.checkedAt });

describe('auditable price snapshots and cache accounting', () => {
  it('keeps a captured request price immutable when later manual/catalog prices change', () => {
    const saved = event({ endpoint: price().endpoint, priceSnapshot: price(), cachedInputTokens: 0 });
    const state = { events: [saved], rates: [pricedRate(price({ inputPerMillion: 500, outputPerMillion: 900, source: 'manual' }))] };
    const before = structuredClone(state), result = projectUsage(state);
    expect(result.requests[0]?.cost).toMatchObject({ amount: 0.00032, currency: 'USD', usd: 0.00032, source: 'estimated', basis: 'request-snapshot', reason: 'request-rate' });
    expect(state).toEqual(before);
  });

  it('labels current-price backfill for both legacy and explicit unpriced requests without mutating them', () => {
    const state = { events: [event(), event({ requestId: 'new-unpriced', endpoint: price().endpoint, priceSnapshot: null })], rates: [pricedRate(price())] };
    const before = structuredClone(state), result = projectUsage(state);
    expect(result.requests.every(request => request.cost.basis === 'current-reference' && request.cost.reason === 'current-reference')).toBe(true);
    expect(state).toEqual(before);
    expect(projectUsage({ events: [state.events[1]!], rates: [] }).requests[0]?.cost.reason).toBe('missing-rate-at-request');
  });

  it('prefers an explicit manual rate to later API/reference prices only at the exact provider/model/endpoint', () => {
    const manual = price({ source: 'manual', inputPerMillion: 7 });
    const result = projectUsage({ events: [event({ endpoint: manual.endpoint })], rates: [pricedRate(price({ checkedAt: '2026-11-03T00:00:00.000Z' })), pricedRate(manual)] });
    expect(result.requests[0]?.cost.rate?.source).toBe('manual');
    expect(result.summary.estimatedUSD).toBeCloseTo(0.00082);
    expect(projectUsage({ events: [event({ endpoint: 'https://other.example.com/v1' })], rates: [pricedRate(manual)] }).requests[0]?.cost.reason).toBe('endpoint-mismatch');
    expect(projectUsage({ events: [event({ model: 'synthetic-model-alias' })], rates: [pricedRate(manual)] }).requests[0]?.cost.reason).toBe('missing-rate');
    expect(projectUsage({ events: [event({ providerId: 'another-provider' })], rates: [pricedRate(manual)] }).requests[0]?.cost.reason).toBe('missing-rate');
  });

  it('rejects a frozen endpoint mismatch or invalid snapshot instead of applying a current replacement', () => {
    const eventWithPrice = event({ endpoint: price().endpoint, priceSnapshot: price({ endpoint: 'https://other.example.com/v1' }) });
    expect(projectUsage({ events: [eventWithPrice], rates: [pricedRate(price())] }).requests[0]?.cost.reason).toBe('endpoint-mismatch');
    const invalid = event({ priceSnapshot: price({ outputPerMillion: Number.NaN }) });
    expect(projectUsage({ events: [invalid], rates: [pricedRate(price())] }).requests[0]?.cost.reason).toBe('invalid-rate');
  });

  it('subtracts cache-read and cache-write subsets, and never adds reasoning tokens a second time', () => {
    const result = projectUsage({ events: [event({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, cacheWriteInputTokens: 200,
      reasoningOutputTokens: 60, priceSnapshot: price() })], rates: [] });
    // 400 regular * 2 + 400 cached * .2 + 200 write * 3 + 100 output * 6.
    expect(result.requests[0]?.cost.amount).toBeCloseTo(0.00208);
    expect(result.requests[0]?.cost.cacheBreakdown).toBe('reported');
    expect(result.summary.reportedTokens).toBe(1100);
  });

  it.each([
    { cachedInputTokens: 101 }, { cachedInputTokens: 80, cacheWriteInputTokens: 21 },
    { cachedInputTokens: -1 }, { cachedInputTokens: 0.5 }, { cachedInputTokens: Number.NaN }, { reasoningOutputTokens: 21 },
  ])('does not price inconsistent cache/reasoning detail %j', detail => {
    expect(projectUsage({ events: [event({ ...detail, priceSnapshot: price() })], rates: [] }).requests[0]?.cost.reason).toBe('invalid-cache-usage');
  });

  it('requires a cache price only when that cache category has a positive known count', () => {
    const noCacheRate = price({ cachedInputPerMillion: null, cacheWriteInputPerMillion: null });
    const project = (patch: Partial<UsageEvent>) => projectUsage({ events: [event({ priceSnapshot: noCacheRate, ...patch })], rates: [] }).requests[0]!.cost;
    expect(project({ cachedInputTokens: 1 }).reason).toBe('missing-cache-rate');
    expect(project({ cacheWriteInputTokens: 1 }).reason).toBe('missing-cache-rate');
    expect(project({ cachedInputTokens: 0, cacheWriteInputTokens: 0 })).toMatchObject({ source: 'estimated', cacheBreakdown: 'reported' });
    expect(project({})).toMatchObject({ source: 'estimated', cacheBreakdown: 'unknown', amount: 0.00032 });
  });

  it('selects a long-context tier from full reported input, including cached input, using strict threshold semantics', () => {
    const tiered = price({ longContext: { inputThreshold: 100, inputPerMillion: 4, outputPerMillion: 12, cachedInputPerMillion: 0.4, cacheWriteInputPerMillion: 6 } });
    const result = projectUsage({ events: [event({ priceSnapshot: tiered, inputTokens: 101, cachedInputTokens: 51, cacheWriteInputTokens: 10 })], rates: [] });
    expect(result.requests[0]?.cost.amount).toBeCloseTo((40 * 4 + 51 * 0.4 + 10 * 6 + 20 * 12) / 1_000_000);
    const boundary = projectUsage({ events: [event({ priceSnapshot: tiered, inputTokens: 100 })], rates: [] });
    expect(boundary.requests[0]?.cost.amount).toBeCloseTo(0.00032);
    const missingTierCache = price({ longContext: { inputThreshold: 100, inputPerMillion: 4, outputPerMillion: 12 } });
    expect(projectUsage({ events: [event({ priceSnapshot: missingTierCache, inputTokens: 101, cachedInputTokens: 1 })], rates: [] }).requests[0]?.cost.reason).toBe('missing-cache-rate');
  });

  it('keeps CNY and USD amounts and request counts separate without an implicit exchange rate', () => {
    const result = projectUsage({ events: [event({ requestId: 'usd', priceSnapshot: price() }), event({ requestId: 'cny', priceSnapshot: price({ currency: 'CNY' }) }),
      event({ requestId: 'reported', reportedCostUSD: 0.5, priceSnapshot: price({ currency: 'CNY' }) })], rates: [] });
    expect(result.summary.estimatedByCurrency).toEqual({ USD: 0.00032, CNY: 0.00032 });
    expect(result.summary.reportedByCurrency).toEqual({ USD: 0.5 });
    expect(result.summary.estimatedCostRequestsByCurrency).toEqual({ USD: 1, CNY: 1 });
    expect(result.summary.reportedCostRequestsByCurrency).toEqual({ USD: 1 });
    expect(result.summary.estimatedUSD).toBe(0.00032);
    expect(result.requests.find(request => request.event.requestId === 'cny')?.cost.usd).toBeNull();
    expect(result.requests.find(request => request.event.requestId === 'reported')?.cost).toMatchObject({ amount: 0.5, currency: 'USD', basis: 'reported' });
  });

  it('distinguishes missing input from missing output and retains explicit zero cost', () => {
    const project = (patch: Partial<UsageEvent>) => projectUsage({ events: [event({ ...patch, priceSnapshot: price() })], rates: [] }).requests[0]!.cost;
    expect(project({ inputTokens: null }).reason).toBe('missing-input-usage');
    expect(project({ outputTokens: null }).reason).toBe('missing-output-usage');
    expect(project({ inputTokens: 0, outputTokens: 0 })).toMatchObject({ amount: 0, source: 'estimated' });
    expect(project({ inputTokens: null, outputTokens: null, reportedCostUSD: 0 })).toMatchObject({ amount: 0, source: 'provider-reported' });
  });

  it('folds lifecycle cache details and frozen prices without losing them at the terminal record', () => {
    const first = event({ phase: 'prepared', dispatchedAt: null, terminalAt: null, inputTokens: null, outputTokens: null, priceSnapshot: price() });
    const received = event({ phase: 'response-received', terminalAt: null, cachedInputTokens: 50, outputTokens: null });
    const terminal = event({ inputTokens: null, outputTokens: 20 });
    const result = projectUsage({ events: [terminal, first, received], rates: [] });
    expect(result.requests[0]?.cost).toMatchObject({ amount: 0.00023, basis: 'request-snapshot' });
    expect(result.requests[0]?.event.cachedInputTokens).toBe(50);
    expect(result.summary.dispatchedRequests).toBe(1);
  });

  it('marks conflicting endpoint identities unknown even if a provider reports a cost', () => {
    const result = projectUsage({ events: [event({ endpoint: price().endpoint, reportedCostUSD: 1 }), event({ endpoint: 'https://different.example.com', reportedCostUSD: 1 })], rates: [] });
    expect(result.summary.dispatchedRequests).toBe(1); expect(result.summary.identityConflicts).toBe(1);
    expect(result.requests[0]?.cost.reason).toBe('identity-conflict');
  });
});
