import type { ProviderKind } from './contracts';

/** Dated token rates may support estimates, never a provider bill or usage receipt. */
export interface ModelPricing {
  currency: 'USD' | 'CNY';
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedInputPerMillion?: number | null | undefined;
  cacheWriteInputPerMillion?: number | null | undefined;
  /** Applies to the full request when input tokens are strictly above the threshold. */
  longContext?: {
    inputThreshold: number;
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion?: number | null | undefined;
    cacheWriteInputPerMillion?: number | null | undefined;
  } | undefined;
  /** A known billing condition prevents deriving a complete token-cost estimate. */
  unsupportedReason?: string | undefined;
  source: 'provider-api' | 'reference';
  sourceUrl: string;
  checkedAt: string;
  note?: string | undefined;
}

/** Draft discovery is ephemeral: it must not persist a key or change a binding. */
export interface ProviderDiscoveryInput {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string | undefined;
  existingProviderId?: string | undefined;
}
