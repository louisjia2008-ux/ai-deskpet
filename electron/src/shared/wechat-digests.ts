import { z } from 'zod';
import { wechatCloudRouteSchema } from './wechat-channel';

export const wechatDigestGroupIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const wechatDigestTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const wechatDigestKeywordSchema = z.string().trim().min(1).max(80)
  .refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
export const wechatDigestGroupSettingsSchema = z.strictObject({
  time: wechatDigestTimeSchema.default('21:30'),
  groups: z.array(z.strictObject({ id: wechatDigestGroupIdSchema, cloud: z.boolean().default(true) })).max(12)
    .refine(groups => new Set(groups.map(group => group.id)).size === groups.length),
  provider: wechatCloudRouteSchema.nullable(),
  keywords: z.array(wechatDigestKeywordSchema).max(16),
});

export type WeChatDigestGroupSettings = z.infer<typeof wechatDigestGroupSettingsSchema>;
export const defaultWeChatDigestGroupSettings = (): WeChatDigestGroupSettings => ({
  time: '21:30', groups: [], provider: null, keywords: [],
});
export const wechatOfficialAccountIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const wechatOfficialBriefSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  time: wechatDigestTimeSchema.default('08:30'),
  limit: z.number().int().min(1).max(12).default(5),
  accountIds: z.array(wechatOfficialAccountIdSchema).max(250)
    .refine(ids => new Set(ids).size === ids.length).nullable().default(null),
  keywords: z.array(wechatDigestKeywordSchema).max(16).default([]),
  cloud: z.boolean().default(false),
  provider: wechatCloudRouteSchema.nullable().default(null),
}).refine(value => !value.enabled || value.accountIds === null || value.accountIds.length > 0);
export type WeChatOfficialBriefSettings = z.infer<typeof wechatOfficialBriefSettingsSchema>;
export const defaultWeChatOfficialBriefSettings = (): WeChatOfficialBriefSettings => ({
  enabled: false, time: '08:30', limit: 5, accountIds: null, keywords: [], cloud: false, provider: null,
});
export const wechatFriendsMomentsSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  cloud: z.boolean().default(true),
  time: wechatDigestTimeSchema.default('20:00'),
  cadence: z.enum(['daily', 'weekly']).default('daily'),
  weekday: z.number().int().min(0).max(6).default(0),
  provider: wechatCloudRouteSchema.nullable().default(null),
});
export type WeChatFriendsMomentsSettings = z.infer<typeof wechatFriendsMomentsSettingsSchema>;
export const defaultWeChatFriendsMomentsSettings = (): WeChatFriendsMomentsSettings => ({
  enabled: false, cloud: true, time: '20:00', cadence: 'daily', weekday: 0, provider: null,
});
export interface WeChatDigestGroupState {
  settings: WeChatDigestGroupSettings;
  groups: { id: string; title: string; replying?: true | undefined }[];
  providers: { id: string; name: string; model: string }[];
  available: boolean;
}
export interface WeChatGroupDigestResult {
  at: number;
  entries: { title: string; summary: string; detail: string }[];
  delivery: string;
}
export interface WeChatOfficialBriefState {
  settings: WeChatOfficialBriefSettings;
  accounts: { id: string; title: string }[];
  providers: { id: string; name: string; model: string }[];
  available: boolean;
}
export interface WeChatFriendsMomentsState {
  settings: WeChatFriendsMomentsSettings;
  providers: { id: string; name: string; model: string }[];
  available: boolean;
}
export interface WeChatDigestsAPI {
  getGroupSettings(): Promise<WeChatDigestGroupState>;
  setGroupSettings(settings: WeChatDigestGroupSettings): Promise<void>;
  groupResults(): Promise<WeChatGroupDigestResult[]>;
  getOfficialSettings(): Promise<WeChatOfficialBriefState>;
  setOfficialSettings(settings: WeChatOfficialBriefSettings): Promise<void>;
  getFriendsMomentsSettings(): Promise<WeChatFriendsMomentsState>;
  setFriendsMomentsSettings(settings: WeChatFriendsMomentsSettings): Promise<void>;
}
