/* global process, Buffer, setTimeout, clearTimeout, TextDecoder */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyService, prepareRuntime, startChild, verifyIsolation } from './mcp-stdio-bridge-sandbox.mjs';

const versions = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const idOK = (id) => (typeof id === 'string' && id.length > 0 && id.length <= 128) || Number.isSafeInteger(id);
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
class HttpFailure extends Error {
  constructor(status) {
    super('Request rejected');
    this.status = status;
  }
}
const reject = (status) => {
  throw new HttpFailure(status);
};

async function body(req) {
  if (Number(req.headers['content-length']) > 65536) reject(413);
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 65536) reject(413);
    parts.push(part);
  }
  try {
    const msg = JSON.parse(utf8(Buffer.concat(parts)));
    if (
      record(msg) &&
      msg.jsonrpc === '2.0' &&
      typeof msg.method === 'string' &&
      msg.result === undefined &&
      msg.error === undefined &&
      (msg.id === undefined || idOK(msg.id))
    )
      return msg;
  } catch {
    /* Return only a local fixed error. */
  }
  reject(400);
}

function childSession(runtime, entry, ended) {
  const child = startChild(runtime, [join(runtime.snapshot, entry)]);
  const session = {
    id: randomUUID(),
    version: null,
    phase: 'initializing',
    busy: false,
    closed: false,
    call,
    notify,
    stop,
    touch,
  };
  let pending = null,
    buffer = Buffer.alloc(0),
    idle = null,
    messages = 0,
    seen = new Set();
  const lifetime = setTimeout(stop, 120000);
  lifetime.unref();
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(stop, 20000);
    idle.unref();
  }
  function stop() {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(idle);
    clearTimeout(lifetime);
    child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
    if (pending) {
      clearTimeout(pending.timer);
      pending.fail(new HttpFailure(502));
      pending = null;
    }
    ended(session);
  }
  function send(msg) {
    if (session.closed || ++messages > 128) {
      stop();
      reject(503);
    }
    touch();
    child.stdin.write(JSON.stringify(msg) + '\n', (error) => {
      if (error) stop();
    });
  }
  function notify(msg) {
    send(msg);
  }
  function call(msg) {
    if (session.closed || pending) reject(409);
    if (seen.has(msg.id)) reject(409);
    seen.add(msg.id);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        stop();
      }, 8000);
      timer.unref();
      pending = { id: msg.id, timer, done, fail };
      try {
        send(msg);
      } catch {
        stop();
      }
    });
  }
  child.on('error', stop);
  child.on('close', stop);
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.stdout.on('data', (chunk) => {
    try {
      if (session.closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > 524288) stop();
          return;
        }
        if (newline > 524288 || ++messages > 128) {
          stop();
          return;
        }
        const msg = JSON.parse(utf8(buffer.subarray(0, newline)));
        buffer = buffer.subarray(newline + 1);
        if (!record(msg) || msg.jsonrpc !== '2.0') throw Error();
        // No roots, sampling, elicitation or server-to-client RPC are negotiated.
        if (msg.method !== undefined) {
          if (msg.id !== undefined || !String(msg.method).startsWith('notifications/')) throw Error();
          continue;
        }
        if (!pending || msg.id !== pending.id || (msg.result === undefined) === (msg.error === undefined)) throw Error();
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        current.done(msg);
      }
    } catch {
      stop();
    }
  });
  touch();
  return session;
}

/** Loopback JSON responses implement Streamable HTTP without SSE or replay. The
 * random URL and session header are separate and never passed to service code. */
export async function openBridge(directory, entry) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'deskpet-mcp-bridge-')));
  await chmod(root, 0o700);
  let server = null,
    active = null,
    closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    active?.stop();
    if (server) {
      const stopped = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    const snapshot = join(root, 'service');
    const name = await copyService(directory, entry, snapshot);
    const runtime = await prepareRuntime(snapshot);
    const canary = join(root, 'isolation-check');
    await writeFile(canary, 'isolation fixture', { mode: 0o600, flag: 'wx' });
    await verifyIsolation(runtime, canary);
    await rm(canary);
    const path = '/mcp/' + randomBytes(32).toString('hex');
    let authority = '';
    const reply = (res, status, msg, headers = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(msg ? { 'content-type': 'application/json' } : {}),
        ...headers,
      });
      res.end(msg ? JSON.stringify(msg) : undefined);
    };
    server = createServer(
      { maxHeaderSize: 8192, headersTimeout: 3000, requestTimeout: 5000, connectionsCheckingInterval: 1000 },
      async (req, res) => {
        let session = null;
        try {
          if (
            req.headers.host !== authority ||
            (req.headers.origin !== undefined && req.headers.origin !== 'http://' + authority)
          )
            reject(403);
          if (req.url !== path || closing) reject(404);
          if (req.method === 'GET') {
            reply(res, 405, null, { allow: 'POST, DELETE' });
            return;
          }
          if (req.method !== 'POST' && req.method !== 'DELETE') reject(405);
          const sid = req.headers['mcp-session-id'],
            version = req.headers['mcp-protocol-version'];
          if (sid !== undefined && (!active || sid !== active.id)) reject(404);
          if (version !== undefined && (!versions.has(version) || (active?.version && active.version !== version))) reject(400);
          if (req.method === 'DELETE') {
            if (!sid) reject(400);
            active.stop();
            reply(res, 204);
            return;
          }
          if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '')) reject(415);
          const accept = String(req.headers.accept ?? '').toLowerCase();
          if (!accept.includes('application/json') || !accept.includes('text/event-stream')) reject(406);
          const msg = await body(req);
          if (msg.method === 'initialize') {
            if (sid || msg.id === undefined || !record(msg.params) || !versions.has(msg.params.protocolVersion)) reject(400);
            if (active) reject(409);
            session = childSession(runtime, entry, (old) => {
              if (active === old) active = null;
            });
            active = session;
            const result = await session.call({
              ...msg,
              params: {
                protocolVersion: msg.params.protocolVersion,
                capabilities: {},
                clientInfo: { name: 'DeskPet local bridge', version: '1' },
              },
            });
            if (
              !record(result.result) ||
              !versions.has(result.result.protocolVersion) ||
              !record(result.result.capabilities?.tools)
            ) {
              session.stop();
              reject(502);
            }
            session.version = result.result.protocolVersion;
            session.phase = 'initialized';
            reply(
              res,
              200,
              {
                jsonrpc: '2.0',
                id: msg.id,
                result: { protocolVersion: session.version, capabilities: { tools: {} }, serverInfo: { name, version: '1' } },
              },
              { 'mcp-session-id': session.id },
            );
            return;
          }
          if (!sid || !active || sid !== active.id) reject(400);
          session = active;
          session.touch();
          if (msg.method === 'notifications/initialized' && msg.id === undefined && session.phase === 'initialized') {
            session.notify({ jsonrpc: '2.0', method: msg.method });
            session.phase = 'ready';
            reply(res, 202);
            return;
          }
          if (session.phase !== 'ready' || msg.id === undefined) reject(409);
          if (!['tools/list', 'tools/call', 'ping'].includes(msg.method)) {
            reply(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not enabled' } });
            return;
          }
          if (
            msg.method === 'tools/call' &&
            (!record(msg.params) || typeof msg.params.name !== 'string' || !record(msg.params.arguments))
          )
            reject(400);
          if (session.busy) reject(409);
          session.busy = true;
          try {
            const result = await session.call(msg);
            // A subprocess error may include its inputs or host paths; never relay it.
            reply(
              res,
              200,
              result.error === undefined
                ? result
                : { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Local service rejected the request' } },
            );
          } finally {
            session.busy = false;
          }
        } catch (error) {
          reply(res, error instanceof HttpFailure ? error.status : 502);
        }
      },
    );
    server.maxConnections = 12;
    server.keepAliveTimeout = 1500;
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', done);
    });
    if (server.address().port < 1024) throw Error('No ephemeral port.');
    authority = '127.0.0.1:' + server.address().port;
    const manifest = join(root, 'bridge.json');
    await writeFile(
      manifest,
      JSON.stringify({ version: 1, kind: 'deskpet-stdio-bridge', name, endpoint: 'http://' + authority + path }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    return { manifest, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    process.stderr.write('Usage: npm run mcp:stdio -- /absolute/reviewed/package relative/entry.js\n');
    process.exitCode = 2;
  } else {
    try {
      const bridge = await openBridge(process.argv[2], process.argv[3]);
      process.stdout.write(bridge.manifest + '\n');
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.once(signal, () => {
          void bridge.close();
        });
    } catch (error) {
      process.stderr.write(
        error instanceof Error && error.message.startsWith('Sandbox isolation probe failed:')
          ? error.message + '\n'
          : 'Local MCP bridge could not start. Check the documented runtime and package constraints.\n',
      );
      process.exitCode = 1;
    }
  }
}
