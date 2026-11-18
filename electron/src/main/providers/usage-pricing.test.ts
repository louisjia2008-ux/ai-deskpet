import { describe, expect, it } from 'vitest';
import type { ModelPricing, ProviderConfig } from '../../shared';
import { referenceUsagePrice, usagePriceFromCatalog, usageRatesFromModels } from './usage-pricing';

const provider: ProviderConfig = { id: '00000000-0000-4000-8000-000000000001', kind: 'openai', name: 'Synthetic official configuration', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', enabled: true, supportsTools: true, secretState: 'missing' };
const price: ModelPricing = { currency: 'CNY', inputPerMillion: 8, outputPerMillion: 28, cachedInputPerMillion: 2,
  source: 'provider-api', sourceUrl: 'https://catalog.example/pricing', checkedAt: '2026-11-02T00:00:00.000Z' };

describe('catalog prices reach usage accounting without provider access', () => {
  it('resolves an exact official model before any model-list discovery, without assigning its price to a proxy or alias', () => {
    const resolved = referenceUsagePrice(provider, provider.model);
    expect(resolved).toMatchObject({ currency: 'USD', inputPerMillion: 1, outputPerMillion: 5, endpoint: provider.baseUrl, source: 'reference' });
    expect(referenceUsagePrice({ ...provider, baseUrl: 'https://proxy.example/v1' }, provider.model)).toBeUndefined();
    expect(referenceUsagePrice({ ...provider, kind: 'openai-compatible' }, provider.model)).toBeUndefined();
    expect(referenceUsagePrice(provider, 'unverified-alias')).toBeUndefined();
  });
  it('keeps currency, source, cache prices and canonical endpoint, and rejects incomplete or unsupported tariffs', () => {
    expect(usagePriceFromCatalog({ ...provider, baseUrl: `${provider.baseUrl}/` }, price)).toEqual({ ...price, endpoint: provider.baseUrl });
    for (const patch of [{ inputPerMillion: null }, { outputPerMillion: null }, { inputPerMillion: Number.NaN }, { inputPerMillion: -1 }, { inputPerMillion: 1e12 },
      { cachedInputPerMillion: -1 }, { longContext: { inputThreshold: 0, inputPerMillion: 2, outputPerMillion: 5 } }, { unsupportedReason: 'Time-dependent tariff' }]) {
      expect(usagePriceFromCatalog(provider, { ...price, ...patch })).toBeUndefined();
    }
  });
  it('caches only API catalog prices and exact listed IDs, independently of the selected model', () => {
    const common = { displayName: 'Fixture', contextWindow: null, supportsTools: false };
    expect(usageRatesFromModels(provider, [{ ...common, id: 'catalog-id', pricing: price }, { ...common, id: 'no-price' }, { ...common, id: 'unsupported-price', pricing: { ...price, inputPerMillion: 1e12 } },
      { ...common, id: 'reference', pricing: { ...price, source: 'reference' } }])).toEqual([{ providerId: provider.id, model: 'catalog-id',
      price: { ...price, endpoint: provider.baseUrl }, updatedAt: price.checkedAt }]);
  });
});
