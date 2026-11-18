// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatCronBinding, ChatCronInput, ChatCronRun, ChatCronState, ChatCronStore } from '../../shared/chat-cron';
import { ChatCronService } from './chat-cron-service';

const binding = (): ChatCronBinding => ({ sessionId: randomUUID(), providerId: randomUUID(), model: 'synthetic-model' });
const input = (patch: Partial<ChatCronInput> = {}): ChatCronInput => ({ title: 'Synthetic scheduled search', instruction: 'Search selected public material',
  expression: '0 9 * * *', timezone: 'UTC', allowedCapabilities: ['web.search'], missedPolicy: 'skip', ...patch });
const authorize = () => undefined;
const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
class MemoryStore implements ChatCronStore {
  state: ChatCronState;
  disk: string;
  failNext = false;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(state: ChatCronState) { this.state = structuredClone(state); this.disk = JSON.stringify(this.state); }
  snapshot(): ChatCronState { return structuredClone(this.state); }
  transaction<T>(mutation: (draft: ChatCronState) => T | Promise<T>): Promise<T> {
    const work = this.#queue.then(async () => {
      if (this.failNext) { this.failNext = false; throw new Error('synthetic.diskFailure'); }
      const draft = this.snapshot(), result = await mutation(draft);
      this.disk = JSON.stringify(draft); this.state = JSON.parse(this.disk) as ChatCronState; return structuredClone(result);
    });
    this.#queue = work.catch(() => undefined); return work;
  }
  reopen(): MemoryStore { return new MemoryStore(JSON.parse(this.disk) as ChatCronState); }
}
const fixture = (overrides: Partial<ConstructorParameters<typeof ChatCronService>[1]> = {}) => {
  let now = Date.parse('2026-11-02T08:00:00Z');
  const owner = binding(), other = binding();
  const store = new MemoryStore({ chatCronSchedules: [], chatCronRuns: [], chatSessions: [{ id: owner.sessionId }, { id: other.sessionId }] });
  const execute = vi.fn<ConstructorParameters<typeof ChatCronService>[1]['execute']>(async () => undefined), changed = vi.fn();
  const service = new ChatCronService(store, { now: () => now, execute, changed, ...overrides });
  return { owner, other, store, service, execute, changed, setNow: (value: string) => { now = Date.parse(value); },
    settled: async () => { await vi.waitFor(() => expect(service.active).toBe(false)); } };
};

describe('durable scheduled chat tasks', () => {
  it('re-intersects a restored QQ v1 schedule and requires fresh owner approval', async () => {
    const f = fixture();
    const schedule = await f.service.create(f.owner, input({ allowedCapabilities: ['workspace.write', 'web.search'] }), authorize);
    await f.store.transaction(state => {
      state.chatCronSchedules[0]!.channel = { kind: 'qq', bindingId: 'synthetic-binding', senderId: 'synthetic-owner', policyVersion: 1 };
    });
    const reopened = f.store.reopen();
    const service = new ChatCronService(reopened, { now: () => Date.parse(schedule.nextRunAt!), execute: f.execute });
    expect(await service.tick({ startup: true })).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(service.list(f.owner.sessionId)[0]).toMatchObject({ enabled: false, nextRunAt: null, allowedCapabilities: ['web.search'],
      channel: { kind: 'qq', policyVersion: 2 } });
    await expect(service.resume(f.owner.sessionId, schedule.id, authorize)).rejects.toThrow('qq.confirmationRequired');
  });
  it('captures host binding, validates scope and creates an idempotent schedule', async () => {
    const f = fixture(), body = input(), auth = vi.fn();
    const schedule = await f.service.create(f.owner, body, auth, 'run:call');
    expect(schedule).toMatchObject({ ...f.owner, ...body, revision: 1, enabled: true, nextRunAt: '2026-11-02T09:00:00.000Z' });
    expect(auth).toHaveBeenCalledTimes(2);
    expect((await f.service.create(f.owner, body, authorize, 'run:call')).id).toBe(schedule.id);
    await expect(f.service.create(f.owner, input({ instruction: 'Changed request' }), authorize, 'run:call')).rejects.toThrow('cron.operationConflict');
    await expect(f.service.create(f.owner, input({ allowedCapabilities: ['workspace.read'] as never }), authorize)).rejects.toThrow();
    await expect(f.service.create(f.owner, input({ expression: '0 0 31 2 *' }), authorize)).rejects.toThrow('cron.noOccurrence');
    expect(f.service.list(f.owner.sessionId)).toHaveLength(1); expect(f.changed).toHaveBeenCalled();
  });
  it('rechecks host authorization at the durable write boundary', async () => {
    const f = fixture(), wait = gate(); let authorized = true;
    const blocker = f.store.transaction(async () => { await wait.promise; });
    const created = f.service.create(f.owner, input(), () => { if (!authorized) throw new Error('revoked'); });
    expect(f.service.active).toBe(true); authorized = false; wait.release(); await blocker;
    await expect(created).rejects.toThrow('revoked'); expect(f.service.list(f.owner.sessionId)).toEqual([]); expect(f.service.active).toBe(false);
  });
  it('keeps listing and management scoped to the original session', async () => {
    const f = fixture(), schedule = await f.service.create(f.owner, input(), authorize);
    expect(f.service.list(f.other.sessionId)).toEqual([]); expect(f.service.history(f.other.sessionId)).toEqual([]);
    await expect(f.service.pause(f.other.sessionId, schedule.id, authorize)).rejects.toThrow('cron.notFound');
    expect(() => f.service.history(f.other.sessionId, schedule.id)).toThrow('cron.notFound');
    expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(true);
  });
  it('persists a reservation and running status before executing, deduplicates ticks and records success', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (schedule, runId, signal, assertCurrent) => {
      const disk = JSON.parse(f.store.disk) as ChatCronState;
      expect(disk.chatCronRuns.find((run) => run.id === runId)?.status).toBe('running');
      expect(disk.chatCronSchedules[0]?.nextRunAt).toBe('2026-11-03T09:00:00.000Z');
      expect(schedule.sessionId).toBe(f.owner.sessionId); expect(signal.aborted).toBe(false); assertCurrent();
    });
    await f.service.create(f.owner, input(), authorize); f.setNow('2026-11-02T09:00:00Z');
    expect(await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()])).toEqual([1, 0, 0]); await f.settled();
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.service.history(f.owner.sessionId)[0]).toMatchObject({ status: 'succeeded', errorCode: null });
    await f.service.tick(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('accepts polling delay below one minute after startup and skips an older due slot', async () => {
    const f = fixture(); await f.service.tick(); await f.service.create(f.owner, input(), authorize); f.setNow('2026-11-02T09:00:59Z');
    expect(await f.service.tick()).toBe(1); await f.settled();
    const late = fixture(); await late.service.tick(); await late.service.create(late.owner, input(), authorize); late.setNow('2026-11-02T09:01:00Z');
    expect(await late.service.tick()).toBe(0); expect(late.service.history(late.owner.sessionId)[0]?.status).toBe('missed'); expect(late.execute).not.toHaveBeenCalled();
  });
  it('does not dispatch or consume the due slot when its reservation cannot be committed', async () => {
    const f = fixture(); await f.service.tick(); const schedule = await f.service.create(f.owner, input(), authorize);
    f.setNow(schedule.nextRunAt!); f.store.failNext = true;
    await expect(f.service.tick()).rejects.toThrow('synthetic.diskFailure');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.service.history(f.owner.sessionId)).toEqual([]);
    expect(f.service.list(f.owner.sessionId)[0]?.nextRunAt).toBe(schedule.nextRunAt);
    expect(await f.service.tick()).toBe(1); await f.settled(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('coalesces missed slots into one run-once execution and honors startup skip', async () => {
    const f = fixture(); await f.service.create(f.owner, input({ expression: '* * * * *', missedPolicy: 'run-once' }), authorize); f.setNow('2026-11-10T09:00:00Z');
    expect(await f.service.tick({ startup: true })).toBe(1); await f.settled(); await f.service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.service.list(f.owner.sessionId)[0]?.nextRunAt).toBe('2026-11-10T09:01:00.000Z');
    const skip = fixture(); await skip.service.create(skip.owner, input(), authorize); skip.setNow('2026-11-02T09:00:01Z');
    expect(await skip.service.tick({ startup: true })).toBe(0); expect(skip.service.history(skip.owner.sessionId)[0]?.errorCode).toBe('cron.missedSkipped');
  });
  it.each(['reserved', 'running'] as const)('marks persisted %s work interrupted after restart without replaying it', async (status) => {
    const f = fixture(), schedule = await f.service.create(f.owner, input(), authorize), dueAt = schedule.nextRunAt!;
    await f.store.transaction((state) => { state.chatCronRuns.push({ id: randomUUID(), key: `cron:${schedule.id}:${dueAt}`, scheduleId: schedule.id,
      sessionId: schedule.sessionId, scheduleRevision: 1, dueAt, status, createdAt: dueAt, startedAt: status === 'running' ? dueAt : null, finishedAt: null, errorCode: null });
      state.chatCronSchedules[0]!.nextRunAt = '2026-11-03T09:00:00.000Z'; });
    const reopened = f.store.reopen(), execute = vi.fn(), service = new ChatCronService(reopened, { now: () => Date.parse('2026-11-02T09:01:00Z'), execute });
    await service.tick({ startup: true }); await service.tick();
    expect(execute).not.toHaveBeenCalled(); expect(service.history(f.owner.sessionId)[0]).toMatchObject({ status: 'interrupted', errorCode: 'cron.interruptedNoReplay' });
  });
  it('does not execute duplicate persisted slot identities even when nextRunAt points to the consumed slot', async () => {
    const f = fixture(), schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!); await f.service.tick(); await f.settled();
    await f.store.transaction((state) => { state.chatCronSchedules[0]!.nextRunAt = schedule.nextRunAt; }); await f.service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.service.history(f.owner.sessionId)).toHaveLength(1);
  });
  it.each(['pause', 'cancel', 'update'] as const)('invalidates an active run on %s and preserves its cancelled terminal status', async (action) => {
    const f = fixture(), wait = gate(); f.execute.mockImplementation(async () => { await wait.promise; });
    const schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!); await f.service.tick();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1)); const [, , signal, current] = f.execute.mock.calls[0]!;
    if (action === 'update') await f.service.update(f.owner.sessionId, schedule.id, { instruction: 'New scope', allowedCapabilities: [] }, authorize);
    else await f.service[action](f.owner.sessionId, schedule.id, authorize);
    expect(signal.aborted).toBe(true); expect(current).toThrow(); wait.release(); await f.settled();
    expect(f.service.history(f.owner.sessionId)[0]).toMatchObject({ status: 'cancelled', errorCode: 'cron.scheduleChanged' });
    expect(f.service.list(f.owner.sessionId)[0]?.revision).toBe(2);
  });
  it('resumes paused schedules from now but refuses to resume or update cancelled schedules', async () => {
    const f = fixture(), schedule = await f.service.create(f.owner, input(), authorize); await f.service.pause(f.owner.sessionId, schedule.id, authorize);
    f.setNow('2026-11-04T12:00:00Z'); expect((await f.service.resume(f.owner.sessionId, schedule.id, authorize)).nextRunAt).toBe('2026-11-05T09:00:00.000Z');
    const cancelled = await f.service.cancel(f.owner.sessionId, schedule.id, authorize);
    expect((await f.service.cancel(f.owner.sessionId, schedule.id, authorize)).revision).toBe(cancelled.revision);
    await expect(f.service.resume(f.owner.sessionId, schedule.id, authorize)).rejects.toThrow('cron.cancelled');
    await expect(f.service.update(f.owner.sessionId, schedule.id, { title: 'changed', allowedCapabilities: [] }, authorize)).rejects.toThrow('cron.cancelled');
  });
  it('aborts affected work on capability revocation and requires explicit resume', async () => {
    const f = fixture(), wait = gate(); f.execute.mockImplementation(async () => { await wait.promise; });
    const schedule = await f.service.create(f.owner, input(), authorize), other = await f.service.create(f.other, input({ allowedCapabilities: ['time.read'] }), authorize);
    f.setNow(schedule.nextRunAt!); await f.service.tick(); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    await f.service.revokeCapability('web.search');
    expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(false); expect(f.service.list(f.other.sessionId)[0]?.enabled).toBe(true);
    expect(f.execute.mock.calls.find(([value]) => value.id === schedule.id)?.[2].aborted).toBe(true);
    expect(f.execute.mock.calls.find(([value]) => value.id === other.id)?.[2].aborted).toBe(false);
    wait.release(); await f.settled(); expect(f.service.history(f.owner.sessionId)[0]?.errorCode).toBe('cron.permissionRevoked');
    await f.service.resume(f.owner.sessionId, schedule.id, authorize); expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(true);
  });
  it('keeps revocation blocked in memory even when its durable write fails', async () => {
    const f = fixture(), wait = gate(); f.execute.mockImplementation(async () => { await wait.promise; });
    const schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!); await f.service.tick(); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    f.store.failNext = true; const revoked = f.service.revokeCapability('chat.cron');
    expect(f.execute.mock.calls[0]?.[2].aborted).toBe(true); await expect(revoked).rejects.toThrow('synthetic.diskFailure');
    wait.release(); await f.settled(); f.setNow('2026-11-03T09:00:00Z'); expect(await f.service.tick()).toBe(0); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('suppresses archived sessions and invalidates the active guard after an archive', async () => {
    const f = fixture(), wait = gate(); f.execute.mockImplementation(async () => { await wait.promise; });
    const schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!); await f.service.tick(); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    await f.store.transaction((state) => { state.chatSessions[0]!.archivedAt = '2026-11-02T09:00:01Z'; });
    expect(f.execute.mock.calls[0]![3]).toThrow('cron.sessionUnavailable'); wait.release(); await f.settled();
    f.setNow('2026-11-03T09:00:00Z'); await f.service.tick(); expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(false);
    await expect(f.service.create(f.owner, input(), authorize)).rejects.toThrow('cron.sessionUnavailable');
  });
  it('allows another session past a due slot blocked by an active session', async () => {
    const f = fixture({ maxRunsPerTick: 1 }), wait = gate(); f.execute.mockImplementation(async () => { await wait.promise; });
    await f.service.create(f.owner, input({ expression: '0 9 * * *', missedPolicy: 'run-once' }), authorize);
    await f.service.create(f.owner, input({ expression: '1 9 * * *', missedPolicy: 'run-once' }), authorize);
    await f.service.create(f.other, input({ expression: '2 9 * * *', missedPolicy: 'run-once' }), authorize);
    f.setNow('2026-11-02T09:02:00Z'); expect(await f.service.tick()).toBe(1); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    expect(await f.service.tick()).toBe(1); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    expect(f.execute.mock.calls.map(([schedule]) => schedule.sessionId)).toEqual([f.owner.sessionId, f.other.sessionId]);
    expect(await f.service.tick()).toBe(0); wait.release(); await f.settled();
  });
  it('does no work while suspended and cancels cooperatively on shutdown', async () => {
    const f = fixture(); f.execute.mockImplementation(async (_schedule, _runId, signal) => { await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); }); });
    const schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!);
    expect(await f.service.tick({ suspended: true })).toBe(0); expect(f.service.history(f.owner.sessionId)).toEqual([]);
    await f.service.tick(); await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1)); await f.service.shutdown();
    expect(f.service.active).toBe(false); expect(f.service.history(f.owner.sessionId)[0]?.status).toBe('cancelled');
    expect(await f.service.tick()).toBe(0); await expect(f.service.create(f.owner, input(), authorize)).rejects.toThrow('cron.closed');
  });
  it('cancels only the selected active occurrence while preserving future scheduled execution', async () => {
    const f = fixture(); f.execute.mockImplementation(async (_schedule, _runId, signal) => { await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); }); });
    const schedule = await f.service.create(f.owner, input(), authorize); f.setNow(schedule.nextRunAt!); await f.service.tick();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    const [, runId, signal] = f.execute.mock.calls[0]!;
    expect(f.service.cancelRun(randomUUID())).toBe(false); expect(signal.aborted).toBe(false);
    expect(f.service.cancelRun(runId)).toBe(true); expect(signal.aborted).toBe(true); await f.settled();
    expect(f.service.history(f.owner.sessionId)[0]).toMatchObject({ id: runId, status: 'cancelled', errorCode: 'cron.interrupted' });
    expect(f.service.list(f.owner.sessionId)[0]).toMatchObject({ enabled: true, revision: 1, cancelledAt: null, nextRunAt: '2026-11-03T09:00:00.000Z' });
    expect(f.service.cancelRun(runId)).toBe(false);
    f.execute.mockResolvedValue(undefined); f.setNow('2026-11-03T09:00:00Z'); expect(await f.service.tick()).toBe(1); await f.settled();
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.service.history(f.owner.sessionId)[0]?.status).toBe('succeeded');
  });
  it('records execution failure without saving provider exception contents', async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error('sensitive provider body')); const schedule = await f.service.create(f.owner, input(), authorize);
    f.setNow(schedule.nextRunAt!); await f.service.tick(); await f.settled();
    expect(f.service.history(f.owner.sessionId)[0]).toMatchObject({ status: 'failed', errorCode: 'cron.executionFailed' }); expect(f.store.disk).not.toContain('sensitive provider body');
  });
  it('retains history identities and refuses work at the storage bounds', async () => {
    const f = fixture(), schedule = await f.service.create(f.owner, input(), authorize), dueAt = schedule.nextRunAt!;
    const run: ChatCronRun = { id: randomUUID(), key: 'retained', scheduleId: schedule.id, sessionId: schedule.sessionId, scheduleRevision: 1, dueAt,
      status: 'missed', createdAt: dueAt, startedAt: null, finishedAt: dueAt, errorCode: 'cron.missedSkipped' };
    await f.store.transaction((state) => { state.chatCronRuns = Array.from({ length: 10000 }, (_, index) => ({ ...run, id: randomUUID(), key: `retained:${index}` }));
      state.chatCronSchedules = Array.from({ length: 200 }, (_, index) => ({ ...schedule, id: index === 0 ? schedule.id : randomUUID(), enabled: index === 0 })); });
    await expect(f.service.create(f.owner, input(), authorize)).rejects.toThrow('cron.scheduleLimit');
    f.setNow(dueAt); await expect(f.service.tick()).rejects.toThrow('cron.historyLimit');
    expect(f.service.history(f.owner.sessionId)).toHaveLength(10000); expect(f.service.list(f.owner.sessionId)[0]?.nextRunAt).toBe(dueAt); expect(f.execute).not.toHaveBeenCalled();
  });
});
