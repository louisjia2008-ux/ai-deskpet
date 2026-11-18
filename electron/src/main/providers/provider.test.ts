import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfig } from '../../shared';
import { providerFailureCode } from '../../shared/provider-errors';
import { OpenAICompatibleAdapter, ProviderHttpError } from './openai-compatible';
import { providerUtilityCommandSchema } from '../../utility/provider-protocol';

const servers: Array<ReturnType<typeof createServer>> = [];
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))),
  );
});

const config = (baseUrl: string): ProviderConfig => ({
  id: '0e5e71f9-5987-486d-bb03-f75c4c693783',
  kind: 'ollama',
  name: 'Fixture',
  baseUrl,
  model: 'fixture-model',
  enabled: true,
  supportsTools: true,
  secretState: 'missing',
});

describe('OpenAICompatibleAdapter', () => {
  it('parses streamed text, fragmented tool calls, usage, and completion', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"time.","arguments":"{\\""}}]},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"current","arguments":"timezone\\":\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n');
      response.end('data: [DONE]\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const events = [];
    for await (const event of adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: 'text', text: 'Hello ' });
    expect(events).toContainEqual({ type: 'tool-call', id: 'call_1', name: 'time.current', argumentsJson: '{"timezone":"UTC"}' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 3, outputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('lists models and maps authentication errors without returning response secrets', async () => {
    let unauthorized = false;
    const baseUrl = await listen((_request, response) => {
      if (unauthorized) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"apiKey":"must-not-leak"}');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"z-model"},{"id":"a-model"}]}');
      }
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: 'local-fixture-secret' });
    expect((await adapter.listModels()).map((model) => model.id)).toEqual(['a-model', 'z-model']);
    unauthorized = true;
    const error = await adapter.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 401, code: 'provider.authentication' });
    expect(String(error)).not.toContain('must-not-leak');
    expect(String(error)).not.toContain('local-fixture-secret');
  });

  it('only disables thinking when explicitly requested and accepts it across the utility boundary', async () => {
    const bodies: unknown[] = [];
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n');
      });
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    for (const reasoningEffort of [undefined, 'none'] as const) {
      const request = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'hi' }], ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
      const command = providerUtilityCommandSchema.parse({ version: 1, kind: 'provider:chat', requestId: crypto.randomUUID(), credentials: { config: config(baseUrl), apiKey: null }, request });
      if (command.kind !== 'provider:chat') throw new Error('Unexpected command.');
      expect(command.request.reasoningEffort).toBe(reasoningEffort);
      for await (const event of adapter.streamChat(request)) expect(event.type).toBe('done');
    }
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[1]).toHaveProperty('reasoning_effort', 'none');
  });

  it('maps exhausted provider credit to a safe quota error', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(402, { 'content-type': 'application/json' }).end('{"error":"private provider account details"}');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const iterator = adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
    const error: unknown = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 402, code: 'provider.quota' });
    expect(String(error)).not.toContain('private provider account details');
  });

  it('serializes declared tools and assistant tool-call history using the OpenAI contract', async () => {
    let receivedBody: unknown = null;
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const events = [];
    for await (const event of adapter.streamChat({
      model: 'fixture-model',
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'time.current', argumentsJson: '{}' }] },
        { role: 'tool', content: '{"iso":"now"}', toolCallId: 'call_1' },
      ],
      tools: [{ name: 'time.current', description: 'Current time', parameters: { type: 'object' } }],
    })) events.push(event);

    expect(receivedBody).toMatchObject({
      tools: [{ type: 'function', function: { name: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u), parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u), arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1' },
      ],
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('uses distinct legal wire names and maps fragmented function replies back to internal tool IDs', async () => {
    const declarations: string[][] = [];
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools: Array<{ function: { name: string } }>;
          messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
        };
        const names = body.tools.map((tool) => tool.function.name);
        declarations.push(names);
        expect(body.messages[0]?.tool_calls?.[0]?.function.name).toBe(names[0]);
        if (names.some((name) => !/^[A-Za-z0-9_-]{1,64}$/u.test(name))) { response.writeHead(400).end(); return; }
        const name = names[0] as string;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: name.slice(0, 5), arguments: '{}' } }] } }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: name.slice(5) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const tools = ['time.current', 'time_current', '工具.current', 'x'.repeat(150)].map((name) => ({ name, description: 'Synthetic tool', parameters: { type: 'object' } }));
    for (let retry = 0; retry < 2; retry += 1) {
      const events = [];
      for await (const event of adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'previous', name: 'time.current', argumentsJson: '{}' }] }], tools })) events.push(event);
      expect(events).toContainEqual({ type: 'tool-call', id: 'call_1', name: 'time.current', argumentsJson: '{}' });
    }
    expect(new Set(declarations[0]).size).toBe(tools.length);
    expect(declarations[0]?.[1]).toBe('time_current');
    expect(declarations[0]?.[0]).not.toBe('time.current');
    expect(declarations[0]).toEqual(declarations[1]);
  });

  it('declares readable names and executes the exact web_read name returned by a real model', async () => {
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools: Array<{ function: { name: string } }> };
        expect(body.tools.map((tool) => tool.function.name)).toEqual(['web_read', 'timer_create']);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_read', arguments: '{"url":"https://www.iana.org/domains/reserved"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const tools = ['web.read', 'timer.create'].map((name) => ({ name, description: 'Synthetic tool', parameters: { type: 'object' } }));
    const events = [];
    for await (const event of adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'Read the page' }], tools })) events.push(event);
    expect(events).toContainEqual({ type: 'tool-call', id: 'call_1', name: 'web.read', argumentsJson: '{"url":"https://www.iana.org/domains/reserved"}' });
  });

  it('propagates caller cancellation during streaming', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const controller = new AbortController();
    const iterator = adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    expect(await iterator.next()).toMatchObject({ value: { type: 'text', text: 'first' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves a timeout that occurs after the stream has started', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null }, fetch, 200);
    const iterator = adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(await iterator.next()).toMatchObject({ value: { type: 'text', text: 'first' } });
    const error: unknown = await iterator.next().catch((caught: unknown) => caught);
    expect(providerFailureCode(error)).toBe('provider.timeout');
  });

  it.each([
    { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', stillOpenAfterMs: 14 * 60_000, abortedAfterMs: 15 * 60_000 },
    { kind: 'lm-studio' as const, baseUrl: 'http://127.0.0.1:1234/v1', stillOpenAfterMs: 14 * 60_000, abortedAfterMs: 15 * 60_000 },
    { kind: 'openai-compatible' as const, baseUrl: 'https://provider.invalid/v1', stillOpenAfterMs: 50_000, abortedAfterMs: 60_000 },
  ])('lets a silent $kind stream run for $stillOpenAfterMs ms before timing out', async ({ kind, baseUrl, stillOpenAfterMs, abortedAfterMs }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const silentAfterFirstChunk = vi.fn<typeof fetch>(async (_url, init) => new Response(new globalThis.ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new globalThis.TextEncoder().encode('data: {"choices":[{"delta":{"content":"Writing the note."},"finish_reason":null}]}\n\n'));
        init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const adapter = new OpenAICompatibleAdapter({ config: { ...config(baseUrl), kind }, apiKey: null }, silentAfterFirstChunk);
      const iterator = adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
      expect(await iterator.next()).toMatchObject({ value: { type: 'text', text: 'Writing the note.' } });
      let settled = false;
      const pending = iterator.next().catch((caught: unknown) => caught).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(stillOpenAfterMs);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(abortedAfterMs - stillOpenAfterMs);
      expect(providerFailureCode(await pending)).toBe('provider.timeout');
    } finally { vi.useRealTimers(); }
  });

  it('accepts the usage-only final chunk emitted when streaming includes usage', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n');
      response.end('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const events = [];
    for await (const event of adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
    expect(events).toContainEqual({ type: 'text', text: 'Done' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 7, outputTokens: 2 });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('rejects insecure non-local provider endpoints before making a request', () => {
    const insecure = { ...config('http://example.com/v1'), kind: 'openai' as const };
    expect(() => new OpenAICompatibleAdapter({ config: insecure, apiKey: null })).toThrow('requires an HTTPS endpoint');
  });
});
