import { z } from 'zod';

export const wechatInboxIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const wechatInboxQuerySchema = z.string().trim().max(160);
const clean = (value: string): boolean => !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
const link = z.string().max(500).refine(value => {
  if (!clean(value) || !/^https?:\/\//iu.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
});

export const wechatInboxInputSchema = z.strictObject({
  kind: z.enum(['article', 'link', 'file', 'image', 'forward', 'quote']),
  title: z.string().trim().min(1).max(160).refine(clean),
  source: z.string().trim().max(160).refine(clean),
  at: z.number().int().nonnegative().max(8_640_000_000_000_000),
  summary: z.string().trim().max(1800).refine(value => clean(value.replace(/[\n\t]/gu, ''))),
  url: link.optional(),
  fileRef: wechatInboxIdSchema.optional(),
  legacyId: wechatInboxIdSchema.optional(),
});
export const wechatInboxItemSchema = wechatInboxInputSchema.extend({ id: wechatInboxIdSchema });

export type WeChatInboxInput = z.infer<typeof wechatInboxInputSchema>;
export type WeChatInboxItem = z.infer<typeof wechatInboxItemSchema>;
export interface WeChatInboxAPI {
  list(query: string): Promise<WeChatInboxItem[]>;
  remove(id: string): Promise<void>;
  getExport(): Promise<boolean>;
  setExport(enabled: boolean): Promise<void>;
}
