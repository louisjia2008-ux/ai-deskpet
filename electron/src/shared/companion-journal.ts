import { z } from 'zod';

export const companionPreferencesSchema = z.object({
  frequency: z.enum(['few', 'normal', 'more']), destination: z.enum(['desktop', 'wechat', 'both']),
  wechatVoice: z.boolean(), diaryEnabled: z.boolean(),
}).strict();
export type CompanionPreferences = z.infer<typeof companionPreferencesSchema>;
export const defaultCompanionPreferences = (): CompanionPreferences => ({ frequency: 'normal', destination: 'desktop', wechatVoice: false, diaryEnabled: false });
export const diaryEntrySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), text: z.string().trim().min(1).max(6000), summary: z.string().trim().max(600),
  revision: z.number().int().positive(), edited: z.boolean(), createdAt: z.iso.datetime(),
  sources: z.array(z.object({ id: z.string(), digest: z.string() }).strict()).max(120),
  memories: z.array(z.object({ id: z.string(), revision: z.number().int().positive() }).strict()).max(30),
}).strict();
export type DiaryEntry = z.infer<typeof diaryEntrySchema>;
export interface CompanionJournalAPI {
  preferences(): Promise<CompanionPreferences>; configure(value: CompanionPreferences): Promise<CompanionPreferences>;
  list(): Promise<DiaryEntry[]>; edit(input: { date: string; revision: number; text: string }): Promise<void>;
  remove(input: { date: string; revision: number }): Promise<void>;
}
