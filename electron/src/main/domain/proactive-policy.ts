import { defaultAutomationProactive, proactivePolicyInputSchema, timezoneSchema } from '../../shared/automation-schemas';
import { proactiveMode } from '../../shared/automation';
import type {
  ProactiveObservation, AutomaticTrigger, ProactiveEnvironment, ProactiveEvent, ProactiveEventKind, ProactivePolicy, ProactivePolicyInput,
} from '../../shared/automation';

export const PROACTIVE_EVENT_KINDS: readonly ProactiveEventKind[] = ['task-completed', 'focus-completed', 'explicit-check-in'];
export const PROACTIVE_EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
export const PROACTIVE_EVENT_LIMIT = 1000;
export const PROACTIVE_TRIGGER_LIMIT = 2000;
export const PROACTIVE_OBSERVATION_LIMIT = 200;
export type ProactiveBlockReason = 'disabled' | 'policy-changed' | 'cancelled' | 'event-unselected' | 'invalid-event'
  | 'event-expired' | 'clock-before-event' | 'quiet' | 'cooldown' | 'daily-limit' | 'suspended' | 'locked'
  | 'busy' | 'hidden' | 'permission' | 'no-provider' | 'closed' | 'observation-only';
export interface ProactiveAdmission { allowed: boolean; reason: ProactiveBlockReason | null }

export const defaultEventProactivePolicy = defaultAutomationProactive;
export const validProactiveTimezone = (timezone: string): boolean => timezoneSchema.safeParse(timezone).success;
/** One canonical validator shared by renderer IPC and host policy, without permission defaults. */
export const validateProactivePolicyInput = (input: ProactivePolicyInput): ProactivePolicyInput => {
  const parsed = proactivePolicyInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('proactive.invalidPolicy');
  return parsed.data;
};

const localParts = (now: number, timezone: string): { day: string; minute: number } => {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
};
const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const isProactiveQuiet = (policy: Pick<ProactivePolicy, 'timezone' | 'quietStart' | 'quietEnd'>, now: number): boolean => {
  const minute = localParts(now, policy.timezone).minute, start = minutes(policy.quietStart), end = minutes(policy.quietEnd);
  // Equal endpoints explicitly mean no quiet interval; no implicit all-day lock.
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
};
export const proactiveDayKey = (now: number, timezone: string): string => localParts(now, timezone).day;
export const proactiveMinuteOfDay = (now: number, timezone: string): number => localParts(now, timezone).minute;

export interface ProactiveAdmissionInput {
  policy: ProactivePolicy;
  event: ProactiveEvent;
  triggers: readonly AutomaticTrigger[];
  environment: ProactiveEnvironment;
  now: number;
  excludeTriggerId?: string;
  purpose?: 'execute' | 'observe';
}

/** Pure fixed-event policy. The same predicate must run at submit, fetch and publish. */
export const evaluateProactiveAdmission = ({ policy, event, triggers, environment, now, excludeTriggerId, purpose = 'execute' }: ProactiveAdmissionInput): ProactiveAdmission => {
  const no = (reason: ProactiveBlockReason): ProactiveAdmission => ({ allowed: false, reason });
  const mode = proactiveMode(policy);
  if (mode === 'off') return no('disabled');
  if (purpose === 'execute' && mode !== 'auto') return no('observation-only');
  if (!policy.eventKinds.includes(event.kind)) return no('event-unselected');
  const eventTime = Date.parse(event.occurredAt);
  if (!Number.isFinite(now) || !Number.isFinite(eventTime) || !event.id || event.summary.length > 500) return no('invalid-event');
  if (now < eventTime) return no('clock-before-event');
  if (now - eventTime > PROACTIVE_EVENT_MAX_AGE_MS) return no('event-expired');
  if (purpose === 'execute' && !environment.permission) return no('permission');
  if (environment.suspended) return no('suspended');
  if (environment.locked) return no('locked');
  // Asking for a check-in right now is the owner's own request, not an interruption.
  const askedNow = event.id.startsWith('explicit:');
  if (!askedNow && isProactiveQuiet(policy, now)) return no('quiet');
  if (!askedNow && environment.fullscreen) return no('busy');
  const lastInteraction = Date.parse(environment.lastInteractionAt ?? '');
  if (!askedNow && Number.isFinite(lastInteraction)) {
    if (now - lastInteraction < 2 * 3_600_000) return no('cooldown');
    const unanswered = triggers.filter(trigger => trigger.id !== excludeTriggerId && trigger.kind === 'proactive'
      && !trigger.sourceId.startsWith('explicit:') && trigger.publishedAt && Date.parse(trigger.publishedAt) > lastInteraction)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = unanswered[0];
    if (first) {
      const today = proactiveDayKey(now, policy.timezone), firstDay = proactiveDayKey(Date.parse(first.createdAt), policy.timezone);
      // One unanswered greeting today. On later days at most one gentle retry, never a burst.
      if (firstDay === today || unanswered.length >= 2 || unanswered.some(trigger => proactiveDayKey(Date.parse(trigger.createdAt), policy.timezone) === today)) return no('cooldown');
    }
  }
  if (!environment.visible) return no('hidden');
  if (environment.busy) return no('busy');
  if (purpose === 'execute' && (policy.providerId === null || policy.model === '')) return no('no-provider');
  const reservations = triggers.filter((trigger) => trigger.kind === 'proactive' && trigger.id !== excludeTriggerId);
  const today = proactiveDayKey(now, policy.timezone);
  // Reservation counts survive cancellation/failure and app restarts. Usage is
  // still charged independently only from observed request receipts.
  if (reservations.filter((trigger) => proactiveDayKey(Date.parse(trigger.createdAt), policy.timezone) === today).length >= policy.dailyLimit) return no('daily-limit');
  const latest = reservations.reduce((time, trigger) => Math.max(time, Date.parse(trigger.createdAt)), -Infinity);
  if (!askedNow && now - latest < policy.cooldownMinutes * 60_000) return no('cooldown');
  return { allowed: true, reason: null };
};

/** Local rule preview only. Observed matches simulate frequency without reserving
 * an execution trigger or granting provider/automation permission. */
export const evaluateProactiveObservation = (input: ProactiveAdmissionInput & { observations: readonly ProactiveObservation[] }): ProactiveAdmission => {
  const simulated = input.observations.filter((entry) => entry.decision === 'would-act').map<AutomaticTrigger>((entry) => ({
    id: entry.id, key: `observation:${entry.eventId}`, kind: 'proactive', sourceId: entry.eventId,
    dueAt: entry.occurredAt, policyRevision: entry.policyRevision, status: 'cancelled', jobId: null, messageId: null,
    createdAt: entry.observedAt, updatedAt: entry.observedAt, cancelledAt: entry.observedAt, errorCode: 'proactive.observationOnly',
  }));
  return evaluateProactiveAdmission({ ...input, purpose: 'observe', triggers: [...input.triggers, ...simulated] });
};
