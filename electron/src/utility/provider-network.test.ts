// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { net } from 'electron';
import { providerNetworkFetch } from './provider-network';
import { providerFailureCode } from '../shared/provider-errors';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('uses Chromium transport while preserving the exact bearer, body, redirect and abort contract', async () => {
  const nodeFetch = vi.fn(); vi.stubGlobal('fetch', nodeFetch);
  const signal = new AbortController().signal;
  const body = JSON.stringify({ model: 'synthetic-only', messages: [{ role: 'user', content: 'synthetic material' }] });
  const headers = { authorization: 'Bearer SYNTHETIC_ONLY', 'content-type': 'application/json' };
  const response = new Response('synthetic response');
  vi.mocked(net.fetch).mockResolvedValueOnce(response);
  await expect(providerNetworkFetch('https://example.invalid/v1/chat/completions', { method: 'POST', headers, body, redirect: 'error', signal, credentials: 'include' })).resolves.toBe(response);
  expect(net.fetch).toHaveBeenCalledExactlyOnceWith('https://example.invalid/v1/chat/completions', { method: 'POST', headers, body, redirect: 'error', signal, credentials: 'omit' });
  expect(nodeFetch).not.toHaveBeenCalled();
});

it('normalizes URL objects without following redirects or adding a retry', async () => {
  const error = new Error('synthetic network failure'); vi.mocked(net.fetch).mockRejectedValueOnce(error);
  await expect(providerNetworkFetch(new URL('https://example.invalid/v1/models'), { redirect: 'error' })).rejects.toBe(error);
  expect(net.fetch).toHaveBeenCalledExactlyOnceWith('https://example.invalid/v1/models', { redirect: 'error', credentials: 'omit' });
});

it('returns the original response stream without buffering or delaying abort', async () => {
  const controller = new AbortController();
  const response = new Response(new globalThis.ReadableStream({ start(stream) { stream.enqueue(new globalThis.TextEncoder().encode('data: synthetic\n\n')); } }));
  vi.mocked(net.fetch).mockResolvedValueOnce(response);
  const actual = await providerNetworkFetch('http://127.0.0.1:1234/v1/chat/completions', { signal: controller.signal });
  expect(actual).toBe(response); expect(actual.bodyUsed).toBe(false);
  expect(vi.mocked(net.fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  await actual.body?.cancel();
});

it.each([
  ['ERR_PROXY_CONNECTION_FAILED', 'provider.network'],
  ['ERR_TUNNEL_CONNECTION_FAILED', 'provider.network'],
  ['ERR_NAME_NOT_RESOLVED', 'provider.network'],
  ['ERR_DNS_SERVER_FAILED', 'provider.network'],
  ['ERR_CONNECTION_REFUSED', 'provider.network'],
  ['ERR_CONNECTION_RESET', 'provider.network'],
  ['ERR_CERT_AUTHORITY_INVALID', 'provider.network'],
  ['ERR_TIMED_OUT', 'provider.timeout'],
  ['ERR_CONNECTION_TIMED_OUT', 'provider.timeout'],
  ['ERR_DNS_TIMED_OUT', 'provider.timeout'],
])('classifies Chromium %s using a fixed safe code without retrying', async (reason, code) => {
  vi.mocked(net.fetch).mockRejectedValueOnce(new Error(`net::${reason}`));
  const error: unknown = await providerNetworkFetch('https://example.invalid/v1/chat/completions').catch((value: unknown) => value);
  expect(error).toMatchObject({ code, message: code });
  expect(providerFailureCode(error)).toBe(code);
  expect(vi.mocked(net.fetch)).toHaveBeenCalledOnce();
});

it.each(['net::ERR_UNKNOWN', 'net::ERR_ABORTED', 'private body net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT https://private.example/secret'])('does not reinterpret an unknown or noncanonical error: %s', async message => {
  const error = new Error(message); vi.mocked(net.fetch).mockRejectedValueOnce(error);
  await expect(providerNetworkFetch('https://example.invalid/v1/chat/completions')).rejects.toBe(error);
  expect(providerFailureCode(error)).toBe('provider.failed');
});

it('preserves caller cancellation when Chromium reports a concurrent network timeout', async () => {
  const controller = new AbortController();
  const error = new Error('net::ERR_TIMED_OUT');
  vi.mocked(net.fetch).mockImplementationOnce(async () => { controller.abort(); throw error; });
  await expect(providerNetworkFetch('https://example.invalid/v1/chat/completions', { signal: controller.signal })).rejects.toBe(error);
  expect(providerFailureCode(error, controller.signal.aborted ? 'provider.cancelled' : 'provider.failed')).toBe('provider.cancelled');
});
