import { describe, expect, it } from 'vitest';
import type { AutomaticTrigger, ProactiveEnvironment, ProactiveEvent, ProactivePolicy } from '../../shared/automation';
import { defaultEventProactivePolicy, evaluateProactiveAdmission, isProactiveQuiet, validateProactivePolicyInput } from './proactive-policy';

const now = Date.parse('2026-10-29T12:00:00.000Z');
const policy = (patch: Partial<ProactivePolicy> = {}): ProactivePolicy => ({ ...defaultEventProactivePolicy(), enabled: true,
  eventKinds: ['task-completed'], providerId: 'provider', model: 'synthetic', ...patch });
const event = (patch: Partial<ProactiveEvent> = {}): ProactiveEvent => ({ id: 'task:event:1', kind: 'task-completed',
  occurredAt: new Date(now).toISOString(), summary: 'Synthetic task completed', status: 'pending', reason: null, ...patch });
const environment: ProactiveEnvironment = { suspended: false, locked: false, busy: false, visible: true, permission: true };
const trigger = (id: string, at: number): AutomaticTrigger => ({ id, key: `proactive:${id}`, kind: 'proactive', sourceId: id,
  dueAt: new Date(at).toISOString(), policyRevision: 1, status: 'cancelled', jobId: null, messageId: null,
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), cancelledAt: new Date(at).toISOString(), errorCode: null });
const admit = (patch: Partial<Parameters<typeof evaluateProactiveAdmission>[0]> = {}) => evaluateProactiveAdmission({
  policy: policy(), event: event(), triggers: [], environment, now, ...patch,
});

describe('finite explicit-event policy', () => {
  it('waits two hours after chatting, suppresses unanswered same-day greetings and permits only one next-day retry', () => {
    const lastInteractionAt = '2026-10-29T08:00:00.000Z';
    const env = { ...environment, lastInteractionAt };
    expect(admit({ environment: { ...env, lastInteractionAt: new Date(now - 7_199_999).toISOString() } }).reason).toBe('cooldown');
    expect(admit({ environment: env }).allowed).toBe(true);
    expect(admit({ environment: { ...env, fullscreen: true } }).reason).toBe('busy');
    const first = { ...trigger('first', now - 3 * 3_600_000), publishedAt: new Date(now - 3 * 3_600_000).toISOString() };
    expect(admit({ environment: env, triggers: [first] }).reason).toBe('cooldown');
    const tomorrow = now + 86_400_000, next = { now: tomorrow, event: event({ occurredAt: new Date(tomorrow).toISOString() }), environment: env };
    expect(admit({ ...next, triggers: structuredClone([first]) }).allowed).toBe(true);
    const retry = { ...trigger('retry', tomorrow - 3 * 3_600_000), publishedAt: new Date(tomorrow - 3 * 3_600_000).toISOString() };
    expect(admit({ ...next, triggers: [first, retry] }).reason).toBe('cooldown');
    expect(admit({ ...next, now: tomorrow + 86_400_000, event: event({ occurredAt: new Date(tomorrow + 86_400_000).toISOString() }), triggers: [first, retry] }).reason).toBe('cooldown');
  });
  it('defaults to no event collection or permission and rejects unknown policy fields', () => {
    expect(defaultEventProactivePolicy()).toMatchObject({ enabled: false, eventKinds: [], privacy: 'local-only' });
    const { revision, ...input } = policy(); void revision;
    expect(() => validateProactivePolicyInput({ ...input, screenshotPermission: true } as typeof input)).toThrow('proactive.invalidPolicy');
    expect(() => validateProactivePolicyInput({ ...input, dailyLimit: 13 })).toThrow('proactive.invalidPolicy');
    expect(() => validateProactivePolicyInput({ ...input, timezone: 'Unavailable/Timezone' })).toThrow('proactive.invalidPolicy');
  });
  it('uses local wall time for a midnight-crossing quiet interval', () => {
    const p = policy({ timezone: 'Asia/Shanghai' });
    expect(isProactiveQuiet(p, Date.parse('2026-10-29T15:00:00Z'))).toBe(true);
    expect(isProactiveQuiet(p, Date.parse('2026-10-30T00:00:00Z'))).toBe(false);
    expect(isProactiveQuiet({ ...p, quietStart: '08:00', quietEnd: '08:00' }, now)).toBe(false);
  });
  it('keeps both repeated fall-DST hours quiet and ends at the selected wall boundary', () => {
    const p = policy({ timezone: 'America/New_York', quietStart: '01:30', quietEnd: '02:30' });
    expect(isProactiveQuiet(p, Date.parse('2026-11-01T05:45:00Z'))).toBe(true);
    expect(isProactiveQuiet(p, Date.parse('2026-11-01T06:45:00Z'))).toBe(true);
    expect(isProactiveQuiet(p, Date.parse('2026-11-01T07:30:00Z'))).toBe(false);
  });
  it.each(['permission', 'suspended', 'locked', 'busy', 'visible'] as const)('blocks environment %s at admission', (key) => {
    const blocked = { ...environment, [key]: key === 'permission' || key === 'visible' ? false : true };
    expect(admit({ environment: blocked }).allowed).toBe(false);
  });
  it('requires a selected event and a nonfuture event younger than 24 hours', () => {
    expect(admit({ event: event({ kind: 'focus-completed' }) }).reason).toBe('event-unselected');
    expect(admit({ event: event({ occurredAt: new Date(now + 1).toISOString() }) }).reason).toBe('clock-before-event');
    expect(admit({ event: event({ occurredAt: new Date(now - 86_400_001).toISOString() }) }).reason).toBe('event-expired');
  });
  it('counts failed/cancelled reservations against cooldown and daily quota across restarts', () => {
    expect(admit({ triggers: [trigger('cancelled-attempt', now - 1)] }).reason).toBe('cooldown');
    expect(admit({ policy: policy({ dailyLimit: 1 }), triggers: [trigger('cancelled-attempt', now - 3_600_000)] }).reason).toBe('daily-limit');
  });
  it('excludes only the current request at fetch/publish, not a different reservation', () => {
    const own = trigger('own', now);
    expect(admit({ policy: policy({ dailyLimit: 1 }), triggers: [own], excludeTriggerId: own.id }).allowed).toBe(true);
    expect(admit({ policy: policy({ dailyLimit: 1 }), triggers: [own, trigger('another', now)], excludeTriggerId: own.id }).reason).toBe('daily-limit');
  });
  it('resets the local calendar-day quota at the selected timezone boundary without dropping cooldown', () => {
    const at = Date.parse('2026-10-29T16:00:00.000Z');
    expect(admit({ now: at, event: event({ occurredAt: new Date(at).toISOString() }), policy: policy({ timezone: 'Asia/Shanghai',
      quietStart: '00:00', quietEnd: '00:00', dailyLimit: 1, cooldownMinutes: 1 }), triggers: [trigger('previous-day', at - 60_000)] }).allowed).toBe(true);
  });
});

describe('explicit execution mode compatibility', () => {
  it('keeps legacy disabled policy off and legacy enabled policy automatic', () => {
    expect(admit({ policy: policy({ enabled: false }) }).reason).toBe('disabled');
    expect(admit({ policy: policy() }).allowed).toBe(true);
  });
  it('allows observe without a provider but never admits it for execution', () => {
    const { revision, ...input } = policy({ enabled: false, mode: 'observe', providerId: null, model: '' }); void revision;
    expect(validateProactivePolicyInput(input)).toMatchObject({ mode: 'observe', enabled: false });
    expect(admit({ policy: { ...input, revision: 1 } }).reason).toBe('observation-only');
    expect(() => validateProactivePolicyInput({ ...input, enabled: true })).toThrow('proactive.invalidPolicy');
    expect(() => validateProactivePolicyInput({ ...input, mode: 'auto', enabled: true })).toThrow('proactive.invalidPolicy');
    expect(() => validateProactivePolicyInput({ ...input, eventKinds: [] })).toThrow('proactive.invalidPolicy');
  });
});
