import { z } from 'zod';
import type { ProviderUsageTokenDetails } from '../../shared/providers';

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Totals already have their protocol validation. Optional vendor metadata is
// decoded separately so malformed cache details cannot discard a valid reply.
export const inputTokenDetailsSchema = z.unknown().optional();
export const outputTokenDetailsSchema = z.unknown().optional();

export function providerUsageTokenDetails(input: unknown, output: unknown): ProviderUsageTokenDetails {
  const result: ProviderUsageTokenDetails = {};
  const read = (details: unknown, fields: Array<[string, 'cachedInputTokens' | 'cacheWriteInputTokens' | 'reasoningOutputTokens']>): void => {
    if (details == null) return;
    if (typeof details !== 'object' || Array.isArray(details)) { result.tokenDetailsInvalid = true; return; }
    for (const [wire, key] of fields) {
      const value = (details as Record<string, unknown>)[wire];
      if (value === undefined) continue;
      const parsed = tokenCount.nullable().safeParse(value);
      if (parsed.success) result[key] = parsed.data;
      else result.tokenDetailsInvalid = true;
    }
  };
  read(input, [['cached_tokens', 'cachedInputTokens'], ['cache_write_tokens', 'cacheWriteInputTokens']]);
  read(output, [['reasoning_tokens', 'reasoningOutputTokens']]);
  return result;
}

/** Later partial usage must not discard a previously observed subtotal. */
export function mergeProviderUsageTokenDetails(previous: ProviderUsageTokenDetails, next: ProviderUsageTokenDetails): ProviderUsageTokenDetails {
  const merged: ProviderUsageTokenDetails = { ...previous };
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const) {
    if (next[key] !== undefined) merged[key] = next[key] ?? previous[key] ?? null;
  }
  if (next.tokenDetailsInvalid) merged.tokenDetailsInvalid = true;
  return merged;
}

export function providerReportedCostUSD(usage: { cost?: unknown; cost_currency?: unknown }, implicitUSD = false): number | null {
  // OpenRouter's official account-credit unit is USD. The caller must bind this
  // exception to its exact official service; an explicit other currency wins.
  const usd = usage.cost_currency === 'USD' || (usage.cost_currency === undefined && implicitUSD);
  return usd && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 && usage.cost <= 1e12 ? usage.cost : null;
}
