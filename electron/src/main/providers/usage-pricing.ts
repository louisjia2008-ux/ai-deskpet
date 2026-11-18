import type { ModelPricing, ProviderConfig, ProviderModel, UsagePriceSnapshot, UsageRate } from '../../shared';
import { usagePriceSnapshotSchema } from '../../shared/automation-schemas';
import { getModelPricing } from './model-catalog';
import { normalizedProviderBaseUrl } from './request-budget';

/** Exact endpoint and model identity is as important as the displayed model name.
 * A proxy may charge a different price for an identically named model. */
export const usagePriceFromCatalog = (provider: ProviderConfig, pricing: ModelPricing): UsagePriceSnapshot | undefined => {
  if (pricing.unsupportedReason || pricing.inputPerMillion === null || pricing.outputPerMillion === null) return undefined;
  if (![pricing.inputPerMillion, pricing.outputPerMillion].every(value => Number.isFinite(value) && value >= 0)) return undefined;
  const snapshot = {
    currency: pricing.currency, inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion,
    ...(pricing.cachedInputPerMillion === undefined ? {} : { cachedInputPerMillion: pricing.cachedInputPerMillion }),
    ...(pricing.cacheWriteInputPerMillion === undefined ? {} : { cacheWriteInputPerMillion: pricing.cacheWriteInputPerMillion }),
    ...(pricing.longContext === undefined ? {} : { longContext: structuredClone(pricing.longContext) }),
    source: pricing.source, sourceUrl: pricing.sourceUrl, checkedAt: pricing.checkedAt,
    endpoint: normalizedProviderBaseUrl(provider).toString(),
    ...(pricing.note === undefined ? {} : { note: pricing.note }),
  };
  const parsed = usagePriceSnapshotSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : undefined;
};

export const referenceUsagePrice = (provider: ProviderConfig, model: string): UsagePriceSnapshot | undefined => {
  const pricing = getModelPricing(provider, model);
  return pricing === undefined ? undefined : usagePriceFromCatalog(provider, pricing);
};

export const usageRatesFromModels = (provider: ProviderConfig, models: readonly ProviderModel[]): UsageRate[] => models.flatMap(model => {
  if (model.pricing?.source !== 'provider-api') return [];
  const price = usagePriceFromCatalog(provider, model.pricing);
  return price === undefined ? [] : [{ providerId: provider.id, model: model.id, price, updatedAt: price.checkedAt }];
});
