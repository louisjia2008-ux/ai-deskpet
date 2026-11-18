// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchBinding, ResearchExecutionResult, ResearchTask, ResearchTaskInput } from '../../shared/research-tasks';
import { researchTaskInputSchema } from '../../shared/research-tasks';
import { EncryptedJsonStore, EncryptedStoreWriteError } from '../persistence/encrypted-json-store';
import { DomainRepository } from './repository';
import { ResearchTaskService } from './research-task-service';
import type { ResearchTaskHost } from './research-task-service';
import { persistentStateSchema } from './schemas';

const roots: string[] = [], services: ResearchTaskService[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const providerId = '6dd05ee1-947c-460f-847a-488e1d2129a4';
const input = (goal = 'Compare the public evidence'): ResearchTaskInput => ({ operationId: randomUUID(), goal,
  material: 'ONLY_EXPLICIT_PUBLIC_MATERIAL', providerId, model: 'synthetic-model', allowRemote: false, maxMinutes: 10, maxToolCalls: 20 });
const report = (task: ResearchTask): ResearchExecutionResult => ({ status: 'completed', summary: `Finished ${task.input.goal}`,
  artifacts: [{ path: task.reportPath, bytes: 100, sha256: 'b'.repeat(64) }], sources: [{ title: 'Official example', url: 'https://example.com/source' }], messageId: randomUUID() });

const fixture = async (overrides: Partial<ResearchTaskHost> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-research-')); roots.push(root);
  const path = join(root, 'profile.enc.json'), vault = { getVaultKey: async () => Buffer.alloc(32, 19) };
  const repo = new DomainRepository(path, vault); await repo.initialize();
  let binding: ResearchBinding = { fingerprint: 'a'.repeat(64), destination: 'local' };
  const execute = vi.fn<ResearchTaskHost['execute']>(overrides.execute ?? (async task => report(task)));
  const createSession = vi.fn<ResearchTaskHost['createSession']>(overrides.createSession ?? (async () => randomUUID()));
  const validateBinding = vi.fn<ResearchTaskHost['validateBinding']>(overrides.validateBinding ?? (async () => binding));
  const host: ResearchTaskHost = { execute, createSession, validateBinding };
  const service = new ResearchTaskService(repo, host); services.push(service); await service.initialize();
  const settled = async (id: string): Promise<ResearchTask> => {
    await vi.waitFor(async () => expect(['queued', 'running']).not.toContain((await service.get(id)).status));
    return service.get(id);
  };
  return { root, path, vault, repo, host, service, execute, createSession, validateBinding, settled, setBinding: (next: ResearchBinding) => { binding = next; } };
};

describe('bounded background research service', () => {
  it('accepts one idempotent task, supplies only selected material and persists verified results in the encrypted profile', async () => {
    const f = await fixture();
    await f.repo.transaction(state => {
      const at = new Date().toISOString(), sessionId = randomUUID();
      state.chatSessions.push({ id: sessionId, title: 'UNRELATED_PRIVATE_CHAT', kind: 'normal', createdAt: at, updatedAt: at });
      state.chatMessages.push({ id: randomUUID(), sessionId, role: 'user', content: 'UNRELATED_PRIVATE_TEXT', status: 'complete', createdAt: at, errorCode: null });
    });
    const request = input(), [first, duplicate] = await Promise.all([f.service.submit(request), f.service.submit(request)]);
    expect(first.id).toBe(duplicate.id);
    const saved = await f.settled(first.id);
    expect(saved.status).toBe('completed'); expect(saved.attempts).toHaveLength(1);
    expect(saved.reportPath).toBe(`research/${saved.id}/report.md`);
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.createSession).toHaveBeenCalledOnce();
    const [task, control] = f.execute.mock.calls[0]!;
    expect(control.prompt).toContain(request.material); expect(control.prompt).not.toContain('UNRELATED_PRIVATE');
    expect(JSON.stringify(task)).not.toContain('UNRELATED_PRIVATE');
    expect(task.sessionId).toBe(saved.sessionId);
    const reopened = new DomainRepository(f.path, f.vault); await reopened.initialize();
    expect(reopened.snapshot().researchTasks[0]?.artifacts).toEqual(saved.artifacts);
    expect(await readFile(f.path, 'utf8')).not.toContain(request.material);
    await expect(f.service.submit({ ...request, goal: 'Changed goal' })).rejects.toThrow('research.operationConflict');
  });

  it('requires explicit remote consent and rejects caller-selected output paths and invalid execution limits', async () => {
    const f = await fixture(); f.setBinding({ fingerprint: 'a'.repeat(64), destination: 'remote' });
    await expect(f.service.submit(input())).rejects.toThrow('research.privacyBlocked');
    expect(f.repo.snapshot().researchTasks).toEqual([]);
    await expect(f.service.submit({ ...input(), maxMinutes: 31 })).rejects.toThrow('research.invalidInput');
    await expect(f.service.submit({ ...input(), maxToolCalls: 41 })).rejects.toThrow('research.invalidInput');
    expect(researchTaskInputSchema.safeParse({ ...input(), reportPath: '../outside.md' }).success).toBe(false);
    const task = await f.service.submit({ ...input(), allowRemote: true });
    expect((await f.settled(task.id)).status).toBe('completed');
  });

  it('does not claim completion without a verified report from this attempt', async () => {
    const f = await fixture({ execute: async () => ({ status: 'completed', summary: 'The model said it saved a file.', artifacts: [] }) });
    const task = await f.service.submit(input());
    expect(await f.settled(task.id)).toMatchObject({ status: 'partial', errorCode: 'research.reportMissing', artifacts: [] });
  });

  it.each(['../outside.md', 'research/other/report.md', 'research/TASK/../outside.md', 'research/TASK/nested\\outside.md'])('rejects host artifacts outside the fixed task folder: %s', async path => {
    const f = await fixture({ execute: async task => ({ status: 'completed', summary: 'invalid', artifacts: [{ path: path.replace('TASK', task.id), bytes: 1, sha256: 'c'.repeat(64) }] }) });
    const task = await f.service.submit(input());
    expect(await f.settled(task.id)).toMatchObject({ status: 'failed', errorCode: 'research.artifactOutsideTask', artifacts: [] });
  });

  it('executes FIFO with one host call at a time and never creates a session for a cancelled queued task', async () => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async task => { if (task.input.goal === 'first') await gate.promise; return report(task); } });
    const first = await f.service.submit(input('first'));
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const second = await f.service.submit(input('second')), removed = await f.service.submit(input('cancelled while queued')), third = await f.service.submit(input('third'));
    await f.service.cancel(removed.id);
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.createSession).toHaveBeenCalledOnce();
    gate.resolve(); await f.settled(first.id); await f.settled(second.id); await f.settled(third.id);
    expect(f.execute.mock.calls.map(([task]) => task.input.goal)).toEqual(['first', 'second', 'third']);
    expect((await f.service.get(removed.id)).sessionId).toBeNull();
  });

  it('cancels a noncooperative host promptly, runs the next task, and suppresses late results and actions', async () => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async task => { if (task.input.goal === 'first') await gate.promise; return report(task); } });
    const first = await f.service.submit(input('first')); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const control = f.execute.mock.calls[0]![1], second = await f.service.submit(input('second'));
    await f.service.cancel(first.id);
    expect(control.signal.aborted).toBe(true);
    expect((await f.settled(second.id)).status).toBe('completed');
    gate.resolve(); await expect(control.assertCurrent()).rejects.toThrow();
    expect(await f.service.get(first.id)).toMatchObject({ status: 'cancelled', summary: '', artifacts: [], cancelRequestedAt: expect.any(String) });
  });

  it('explicitly resumes in the same session with previous evidence and idempotent operation receipts', async () => {
    const f = await fixture();
    f.execute.mockImplementationOnce(async task => ({ ...report(task), status: 'partial', summary: 'Verified two sources; compare the third next.' }));
    const created = await f.service.submit(input()), previous = await f.settled(created.id);
    const request = { id: created.id, operationId: randomUUID() };
    await Promise.all([f.service.resume(request), f.service.resume(request)]);
    const completed = await f.settled(created.id);
    expect(completed.status).toBe('completed'); expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts[0]?.summary).toContain('compare the third');
    expect(completed.sessionId).toBe(previous.sessionId); expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledTimes(2);
    const control = f.execute.mock.calls[1]![1];
    expect(control.prompt).toContain('SAME task and session'); expect(control.prompt).toContain('compare the third');
    expect(control.prompt).toContain('https://example.com/source'); expect(control.prompt).toContain(previous.reportPath);
    await f.service.resume(request); expect(f.execute).toHaveBeenCalledTimes(2);
    await expect(f.service.submit({ ...input(), operationId: request.operationId })).rejects.toThrow('research.operationConflict');
  });

  it.each([
    { fingerprint: 'd'.repeat(64), destination: 'local' as const },
    { fingerprint: 'a'.repeat(64), destination: 'remote' as const },
  ])('rechecks provider fingerprint and destination during execution, before queued execution and before continuation: %j', async changedBinding => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async task => { await gate.promise; return report(task); } });
    const first = await f.service.submit({ ...input('first'), allowRemote: true }); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const second = await f.service.submit({ ...input('second'), allowRemote: true }), control = f.execute.mock.calls[0]![1];
    f.setBinding(changedBinding);
    await expect(control.assertCurrent()).rejects.toThrow('research.bindingChanged');
    gate.resolve();
    expect(await f.settled(first.id)).toMatchObject({ status: 'failed', errorCode: 'research.bindingChanged', artifacts: [] });
    expect(await f.settled(second.id)).toMatchObject({ status: 'failed', errorCode: 'research.bindingChanged' });
    expect(f.execute).toHaveBeenCalledOnce();
    await expect(f.service.resume({ id: first.id, operationId: randomUUID() })).rejects.toThrow('research.bindingChanged');
  });

  it('retains verified progress on cancellation and never accepts progress from a stale attempt', async () => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async (task, control) => { await control.recordProgress(report(task)); await gate.promise; return report(task); } });
    const task = await f.service.submit(input());
    await vi.waitFor(async () => expect((await f.service.get(task.id)).artifacts).toHaveLength(1));
    const control = f.execute.mock.calls[0]![1];
    await f.service.cancel(task.id);
    expect((await f.service.get(task.id)).artifacts[0]?.path).toBe(task.reportPath);
    await expect(control.recordProgress({ summary: 'late untrusted replacement' })).rejects.toThrow();
    expect((await f.service.get(task.id)).summary).not.toContain('late');
  });

  it('recovers running attempts as interrupted and starts only never-dispatched queue entries after restart', async () => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async task => { await gate.promise; return report(task); } });
    const first = await f.service.submit(input('first')); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const second = await f.service.submit(input('second')); await f.service.shutdown();
    // Recreate the last durable pre-crash state, including its dispatched attempt.
    await f.repo.transaction(state => { const task = state.researchTasks[0]!; task.status = 'running'; task.attempts[0]!.status = 'running'; task.attempts[0]!.finishedAt = null; });
    const repo = new DomainRepository(f.path, f.vault); await repo.initialize();
    const execute = vi.fn<ResearchTaskHost['execute']>(async task => report(task));
    const restarted = new ResearchTaskService(repo, { ...f.host, execute }); services.push(restarted); await restarted.initialize();
    await vi.waitFor(async () => expect((await restarted.get(second.id)).status).toBe('completed'));
    expect(await restarted.get(first.id)).toMatchObject({ status: 'interrupted', errorCode: 'research.interruptedUnknown' });
    expect(execute.mock.calls.map(([task]) => task.input.goal)).toEqual(['second']);
    gate.resolve(); expect((await restarted.get(first.id)).status).toBe('interrupted');
  });

  it('honors the deadline even when the host ignores abort, preserving already recorded partial work', async () => {
    const gate = deferred(); releases.push(() => gate.resolve());
    const f = await fixture({ execute: async (task, control) => { await control.recordProgress(report(task)); await gate.promise; return report(task); } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const task = await f.service.submit({ ...input(), maxMinutes: 2 });
    await vi.waitFor(async () => expect((await f.service.get(task.id)).artifacts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(120_001); vi.useRealTimers();
    expect(await f.settled(task.id)).toMatchObject({ status: 'partial', errorCode: 'research.deadlineExceeded' });
    expect(f.execute.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('stops waiting for slow session creation on shutdown without dispatching a provider request', async () => {
    const gate = deferred<string>(); releases.push(() => gate.resolve(randomUUID()));
    const f = await fixture({ createSession: async () => gate.promise });
    const task = await f.service.submit(input()); await vi.waitFor(() => expect(f.createSession).toHaveBeenCalledOnce());
    await f.service.shutdown();
    expect(await f.service.get(task.id)).toMatchObject({ status: 'interrupted', sessionId: null });
    gate.resolve(randomUUID()); expect(f.execute).not.toHaveBeenCalled();
  });

  it('reconciles an accepted atomic write whose acknowledgement was lost and keeps one task and attempt', async () => {
    const f = await fixture(), save = EncryptedJsonStore.prototype.save;
    vi.spyOn(EncryptedJsonStore.prototype, 'save').mockImplementationOnce(async function(this: EncryptedJsonStore<unknown>, value: unknown) {
      await save.call(this, value); throw new EncryptedStoreWriteError(new Error('synthetic post-rename failure'));
    });
    const request = input(), task = await f.service.submit(request);
    await f.service.submit(request); await f.settled(task.id);
    expect(f.repo.snapshot().researchTasks).toHaveLength(1); expect(f.execute).toHaveBeenCalledOnce();
  });

  it('migrates an older profile with no research state to an empty research queue', async () => {
    const f = await fixture(); const older: Record<string, unknown> = f.repo.snapshot(); delete older.researchTasks;
    expect(persistentStateSchema.parse(older).researchTasks).toEqual([]);
  });
});
