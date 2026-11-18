import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ToolFailure } from '../runtime/tool-failure';

const withAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type PinnedRequester = (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<WebResponse>;

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
};

const isPrivateAddress = (address: string): boolean => {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const mappedHex = normalized.match(/^::(?:ffff:)?([a-f\d]{1,4}):([a-f\d]{1,4})$/u);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16), low = Number.parseInt(mappedHex[2]!, 16);
    if (isPrivateIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)) return true;
  }
  const mappedIpv4 = normalized.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4 !== undefined && isIP(mappedIpv4) === 4) return isPrivateIpv4(mappedIpv4);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('100:') ||
    normalized.startsWith('2001:2:') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('2001:10:') ||
    normalized.startsWith('2001:20:')
  );
};

export const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) throw new Error('DNS returned an unsupported address family.');
    return { address: record.address, family: record.family };
  });
};

export const assertSafeHttpsTarget = async (url: URL, resolver: HostResolver): Promise<ResolvedAddress> => {
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new ToolFailure('tool.webTarget', 'Web reads require an HTTPS URL without embedded credentials.', 'web.invalidTarget');
  }
  if (url.port !== '' && url.port !== '443') throw new ToolFailure('tool.webTarget', 'Web reads allow HTTPS port 443 only.', 'web.invalidTarget');
  let addresses: ResolvedAddress[];
  try { addresses = await resolver(url.hostname); }
  catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(String(code))) throw new ToolFailure('tool.network', 'tool.network', 'web.dnsUnavailable');
    throw error;
  }
  if (addresses.length === 0) throw new ToolFailure('tool.network', 'tool.network', 'web.dnsUnavailable');
  if (addresses.some((item) => isPrivateAddress(item.address))) throw new ToolFailure('tool.webTarget', 'Web target resolves to a private or reserved address.', 'web.nonPublicAddress');
  const address = addresses[0];
  if (address === undefined) throw new Error('Web target has no address.');
  return address;
};

export const createPinnedRequester = (headers: Readonly<Record<string, string>> = {}): PinnedRequester => (url, address, signal) =>
  new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: address.address,
        family: address.family,
        servername: url.hostname,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'text/html, application/json, text/plain;q=0.9', ...headers, host: url.host },
        signal,
      },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
        );
        resolveRequest({ status: response.statusCode ?? 0, headers, body: response });
      },
    );
    request.once('error', rejectRequest);
    request.end();
  });

export const defaultPinnedRequester = createPinnedRequester();

export interface WebReaderOptions {
  resolver?: HostResolver;
  requester?: PinnedRequester;
  normalizeTarget?: (url: URL) => URL;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class SecureWebReader {
  readonly #resolver: HostResolver;
  readonly #requester: PinnedRequester;
  readonly #normalizeTarget: (url: URL) => URL;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;

  constructor(options: WebReaderOptions = {}) {
    this.#resolver = options.resolver ?? defaultResolver;
    this.#requester = options.requester ?? defaultPinnedRequester;
    this.#normalizeTarget = options.normalizeTarget ?? ((url) => url);
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRedirects = options.maxRedirects ?? 3;
  }

  async read(input: string, callerSignal?: AbortSignal, assertAuthorized: () => void = () => undefined): Promise<{ url: string; contentType: string; text: string }> {
    callerSignal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Web read timed out.', 'TimeoutError')), this.#timeoutMs);
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    try {
      let url: URL;
      try { url = new URL(input); } catch { throw new ToolFailure('tool.webTarget', 'tool.webTarget', 'web.invalidTarget'); }
      return await withAbort(this.#read(url, controller.signal, 0, assertAuthorized), controller.signal);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  async #read(targetUrl: URL, signal: AbortSignal, redirects: number, assertAuthorized: () => void): Promise<{ url: string; contentType: string; text: string }> {
    signal.throwIfAborted();
    const url = this.#normalizeTarget(targetUrl);
    const address = await withAbort(assertSafeHttpsTarget(url, this.#resolver), signal);
    signal.throwIfAborted();
    assertAuthorized();
    const response = await this.#requester(url, address, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (location === undefined || redirects >= this.#maxRedirects) throw new ToolFailure('tool.network', 'tool.network', 'web.redirectLimit');
      let target: URL;
      try { target = new URL(location, url); } catch { throw new ToolFailure('tool.webTarget', 'tool.webTarget', 'web.invalidTarget'); }
      // Some public sites emit legacy HTTP links for same-host canonical paths.
      // Try that path over TLS, never make an HTTP request or fall back to it.
      // Other hosts, credentials and custom ports still go through strict checks.
      if (target.protocol === 'http:' && target.hostname === url.hostname && target.port === '' && !target.username && !target.password) target.protocol = 'https:';
      return this.#read(target, signal, redirects + 1, assertAuthorized);
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.status === 404 || response.status === 410 ? 'web.pageNotFound'
        : response.status === 401 || response.status === 403 ? 'web.pageAccessDenied'
          : response.status === 429 ? 'web.pageRateLimited' : response.status >= 500 ? 'web.pageServerError' : 'web.crawlFailed';
      throw new ToolFailure('tool.network', 'tool.network', detail);
    }
    const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? 'application/octet-stream';
    if (!['application/json', 'text/html', 'text/plain'].includes(contentType)) throw new ToolFailure('tool.network', 'tool.network', 'web.unsupportedContent');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted(); assertAuthorized();
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > this.#maxBytes) throw new ToolFailure('tool.network', 'Web response exceeds the size limit.', 'web.responseTooLarge');
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) throw new ToolFailure('tool.network', 'tool.network', 'web.emptyContent');
    return { url: url.toString(), contentType, text };
  }
}
