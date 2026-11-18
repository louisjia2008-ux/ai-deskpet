// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { net } from 'electron';
import type { ProviderConfig } from '../../shared';
import type { ProviderUtilityCommand, ProviderUtilityResponse } from '../../utility/provider-protocol';
import { chatRequestLimits } from './chat-request-policy';
import type { CapturedProviderBinding } from './provider-service';
import { prepareProviderChatRequest, providerBindingFingerprint } from './request-budget';
import type { ProviderChatRequest, ProviderResponseItem } from './types';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, utilityProcess: { fork: vi.fn() } }));

// Import the real utility entry and drive its registered parent-port handler.
// Mock only Electron's transport: the protocol schema, reconstruction, adapter,
// binding guards, wire serialization and event serialization all remain real.
class ParentPort extends EventEmitter {
  postMessage(value: ProviderUtilityResponse): void { this.emit('posted', value); }
}
const port = new ParentPort();
const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');

const provider = (kind: ProviderConfig['kind'] = 'openai'): ProviderConfig => ({
  id: randomUUID(), kind, name: 'Synthetic utility entry fixture',
  baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434/v1',
  model: kind === 'openai' ? 'gpt-6.1-terra' : 'fixture',
  enabled: true, supportsTools: true, secretState: 'configured',
});
const request = (config: ProviderConfig, messages: ProviderChatRequest['messages'] = [{ role: 'user', content: 'Synthetic hello' }]): ProviderChatRequest => ({
  model: config.model, messages,
  ...chatRequestLimits({ provider: config, model: config.model, inspection: { contextWindowTokens: null } } as CapturedProviderBinding),
  identity: { requestId: randomUUID(), bindingDigest: providerBindingFingerprint(config, config.model) },
});
const completed = (output: ProviderResponseItem[]): Response => new Response(`data: ${JSON.stringify({
  type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 20, output_tokens: 4 } },
})}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const answer: ProviderResponseItem[] = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic answer' }] }];
const dispatch = (config: ProviderConfig, chat: ProviderChatRequest): Promise<ProviderUtilityResponse[]> => {
  const requestId = randomUUID();
  const command: ProviderUtilityCommand = { version: 1, kind: 'provider:chat', requestId,
    credentials: { config, apiKey: 'SYNTHETIC_NEVER_SENT' }, request: chat };
  return new Promise((resolve) => {
    const responses: ProviderUtilityResponse[] = [];
    const receive = (response: ProviderUtilityResponse): void => {
      if (response.requestId !== requestId) return;
      responses.push(response);
      if (response.kind === 'provider:complete' || response.kind === 'provider:error') {
        port.off('posted', receive); resolve(responses);
      }
    };
    port.on('posted', receive);
    port.emit('message', { data: command });
  });
};
const expectMatchingWire = (responses: ProviderUtilityResponse[], chat: ProviderChatRequest): void => {
  expect(responses.at(-1)?.kind).toBe('provider:complete');
  const expected = prepareProviderChatRequest(chat);
  const observations = responses.flatMap((response) => response.kind === 'provider:event' && response.event.type === 'request-observation' ? [response.event.observation] : []);
  expect(observations.map((observation) => observation.phase)).toEqual(['fetch-invoked', 'response-received', 'terminal']);
  expect(observations.every((observation) => observation.bodySHA256 === expected.bodySHA256)).toBe(true);
  expect(net.fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: expected.bodyText, credentials: 'omit' }));
};

beforeAll(async () => {
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port });
  await import('../../utility/entry');
});
beforeEach(() => { vi.mocked(net.fetch).mockReset(); });
afterAll(() => {
  port.removeAllListeners();
  if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort);
  else Reflect.deleteProperty(process, 'parentPort');
});

describe('real provider utility entry boundary', () => {
  it('preserves a bound official OpenAI Responses selection and the exact host wire receipt', async () => {
    const config = provider(), chat = request(config);
    vi.mocked(net.fetch).mockResolvedValueOnce(completed(answer));
    const responses = await dispatch(config, chat);
    expectMatchingWire(responses, chat);
    expect(net.fetch).toHaveBeenCalledExactlyOnceWith('https://api.openai.com/v1/responses', expect.any(Object));
    expect(responses).toContainEqual(expect.objectContaining({ kind: 'provider:event', event: { type: 'text', text: 'Synthetic answer' } }));
  });

  it('retains encrypted reasoning and function items through the second tool round without changing its host body hash', async () => {
    const config = provider();
    const output: ProviderResponseItem[] = [
      { type: 'reasoning', id: 'rs_synthetic', summary: [], encrypted_content: 'SYNTHETIC_OPAQUE_REASONING' },
      { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'math_calculate', arguments: '{"expression":"2+2"}', status: 'completed' },
    ];
    const first = request(config);
    first.tools = [{ name: 'math.calculate', description: 'Synthetic math', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } }];
    vi.mocked(net.fetch).mockResolvedValueOnce(completed(output)).mockResolvedValueOnce(completed(answer));
    const firstResponses = await dispatch(config, first);
    expectMatchingWire(firstResponses, first);
    const retained = firstResponses.flatMap((response) => response.kind === 'provider:event' && response.event.type === 'response-items' ? response.event.items : []);
    expect(retained).toEqual(output);
    const second = request(config, [
      ...first.messages,
      { role: 'assistant', content: '', responseItems: retained, toolCalls: [{ id: 'call_synthetic', name: 'math.calculate', argumentsJson: '{"expression":"2+2"}' }] },
      { role: 'tool', content: '{"value":4}', toolCallId: 'call_synthetic' },
    ]);
    second.tools = first.tools;
    expectMatchingWire(await dispatch(config, second), second);
    const body = JSON.parse(String(vi.mocked(net.fetch).mock.calls[1]?.[1]?.body));
    expect(body.input.slice(1, 3)).toEqual(output);
    expect(body.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'call_synthetic', output: '{"value":4}' });
  });

  it('keeps local compatible chat on the legacy endpoint and exact legacy body', async () => {
    const config = provider('ollama'), chat = request(config);
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Local answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    expectMatchingWire(await dispatch(config, chat), chat);
    expect(net.fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:11434/v1/chat/completions', expect.any(Object));
  });

  it('rejects a missing official protocol or a changed compatible protocol before network dispatch', async () => {
    for (const kind of ['openai', 'ollama'] as const) {
      const config = provider(kind), chat = request(config);
      if (kind === 'openai') delete chat.wireProtocol;
      else chat.wireProtocol = 'responses';
      const responses = await dispatch(config, chat);
      expect(responses.at(-1)).toMatchObject({ kind: 'provider:error', errorCode: 'provider.bindingMismatch' });
    }
    expect(net.fetch).not.toHaveBeenCalled();
  });
});
