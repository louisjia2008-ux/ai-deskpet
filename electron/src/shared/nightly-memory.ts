// The stored shape of the retired rule-based nightly organization. Profiles written by
// earlier versions still carry it, so it is read and kept, but nothing uses it any more.
import { z } from 'zod';
import { timezoneSchema } from './automation-schemas';

export const nightlySettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoSave: z.boolean().optional(),
    hour: z.number().int().min(0).max(23),
    timezone: timezoneSchema,
  })
  .strict();
export type NightlyMemorySettings = z.infer<typeof nightlySettingsSchema>;
export const nightlySourceSchema = z
  .object({
    sessionId: z.string().uuid(),
    messageId: z.string().uuid(),
    contentSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type NightlySource = z.infer<typeof nightlySourceSchema>;
const reportSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    at: z.iso.datetime(),
    excerpts: z.array(nightlySourceSchema).max(32),
    suggestions: z.array(nightlySourceSchema).max(16),
    autoSaved: z
      .array(nightlySourceSchema.extend({ memoryId: z.string().uuid(), revision: z.number().int().positive() }))
      .max(16)
      .default([]),
    mergedDuplicates: z.number().int().nonnegative().default(0),
    duplicateGroups: z
      .array(
        z
          .array(
            z.object({
              id: z.string().uuid(),
              revision: z.number().int().positive(),
            }),
          )
          .min(2)
          .max(16),
      )
      .max(16),
  })
  .strict();
export const nightlyStoreSchema = z
  .object({
    settings: nightlySettingsSchema,
    enabledSince: z.iso.datetime().nullable(),
    lastRunAt: z.iso.datetime().nullable(),
    lastDay: z.string().nullable(),
    reports: z.array(reportSchema).max(7),
  })
  .strict();
export type NightlyStore = z.infer<typeof nightlyStoreSchema>;
export function defaultNightlyStore(): NightlyStore {
  return {
    settings: { enabled: false, hour: 23, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    enabledSince: null,
    lastRunAt: null,
    lastDay: null,
    reports: [],
  };
}
