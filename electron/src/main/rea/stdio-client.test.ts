import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReaStdioClient, reaToolContractsDigest } from './stdio-client';
import type { ReaRuntimeConfig, ReaToolContract } from './stdio-client';

const root = '/private/tmp/deskpet/output/deskpet-electron-next-integration-20261029/rea/unit-fixtures';
const owned: string[] = [], clients: ReaStdioClient[] = [];
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const tools: ReaToolContract[] = ['analyze_javascript_application', 'inspect_analysis_view'].map((name) => ({ name: name as ReaToolContract['name'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }));
const factory = async (mode = 'normal') => {
  await mkdir(root, { recursive: true, mode: 0o700 }); const fixture = await mkdtemp(join(root, 'transport-')); owned.push(fixture);
  const pkg = join(fixture, 'package'), session = join(fixture, 'session'); await mkdir(pkg); await mkdir(session, { mode: 0o700 });
  const entry = join(pkg, 'server.cjs');
  const code = `const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{spawn}=require('node:child_process');const mode=${JSON.stringify(mode)},tools=${JSON.stringify(tools)};let calls=0;const rl=readline.createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')send({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'rea',version:'6.8.0'},capabilities:{tools:{}}}});else if(q.method==='tools/list')send({jsonrpc:'2.0',id:q.id,result:{tools}});else if(q.method==='tools/call'){calls++;fs.writeFileSync(path.join(process.env.TMPDIR,'calls.json'),JSON.stringify({calls,envKeys:Object.keys(process.env),cwd:process.cwd(),home:process.env.HOME}));if(mode==='invalid')return process.stdout.write('bad-json\\n');if(mode==='oversize')return process.stdout.write('x'.repeat(8192));if(mode==='hang'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(process.env.TMPDIR,'worker.pid'),String(child.pid));return;}const done=()=>send({jsonrpc:'2.0',id:q.id,result:{content:[],isError:mode==='business-error',structuredContent:mode==='business-error'?{error:{code:'synthetic_error'}}:{normalized_result:{kind:'summary',parent_operation:'analyze_javascript_application',artifact:{path:mode==='foreign-artifact'?'/outside':q.params.arguments.input_path},parent_evidence_id:'ev_'+ 'a'.repeat(64)},untrustedText:'SYNTHETIC_ONLY'}}});if(mode==='slow')setTimeout(done,80);else done();}});`;
  await writeFile(entry, code); const manifest = join(fixture, 'manifest.json'); await writeFile(manifest, JSON.stringify({ version: 1, packageRoot: pkg, files: [{ path: 'server.cjs', type: 'file', sha256: sha(code) }] }));
  const config: ReaRuntimeConfig = { executablePath: process.execPath, executableSHA256: sha(await readFile(process.execPath)), entryPath: entry, entrySHA256: sha(code), packageRoot: pkg,
    sessionRoot: session, manifestPath: manifest, manifestSHA256: sha(await readFile(manifest)), expectedToolContractsSHA256: reaToolContractsDigest(tools), startupTimeoutMs: 3000, toolTimeoutMs: 3000, shutdownTimeoutMs: 100, maxFrameBytes: mode === 'oversize' ? 2048 : 1024 * 1024 };
  const target = join(session, 'target'); await mkdir(target); const args = { input_path: target, format: 'directory', integrity_policy: 'fail', detail: 'summary', source_paths: ['main.js'],
    max_heap_mb: 128, max_semantic_nodes: 100, max_semantic_nodes_per_file: 100, max_semantic_unknowns: 100, max_semantic_unknowns_per_file: 100, analysis_timeout_ms: 1000 };
  const client = new ReaStdioClient(config); clients.push(client); return { fixture, entry, config, client, session, args };
};
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined))); await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('controlled JSON-lines MCP transport (synthetic server)', () => {
  it('pins runtime and schemas, permits exactly two tools and excludes inherited secret environment', async () => {
    const s = await factory(); const previous = process.env.SYNTHETIC_REA_PROVIDER_KEY; process.env.SYNTHETIC_REA_PROVIDER_KEY = 'SYNTHETIC_NOT_REAL';
    try {
      await s.client.start(); expect(s.client.tools().map((tool) => tool.name).sort()).toEqual(['analyze_javascript_application', 'inspect_analysis_view']);
      const reply = await s.client.callTool('analyze_javascript_application', s.args); expect(reply.provenance).toMatchObject({ untrusted: true, localOnly: true });
      const observed = JSON.parse(await readFile(join(String(s.client.diagnostics().temporaryRoot ?? join(s.session, 'tmp')), 'calls.json'), 'utf8')) as { envKeys: string[]; home: string; cwd: string };
      expect(observed.envKeys).not.toContain('SYNTHETIC_REA_PROVIDER_KEY'); expect(observed.home).toBe(process.env.HOME); expect(observed.cwd).toBe(join(s.session, 'cwd'));
      await expect(s.client.callTool('read_file' as 'analyze_javascript_application', s.args)).rejects.toThrow('rea.toolNotAllowed');
      await expect(s.client.callTool('analyze_javascript_application', { ...s.args, input_path: s.fixture })).rejects.toThrow('rea.toolArgumentsOutOfScope');
      await s.client.callTool('inspect_analysis_view', { source: { kind: 'retained-evidence', evidence_id: `ev_${'a'.repeat(64)}` }, view: { kind: 'summary' } });
      await expect(s.client.callTool('inspect_analysis_view', { source: { kind: 'evidence-file', path: '/outside.json' }, view: { kind: 'summary' } })).rejects.toThrow('rea.toolArgumentsOutOfScope');
      await expect(s.client.callTool('inspect_analysis_view', { source: { kind: 'retained-evidence', evidence_id: `ev_${'b'.repeat(64)}` }, view: { kind: 'summary' } })).rejects.toThrow('rea.toolArgumentsOutOfScope');
      await s.client.close(); expect(s.client.diagnostics()).toMatchObject({ ownedGroupEmpty: true, forced: false });
    } finally { if (previous === undefined) delete process.env.SYNTHETIC_REA_PROVIDER_KEY; else process.env.SYNTHETIC_REA_PROVIDER_KEY = previous; }
  });
  it('registers only the exact successful associated analysis field, never arbitrary strings or another artifact', async () => {
    const s = await factory('foreign-artifact'); await s.client.start();
    await s.client.callTool('analyze_javascript_application', s.args);
    await expect(s.client.callTool('inspect_analysis_view', { source: { kind: 'retained-evidence', evidence_id: `ev_${'a'.repeat(64)}` }, view: { kind: 'summary' } })).rejects.toThrow('rea.toolArgumentsOutOfScope');
    expect(s.client.diagnostics().requestsStarted).toBe(3);
  });
  it('does not launch after cancellation while asynchronous runtime verification is still pending', async () => {
    const s = await factory(); const starting = s.client.start(); await s.client.close();
    await expect(starting).rejects.toThrow('rea.sessionClosed');
    expect(s.client.diagnostics()).toMatchObject({ closed: true, pid: null, ownedGroupEmpty: true });
  });
  it('rejects tampered code before creating any process', async () => {
    const s = await factory(); await writeFile(s.entry, 'changed'); await expect(s.client.start()).rejects.toThrow('rea.runtimeIdentityMismatch'); expect(s.client.diagnostics().pid).toBeNull();
  });
  it('enforces one active call even across asynchronous path admission', async () => {
    const s = await factory('slow'); await s.client.start(); const first = s.client.callTool('analyze_javascript_application', s.args);
    await expect(s.client.callTool('analyze_javascript_application', s.args)).rejects.toThrow('rea.sessionBusy'); await first;
    expect(JSON.parse(await readFile(join(String(s.client.diagnostics().temporaryRoot ?? join(s.session, 'tmp')), 'calls.json'), 'utf8')).calls).toBe(1);
  });
  it.each([['invalid', 'invalidFrame'], ['oversize', 'frameLimit']])('fails closed on %s framing', async (mode, error) => {
    const s = await factory(mode); await s.client.start(); await expect(s.client.callTool('analyze_javascript_application', s.args)).rejects.toThrow(`rea.${error}`);
    await s.client.close(); expect(s.client.diagnostics().ownedGroupEmpty).toBe(true);
  });
  it('preserves a real tool business error instead of converting transport completion into product success', async () => {
    const s = await factory('business-error'); await s.client.start(); const reply = await s.client.callTool('analyze_javascript_application', s.args);
    expect(reply.isError).toBe(true); expect(reply.provenance.untrusted).toBe(true);
  });
  it('cancels only its new process group including an uncooperative inherited worker', async () => {
    const s = await factory('hang'); await s.client.start(); const abort = new AbortController(); const result = s.client.callTool('analyze_javascript_application', s.args, { signal: abort.signal });
    let workerPID = 0; for (let n = 0; n < 100; n++) { try { workerPID = Number(await readFile(join(String(s.client.diagnostics().temporaryRoot ?? join(s.session, 'tmp')), 'worker.pid'), 'utf8')); break; } catch { await new Promise((done) => setTimeout(done, 10)); } }
    expect(workerPID).toBeGreaterThan(0); abort.abort(); await expect(result).rejects.toThrow('rea.cancelled'); await s.client.close();
    expect(s.client.diagnostics()).toMatchObject({ forced: true, ownedGroupEmpty: true });
    expect(() => process.kill(workerPID, 0)).toThrow();
  });
  it('times out without automatically retrying an ambiguous request and drains the owned group', async () => {
    const s = await factory('hang'); await s.client.start(); await expect(s.client.callTool('analyze_javascript_application', s.args, { timeoutMs: 50 })).rejects.toThrow('rea.timeout');
    await s.client.close(); expect(s.client.diagnostics()).toMatchObject({ ownedGroupEmpty: true, failureCode: 'rea.timeout' });
  });
  it('does not use unsafe runtime arrays as accepted configuration values', async () => {
    const s = await factory(); await s.client.start(); await expect(s.client.callTool('analyze_javascript_application', { ...s.args, format: ['directory'] })).rejects.toThrow('rea.toolArgumentsOutOfScope');
    await chmod(s.entry, 0o600);
  });
});
