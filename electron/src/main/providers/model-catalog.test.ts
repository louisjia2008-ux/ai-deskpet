import { describe, expect, it, vi } from 'vitest';

import type { ProviderConfig } from '../../shared';
import { OpenAICompatibleAdapter, ProviderHttpError } from './openai-compatible';
import { attachModelPricing, getModelPricing, openRouterRatePerMillion, parseProviderModels, providerModelListPath } from './model-catalog';

const config = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: '0e5e71f9-5987-486d-bb03-f75c4c693783', kind: 'openrouter', name: 'Synthetic catalog',
  baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/chat', enabled: true,
  supportsTools: true, secretState: 'configured', ...patch,
});
const checkedAt = '2026-10-30T12:00:00.000Z';
const fetchResponse = (body: unknown, status = 200): typeof fetch => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
}));

describe('provider model catalog', () => {
  it('converts explicit decimal USD/token rates, preserving explicit zero', () => {
    expect(openRouterRatePerMillion('0')).toBe(0);
    expect(openRouterRatePerMillion('0.0000003')).toBeCloseTo(0.3);
    expect(openRouterRatePerMillion('1.25e-6')).toBe(1.25);
    expect(openRouterRatePerMillion('0.000002')).toBe(2);
  });

  it.each([undefined, null, '', ' ', ' 0', '0 ', '-1', '-0', 'NaN', 'Infinity', '1e999', '1e-999', '100000000', 0, 1, false, [], {}])('does not coerce invalid/unknown rate %j to free', (input) => {
    expect(openRouterRatePerMillion(input)).toBeNull();
  });

  it('projects only bounded metadata, removes duplicate IDs and sorts independently of price', () => {
    const models = parseProviderModels({ data: [
      { id: 'z', name: 'Z display', context_length: 131072, supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0', completion: '0.000002' }, ignoredSecret: 'must-not-return' },
      { id: 'a', name: 'A display', supported_parameters: ['temperature'], pricing: { prompt: '0.000001', completion: null } },
      { id: 'z', name: 'Duplicate with contradictory price', pricing: { prompt: '123', completion: '123' } },
    ], ignoredSecret: 'must-not-return' }, config(), checkedAt);
    expect(models.map((model) => model.id)).toEqual(['a', 'z']);
    expect(models[1]).toMatchObject({ displayName: 'Z display', contextWindow: 131072, supportsTools: true, availability: 'provider-listed',
      pricing: { currency: 'USD', source: 'provider-api', sourceUrl: 'https://openrouter.ai/api/v1/models/user', checkedAt, inputPerMillion: 0, outputPerMillion: 2 } });
    expect(models[0]).toMatchObject({ supportsTools: false, pricing: { inputPerMillion: 1, outputPerMillion: null } });
    expect(JSON.stringify(models)).not.toContain('must-not-return');
    expect(models[1]?.pricing?.note).toContain('overrides');
  });

  it('does not attest OpenRouter tool support from missing or invalid metadata', () => {
    const models = parseProviderModels({ data: [{ id: 'missing' }, { id: 'invalid', supported_parameters: 'tools' }, { id: 'valid', supported_parameters: ['tools'] }] }, config(), checkedAt);
    expect(models.map((model) => [model.id, model.supportsTools])).toEqual([['invalid', false], ['missing', false], ['valid', true]]);
    expect(parseProviderModels({ data: [{ id: 'tools', supported_parameters: ['tools'] }] }, config({ supportsTools: false }))[0]?.supportsTools).toBe(false);
  });

  it('retains OpenRouter cache read/write token prices without converting missing rates to zero', () => {
    const models = parseProviderModels({ data: [
      { id: 'cached', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001', input_cache_write: '0.0000025', request: '0' } },
      { id: 'missing', pricing: { prompt: '0', completion: '0' } },
      { id: 'invalid', pricing: { prompt: '0', completion: '0', input_cache_read: '', input_cache_write: '-1' } },
    ] }, config());
    expect(models[0]?.pricing?.cachedInputPerMillion).toBeCloseTo(0.1);
    expect(models[0]?.pricing?.cacheWriteInputPerMillion).toBe(2.5);
    expect(models[0]?.pricing?.unsupportedReason).toBeUndefined();
    for (const model of models.slice(1)) expect(model.pricing).toMatchObject({ cachedInputPerMillion: null, cacheWriteInputPerMillion: null });
  });

  it.each([
    { request: '0.000001' },
    { request: null },
    { internal_reasoning: '0.00001' },
    { web_search: '0.01' },
    { tiers: [{ threshold: 272000, prompt: '0.000004' }] },
  ])('marks additional OpenRouter billing dimensions as unsupported: %j', (extras) => {
    const model = parseProviderModels({ data: [{ id: 'extra-billing', pricing: { prompt: '0.000002', completion: '0.00001', ...extras } }] }, config())[0];
    expect(model?.pricing).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10 });
    expect(model?.pricing?.unsupportedReason).toContain('Additional provider charges');
  });

  it('excludes explicit non-text input/output without inventing missing modalities', () => {
    const models = parseProviderModels({ data: [
      { id: 'image-only', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      { id: 'audio-only', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
      { id: 'text', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'unknown' },
    ] }, config());
    expect(models.map((model) => model.id)).toEqual(['text', 'unknown']);
  });

  it.each([
    { kind: 'openai-compatible' as const, baseUrl: 'https://openrouter.ai/api/v1' },
    { kind: 'openrouter' as const, baseUrl: 'https://proxy.example/api/v1' },
    { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/other' },
    { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai:444/api/v1' },
    { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1' },
  ])('never treats compatible/proxy/local pricing as official OpenRouter prices: %j', (patch) => {
    const models = parseProviderModels({ data: [{ id: 'synthetic', pricing: { prompt: '0', completion: '0' } }] }, config(patch));
    expect(models[0]?.pricing).toBeUndefined();
  });

  it('keeps malformed optional metadata unknown and allows declared generic tools policy', () => {
    const models = parseProviderModels({ data: [{ id: 'synthetic', name: '\nunsafe', context_length: -1, context_window: '8192', supported_parameters: null, pricing: null }] }, config({ kind: 'openai' }), checkedAt);
    expect(models[0]).toEqual({ id: 'synthetic', displayName: 'synthetic', contextWindow: null, supportsTools: true, availability: 'provider-listed' });
  });

  it.each(['', ' ', ' leading', 'trailing ', 'bad\nmodel', 'bad\u0000model', 'bad\u007fmodel', 'x'.repeat(241)])('rejects unsafe ID %j rather than changing its identity', (id) => {
    expect(() => parseProviderModels({ data: [{ id }] }, config())).toThrow();
  });

  it('keeps the existing total-model bound and requires a data envelope', () => {
    expect(() => parseProviderModels({ data: Array.from({ length: 10001 }, (_, index) => ({ id: `model-${index}` })) }, config())).toThrow();
    expect(() => parseProviderModels([{ id: 'synthetic' }], config())).toThrow();
  });

  it('uses the authenticated user catalog only for OpenRouter and sends no generation', async () => {
    const fetcher = fetchResponse({ data: [{ id: 'synthetic/chat', pricing: { prompt: '0.000001', completion: '0.000002' } }] });
    const adapter = new OpenAICompatibleAdapter({ config: config(), apiKey: 'fake-synthetic-key' }, fetcher);
    const result = await adapter.listModels();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models/user', expect.objectContaining({ method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ authorization: 'Bearer fake-synthetic-key' }) }));
    expect(result[0]?.pricing).toMatchObject({ inputPerMillion: 1, outputPerMillion: 2 });
    expect(providerModelListPath(config({ kind: 'openai' }))).toBe('/models');
    expect(providerModelListPath(config({ kind: 'ollama' }))).toBe('/models');
  });

  it('does not fall back to a public catalog on account authentication failure or leak upstream material', async () => {
    const fetcher = fetchResponse({ error: 'private-account-detail', apiKey: 'fake-synthetic-key' }, 401);
    const error: unknown = await new OpenAICompatibleAdapter({ config: config(), apiKey: 'fake-synthetic-key' }, fetcher).listModels().catch((cause: unknown) => cause);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ code: 'provider.authentication', status: 401 });
    expect(String(error)).not.toContain('private-account-detail');
    expect(String(error)).not.toContain('fake-synthetic-key');
  });

  it('preserves the 4 MiB response limit before parsing', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)));
    await expect(new OpenAICompatibleAdapter({ config: config(), apiKey: null }, fetcher).listModels()).rejects.toThrow('size limit');
  });

  it.each([
    [401, {}, 'provider.authentication'],
    [403, { error: { message: 'PRIVATE_BODY' } }, 'provider.permissionDenied'],
    [429, { error: { code: 'credit_balance_exhausted', message: 'PRIVATE_BODY' } }, 'provider.quota'],
    [429, { error: { code: 'project_spend_limit_exceeded' } }, 'provider.quota'],
    [429, { error: { type: 'insufficient_quota' } }, 'provider.quota'],
    [429, { error: { code: 'rate_limit_exceeded', type: 'insufficient_quota' } }, 'provider.rateLimit'],
    [429, { error: { code: 'slow_down' } }, 'provider.rateLimit'],
    [429, { error: { code: 'unknown_PRIVATE_BODY' } }, 'provider.limitUnknown'],
  ])('classifies catalog HTTP %s from bounded safe metadata without exposing the body', async (status, body, code) => {
    const fetcher = fetchResponse(body, status as number);
    const error: unknown = await new OpenAICompatibleAdapter({ config: config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), apiKey: 'fake-synthetic-key' }, fetcher).listModels().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain('PRIVATE_BODY');
    expect(String(error)).not.toContain('fake-synthetic-key');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps oversized or non-JSON 429 bodies unclassified rather than guessing a rate or billing problem', async () => {
    for (const body of ['private invalid JSON', ' '.repeat(8_193)]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 429 }));
      await expect(new OpenAICompatibleAdapter({ config: config(), apiKey: 'synthetic-key' }, fetcher).listModels()).rejects.toMatchObject({ code: 'provider.limitUnknown', status: 429 });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('distinguishes no HTTP response from an unsupported HTTP 200 model catalog', async () => {
    const offline = vi.fn<typeof fetch>(async () => { throw new TypeError('PRIVATE_NETWORK_DETAILS'); });
    await expect(new OpenAICompatibleAdapter({ config: config(), apiKey: 'synthetic-key' }, offline).listModels()).rejects.toThrow(/^provider.network$/u);
    for (const body of ['not JSON PRIVATE_BODY', JSON.stringify({ unexpected: 'PRIVATE_BODY' })]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
      await expect(new OpenAICompatibleAdapter({ config: config(), apiKey: 'synthetic-key' }, fetcher).listModels()).rejects.toThrow(/^provider.catalogInvalid$/u);
    }
  });

  it('preserves caller cancellation and the metadata timeout signal', async () => {
    const signals: AbortSignal[] = [];
    const fetcher: typeof fetch = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Missing signal');
      signals.push(signal);
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const abort = new AbortController();
    const pending = new OpenAICompatibleAdapter({ config: config(), apiKey: null }, fetcher, 5000).listModels(abort.signal);
    abort.abort(new Error('synthetic caller cancelled'));
    await expect(pending).rejects.toThrow('synthetic caller cancelled');
    await expect(new OpenAICompatibleAdapter({ config: config(), apiKey: null }, fetcher, 10).listModels()).rejects.toThrow('timed out');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('adds dated official reference prices only for exact IDs without adding models or attesting availability', () => {
    const models = [{ id: 'gpt-4.1-mini', displayName: 'Explicit manual entry', contextWindow: null, supportsTools: false, availability: 'reference' as const }];
    const result = attachModelPricing(config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), models);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'gpt-4.1-mini', availability: 'reference', pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6,
      cachedInputPerMillion: 0.1, currency: 'USD', source: 'reference', checkedAt: '2026-11-02T10:52:53.000Z', sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini' } });
    expect(result[0]?.pricing?.note).toContain('deprecated');
    expect(models[0]).not.toHaveProperty('pricing');
    expect(attachModelPricing(config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), [])).toEqual([]);
  });

  it('never applies official reference prices to aliases, proxies or unrelated provider kinds', () => {
    const models = [{ id: 'gpt-4.1-mini-2025-04-14', displayName: 'Alias', contextWindow: null, supportsTools: false }];
    expect(attachModelPricing(config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), models)[0]?.pricing).toBeUndefined();
    const exact = [{ ...models[0]!, id: 'gpt-4.1-mini' }];
    for (const patch of [
      { kind: 'openai' as const, baseUrl: 'https://proxy.example/v1' },
      { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' },
      { kind: 'openai' as const, baseUrl: 'https://api.openai.com/other' },
    ]) expect(attachModelPricing(config(patch), exact)[0]?.pricing).toBeUndefined();
  });

  it.each([
    ['gpt-6-astra', 10, 50, 1, 12.5],
    ['gpt-6.1-sol', 2, 10, 0.1, 2.5],
    ['gpt-6.1-terra', 1, 5, 0.05, 1.25],
    ['gpt-6-luna', 0.1, 0.5, 0.01, 0.125],
  ] as const)('resolves %s standard, cache and whole-request long-context rates without fetching a model catalog', (model, input, output, cached, write) => {
    const pricing = getModelPricing(config({ kind: 'openai', baseUrl: 'https://api.openai.com:443/v1/' }), model);
    expect(pricing).toMatchObject({ currency: 'USD', inputPerMillion: input, outputPerMillion: output, cachedInputPerMillion: cached,
      cacheWriteInputPerMillion: write, source: 'reference', sourceUrl: `https://developers.openai.com/api/docs/models/${model}`,
      longContext: { inputThreshold: 272000, inputPerMillion: input * 2, outputPerMillion: output * 1.5,
        cachedInputPerMillion: cached * 2, cacheWriteInputPerMillion: write * 2 } });
    expect(pricing?.unsupportedReason).toBeUndefined();
    expect(pricing?.note).toContain('30-minute retention');
    expect(pricing?.note).toContain('12-hour retention is excluded');
  });

  it.each([
    'https://proxy.example/v1', 'https://eu.api.openai.com/v1', 'https://api.openai.com:444/v1',
    'https://user:secret@api.openai.com/v1', 'https://api.openai.com/v1?region=us', 'https://api.openai.com/v1#fragment',
    'https://api.openai.com/v1/other', 'http://api.openai.com/v1', 'invalid-url',
  ])('returns no reference price for a non-exact endpoint: %s', (baseUrl) => {
    expect(getModelPricing(config({ kind: 'openai', baseUrl }), 'gpt-6.1-terra')).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', 'toString', 'gpt-6.1-terra-2026-10-01', 'GPT-6.1-Terra', 'unknown'])('never infers pricing from a non-catalog ID: %s', (model) => {
    expect(getModelPricing(config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), model)).toBeUndefined();
  });

  it('does not share mutable rate or tier data between requests', () => {
    const official = config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' });
    const first = getModelPricing(official, 'gpt-6.1-terra');
    if (!first?.longContext) throw new Error('Missing synthetic expected price');
    first.inputPerMillion = 999;
    first.longContext.inputPerMillion = 999;
    expect(getModelPricing(official, 'gpt-6.1-terra')).toMatchObject({ inputPerMillion: 1, longContext: { inputPerMillion: 2 } });
  });

  it('keeps GLM references in CNY and never performs currency conversion', () => {
    const result = parseProviderModels({ data: [{ id: 'glm-5.3' }] }, config({ kind: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }));
    expect(result[0]?.pricing).toMatchObject({ currency: 'CNY', inputPerMillion: 8, outputPerMillion: 28, cachedInputPerMillion: 2, source: 'reference' });
  });

  it('keeps time-dependent DeepSeek prices unknown and resolves MiniMax standard context tiers', () => {
    const deepseek = parseProviderModels({ data: [{ id: 'deepseek-v4-pro' }] }, config({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }));
    expect(deepseek[0]?.pricing).toMatchObject({ inputPerMillion: null, outputPerMillion: null, source: 'reference', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' });
    expect(deepseek[0]?.pricing?.note).toContain('peak/off-peak');
    expect(deepseek[0]?.pricing?.unsupportedReason).toContain('Chinese public holidays');
    const minimax = parseProviderModels({ data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3.1-Flash' }] }, config({ kind: 'minimax', baseUrl: 'https://api.minimax.io/v1' }));
    expect(minimax[0]?.pricing).toMatchObject({ inputPerMillion: 0.3, outputPerMillion: 1.2, cachedInputPerMillion: 0.06,
      longContext: { inputThreshold: 512000, inputPerMillion: 0.6, outputPerMillion: 2.4, cachedInputPerMillion: 0.12 } });
    expect(minimax[1]?.pricing).toMatchObject({ inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.015 });
  });

  it('excludes only clearly non-chat official OpenAI models and honors explicit direct modalities', () => {
    const ids = ['gpt-4.1-mini', 'whisper-1', 'tts-1', 'dall-e-3', 'text-embedding-3-small', 'gpt-image-1', 'gpt-4o-realtime-preview', 'gpt-4o-transcribe'];
    const official = config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' });
    expect(parseProviderModels({ data: ids.map((id) => ({ id })) }, official).map((model) => model.id)).toEqual(['gpt-4.1-mini']);
    expect(parseProviderModels({ data: [{ id: 'my-transcribe-text-model' }] }, config({ kind: 'openai-compatible', baseUrl: 'https://proxy.example/v1' }))).toHaveLength(1);
    expect(parseProviderModels({ data: [{ id: 'explicit-non-text', output_modalities: ['image'] }] }, official)).toEqual([]);
  });
});
