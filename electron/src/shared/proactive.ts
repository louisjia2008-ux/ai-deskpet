import { z } from 'zod';

export const proactiveConfigSchema = z.object({ enabled: z.boolean(), frequency: z.enum(['rare', 'occasional', 'frequent']) }).strict();
export type ProactiveConfig = z.infer<typeof proactiveConfigSchema>;
export const PROACTIVE_FREQUENCIES = {
  rare: { minMinutes: 60, maxMinutes: 120, dailyLimit: 3 },
  occasional: { minMinutes: 30, maxMinutes: 60, dailyLimit: 6 },
  frequent: { minMinutes: 10, maxMinutes: 20, dailyLimit: 12 },
} as const;
export const proactiveRecordSchema = proactiveConfigSchema.extend({
  nextAt: z.iso.datetime().nullable(), lastAttemptAt: z.iso.datetime().nullable(),
  day: z.string().max(10), attemptsToday: z.number().int().nonnegative(),
  sessionId: z.string().uuid().nullable(), lastMessageAt: z.iso.datetime().nullable(),
}).strict();
export const defaultProactiveRecord = (): z.infer<typeof proactiveRecordSchema> => ({
  enabled: false, frequency: 'occasional', nextAt: null, lastAttemptAt: null,
  day: '', attemptsToday: 0, sessionId: null, lastMessageAt: null,
});
export type ProactiveStatus = 'off' | 'inactive' | 'quiet' | 'focus' | 'busy' | 'hidden' | 'no-provider' | 'cooldown' | 'waiting' | 'generating' | 'error' | 'daily-limit';
export interface ProactiveState extends ProactiveConfig {
  status: ProactiveStatus;
  nextAt: string | null;
  attemptsToday: number;
  dailyLimit: number;
  sessionId: string | null;
  lastMessageAt: string | null;
}
