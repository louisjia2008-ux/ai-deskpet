import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mcpEndpoint } from '../../shared/desktop-extensions';
import type { McpTool, McpResult } from '../../shared/desktop-extensions';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const tool = z.object({ name: z.string().min(1).max(128), description: z.string().max(8000).optional(),
  inputSchema: z.object({ type: z.literal('object') }).passthrough() }).passthrough();
const toolPage = z.object({ tools: z.array(tool).max(200), nextCursor: z.string().optional() });
const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
const RESPONSE_BYTES = 512 * 1024;
const bearerToken = (token: string): string => {
  if (!token || token.length > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) throw new Error('extensions.invalidToken');
  return token;
};

async function readResult(response: Response, id: string, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/event-stream' || !response.body) throw new Error('extensions.mcpProtocol');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, buffer = '';
  const parse = (raw: string): unknown => {
    const payload = rpc.parse(JSON.parse(raw));
    if (payload.method) { if (payload.id !== undefined) throw new Error('extensions.serverRequestUnsupported'); return undefined; }
    if (payload.id !== id || payload.error !== undefined || payload.result === undefined) throw new Error('extensions.mcpProtocol');
    return payload.result;
  };
  try {
    for (;;) {
      const part = await reader.read(); signal.throwIfAborted();
      bytes += part.value?.byteLength ?? 0;
      if (bytes > RESPONSE_BYTES) throw new Error('extensions.resultTooLarge');
      buffer += decoder.decode(part.value, { stream: !part.done });
      if (type === 'application/json') { if (part.done) return parse(buffer); continue; }
      const blocks = buffer.split(/\r?\n\r?\n/u); buffer = part.done ? '' : blocks.pop()!;
      for (const block of blocks) {
        const data = block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) { const result = parse(data); if (result !== undefined) return result; }
      }
      if (part.done) throw new Error('extensions.mcpProtocol');
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class McpHttpClient {
  readonly endpoint: string;
  readonly #signal: AbortSignal;
  #version: string | null = null;
  #session: string | null = null;
  readonly #bearerToken: string | null;
  constructor(endpoint: string, readonly fetcher: typeof fetch, signal: AbortSignal, options: { bearerToken?: string } = {}) {
    this.endpoint = mcpEndpoint(endpoint); this.#signal = signal;
    if (options.bearerToken !== undefined && new URL(this.endpoint).protocol !== 'https:') throw new Error('extensions.invalidToken');
    this.#bearerToken = options.bearerToken === undefined ? null : bearerToken(options.bearerToken);
  }
  #headers(): Record<string,string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(this.#bearerToken ? { Authorization: `Bearer ${this.#bearerToken}` } : {}),
      ...(new URL(this.endpoint).hostname === 'api.githubcopilot.com' ? { 'X-MCP-Readonly': 'true' } : {}),
      ...(this.#version ? { 'MCP-Protocol-Version': this.#version } : {}), ...(this.#session ? { 'Mcp-Session-Id': this.#session } : {}) };
  }
  async #request(method: string, params?: unknown, notify = false): Promise<unknown> {
    this.#signal.throwIfAborted();
    const id = notify ? undefined : randomUUID();
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, { method: 'POST', headers: this.#headers(), credentials: 'omit', redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: this.#signal });
    } catch { throw new Error('extensions.mcpHttp'); }
    if (method === 'initialize') {
      const assigned = response.headers.get('Mcp-Session-Id');
      if (assigned !== null && !/^[!-~]+$/u.test(assigned)) { await response.body?.cancel(); throw new Error('extensions.mcpProtocol'); }
      this.#session = assigned;
    }
    if (!response.ok || (!id && response.status !== 202)) {
      await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'extensions.authRequired' : 'extensions.mcpHttp');
    }
    if (!id) { await response.body?.cancel(); return; }
    return readResult(response, id, this.#signal);
  }
  async initialize(): Promise<void> {
    const response = z.object({ protocolVersion: z.string(), capabilities: z.object({ tools: z.object({}).passthrough() }) })
      .parse(await this.#request('initialize', { protocolVersion: versions[0], capabilities: {}, clientInfo: { name: 'DeskPet', version: '1.0' } }));
    if (!versions.includes(response.protocolVersion)) throw new Error('extensions.mcpVersion');
    this.#version = response.protocolVersion;
    await this.#request('notifications/initialized', undefined, true);
  }
  async tools(): Promise<McpTool[]> {
    const tools: McpTool[] = [], cursors = new Set<string>(), names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = toolPage.parse(await this.#request('tools/list', cursor === undefined ? {} : { cursor }));
      for (const definition of page.tools) {
        if (names.has(definition.name) || names.size >= 200) throw new Error('extensions.mcpProtocol');
        names.add(definition.name);
        tools.push({ name: definition.name, description: definition.description ?? '', inputSchema: definition.inputSchema,
          digest: createHash('sha256').update(JSON.stringify(definition)).digest('hex') });
      }
      cursor = page.nextCursor;
      if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 32)) throw new Error('extensions.mcpProtocol');
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return tools;
  }
  async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
    const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).max(128),
      structuredContent: z.record(z.string(),z.unknown()).optional() }).parse(await this.#request('tools/call', { name, arguments: args }));
    const text = result.content.map(block => block.type === 'text' && block.text !== undefined ? block.text : `[${block.type}]`);
    if (result.structuredContent) text.push(JSON.stringify(result.structuredContent, null, 2));
    return { isError: result.isError ?? false, text: text.join('\n') };
  }
  async close(): Promise<void> {
    if (!this.#session || (this.#bearerToken && this.#signal.aborted)) return;
    // Close only the negotiated session. A refused DELETE is permitted by MCP.
    try { const response = await this.fetcher(this.endpoint, { method: 'DELETE', headers: this.#headers(), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); }
    catch { /* Cleanup can fail if the user disabled the endpoint. Never replay a tool call. */ }
  }
}
