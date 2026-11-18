// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { prepareProviderChatRequest, providerBindingFingerprint } from './request-budget';
import { chatRequestLimits } from './chat-request-policy';
import type { ProviderChatRequest, ProviderStreamEvent, ProviderToolThought } from './types';

const config = (kind: 'ollama' | 'deepseek'): ProviderConfig => ({
  id: randomUUID(), kind, model: 'synthetic', name: 'Fixture', supportsTools: true, enabled: true, secretState: 'missing',
  baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434/proxy/v1' : 'https://deepseek.example.invalid/v1',
  contextWindowTokens: 16384, maxOutputTokens: 512,
});
const collect = async (adapter: OpenAICompatibleAdapter, request: ProviderChatRequest, signal?: AbortSignal) => {
  const events: ProviderStreamEvent[] = [];
  for await (const event of adapter.streamChat(request, signal)) events.push(event);
  return events;
};
const requestFor = (provider: ProviderConfig, adapter: OpenAICompatibleAdapter): ProviderChatRequest => {
  const bindingDigest = providerBindingFingerprint(provider, provider.model);
  const limits = chatRequestLimits({ provider, model: provider.model, bindingDigest, credentialRef: randomUUID(), adapter,
    inspection: { contextWindowTokens: 131072, source: 'unknown', executionDestination: 'unknown' } });
  return { model: provider.model, messages: [{ role: 'user', content: 'Compute two plus two' }], ...limits,
    tools: [{ name: 'math.calculate', description: 'Calculate', parameters: { type: 'object' } }],
    identity: { requestId: randomUUID(), bindingDigest } };
};
const ndjson = (...chunks: unknown[]): Response => new Response(chunks.map(item => JSON.stringify(item)).join('\n') + '\n');
const sse = (delta: unknown, reason: string | null = null): string => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: reason }] }) + '\n\n';
const call = { id: 'call-1', function: { name: 'math_calculate', arguments: { expression: '2+2' } } };
const nextRound = (request: ProviderChatRequest, thought: ProviderToolThought): ProviderChatRequest => ({ ...request,
  messages: [...request.messages, { role: 'assistant', content: '', toolThought: thought, toolCalls: [{ id: 'call-1', name: 'math.calculate', argumentsJson: '{"expression":"2+2"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: '{"value":4}' }] });

it('uses native Ollama loading, real tool argument objects, call IDs and the smaller context budget for every round', async () => {
  const provider = { ...config('ollama'), ollamaNumCtx: 8192 };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(ndjson({ message: { role: 'assistant', thinking: 'private fixture', content: '', tool_calls: [call] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 67, eval_count: 13 }))
    .mockResolvedValueOnce(ndjson({ message: { role: 'assistant', content: '4' }, done: true, done_reason: 'stop' }));
  const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
  const first = requestFor(provider, adapter);
  expect(first.contextBudget?.contextWindowTokens).toBe(8192);
  const events = await collect(adapter, first);
  expect(events).toContainEqual({ type: 'tool-call', id: 'call-1', name: 'math.calculate', argumentsJson: '{"expression":"2+2"}' });
  expect(events).toContainEqual({ type: 'usage', inputTokens: 67, outputTokens: 13 });
  const thought = events.find(e => e.type === 'tool-thought')!;
  const follow = nextRound(first, thought.thought);
  const final = await collect(adapter, follow);
  expect(final).toContainEqual({ type: 'text', text: '4' });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('http://127.0.0.1:11434/proxy/api/chat'));
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
  expect(body).toMatchObject({ options: { num_ctx: 8192, num_predict: 512 }, truncate: false, messages: [
    { role: 'user' }, { role: 'assistant', thinking: 'private fixture', tool_calls: [{ id: 'call-1', function: { name: 'math_calculate', arguments: { expression: '2+2' } } }] },
    { role: 'tool', tool_call_id: 'call-1', tool_name: 'math_calculate', content: '{"value":4}' },
  ] });
  expect(final.filter(e => e.type === 'request-observation').map(e => e.observation.bodySHA256)).toEqual(Array(3).fill(prepareProviderChatRequest(follow).bodySHA256));
});

it('discards incomplete Ollama tool calls and does not treat cancellation or a server error as completion', async () => {
  const provider = { ...config('ollama'), ollamaNumCtx: 8192 };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ndjson({ message: { role: 'assistant', content: '', tool_calls: [call] }, done: false }))
    .mockResolvedValueOnce(ndjson({ error: 'arbitrary private upstream message' })).mockResolvedValueOnce(new Response(new ReadableStream()));
  const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
  const request = requestFor(provider, adapter), events: ProviderStreamEvent[] = [];
  await expect((async () => { for await (const e of adapter.streamChat(request)) events.push(e); })()).rejects.toThrow('provider.streamInterrupted');
  expect(events.some(e => e.type === 'tool-call')).toBe(false);
  await expect(collect(adapter, request)).rejects.toThrow('provider.request');
  const controller = new AbortController(), pending = collect(adapter, request, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

it('replays DeepSeek reasoning only on the original assistant tool call and provider binding', async () => {
  const provider = config('deepseek'), hidden = 'PRIVATE_FIXTURE_THOUGHT';
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(sse({ reasoning_content: 'PRIVATE_' }) +
    sse({ reasoning_content: 'FIXTURE_THOUGHT', tool_calls: [{ index: 0, id: call.id, function: { name: call.function.name, arguments: '{"expression":"2+2"}' } }] }, 'tool_calls')))
    .mockResolvedValueOnce(new Response(sse({ reasoning_content: 'discard final reasoning', content: '4' }, 'stop')));
  const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
  const first = requestFor(provider, adapter), events = await collect(adapter, first);
  const thought = events.find(e => e.type === 'tool-thought')!;
  expect(thought.thought.content).toBe(hidden);
  expect(JSON.stringify(events.filter(e => e.type !== 'tool-thought'))).not.toContain(hidden);
  const follow = nextRound(first, thought.thought), final = await collect(adapter, follow);
  expect(JSON.stringify(final)).not.toContain('discard final reasoning');
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
  expect(body.messages.map((m: Record<string, unknown>) => m.reasoning_content)).toEqual([undefined, hidden, undefined]);
  expect(body.messages.at(-1).tool_call_id).toBe(call.id);
  const other = { ...provider, id: randomUUID() }, alternateFetch = vi.fn<typeof fetch>();
  await expect(collect(new OpenAICompatibleAdapter({ config: other, apiKey: null }, alternateFetch), { ...follow, identity: {
    requestId: randomUUID(), bindingDigest: providerBindingFingerprint(other, other.model),
  } })).rejects.toThrow('provider.bindingMismatch');
  expect(alternateFetch).not.toHaveBeenCalled();
});
