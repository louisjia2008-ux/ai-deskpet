import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProviderChatRequest, ProviderStreamEvent } from './types';

const call = z.object({ id: z.string().min(1).max(240).optional(), function: z.object({
  name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()),
}) });
const chunkSchema = z.object({
  message: z.object({ role: z.literal('assistant'), content: z.string(), thinking: z.string().optional(), tool_calls: z.array(call).max(128).optional() }),
  done: z.boolean(), done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(), eval_count: z.number().int().nonnegative().optional(),
});

export const ollamaChatBody = (request: ProviderChatRequest, wireNames: Map<string, string>) => {
  const namesByCall = new Map<string, string>();
  return {
    model: request.model, stream: true, truncate: false,
    ...(request.ollamaReleaseAfterTurn ? { keep_alive: 0 } : {}),
    options: { num_ctx: request.ollamaNumCtx,
      ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }) },
    ...(request.reasoningEffort === 'none' ? { think: false } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({
      type: 'function', function: { name: wireNames.get(tool.name), description: tool.description, parameters: tool.parameters },
    })) } : {}),
    messages: request.messages.map(message => {
      if (message.role === 'tool') {
        const name = message.toolCallId && namesByCall.get(message.toolCallId);
        if (!name) throw new Error('provider.request');
        return { role: 'tool', content: message.content, tool_name: name, tool_call_id: message.toolCallId };
      }
      return { role: message.role, content: message.content,
        ...(message.toolThought ? { thinking: message.toolThought.content } : {}),
        ...(message.toolCalls ? { tool_calls: message.toolCalls.map((item, index) => {
          const name = wireNames.get(item.name)!;
          namesByCall.set(item.id, name);
          const args = z.record(z.string(), z.unknown()).parse(JSON.parse(item.argumentsJson));
          return { id: item.id, function: { index, name, arguments: args } };
        }) } : {}),
      };
    }),
  };
};

/** Native /api/chat emits NDJSON and complete tool calls. Only a final done frame
 * authorizes their use, even when earlier frames contain well-formed arguments. */
export async function* readOllamaChat(body: ReadableStream<Uint8Array>, names: Map<string, string>,
  bindingDigest: string, signal: AbortSignal, activity: () => void, background: boolean): AsyncGenerator<ProviderStreamEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = '', thinking = '', bytes = 0;
  const calls: Extract<ProviderStreamEvent, { type: 'tool-call' }>[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      bytes += value?.byteLength ?? 0;
      if (bytes > 8 * 1024 * 1024) throw new Error('provider.streamInterrupted');
      if (value?.byteLength) activity();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n'); buffer = done ? '' : lines.pop()!;
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error('provider.streamInterrupted');
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('provider.streamInterrupted');
        let payload: unknown;
        try { payload = JSON.parse(line); } catch { throw new Error('provider.streamInterrupted'); }
        if (payload && typeof payload === 'object' && 'error' in payload) throw new Error('provider.request');
        const parsed = chunkSchema.safeParse(payload);
        if (!parsed.success) throw new Error('provider.streamInterrupted');
        const chunk = parsed.data;
        if (background && chunk.message.tool_calls?.length) throw new Error('job.toolsForbidden');
        if (chunk.message.content) yield { type: 'text', text: chunk.message.content };
        if (!background && chunk.message.thinking) {
          thinking += chunk.message.thinking;
          if (thinking.length > 256_000) throw new Error('provider.contextBudgetExceeded');
        }
        for (const item of chunk.message.tool_calls ?? []) {
          if (calls.length >= 128) throw new Error('provider.request');
          calls.push({ type: 'tool-call', id: item.id ?? randomUUID(), name: names.get(item.function.name) ?? item.function.name,
            argumentsJson: JSON.stringify(item.function.arguments) });
        }
        if (!chunk.done) continue;
        if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) yield {
          type: 'usage', inputTokens: chunk.prompt_eval_count ?? null, outputTokens: chunk.eval_count ?? null,
        };
        if (chunk.done_reason === 'length') throw new Error('provider.truncated');
        if (chunk.done_reason && chunk.done_reason !== 'stop') throw new Error('provider.streamInterrupted');
        if (thinking && calls.length) yield { type: 'tool-thought', thought: { protocol: 'ollama', bindingDigest, content: thinking } };
        yield* calls;
        yield { type: 'done', finishReason: calls.length ? 'tool_calls' : 'stop' };
        return;
      }
      if (done) throw new Error('provider.streamInterrupted');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
