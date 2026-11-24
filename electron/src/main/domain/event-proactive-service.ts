import { randomUUID } from 'node:crypto';
import { proactiveMode } from '../../shared/automation';
import type {
  ProactiveObservation, AutomaticTaskPort, AutomaticTrigger, AutomationState, AutomationStore, ProactiveEnvironment, ProactiveEvent,
  ProactivePolicy, ProactivePolicyInput, ProactiveEventKind,
} from '../../shared/automation';
import {
  evaluateProactiveAdmission, evaluateProactiveObservation, PROACTIVE_EVENT_KINDS, PROACTIVE_EVENT_LIMIT, PROACTIVE_TRIGGER_LIMIT, PROACTIVE_OBSERVATION_LIMIT,
  validateProactivePolicyInput,
} from './proactive-policy';
import type { ProactiveAdmission, ProactiveBlockReason } from './proactive-policy';
import { backgroundFailureCode } from './background-failure';

interface Options {
  /** The owner's written character, sent with the check-in material. */
  character?: (policy: ProactivePolicy) => string | null; context?: (policy: ProactivePolicy) => unknown; now?: () => number; environment: () => ProactiveEnvironment; changed?: () => void;
  defaultModel?: (providerId: string) => string | null; }
type OfferedEvent = Pick<ProactiveEvent, 'id' | 'kind' | 'occurredAt' | 'summary'>;
const triggerKey = (eventId: string): string => `proactive:${eventId}`;
const pending = (trigger: AutomaticTrigger): boolean => trigger.kind === 'proactive' && ['reserved', 'submitted'].includes(trigger.status);

/** A bounded consumer of explicit app events, never a model polling loop. */
export class EventProactiveService {
  readonly #now: () => number;
  #closed = false;
  #operation: Promise<void> | null = null;
  #epoch = 0;
  #revoking = 0;
  #faulted = false;
  #revocation: Promise<void> = Promise.resolve();

  constructor(private readonly store: AutomationStore, private readonly tasks: AutomaticTaskPort, private readonly options: Options) {
    this.#now = options.now ?? Date.now;
  }
  get active(): boolean { return this.#operation !== null || this.#revoking > 0; }
  /** A fixed greeting for an explicitly paired phone needs no model or desktop
   * content. Desktop visibility and the screen lock govern on-screen greetings. */
  privatePhonePolicy(): Pick<ProactivePolicy,'quietStart'|'quietEnd'|'timezone'|'cooldownMinutes'|'dailyLimit'|'revision'> | null {
    if (this.#closed || this.#revoking > 0 || this.#faulted) return null;
    const env = this.#environment(), policy = this.getPolicy();
    if (!env.permission || env.suspended || env.busy || proactiveMode(policy) !== 'auto' ||
      !policy.eventKinds.includes('explicit-check-in')) return null;
    const { quietStart, quietEnd, timezone, cooldownMinutes, dailyLimit, revision } = policy;
    return { quietStart, quietEnd, timezone, cooldownMinutes, dailyLimit, revision };
  }
  get pausedByError(): boolean { return this.#faulted; }
  getPolicy(): ProactivePolicy { return structuredClone(this.store.snapshot().proactivePolicy); }
  getObservations(): ProactiveObservation[] { return structuredClone(this.store.snapshot().proactiveObservations ?? []); }

  #changed(): void { try { this.options.changed?.(); } catch { /* Notifications do not change durable authority. */ } }
  #environment(): ProactiveEnvironment {
    try { return this.options.environment(); }
    catch { return { suspended: true, locked: true, busy: true, visible: false, permission: false }; }
  }
  #decision(state: AutomationState, trigger: AutomaticTrigger): ProactiveAdmission {
    const no = (reason: ProactiveBlockReason): ProactiveAdmission => ({ allowed: false, reason });
    if (this.#closed) return no('closed');
    if (this.#revoking || this.#faulted || trigger.cancelledAt !== null || !pending(trigger)) return no('cancelled');
    if (trigger.policyRevision !== state.proactivePolicy.revision) return no('policy-changed');
    const event = state.proactiveEvents.find((item) => item.id === trigger.sourceId);
    if (!event || trigger.key !== triggerKey(event.id) || event.status !== 'consumed') return no('invalid-event');
    return evaluateProactiveAdmission({ policy: state.proactivePolicy, event, triggers: state.automationTriggers,
      environment: this.#environment(), now: this.#now(), excludeTriggerId: trigger.id });
  }
  /** Host must reuse this at actual fetch and publication, including revocations still waiting on disk. */
  admission(trigger: AutomaticTrigger, phase: 'submit' | 'dispatch' | 'publish' = 'dispatch'): ProactiveAdmission {
    if (!['submit', 'dispatch', 'publish'].includes(phase)) return { allowed: false, reason: 'invalid-event' };
    const state = this.store.snapshot(), current = state.automationTriggers.find((item) => item.id === trigger.id);
    if (!current) return { allowed: false, reason: 'invalid-event' };
    // The coordinator owns exactly-once message creation. Its post-commit
    // visibility check must still re-evaluate quiet/revocation without making a
    // completed trigger dispatchable again or changing persistent authority.
    const publication = phase === 'publish' && current.status === 'succeeded' && current.messageId !== null
      ? { ...current, status: 'submitted' as const } : current;
    return this.#decision(state, publication);
  }

  /** Whether an event offered this instant would run. A moment that cannot is not worth
   * queueing: a morning greeting must not fire that evening when the rules next allow. */
  wouldAdmitNow(kind: ProactiveEventKind): boolean {
    const state = this.store.snapshot(), now = this.#now();
    if (this.#closed || this.#revoking > 0 || this.#faulted) return false;
    return evaluateProactiveAdmission({ policy: state.proactivePolicy, triggers: state.automationTriggers, environment: this.#environment(), now,
      event: { id: 'preview', kind, occurredAt: new Date(now).toISOString(), summary: '', status: 'pending', reason: null } }).allowed;
  }

  async offer(raw: OfferedEvent): Promise<void> {
    if (this.#closed) return;
    if (!raw || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128
      || !PROACTIVE_EVENT_KINDS.includes(raw.kind) || !Number.isFinite(Date.parse(raw.occurredAt))
      || typeof raw.summary !== 'string' || raw.summary.length > 500) throw new Error('proactive.invalidEvent');
    const policy = this.getPolicy();
    if (proactiveMode(policy) === 'off' || !policy.eventKinds.includes(raw.kind)) return;
    await this.store.transaction((state) => {
      // Unselected events are not collected as a new history or observation permission.
      if (proactiveMode(state.proactivePolicy) === 'off' || !state.proactivePolicy.eventKinds.includes(raw.kind)) return;
      const existing = state.proactiveEvents.find((event) => event.id === raw.id);
      if (existing) {
        if (existing.kind !== raw.kind || existing.occurredAt !== raw.occurredAt || existing.summary !== raw.summary) throw new Error('proactive.eventConflict');
        return;
      }
      if (state.proactiveEvents.length >= PROACTIVE_EVENT_LIMIT) throw new Error('proactive.eventCapacity');
      state.proactiveEvents.push({ ...raw, status: 'pending', reason: null });
    });
    if (proactiveMode(this.getPolicy()) === 'auto') this.#changed();
  }

  #patches: Promise<unknown> = Promise.resolve();
  /** Applies field patches one at a time on the policy as saved then, so concurrent edits never revive old values. */
  patch(fields: Partial<ProactivePolicyInput>): Promise<ProactivePolicy> {
    const run = this.#patches.then(() => {
      const { revision, ...current } = this.getPolicy(); void revision;
      return this.configure({ ...current, ...fields });
    });
    this.#patches = run.catch(() => undefined);
    return run;
  }

  async configure(raw: ProactivePolicyInput): Promise<ProactivePolicy> {
    const input = validateProactivePolicyInput(raw);
    const previous = this.getPolicy();
    const { revision, ...previousInput } = previous;
    void revision; // The revision is host metadata, not a user policy field.
    if (JSON.stringify(previousInput) === JSON.stringify(input)) return previous;
    let saved: ProactivePolicy | undefined;
    await this.#revoke('proactive.policyChanged', (state) => {
      if (state.proactivePolicy.revision >= Number.MAX_SAFE_INTEGER) throw new Error('proactive.revisionExhausted');
      state.proactivePolicy = { ...input, revision: state.proactivePolicy.revision + 1 };
      saved = structuredClone(state.proactivePolicy);
      for (const event of state.proactiveEvents) if (event.status === 'pending') { event.status = 'dismissed'; event.reason = 'policy-changed'; }
    });
    this.#faulted = false;
    this.#changed();
    return saved!;
  }

  async followModel(expected: { providerId: string; model: string }): Promise<boolean> {
    const policy = this.getPolicy();
    if (policy.providerId !== expected.providerId || policy.model !== expected.model) return false;
    let changed = false;
    await this.#revoke('proactive.policyChanged', state => {
      const current = state.proactivePolicy;
      if (current.providerId !== expected.providerId || current.model !== expected.model) return false;
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('proactive.revisionExhausted');
      current.model = null;
      changed = true;
      if (this.options.defaultModel?.(expected.providerId) === expected.model) return false;
      current.revision++;
      return true;
    });
    if (changed) this.#changed();
    return changed;
  }

  /** Persists intent first, then targets only proactive jobs. Never cancels another origin. */
  #revoke(reason: string, change?: (state: AutomationState) => boolean | void): Promise<void> {
    this.#epoch++; this.#revoking++;
    const revoke = async (): Promise<void> => {
      const operations = await this.store.transaction((state) => {
        if (change?.(state) === false) return [];
        const now = new Date(this.#now()).toISOString(), ids: string[] = [];
        for (const trigger of state.automationTriggers.filter(pending)) {
          trigger.status = 'cancelled'; trigger.cancelledAt = now; trigger.updatedAt = now; trigger.errorCode = reason;
          ids.push(trigger.id);
        }
        return ids;
      });
      for (const operationId of operations) {
        const job = this.tasks.getByOperation(operationId);
        if (job && ['queued', 'dispatching', 'running'].includes(job.status)) await this.tasks.cancel(job.id);
      }
      this.#changed();
    };
    const operation = this.#revocation.then(revoke, revoke).catch((error: unknown) => { this.#faulted = true; throw error; })
      .finally(() => { this.#revoking--; });
    this.#revocation = operation.catch(() => undefined);
    return operation;
  }
  interrupt(): Promise<void> { return this.#revoke('proactive.interrupted'); }
  noteInteraction(): Promise<void> { return this.#revoke('proactive.userInteraction'); }

  tick(): Promise<void> {
    if (this.#closed || this.#revoking || this.#faulted || proactiveMode(this.getPolicy()) === 'off') return Promise.resolve();
    if (this.#operation !== null) return this.#operation;
    const executing = proactiveMode(this.getPolicy()) === 'auto';
    this.#operation = this.#tick().catch((error: unknown) => { this.#faulted = true; throw error; }).finally(() => { this.#operation = null; if (executing) this.#changed(); });
    return this.#operation;
  }

  async #reconcile(): Promise<void> {
    const changes = this.store.snapshot().automationTriggers.filter(pending).flatMap<Pick<AutomaticTrigger, 'id' | 'jobId' | 'status' | 'errorCode'>>((trigger) => {
      const job = this.tasks.getByOperation(trigger.id);
      if (!job || job.status === 'interrupted') return [{ id: trigger.id, jobId: job?.id ?? trigger.jobId, status: 'unknown' as const, errorCode: 'proactive.dispatchUnconfirmed' }];
      if (job.status === 'failed' || job.status === 'blocked' || job.status === 'cancelled') return [{ id: trigger.id, jobId: job.id, status: job.status, errorCode: job.completionReason ?? 'proactive.jobTerminal' }];
      if (trigger.status === 'reserved') return [{ id: trigger.id, jobId: job.id, status: 'submitted' as const, errorCode: null }];
      return [];
    });
    if (changes.length === 0) return;
    await this.store.transaction((state) => {
      for (const update of changes) {
        const trigger = state.automationTriggers.find((item) => item.id === update.id);
        if (trigger && pending(trigger)) Object.assign(trigger, update, { updatedAt: new Date(this.#now()).toISOString() });
      }
    });
    // Successful job publication is owned by the mainline coordinator. It is
    // intentionally still submitted until that one transaction publishes it.
  }

  async #observe(epoch: number): Promise<void> {
    const ids = this.store.snapshot().proactiveEvents.filter((event) => event.status === 'pending')
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).slice(0, 32).map((event) => event.id);
    if (ids.length === 0) return;
    await this.store.transaction((state) => {
      if (this.#closed || this.#revoking || epoch !== this.#epoch || proactiveMode(state.proactivePolicy) !== 'observe') return;
      const observations = state.proactiveObservations ??= [];
      for (const id of ids) {
        const event = state.proactiveEvents.find((entry) => entry.id === id);
        if (!event || event.status !== 'pending') continue;
        if (!observations.some((entry) => entry.eventId === id)) {
          const now = this.#now();
          // Frequency history belongs to retained event identities, not the
          // shorter display log. Evicting a row must not reset today's rules.
          const previousMatches = state.proactiveEvents.flatMap<ProactiveObservation>((entry) => entry.observation?.matched ? [{
            id: `observation:${entry.id}`, eventId: entry.id, kind: entry.kind, summary: entry.summary, occurredAt: entry.occurredAt,
            observedAt: entry.observation.observedAt, policyRevision: entry.observation.policyRevision, decision: 'would-act', reason: 'rules-matched',
          }] : []);
          const decision = evaluateProactiveObservation({ policy: state.proactivePolicy, event, triggers: state.automationTriggers,
            observations: previousMatches, environment: this.#environment(), now });
          event.observation = { observedAt: new Date(now).toISOString(), policyRevision: state.proactivePolicy.revision, matched: decision.allowed };
          observations.push({ id: `observation:${id}`, eventId: id, kind: event.kind, summary: event.summary, occurredAt: event.occurredAt,
            observedAt: new Date(now).toISOString(), policyRevision: state.proactivePolicy.revision,
            decision: decision.allowed ? 'would-act' : 'would-skip', reason: decision.reason ?? 'rules-matched' });
          if (observations.length > PROACTIVE_OBSERVATION_LIMIT) observations.splice(0, observations.length - PROACTIVE_OBSERVATION_LIMIT);
        }
        // Keep the event identity even if its display record later leaves the
        // bounded observation list. Re-offering it can never create work.
        event.status = 'consumed'; event.reason = 'observation-only';
      }
    });
  }

  async #tick(): Promise<void> {
    const epoch = this.#epoch;
    if (proactiveMode(this.getPolicy()) === 'observe') { await this.#observe(epoch); return; }
    await this.#reconcile();
    if (this.#closed || this.#revoking || epoch !== this.#epoch) return;
    const events = this.store.snapshot().proactiveEvents.filter((event) => event.status === 'pending')
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(0, 32);
    for (const event of events) {
      if (this.#closed || this.#revoking || epoch !== this.#epoch) return;
      const snapshot = this.store.snapshot();
      const currentEvent = snapshot.proactiveEvents.find((item) => item.id === event.id);
      if (!currentEvent || currentEvent.status !== 'pending') continue;
      const preview = evaluateProactiveAdmission({ policy: snapshot.proactivePolicy, event: currentEvent,
        triggers: snapshot.automationTriggers, environment: this.#environment(), now: this.#now() });
      if (!preview.allowed && currentEvent.reason === preview.reason
        && !snapshot.automationTriggers.some((trigger) => trigger.key === triggerKey(currentEvent.id))) continue;
      const reserved = await this.store.transaction((state) => {
        const current = state.proactiveEvents.find((item) => item.id === event.id);
        if (!current || current.status !== 'pending') return null;
        const existing = state.automationTriggers.find((trigger) => trigger.key === triggerKey(current.id));
        if (existing) { current.status = 'consumed'; return null; }
        const now = this.#now(), decision = evaluateProactiveAdmission({ policy: state.proactivePolicy, event: current,
          triggers: state.automationTriggers, environment: this.#environment(), now });
        if (!decision.allowed) {
          current.reason = decision.reason;
          if (['disabled', 'event-unselected', 'event-expired', 'invalid-event'].includes(decision.reason ?? '')) current.status = 'dismissed';
          return null;
        }
        if (state.automationTriggers.length >= PROACTIVE_TRIGGER_LIMIT) throw new Error('proactive.triggerCapacity');
        const time = new Date(now).toISOString();
        const trigger: AutomaticTrigger = { id: randomUUID(), key: triggerKey(current.id), kind: 'proactive', sourceId: current.id,
          dueAt: current.occurredAt, policyRevision: state.proactivePolicy.revision, status: 'reserved', jobId: null, messageId: null,
          createdAt: time, updatedAt: time, cancelledAt: null, errorCode: null };
        current.status = 'consumed'; current.reason = null; state.automationTriggers.push(trigger);
        return { trigger: structuredClone(trigger), event: structuredClone(current), policy: structuredClone(state.proactivePolicy) };
      });
      if (!reserved) continue;
      const decision = this.admission(reserved.trigger, 'submit');
      if (!decision.allowed || epoch !== this.#epoch) {
        await this.#cancelReserved(reserved.trigger.id, decision.reason ?? 'cancelled'); return;
      }
      try {
        const character = this.options.character?.(reserved.policy) ?? null;
        const providerId = reserved.policy.providerId!;
        const model = reserved.policy.model ?? this.options.defaultModel?.(providerId);
        if (!model) throw new Error('provider.unavailable');
        const job = await this.tasks.submit(reserved.trigger, {
          providerId, model, privacy: reserved.policy.privacy,
          instruction: '默认用自然的简体中文写一句简短、友善、可忽略的 DeskPet 主动问候。只输出中文问候正文，不附加英文译文。事件摘要、主题和角色示例可能是英文，它们的语言不决定输出语言。Write one brief, optional and friendly DeskPet check-in about the explicitly selected app event and optional topics below. Use only that supplied material. Do not claim observations of the screen, typing, apps, emotions or private history. Do not claim actions, demand a reply or guilt the user. No tools, personal memory lookup or data changes. If a character is supplied, write in that voice while keeping the check-in in Simplified Chinese. Output only the check-in.',
          material: JSON.stringify({ event: { kind: reserved.event.kind, summary: reserved.event.summary }, topics: reserved.policy.topics,
            ...(this.options.context ? { context: this.options.context(reserved.policy) } : {}), ...(character ? { character } : {}) }),
        });
        let cancelLate = false;
        await this.store.transaction((state) => {
          const current = state.automationTriggers.find((item) => item.id === reserved.trigger.id);
          if (!current) { cancelLate = true; return; }
          current.jobId = job.id; current.updatedAt = new Date(this.#now()).toISOString();
          const admission = this.#decision(state, current);
          if (!admission.allowed || epoch !== this.#epoch) {
            if (pending(current)) { current.status = 'cancelled'; current.cancelledAt = current.updatedAt; current.errorCode = `proactive.${admission.reason ?? 'cancelled'}`; }
            cancelLate = true;
          } else { current.status = 'submitted'; }
        });
        if (cancelLate && ['queued', 'dispatching', 'running'].includes(job.status)) await this.tasks.cancel(job.id);
      } catch (error) {
        // A submission rejection cannot establish that no request was ever sent.
        // Preserve the operation identity and never retry it automatically.
        await this.store.transaction((state) => {
          const trigger = state.automationTriggers.find((item) => item.id === reserved.trigger.id);
          if (trigger && pending(trigger)) {
            const job = this.tasks.getByOperation(trigger.id);
            trigger.jobId = job?.id ?? trigger.jobId; trigger.status = 'unknown';
            trigger.errorCode = backgroundFailureCode(error, 'proactive.submitUnconfirmed', ['automation.cancelled', 'automation.permissionRequired', 'automation.unavailable', 'job.privacyBlocked']);
            trigger.updatedAt = new Date(this.#now()).toISOString();
          }
        });
      }
      this.#changed();
      return; // At most one reservation/submission per host tick.
    }
  }
  async #cancelReserved(id: string, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const trigger = state.automationTriggers.find((item) => item.id === id);
      if (trigger && pending(trigger)) { trigger.status = 'cancelled'; trigger.cancelledAt = new Date(this.#now()).toISOString(); trigger.updatedAt = trigger.cancelledAt; trigger.errorCode = `proactive.${reason}`; }
    });
  }
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#revoke('proactive.shutdown');
    await this.#operation;
  }
}
