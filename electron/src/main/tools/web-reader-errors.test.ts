// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { SecureWebReader } from './web-reader';
import type { HostResolver, PinnedRequester, WebReaderOptions } from './web-reader';
import { ToolFailure, classifyToolFailure, recoverableToolFailure, toolFailureResult } from '../runtime/tool-failure';

const fixture = (options: { status?: number; contentType?: string; text?: string; location?: string; resolver?: HostResolver } & WebReaderOptions = {}) => {
  const requester = vi.fn<PinnedRequester>(async () => ({ status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'text/plain', ...(options.location ? { location: options.location } : {}) },
    body: (async function* () { yield Buffer.from(options.text ?? 'SYNTHETIC_PAGE'); })(),
  }));
  const reader = new SecureWebReader({ ...options, requester,
    resolver: options.resolver ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
  });
  return { reader, requester };
};

it.each([
  [404, 'web.pageNotFound', false], [410, 'web.pageNotFound', false],
  [401, 'web.pageAccessDenied', false], [403, 'web.pageAccessDenied', false],
  [429, 'web.pageRateLimited', false], [503, 'web.pageServerError', true],
] as const)('keeps HTTP %s as a failed source with a safe reason and retry hint', async (status, detail, retryable) => {
  const f = fixture({ status, text: '<title>PRIVATE_ERROR_PAGE</title>' });
  const failure = classifyToolFailure(await f.reader.read('https://example.org/error').catch((error: unknown) => error), 'web.read');
  expect(failure).toMatchObject({ code: 'tool.network', detail });
  expect(toolFailureResult(failure)).toMatchObject({ ok: false, error: { retryable } });
  expect(JSON.stringify(toolFailureResult(failure))).not.toContain('PRIVATE_');
  expect(recoverableToolFailure(failure, false, 'execution')).toBe(true);
  expect(f.requester).toHaveBeenCalledOnce();
});

it.each(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'])('classifies DNS %s before any HTTPS request without exposing the resolver error', async code => {
  const f = fixture({ resolver: async () => { throw Object.assign(new Error('PRIVATE_DNS_DETAIL'), { code }); } });
  const error = await f.reader.read('https://example.org/no-dns').catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'tool.network', detail: 'web.dnsUnavailable' });
  expect(error).toBeInstanceOf(ToolFailure);
  expect((error as Error).message).not.toContain('PRIVATE_');
  expect(f.requester).not.toHaveBeenCalled();
});

it('distinguishes empty DNS from mixed public/private DNS while sending neither request', async () => {
  const empty = fixture({ resolver: async () => [] });
  await expect(empty.reader.read('https://example.org/')).rejects.toMatchObject({ code: 'tool.network', detail: 'web.dnsUnavailable' });
  const mixed = fixture({ resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }] });
  const error = await mixed.reader.read('https://example.org/').catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'tool.webTarget', detail: 'web.nonPublicAddress' });
  expect(recoverableToolFailure(error as ToolFailure, false, 'execution')).toBe(false);
  expect(empty.requester).not.toHaveBeenCalled(); expect(mixed.requester).not.toHaveBeenCalled();
});

it('rejects malformed and forbidden targets without calling the resolver or requester', async () => {
  const resolver = vi.fn<HostResolver>(); const f = fixture({ resolver });
  for (const target of ['not a URL', 'http://example.org/', 'https://fixture:secret@example.org/', 'https://example.org:8443/']) {
    await expect(f.reader.read(target)).rejects.toMatchObject({ code: 'tool.webTarget', detail: 'web.invalidTarget' });
  }
  expect(resolver).not.toHaveBeenCalled(); expect(f.requester).not.toHaveBeenCalled();
});

it.each([
  [{ text: ' \n\t' }, 'web.emptyContent'],
  [{ contentType: 'application/pdf' }, 'web.unsupportedContent'],
  [{ text: '12345', maxBytes: 4 }, 'web.responseTooLarge'],
  [{ status: 302, location: '/next', maxRedirects: 0 }, 'web.redirectLimit'],
] as const)('preserves a reason when a response cannot be used: %s', async (options, detail) => {
  const f = fixture(options);
  await expect(f.reader.read('https://example.org/')).rejects.toMatchObject({ code: 'tool.network', detail });
  expect(f.requester).toHaveBeenCalledOnce();
});

it('does not reinterpret cancellation as a DNS failure', async () => {
  const cancelled = new DOMException('SYNTHETIC_CANCEL', 'AbortError');
  const f = fixture({ resolver: async () => { throw cancelled; } });
  await expect(f.reader.read('https://example.org/')).rejects.toBe(cancelled);
  expect(f.requester).not.toHaveBeenCalled();
});
