// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { providerFailureCode } from '../../shared/provider-errors';
import type { ProviderStreamEvent } from './types';

const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const make = (source: string | globalThis.ReadableStream<Uint8Array>) => new OpenAICompatibleAdapter({ apiKey: null, config: {
  id: crypto.randomUUID(), kind: 'ollama', name: 'fixture', model: 'fixture', enabled: true, supportsTools: true, secretState: 'missing', baseUrl: 'http://127.0.0.1:11434/v1',
} }, async () => new Response(source));
const read = async (source: string | globalThis.ReadableStream<Uint8Array>) => {
  const events: ProviderStreamEvent[] = [];
  let error: unknown;
  try { for await (const event of make(source).streamChat({ model: 'fixture', messages: [] })) events.push(event); } catch (caught) { error = caught; }
  return { events, error };
};

it.each(['', chunk({ content: 'partial' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'timer.create', arguments: '{"seconds":60}' } }] })])('rejects premature EOF without declaring success or yielding tool calls', async (source) => {
  const result = await read(source);
  expect(providerFailureCode(result.error)).toBe('provider.streamInterrupted');
  expect(result.events.every((event) => event.type === 'text')).toBe(true);
});
it.each(['stop', 'tool_calls'])('accepts an explicit %s finish at EOF without requiring DONE', async (finish) => {
  expect((await read(chunk({ content: '完整' }, finish))).events.at(-1)).toEqual({ type: 'done', finishReason: finish });
});
it('recognizes a fragmented DONE marker and UTF-8 text, then releases an open connection', async () => {
  const cancel = vi.fn();
  const bytes = new globalThis.TextEncoder().encode(chunk({ content: '你好' }) + 'data: [DONE]\n\n');
  const result = await read(new globalThis.ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); }, cancel }));
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([{ type: 'text', text: '你好' }, { type: 'done', finishReason: null }]);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(['length', 'content_filter'])('does not treat %s truncation as successful completion', async (reason) => {
  const result = await read(chunk({ content: 'partial' }, reason) + 'data: [DONE]\n\n');
  expect(providerFailureCode(result.error)).toBe('provider.truncated');
  expect(result.events).toEqual([{ type: 'text', text: 'partial' }]);
});
it('classifies an abruptly broken response body as interruption while preserving received text', async () => {
  let sent = false;
  const result = await read(new globalThis.ReadableStream({ pull(controller) {
    if (sent) controller.error(new TypeError('terminated'));
    else { sent = true; controller.enqueue(new globalThis.TextEncoder().encode(chunk({ content: 'before disconnect' }))); }
  } }));
  expect(providerFailureCode(result.error)).toBe('provider.streamInterrupted');
  expect(result.events).toEqual([{ type: 'text', text: 'before disconnect' }]);
});
