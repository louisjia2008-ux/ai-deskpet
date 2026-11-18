// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../../shared/background-jobs';
import type { AutomaticTaskPort, AutomaticTrigger, AutomationState, AutomationStore, PersistentScheduleInput } from '../../shared/automation';
import { PersistentScheduleService } from './persistent-schedule-service';

const initial = (): AutomationState => ({ automationSchedules: [], automationTriggers: [], proactiveEvents: [],
  proactivePolicy: { enabled: false, revision: 1, eventKinds: [], quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC',
    cooldownMinutes: 60, dailyLimit: 1, topics: [], privacy: 'local-only', providerId: null, model: '' } });
class MemoryStore implements AutomationStore {
  state: AutomationState;
  disk: string;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(state = initial()) { this.state = structuredClone(state); this.disk = JSON.stringify(this.state); }
  snapshot(): AutomationState { return structuredClone(this.state); }
  transaction<T>(mutate: (draft: AutomationState) => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => { const draft = this.snapshot(); const value = await mutate(draft); this.disk = JSON.stringify(draft); this.state = JSON.parse(this.disk) as AutomationState; return structuredClone(value); });
    this.#queue = next.catch(() => undefined); return next;
  }
  reopen(): MemoryStore { return new MemoryStore(JSON.parse(this.disk) as AutomationState); }
}
const schedule = (patch: Partial<PersistentScheduleInput> = {}): PersistentScheduleInput => ({ id: randomUUID(), title: 'Synthetic schedule', instruction: 'Synthetic summary instruction',
  material: 'Only selected synthetic material', privacy: 'local-only', providerId: '0e5e71f9-5987-486d-bb03-f75c4c693783', model: 'synthetic-clock',
  rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', missedPolicy: 'skip', enabled: true, ...patch });
const fixture = () => {
  let now = Date.parse('2026-10-29T08:00:00Z');
  const store = new MemoryStore(), jobs = new Map<string, BackgroundJob>();
  const events: Array<{ trigger: AutomaticTrigger; reservedOnDisk: boolean; input: unknown }> = [];
  const tasks: AutomaticTaskPort = {
    submit: vi.fn(async (trigger, input) => {
      events.push({ trigger: structuredClone(trigger), reservedOnDisk: (JSON.parse(store.disk) as AutomationState).automationTriggers.some((item) => item.id === trigger.id), input });
      const existing = jobs.get(trigger.id); if (existing) return existing;
      const job = { id: randomUUID(), operationId: trigger.id, status: 'queued', request: null,
        instruction: input.instruction, material: input.material, source: { privacy: input.privacy },
        binding: { provider: { id: input.providerId }, model: input.model } } as BackgroundJob; jobs.set(trigger.id, job); return job;
    }),
    cancel: vi.fn(async (id) => { const job = [...jobs.values()].find((value) => value.id === id); if (job) job.status = 'cancelled'; }),
    getByOperation: (id) => jobs.get(id) ?? null,
  };
  const service = new PersistentScheduleService(store, tasks, { now: () => now });
  return { store, tasks, service, jobs, events, setNow: (time: string) => { now = Date.parse(time); }, reopen: () => new PersistentScheduleService(store.reopen(), tasks, { now: () => now }) };
};

describe('persistent schedule reservations through the shared E-P2 port', () => {
  it('commits one durable trigger before submit, deduplicates concurrent ticks and advances the calendar', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); f.setNow('2026-10-29T09:00:00Z');
    await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
    expect(f.tasks.submit).toHaveBeenCalledTimes(1); expect(f.events[0]?.reservedOnDisk).toBe(true);
    expect(f.events[0]?.trigger.id).toBe(f.store.snapshot().automationTriggers[0]?.id);
    expect(f.events[0]?.input).toEqual({ instruction: input.instruction, material: input.material, providerId: input.providerId, model: input.model, privacy: 'local-only' });
    expect(f.service.list()[0]?.nextRunAt).toBe('2026-10-30T09:00:00.000Z');
    await f.reopen().tick({ startup: true }); expect(f.tasks.submit).toHaveBeenCalledTimes(1);
  });
  it('accepts normal polling delay within 60 seconds, but records older skipped occurrences', async () => {
    const f = fixture(); await f.service.upsert(schedule()); f.setNow('2026-10-29T09:00:59Z');
    expect(await f.service.tick()).toBe(1);
    const late = fixture(); await late.service.upsert(schedule()); late.setNow('2026-10-29T09:01:01Z');
    expect(await late.service.tick()).toBe(0); expect(late.service.history()[0]?.status).toBe('missed'); expect(late.tasks.submit).not.toHaveBeenCalled();
  });
  it('persists skip on cold startup and coalesces many missed days into one run-once request', async () => {
    const skip = fixture(); await skip.service.upsert(schedule()); skip.setNow('2026-11-10T12:00:00Z');
    await skip.service.tick({ startup: true }); expect(skip.service.history()).toHaveLength(1); expect(skip.service.history()[0]?.status).toBe('missed');
    expect(skip.service.list()[0]?.nextRunAt).toBe('2026-11-11T09:00:00.000Z');
    const catchup = fixture(); await catchup.service.upsert(schedule({ missedPolicy: 'run-once' })); catchup.setNow('2026-11-10T12:00:00Z');
    expect(await catchup.service.tick({ startup: true })).toBe(1); expect(catchup.tasks.submit).toHaveBeenCalledTimes(1);
    await catchup.service.tick({ startup: true }); expect(catchup.tasks.submit).toHaveBeenCalledTimes(1); expect(catchup.service.list()[0]?.nextRunAt).toBe('2026-11-11T09:00:00.000Z');
  });
  it('does no work while suspended and consumes a one-time occurrence only once after resume', async () => {
    const f = fixture(); await f.service.upsert(schedule({ rule: { kind: 'once', at: '2026-10-29T09:00:00Z' }, missedPolicy: 'run-once' })); f.setNow('2026-10-29T12:00:00Z');
    expect(await f.service.tick({ suspended: true })).toBe(0); expect(f.service.history()).toEqual([]);
    await f.service.tick({ startup: true }); await f.service.tick(); expect(f.tasks.submit).toHaveBeenCalledTimes(1); expect(f.service.list()[0]?.nextRunAt).toBeNull();
    expect(f.service.list()[0]?.enabled).toBe(true); // dispatch guard remains valid for the accepted one-shot.
  });
  it('refuses a newly enabled past one-time rule instead of saving a silently inert schedule', async () => {
    const f = fixture();
    await expect(f.service.upsert(schedule({ rule: { kind: 'once', at: '2026-10-29T07:00:00Z' } }))).rejects.toThrow('schedule.pastOnce');
    expect(f.service.list()).toEqual([]); expect(f.tasks.submit).not.toHaveBeenCalled();
  });
  it('does not redispatch an existing interrupted or possibly dispatched job on restart', async () => {
    const f = fixture(); await f.service.upsert(schedule()); f.setNow('2026-10-29T09:00:00Z'); await f.service.tick();
    const trigger = f.service.history()[0]!, job = f.jobs.get(trigger.id)!; job.status = 'running';
    const stopped = f.store.reopen(), restarted = new PersistentScheduleService(stopped, f.tasks, { now: () => Date.parse('2026-10-29T09:00:10Z') });
    await restarted.tick({ startup: true }); expect(stopped.snapshot().automationTriggers[0]?.status).toBe('unknown'); expect(f.tasks.submit).toHaveBeenCalledTimes(1);
    job.status = 'interrupted'; await restarted.tick(); expect(stopped.snapshot().automationTriggers[0]?.status).toBe('unknown'); expect(f.tasks.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps a reservation with missing job unknown rather than creating another operation after restart', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); const due = f.service.list()[0]!.nextRunAt!;
    const id = randomUUID(); await f.store.transaction((state) => { state.automationTriggers.push({ id, key: `schedule:${input.id}:${due}`, kind: 'schedule', sourceId: input.id,
      dueAt: due, policyRevision: 1, status: 'reserved', jobId: null, messageId: null, createdAt: due, updatedAt: due, cancelledAt: null, errorCode: null }); state.automationSchedules[0]!.nextRunAt = '2026-10-30T09:00:00Z'; });
    f.setNow('2026-10-29T10:00:00Z'); await f.service.tick({ startup: true }); await f.service.tick();
    expect(f.service.history()[0]?.status).toBe('unknown'); expect(f.service.history()[0]?.errorCode).toBe('schedule.reservationUncertain'); expect(f.tasks.submit).not.toHaveBeenCalled();
  });
  it('makes manual retry identity idempotent and rejects sharing that operation across schedules', async () => {
    const f = fixture(), a = schedule(), b = schedule(); await f.service.upsert(a); await f.service.upsert(b);
    const operationId = randomUUID(); const first = await f.service.runNow({ id: a.id, operationId }); const again = await f.service.runNow({ id: a.id, operationId });
    expect(first.id).toBe(operationId); expect(again.id).toBe(first.id); expect(f.tasks.submit).toHaveBeenCalledTimes(1);
    await expect(f.service.runNow({ id: b.id, operationId })).rejects.toThrow('schedule.operationConflict');
  });
  it('refuses an existing unrelated operation without attaching or cancelling its job', async () => {
    const f = fixture(), input = schedule(), operationId = randomUUID(); await f.service.upsert(input);
    f.jobs.set(operationId, { id: randomUUID(), operationId, instruction: 'Unrelated explicit job', material: 'Other material', status: 'running' } as BackgroundJob);
    await expect(f.service.runNow({ id: input.id, operationId })).rejects.toThrow('schedule.operationConflict');
    expect(f.service.history()).toEqual([]); expect(f.tasks.submit).not.toHaveBeenCalled();
    await f.service.cancel(input.id); expect(f.tasks.cancel).not.toHaveBeenCalled();
  });
  it('blocks a conflicting task acknowledgement and never claims another task result', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input);
    vi.mocked(f.tasks.submit).mockImplementation(async (trigger) => {
      const foreign = { id: randomUUID(), operationId: trigger.id, instruction: 'Foreign body', material: 'Foreign material', status: 'succeeded' } as BackgroundJob;
      f.jobs.set(trigger.id, foreign); return foreign;
    });
    const result = await f.service.runNow({ id: input.id, operationId: randomUUID() });
    expect(result.status).toBe('blocked'); expect(result.jobId).toBeNull(); expect(result.errorCode).toBe('schedule.operationConflict');
    await f.service.cancel(input.id); expect(f.tasks.cancel).not.toHaveBeenCalled();
  });
  it('commits pause/cancel intent before cancellation and never changes a cancelled trigger to late success', async () => {
    const f = fixture(), a = schedule(), b = schedule(); await f.service.upsert(a); await f.service.upsert(b);
    const ta = await f.service.runNow({ id: a.id, operationId: randomUUID() }); const tb = await f.service.runNow({ id: b.id, operationId: randomUUID() });
    vi.mocked(f.tasks.cancel).mockImplementation(async (id) => { expect(f.store.snapshot().automationTriggers.find((trigger) => trigger.jobId === id)?.cancelledAt).not.toBeNull(); });
    await f.service.pause(a.id); expect(f.tasks.cancel).toHaveBeenCalledWith(ta.jobId); expect(f.tasks.cancel).not.toHaveBeenCalledWith(tb.jobId);
    f.jobs.get(ta.id)!.status = 'succeeded'; await f.service.tick(); expect(f.service.history(a.id)[0]?.status).toBe('cancelled');
    expect(f.service.history(b.id)[0]?.status).toBe('submitted'); await f.service.cancel(a.id);
    await expect(f.service.upsert(a)).rejects.toThrow('schedule.cancelled');
  });
  it('suppresses a target cancelled while submit is awaiting its durable job acknowledgement', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; }); const original = vi.mocked(f.tasks.submit).getMockImplementation()!;
    vi.mocked(f.tasks.submit).mockImplementation(async (trigger, body) => { await wait; const job = await original(trigger, body); job.status = 'succeeded'; return job; });
    const started = f.service.runNow({ id: input.id, operationId: randomUUID() }); await vi.waitFor(() => expect(f.service.history()).toHaveLength(1));
    await f.service.cancel(input.id); release(); const result = await started;
    expect(result.status).toBe('cancelled'); expect(result.cancelledAt).not.toBeNull(); expect(f.tasks.cancel).toHaveBeenCalledWith(result.jobId);
  });
  it('invalidates active jobs on edit but leaves a byte-equivalent upsert alone', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); const trigger = await f.service.runNow({ id: input.id, operationId: randomUUID() });
    const reordered = { ...input, rule: { time: '09:00', kind: 'daily' } as const }; await f.service.upsert(reordered);
    expect(f.service.list()[0]?.revision).toBe(1); expect(f.tasks.cancel).not.toHaveBeenCalled();
    await f.service.upsert({ ...input, instruction: 'New explicit synthetic instruction' }); expect(f.service.list()[0]?.revision).toBe(2); expect(f.tasks.cancel).toHaveBeenCalledWith(trigger.jobId);
    expect(f.service.history()[0]?.cancelledAt).not.toBeNull();
  });
  it('preserves durable unknown submission and cancellation intents even when the task port rejects', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); vi.mocked(f.tasks.submit).mockRejectedValue(new Error('synthetic unknown submit acknowledgement'));
    const result = await f.service.runNow({ id: input.id, operationId: randomUUID() }); expect(result.status).toBe('unknown'); await f.service.tick({ startup: true }); expect(f.tasks.submit).toHaveBeenCalledTimes(1);
    const g = fixture(), next = schedule(); await g.service.upsert(next); await g.service.runNow({ id: next.id, operationId: randomUUID() }); vi.mocked(g.tasks.cancel).mockRejectedValue(new Error('synthetic cancel ack unavailable'));
    await expect(g.service.cancel(next.id)).rejects.toThrow('schedule.cancelIncomplete'); expect(g.service.list()[0]?.cancelledAt).not.toBeNull(); expect(g.service.history()[0]?.status).toBe('cancelled');
  });
  it('retains all 2,000 protection identities and refuses a new trigger at the bound', async () => {
    const f = fixture(), input = schedule(); await f.service.upsert(input); const due = f.service.list()[0]!.nextRunAt!;
    await f.store.transaction((state) => { for (let i = 0; i < 2000; i += 1) state.automationTriggers.push({ id: randomUUID(), key: `retained:${i}`, kind: 'schedule', sourceId: input.id, dueAt: due, policyRevision: 1, status: 'missed', jobId: null, messageId: null, createdAt: due, updatedAt: due, cancelledAt: null, errorCode: null }); });
    f.setNow('2026-10-29T09:00:00Z'); await expect(f.service.tick()).rejects.toThrow('schedule.historyCapacity'); expect(f.service.history()).toHaveLength(2000); expect(f.tasks.submit).not.toHaveBeenCalled(); expect(f.service.list()[0]?.nextRunAt).toBe(due);
  });
});
