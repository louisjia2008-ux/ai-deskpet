import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BackgroundJob } from '../../shared/background-jobs';
import type { AutomaticTaskPort, AutomaticTrigger, AutomationState, AutomationStore, CalendarRule, PersistentSchedule, PersistentScheduleInput } from '../../shared/automation';
import { calendarPreview, validateCalendarRule, validateCalendarTimezone } from './calendar-rules';

const MAX_TRIGGERS = 2000;
const MAX_SCHEDULES = 200;
const ON_TIME_GRACE_MS = 60_000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu;
const terminal = new Set<AutomaticTrigger['status']>(['missed', 'cancelled', 'blocked', 'succeeded', 'failed']);
const when = (value: number): string => { if (!Number.isFinite(value)) throw new Error('schedule.invalidClock'); return new Date(value).toISOString(); };
const assertId = (value: string): void => { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('schedule.invalidId'); };

const validateInput = (input: PersistentScheduleInput): void => {
  assertId(input.id); assertId(input.providerId);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 240
    || typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 4000
    || typeof input.material !== 'string' || input.material.length > 32_000
    || (input.model !== null && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 240))
    || typeof input.enabled !== 'boolean' || !['skip', 'run-once'].includes(input.missedPolicy)
    || !['local-only', 'cloud-allowed'].includes(input.privacy)) throw new Error('schedule.invalidInput');
  validateCalendarRule(input.rule); validateCalendarTimezone(input.timezone);
};
const configured = (schedule: PersistentSchedule): PersistentScheduleInput => ({ id: schedule.id, title: schedule.title, instruction: schedule.instruction,
  material: schedule.material, privacy: schedule.privacy, providerId: schedule.providerId, model: schedule.model,
  rule: schedule.rule, timezone: schedule.timezone, missedPolicy: schedule.missedPolicy, enabled: schedule.enabled });
const sameSpecification = (job: BackgroundJob, schedule: PersistentSchedule): boolean => job.instruction === schedule.instruction
  && job.material === schedule.material && job.source?.privacy === schedule.privacy
  && job.binding?.provider.id === schedule.providerId && (schedule.model === null || job.binding?.model === schedule.model);
const ownsJob = (job: BackgroundJob, trigger: AutomaticTrigger, schedule: PersistentSchedule): boolean => job.operationId === trigger.id
  && (trigger.jobId === job.id || sameSpecification(job, schedule));
const jobStatus = (job: BackgroundJob, startup: boolean): AutomaticTrigger['status'] => {
  if (job.status === 'interrupted') return 'unknown';
  if (startup && ['running', 'dispatching'].includes(job.status)) return 'unknown';
  if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job.status)) return job.status as AutomaticTrigger['status'];
  return 'submitted';
};

/** Uses the existing E-P2 task port; never performs provider requests or tool execution. */
export class PersistentScheduleService {
  readonly #now: () => number;
  readonly #changed: () => void;
  #ticking = false;

  constructor(private readonly store: AutomationStore, private readonly tasks: AutomaticTaskPort,
    private readonly options: { now?: () => number; changed?: () => void; defaultModel?: (providerId: string) => string | undefined } = {}) {
    this.#now = options.now ?? Date.now; this.#changed = options.changed ?? (() => undefined);
  }
  list(): PersistentSchedule[] { return this.store.snapshot().automationSchedules; }
  history(id?: string): AutomaticTrigger[] { return this.store.snapshot().automationTriggers.filter((trigger) => trigger.kind === 'schedule' && (id === undefined || trigger.sourceId === id)); }
  preview(input: { rule: CalendarRule; timezone: string; after: string; count: number }): string[] { return calendarPreview(input); }
  #next(schedule: Pick<PersistentSchedule, 'rule' | 'timezone'>, instant: number): string | null {
    return calendarPreview({ rule: schedule.rule, timezone: schedule.timezone, after: when(instant), count: 1 })[0] ?? null;
  }
  #schedule(state: AutomationState, id: string): PersistentSchedule {
    const schedule = state.automationSchedules.find((item) => item.id === id);
    if (!schedule) throw new Error('schedule.notFound');
    return schedule;
  }
  #cancelTriggers(state: AutomationState, id: string, time: string, reason: string): string[] {
    const jobs: string[] = [];
    const schedule = this.#schedule(state, id);
    for (const trigger of state.automationTriggers) {
      if (trigger.kind !== 'schedule' || trigger.sourceId !== id || terminal.has(trigger.status)) continue;
      trigger.cancelledAt ??= time; trigger.updatedAt = time; trigger.status = 'cancelled'; trigger.errorCode = reason;
      const job = this.tasks.getByOperation(trigger.id);
      if (job && ownsJob(job, trigger, schedule)) { trigger.jobId ??= job.id; jobs.push(job.id); }
    }
    return [...new Set(jobs)];
  }
  async #cancelJobs(jobs: string[]): Promise<void> {
    const results = await Promise.allSettled(jobs.map((id) => this.tasks.cancel(id)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('schedule.cancelIncomplete');
  }

  async upsert(input: PersistentScheduleInput): Promise<PersistentSchedule> {
    validateInput(input);
    const now = this.#now(), time = when(now);
    const output = await this.store.transaction((state) => {
      const existing = state.automationSchedules.find((item) => item.id === input.id);
      if (existing?.cancelledAt) throw new Error('schedule.cancelled');
      if (existing && isDeepStrictEqual(configured(existing), input)) return { schedule: structuredClone(existing), jobs: [] as string[] };
      if (!existing && state.automationSchedules.length >= MAX_SCHEDULES) throw new Error('schedule.capacity');
      const nextRunAt = input.enabled ? this.#next(input, now) : null;
      if (input.enabled && input.rule.kind === 'once' && nextRunAt === null) throw new Error('schedule.pastOnce');
      const jobs = existing ? this.#cancelTriggers(state, existing.id, time, 'schedule.configurationChanged') : [];
      const schedule: PersistentSchedule = { ...structuredClone(input), revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? time, updatedAt: time, cancelledAt: null,
        nextRunAt };
      if (existing) Object.assign(existing, schedule); else state.automationSchedules.push(schedule);
      return { schedule: structuredClone(schedule), jobs };
    });
    this.#changed(); await this.#cancelJobs(output.jobs); return output.schedule;
  }
  async pause(id: string): Promise<void> {
    assertId(id); const time = when(this.#now());
    const jobs = await this.store.transaction((state) => {
      const schedule = this.#schedule(state, id);
      if (!schedule.enabled || schedule.cancelledAt) return [];
      schedule.enabled = false; schedule.revision += 1; schedule.updatedAt = time; schedule.nextRunAt = null;
      return this.#cancelTriggers(state, id, time, 'schedule.paused');
    });
    this.#changed(); await this.#cancelJobs(jobs);
  }
  async cancel(id: string): Promise<void> {
    assertId(id); const time = when(this.#now());
    const jobs = await this.store.transaction((state) => {
      const schedule = this.#schedule(state, id);
      if (schedule.cancelledAt) return [];
      schedule.enabled = false; schedule.cancelledAt = time; schedule.revision += 1; schedule.updatedAt = time; schedule.nextRunAt = null;
      return this.#cancelTriggers(state, id, time, 'schedule.cancelled');
    });
    this.#changed(); await this.#cancelJobs(jobs);
  }
  #newTrigger(state: AutomationState, schedule: PersistentSchedule, key: string, id: string, dueAt: string, status: AutomaticTrigger['status']): AutomaticTrigger {
    if (state.automationTriggers.length >= MAX_TRIGGERS) throw new Error('schedule.historyCapacity');
    if (state.automationTriggers.some((trigger) => trigger.id === id)) throw new Error('schedule.operationConflict');
    const time = when(this.#now());
    const trigger: AutomaticTrigger = { id, key, kind: 'schedule', sourceId: schedule.id, dueAt, policyRevision: schedule.revision,
      status, jobId: null, messageId: null, createdAt: time, updatedAt: time, cancelledAt: null, errorCode: status === 'missed' ? 'schedule.missedSkipped' : null };
    state.automationTriggers.push(trigger); return structuredClone(trigger);
  }
  #assertCurrent(trigger: AutomaticTrigger): PersistentSchedule {
    const state = this.store.snapshot(), schedule = this.#schedule(state, trigger.sourceId);
    const current = state.automationTriggers.find((item) => item.id === trigger.id);
    if (!current || current.cancelledAt || current.status !== 'reserved' || !schedule.enabled || schedule.cancelledAt
      || schedule.revision !== trigger.policyRevision) throw new Error('schedule.authorizationChanged');
    return schedule;
  }
  async #submit(trigger: AutomaticTrigger): Promise<AutomaticTrigger> {
    let job: BackgroundJob | null = null;
    try {
      const schedule = this.#assertCurrent(trigger);
      const existing = this.tasks.getByOperation(trigger.id);
      if (existing) {
        if (!ownsJob(existing, trigger, schedule)) throw new Error('schedule.operationConflict');
        job = existing;
      } else {
        const model = schedule.model ?? this.options.defaultModel?.(schedule.providerId);
        if (!model) throw new Error('provider.unavailable');
        const submitted = await this.tasks.submit(trigger, { instruction: schedule.instruction, material: schedule.material,
          privacy: schedule.privacy, providerId: schedule.providerId, model });
        if (submitted.operationId !== trigger.id || !sameSpecification(submitted, { ...schedule, model })) throw new Error('schedule.operationConflict');
        job = submitted;
      }
      const outcome = await this.store.transaction((state) => {
        const current = state.automationTriggers.find((item) => item.id === trigger.id);
        if (!current) throw new Error('schedule.triggerNotFound');
        current.jobId = job!.id; current.updatedAt = when(this.#now());
        if (current.cancelledAt) return { trigger: structuredClone(current), cancel: true };
        const latest = this.#schedule(state, current.sourceId);
        if (!latest.enabled || latest.cancelledAt || latest.revision !== current.policyRevision) {
          current.cancelledAt = current.updatedAt; current.status = 'cancelled'; current.errorCode = 'schedule.authorizationChanged';
          return { trigger: structuredClone(current), cancel: true };
        }
        current.status = jobStatus(job!, false); return { trigger: structuredClone(current), cancel: false };
      });
      if (outcome.cancel) await this.tasks.cancel(job.id);
      this.#changed(); return outcome.trigger;
    } catch (error) {
      const candidate = job ?? this.tasks.getByOperation(trigger.id);
      const currentSchedule = this.store.snapshot().automationSchedules.find((schedule) => schedule.id === trigger.sourceId);
      const existing = candidate && (job !== null || (currentSchedule && ownsJob(candidate, trigger, currentSchedule))) ? candidate : null;
      const conflict = (error instanceof Error && error.message === 'schedule.operationConflict') || (candidate !== null && existing === null);
      const result = await this.store.transaction((state) => {
        const current = state.automationTriggers.find((item) => item.id === trigger.id);
        if (!current) throw new Error('schedule.triggerNotFound');
        current.updatedAt = when(this.#now());
        if (existing) current.jobId = existing.id;
        if (!current.cancelledAt && !terminal.has(current.status)) {
          current.status = conflict ? 'blocked' : existing ? jobStatus(existing, false) : 'unknown';
          current.errorCode = conflict ? 'schedule.operationConflict' : 'schedule.submissionUnknown';
        }
        return structuredClone(current);
      });
      this.#changed(); return result;
    }
  }
  async runNow(input: { id: string; operationId: string }): Promise<AutomaticTrigger> {
    assertId(input.id); assertId(input.operationId);
    const reserved = await this.store.transaction((state) => {
      const schedule = this.#schedule(state, input.id);
      if (!schedule.enabled || schedule.cancelledAt) throw new Error('schedule.paused');
      const key = `schedule-manual:${input.operationId}`;
      const existing = state.automationTriggers.find((trigger) => trigger.key === key);
      if (existing) {
        if (existing.sourceId !== input.id || existing.kind !== 'schedule') throw new Error('schedule.operationConflict');
        return { trigger: structuredClone(existing), created: false };
      }
      // A client-supplied operation UUID must not attach a pre-existing unrelated job.
      if (this.tasks.getByOperation(input.operationId)) throw new Error('schedule.operationConflict');
      return { trigger: this.#newTrigger(state, schedule, key, input.operationId, when(this.#now()), 'reserved'), created: true };
    });
    this.#changed(); return reserved.created ? this.#submit(reserved.trigger) : reserved.trigger;
  }

  async #reconcile(startup: boolean): Promise<void> {
    const updates = this.store.snapshot().automationTriggers.filter((trigger) => trigger.kind === 'schedule'
      && !terminal.has(trigger.status)).map((trigger) => ({ trigger, job: this.tasks.getByOperation(trigger.id) }));
    if (!updates.length) return;
    await this.store.transaction((state) => {
      for (const { trigger, job } of updates) {
        const current = state.automationTriggers.find((item) => item.id === trigger.id);
        if (!current || current.cancelledAt || terminal.has(current.status)) continue;
        const schedule = state.automationSchedules.find((item) => item.id === current.sourceId);
        if (job && schedule && ownsJob(job, current, schedule)) { current.jobId = job.id; current.status = jobStatus(job, startup); }
        else if (job) { current.status = 'blocked'; current.errorCode = 'schedule.operationConflict'; }
        else if (startup && current.status === 'reserved') { current.status = 'unknown'; current.errorCode = 'schedule.reservationUncertain'; }
        current.updatedAt = when(this.#now());
      }
    });
  }
  /** Existing host timer calls this; app exit runs nothing. Resume/startup applies the explicit missed policy. */
  async tick(options: { startup?: boolean; suspended?: boolean } = {}): Promise<number> {
    if (options.suspended || this.#ticking) return 0;
    this.#ticking = true;
    try {
      await this.#reconcile(options.startup === true);
      const now = this.#now(); let submitted = 0;
      // A tick can reserve at most 20 tasks, including skipped/coalesced occurrences.
      const due = this.list().filter((schedule) => schedule.enabled && !schedule.cancelledAt && schedule.nextRunAt !== null
        && Date.parse(schedule.nextRunAt) <= now).slice(0, 20);
      for (const selected of due) {
        const reserved = await this.store.transaction((state) => {
          const schedule = this.#schedule(state, selected.id), date = schedule.nextRunAt;
          if (!schedule.enabled || schedule.cancelledAt || date === null || Date.parse(date) > now) return null;
          const key = `schedule:${schedule.id}:${date}`;
          const previous = state.automationTriggers.find((trigger) => trigger.key === key);
          const missed = (options.startup === true && Date.parse(date) < now) || now - Date.parse(date) > ON_TIME_GRACE_MS;
          if (previous) { schedule.nextRunAt = this.#next(schedule, now); schedule.updatedAt = when(now); return null; }
          const trigger = this.#newTrigger(state, schedule, key, randomUUID(), date, missed && schedule.missedPolicy === 'skip' ? 'missed' : 'reserved');
          schedule.nextRunAt = this.#next(schedule, now); schedule.updatedAt = when(now);
          return trigger;
        });
        if (reserved?.status === 'reserved') { await this.#submit(reserved); submitted += 1; }
      }
      this.#changed(); return submitted;
    } finally { this.#ticking = false; }
  }
}
