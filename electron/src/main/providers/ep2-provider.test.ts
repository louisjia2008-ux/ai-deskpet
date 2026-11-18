// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { providerUtilityCommandSchema } from '../../utility/provider-protocol';
import { InferenceAdmission } from './inference-admission';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { prepareProviderChatRequest } from './request-budget';
import type { ProviderChatRequest, ProviderStreamEvent } from './types';

const config: ProviderConfig = {
  id: '0e5e71f9-5987-486d-bb03-f75c4c693783', kind: 'lm-studio', name: 'Synthetic',
  baseUrl: 'http://127.0.0.1:19991/v1', model: 'synthetic', enabled: true, supportsTools: true, secretState: 'missing',
};
const request: ProviderChatRequest = {
  model: 'synthetic', executionMode: 'background-text', messages: [{ role: 'user', content: 'ONLY_SELECTED_MATERIAL' }],
};
const drain = async (adapter: OpenAICompatibleAdapter, selected: ProviderChatRequest = request): Promise<ProviderStreamEvent[]> => {
  const events: ProviderStreamEvent[] = [];
  for await (const event of adapter.streamChat(selected)) events.push(event);
  return events;
};
const fixture = (envelope: unknown, status = 200) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`, {
    status, headers: { 'content-type': 'text/event-stream' },
  }));
  return { fetcher, adapter: new OpenAICompatibleAdapter({ config, apiKey: null }, fetcher) };
};

describe('E-P2 text-only provider protocol', () => {
  it('preserves the host mode across strict utility protocol and sends no tool declaration', async () => {
    const parsed = providerUtilityCommandSchema.parse({ version: 1, kind: 'provider:chat', requestId: randomUUID(), credentials: { config, apiKey: null }, request });
    expect(parsed.kind === 'provider:chat' && parsed.request.executionMode).toBe('background-text');
    const f = fixture({ choices: [{ delta: { content: '<script>TEXT_ONLY</script>' }, finish_reason: 'stop' }] });
    expect(await drain(f.adapter)).toContainEqual({ type: 'text', text: '<script>TEXT_ONLY</script>' });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ tool_choice: 'none', messages: [{ role: 'user', content: 'ONLY_SELECTED_MATERIAL' }] });
    expect(body).not.toHaveProperty('tools');
    expect(prepareProviderChatRequest({ ...request, tools: [] }).body).not.toHaveProperty('tools');
  });

  it.each([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'workspace.write', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ delta: { function_call: { name: 'workspace.write', arguments: '{}' } }, finish_reason: null }] },
    { choices: [{ message: { function_call: { name: 'workspace.write', arguments: '{}' } }, finish_reason: 'stop' }] },
    { choices: [{ message: { tool_calls: [{ function: { name: 'workspace.write' } }] }, finish_reason: 'stop' }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [{ delta: {}, finish_reason: 'function_call' }] },
    { choices: [{ delta: {}, finish_reason: null }, { delta: { function_call: { name: 'other' } }, finish_reason: null }] },
    { function_call: { name: 'legacy' }, choices: [] },
  ])('rejects a structured execution response before exposing a tool event: %j', async (envelope) => {
    const f = fixture(envelope);
    const events: ProviderStreamEvent[] = [];
    await expect((async () => { for await (const event of f.adapter.streamChat(request)) events.push(event); })()).rejects.toThrow('job.toolsForbidden');
    expect(events.some((event) => event.type === 'tool-call')).toBe(false);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('retains reported usage when the same envelope violates the no-tools protocol', async () => {
    const f = fixture({ choices: [{ delta: { function_call: { name: 'legacy' } }, finish_reason: 'function_call' }], usage: { prompt_tokens: 12, completion_tokens: 7 } });
    const events: ProviderStreamEvent[] = [];
    await expect((async () => { for await (const event of f.adapter.streamChat(request)) events.push(event); })()).rejects.toThrow('job.toolsForbidden');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 7 });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('rejects host request tools and tool history before actual fetch', async () => {
    const f = fixture({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    await expect(drain(f.adapter, { ...request, tools: [{ name: 'time.current', description: 'Time', parameters: {} }] })).rejects.toThrow('job.toolsForbidden');
    await expect(drain(f.adapter, { ...request, messages: [{ role: 'tool', content: 'prior result', toolCallId: 'old' }] })).rejects.toThrow('job.toolsForbidden');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([429, 500])('does not retry rejected generation HTTP %s', async (status) => {
    const f = fixture({}, status);
    await expect(drain(f.adapter)).rejects.toThrow(`HTTP ${status}`);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('keeps ordinary chat tool decoding available', async () => {
    const f = fixture({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'time.current', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
    expect(await drain(f.adapter, { model: request.model, messages: request.messages })).toContainEqual({ type: 'tool-call', id: 'c', name: 'time.current', argumentsJson: '{}' });
  });
});

describe('shared inference admission', () => {
  it('keeps one active slot and gives the next slot to foreground without preemption', async () => {
    const gate = new InferenceAdmission();
    const order: string[] = [];
    const firstRelease = await gate.acquire('background');
    let secondRelease: (() => void) | undefined;
    let foregroundRelease: (() => void) | undefined;
    const second = gate.acquire('background').then((release) => { order.push('background'); secondRelease = release; });
    const foreground = gate.acquire('foreground').then((release) => { order.push('foreground'); foregroundRelease = release; });
    await Promise.resolve(); expect(order).toEqual([]);
    firstRelease(); await foreground; expect(order).toEqual(['foreground']);
    firstRelease(); await Promise.resolve(); expect(order).toEqual(['foreground']);
    foregroundRelease?.(); await second; expect(order).toEqual(['foreground', 'background']); secondRelease?.();
  });

  it('removes aborted queued waiters and does not steal a slot', async () => {
    const gate = new InferenceAdmission();
    const release = await gate.acquire('foreground');
    const controller = new AbortController();
    const cancelled = gate.acquire('background', controller.signal);
    const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await assertion;
    const next = gate.acquire('background'); release(); (await next)();
    await expect(gate.acquire('foreground', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    (await gate.acquire('foreground'))();
  });
});
