import { z } from 'zod';

import type { ModelPricing, ProviderConfig, ProviderModel } from '../../shared';

const modelId = z.string().min(1).max(240).refine((value) => value.trim() === value
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const modelListSchema = z.object({
  data: z.array(z.object({ id: modelId }).passthrough()).max(10_000),
}).passthrough();

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const safeText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 240
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const textArray = (value: unknown): string[] | null => Array.isArray(value) && value.length <= 64
  && value.every((item) => typeof item === 'string' && item.length <= 64) ? value as string[] : null;
const contextWindow = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** API token rates are decimal strings in USD/token. Missing and invalid values
 * remain unknown; neither JavaScript coercion nor underflow may create "free". */
export const openRouterRatePerMillion = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || (rate === 0 && /[1-9]/u.test(value.split(/[eE]/u)[0] ?? ''))) return null;
  const perMillion = rate * 1_000_000;
  return Number.isFinite(perMillion) && perMillion <= 1e12 ? perMillion : null;
};

const officialOpenRouter = (config: ProviderConfig): boolean => {
  return config.kind === 'openrouter' && officialEndpoint(config, 'openrouter.ai', '/api/v1');
};

const referenceCheckedAt = '2026-11-02T10:52:53.000Z';
const standardText = 'Standard online text token estimate. Excludes Batch/Flex/Fast, regional tiers, tools, media, tax and account discounts. Reference, not a bill.';
const openAIReference: Readonly<Record<string, { input: number; output: number; cachedInput: number; cacheWriteInput?: number; deprecated?: boolean; longContext?: boolean }>> = {
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5, deprecated: true },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1, deprecated: true },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25, deprecated: true },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075, deprecated: true },
  'gpt-6-astra': { input: 10, output: 50, cachedInput: 1, cacheWriteInput: 12.5, longContext: true },
  'gpt-6.1-sol': { input: 2, output: 10, cachedInput: 0.1, cacheWriteInput: 2.5, longContext: true },
  'gpt-6.1-terra': { input: 1, output: 5, cachedInput: 0.05, cacheWriteInput: 1.25, longContext: true },
  'gpt-6-luna': { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWriteInput: 0.125, longContext: true },
};
const glmReference: Readonly<Record<string, { input: number; output: number; cachedInput: number }>> = {
  'glm-5.3': { input: 8, output: 28, cachedInput: 2 },
  'glm-5.3-flash': { input: 0.8, output: 2.8, cachedInput: 0.23 },
  'glm-5.3-flashx': { input: 2, output: 7, cachedInput: 0.57 },
};

const officialEndpoint = (config: ProviderConfig, hostname: string, pathname: string): boolean => {
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'https:' && url.hostname === hostname && (url.port === '' || url.port === '443')
      && url.pathname.replace(/\/+$/u, '') === pathname && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
};

/** No catalog fetch is needed for an exact official endpoint and known model ID.
 * Never infer a price for a proxy, regional endpoint, alias or unknown model. */
export const getModelPricing = (config: ProviderConfig, model: string): ModelPricing | undefined => {
  if (config.kind === 'openai' && officialEndpoint(config, 'api.openai.com', '/v1')) {
    const rate = Object.hasOwn(openAIReference, model) ? openAIReference[model] : undefined;
    if (!rate) return undefined;
    return { currency: 'USD', inputPerMillion: rate.input, outputPerMillion: rate.output, cachedInputPerMillion: rate.cachedInput,
      ...(rate.cacheWriteInput === undefined ? {} : { cacheWriteInputPerMillion: rate.cacheWriteInput }),
      ...(rate.longContext ? { longContext: { inputThreshold: 272_000, inputPerMillion: rate.input * 2,
        outputPerMillion: rate.output * 1.5, cachedInputPerMillion: rate.cachedInput * 2,
        ...(rate.cacheWriteInput === undefined ? {} : { cacheWriteInputPerMillion: rate.cacheWriteInput * 2 }) } } : {}),
      source: 'reference', sourceUrl: `https://developers.openai.com/api/docs/models/${model}`,
      checkedAt: referenceCheckedAt,
      note: `${standardText}${rate.longContext ? ' Above 272,000 input tokens, long-context rates apply to the whole request. Cache write rates assume 30-minute retention; 12-hour retention is excluded.' : ''}${rate.deprecated ? ' Official page marks this model deprecated; listing is not proof of current access.' : ''}` };
  }
  if (config.kind === 'glm' && officialEndpoint(config, 'open.bigmodel.cn', '/api/paas/v4')) {
    const rate = Object.hasOwn(glmReference, model) ? glmReference[model] : undefined;
    if (!rate) return undefined;
    return { currency: 'CNY', inputPerMillion: rate.input, outputPerMillion: rate.output, cachedInputPerMillion: rate.cachedInput, source: 'reference',
      sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', checkedAt: referenceCheckedAt,
      note: 'China standard API text; cache storage is currently waived. Media, tools and subscription quotas excluded. CNY; no currency conversion. Reference, not a bill.' };
  }
  if (config.kind === 'minimax' && officialEndpoint(config, 'api.minimax.io', '/v1')) {
    if (model === 'MiniMax-M3.1-Flash') return { currency: 'USD', inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.015, source: 'reference',
      sourceUrl: 'https://platform.minimax.io/docs/pricing/overview', checkedAt: referenceCheckedAt,
      note: 'Standard online text. Subscriptions, cache writes, tools, media, tax and other rates excluded. Reference, not a bill.' };
    if (model === 'MiniMax-M3') return { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2, cachedInputPerMillion: 0.06,
      longContext: { inputThreshold: 512_000, inputPerMillion: 0.6, outputPerMillion: 2.4, cachedInputPerMillion: 0.12 }, source: 'reference',
      sourceUrl: 'https://platform.minimax.io/docs/pricing/overview', checkedAt: referenceCheckedAt,
      note: 'Standard online text with the published permanent discount; above 512,000 input tokens the higher tier applies. Priority, subscriptions, cache writes, tools, media and tax excluded. Reference, not a bill.' };
  }
  if (config.kind === 'deepseek' && officialEndpoint(config, 'api.deepseek.com', '/v1') && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    return { currency: 'USD', inputPerMillion: null, outputPerMillion: null, source: 'reference',
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', checkedAt: referenceCheckedAt,
      unsupportedReason: 'Peak/off-peak prices depend on request time and Chinese public holidays; time-based pricing is not supported.',
      note: 'Tiered prices depend on peak/off-peak time and cache hits/misses. No single unconditional input/output rate; see official price table.' };
  }
  return undefined;
};

/** Enrich exact IDs only. A dated price reference never creates an account-
 * available model or changes a manual entry into an authenticated listing. */
export const attachModelPricing = (config: ProviderConfig, models: ProviderModel[]): ProviderModel[] => models.map((model) => {
  if (model.pricing !== undefined) return model;
  const pricing = getModelPricing(config, model.id);
  return pricing === undefined ? model : { ...model, pricing };
});

/** Never fall back from the account-filtered catalog to a public model list. */
export const providerModelListPath = (config: ProviderConfig): '/models/user' | '/models' => config.kind === 'openrouter' ? '/models/user' : '/models';

export const parseProviderModels = (value: unknown, config: ProviderConfig, checkedAt = new Date().toISOString()): ProviderModel[] => {
  const parsed = modelListSchema.parse(value);
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const item of parsed.data) {
    if (seen.has(item.id)) continue;
    // OpenAI's authenticated /models also lists endpoints that this text chat
    // adapter cannot invoke. This small exclusion applies only to that exact
    // official service; custom model names are not guessed from substrings.
    if (config.kind === 'openai' && officialEndpoint(config, 'api.openai.com', '/v1')
      && (/^(?:text-embedding-|whisper(?:-|$)|tts(?:-|$)|dall-e(?:-|$)|gpt-image(?:-|$)|chatgpt-image(?:-|$)|sora(?:-|$)|babbage(?:-|$)|davinci(?:-|$)|computer-use(?:-|$))/u.test(item.id)
        || /(?:^|-)(?:realtime|transcribe|transcription|tts)(?:$|-)/u.test(item.id))) continue;
    const architecture = object(item.architecture);
    const inputs = textArray(architecture?.input_modalities) ?? textArray(item.input_modalities);
    const outputs = textArray(architecture?.output_modalities) ?? textArray(item.output_modalities);
    // Chat accepts textual input and output. Explicit incompatible metadata is
    // excluded; absent metadata stays an unverified listed model.
    if ((inputs !== null && !inputs.includes('text')) || (outputs !== null && !outputs.includes('text'))) continue;
    seen.add(item.id);
    const supported = textArray(item.supported_parameters);
    const supportsTools = config.supportsTools && (supported !== null ? supported.includes('tools') : config.kind !== 'openrouter');
    let pricing: ModelPricing | undefined;
    if (officialOpenRouter(config)) {
      const raw = object(item.pricing);
      // Preserve only verified token units. A request fee, extra billing unit or
      // tier override cannot silently disappear from a purported total estimate.
      const tokenFields = new Set(['prompt', 'completion', 'input_cache_read', 'input_cache_write']);
      const unsupportedCharges = raw !== null && Object.entries(raw).some(([key, value]) => !tokenFields.has(key)
        && openRouterRatePerMillion(value) !== 0);
      pricing = {
        currency: 'USD',
        inputPerMillion: openRouterRatePerMillion(raw?.prompt),
        outputPerMillion: openRouterRatePerMillion(raw?.completion),
        cachedInputPerMillion: openRouterRatePerMillion(raw?.input_cache_read),
        cacheWriteInputPerMillion: openRouterRatePerMillion(raw?.input_cache_write),
        ...(unsupportedCharges ? { unsupportedReason: 'Additional provider charges or pricing tiers are not supported by the token-cost estimate.' } : {}),
        source: 'provider-api',
        sourceUrl: 'https://openrouter.ai/api/v1/models/user',
        checkedAt,
        note: 'Base token rates only. Tier/time overrides and per-request, media, search or reasoning charges may apply.',
      };
    }
    result.push({
      id: item.id,
      displayName: safeText(item.name) ? item.name : item.id,
      contextWindow: contextWindow(item.context_length) ?? contextWindow(item.context_window) ?? contextWindow(item.max_context_length),
      supportsTools,
      availability: 'provider-listed',
      ...(pricing === undefined ? {} : { pricing }),
    });
  }
  return attachModelPricing(config, result.sort((left, right) => left.id.localeCompare(right.id)));
};
