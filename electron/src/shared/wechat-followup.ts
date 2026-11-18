import { z } from 'zod';
import { wechatCloudRouteSchema } from './wechat-channel';
import { wechatDigestGroupIdSchema, wechatDigestTimeSchema } from './wechat-digests';

const followupId = z.string().regex(/^[a-f0-9]{64}$/u);
const epochMs = z.number().int().min(0).max(8_640_000_000_000_000);

export const wechatFollowupSettingsSchema = z.strictObject({
  time: wechatDigestTimeSchema.default('21:30'),
  waitMinutes: z.number().int().min(5).max(1440).default(60),
  groups: z.array(z.strictObject({ id: wechatDigestGroupIdSchema, cloud: z.boolean().default(false) })).max(12)
    .refine(groups => new Set(groups.map(group => group.id)).size === groups.length),
  provider: wechatCloudRouteSchema.nullable().default(null),
});
export type WeChatFollowupSettings = z.infer<typeof wechatFollowupSettingsSchema>;
export const defaultWeChatFollowupSettings = (): WeChatFollowupSettings => ({ time: '21:30', waitMinutes: 60, groups: [], provider: null });

export const wechatFollowupItemSchema = z.strictObject({
  id: followupId,
  groupTitle: z.string().trim().min(1).max(256),
  at: epochMs,
  summary: z.string().trim().min(1).max(400),
  detail: z.string().trim().max(1_600),
  deadline: z.string().trim().min(1).max(160).nullable(),
  snoozedUntil: epochMs.nullable(),
});
export type WeChatFollowupItem = z.infer<typeof wechatFollowupItemSchema>;

export const wechatFollowupActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ id: followupId, action: z.literal('done') }),
  z.strictObject({ id: followupId, action: z.literal('snooze'), minutes: z.number().int().min(5).max(10_080) }),
]);
export type WeChatFollowupAction = z.infer<typeof wechatFollowupActionSchema>;

export interface WeChatFollowupSettingsState {
  settings: WeChatFollowupSettings;
  groups: { id: string; title: string }[];
  providers: { id: string; name: string; model: string }[];
  available: boolean;
}

export interface WeChatFollowupAPI {
  getSettings(): Promise<WeChatFollowupSettingsState>;
  configure(settings: WeChatFollowupSettings): Promise<void>;
  list(): Promise<WeChatFollowupItem[]>;
  act(action: WeChatFollowupAction): Promise<void>;
}
