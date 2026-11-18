import { request as http } from 'node:http';
import { request as https } from 'node:https';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { assertSafeHttpsTarget, defaultResolver } from '../tools/web-reader';
import type { HostResolver } from '../tools/web-reader';
import { mcpEndpoint } from '../../shared/desktop-extensions';

/** Use the same DNS checks as public web reads and connect to the approved
 * address directly. TLS still verifies the original hostname. Never redirect. */
export async function mcpConnectionTarget(raw: string, resolver: HostResolver = defaultResolver): Promise<RequestOptions> {
  const url = new URL(mcpEndpoint(raw));
  if (url.protocol === 'http:') return { protocol: 'http:', hostname: url.hostname.replace(/^\[|\]$/gu,''), port: Number(url.port), path: url.pathname };
  const address = await assertSafeHttpsTarget(url, async host => {
    const addresses = await resolver(host);
    // Exclude IPv6 transition/tunneling ranges, including private IPv4 via NAT64.
    if (addresses.some(a => a.family === 6 && (!/^[23]/u.test(a.address) || /^(?:2002:|2001:0*:)/iu.test(a.address)))) throw new Error('extensions.endpoint');
    return addresses;
  });
  return { protocol: 'https:', hostname: address.address, family: address.family, servername: url.hostname, port: 443, path: url.pathname, rejectUnauthorized: true };
}
export const mcpNetworkFetch: typeof fetch = async (input, init) => {
  const raw = String(input), target = await mcpConnectionTarget(raw);
  init?.signal?.throwIfAborted();
  const send = target.protocol === 'http:' ? http : https;
  return new Promise<Response>((resolve, reject) => {
    const req = send({ ...target, method: init?.method ?? 'POST', headers: { ...Object.fromEntries(new Headers(init?.headers)), host: new URL(raw).host },
      ...(init?.signal ? { signal: init.signal } : {}), agent: false }, response => {
      const headers = new Headers();
      for (const [key,value] of Object.entries(response.headers)) if (value !== undefined) {
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key,item);
      }
      const status = response.statusCode ?? 500;
      if (status < 200 || status > 599) { response.destroy(); reject(new Error('extensions.mcpHttp')); return; }
      const body = status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      if (!body) response.resume();
      resolve(new Response(body, { status,headers }));
    });
    req.on('error',reject);
    req.end(typeof init?.body === 'string' ? init.body : undefined);
  });
};
