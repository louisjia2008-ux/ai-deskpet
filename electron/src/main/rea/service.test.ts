import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as FSPromises from 'node:fs/promises';
import type { PermissionLease } from '../runtime/permissions';

const doubles = vi.hoisted(() => ({
  clients: [] as Array<{ start: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  wrongArtifact: false,
  wrongParent: false,
  onStart: null as (() => Promise<void>) | null,
  onClose: null as (() => Promise<void>) | null,
  afterResultWritten: null as (() => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FSPromises>();
  const wrappedWriteFile = async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
    await actual.writeFile(...args);
    if (typeof args[0] === 'string' && args[0].includes('/host-result-') && doubles.afterResultWritten) await doubles.afterResultWritten();
  };
  return { ...actual, default: { ...actual, writeFile: wrappedWriteFile }, writeFile: wrappedWriteFile };
});
vi.mock('./stdio-client', () => ({ ReaStdioClient: class {
  readonly start = vi.fn(async () => { await doubles.onStart?.(); });
  readonly close = vi.fn(async () => { await doubles.onClose?.(); });
  #artifactPath: unknown;
  readonly callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'analyze_javascript_application') this.#artifactPath = args.input_path;
    return { isError: false, content: [],
      structuredContent: { normalized_result: { kind: 'summary', parent_operation: 'analyze_javascript_application',
        artifact: { path: doubles.wrongArtifact ? '/synthetic/NOT_THE_SELECTED_TARGET' : this.#artifactPath },
        parent_evidence_id: `ev_${(doubles.wrongParent ? 'b' : 'a').repeat(64)}`, summary: { synthetic: true } } },
      provenance: { untrusted: true, localOnly: true, sessionId: 'synthetic-transport', requestId: 3 } };
  });
  constructor() { doubles.clients.push(this); }
} }));
// Use the actual target boundary and real synthetic disk snapshot. Only MCP
// transport is doubled; these tests cannot prove actual REA/worker execution.
import { ReaService } from './service';
const base = process.env.DESKPET_REA_SERVICE_EVIDENCE ?? join(tmpdir(),'deskpet-rea-service-unit-fixtures');
const owned: string[] = [], services: ReaService[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const lease = () => {
  const controller = new AbortController(), release = vi.fn();
  const value: PermissionLease = { signal: controller.signal, assertCurrent: () => { if (controller.signal.aborted) throw Error('permission.revoked'); }, release };
  return { value, controller, release };
};
async function fixture() {
  await mkdir(base, { recursive: true, mode: 0o700 }); const root = await realpath(await mkdtemp(join(base, 'wrapper-'))); owned.push(root);
  const profile = join(root, 'profile'), source = join(root, 'selected'); await mkdir(profile, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'package.json'), JSON.stringify({ main: 'main.js' })); await writeFile(join(source, 'main.js'), "throw Error('SYNTHETIC_MUST_NOT_EXECUTE');");
  const hash = 'b'.repeat(64), manifest = join(root, 'runtime.json'), packageRoot=join(root,'runtime');await mkdir(packageRoot);
  const executablePath=join(packageRoot,'node'),entryPath=join(packageRoot,'rea.mjs'),manifestPath=join(root,'runtime-manifest.json');
  await writeFile(executablePath,'synthetic executable');await writeFile(entryPath,'synthetic entry');await writeFile(manifestPath,'{}');
  await writeFile(manifest, JSON.stringify({ executablePath, executableSHA256: hash, entryPath, entrySHA256: hash,
    packageRoot, manifestPath, manifestSHA256: hash, expectedToolContractsSHA256: hash }));
  let sessionValid = true; const supplied = lease(), consume = vi.fn(async (): Promise<PermissionLease> => supplied.value);
  const service = new ReaService(profile, manifest, { assertSession: () => { if (!sessionValid) throw Error('rea.sessionUnavailable'); }, lease: consume }); services.push(service);
  const session = 'session-synthetic', target = await service.bind(session, source, supplied.value);
  return { root, profile, source, service, session, target, supplied, consume, manifest, entryPath, invalidateSession: () => { sessionValid = false; } };
}
beforeEach(() => { doubles.wrongArtifact = false; doubles.wrongParent = false; doubles.clients.length = 0; doubles.onStart = null; doubles.onClose = null; doubles.afterResultWritten = null; });
afterEach(async () => { doubles.onStart = null; doubles.onClose = null; doubles.afterResultWritten = null; await Promise.all(services.splice(0).map((s) => s.shutdown().catch(() => undefined))); await Promise.all(owned.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe('production REA service wrapper with explicit synthetic transport double', () => {
  it('distinguishes missing configuration, missing runtime and unverified configuration without starting a process', async () => {
    const s=await fixture();
    expect(await s.service.status()).toMatchObject({available:false,verified:false,reasonCode:'rea.runtimeNotChecked',checkedAt:null});
    expect(doubles.clients[0]!.start).not.toHaveBeenCalled();
    await rm(s.entryPath);expect(await s.service.status()).toMatchObject({available:false,reasonCode:'rea.runtimeMissing'});
    await rm(s.manifest);expect(await s.service.status()).toMatchObject({available:false,reasonCode:'rea.runtimeUnavailable'});
  });
  it('explicitly checks the runtime once, closes the check process and invalidates readiness when configured files change', async () => {
    const s=await fixture(),entered=deferred(),barrier=deferred();
    doubles.onStart=async()=>{entered.resolve();await barrier.promise;};
    const check=s.service.checkRuntime();await entered.promise;expect(s.service.active).toBe(true);
    expect(s.service.checkRuntime()).toBe(check);barrier.resolve();
    expect(await check).toMatchObject({available:true,verified:true,active:false,reasonCode:'rea.ready'});
    expect(doubles.clients[1]!.start).toHaveBeenCalledOnce();expect(doubles.clients[1]!.close).toHaveBeenCalledOnce();
    expect(doubles.clients[1]!.callTool).not.toHaveBeenCalled();expect(s.supplied.release).toHaveBeenCalledOnce();
    expect(await s.service.status()).toMatchObject({available:true,reasonCode:'rea.ready'});
    await writeFile(s.entryPath,'runtime changed');
    expect(await s.service.status()).toMatchObject({available:false,reasonCode:'rea.runtimeNotChecked'});
  });
  it('does not claim readiness for a rejected tool contract or unconfirmed process cleanup', async () => {
    const s=await fixture();doubles.onStart=async()=>{throw Error('rea.toolContractMismatch');};
    expect(await s.service.checkRuntime()).toMatchObject({available:false,verified:false,reasonCode:'rea.toolContractMismatch'});
    doubles.onStart=null;doubles.onClose=async()=>{throw Error('rea.cleanupUnconfirmed');};
    expect(await s.service.checkRuntime()).toMatchObject({available:false,reasonCode:'rea.cleanupUnconfirmed'});
  });
  it('cancels all targets without permanently closing the service, allowing plugin re-enable', async () => {
    const s=await fixture();await s.service.cancelAll();
    expect(doubles.clients[0]!.close).toHaveBeenCalledOnce();
    await expect(s.service.analyze({sessionId:s.session,targetId:s.target.id})).rejects.toThrow('rea.targetTokenInvalid');
    const target=await s.service.bind(s.session,s.source);
    expect(await s.service.analyze({sessionId:s.session,targetId:target.id})).toMatchObject({targetId:target.id});
  });
  it('invalidates a runtime check cancelled during startup instead of publishing late readiness', async () => {
    const s=await fixture(),entered=deferred(),barrier=deferred();doubles.onStart=async()=>{entered.resolve();await barrier.promise;};
    const checking=s.service.checkRuntime();await entered.promise;
    const cancelled=s.service.cancelAll();barrier.resolve();await cancelled;
    expect(await checking).toMatchObject({available:false,reasonCode:'rea.cancelled'});expect(s.service.active).toBe(false);
    doubles.onStart=null;expect(await s.service.checkRuntime()).toMatchObject({available:true,reasonCode:'rea.ready'});
  });
  it('uses the chooser supplied lease once, preserves target/source identity and session ownership', async () => {
    const s = await fixture(); expect(s.consume).not.toHaveBeenCalled(); expect(s.supplied.release).not.toHaveBeenCalled();
    expect(s.target).toMatchObject({ sessionId: s.session, kind: 'directory', files: 2 });
    expect(await readFile(join(s.source, 'main.js'), 'utf8')).toContain('SYNTHETIC_MUST_NOT_EXECUTE');
    await expect(s.service.analyze({ sessionId: 'other', targetId: s.target.id })).rejects.toThrow('rea.targetTokenInvalid');
    expect(doubles.clients[0]!.callTool).not.toHaveBeenCalled();
  });
  it('refuses material whose successful tool envelope names a different target artifact', async () => {
    const s = await fixture(); doubles.wrongArtifact = true;
    await expect(s.service.analyze({ sessionId: s.session, targetId: s.target.id })).rejects.toThrow(/rea\./u);
  });
  it('retains inspect association to the original analysis and refuses a foreign parent evidence id', async () => {
    const s = await fixture(), analyzed = await s.service.analyze({ sessionId: s.session, targetId: s.target.id });
    const inspected = await s.service.inspect({ sessionId: s.session, targetId: s.target.id, resultId: analyzed.id, view: 'summary' });
    expect(inspected).toMatchObject({ targetId: s.target.id, sessionId: s.session, tool: 'inspect_analysis_view', untrusted: true });
    doubles.wrongParent = true;
    await expect(s.service.inspect({ sessionId: s.session, targetId: s.target.id, resultId: analyzed.id, view: 'summary' })).rejects.toThrow(/rea\./u);
  });
  it('reserves the operation before awaiting a permission lease; a second call cannot clear its active state', async () => {
    const s = await fixture(), barrier = deferred(), entered = deferred(); s.consume.mockImplementation(async () => { entered.resolve(); await barrier.promise; return s.supplied.value; });
    const first = s.service.analyze({ sessionId: s.session, targetId: s.target.id }); await entered.promise; expect(s.service.active).toBe(true);
    await expect(s.service.analyze({ sessionId: s.session, targetId: s.target.id })).rejects.toThrow('rea.sessionBusy'); expect(s.service.active).toBe(true);
    barrier.resolve(); const result = await first; expect(result.untrusted).toBe(true); expect(result.privacy).toBe('local-only'); expect(s.service.active).toBe(false);
    expect(s.consume).toHaveBeenCalledTimes(1); expect(doubles.clients[0]!.callTool).toHaveBeenCalledTimes(1);
  });
  it('cancels while lease acquisition is suspended without starting transport or publishing late success', async () => {
    const s = await fixture(), entered = deferred(), barrier = deferred(); s.consume.mockImplementation(async () => { entered.resolve(); await barrier.promise; return s.supplied.value; });
    const result = s.service.analyze({ sessionId: s.session, targetId: s.target.id }); await Promise.race([entered.promise,result.then(()=>{throw Error('operation completed before write barrier');},error=>{throw error;})]); await s.service.cancel(s.session); barrier.resolve();
    await expect(result).rejects.toThrow('rea.operationFailed'); expect(doubles.clients[0]!.start).not.toHaveBeenCalled(); expect(doubles.clients[0]!.callTool).not.toHaveBeenCalled(); expect(s.service.active).toBe(false);
    expect(s.supplied.release).toHaveBeenCalledOnce();
  });
  it('closes its transport on permission revocation during startup and never submits a tool', async () => {
    const s = await fixture(), entered = deferred(), barrier = deferred(); doubles.onStart = async () => { entered.resolve(); await barrier.promise; };
    const result = s.service.analyze({ sessionId: s.session, targetId: s.target.id }); await entered.promise; s.supplied.controller.abort(); await Promise.resolve();
    expect(doubles.clients[0]!.close).toHaveBeenCalled(); barrier.resolve(); await expect(result).rejects.toThrow('rea.operationFailed'); expect(doubles.clients[0]!.callTool).not.toHaveBeenCalled();
    expect(s.service.active).toBe(false); await expect(s.service.analyze({ sessionId: s.session, targetId: s.target.id })).rejects.toThrow('rea.targetTokenInvalid');
  });
  it('does not return or authorize a result canceled after its artifact was written to disk', async () => {
    const s = await fixture(), entered = deferred(), barrier = deferred(); doubles.afterResultWritten = async () => { entered.resolve(); await barrier.promise; };
    const result = s.service.analyze({ sessionId: s.session, targetId: s.target.id }); await Promise.race([entered.promise,result.then(()=>{throw Error('operation completed before write barrier');},error=>{throw error;})]); await s.service.cancel(s.session); barrier.resolve();
    await expect(result).rejects.toThrow('rea.operationFailed'); expect(doubles.clients[0]!.callTool).toHaveBeenCalledOnce();
    const sessionRoot = join(s.profile, 'rea-analysis', s.session), directory = (await readdir(sessionRoot))[0]!;
    const files = await readdir(join(sessionRoot, directory)), filename = files.find((f) => f.startsWith('host-result-'))!; expect(filename).toBeTruthy();
    const saved = JSON.parse(await readFile(join(sessionRoot, directory, filename), 'utf8')) as { result: { id: string; text: string } };
    expect(() => s.service.material(s.session, saved.result.id)).toThrow('rea.analysisTokenInvalid');
  });
  it('rechecks session validity before exposing a completed artifact', async () => {
    const s = await fixture(), entered = deferred(), barrier = deferred(); doubles.afterResultWritten = async () => { entered.resolve(); await barrier.promise; };
    const result = s.service.analyze({ sessionId: s.session, targetId: s.target.id }); await Promise.race([entered.promise,result.then(()=>{throw Error('operation completed before write barrier');},error=>{throw error;})]); s.invalidateSession(); barrier.resolve();
    await expect(result).rejects.toThrow('rea.sessionUnavailable'); expect(() => s.service.material(s.session, 'unavailable')).toThrow('rea.sessionUnavailable');
  });
});
