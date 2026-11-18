// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleAdapter } from './openai-compatible';
import { assertProviderRequestBinding, assertProviderRequestBudget, estimateProviderRequestInputTokens, prepareProviderChatRequest, providerBindingFingerprint } from './request-budget';
import { estimateSerializedInputTokens } from './input-token-estimate';
import { providerUtilityCommandSchema, providerUtilityResponseSchema } from '../../utility/provider-protocol';

import type { ProviderConfig, ProviderRequestObservation } from '../../shared';
import type { ProviderChatRequest, ProviderStreamEvent } from './types';

const config = (): ProviderConfig => ({
  id: randomUUID(), kind: 'ollama', name: 'Fixture', model: 'fixture',
  baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, supportsTools: true, secretState: 'missing',
  localExecutionConfirmed: true, contextWindowTokens: 8192, maxOutputTokens: 512, outputTokenParameter: 'max_tokens',
});
const request = (provider: ProviderConfig): ProviderChatRequest => ({
  model: 'fixture', messages: [{ role: 'user', content: '预算测试' }],
  maxOutputTokens: 512, outputTokenParameter: 'max_tokens',
  contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' },
  identity: { requestId: randomUUID(), bindingDigest: providerBindingFingerprint(provider, 'fixture') },
});
const chunk = (content: string, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
const collect = async (adapter: OpenAICompatibleAdapter, input: ProviderChatRequest, signal?: AbortSignal) => {
  const events: ProviderStreamEvent[] = [];
  let error: unknown;
  try { for await (const event of adapter.streamChat(input, signal)) events.push(event); } catch (caught) { error = caught; }
  return { events, error, observations: events.flatMap((event) => event.type === 'request-observation' ? [event.observation] : []) };
};

describe('Provider request budget and binding', () => {
  it('counts Unicode, mapped tool schemas, call arguments and results in the actual wire body', () => {
    const provider = config(); const input = request(provider);
    input.tools = [{ name: 'memory.lookup', description: '查询记忆', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    input.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'memory.lookup', argumentsJson: '{"query":"中文"}' }] }, { role: 'tool', content: '完整工具结果', toolCallId: 'call_1' });
    const prepared = prepareProviderChatRequest(input);
    expect(prepared.bodyText).toContain('memory_lookup');
    expect(prepared.bodyText).toContain('tool_call_id');
    expect(prepared.bodyText).toContain('完整工具结果');
    expect(prepared.bodySHA256).toBe(createHash('sha256').update(prepared.bodyText).digest('hex'));
    expect(prepared.inputEstimate).toBeGreaterThan(estimateSerializedInputTokens(prepared.bodyText));
    expect(estimateProviderRequestInputTokens(input)).toBe(prepared.inputEstimate);
    expect(assertProviderRequestBudget(input)).toEqual({ inputEstimate: prepared.inputEstimate, maxInputTokens: 8192 - 512 - 256 });
    expect(prepared.bodyText).not.toMatch(/requestId|bindingDigest|contextBudget|capacitySource/u);
  });

  it('fails before fetch when the required body cannot fit, including tool schemas', async () => {
    const provider = config(); const input = request(provider);
    input.tools = [{ name: 'required.tool', description: 'required tool schema '.repeat(8000), parameters: {} }];
    const fetcher = vi.fn<typeof fetch>();
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), input);
    expect(result.error).toMatchObject({ code: 'provider.contextBudgetExceeded' });
    expect(fetcher).not.toHaveBeenCalled(); expect(result.events).toEqual([]);
  });

  it.each([0, -1, 1.5, 8193, Number.NaN])('rejects invalid output bound %s without dispatch', async (bound) => {
    const provider = config(); const input = { ...request(provider), maxOutputTokens: bound };
    const fetcher = vi.fn<typeof fetch>();
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), input);
    expect(result.error).toMatchObject({ code: 'provider.invalidRequestBudget' }); expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds actual model, final endpoint and privacy/budget settings, but ignores display/default model edits', () => {
    const provider = config(); const digest = providerBindingFingerprint(provider, 'selected');
    expect(providerBindingFingerprint({ ...provider, name: 'renamed', model: 'different-default', baseUrl: `${provider.baseUrl}/` }, 'selected')).toBe(digest);
    for (const change of [{ baseUrl: 'http://127.0.0.1:11435/v1' }, { supportsTools: false }, { localExecutionConfirmed: false }, { contextWindowTokens: 4096 }, { maxOutputTokens: 1024 }, { outputTokenParameter: 'max_completion_tokens' as const }, { enabled: false }]) {
      expect(providerBindingFingerprint({ ...provider, ...change }, 'selected')).not.toBe(digest);
    }
    expect(providerBindingFingerprint(provider, 'other-model')).not.toBe(digest);
  });

  it('rejects a stale request identity before network and snapshots constructor config', async () => {
    const provider = config(); const input = request(provider);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'));
    const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
    provider.baseUrl = 'http://127.0.0.1:11435/v1';
    expect((await collect(adapter, input)).error).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
    fetcher.mockClear(); input.identity = { requestId: randomUUID(), bindingDigest: providerBindingFingerprint(provider, input.model) };
    expect((await collect(adapter, input)).error).toMatchObject({ message: 'provider.bindingMismatch' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends the selected output parameter exactly once and never retries an unsupported bound unbounded', async () => {
    const provider = { ...config(), outputTokenParameter: 'max_completion_tokens' as const }; const input = { ...request(provider), outputTokenParameter: 'max_completion_tokens' as const };
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 400 }));
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), input);
    expect(fetcher).toHaveBeenCalledOnce();
    const options = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(options?.body))).toMatchObject({ max_completion_tokens: 512 });
    expect(JSON.parse(String(options?.body))).not.toHaveProperty('max_tokens');
    expect(options?.redirect).toBe('error');
    expect(result.observations.at(-1)).toMatchObject({ phase: 'terminal', outcome: 'failed', httpStatus: 400, usage: { inputTokens: null, outputTokens: null, source: 'unknown' } });
  });

  it('rechecks bound request limits against frozen config even when the body fits the supplied budget', async () => {
    const provider = config(); const valid = request(provider); const fetcher = vi.fn<typeof fetch>();
    const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
    for (const input of [
      { ...valid, contextBudget: { ...valid.contextBudget!, contextWindowTokens: 16384 } },
      { ...valid, maxOutputTokens: 1024 },
      { ...valid, contextBudget: { ...valid.contextBudget!, safetyMarginTokens: 0 } },
    ]) expect((await collect(adapter, input)).error).toMatchObject({ code: 'provider.invalidRequestBudget' });
    expect((await collect(adapter, { ...valid, outputTokenParameter: 'max_completion_tokens' })).error).toMatchObject({ message: 'provider.bindingMismatch' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a disabled provider even if its supplied fingerprint matches', async () => {
    const provider = { ...config(), enabled: false }; const fetcher = vi.fn<typeof fetch>();
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), request(provider));
    expect(result.error).toMatchObject({ message: 'provider.bindingMismatch' }); expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the OpenAI default output parameter policy while preserving an explicit override', async () => {
    const provider: ProviderConfig = { ...config(), kind: 'openai', baseUrl: 'https://provider.example/v1', outputTokenParameter: undefined };
    const input = { ...request(provider), outputTokenParameter: 'max_completion_tokens' as const };
    const fetcher = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'));
    expect((await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), input)).error).toBeUndefined();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ max_completion_tokens: 512 });
  });
});

describe('Provider request observations', () => {
  it('hashes the exact transmitted body and preserves measured partial usage without inventing zeroes', async () => {
    const provider = config(); const input = request(provider);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(chunk('答复', 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 19 } })}\n\ndata: [DONE]\n\n`));
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), input);
    expect(result.error).toBeUndefined();
    expect(result.observations.map((item) => item.phase)).toEqual(['fetch-invoked', 'response-received', 'terminal']);
    expect(result.observations[0]).toMatchObject({ httpStatus: null, outcome: null, usage: { inputTokens: null, outputTokens: null, source: 'unknown' } });
    expect(result.observations.at(-1)).toMatchObject({ httpStatus: 200, outcome: 'completed', finishReason: 'stop', usage: { inputTokens: 19, outputTokens: null, source: 'provider-reported' } });
    const hash = createHash('sha256').update(String(fetcher.mock.calls[0]?.[1]?.body)).digest('hex');
    expect(result.observations.every((item) => item.bodySHA256 === hash && item.requestId === input.identity?.requestId)).toBe(true);
    for (const event of result.events) expect(providerUtilityResponseSchema.safeParse({ version: 1, kind: 'provider:event', requestId: randomUUID(), event }).success).toBe(true);
  });

  it('distinguishes an invoked fetch with a network failure from a received HTTP response', async () => {
    const provider = config(); const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('network failure'); });
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), request(provider));
    expect(result.observations.map((item) => item.phase)).toEqual(['fetch-invoked', 'terminal']);
    expect(result.observations.at(-1)).toMatchObject({ httpStatus: null, outcome: 'failed' });
  });

  it('does not declare a truncated response completed', async () => {
    const provider = config();
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, async () => new Response(chunk('partial', 'length'))), request(provider));
    expect(result.error).toMatchObject({ message: 'provider.truncated' });
    expect(result.observations.at(-1)).toMatchObject({ phase: 'terminal', outcome: 'failed', finishReason: 'length' });
    expect(result.events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not dispatch an already cancelled request or fabricate observations', async () => {
    const provider = config(); const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const result = await collect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher), request(provider), controller.signal);
    expect(result.error).toMatchObject({ name: 'AbortError' }); expect(result.events).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates new budget/identity fields through the strict utility protocol', () => {
    const provider = config(); const input = request(provider);
    const command = { version: 1, kind: 'provider:chat', requestId: randomUUID(), credentials: { config: provider, apiKey: null }, request: input };
    expect(providerUtilityCommandSchema.parse(command)).toEqual(command);
    expect(providerUtilityCommandSchema.safeParse({ ...command, request: { ...input, identity: { requestId: randomUUID(), bindingDigest: 'wrong' } } }).success).toBe(false);
    const observation: ProviderRequestObservation = { requestId: randomUUID(), bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 100, phase: 'terminal', httpStatus: null, outcome: 'failed', usage: { inputTokens: null, outputTokens: null, source: 'unknown' }, finishReason: null };
    expect(providerUtilityResponseSchema.safeParse({ version: 1, kind: 'provider:event', requestId: randomUUID(), event: { type: 'request-observation', observation: { ...observation, usage: { ...observation.usage, inputTokens: -1 } } } }).success).toBe(false);
  });
});

describe('Read-only Ollama model inspection', () => {
  it.each([{ remote_host: 'https://ollama.com' }, { remote_model: 'cloud-model' }])('reports remote metadata and architecture ceiling using only the selected model show request', async (remote) => {
    const provider = config();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...remote, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 131072 } }));
    const result = await new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher).inspectModel('selected:cloud');
    expect(result).toEqual({ contextWindowTokens: 131072, executionDestination: 'remote', source: 'ollama-show' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/show');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify({ model: 'selected:cloud', verbose: false }) });
  });

  it('keeps missing or malformed capacity unknown and does not infer local execution', async () => {
    const provider = config();
    const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, async () => Response.json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': '8192', 'other.context_length': 32768 } }));
    await expect(adapter.inspectModel('fixture')).resolves.toEqual({ contextWindowTokens: null, executionDestination: 'unknown', source: 'ollama-show' });
  });

  it.each([
    { remote_host: 'https://ollama.com', remote_model: null, model_info: null },
    { remote_host: 'https://ollama.com', remote_model: { malformed: true }, model_info: 'invalid metadata' },
    { remote_model: 'cloud-model', remote_host: ['malformed'], model_info: [] },
    { remote_model: 'cloud-model', remote_host: null, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 'invalid' } },
  ])('preserves recognized remote evidence when another field is null or malformed', async (payload) => {
    const adapter = new OpenAICompatibleAdapter({ config: config(), apiKey: null }, async () => Response.json(payload));
    await expect(adapter.inspectModel('fixture')).resolves.toEqual({ contextWindowTokens: null, executionDestination: 'remote', source: 'ollama-show' });
  });

  it('does not query unsupported providers and rejects redirected or failed inspections', async () => {
    const provider = { ...config(), kind: 'lm-studio' as const }; const fetcher = vi.fn<typeof fetch>();
    await expect(new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher).inspectModel('fixture')).resolves.toEqual({ contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
    const failed = new OpenAICompatibleAdapter({ config: config(), apiKey: null }, async () => new Response('', { status: 302 }));
    await expect(failed.inspectModel('fixture')).rejects.toMatchObject({ status: 302 });
  });
});

it.each([false, true])('serializes and validates keep_alive only on same-daemon Ollama vault tool requests (native=%s)', native => {
  const provider = { ...config(), ...(native ? { ollamaNumCtx: 8192 } : {}) };
  const input: ProviderChatRequest = {
    ...request(provider),
    ...(native ? { ollamaNumCtx: 8192 } : {}),
    ollamaReleaseAfterTurn: true,
    tools: [{ name: 'notes.search', description: 'Find notes', parameters: {} }],
  };
  expect(() => assertProviderRequestBinding(provider, input)).not.toThrow();
  expect(prepareProviderChatRequest(input).body).toHaveProperty('keep_alive', 0);
  expect(prepareProviderChatRequest({ ...input, ollamaReleaseAfterTurn: undefined }).body).not.toHaveProperty('keep_alive');
  expect(() => assertProviderRequestBinding({ ...provider, baseUrl: 'http://127.0.0.1:11435/v1' }, input)).toThrow('provider.bindingMismatch');
  expect(() => assertProviderRequestBinding(provider, { ...input, tools: [] })).toThrow('provider.bindingMismatch');
  expect(() => assertProviderRequestBinding(provider, { ...input, executionMode: 'background-text' })).toThrow('provider.bindingMismatch');
  expect(providerUtilityCommandSchema.safeParse({
    version: 1, kind: 'provider:chat', requestId: input.identity!.requestId, credentials: { config: provider, apiKey: null }, request: input,
  }).success).toBe(true);
});
