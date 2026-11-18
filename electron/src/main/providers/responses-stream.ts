import { z } from 'zod';
import { providerResponseItemSchema, providerResponseItemsSchema } from './response-items';
import type { ProviderStreamEvent } from './types';
import { safeProviderHttpErrorCode } from './http-errors';
import { inputTokenDetailsSchema, outputTokenDetailsSchema, providerReportedCostUSD, providerUsageTokenDetails } from './usage-accounting';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().nullish(), output_tokens: z.number().int().nonnegative().nullish(),
  input_tokens_details: inputTokenDetailsSchema, output_tokens_details: outputTokenDetailsSchema,
  cost: z.unknown().optional(), cost_currency: z.unknown().optional(),
});
interface FunctionProgress { id: string; callId: string; name: string; arguments: string }
const indexSchema = z.number().int().min(0).max(127);
function failure(): never { throw new Error('provider.streamInterrupted'); }

/** SSE framing is independent of network chunks, UTF-8 codepoints and line endings. */
async function* responseFrames(body: globalThis.ReadableStream<Uint8Array>, signal: AbortSignal, activity: () => void): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], total = 0;
  const parseFrame = (): unknown => {
    const text = data.join('\n'); data = [];
    if (text === '[DONE]' || !text) return null;
    try { return JSON.parse(text) as unknown; } catch { return failure(); }
  };
  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => { if (signal.aborted) throw signal.reason; return failure(); });
      signal.throwIfAborted();
      if (value?.length) { activity(); total += value.byteLength; }
      if (total > 8 * 1024 * 1024) failure();
      buffer += decoder.decode(value, { stream: !done });
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) failure();
      const lines = buffer.split(/\r?\n/u); buffer = done ? '' : lines.pop() ?? '';
      for (const line of lines) {
        if (!line) { const frame = parseFrame(); if (frame !== null) yield frame; }
        else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''));
          if (Buffer.byteLength(data.join('\n')) > 4 * 1024 * 1024) failure();
        }
      }
      if (done) { const frame = parseFrame(); if (frame !== null) yield frame; break; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function* readResponsesStream(body: globalThis.ReadableStream<Uint8Array>, toolNames: Map<string, string>, options: {
  signal: AbortSignal; activity(): void; backgroundText: boolean; finishReason(reason: string): void; implicitCostUSD?: boolean;
}): AsyncGenerator<ProviderStreamEvent> {
  const calls = new Map<number, FunctionProgress>();
  let streamedText = '';
  const admitCall = (index: number, raw: unknown, final: boolean): void => {
    if (options.backgroundText) throw new Error('job.toolsForbidden');
    if (!object(raw) || raw.type !== 'function_call') failure();
    const parsed = providerResponseItemSchema.parse(raw);
    if (parsed.type !== 'function_call' || !parsed.id) failure();
    const previous = calls.get(index);
    if (previous && (previous.id !== parsed.id || previous.callId !== parsed.call_id || previous.name !== parsed.name
      || (final && !parsed.arguments.startsWith(previous.arguments)))) failure();
    calls.set(index, { id: parsed.id, callId: parsed.call_id, name: parsed.name, arguments: parsed.arguments });
  };
  for await (const envelope of responseFrames(body, options.signal, options.activity)) {
    if (!object(envelope) || typeof envelope.type !== 'string') failure();
    const type = envelope.type;
    const response = object(envelope.response) ? envelope.response : null;
    if (response?.usage != null) {
      const usage = usageSchema.parse(response.usage);
      const reportedCostUSD = providerReportedCostUSD(usage, options.implicitCostUSD);
      yield { type: 'usage', inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null,
        ...providerUsageTokenDetails(usage.input_tokens_details, usage.output_tokens_details),
        ...(reportedCostUSD === null ? {} : { reportedCostUSD }),
      };
    }
    if (type === 'error' || type === 'response.failed') {
      options.finishReason('error'); throw new Error(safeProviderHttpErrorCode(400, type === 'error' ? envelope : response));
    }
    if (type === 'response.incomplete') {
      const details = response && object(response.incomplete_details) ? response.incomplete_details : null;
      options.finishReason(details?.reason === 'content_filter' ? 'content_filter' : 'length');
      throw new Error('provider.truncated');
    }
    if (options.backgroundText && (type.startsWith('response.function_call_arguments.')
      || (object(envelope.item) && envelope.item.type !== 'message' && envelope.item.type !== 'reasoning')
      || (Array.isArray(response?.output) && response.output.some((item) => object(item) && item.type !== 'message' && item.type !== 'reasoning')))) {
      throw new Error('job.toolsForbidden');
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = z.string().max(256_000).parse(envelope.delta);
      streamedText += delta; if (streamedText.length > 1024 * 1024) failure();
      if (delta) yield { type: 'text', text: delta };
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (!object(envelope.item)) failure();
      if (envelope.item.type === 'function_call') admitCall(indexSchema.parse(envelope.output_index), envelope.item, type.endsWith('.done'));
      else if (envelope.item.type !== 'message' && envelope.item.type !== 'reasoning') failure();
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      if (options.backgroundText) throw new Error('job.toolsForbidden');
      const call = calls.get(indexSchema.parse(envelope.output_index));
      if (!call || (envelope.item_id !== undefined && envelope.item_id !== call.id)) failure();
      if (type.endsWith('.delta')) call.arguments += z.string().max(1024 * 1024).parse(envelope.delta);
      else {
        const complete = z.string().max(1024 * 1024).parse(envelope.arguments);
        if (!complete.startsWith(call.arguments)) failure(); call.arguments = complete;
      }
      if (call.arguments.length > 1024 * 1024) failure();
    } else if (type === 'response.completed') {
      if (!response || response.status !== 'completed') failure();
      const items = providerResponseItemsSchema.parse(response.output);
      if (items.some((item) => item.status !== undefined && item.status !== 'completed')) failure();
      const completedCalls = items.filter((item) => item.type === 'function_call');
      if (options.backgroundText && completedCalls.length) throw new Error('job.toolsForbidden');
      const callIds = new Set<string>();
      for (const [index, item] of items.entries()) if (item.type === 'function_call') {
        if (callIds.has(item.call_id)) failure(); callIds.add(item.call_id);
        if (calls.has(index)) admitCall(index, item, true);
      }
      for (const call of calls.values()) if (!completedCalls.some((item) => item.id === call.id && item.call_id === call.callId && item.name === call.name && item.arguments === call.arguments)) failure();
      const finalText = items.flatMap((item) => item.type === 'message' ? item.content.map((part) => part.type === 'output_text' ? part.text : part.refusal) : []).join('');
      if (!finalText.startsWith(streamedText)) failure();
      if (finalText.length > streamedText.length) yield { type: 'text', text: finalText.slice(streamedText.length) };
      const reason = completedCalls.length ? 'tool_calls' : 'stop'; options.finishReason(reason);
      // Executable calls and replayable reasoning are withheld until an explicit,
      // fully validated completion; EOF or argument-done alone cannot authorize a tool.
      if (items.length) yield { type: 'response-items', items };
      for (const call of completedCalls) yield { type: 'tool-call', id: call.call_id, name: toolNames.get(call.name) ?? call.name, argumentsJson: call.arguments };
      yield { type: 'done', finishReason: reason }; return;
    }
  }
  throw new Error('provider.streamInterrupted');
}
