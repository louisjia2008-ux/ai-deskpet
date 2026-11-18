import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

interface WireMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
export interface MinecraftChatWire {
  messages: WireMessage[];
  tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>;
}

/** Scripted loopback model only. It never implements a Minecraft task or world. */
export async function minecraftCompanionChatModel() {
  const wires: MinecraftChatWire[] = [];
  const errors: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })
      + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'minecraft-chat-fixture' }] })); return;
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) throw new Error('Unexpected loopback fixture endpoint');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_000_000) throw new Error('Fixture request too large');
        chunks.push(Buffer.from(chunk));
      }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MinecraftChatWire;
      wires.push(wire);
      const calls = new Map(wire.messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
      const results = wire.messages.filter(message => message.role === 'tool');
      const discovery = wire.tools?.find(tool => tool.function.description.startsWith('Load more tools.'));
      const status = wire.tools?.find(tool => tool.function.description.startsWith('Read Minecraft task status.'));
      const resultFor = (name: string | undefined) => name === undefined ? undefined : results.find(message => calls.get(message.tool_call_id ?? '') === name);
      const call = (name: string, args: unknown) => send(response, { tool_calls: [{ index: 0,
        id: 'minecraft-fixture-' + wires.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (!discovery) throw new Error('Production tool discovery was not declared');
      if (!resultFor(discovery.function.name)) { call(discovery.function.name, { group: 'minecraft' }); return; }
      if (!status) throw new Error('Minecraft status was not declared after discovery');
      const result = resultFor(status.function.name);
      if (!result) { call(status.function.name, {}); return; }
      const snapshot = JSON.parse(result.content) as { runtimeState?: string; connectionState?: string; task?: unknown };
      if (snapshot.runtimeState !== 'stopped' || snapshot.connectionState !== 'disconnected' || snapshot.task !== null) {
        throw new Error('The actual host returned an unexpected initial snapshot');
      }
      send(response, { content: 'Observed Minecraft runtime=stopped; connection=disconnected; task=none. No game task was started.' });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown fixture error');
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Local fixture contract failed' }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback fixture port unavailable');
  return { base: `http://127.0.0.1:${address.port}`, wires, errors,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
