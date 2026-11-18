// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainRepository } from './repository';
import { UsageLedger } from './usage-ledger';
import type { PricedUsageRate, UsagePriceSnapshot } from '../../shared';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-usage-accounting-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 71) };
  const repo = new DomainRepository(path, vault); await repo.initialize();
  const ledger = new UsageLedger(repo);
  const record = () => ({ requestId: randomUUID(), bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), providerId: randomUUID(), model: 'synthetic', inputEstimate: 100, maxInputTokens: 3328, maxOutputTokens: 100, capacitySource: 'configured' });
  return { ledger, repo, record, reopen: async () => { const next = new DomainRepository(path, vault); await next.initialize(); return next; } };
};

describe('Read-only token accounting without daily admission limits', () => {
  it.each([0, 1] as const)('records and admits multiple requests despite a legacy daily limit of %s', async limit => {
    const f = await fixture();
    await f.repo.transaction(state => { state.usageBudget = { dailyRequestLimit: limit, dailyTokenLimit: limit }; });
    const records = [f.record(), f.record(), f.record()];
    await Promise.all(records.map(record => f.ledger.prepare(record)));
    for (const record of records) expect(() => f.ledger.assertDispatch(record.requestId)).not.toThrow();
    expect(f.ledger.snapshot().events).toHaveLength(3);
    const restored = await f.reopen();
    expect(restored.snapshot().usageBudget).toEqual({ dailyRequestLimit: limit, dailyTokenLimit: limit });
    const next = new UsageLedger(restored);
    await expect(next.prepare(f.record())).resolves.toBeUndefined();
  });

  it('counts a repeated request identity once, rejects conflicting identities and requires preparation', async () => {
    const f = await fixture(), record = f.record();
    await Promise.all([f.ledger.prepare(record), f.ledger.prepare(record)]);
    expect(f.ledger.snapshot().events).toHaveLength(1);
    await expect(f.ledger.prepare({ ...record, model: 'different' })).rejects.toThrow('provider.usageIdentityConflict');
    expect(() => f.ledger.assertDispatch(randomUUID())).toThrow('provider.usageNotPrepared');
  });

  it.each(['failed', 'aborted'] as const)('persists an undispatched %s attempt without permitting the same attempt to restart', async outcome => {
    const f = await fixture(), first = f.record(); await f.ledger.prepare(first);
    await f.ledger.releaseUndispatched(first, outcome);
    const restored = await f.reopen();
    expect(restored.snapshot().usageEvents[0]).toMatchObject({ phase: 'terminal', outcome, dispatchedAt: null, inputTokens: null, outputTokens: null, tokenSource: 'unknown', reportedCostUSD: null });
    const next = new UsageLedger(restored);
    await expect(next.prepare(first)).rejects.toThrow('provider.requestRecordFailed');
    expect(() => next.assertDispatch(first.requestId)).toThrow('provider.requestRecordFailed');
    await expect(next.prepare(f.record())).resolves.toBeUndefined();
  });

  it('retains unknown dispatched usage when a later undispatched callback arrives', async () => {
    const f = await fixture(), first = f.record(); await f.ledger.prepare(first);
    await f.ledger.observe({ requestId: first.requestId, bindingDigest: first.bindingDigest, bodySHA256: first.bodySHA256, inputEstimate: 100, phase: 'fetch-invoked', httpStatus: null, outcome: null, usage: { inputTokens: null, outputTokens: null, source: 'unknown' }, finishReason: null });
    await f.ledger.releaseUndispatched(first, 'aborted');
    expect(f.repo.snapshot().usageEvents[0]).toMatchObject({ phase: 'fetch-invoked', outcome: null, inputTokens: null, outputTokens: null, tokenSource: 'unknown' });
    expect(f.repo.snapshot().usageEvents[0]?.dispatchedAt).not.toBeNull();
    await expect(f.ledger.prepare(f.record())).resolves.toBeUndefined();
  });

  it('preserves a terminal attempt even when preparation failed before an accounting row existed', async () => {
    const f = await fixture(), record = f.record();
    await f.ledger.releaseUndispatched(record, 'failed');
    const restored = await f.reopen();
    expect(restored.snapshot().usageEvents[0]).toMatchObject({ requestId: record.requestId, phase: 'terminal', outcome: 'failed', dispatchedAt: null });
    await expect(new UsageLedger(restored).prepare(record)).rejects.toThrow('provider.requestRecordFailed');
  });

  it('exposes recorded prices read-only while preserving inert legacy budgets in encrypted storage', async () => {
    const f = await fixture();
    const rate = { providerId: randomUUID(), model: 'legacy-model', inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: '2026-11-01T00:00:00.000Z' };
    await f.repo.transaction(state => { state.usageRates.push(rate); state.usageBudget = { dailyRequestLimit: 0, dailyTokenLimit: 0 }; });
    expect(f.ledger.snapshot()).toEqual({ events: [], rates: [rate] });
    const restored = await f.reopen();
    expect(restored.snapshot().usageRates).toEqual([rate]);
    expect(restored.snapshot().usageBudget).toEqual({ dailyRequestLimit: 0, dailyTokenLimit: 0 });
  });
});

const referencePrice = (patch: Partial<UsagePriceSnapshot> = {}): UsagePriceSnapshot => ({ currency: 'USD', inputPerMillion: 2, outputPerMillion: 6,
  cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 3, source: 'reference', sourceUrl: 'https://example.com/pricing',
  checkedAt: '2026-11-02T00:00:00.000Z', endpoint: 'https://api.example.com/v1', ...patch });
const registerProvider = async (repo: DomainRepository, providerId: string) => {
  await repo.transaction(state => state.providers.push({ id: providerId, kind: 'openai-compatible', name: 'Synthetic', baseUrl: referencePrice().endpoint,
    model: 'synthetic', enabled: true, supportsTools: true, secretState: 'missing' }));
};

describe('persisted request price snapshots and manual overrides', () => {
  it('retains invalid optional detail provenance across later partial observations and encrypted restart', async () => {
    const f = await fixture(), record = f.record(); await f.ledger.prepare(record);
    const common = { requestId: record.requestId, bindingDigest: record.bindingDigest, bodySHA256: record.bodySHA256, inputEstimate: record.inputEstimate, httpStatus: 200, finishReason: 'stop' };
    await f.ledger.observe({ ...common, phase: 'response-received', outcome: null, usage: { inputTokens: 100, outputTokens: 20, source: 'provider-reported', tokenDetailsInvalid: true } });
    await f.ledger.observe({ ...common, phase: 'terminal', outcome: 'completed', usage: { inputTokens: null, outputTokens: null, source: 'unknown' } });
    expect((await f.reopen()).snapshot().usageEvents[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, tokenDetailsInvalid: true, outcome: 'completed' });
  });
  it('captures an immutable reference price at prepare and preserves it through edits, observations and restart', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    let current = referencePrice();
    const ledger = new UsageLedger(f.repo, () => Date.parse('2026-11-02T01:00:00.000Z'), () => current);
    await ledger.prepare({ ...record, endpoint: current.endpoint });
    current = referencePrice({ inputPerMillion: 99 });
    await ledger.upsertRate({ providerId: record.providerId, model: record.model, currency: 'CNY', inputPerMillion: 9, outputPerMillion: 15 });
    await ledger.observe({ requestId: record.requestId, bindingDigest: record.bindingDigest, bodySHA256: record.bodySHA256, inputEstimate: record.inputEstimate,
      phase: 'terminal', outcome: 'completed', httpStatus: 200, usage: { inputTokens: 100, outputTokens: 20, source: 'provider-reported', cachedInputTokens: 40,
        cacheWriteInputTokens: 10, reasoningOutputTokens: 8 }, finishReason: 'stop' });
    const reopened = await f.reopen(), event = reopened.snapshot().usageEvents[0];
    expect(event).toMatchObject({ endpoint: referencePrice().endpoint, priceSnapshot: referencePrice(), cachedInputTokens: 40, cacheWriteInputTokens: 10, reasoningOutputTokens: 8 });
    const nextRecord = { ...f.record(), providerId: record.providerId };
    await new UsageLedger(reopened).prepare(nextRecord);
    expect(reopened.snapshot().usageEvents[1]?.priceSnapshot).toMatchObject({ currency: 'CNY', inputPerMillion: 9, source: 'manual' });
  });

  it('captures missing prices as null and labels later references without writing back into the ledger', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    const ledger = new UsageLedger(f.repo);
    await ledger.prepare(record);
    expect(f.repo.snapshot().usageEvents[0]?.priceSnapshot).toBeNull();
    const before = f.repo.snapshot();
    const enriched = new UsageLedger(f.repo, Date.now, () => referencePrice()).snapshot();
    expect(enriched.rates).toHaveLength(1); expect(enriched.events[0]?.priceSnapshot).toBeNull();
    expect(f.repo.snapshot()).toEqual(before);
  });

  it('binds manual edits to saved endpoints, validates both methods, and leaves budgets and events untouched', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    await f.ledger.prepare(record); const before = f.repo.snapshot();
    const edited = await f.ledger.upsertRate({ providerId: record.providerId, model: record.model, currency: 'CNY', inputPerMillion: 0,
      outputPerMillion: 8, cachedInputPerMillion: 0, longContext: { inputThreshold: 100, inputPerMillion: 3, outputPerMillion: 9, cacheWriteInputPerMillion: 5 } });
    expect(edited.rates[0]).toMatchObject({ providerId: record.providerId, model: record.model, price: { source: 'manual', endpoint: referencePrice().endpoint, currency: 'CNY' } });
    expect(f.repo.snapshot().usageEvents).toEqual(before.usageEvents); expect(f.repo.snapshot().usageBudget).toEqual(before.usageBudget);
    await expect(f.ledger.upsertRate({ providerId: record.providerId, model: record.model, currency: 'USD', inputPerMillion: -1, outputPerMillion: 2 })).rejects.toThrow();
    await expect(f.ledger.removeRate({ providerId: 'invalid', model: record.model })).rejects.toThrow();
    for (const model of ['a\nb', 'a\tb', 'a\u007fb']) {
      await expect(f.ledger.upsertRate({ providerId: record.providerId, model, currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 })).rejects.toThrow();
      await expect(f.ledger.removeRate({ providerId: record.providerId, model })).rejects.toThrow();
    }
    await expect(f.ledger.upsertRate({ providerId: randomUUID(), model: record.model, currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 })).rejects.toThrow('provider.unavailable');
    await f.ledger.removeRate({ providerId: record.providerId, model: record.model });
    expect(f.ledger.snapshot().rates).toEqual([]); expect(f.repo.snapshot().usageEvents).toEqual(before.usageEvents);
  });

  it('preserves cached API prices beneath manual precedence and reveals them after manual removal', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    const apiRate = { providerId: record.providerId, model: record.model, price: referencePrice({ source: 'provider-api', inputPerMillion: 7 }), updatedAt: referencePrice().checkedAt };
    await f.ledger.upsertRate({ providerId: record.providerId, model: record.model, currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 });
    await f.ledger.cacheRates([apiRate]);
    await f.ledger.prepare(record);
    expect(f.repo.snapshot().usageEvents[0]?.priceSnapshot).toMatchObject({ source: 'manual', inputPerMillion: 1 });
    expect(f.repo.snapshot().usageRates).toHaveLength(2);
    await f.ledger.removeRate({ providerId: record.providerId, model: record.model });
    await f.ledger.prepare({ ...f.record(), providerId: record.providerId });
    expect(f.repo.snapshot().usageEvents[1]?.priceSnapshot).toMatchObject({ source: 'provider-api', inputPerMillion: 7 });
  });

  it('refuses stale endpoint API responses and a mismatching resolver without reassigning request prices', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    const other = referencePrice({ source: 'provider-api', endpoint: 'https://other.example.com/v1' });
    await f.ledger.cacheRates([{ providerId: record.providerId, model: record.model, price: other, updatedAt: other.checkedAt }]);
    expect(f.ledger.snapshot().rates).toEqual([]);
    const ledger = new UsageLedger(f.repo, Date.now, () => other);
    await ledger.prepare(record);
    expect(f.repo.snapshot().usageEvents[0]?.priceSnapshot).toBeNull();
    expect(ledger.snapshot().rates).toEqual([]);
  });

  it('replaces withdrawn API prices while retaining manual entries and ignores responses from an edited endpoint', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    const endpoint = referencePrice().endpoint;
    const apiRate = { providerId: record.providerId, model: record.model, price: referencePrice({ source: 'provider-api' }), updatedAt: referencePrice().checkedAt };
    await f.ledger.replaceCatalog(record.providerId, endpoint, [apiRate]);
    await f.ledger.upsertRate({ providerId: record.providerId, model: record.model, currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 });
    await f.ledger.replaceCatalog(record.providerId, endpoint, []);
    expect(f.repo.snapshot().usageRates).toHaveLength(1); expect(f.repo.snapshot().usageRates[0]).toMatchObject({ price: { source: 'manual' } });
    await f.repo.transaction(state => { state.providers[0]!.baseUrl = 'https://new.example.com/v1'; });
    await f.ledger.replaceCatalog(record.providerId, endpoint, [apiRate]);
    expect(f.repo.snapshot().usageRates).toHaveLength(1);
    await expect(f.ledger.replaceCatalog(record.providerId, 'https://new.example.com/v1', [apiRate])).rejects.toThrow('provider.invalidUsageCatalog');
  });

  it('preserves partial cache usage from earlier lifecycle observations when terminal usage is absent', async () => {
    const f = await fixture(), record = f.record(); await f.ledger.prepare(record);
    const base = { requestId: record.requestId, bindingDigest: record.bindingDigest, bodySHA256: record.bodySHA256, inputEstimate: record.inputEstimate, httpStatus: 200, finishReason: null };
    await f.ledger.observe({ ...base, phase: 'response-received', outcome: null, usage: { inputTokens: 100, outputTokens: null, cachedInputTokens: 40, source: 'provider-reported' } });
    await f.ledger.observe({ ...base, phase: 'terminal', outcome: 'completed', usage: { inputTokens: null, outputTokens: 20, source: 'provider-reported' } });
    const event = (await f.reopen()).snapshot().usageEvents[0];
    expect(event).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
  });

  it('round-trips old profiles and rejects malformed rates instead of silently changing currency or totals', async () => {
    const f = await fixture(), providerId = randomUUID();
    const legacy = { providerId, model: 'legacy', inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: '2026-11-01T00:00:00.000Z' };
    await f.repo.transaction(state => state.usageRates.push(legacy));
    expect((await f.reopen()).snapshot().usageRates).toEqual([legacy]);
    await expect(f.ledger.cacheRates([{ providerId, model: 'invalid', price: referencePrice({ source: 'provider-api', inputPerMillion: Number.NaN }), updatedAt: referencePrice().checkedAt }])).rejects.toThrow();
    expect(f.repo.snapshot().usageRates).toEqual([legacy]);
  });
});

describe('historical usage receipt import', () => {
  it('imports partial old observations once without inventing an endpoint or request-time price', async () => {
    const f = await fixture(), record = f.record(), sessionId = randomUUID(), messageId = randomUUID(), timestamp = '2026-11-01T00:00:00.000Z';
    await registerProvider(f.repo, record.providerId);
    await f.repo.transaction(state => {
      state.chatSessions.push({ id: sessionId, title: 'Synthetic import', kind: 'normal', createdAt: timestamp, updatedAt: timestamp });
      state.chatMessages.push({ id: messageId, sessionId, role: 'assistant', content: 'Synthetic answer', createdAt: timestamp, status: 'complete', errorCode: null,
        requestReceipts: [{ requestId: record.requestId, bindingDigest: record.bindingDigest, expectedBodySHA256: record.bodySHA256,
          inputEstimate: record.inputEstimate, maxInputTokens: record.maxInputTokens, maxOutputTokens: record.maxOutputTokens, capacitySource: record.capacitySource,
          contextTrace: { version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'cloud-allowed', scope: { kind: 'session', sessionId }, lineage: 'complete' },
          contextBinding: { providerId: record.providerId, model: record.model, destination: 'remote', localExecutionDeclared: false },
          preparedAt: timestamp, userMessageId: null, phase: 'terminal', sentCountRecorded: true,
          observations: [
            { requestId: record.requestId, bindingDigest: record.bindingDigest, bodySHA256: record.bodySHA256, inputEstimate: record.inputEstimate,
              phase: 'response-received', httpStatus: 200, outcome: null, usage: { inputTokens: 100, outputTokens: null, cachedInputTokens: 40, source: 'provider-reported' }, finishReason: null, observedAt: timestamp },
            { requestId: record.requestId, bindingDigest: record.bindingDigest, bodySHA256: record.bodySHA256, inputEstimate: record.inputEstimate,
              phase: 'terminal', httpStatus: 200, outcome: 'completed', usage: { inputTokens: null, outputTokens: 20, reasoningOutputTokens: 8, source: 'provider-reported', reportedCostUSD: 0 }, finishReason: 'stop', observedAt: timestamp },
          ] }],
      });
    });
    const ledger = new UsageLedger(f.repo, Date.now, () => referencePrice());
    await ledger.importReceipts(); await ledger.importReceipts();
    const imported = (await f.reopen()).snapshot().usageEvents;
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ ownerId: messageId, scope: 'chat', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 8, reportedCostUSD: 0 });
    expect(imported[0]?.endpoint).toBeUndefined(); expect(imported[0]?.priceSnapshot).toBeUndefined();
    expect(ledger.snapshot().rates).toHaveLength(1);
    expect(f.repo.snapshot().usageEvents).toEqual(imported);
  });
});

const catalogRate = (providerId: string, model: string, checkedAt = referencePrice().checkedAt): PricedUsageRate => ({
  providerId, model, price: referencePrice({ source: 'provider-api', checkedAt }), updatedAt: checkedAt,
});

describe('bounded disposable API price cache', () => {
  it.each(['incremental', 'replacement'] as const)('accepts an oversized %s catalog while preserving manual/legacy and prioritizing active, historical and job models', async method => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    await f.ledger.prepare({ ...record, model: 'historically-used', endpoint: referencePrice().endpoint });
    const manual = { providerId: record.providerId, model: 'manual-protected', price: referencePrice({ source: 'manual' }), updatedAt: referencePrice().checkedAt };
    const legacy = { providerId: record.providerId, model: 'legacy-protected', inputUSDPerMillion: 1, outputUSDPerMillion: 2, updatedAt: referencePrice().checkedAt };
    await f.repo.transaction(state => {
      state.usageRates.push(manual, legacy);
      state.backgroundJobs.push({ id: randomUUID(), profileId: state.profileId, operationId: randomUUID(), specDigest: 'a'.repeat(64), attemptId: randomUUID(),
        origin: 'background-jobs', resultOwner: randomUUID(), instruction: 'Synthetic cached-price priority', material: '',
        source: { kind: 'explicit-paste', actionId: randomUUID(), privacy: 'cloud-allowed' },
        binding: { provider: state.providers[0]!, model: 'job-used', digest: 'b'.repeat(64), credentialRef: randomUUID(), destination: 'remote',
          limits: { maxOutputTokens: 100, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } } },
        status: 'succeeded', executionOwner: null, cancelRequestedAt: null, createdAt: referencePrice().checkedAt, updatedAt: referencePrice().checkedAt,
        completionReason: null, result: null, request: null, receipts: [],
      });
    });
    const catalog = [
      ...['synthetic', 'historically-used', 'job-used'].map(model => catalogRate(record.providerId, model, '2026-10-01T00:00:00.000Z')),
      ...Array.from({ length: 1100 }, (_, index) => catalogRate(record.providerId, `unused-${index}`, new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 1000).toISOString())),
    ];
    if (method === 'incremental') await expect(f.ledger.cacheRates(catalog)).resolves.toBeUndefined();
    else await expect(f.ledger.replaceCatalog(record.providerId, referencePrice().endpoint, catalog)).resolves.toBeUndefined();
    const reopened = (await f.reopen()).snapshot();
    expect(reopened.usageRates).toHaveLength(1000);
    expect(reopened.usageRates).toContainEqual(manual); expect(reopened.usageRates).toContainEqual(legacy);
    const models = new Set(reopened.usageRates.map(rate => rate.model));
    for (const model of ['synthetic', 'historically-used', 'job-used', 'unused-1099']) expect(models.has(model)).toBe(true);
    expect(models.has('unused-0')).toBe(false);
    expect(reopened.usageEvents).toEqual(f.repo.snapshot().usageEvents);
  });

  it.each(['incremental', 'replacement'] as const)('ignores automatic %s prices when all 1000 slots belong to explicit prices', async method => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    await f.repo.transaction(state => {
      state.usageRates = Array.from({ length: 1000 }, (_, index) => index % 2 === 0
        ? { providerId: record.providerId, model: `explicit-${index}`, price: referencePrice({ source: 'manual' }), updatedAt: referencePrice().checkedAt }
        : { providerId: record.providerId, model: `explicit-${index}`, inputUSDPerMillion: 1, outputUSDPerMillion: 2, updatedAt: referencePrice().checkedAt });
    });
    const before = f.repo.snapshot().usageRates;
    const catalog = Array.from({ length: 1200 }, (_, index) => catalogRate(record.providerId, `automatic-${index}`));
    if (method === 'incremental') await expect(f.ledger.cacheRates(catalog)).resolves.toBeUndefined();
    else await expect(f.ledger.replaceCatalog(record.providerId, referencePrice().endpoint, catalog)).resolves.toBeUndefined();
    expect((await f.reopen()).snapshot().usageRates).toEqual(before);
  });

  it('evicts only an automatic price to make room for a manual save when 1000 API entries are cached', async () => {
    const f = await fixture(), record = f.record(); await registerProvider(f.repo, record.providerId);
    await f.ledger.cacheRates([catalogRate(record.providerId, 'synthetic', '2026-10-01T00:00:00.000Z'),
      ...Array.from({ length: 999 }, (_, index) => catalogRate(record.providerId, `automatic-${index}`))]);
    await expect(f.ledger.upsertRate({ providerId: record.providerId, model: 'manual-new', currency: 'CNY', inputPerMillion: 2, outputPerMillion: 6 })).resolves.toBeDefined();
    const saved = (await f.reopen()).snapshot().usageRates;
    expect(saved).toHaveLength(1000);
    expect(saved.filter(rate => 'price' in rate && rate.price.source === 'provider-api')).toHaveLength(999);
    expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'manual-new', price: expect.objectContaining({ source: 'manual', currency: 'CNY' }) }),
      expect.objectContaining({ model: 'synthetic' })]));
  });

  it('bounds the combined cache of multiple providers and keeps both current models', async () => {
    const f = await fixture(), providerA = randomUUID(), providerB = randomUUID();
    await registerProvider(f.repo, providerA); await registerProvider(f.repo, providerB);
    const catalog = (providerId: string) => [catalogRate(providerId, 'synthetic', '2026-10-01T00:00:00.000Z'),
      ...Array.from({ length: 599 }, (_, index) => catalogRate(providerId, `automatic-${index}`))];
    await f.ledger.cacheRates(catalog(providerA));
    await f.ledger.replaceCatalog(providerB, referencePrice().endpoint, catalog(providerB));
    const rates = (await f.reopen()).snapshot().usageRates;
    expect(rates).toHaveLength(1000);
    expect(rates.some(rate => rate.providerId === providerA && rate.model === 'synthetic')).toBe(true);
    expect(rates.some(rate => rate.providerId === providerB && rate.model === 'synthetic')).toBe(true);
  });
});
