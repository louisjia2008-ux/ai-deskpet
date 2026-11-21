import { z } from 'zod';
import type { ProactivePolicy } from './automation';
import { proactiveMode } from './automation';
const id = z.string().uuid();
const timestamp = z.iso.datetime();
export const timezoneSchema = z.string().min(1).max(128).refine((s) => { try { new Intl.DateTimeFormat('en', { timeZone: s }).format(0); return true; } catch { return false; } }, 'Use an IANA time zone.');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const calendarRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: timestamp }).strict(),
  z.object({ kind: z.literal('daily'), time }).strict(),
  z.object({ kind: z.literal('weekly'), time, weekday: z.number().int().min(0).max(6) }).strict(),
]);
export const persistentScheduleInputSchema = z.object({
  id, title: z.string().trim().min(1).max(240), instruction: z.string().trim().min(1).max(32_000), material: z.string().max(32_000),
  privacy: z.enum(['local-only', 'cloud-allowed']), providerId: id, model: z.string().min(1).max(240).nullable().default(null),
  rule: calendarRuleSchema, timezone: timezoneSchema, missedPolicy: z.enum(['skip', 'run-once']), enabled: z.boolean(),
}).strict();
export const persistentScheduleSchema = persistentScheduleInputSchema.extend({ revision: z.number().int().positive(), createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp.nullable(), cancelledAt: timestamp.nullable() }).strict();
export const automaticTriggerSchema = z.object({
  id, key: z.string().min(1).max(512), kind: z.enum(['schedule', 'proactive']), sourceId: z.string().min(1).max(256), dueAt: timestamp,
  policyRevision: z.number().int().positive(), status: z.enum(['reserved', 'submitted', 'missed', 'cancelled', 'blocked', 'unknown', 'succeeded', 'failed']),
  publishedAt: timestamp.nullable().optional(),
  jobId: id.nullable(), messageId: id.nullable(), createdAt: timestamp, updatedAt: timestamp, cancelledAt: timestamp.nullable(), errorCode: z.string().max(240).nullable(),
}).strict();
const proactivePolicyBaseSchema = z.object({
  enabled: z.boolean(), mode: z.enum(['off', 'observe', 'auto']).optional(), eventKinds: z.array(z.enum(['task-completed', 'focus-completed', 'explicit-check-in'])).max(3).refine((v) => new Set(v).size === v.length),
  quietStart: time, quietEnd: time, timezone: timezoneSchema,
  cooldownMinutes: z.number().int().min(1).max(10080), dailyLimit: z.number().int().min(1).max(12),
  topics: z.array(z.string().trim().min(1).max(120)).max(8).transform((v) => [...new Set(v)]),
  privacy: z.enum(['local-only', 'cloud-allowed']), providerId: z.string().min(1).max(128).nullable(), model: z.string().trim().max(240).nullable(),
}).strict();
const consistentProactiveMode = (value: { enabled: boolean; mode?: 'off' | 'observe' | 'auto' | undefined }): boolean => value.mode === undefined || value.enabled === (value.mode === 'auto');
export const proactivePolicyInputSchema = proactivePolicyBaseSchema
  .refine(consistentProactiveMode, 'Only auto mode may enable model execution.')
  .refine((value) => proactiveMode(value) !== 'auto' || (value.providerId !== null && value.model !== '' && value.eventKinds.length > 0), 'Choose events and a provider before enabling auto mode.')
  .refine((value) => proactiveMode(value) !== 'observe' || value.eventKinds.length > 0, 'Choose at least one app event to observe.');
export const proactivePolicySchema = proactivePolicyBaseSchema.extend({revision:z.number().int().positive()}).strict().refine(consistentProactiveMode, 'Inconsistent proactive execution mode.');
export const defaultAutomationProactive = (): ProactivePolicy => ({ enabled: false, revision: 1, eventKinds: [], quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC', cooldownMinutes: 120, dailyLimit: 2, topics: [], privacy: 'local-only', providerId: null, model: '' });
export const proactiveEventSchema = z.object({ id: z.string().min(1).max(256), kind: z.enum(['task-completed', 'focus-completed', 'explicit-check-in']), occurredAt: timestamp, summary: z.string().max(2000), status: z.enum(['pending', 'consumed', 'dismissed']), reason: z.string().max(240).nullable(),
  observation: z.object({ observedAt: timestamp, policyRevision: z.number().int().positive(), matched: z.boolean() }).strict().optional(),
}).strict();
export const proactiveObservationSchema = z.object({
  id: z.string().min(1).max(256), eventId: z.string().min(1).max(128), kind: z.enum(['task-completed', 'focus-completed', 'explicit-check-in']),
  summary: z.string().max(500), occurredAt: timestamp, observedAt: timestamp, policyRevision: z.number().int().positive(),
  decision: z.enum(['would-act', 'would-skip']),
  reason: z.enum(['rules-matched', 'disabled', 'event-unselected', 'invalid-event', 'event-expired', 'clock-before-event', 'quiet', 'cooldown', 'daily-limit', 'suspended', 'locked', 'busy', 'hidden', 'permission', 'no-provider', 'closed', 'cancelled', 'policy-changed', 'observation-only']),
}).strict();
export const usageBudgetSchema = z.object({ dailyRequestLimit: z.number().int().min(0).max(1000), dailyTokenLimit: z.number().int().min(0).max(10_000_000) }).strict();
const usagePrice = z.number().finite().nonnegative().max(1_000_000);
const usagePriceFields = {
  inputPerMillion: usagePrice, outputPerMillion: usagePrice,
  cachedInputPerMillion: usagePrice.nullable().optional(), cacheWriteInputPerMillion: usagePrice.nullable().optional(),
};
export const usageLongContextPriceSchema = z.object({ inputThreshold: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ...usagePriceFields }).strict();
export const usagePriceSnapshotSchema = z.object({
  currency: z.enum(['USD', 'CNY']), ...usagePriceFields, longContext: usageLongContextPriceSchema.optional(),
  source: z.enum(['reference', 'provider-api', 'manual']), sourceUrl: z.string().url().max(2048).optional(),
  checkedAt: timestamp, endpoint: z.string().min(1).max(2048), note: z.string().max(1000).optional(),
}).strict();
export const usageRateTargetSchema = z.object({ providerId: id, model: z.string().trim().min(1).max(240)
  .refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'Use an exact model ID without control characters.') }).strict();
export const usageRateInputSchema = usageRateTargetSchema.extend({ currency: z.enum(['USD', 'CNY']), ...usagePriceFields, longContext: usageLongContextPriceSchema.optional() }).strict();
export const usageRateSchema = z.union([
  z.object({ providerId: id, model: z.string().min(1).max(240), inputUSDPerMillion: usagePrice, outputUSDPerMillion: usagePrice, updatedAt: timestamp }).strict(),
  z.object({ providerId: id, model: z.string().min(1).max(240), price: usagePriceSnapshotSchema, updatedAt: timestamp }).strict(),
]);
export const usageEventSchema = z.object({
  requestId: id, ownerId: z.string().min(1).max(256), scope: z.enum(['chat', 'background-job', 'delegation', 'consolidation', 'schedule', 'proactive', 'other']), batchId: z.string().max(256).nullable(),
  providerId: id, model: z.string().max(240), preparedAt: timestamp, dispatchedAt: timestamp.nullable(), terminalAt: timestamp.nullable(),
  phase: z.enum(['prepared', 'fetch-invoked', 'response-received', 'terminal']), outcome: z.enum(['completed', 'failed', 'aborted']).nullable(),
  inputEstimate: z.number().int().nonnegative(), maxOutputTokens: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
  tokenSource: z.enum(['provider-reported', 'unknown']), reportedCostUSD: z.number().finite().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  tokenDetailsInvalid: z.boolean().optional(),
  endpoint: z.string().min(1).max(2048).optional(), priceSnapshot: usagePriceSnapshotSchema.nullable().optional(),
  pricingUnavailableReason: z.enum(['missing-rate', 'endpoint-mismatch', 'invalid-rate']).optional(),
}).strict();
