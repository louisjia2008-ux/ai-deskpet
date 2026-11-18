// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderCredentials } from './types';

const credentials: ProviderCredentials = { apiKey: null, config: { id: '01234567-89ab-4def-8123-456789abcdef', kind: 'ollama', name: 'Fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, supportsTools: false, secretState: 'missing' } };
afterEach(() => vi.useRealTimers());
it('keeps continuous output alive past the old total deadline and still emits completion', async () => {
  vi.useFakeTimers();
  const fetcher: typeof fetch = async (_url, init) => new Response(new globalThis.ReadableStream({ start(controller) {
    let chunks = 0;
    const timer = setInterval(() => {
      controller.enqueue(new globalThis.TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: chunks === 5 ? 'stop' : null }] })}\n\n`));
      if (++chunks === 6) { clearInterval(timer); controller.close(); }
    }, 30);
    init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(init.signal?.reason); }, { once: true });
  } }));
  const adapter = new OpenAICompatibleAdapter(credentials, fetcher, 50);
  const output = (async () => { const events = []; for await (const event of adapter.streamChat({ model: 'fixture', messages: [] })) events.push(event); return events; })();
  await vi.advanceTimersByTimeAsync(200);
  expect((await output).filter((event) => event.type === 'text')).toHaveLength(6);
  expect((await output).at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
});
it('gives a cold local model fifteen minutes for its first response while bounding silence', async () => {
  vi.useFakeTimers();
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
  const iterator = new OpenAICompatibleAdapter(credentials, fetcher).streamChat({ model: 'fixture', messages: [] });
  const first = iterator.next(); const rejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  let done = false; void first.catch(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000); await rejected;
});
