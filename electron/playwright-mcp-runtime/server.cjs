'use strict';
const process = require('node:process');
const { Buffer } = require('node:buffer');
// A single owner-controlled HTTP endpoint. The Microsoft MCP implementation is
// used through its public API; no anonymous upstream listener is created.
const { createServer } = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { createConnection } = require('@playwright/mcp');
const { chromium } = require('playwright');
const { registry } = require('playwright-core/lib/coreBundle');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const workspace = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('playwright.configuration');
// Playwright's own headless shell for the pinned version. It is a plain binary,
// so unlike the installed Chrome app it leaves no code-signing clone behind
// when a run is killed, and it never touches the user's browser install.
const browserExecutable = registry.registry.findExecutable('chromium-headless-shell')?.executablePath();
const sessions = new Map();
const capability = randomBytes(32).toString('hex');
const capabilityPath = '/mcp/' + capability;
const config = {
  // The supplied BrowserContext is already in-memory and isolated from the
  // user's normal profile. false here makes createConnection reuse it.
  browser: { isolated: false }, sharedBrowserContext: true, ignoreRoots: true,
  capabilities: ['core'], webmcp: false, saveSession: false, codegen: 'none',
  allowUnrestrictedFileAccess: false, imageResponses: 'omit',
  outputDir: join(workspace, 'output'), outputMaxSize: 20 * 1024 * 1024,
  timeouts: { action: 10000, navigation: 60000, settle: 500 },
};
let browserPromise;
let contextPromise;
const browserClosings = new Set();
const trackClose = task => {
  browserClosings.add(task);
  void task.then(() => browserClosings.delete(task), () => browserClosings.delete(task));
  return task;
};
const context = () => {
  if (!contextPromise) {
    const launched = chromium.launch({ executablePath: browserExecutable, headless: true, handleSIGINT: false, handleSIGTERM: false });
    browserPromise = launched;
    const created = launched.then(async browser => {
      const reset = () => {
        if (contextPromise === created) contextPromise = undefined;
        if (browserPromise === launched) browserPromise = undefined;
      };
      browser.once('disconnected', reset);
      const browserContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      browserContext.once('close', () => { reset(); void trackClose(browser.close()).catch(() => {}); });
      return browserContext;
    }).catch(error => {
      if (contextPromise === created) contextPromise = undefined;
      if (browserPromise === launched) browserPromise = undefined;
      void trackClose(launched.then(browser => browser.close())).catch(() => {});
      throw error;
    });
    contextPromise = created;
  }
  return contextPromise;
};
const closeBrowser = async () => {
  const pending = browserPromise;
  browserPromise = undefined;
  contextPromise = undefined;
  const closingTasks = [...browserClosings];
  if (pending) closingTasks.push(trackClose(pending.then(browser => browser.close())));
  await Promise.all(closingTasks);
};

let port;
const authenticated = req => {
  if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}` || req.url !== capabilityPath) return false;
  const supplied = Buffer.from(req.url);
  const expected = Buffer.from(capabilityPath);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const errorResponse = (res, status) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: status === 403 ? 'Forbidden' : 'Request failed' })); };
const readBody = async req => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const httpServer = createServer(async (req, res) => {
  if (closing) return errorResponse(res, 503);
  if (!authenticated(req)) return errorResponse(res, 403);
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) return errorResponse(res, 405);
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const item = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!item) return errorResponse(res, 404);
      return await item.transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
    }
    if (req.method !== 'POST' || sessions.size >= 16) return errorResponse(res, 400);
    const body = await readBody(req);
    if (!body || Array.isArray(body) || body.method !== 'initialize') return errorResponse(res, 400);
    const server = await createConnection(config, context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: id => sessions.set(id, { transport, server }),
    });
    // Browser automation does not grant host JavaScript execution. Upstream
    // exposes this RCE-equivalent tool in its core set; keep it out of both
    // discovery and invocation for the managed preset.
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (Array.isArray(message.result?.tools)) message = { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => tool.name !== 'browser_run_code_unsafe') } };
      return send(message, options);
    };
    await server.connect(transport);
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (message.method === 'tools/call' && message.params?.name === 'browser_close') {
        if (message.id !== undefined) void closeBrowser().then(() => send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Browser closed. The next browser action starts a fresh isolated context.' }] } }), () => send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Could not confirm that the managed browser closed.' }] } })).catch(() => {});
        return;
      }
      if (message.method === 'tools/call' && message.params?.name === 'browser_run_code_unsafe') {
        if (message.id !== undefined) void send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Host code execution is unavailable in the managed Playwright service.' }] } }).catch(() => {});
        return;
      }
      receive?.(message, extra);
    };
    const oldClose = transport.onclose;
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); oldClose?.(); };
    await transport.handleRequest(req, res, body);
    return undefined;
  } catch {
    if (!res.headersSent) errorResponse(res, 400); else res.end();
    return undefined;
  }
});
httpServer.requestTimeout = 120000;
httpServer.headersTimeout = 15000;
let closing;
const shutdown = () => {
  if (closing) return closing;
  closing = (async () => {
    for (const item of sessions.values()) await item.server.close().catch(() => {});
    sessions.clear();
    await closeBrowser().catch(() => {});
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  })();
  return closing;
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown().finally(() => process.exit(0)));
// The parent owns this service. An IPC disconnect or closed input cannot leave
// an orphaned browser/server after DeskPet exits unexpectedly.
process.stdin.resume();
process.stdin.once('end', () => void shutdown().finally(() => process.exit(0)));
process.once('disconnect', () => void shutdown().finally(() => process.exit(0)));
(async () => {
  if (!browserExecutable || !existsSync(browserExecutable)) {
    process.stdout.write(JSON.stringify({ type: 'browserMissing' }) + '\n');
    process.exit(1);
  }
  await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  const address = httpServer.address();
  if (!address || typeof address === 'string' || address.port < 1024) throw new Error('playwright.endpoint');
  port = address.port;
  process.stdout.write(JSON.stringify({ type: 'ready', endpoint: `http://127.0.0.1:${port}${capabilityPath}`, version: require('@playwright/mcp/package.json').version }) + '\n');
})().catch(() => { process.stderr.write('playwright.startFailed\n'); process.exit(1); });
