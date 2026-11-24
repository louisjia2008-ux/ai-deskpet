import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../../shared/background-jobs';
import { birthdayPrompt, defaultCharacterProfile, localDay } from '../../shared/character';
import type { AutomaticTaskPort, AutomaticTrigger, AutomationState, AutomationStore, ProactiveEnvironment, ProactivePolicyInput } from '../../shared/automation';
import { EventProactiveService } from './event-proactive-service';
import { defaultEventProactivePolicy } from './proactive-policy';
import { DomainRepository } from './repository';
import { hasAutomationProtection } from './automation-protection';

const instant = Date.parse('2026-10-29T12:00:00.000Z');
const enabled = (): ProactivePolicyInput => ({ enabled: true, eventKinds: ['task-completed'], quietStart: '23:00', quietEnd: '08:00',
  timezone: 'UTC', cooldownMinutes: 1, dailyLimit: 2, topics: ['short encouragement'], privacy: 'local-only', providerId: 'provider', model: 'synthetic-model' });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
class Store implements AutomationStore {
  state: AutomationState = { automationSchedules: [], automationTriggers: [], proactivePolicy: defaultEventProactivePolicy(), proactiveEvents: [] };
  #queue = Promise.resolve();
  holdNextAfterCommit: ReturnType<typeof deferred> | null = null;
  snapshot(): AutomationState { return structuredClone(this.state); }
  transaction<T>(mutation: (state: AutomationState) => T | Promise<T>): Promise<T> {
    const operation = this.#queue.then(async () => {
      const draft = this.snapshot(), value = await mutation(draft); this.state = draft;
      const gate = this.holdNextAfterCommit; this.holdNextAfterCommit = null; if (gate) await gate.promise;
      return value;
    });
    this.#queue = operation.then(() => undefined, () => undefined); return operation;
  }
}
const setup = () => {
  const store = new Store(), jobs = new Map<string, BackgroundJob>(); let time = instant;
  const environment: ProactiveEnvironment = { suspended: false, locked: false, busy: false, visible: true, permission: true };
  const submit = vi.fn<AutomaticTaskPort['submit']>(async (trigger) => {
    const job = { id: randomUUID(), operationId: trigger.id, status: 'queued' } as BackgroundJob; jobs.set(trigger.id, job); return structuredClone(job);
  });
  const cancel = vi.fn<AutomaticTaskPort['cancel']>(async (id) => { for (const job of jobs.values()) if (job.id === id) job.status = 'cancelled'; });
  const tasks: AutomaticTaskPort = { submit, cancel, getByOperation: (id) => jobs.get(id) ? structuredClone(jobs.get(id)!) : null };
  const create = () => new EventProactiveService(store, tasks, { now: () => time, environment: () => ({ ...environment }) });
  return { store, jobs, environment, submit, cancel, tasks, create, setTime: (value: number) => { time = value; }, now: () => time };
};
const offered = (id: string, at = instant) => ({ id, kind: 'task-completed' as const, occurredAt: new Date(at).toISOString(), summary: 'SYNTHETIC selected app task completed' });
const waitFor = async (predicate: () => boolean): Promise<void> => { for (let i = 0; i < 100; i++) { if (predicate()) return; await Promise.resolve(); } throw new Error('unit barrier not reached'); };

describe('event-driven persistent proactive service', () => {
  it('uses live defaults for future submissions after an equivalent legacy pin is migrated', async () => {
    const s = setup();
    let defaultModel = 'synthetic-model';
    const service = new EventProactiveService(s.store, s.tasks, {
      now: s.now, environment: () => s.environment, defaultModel: () => defaultModel,
    });
    const initial = await service.configure(enabled());
    await expect(service.followModel({ providerId: 'provider', model: 'synthetic-model' })).resolves.toBe(true);
    expect(service.getPolicy()).toMatchObject({ model: null, revision: initial.revision });
    await expect(service.followModel({ providerId: 'provider', model: 'synthetic-model' })).resolves.toBe(false);
    defaultModel = 'synthetic-new-default';
    await service.offer(offered('new-default'));
    await service.tick();
    expect(s.submit.mock.calls[0]?.[1]).toMatchObject({ providerId: 'provider', model: defaultModel });
  });
  it('adds both birthdays to an existing greeting but does not create one or change the daily limit', async () => {
    const s = setup();
    const service = new EventProactiveService(s.store, s.tasks, { now: s.now, environment: () => s.environment,
      character: policy => birthdayPrompt({ today: localDay(new Date(s.now()), policy.timezone),
        profile: { ...defaultCharacterProfile(), age: 16, ageSince: '2025-10-29', ownerBirthday: '10-29' }, addressUser: '队长', characterLeadDays: 0 }) });
    await service.configure({ ...enabled(), dailyLimit: 1 });
    await service.tick();
    expect(s.submit).not.toHaveBeenCalled();
    await service.offer(offered('first'));
    await service.tick();
    expect(JSON.parse(s.submit.mock.calls[0]![1].material).character).toBe("Today is your birthday: you just turned 17. Today is 队长's birthday.");
    s.setTime(instant + 120_000);
    await service.offer(offered('second', s.now()));
    await service.tick();
    expect(s.submit).toHaveBeenCalledOnce();
    expect(s.store.snapshot().proactivePolicy.dailyLimit).toBe(1);
  });
  it.each(['task-completed', 'focus-completed', 'explicit-check-in'] as const)('defaults %s check-ins to Chinese even with English event, topics and character examples', async (kind) => {
    const s = setup();
    const service = new EventProactiveService(s.store, s.tasks, { now: s.now, environment: () => ({ ...s.environment }),
      character: () => 'Friendly companion. Example: Hi there, take a break.' });
    await service.configure({ ...enabled(), eventKinds: [kind], topics: ['short encouragement'] });
    const policy = s.store.snapshot().proactivePolicy;
    await service.offer({ id: 'english-material', kind, occurredAt: new Date(instant).toISOString(), summary: 'The user explicitly requested a brief check-in.' });
    await service.tick();
    expect(s.submit).toHaveBeenCalledOnce();
    const input = s.submit.mock.calls[0]![1];
    expect(input.instruction).toContain('默认用自然的简体中文');
    expect(input.instruction).toContain('只输出中文问候正文，不附加英文译文');
    expect(input.instruction).toContain('keeping the check-in in Simplified Chinese');
    expect(JSON.parse(input.material)).toMatchObject({ event: { kind, summary: 'The user explicitly requested a brief check-in.' },
      topics: ['short encouragement'], character: 'Friendly companion. Example: Hi there, take a break.' });
    expect(s.store.snapshot().proactivePolicy).toEqual(policy);
  });

  it('allows fixed private-phone greetings with a hidden or locked desktop only under the existing auto policy and permission', async () => {
    const s = setup(), service = s.create();
    expect(service.privatePhonePolicy()).toBeNull();
    await service.configure({ ...enabled(), mode:'auto', eventKinds:['explicit-check-in'] });
    s.environment.visible = false; s.environment.locked = true;
    const phone = service.privatePhonePolicy();
    expect(phone).toMatchObject({timezone:'UTC',dailyLimit:2});
    expect(phone).not.toHaveProperty('topics');
    s.environment.suspended = true; expect(service.privatePhonePolicy()).toBeNull();
    s.environment.suspended = false; s.environment.permission = false; expect(service.privatePhonePolicy()).toBeNull();
    s.environment.permission = true;
    await service.configure({ ...enabled(), enabled:false, mode:'observe', eventKinds:['explicit-check-in'] });
    expect(service.privatePhonePolicy()).toBeNull(); expect(s.submit).not.toHaveBeenCalled();
  });
  it('does not collect unselected events or create timers/provider loops', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval'); const s = setup(), service = s.create();
    await service.offer(offered('off')); await service.tick(); expect(s.store.snapshot().proactiveEvents).toEqual([]); expect(s.submit).not.toHaveBeenCalled();
    await service.configure(enabled()); await service.offer({ ...offered('different'), kind: 'focus-completed' });
    expect(s.store.snapshot().proactiveEvents).toEqual([]); expect(interval).not.toHaveBeenCalled(); interval.mockRestore();
  });
  it('reserves one durable identity before submit and deduplicates repeated events and concurrent ticks', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); await service.offer(offered('one'));
    await Promise.all([service.tick(), service.tick()]); expect(s.submit).toHaveBeenCalledTimes(1);
    const [trigger, input] = s.submit.mock.calls[0]!;
    expect(trigger.status).toBe('reserved'); expect(s.store.snapshot().automationTriggers).toHaveLength(1);
    expect(s.store.snapshot().automationTriggers[0]).toMatchObject({ id: trigger.id, key: 'proactive:one', status: 'submitted' });
    expect(JSON.parse(input.material)).toEqual({ event: { kind: 'task-completed', summary: offered('one').summary }, topics: enabled().topics });
    expect(input.instruction).toContain('No tools'); expect(service.admission(trigger, 'publish').allowed).toBe(true);
    await service.offer(offered('one')); await service.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('never replays missing or already possibly-dispatched operations after a fresh service starts', async () => {
    const s = setup(); let service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); await service.tick();
    const trigger = s.store.snapshot().automationTriggers[0]!; s.jobs.get(trigger.id)!.status = 'interrupted';
    service = s.create(); await service.tick(); await service.offer(offered('one')); await service.tick();
    expect(s.store.snapshot().automationTriggers[0]).toMatchObject({ id: trigger.id, status: 'unknown' }); expect(s.submit).toHaveBeenCalledTimes(1);
    s.store.state.automationTriggers[0]!.status = 'reserved'; s.jobs.clear(); service = s.create(); await service.tick();
    expect(s.store.snapshot().automationTriggers[0]!.status).toBe('unknown'); expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('blocks fetch and publication after quiet hours or permission changes, excluding only its own reservation', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); await service.tick();
    const trigger = s.store.snapshot().automationTriggers[0]!;
    s.environment.permission = false; expect(service.admission(trigger, 'dispatch').reason).toBe('permission');
    s.environment.permission = true; s.setTime(Date.parse('2026-10-29T23:00:00.000Z'));
    expect(service.admission(trigger, 'publish').reason).toBe('quiet');
  });
  it('rechecks a committed successful message for visibility without making it dispatchable or mutating its receipt', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); await service.tick();
    const stored = s.store.state.automationTriggers[0]!; stored.status = 'succeeded'; stored.messageId = 'committed-message';
    const before = s.store.snapshot();
    expect(service.admission(stored, 'dispatch').allowed).toBe(false);
    expect(service.admission(stored, 'publish').allowed).toBe(true);
    s.environment.permission = false; expect(service.admission(stored, 'publish').reason).toBe('permission');
    s.environment.permission = true; s.setTime(Date.parse('2026-10-29T23:00:00.000Z'));
    expect(service.admission(stored, 'publish').reason).toBe('quiet');
    expect(s.store.snapshot()).toEqual(before); expect(s.submit).toHaveBeenCalledTimes(1);
    stored.messageId = null; expect(service.admission(stored, 'publish').allowed).toBe(false);
  });
  it('enforces a permission change after durable reservation but before the submission barrier', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one'));
    const gate = deferred(); s.store.holdNextAfterCommit = gate; const tick = service.tick();
    await waitFor(() => s.store.snapshot().automationTriggers.length === 1); s.environment.permission = false; gate.resolve(); await tick;
    expect(s.submit).not.toHaveBeenCalled(); expect(s.store.snapshot().automationTriggers[0]).toMatchObject({ status: 'cancelled', errorCode: 'proactive.permission' });
  });
  it('persists policy revocation while submit is in flight, suppresses its late result and leaves other origins alone', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one'));
    const gate = deferred(); s.submit.mockImplementation(async (trigger) => {
      const job = { id: randomUUID(), operationId: trigger.id, status: 'queued' } as BackgroundJob; s.jobs.set(trigger.id, job); await gate.promise; return structuredClone(job);
    });
    const other: AutomaticTrigger = { id: 'schedule-op', key: 'schedule:one', kind: 'schedule', sourceId: 'schedule', dueAt: new Date(instant).toISOString(), policyRevision: 1,
      status: 'submitted', jobId: 'schedule-job', messageId: null, createdAt: new Date(instant).toISOString(), updatedAt: new Date(instant).toISOString(), cancelledAt: null, errorCode: null };
    s.store.state.automationTriggers.push(other); s.jobs.set(other.id, { id: 'schedule-job', operationId: other.id, status: 'running' } as BackgroundJob);
    const tick = service.tick(); await waitFor(() => s.submit.mock.calls.length === 1);
    const own = s.store.snapshot().automationTriggers.find((trigger) => trigger.kind === 'proactive')!;
    const configure = service.configure({ ...enabled(), enabled: false });
    expect(service.admission(own, 'dispatch').allowed).toBe(false); await configure;
    expect(s.store.snapshot().automationTriggers.find((trigger) => trigger.id === own.id)?.status).toBe('cancelled');
    gate.resolve(); await tick; expect(service.admission(own, 'publish').allowed).toBe(false);
    expect(s.cancel.mock.calls.every(([id]) => id !== 'schedule-job')).toBe(true); expect(s.jobs.get(other.id)!.status).toBe('running');
  });
  it('retains quota across cancellation and restart, and does not persist unchanged deferred reasons every tick', async () => {
    const s = setup(); let service = s.create(); await service.configure({ ...enabled(), dailyLimit: 1 }); await service.offer(offered('one')); await service.tick();
    await service.noteInteraction(); service = s.create(); s.setTime(instant + 120_000); await service.offer(offered('two', s.now())); await service.tick();
    expect(s.store.snapshot().proactiveEvents.find((event) => event.id === 'two')?.reason).toBe('daily-limit'); expect(s.submit).toHaveBeenCalledTimes(1);
    const transaction = vi.spyOn(s.store, 'transaction'); await service.tick(); expect(transaction).not.toHaveBeenCalled();
  });
  it('fails closed on a rejected submit and does not automatically regenerate its operation', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); s.submit.mockRejectedValueOnce(new Error('commit unknown'));
    await service.tick(); expect(s.store.snapshot().automationTriggers[0]?.status).toBe('unknown'); await service.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('shuts down only its own pending work and cannot accept new offers after shutdown', async () => {
    const s = setup(), service = s.create(); await service.configure(enabled()); await service.offer(offered('one')); await service.tick(); await service.shutdown();
    expect(s.store.snapshot().automationTriggers[0]?.status).toBe('cancelled'); await service.offer(offered('two')); await service.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
  });
});

describe('deterministic observation mode without model work', () => {
  const observing = (): ProactivePolicyInput => ({ ...enabled(), enabled: false, mode: 'observe', providerId: null, model: '' });
  it('records a local rule match without provider permission, jobs, triggers, notifications or timers', async () => {
    const s = setup(), changed = vi.fn(); s.environment.permission = false;
    const service = new EventProactiveService(s.store, s.tasks, { now: s.now, environment: () => ({ ...s.environment }), changed });
    await service.configure(observing()); changed.mockClear();
    const interval = vi.spyOn(globalThis, 'setInterval');
    await service.offer(offered('observed')); await Promise.all([service.tick(), service.tick()]);
    expect(service.getObservations()).toEqual([expect.objectContaining({ eventId: 'observed', decision: 'would-act', reason: 'rules-matched', policyRevision: 2 })]);
    expect(s.store.snapshot().proactiveEvents[0]).toMatchObject({ status: 'consumed', reason: 'observation-only' });
    expect(s.store.snapshot().automationTriggers).toEqual([]); expect(s.jobs.size).toBe(0); expect(s.submit).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled(); interval.mockRestore();
  });
  it('records why a rule would skip and deduplicates across a fresh service without later execution', async () => {
    const s = setup(); let service = s.create(); await service.configure(observing());
    s.setTime(Date.parse('2026-10-29T23:00:00.000Z'));
    const raw = offered('quiet-observation', s.now()); await service.offer(raw); await service.tick();
    expect(service.getObservations()[0]).toMatchObject({ decision: 'would-skip', reason: 'quiet' });
    service = s.create(); s.setTime(Date.parse('2026-10-30T12:00:00.000Z'));
    await service.offer(raw); await service.tick();
    expect(service.getObservations()).toHaveLength(1); expect(s.submit).not.toHaveBeenCalled();
    const transaction = vi.spyOn(s.store, 'transaction'); await service.tick(); expect(transaction).not.toHaveBeenCalled();
  });
  it('simulates cooldown from observed matches without creating execution reservations', async () => {
    const s = setup(), service = s.create(); await service.configure(observing());
    await service.offer(offered('one')); await service.tick();
    s.setTime(instant + 1); await service.offer(offered('two', s.now())); await service.tick();
    expect(service.getObservations().map(entry => [entry.decision, entry.reason])).toEqual([['would-act', 'rules-matched'], ['would-skip', 'cooldown']]);
    expect(s.store.snapshot().automationTriggers).toEqual([]); expect(s.submit).not.toHaveBeenCalled();
  });
  it('does not replay observations after enabling auto and makes each mode change a policy revision', async () => {
    const s = setup(), service = s.create(); await service.configure(observing());
    await service.offer(offered('observed')); await service.tick();
    const before = service.getPolicy().revision; await service.configure({ ...enabled(), mode: 'auto' });
    expect(service.getPolicy().revision).toBe(before + 1);
    await service.offer(offered('observed')); await service.tick(); expect(s.submit).not.toHaveBeenCalled();
    await service.offer(offered('new-auto-event')); await service.tick(); expect(s.submit).toHaveBeenCalledTimes(1);
    const trigger = s.store.snapshot().automationTriggers[0]!;
    await service.configure(observing());
    expect(s.store.snapshot().automationTriggers[0]?.status).toBe('cancelled');
    expect(service.admission(trigger, 'dispatch').allowed).toBe(false); expect(service.admission(trigger, 'publish').allowed).toBe(false);
  });
  it('retains encrypted observations and deduplication across a fresh repository and service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deskpet-observe-persistence-'));
    const key = Buffer.alloc(32, 37), s = setup(), path = join(directory, 'profile.enc.json');
    const vault = { getVaultKey: async () => Buffer.from(key) };
    const serviceFor = (repo: DomainRepository): EventProactiveService => {
      const store: AutomationStore = { snapshot: () => repo.snapshot(), transaction: mutation => repo.transaction(state => mutation(state)) };
      return new EventProactiveService(store, s.tasks, { now: s.now, environment: () => ({ ...s.environment }) });
    };
    try {
      const first = new DomainRepository(path, vault); await first.initialize();
      let service = serviceFor(first); await service.configure(observing()); await service.offer(offered('encrypted-observation')); await service.tick();
      const recorded = service.getObservations(); expect(recorded).toHaveLength(1);
      expect(await readFile(path, 'utf8')).not.toContain('SYNTHETIC selected app task completed');
      const reopened = new DomainRepository(path, vault); await reopened.initialize(); service = serviceFor(reopened);
      expect(service.getObservations()).toEqual(recorded);
      await service.offer(offered('encrypted-observation')); await service.tick();
      expect(service.getObservations()).toEqual(recorded); expect(s.submit).not.toHaveBeenCalled();
      expect(reopened.snapshot().automationTriggers).toEqual([]); expect(reopened.snapshot().backgroundJobs).toEqual([]);
      expect(hasAutomationProtection({ proactiveObservations: recorded })).toBe(true);
      expect(hasAutomationProtection({ attentionReceipts: [{ id: 'retained', fingerprint: '0'.repeat(64), acknowledgedAt: new Date(instant).toISOString() }] })).toBe(true);
    } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
  it('bounds display records while retaining event identities so evicted observations cannot repeat', async () => {
    const s = setup(), service = s.create(); await service.configure({ ...observing(), quietStart: '00:00', quietEnd: '00:00' });
    for (let index = 0; index < 202; index++) {
      s.setTime(instant + index * 120_000); await service.offer(offered(`bounded-${index}`, s.now())); await service.tick();
    }
    expect(service.getObservations()).toHaveLength(200); expect(service.getObservations().some(entry => entry.eventId === 'bounded-0')).toBe(false);
    expect(s.store.snapshot().proactiveEvents).toHaveLength(202);
    expect(s.store.snapshot().proactiveEvents.filter(entry => entry.observation?.matched)).toHaveLength(2);
    expect(service.getObservations().every(entry => entry.decision === 'would-skip')).toBe(true);
    await service.offer(offered('bounded-0')); await service.tick();
    expect(service.getObservations()).toHaveLength(200); expect(service.getObservations().some(entry => entry.eventId === 'bounded-0')).toBe(false);
    expect(s.store.snapshot().automationTriggers).toEqual([]); expect(s.submit).not.toHaveBeenCalled();
  });
});

describe('proactive policy patches', () => {
  it('applies concurrent field patches in order without reviving older values', async () => {
    const service = setup().create();
    const turnOn = service.patch({ mode: 'observe', enabled: false, eventKinds: ['focus-completed'] });
    const quiet = service.patch({ quietStart: '21:30' });
    const off = service.patch({ mode: 'off', enabled: false });
    await Promise.all([turnOn, quiet, off]);
    expect(service.getPolicy()).toMatchObject({ mode: 'off', quietStart: '21:30', eventKinds: ['focus-completed'] });
  });
});

describe('proactive defaults on first switch-on', () => {
  it('fills events and the system time zone only on the very first setup', async () => {
    const first = setup().create();
    await first.patch({ mode: 'observe', enabled: false });
    expect(first.getPolicy().eventKinds).toEqual(['task-completed', 'focus-completed', 'explicit-check-in']);
    expect(first.getPolicy().timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    // Rules already chosen are never overwritten when switching on again.
    const chosen = setup().create();
    await chosen.patch({ eventKinds: ['focus-completed'] });
    await chosen.patch({ mode: 'observe', enabled: false });
    expect(chosen.getPolicy()).toMatchObject({ eventKinds: ['focus-completed'], timezone: 'UTC' });
  });
});
