import { z } from 'zod';
import { wechatGroupIdSchema } from './wechat-channel';

export const MEDIA_MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MEDIA_MAX_ASSETS = 2000;
export const mediaAssetIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const mediaMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const mediaSettingsSchema = z.object({
  providerId: z.string().uuid().nullable(), model: z.string().min(1).max(120),
  autoReplyDesktop: z.boolean(), autoReplyQq: z.boolean(),
  cooldownSeconds: z.number().int().min(30).max(86400).default(300),
}).strict();
export const defaultMediaSettings = (): MediaSettings => ({ providerId: null, model: 'gpt-image-2', autoReplyDesktop: false, autoReplyQq: false, cooldownSeconds: 300 });
const wechatGroups = z.array(wechatGroupIdSchema).max(12).refine(groups => new Set(groups).size === groups.length);
export const mediaAssetSchema = z.object({
  id: mediaAssetIdSchema, sha256: mediaAssetIdSchema, title: z.string().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(40)).max(30), enabled: z.boolean(), allowQq: z.boolean(),
  allowWechat: z.boolean().optional(), allowWechatGroups: wechatGroups.optional(),
  mime: mediaMimeSchema, extension: z.enum(['png', 'jpg', 'webp', 'gif']), bytes: z.number().int().positive().max(MEDIA_MAX_ASSET_BYTES),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  source: z.object({ kind: z.enum(['imported', 'generated']), name: z.string().max(240), model: z.string().max(120).optional(), prompt: z.string().max(4000).optional() }).strict(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), deletedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(), useCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.id === value.sha256, 'Media identity must match content hash.');
export const mediaLibrarySchema = z.object({
  assets: z.array(mediaAssetSchema).max(MEDIA_MAX_ASSETS), settings: mediaSettingsSchema,
  recentUses: z.array(z.object({ assetId: mediaAssetIdSchema, sessionId: z.string().min(1).max(160), at: z.iso.datetime() }).strict()).max(300),
}).strict();
export const defaultMediaLibrary = (): MediaLibraryState => ({ assets: [], settings: defaultMediaSettings(), recentUses: [] });
export const mediaUpdateSchema = z.object({
  id: mediaAssetIdSchema, title: z.string().trim().min(1).max(160).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(), enabled: z.boolean().optional(), allowQq: z.boolean().optional(),
  allowWechat: z.boolean().optional(), allowWechatGroups: wechatGroups.optional(),
}).strict();
export const mediaGenerateSchema = z.object({ providerId: z.string().uuid(), model: z.string().min(1).max(120), prompt: z.string().trim().min(1).max(4000) }).strict();
export const chatImageAttachmentSchema = z.object({ assetId: mediaAssetIdSchema, alt: z.string().max(240) }).strict();
export type MediaAsset = z.infer<typeof mediaAssetSchema> & { url?: string };
export type MediaSettings = z.infer<typeof mediaSettingsSchema>;
export type MediaLibraryState = z.infer<typeof mediaLibrarySchema>;
export type MediaUpdate = z.infer<typeof mediaUpdateSchema>;
export type MediaGenerateInput = z.infer<typeof mediaGenerateSchema>;
export type ChatImageAttachment = z.infer<typeof chatImageAttachmentSchema>;
export interface MediaSnapshot { assets: MediaAsset[]; settings: MediaSettings }
export interface MediaImportResult { imported: MediaAsset[]; reused: number; skipped: number }
export interface MediaAPI {
  snapshot(): Promise<MediaSnapshot>;
  importImages(): Promise<MediaImportResult | null>;
  importFolder(): Promise<MediaImportResult | null>;
  update(input: MediaUpdate): Promise<MediaAsset>;
  remove(id: string): Promise<void>;
  restore(id: string): Promise<MediaAsset>;
  configure(input: MediaSettings): Promise<MediaSettings>;
  generate(input: MediaGenerateInput): Promise<MediaAsset>;
  attach(input: { sessionId: string; assetId: string }): Promise<void>;
  onChanged?(listener: () => void): () => void;
}
export const mediaAssetUrl = (asset: Pick<MediaAsset, 'id' | 'extension'>): string => `deskpet://managed/reply-images/${asset.id}.${asset.extension}`;
