import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatCronBinding, ChatCronChannelRef, ChatCronInput, ChatCronRun, ChatCronSchedule, ChatCronState, ChatCronStore, ChatCronUpdate } from '../../shared/chat-cron';
import { chatCronInputSchema, chatCronUpdateSchema } from './chat-cron-schemas';
import { nextCronOccurrence } from './cron-expression';
import { QQ_CHANNEL_POLICY_VERSION, qqCronOperationSchema } from '../../shared/qq-channel';
import type { QqCronOperation } from '../../shared/qq-channel';
import { assertQqCronCapacity, normalizeQqCronInput, QQ_CRON_MIN_INTERVAL_MS } from '../security/qq-cron-policy';
import { intersectQqCronCapabilities } from '../security/channel-policy';

interface Options {
  now?: () => number;
  changed?: () => void;
  execute(schedule: ChatCronSchedule, runId: string, signal: AbortSignal, assertCurrent: () => void): Promise<void>;
  maxRunsPerTick?: number;
  maxConcurrentRuns?: number;
  /** Live channel policy at reservation and every in-flight authorization. */
  assertSchedule?(schedule: ChatCronSchedule): void;
}
type AssertAuthorized = () => void;
interface Active { scheduleId: string; sessionId: string; controller: AbortController; promise: Promise<void> }
const bindingSchema = z.object({ sessionId: z.string().uuid(), providerId: z.string().uuid(), model: z.string().min(1).max(240) }).strict();
const pending = (run: ChatCronRun) => run.status === 'reserved' || run.status === 'running';
const instant = (value: number) => new Date(value).toISOString();
const operationId = (key?: string) => {
  if (key === undefined) return randomUUID();
  const digest = createHash('sha256').update(`deskpet-chat-cron:${key}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

/** Durable minute-slot reservations around the existing host chat loop. This
 * service creates no timer, OS cron entry, daemon, tool or provider transport. */
export class ChatCronService {
  readonly #active = new Map<string, Active>();
  readonly #blockedSchedules = new Set<string>();
  readonly #now: () => number;
  #closed = false;
  #initialized = false;
  #tickWork: Promise<number> | null = null;
  #operations = 0;

  constructor(private readonly store: ChatCronStore, private readonly options: Options) { this.#now = options.now ?? Date.now; }
  get active(): boolean { return this.#active.size > 0 || this.#tickWork !== null || this.#operations > 0; }
  /** Stop this occurrence only; the approved recurring schedule remains enabled. */
  cancelRun(runId: string): boolean {
    const active = this.#active.get(runId);
    active?.controller.abort();
    return active !== undefined;
  }
  #changed(): void { try { this.options.changed?.(); } catch { /* UI is not authority. */ } }
  async #write<T>(mutation: (state: ChatCronState) => T | Promise<T>): Promise<T> {
    this.#operations++;
    try { const result = await this.store.transaction(mutation); this.#changed(); return result; }
    finally { this.#operations--; }
  }
  #session(state: ChatCronState, sessionId: string): void {
    if (!state.chatSessions.some((session) => session.id === sessionId && !session.archivedAt && !session.deletedAt)) throw new Error('cron.sessionUnavailable');
  }
  #owned(state: ChatCronState, sessionId: string, id: string): ChatCronSchedule {
    const schedule = state.chatCronSchedules.find((item) => item.id === id && item.sessionId === sessionId);
    if (!schedule) throw new Error('cron.notFound'); return schedule;
  }
  #next(input: Pick<ChatCronInput, 'expression' | 'timezone'>, now: number): string {
    const next = nextCronOccurrence(input.expression, input.timezone, now);
    if (next === null) throw new Error('cron.noOccurrence'); return next;
  }
  list(sessionId: string): ChatCronSchedule[] {
    return structuredClone(this.store.snapshot().chatCronSchedules.filter((item) => item.sessionId === sessionId));
  }
  history(sessionId: string, scheduleId?: string): ChatCronRun[] {
    const state = this.store.snapshot();
    if (scheduleId !== undefined) this.#owned(state, sessionId, scheduleId);
    return structuredClone(state.chatCronRuns.filter((run) => run.sessionId === sessionId && (scheduleId === undefined || run.scheduleId === scheduleId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
  }
  async create(binding: ChatCronBinding, raw: ChatCronInput, assertAuthorized: AssertAuthorized, idempotencyKey?: string, channel?: ChatCronChannelRef): Promise<ChatCronSchedule> {
    assertAuthorized(); if (this.#closed) throw new Error('cron.closed');
    if (channel !== undefined) throw new Error('qq.confirmationRequired');
    const owner = bindingSchema.parse(binding), input = chatCronInputSchema.parse(raw);
    const id = operationId(idempotencyKey), now = this.#now(), nextRunAt = this.#next(input, now);
    return this.#write((state) => {
      assertAuthorized(); if (this.#closed) throw new Error('cron.closed'); this.#session(state, owner.sessionId);
      if (state.chatSessions.find(item => item.id === owner.sessionId)?.channelBindingId) throw new Error('qq.confirmationRequired');
      const existing = state.chatCronSchedules.find((item) => item.id === id);
      if (existing) {
        if (Object.entries({ ...owner, ...input }).some(([key, value]) => JSON.stringify(existing[key as keyof ChatCronSchedule]) !== JSON.stringify(value))) throw new Error('cron.operationConflict');
        return structuredClone(existing);
      }
      if (state.chatCronSchedules.length >= 200) throw new Error('cron.scheduleLimit');
      const schedule: ChatCronSchedule = { ...owner, ...input, id, enabled: true, revision: 1, nextRunAt, createdAt: instant(now), updatedAt: instant(now), cancelledAt: null, ...(channel === undefined ? {} : { channel }) };
      state.chatCronSchedules.push(schedule); return structuredClone(schedule);
    });
  }
  /** One atomic, revision-bound, idempotent commit after the QQ service has
   * durably consumed the host confirmation. No check-then-write metadata patch. */
  async applyQqConfirmed(raw: QqCronOperation, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> {
    const operation = qqCronOperationSchema.parse(raw);
    if (JSON.stringify(normalizeQqCronInput(operation.input)) !== JSON.stringify(operation.input)) throw new Error('qq.cronOperationInvalid');
    const { authority, owner, input, approval } = operation;
    if (owner.sessionId !== authority.sessionId || approval.authorityId !== authority.authorityId
      || operation.action === 'create' && operation.expectedRevision !== null
      || operation.action !== 'create' && operation.expectedRevision === null
      || operation.action !== 'update' && !operation.enabled) throw new Error('qq.cronOperationInvalid');
    assertAuthorized();
    const result = await this.#write(state => {
      assertAuthorized(); if (this.#closed) throw new Error('cron.closed'); this.#session(state, owner.sessionId);
      if (state.chatSessions.find(item => item.id === owner.sessionId)?.channelBindingId !== authority.bindingId) throw new Error('qq.sessionOriginMismatch');
      const existing = state.chatCronSchedules.find(item => item.id === operation.scheduleId);
      const channel: ChatCronChannelRef = { kind: 'qq', policyVersion: QQ_CHANNEL_POLICY_VERSION, bindingId: authority.bindingId, senderId: authority.senderId, approval };
      if (existing?.channel?.approval?.confirmationId === approval.confirmationId) {
        if (Object.entries(channel).some(([key, value]) => JSON.stringify(existing.channel?.[key as keyof ChatCronChannelRef]) !== JSON.stringify(value))
          || Object.entries({ ...owner, ...input, enabled: operation.enabled }).some(([key, value]) => JSON.stringify(existing[key as keyof ChatCronSchedule]) !== JSON.stringify(value))) throw new Error('cron.operationConflict');
        return { schedule: structuredClone(existing), changed: false };
      }
      assertQqCronCapacity(state.chatCronSchedules, operation.action === 'create');
      const now = this.#now();
      if (operation.action === 'create') {
        if (existing) throw new Error('cron.operationConflict');
        if (state.chatCronSchedules.length >= 200) throw new Error('cron.scheduleLimit');
        const schedule: ChatCronSchedule = { ...owner, ...input, id: operation.scheduleId, channel, revision: 1, enabled: true,
          nextRunAt: this.#next(input, now), createdAt: instant(now), updatedAt: instant(now), cancelledAt: null };
        state.chatCronSchedules.push(schedule); return { schedule: structuredClone(schedule), changed: true };
      }
      if (!existing || existing.cancelledAt || existing.sessionId !== owner.sessionId || existing.providerId !== owner.providerId || existing.model !== owner.model
        || existing.channel?.bindingId !== authority.bindingId || existing.channel.senderId !== authority.senderId
        || existing.revision !== operation.expectedRevision) throw new Error('cron.scopeChanged');
      if (operation.action === 'resume' && Object.keys(input).some(key => JSON.stringify(existing[key as keyof ChatCronInput]) !== JSON.stringify(input[key as keyof ChatCronInput]))) throw new Error('cron.scopeChanged');
      Object.assign(existing, input, { channel, enabled: operation.enabled, updatedAt: instant(now), revision: existing.revision + 1,
        nextRunAt: operation.enabled ? this.#next(input, now) : null });
      for (const run of state.chatCronRuns) if (run.scheduleId === existing.id && pending(run)) {
        run.status = 'cancelled'; run.finishedAt = instant(now); run.errorCode = 'cron.scheduleChanged';
      }
      return { schedule: structuredClone(existing), changed: true };
    });
    if (result.changed) {
      for (const active of this.#active.values()) if (active.scheduleId === result.schedule.id) active.controller.abort();
      this.#blockedSchedules.delete(result.schedule.id);
    }
    return result.schedule;
  }
  async #change(sessionId: string, id: string, action: 'update' | 'pause' | 'resume' | 'cancel', raw: ChatCronUpdate | null, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> {
    assertAuthorized(); if (this.#closed) throw new Error('cron.closed');
    const patch = raw === null ? null : chatCronUpdateSchema.parse(raw);
    const result = await this.#write((state) => {
      assertAuthorized(); if (this.#closed) throw new Error('cron.closed');
      const schedule = this.#owned(state, sessionId, id), now = this.#now();
      if ((schedule.channel || state.chatSessions.find(item => item.id === sessionId)?.channelBindingId)
        && (action === 'update' || action === 'resume')) throw new Error('qq.confirmationRequired');
      if (schedule.cancelledAt) { if (action === 'cancel') return structuredClone(schedule); throw new Error('cron.cancelled'); }
      if (action === 'update' || action === 'resume') this.#session(state, sessionId);
      if (patch) Object.assign(schedule, patch);
      schedule.revision++; schedule.updatedAt = instant(now);
      if (action === 'pause' || action === 'cancel') { schedule.enabled = false; schedule.nextRunAt = null; }
      else { if (action === 'resume') schedule.enabled = true; schedule.nextRunAt = schedule.enabled ? this.#next(schedule, now) : null; }
      if (action === 'cancel') schedule.cancelledAt = instant(now);
      for (const run of state.chatCronRuns) if (run.scheduleId === id && pending(run)) {
        run.status = 'cancelled'; run.finishedAt = instant(now); run.errorCode = 'cron.scheduleChanged';
      }
      return structuredClone(schedule);
    });
    for (const active of this.#active.values()) if (active.scheduleId === id) active.controller.abort();
    if (action === 'resume' || action === 'update') this.#blockedSchedules.delete(id);
    return result;
  }
  update(sessionId: string, id: string, patch: ChatCronUpdate, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> { return this.#change(sessionId, id, 'update', patch, assertAuthorized); }
  pause(sessionId: string, id: string, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> { return this.#change(sessionId, id, 'pause', null, assertAuthorized); }
  resume(sessionId: string, id: string, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> { return this.#change(sessionId, id, 'resume', null, assertAuthorized); }
  cancel(sessionId: string, id: string, assertAuthorized: AssertAuthorized): Promise<ChatCronSchedule> { return this.#change(sessionId, id, 'cancel', null, assertAuthorized); }

  /** Revocation blocks in memory before any disk await. A failed durable pause
   * cannot allow this process to reacquire a fresh per-operation lease. */
  async revokeCapability(capabilityId: string): Promise<void> {
    const affected = this.store.snapshot().chatCronSchedules.filter((schedule) => !schedule.cancelledAt
      && (capabilityId === 'chat.cron' || schedule.allowedCapabilities.some((capability) => capability === capabilityId)
        || Object.hasOwn(schedule.channel?.approval?.permissionRevisions ?? {}, capabilityId))).map((schedule) => schedule.id);
    const ids = new Set(affected);
    for (const id of ids) this.#blockedSchedules.add(id);
    for (const active of this.#active.values()) if (ids.has(active.scheduleId)) active.controller.abort();
    if (ids.size === 0) return;
    await this.#write((state) => {
      const now = instant(this.#now());
      for (const schedule of state.chatCronSchedules) if (ids.has(schedule.id) && !schedule.cancelledAt) {
        schedule.enabled = false; schedule.nextRunAt = null; schedule.revision++; schedule.updatedAt = now;
      }
      for (const run of state.chatCronRuns) if (ids.has(run.scheduleId) && pending(run)) {
        run.status = 'cancelled'; run.finishedAt = now; run.errorCode = 'cron.permissionRevoked';
      }
    });
  }
  #assertCurrent(schedule: ChatCronSchedule, runId: string, signal: AbortSignal): void {
    signal.throwIfAborted(); if (this.#closed || this.#blockedSchedules.has(schedule.id)) throw new Error('cron.interrupted');
    const state = this.store.snapshot(), current = this.#owned(state, schedule.sessionId, schedule.id);
    this.#session(state, schedule.sessionId);
    if (!current.enabled || current.cancelledAt || current.revision !== schedule.revision) throw new Error('cron.scheduleChanged');
    this.options.assertSchedule?.(current);
    const run = state.chatCronRuns.find((item) => item.id === runId);
    if (!run || run.status !== 'running' || run.scheduleRevision !== schedule.revision) throw new Error('cron.staleRun');
  }
  #launch(schedule: ChatCronSchedule, runId: string): void {
    const controller = new AbortController();
    const active: Active = { scheduleId: schedule.id, sessionId: schedule.sessionId, controller, promise: Promise.resolve() };
    this.#active.set(runId, active);
    active.promise = Promise.resolve().then(async () => {
      try {
        await this.#write((state) => {
          controller.signal.throwIfAborted(); if (this.#closed || this.#blockedSchedules.has(schedule.id)) throw new Error('cron.interrupted');
          const current = this.#owned(state, schedule.sessionId, schedule.id); this.#session(state, schedule.sessionId);
          const run = state.chatCronRuns.find((item) => item.id === runId);
          if (!run || run.status !== 'reserved' || !current.enabled || current.cancelledAt || current.revision !== schedule.revision) throw new Error('cron.scheduleChanged');
          run.status = 'running'; run.startedAt = instant(this.#now());
        });
        const assertCurrent = () => this.#assertCurrent(schedule, runId, controller.signal);
        assertCurrent(); await this.options.execute(structuredClone(schedule), runId, controller.signal, assertCurrent); assertCurrent();
        await this.#finish(runId, 'succeeded', null);
      } catch {
        await this.#finish(runId, controller.signal.aborted || this.#closed ? 'cancelled' : 'failed', controller.signal.aborted || this.#closed ? 'cron.interrupted' : 'cron.executionFailed').catch(() => undefined);
      }
    }).finally(() => { this.#active.delete(runId); this.#changed(); });
  }
  async #finish(runId: string, status: 'succeeded' | 'failed' | 'cancelled', errorCode: string | null): Promise<void> {
    await this.#write((state) => { const run = state.chatCronRuns.find((item) => item.id === runId);
      if (run && pending(run)) { run.status = status; run.errorCode = errorCode; run.finishedAt = instant(this.#now()); }
    });
  }
  tick(options: { startup?: boolean; suspended?: boolean } = {}): Promise<number> {
    if (this.#closed || options.suspended || this.#tickWork !== null) return Promise.resolve(0);
    this.#tickWork = this.#tick(options).finally(() => { this.#tickWork = null; }); return this.#tickWork;
  }
  async #tick(options: { startup?: boolean }): Promise<number> {
    const startup = options.startup === true || !this.#initialized;
    if (startup) await this.#write((state) => {
      for (const schedule of state.chatCronSchedules) {
        const channel = schedule.channel;
        if (!channel || channel.policyVersion === QQ_CHANNEL_POLICY_VERSION) continue;
        schedule.allowedCapabilities = intersectQqCronCapabilities(schedule.allowedCapabilities);
        schedule.channel = { kind: 'qq', bindingId: channel.bindingId, senderId: channel.senderId, policyVersion: QQ_CHANNEL_POLICY_VERSION };
        schedule.enabled = false;
        schedule.nextRunAt = null;
        schedule.revision++;
        schedule.updatedAt = instant(this.#now());
      }
      for (const run of state.chatCronRuns) if (pending(run) && !this.#active.has(run.id)) {
        run.status = 'interrupted'; run.finishedAt = instant(this.#now()); run.errorCode = 'cron.interruptedNoReplay';
      }
    });
    this.#initialized = true;
    const limit = Math.max(1, Math.min(8, this.options.maxRunsPerTick ?? 4));
    const concurrency = Math.max(1, Math.min(8, this.options.maxConcurrentRuns ?? 2));
    let launched = 0, processed = 0;
    const due = this.store.snapshot().chatCronSchedules.filter((schedule) => schedule.enabled && !schedule.cancelledAt && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) <= this.#now())
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!) || a.id.localeCompare(b.id));
    for (const item of due) {
      if (this.#closed) break;
      if (processed >= limit || this.#active.size >= concurrency) break;
      if (this.#blockedSchedules.has(item.id) || [...this.#active.values()].some((active) => active.scheduleId === item.id || active.sessionId === item.sessionId)) continue;
      processed++;
      const reserved = await this.#write((state) => {
        if (this.#closed || this.#blockedSchedules.has(item.id)) return null;
        const schedule = this.#owned(state, item.sessionId, item.id), now = this.#now();
        if (!schedule.enabled || schedule.cancelledAt || schedule.nextRunAt === null || Date.parse(schedule.nextRunAt) > now) return null;
        try { this.#session(state, schedule.sessionId); } catch { schedule.enabled = false; schedule.nextRunAt = null; schedule.revision++; schedule.updatedAt = instant(now); return null; }
        try { this.options.assertSchedule?.(schedule); } catch {
          schedule.enabled = false; schedule.nextRunAt = null; schedule.revision++; schedule.updatedAt = instant(now); return null;
        }
        const dueAt = schedule.nextRunAt, key = `cron:${schedule.id}:${dueAt}`;
        if (state.chatCronRuns.length >= 10000) throw new Error('cron.historyLimit');
        schedule.nextRunAt = this.#next(schedule, Math.max(now, Date.parse(dueAt))); schedule.updatedAt = instant(now);
        if (state.chatCronRuns.some((run) => run.key === key)) return null;
        const missed = (startup && Date.parse(dueAt) < now) || now - Date.parse(dueAt) >= 60_000;
        const tooSoon = schedule.channel?.kind === 'qq' && state.chatCronRuns.some(run => run.scheduleId === schedule.id && run.startedAt
          && now - Date.parse(run.startedAt) < QQ_CRON_MIN_INTERVAL_MS);
        const skip = missed && schedule.missedPolicy === 'skip' || tooSoon;
        const run: ChatCronRun = { id: randomUUID(), key, scheduleId: schedule.id, sessionId: schedule.sessionId, scheduleRevision: schedule.revision,
          dueAt, status: skip ? 'missed' : 'reserved', createdAt: instant(now), startedAt: null, finishedAt: skip ? instant(now) : null, errorCode: tooSoon ? 'qq.cronTooFrequent' : skip ? 'cron.missedSkipped' : null };
        state.chatCronRuns.push(run); return skip ? null : { schedule: structuredClone(schedule), runId: run.id };
      });
      if (reserved) { this.#launch(reserved.schedule, reserved.runId); launched++; }
    }
    return launched;
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) active.controller.abort();
    await this.#tickWork?.catch(() => undefined);
    for (const active of this.#active.values()) active.controller.abort();
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
  }
}
