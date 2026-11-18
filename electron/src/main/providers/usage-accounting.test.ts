// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, ProviderRequestObservation } from '../../shared';
import { providerRequestObservationSchema } from '../domain/schemas';
import { providerUtilityResponseSchema } from '../../utility/provider-protocol';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { providerBindingFingerprint } from './request-budget';
import type { ProviderStreamEvent } from './types';

const config = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: randomUUID(), kind: 'lm-studio', name: 'Synthetic usage fixture',
  baseUrl: 'http://127.0.0.1:1234/v1', model: 'synthetic-usage', enabled: true, supportsTools: false, secretState: 'missing', ...patch });
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const chat = (usage: unknown, done = true): string => frame({ choices: [{ delta: { content: 'SYNTHETIC_USAGE_REPLY' }, finish_reason: done ? 'stop' : null }], usage }) + (done ? 'data: [DONE]\n\n' : '');
const responses = (usage: unknown, failed = false): string => frame({ type: failed ? 'response.failed' : 'response.completed',
  response: { status: failed ? 'failed' : 'completed', output: [], usage, ...(failed ? { error: { code: 'server_error' } } : {}) } });
const run = async (provider: ProviderConfig, sse: string, wireProtocol?: 'responses') => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
  const events: ProviderStreamEvent[] = []; let error: unknown;
  try {
    for await (const event of new OpenAICompatibleAdapter({ config: provider, apiKey: 'SYNTHETIC_ONLY' }, fetcher).streamChat({
      model: provider.model, messages: [{ role: 'user', content: 'Synthetic accounting only' }], maxOutputTokens: 64,
      outputTokenParameter: provider.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens',
      contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' },
      identity: { requestId: randomUUID(), bindingDigest: providerBindingFingerprint(provider, provider.model) },
      ...(wireProtocol ? { wireProtocol } : {}),
    })) events.push(event);
  } catch (caught) { error = caught; }
  const observations = events.flatMap(event => event.type === 'request-observation' ? [event.observation] : []);
  for (const event of events) expect(providerUtilityResponseSchema.safeParse({ version: 1, kind: 'provider:event', requestId: randomUUID(), event }).success).toBe(true);
  for (const observation of observations) expect(providerRequestObservationSchema.parse(observation)).toEqual(observation);
  return { events, error, fetcher, observations, terminal: observations.at(-1)! };
};

describe('provider usage subtotals survive the adapter and both strict boundaries', () => {
  it('keeps Chat cache read/write and reasoning as subtotals, including an interrupted stream after usage', async () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 80 } };
    const result = await run(config(), chat(usage));
    expect(result.error).toBeUndefined();
    expect(result.terminal.usage).toMatchObject({ inputTokens: 1200, outputTokens: 200, cachedInputTokens: 500, cacheWriteInputTokens: 300, reasoningOutputTokens: 80, source: 'provider-reported' });
    expect(result.fetcher).toHaveBeenCalledOnce();
    const interrupted = await run(config(), chat(usage, false));
    expect(interrupted.error).toBeInstanceOf(Error);
    expect(interrupted.terminal).toMatchObject({ phase: 'terminal', outcome: 'failed', usage: result.terminal.usage });
  });

  it('keeps prior subtotal observations when later Chat usage omits details or returns null', async () => {
    const first = frame({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 3 } } });
    const result = await run(config(), first + chat({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: null } }));
    expect(result.terminal.usage).toMatchObject({ inputTokens: 1000, outputTokens: 20, cachedInputTokens: 600, cacheWriteInputTokens: 0, reasoningOutputTokens: 3 });
  });

  it.each([false, true])('keeps Responses details and explicit USD cost for completed/failed=%s', async failed => {
    const provider = config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra' });
    const result = await run(provider, responses({ input_tokens: 1200, output_tokens: 200,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 300 }, output_tokens_details: { reasoning_tokens: 80 }, cost: 0.009, cost_currency: 'USD' }, failed), 'responses');
    expect(result.terminal.usage).toEqual({ inputTokens: 1200, outputTokens: 200, cachedInputTokens: 500, cacheWriteInputTokens: 300,
      reasoningOutputTokens: 80, reportedCostUSD: 0.009, source: 'provider-reported' });
    expect(result.terminal.outcome).toBe(failed ? 'failed' : 'completed');
    expect(result.fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
  });

  it('keeps absent details absent and distinguishes explicitly reported zero details', async () => {
    const missing = await run(config(), chat({ prompt_tokens: 100, completion_tokens: 20 }));
    expect(missing.terminal.usage).not.toHaveProperty('cachedInputTokens');
    expect(missing.terminal.usage).not.toHaveProperty('reasoningOutputTokens');
    const zero = await run(config(), chat({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }));
    expect(zero.terminal.usage).toMatchObject({ cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 });
  });

  it.each([{ cached_tokens: '400' }, { cached_tokens: -1 }, { cache_write_tokens: 0.5 }, ['invalid-details']])('does not let malformed optional cache metadata stop a valid Chat reply: %j', async details => {
    const result = await run(config(), chat({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: details }));
    expect(result.error).toBeUndefined();
    expect(result.terminal).toMatchObject({ outcome: 'completed', usage: { inputTokens: 1000, outputTokens: 200, tokenDetailsInvalid: true } });
    expect(result.terminal.usage).not.toHaveProperty('cachedInputTokens');
  });

  it('preserves invalid optional Responses metadata without discarding totals or a provider-reported amount', async () => {
    const provider = config({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra' });
    const result = await run(provider, responses({ input_tokens: 1000, output_tokens: 200, output_tokens_details: { reasoning_tokens: 'bad' }, cost: 0, cost_currency: 'USD' }), 'responses');
    expect(result.error).toBeUndefined();
    expect(result.terminal.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, tokenDetailsInvalid: true, reportedCostUSD: 0 });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid subtotal %s at utility and persistence boundaries', value => {
    const observation: ProviderRequestObservation = { requestId: randomUUID(), bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 1,
      phase: 'terminal', httpStatus: 200, outcome: 'completed', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, source: 'provider-reported', cachedInputTokens: value } };
    expect(providerRequestObservationSchema.safeParse(observation).success).toBe(false);
    expect(providerUtilityResponseSchema.safeParse({ version: 1, kind: 'provider:event', requestId: randomUUID(), event: { type: 'request-observation', observation } }).success).toBe(false);
  });
});

describe('OpenRouter native cost is USD only for its exact official service', () => {
  it.each(['https://openrouter.ai/api/v1', 'https://openrouter.ai:443/api/v1/'])('accepts currency-omitted native cost at %s', async baseUrl => {
    const result = await run(config({ kind: 'openrouter', baseUrl }), chat({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0123 }));
    expect(result.terminal.usage.reportedCostUSD).toBe(0.0123);
  });
  it.each([
    { kind: 'openai-compatible' as const, baseUrl: 'https://openrouter.ai/api/v1' },
    { kind: 'openrouter' as const, baseUrl: 'https://proxy.example/api/v1' },
    { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai:8443/api/v1' },
    { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v2' },
  ])('does not infer currency for $kind $baseUrl', async patch => {
    const result = await run(config(patch), chat({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0123 }));
    expect(result.terminal.usage.reportedCostUSD ?? null).toBeNull();
  });
  it('does not override an explicit other currency even at the official service', async () => {
    const result = await run(config({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), chat({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0123, cost_currency: 'CNY' }));
    expect(result.terminal.usage.reportedCostUSD ?? null).toBeNull();
  });
});
