// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainRepository } from '../domain';
import { registerBuiltinTools } from '../tools/builtins';
import { SecureWebReader } from '../tools/web-reader';
import { WorkspaceAccess } from '../tools/workspace';
import { AgentRuntime } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionGate } from './permissions';
import { TaskEventStream } from './task-event-stream';
import { ToolRegistry } from './tool-registry';

const roots: string[] = [];
const evidenceRoot = '/private/tmp/deskpet/output/deskpet-electron-tool-boundary-20261028/dispatch-audit';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-execution-boundary-')); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, 'allowed.txt'), 'SYNTHETIC_BEFORE');
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 113) }); await repository.initialize(); await repository.transaction(() => undefined);
  const permissions = new PermissionGate(repository);
  const events = new TaskEventStream(join(root, 'events.jsonl')); await events.initialize();
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, { workspace: new WorkspaceAccess(workspaceRoot), web: new SecureWebReader(), notify: async () => undefined, createTimer: async () => ({ timerId: randomUUID() }) });
  const ledger = new EffectLedger(repository); const runtime = new AgentRuntime(tools, permissions, ledger, events);
  const runId = randomUUID();
  const input = { path: 'allowed.txt', content: 'SYNTHETIC_AFTER' };
  const call = { id: 'model-label-is-not-an-owner', toolId: 'workspace.write', input, effectKey: `host-synthetic:${runId}:0:0` };
  const driver = () => { let round = 0; return { next: async () => ++round === 1 ? { type: 'tools' as const, calls: [call] } : { type: 'final' as const, content: 'done' } }; };
  const save = async (name: string, extra: Record<string, unknown>): Promise<void> => {
    const directory = join(evidenceRoot, `${new Date().toISOString().replaceAll(':', '-')}-${name}-${runId.slice(0, 8)}`); await mkdir(directory, { recursive: true });
    const actual = await readFile(join(workspaceRoot, 'allowed.txt'), 'utf8');
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ name, input, runId, modelCallId: call.id, trustedEffectKey: call.effectKey,
      independentFile: { path: 'allowed.txt', content: actual, sha256: sha256(actual) }, state: repository.snapshot(), events: await events.readAll(), ...extra }, null, 2));
    await copyFile(join(root, 'profile.enc.json'), join(directory, 'profile.enc.json'));
  };
  return { root, workspaceRoot, repository, permissions, ledger, runtime, driver, runId, save };
};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('allows a granted production builtin through AgentRuntime and records the actual file mutation', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  try {
    expect((await f.runtime.run('synthetic authorized write', f.driver(), f.runId)).status).toBe('succeeded');
    expect(await readFile(join(f.workspaceRoot, 'allowed.txt'), 'utf8')).toBe('SYNTHETIC_AFTER');
  } finally { await f.save('allowed-write', { expected: 'SYNTHETIC_AFTER' }); }
});

it('keeps a consumed one-shot host lease usable for its single legitimate operation', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'once');
  try {
    expect((await f.runtime.run('synthetic one-shot authorized write', f.driver(), f.runId)).status).toBe('succeeded');
    expect(await readFile(join(f.workspaceRoot, 'allowed.txt'), 'utf8')).toBe('SYNTHETIC_AFTER');
    await expect(f.permissions.consume('workspace.write')).rejects.toMatchObject({ capabilityId: 'workspace.write' });
  } finally { await f.save('one-shot-authorized-write', { expected: 'SYNTHETIC_AFTER', subsequentUseDenied: true }); }
});

it('rechecks authorization after asynchronous dispatch delay and before a new actual write', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  let arrived!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const actualExecute = f.ledger.execute.bind(f.ledger);
  vi.spyOn(f.ledger, 'execute').mockImplementation(async (...args) => { arrived(); await delayed; return actualExecute(...args); });
  const running = f.runtime.run('synthetic delayed write', f.driver(), f.runId);
  await entered; await f.permissions.revoke('workspace.write'); release();
  let observed: unknown;
  try {
    await expect(running.catch((error: unknown) => { observed = error; throw error; })).rejects.toMatchObject({ code: 'tool.permission.workspace.write' });
    expect(await readFile(join(f.workspaceRoot, 'allowed.txt'), 'utf8')).toBe('SYNTHETIC_BEFORE');
  } finally { await f.save('revoked-before-start', { expected: 'SYNTHETIC_BEFORE', observedError: observed instanceof Error ? observed.message : null }); }
});

it('cancels a queued action before it starts without claiming reversal of completed effects', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  let arrived!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const actualExecute = f.ledger.execute.bind(f.ledger);
  vi.spyOn(f.ledger, 'execute').mockImplementation(async (...args) => { arrived(); await delayed; return actualExecute(...args); });
  const running = f.runtime.run('synthetic queued cancellation', f.driver(), f.runId);
  await entered; expect(f.runtime.cancel(f.runId)).toBe(true); release();
  try {
    expect((await running).status).toBe('cancelled');
    expect(await readFile(join(f.workspaceRoot, 'allowed.txt'), 'utf8')).toBe('SYNTHETIC_BEFORE');
  } finally { await f.save('cancelled-before-start', { expected: 'SYNTHETIC_BEFORE' }); }
});

it('keeps a completed file effect observable when cancellation stops subsequent work', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  try {
    const result = await f.runtime.run('synthetic cancel after completed write', f.driver(), f.runId, [], async () => { f.runtime.cancel(f.runId); });
    expect(result.status).toBe('cancelled');
    expect(await readFile(join(f.workspaceRoot, 'allowed.txt'), 'utf8')).toBe('SYNTHETIC_AFTER');
    expect(f.repository.snapshot().sideEffects).toHaveLength(1);
  } finally { await f.save('cancel-after-completed-effect', { expected: 'SYNTHETIC_AFTER', cancellationDoesNotUndoCompletedWrite: true }); }
});

it('allows public HTTPS through the controlled requester without disabling network reads', async () => {
  const sent: Array<{ url: string; address: string; aborted: boolean }> = [];
  const reader = new SecureWebReader({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], requester: async (url, address, signal) => {
    sent.push({ url: url.toString(), address: address.address, aborted: signal.aborted });
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: (async function* () { yield Buffer.from('SYNTHETIC_PUBLIC_RESPONSE'); })() };
  } });
  expect((await reader.read('https://synthetic-boundary.example/public')).text).toBe('SYNTHETIC_PUBLIC_RESPONSE');
  expect(sent).toEqual([{ url: 'https://synthetic-boundary.example/public', address: '8.8.8.8', aborted: false }]);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, `public-https-${Date.now()}.json`), JSON.stringify({ sent, requesterConfiguration: 'synthetic DNS and requester; no real public network requested' }, null, 2));
});

it.each(['::ffff:7f00:1', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0'])('rejects private IPv4 embedded in IPv6 DNS answer %s before requesting', async (address) => {
  const sent: string[] = [];
  const reader = new SecureWebReader({ resolver: async () => [{ address, family: 6 }], requester: async (url) => {
    sent.push(url.toString()); return { status: 200, headers: { 'content-type': 'text/plain' }, body: (async function* () { yield Buffer.from('SYNTHETIC_PRIVATE_RESPONSE'); })() };
  } });
  let observed: unknown;
  try {
    await expect(reader.read('https://synthetic-boundary.example/')).rejects.toMatchObject({ code: 'tool.webTarget' });
    expect(sent).toEqual([]);
  } catch (error) { observed = error; throw error; }
  finally {
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `ipv6-${address.replaceAll(':', '_')}-${Date.now()}.json`), JSON.stringify({ syntheticDnsAddress: address, sent, expectedRequesterCalls: 0, observedAssertion: observed instanceof Error ? observed.message : null }, null, 2));
  }
});
