// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { DomainRepository } from '../domain/repository';
import { AgentRuntime } from '../runtime/agent-runtime';
import { EffectLedger } from '../runtime/effect-ledger';
import { PermissionGate } from '../runtime/permissions';
import { TaskEventStream } from '../runtime/task-event-stream';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerBuiltinTools } from './builtins';
import { SecureWebReader } from './web-reader';
import { WorkspaceAccess } from './workspace';

const hooks = vi.hoisted(() => ({ afterLstat: undefined as undefined | ((path: string) => Promise<void>), afterStat: undefined as undefined | ((path: string) => Promise<void>), afterOpen: undefined as undefined | ((path: string) => Promise<void>), afterRealpath: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => { const result = await actual.lstat(...args); await hooks.afterLstat?.(String(args[0])); return result; },
    stat: async (...args: Parameters<typeof actual.stat>) => { const result = await actual.stat(...args); await hooks.afterStat?.(String(args[0])); return result; },
    open: async (...args: Parameters<typeof actual.open>) => { const result = await actual.open(...args); await hooks.afterOpen?.(String(args[0])); return result; },
    realpath: async (...args: Parameters<typeof actual.realpath>) => { const result = await actual.realpath(...args); await hooks.afterRealpath?.(String(args[0])); return result; },
  };
});

const roots: string[] = [];
const artifactRoot = join('/private/tmp/deskpet/output/deskpet-electron-tool-boundary-20261028/file-audit', `run-${new Date().toISOString().replaceAll(':', '-')}`);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const record = async (name: string, data: unknown): Promise<void> => { await mkdir(artifactRoot, { recursive: true }); await writeFile(join(artifactRoot, `${name}.json`), JSON.stringify(data, null, 2)); };
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true; } catch { return false; } };
const fixture = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-tool-boundary-workspace-'))); roots.push(base);
  const a = join(base, 'A'); const b = join(base, 'B'); await mkdir(a); await mkdir(b);
  const marker = 'SYNTHETIC_OUTSIDE_B_PRIVATE_CONTENT'; await writeFile(join(b, 'sentinel.txt'), marker);
  const repo = new DomainRepository(join(base, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 19) }); await repo.initialize();
  const events = new TaskEventStream(join(base, 'events.jsonl')); await events.initialize();
  const permissions = new PermissionGate(repo); await permissions.grant('workspace.read', 'session'); await permissions.grant('workspace.write', 'session');
  const tools = new ToolRegistry(); registerBuiltinTools(tools, { workspace: new WorkspaceAccess(a), web: new SecureWebReader(), notify: async () => undefined, createTimer: async () => ({ timerId: randomUUID() }) });
  const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repo), events);
  const call = async (toolId: string, input: unknown): Promise<{ output?: unknown; error?: string }> => {
    let iteration = 0; let output: unknown;
    try { await runtime.run('Synthetic authorized tool boundary fixture', { next: async () => ++iteration === 1
      ? { type: 'tools', calls: [{ id: randomUUID(), toolId, input, effectKey: randomUUID() }] } : { type: 'final', content: 'complete' } }, randomUUID(), [], async (_tool, result) => { output = result; }); return { output }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  return { base, a, b, marker, call, repo, bDigest: async () => sha256(await readFile(join(b, 'sentinel.txt'), 'utf8')) };
};
afterEach(async () => { hooks.afterLstat = undefined; hooks.afterStat = undefined; hooks.afterOpen = undefined; hooks.afterRealpath = undefined; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('production AgentRuntime workspace execution boundary', () => {
  it('allows an authorized A write/read and rejects lexical outside B without changing B', async () => {
    const f = await fixture(); const before = await f.bDigest();
    const allowed = await f.call('workspace.write', { path: 'allowed/note.txt', content: 'SYNTHETIC_A_ALLOWED' });
    const read = await f.call('workspace.read', { path: 'allowed/note.txt' });
    const denied = await f.call('workspace.write', { path: '../B/sentinel.txt', content: 'SHOULD_NEVER_PUBLISH' });
    const deniedRead = await f.call('workspace.read', { path: '../B/sentinel.txt' });
    const after = await f.bDigest();
    await record('allow-A-deny-B', { a: f.a, b: f.b, input: { allowed: 'allowed/note.txt', denied: '../B/sentinel.txt' }, allowed, read, denied, deniedRead, bBeforeSHA256: before, bAfterSHA256: after, persistedSideEffects: f.repo.snapshot().sideEffects });
    expect(allowed.error).toBeUndefined(); expect(await readFile(join(f.a, 'allowed/note.txt'), 'utf8')).toBe('SYNTHETIC_A_ALLOWED'); expect(read.output).toEqual({ content: 'SYNTHETIC_A_ALLOWED', offset: 0, totalCharacters: 'SYNTHETIC_A_ALLOWED'.length, nextOffset: null, truncated: false, sourceSHA256: sha256('SYNTHETIC_A_ALLOWED') });
    expect(denied.error).toBeDefined(); expect(deniedRead.error).toBeDefined(); expect(after).toBe(before);
  });

  it('rejects a symlink parent before creating any directory or file outside B', async () => {
    const f = await fixture(); const before = await f.bDigest(); await symlink(f.b, join(f.a, 'linked'));
    const result = await f.call('workspace.write', { path: 'linked/new-parent/note.txt', content: 'NO_OUTSIDE_MUTATION' });
    const outsideParentCreated = await exists(join(f.b, 'new-parent')); const outsideFileCreated = await exists(join(f.b, 'new-parent/note.txt'));
    await record('symlink-parent-mkdir', { input: 'linked/new-parent/note.txt', result, outsideParentCreated, outsideFileCreated, bBeforeSHA256: before, bAfterSHA256: await f.bDigest(), outsideListing: await readdir(f.b) });
    expect(result.error).toBeDefined(); expect(outsideParentCreated).toBe(false); expect(outsideFileCreated).toBe(false); expect(await f.bDigest()).toBe(before);
  });

  it('does not adopt an outside target when the host-selected workspace root entry is a symlink', async () => {
    const f = await fixture(); const before = await f.bDigest();
    await rename(f.a, `${f.a}.before-root-swap`); await symlink(f.b, f.a);
    const result = await f.call('workspace.write', { path: 'sentinel.txt', content: 'SYNTHETIC_ROOT_ALIAS_MUST_NOT_PUBLISH' });
    const read = await f.call('workspace.read', { path: 'sentinel.txt' });
    const after = await f.bDigest();
    await record('root-entry-symlink', { input: 'sentinel.txt', result, read, bBeforeSHA256: before, bAfterSHA256: after, bActualContent: await readFile(join(f.b, 'sentinel.txt'), 'utf8') });
    expect(result.error).toBeDefined(); expect(read.error).toBeDefined(); expect(after).toBe(before);
  });

  it('does not read B through a hard-linked file alias inside A', async () => {
    const f = await fixture(); await link(join(f.b, 'sentinel.txt'), join(f.a, 'aliased.txt'));
    const result = await f.call('workspace.read', { path: 'aliased.txt' });
    await record('hardlink-read', { input: 'aliased.txt', result, outsideContentObserved: JSON.stringify(result.output ?? null).includes(f.marker), bSHA256: await f.bDigest() });
    expect(JSON.stringify(result.output ?? null)).not.toContain(f.marker); expect(result.error).toBeDefined();
  });

  it('binds an actual read descriptor before a leaf can be swapped to an outside symlink', async () => {
    const f = await fixture(); const target = join(f.a, 'value.txt'); await writeFile(target, 'SYNTHETIC_A_READ'); let swapped = false;
    const swap = async (path: string): Promise<void> => {
      if (path !== target || swapped) return; swapped = true; hooks.afterLstat = undefined; hooks.afterStat = undefined; hooks.afterOpen = undefined;
      await rename(target, `${target}.before-swap`); await symlink(join(f.b, 'sentinel.txt'), target);
    };
    hooks.afterLstat = swap; hooks.afterStat = swap; hooks.afterOpen = swap;
    const result = await f.call('workspace.read', { path: 'value.txt' });
    await record('leaf-swap-read', { input: 'value.txt', swapTriggered: swapped, result, outsideContentObserved: JSON.stringify(result.output ?? null).includes(f.marker), bSHA256: await f.bDigest(), injection: 'Only pauses after the actual fs lstat/stat or open returns; the real inode is renamed and a real outside symlink installed before production access continues.' });
    expect(swapped).toBe(true); expect(JSON.stringify(result.output ?? null)).not.toContain(f.marker);
  });

  it('does not publish outside B after its validated A parent is swapped', async () => {
    const f = await fixture(); const parent = join(f.a, 'notes'); await mkdir(parent); let swapped = false;
    const swap = async (path: string): Promise<void> => {
      if (path !== parent || swapped) return; swapped = true; hooks.afterLstat = undefined; hooks.afterRealpath = undefined; hooks.afterOpen = undefined;
      await rename(parent, `${parent}.before-swap`); await symlink(f.b, parent);
    };
    hooks.afterLstat = swap; hooks.afterRealpath = swap; hooks.afterOpen = swap;
    const result = await f.call('workspace.write', { path: 'notes/published.txt', content: 'SYNTHETIC_MUST_STAY_INSIDE_A' });
    const outsideFileCreated = await exists(join(f.b, 'published.txt'));
    await record('parent-swap-write', { input: 'notes/published.txt', swapTriggered: swapped, result, outsideFileCreated, outsideFileContent: outsideFileCreated ? await readFile(join(f.b, 'published.txt'), 'utf8') : null, outsideListing: await readdir(f.b), bSHA256: await f.bDigest(), injection: 'Only pauses after actual parent lstat/realpath or directory open; real directory is renamed and real outside symlink installed.' });
    expect(swapped).toBe(true); expect(outsideFileCreated).toBe(false);
  });
});
