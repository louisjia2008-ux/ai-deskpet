// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { McpHttpClient } from './mcp-client';

it('sends bearer credentials only in HTTPS headers and pins the GitHub host to read-only mode', async () => {
  const endpoint = 'https://api.githubcopilot.com/mcp/readonly', token = 'ghp_syntheticClientToken123456';
  const methods: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (address, init) => {
    expect(String(address)).toBe(endpoint);
    expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer ' + token);
    expect(headers.get('X-MCP-Readonly')).toBe('true');
    if (init?.method === 'DELETE') { methods.push('DELETE'); return new Response(null,{status:204}); }
    expect(String(init?.body)).not.toContain(token);
    const wire = JSON.parse(String(init?.body)); methods.push(wire.method);
    if (wire.method === 'notifications/initialized') return new Response(null,{status:202});
    const result = wire.method === 'initialize' ? {protocolVersion:'2025-11-25',capabilities:{tools:{}}} : {tools:[]};
    return Response.json({jsonrpc:'2.0',id:wire.id,result},{headers:{'Mcp-Session-Id':'synthetic-session'}});
  });
  const client = new McpHttpClient(endpoint,fetcher,AbortSignal.timeout(5000),{bearerToken:token});
  await client.initialize(); expect(await client.tools()).toEqual([]); await client.close();
  expect(methods).toEqual(['initialize','notifications/initialized','tools/list','DELETE']);
});

it('rejects unsafe bearer values or plaintext endpoints before a request', () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const token of ['', 'contains spaces', 'abc\r\nInjected:value', 'x'.repeat(4097)]) {
    expect(() => new McpHttpClient('https://mcp.example.org/mcp',fetcher,AbortSignal.timeout(5000),{bearerToken:token})).toThrow('extensions.invalidToken');
  }
  expect(() => new McpHttpClient('http://127.0.0.1:8080/mcp',fetcher,AbortSignal.timeout(5000),{bearerToken:'synthetic'})).toThrow('extensions.invalidToken');
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not follow redirects or include a remote error body in authentication errors', async () => {
  const token = 'ghp_syntheticClientToken123456';
  for (const status of [301,401,403]) {
    const fetcher = vi.fn<typeof fetch>(async (_address,init) => {
      expect(init?.redirect).toBe('error');
      return new Response(token,{status,headers:{Location:'https://other.example.org/mcp'}});
    });
    const client = new McpHttpClient('https://mcp.example.org/mcp',fetcher,AbortSignal.timeout(5000),{bearerToken:token});
    await expect(client.initialize()).rejects.toThrow(status === 301 ? 'extensions.mcpHttp' : 'extensions.authRequired');
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(token); });
  const client = new McpHttpClient('https://mcp.example.org/mcp',fetcher,AbortSignal.timeout(5000),{bearerToken:token});
  await expect(client.initialize()).rejects.toThrow(/^extensions\.mcpHttp$/u);
});

it('does not reuse a credential for cleanup after its operation was canceled', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_address,init) => {
    const wire = JSON.parse(String(init?.body));
    if (wire.method === 'notifications/initialized') return new Response(null,{status:202});
    return Response.json({jsonrpc:'2.0',id:wire.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}}, {headers:{'Mcp-Session-Id':'synthetic-session'}});
  });
  const client = new McpHttpClient('https://mcp.example.org/mcp',fetcher,controller.signal,{bearerToken:'syntheticBearerToken'});
  await client.initialize(); controller.abort(); await client.close();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
