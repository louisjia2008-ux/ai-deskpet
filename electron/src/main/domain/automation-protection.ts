import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { defaultAutomationProactive, proactivePolicySchema, usageBudgetSchema } from '../../shared/automation-schemas';

const features = z.object({
  usageEvents: z.array(z.unknown()).default([]), usageRates: z.array(z.unknown()).default([]),
  usageBudget: usageBudgetSchema.default({ dailyRequestLimit: 100, dailyTokenLimit: 100_000 }),
  automationSchedules: z.array(z.unknown()).default([]), automationTriggers: z.array(z.unknown()).default([]),
  proactiveObservations: z.array(z.unknown()).default([]), attentionReceipts: z.array(z.unknown()).default([]),
  proactiveEvents: z.array(z.unknown()).default([]), proactivePolicy: proactivePolicySchema.default(defaultAutomationProactive),
}).passthrough();
/** A reset/old backup is not a merge of dispatch, cancellation or usage authority. */
export const hasAutomationProtection = (raw: unknown): boolean => {
  const parsed = features.safeParse(raw);
  if (!parsed.success) return true;
  const s = parsed.data;
  return s.usageEvents.length > 0 || s.usageRates.length > 0 || s.automationSchedules.length > 0 || s.automationTriggers.length > 0 || s.proactiveEvents.length > 0 || s.proactiveObservations.length > 0 || s.attentionReceipts.length > 0
    || s.usageBudget.dailyRequestLimit !== 100 || s.usageBudget.dailyTokenLimit !== 100_000
    || !isDeepStrictEqual(proactivePolicySchema.parse(s.proactivePolicy), proactivePolicySchema.parse(defaultAutomationProactive()));
};
const AUTHORITY_FIELDS = ['usageEvents', 'usageRates', 'usageBudget', 'automationSchedules', 'automationTriggers', 'proactiveObservations', 'attentionReceipts', 'proactiveEvents', 'proactivePolicy'] as const;
/** The restored profile takes these fields from `authority`, or starts them empty when it is unreadable. */
export const withAutomationAuthority = <T extends object>(incoming: T, authority: unknown): T => {
  const parsed = features.safeParse(authority ?? {});
  const source = parsed.success ? parsed.data : features.parse({});
  return { ...incoming, ...Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, source[field]])) };
};
