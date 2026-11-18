import { z } from 'zod';

const printable = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value));
const forwardEntrySchema = z.strictObject({
  kind: z.enum(['text', 'image', 'voice', 'video', 'link', 'location', 'file', 'forward', 'attachment']),
  text: printable(320).optional(), speaker: printable(48).optional(), at: printable(48).optional(), shortened: z.literal(true).optional(),
}).refine(row => (row.kind === 'text') === (row.text !== undefined) && (!row.shortened || row.kind === 'text'));
export const wechatForwardRecordSchema = z.strictObject({ entries: z.array(forwardEntrySchema).max(80), truncated: z.boolean() })
  .refine(record => record.truncated || (record.entries.length > 0 && record.entries.every(row => !row.shortened)));
export type WeChatForwardRecord = z.infer<typeof wechatForwardRecordSchema>;

export const wechatRichSchema = z.strictObject({
  kind: z.enum(['quote', 'forward', 'link', 'image', 'file', 'location', 'card', 'miniprogram', 'video', 'transfer', 'redpacket']),
  evidence: z.string().max(1800),
  url: z.string().max(500).regex(/^https?:\/\//iu).optional(),
  title: z.string().min(1).max(160).optional(),
  fileExt: z.string().regex(/^[a-z0-9]{1,16}$/u).optional(),
  fileBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  forwardKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  record: wechatForwardRecordSchema.optional(),
}).refine(value => (value.kind === 'link') === (value.url !== undefined)
  && (value.kind === 'file' || (value.fileExt === undefined && value.fileBytes === undefined))
  && (value.kind === 'forward' ? (value.record === undefined) === (value.forwardKey === undefined) : value.record === undefined)
  && (value.kind === 'forward' || value.kind === 'quote' || value.forwardKey === undefined));
export type WeChatRich = z.infer<typeof wechatRichSchema>;
