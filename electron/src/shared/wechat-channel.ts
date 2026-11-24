import { z } from 'zod';
import { wechatSendReasonSchema } from './wechat-send-diagnostics';

export const wechatGroupPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('sender'), sender: z.string().trim().min(1).max(160)
    .refine(value => [...value].length <= 80 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) }).strict(),
  z.object({ mode: z.enum(['mentions', 'all', 'off']), sender: z.null() }).strict(),
]);

const statusCode = z.string().regex(/^[a-z0-9_.-]{1,64}$/u).nullable();
const count = z.number().int().min(0).max(1_000_000);
export const WECHAT_REPLY_GROUP_LIMIT = 12;
export const WECHAT_REPLY_FRIEND_LIMIT = 20;
export const WECHAT_OWNER_PLAIN_TEXT_LIMIT = 1_000;
export const isWeChatOwnerTextWithinLimit = (text: string): boolean =>
  !/\p{Cs}/u.test(text) && [...text].length <= WECHAT_OWNER_PLAIN_TEXT_LIMIT;
export const WECHAT_FRIEND_REPLY_RATE = { perFriendMinute: 4, perFriendDay: 60, allFriendsHour: 120 } as const;
export const wechatGroupIdSchema = z.string().regex(/^(?:legacy|[a-f0-9]{32})$/u);
export const wechatFriendIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
export const wechatFriendRosterIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const wechatModelSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
export const wechatReplySchema = z.object({ model: wechatModelSchema, split: z.boolean(), stickers: z.boolean() }).strict();
export const wechatGroupUpdateSchema = z.object({ groupId: wechatGroupIdSchema, policy: wechatGroupPolicySchema }).strict();
const cloudModelSchema = z.string().trim().min(1).max(240).refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
export const wechatPinnedCloudRouteSchema = z.strictObject({ providerId: z.string().uuid(), model: cloudModelSchema });
export const wechatCloudRouteSchema = wechatPinnedCloudRouteSchema.extend({ model: cloudModelSchema.nullable().default(null) });
export const wechatCloudSettingsSchema = z.object({
  private: wechatCloudRouteSchema.nullable(),
  groups: z.record(wechatGroupIdSchema, wechatCloudRouteSchema).refine(groups => Object.keys(groups).length <= 12),
}).strict();
export const wechatFriendCloudRoutesSchema = z.record(wechatFriendIdSchema, wechatCloudRouteSchema)
  .refine(friends => Object.keys(friends).length <= WECHAT_REPLY_FRIEND_LIMIT);
export const wechatFriendCloudUpdateSchema = z.strictObject({ friendId: wechatFriendIdSchema, route: wechatCloudRouteSchema.nullable() });
/** Owner private chat runs DeskPet's full chat loop when a cloud model is selected.
 * `memories: 'all'` lets that chat use every memory the model may receive. */
/** `moments`: prepare at most one Moments draft a day; nothing posts without the owner's WeChat reply. */
export const wechatAssistantSchema = z.object({ enabled: z.boolean(), memories: z.enum(['all', 'selected']), moments: z.boolean().default(false), richCloud: z.boolean().optional(), forwardCloud: z.boolean().optional() }).strict();
/** How freely the assistant answers in one group; `extra` holds the owner's own lines. */
export const wechatGroupRuleLevelSchema = z.enum(['relaxed', 'standard', 'strict']);
export const wechatGroupRuleSchema = z.object({
  level: wechatGroupRuleLevelSchema,
  extra: z.string().max(500).refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.replace(/\n/gu, ''))),
  /** Members may have it search and read public web pages (at most three calls a reply). */
  web: z.boolean().default(false),
}).strict();
export const wechatGroupRulesSchema = z.record(wechatGroupIdSchema, wechatGroupRuleSchema).refine(rules => Object.keys(rules).length <= 12);
export const wechatGroupRuleUpdateSchema = z.object({ groupId: wechatGroupIdSchema, rule: wechatGroupRuleSchema }).strict();
export const wechatCloudStateSchema = z.object({
  available: z.boolean(),
  assistant: wechatAssistantSchema,
  groupRules: wechatGroupRulesSchema,
  providers: z.array(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(240), model: cloudModelSchema }).strict()),
  settings: wechatCloudSettingsSchema.extend({ friends: wechatFriendCloudRoutesSchema.optional() }),
}).strict();
export const wechatWindowSchema = z.object({ outcome: z.enum([
  'restored', 'already_open', 'login_required', 'unavailable', 'ambiguous_window', 'layout_changed', 'tray_hidden',
]) }).strict();
export const wechatChannelStateSchema = z.object({
  configured: z.boolean(),
  groupName: z.string().min(1).max(256).nullable(),
  state: z.enum(['starting', 'running', 'paused', 'degraded', 'stopped']),
  stale: z.boolean(),
  paused: z.boolean(),
  privateStatus: statusCode,
  sendReason: wechatSendReasonSchema.nullable().catch(null).optional(),
  groupStatus: statusCode,
  pending: count,
  uncertain: count,
  /** Messages given up on in the last day, so one failure could not hold the rest; and when the latest was (unix seconds). */
  dropped: count.optional(),
  droppedAt: z.number().positive().nullable().optional(),
  /** Owner messages in the last day of a kind the listener cannot answer, by kind only (image, quote…). */
  skipped: count.optional(),
  skippedAt: z.number().positive().nullable().optional(),
  skippedKinds: z.array(z.string().regex(/^[a-z0-9_.-]{1,64}$/u)).max(12).optional(),
  groupPolicy: wechatGroupPolicySchema,
  groups: z.array(z.object({
    id: wechatGroupIdSchema, title: z.string().min(1).max(256), policy: wechatGroupPolicySchema,
    status: statusCode, pending: count, uncertain: count,
  }).strict()).max(WECHAT_REPLY_GROUP_LIMIT),
  groupBindingSupported: z.boolean(),
  replyTargetBindingSupported: z.boolean().optional(),
  friendReplySupported: z.boolean().optional(),
  friendStatuses: z.array(z.strictObject({
    status: z.enum(['ready', 'checking', 'paused', 'friend_rate_limited', 'friend_send_uncertain', 'friend_binding_invalid',
      'friend_database_unavailable', 'friend_reply_unavailable']), pending: count, uncertain: count,
  })).max(20).optional(),
  reply: wechatReplySchema,
}).strict();

export type WeChatGroupPolicy = z.infer<typeof wechatGroupPolicySchema>;
export type WeChatChannelState = z.infer<typeof wechatChannelStateSchema>;
export type WeChatReply = z.infer<typeof wechatReplySchema>;
export type WeChatGroupUpdate = z.infer<typeof wechatGroupUpdateSchema>;
export type WeChatWindow = z.infer<typeof wechatWindowSchema>;
export type WeChatCloudRoute = z.infer<typeof wechatCloudRouteSchema>;
export type WeChatPinnedCloudRoute = z.infer<typeof wechatPinnedCloudRouteSchema>;
export type WeChatCloudSettings = z.infer<typeof wechatCloudSettingsSchema>;
export type WeChatCloudState = z.infer<typeof wechatCloudStateSchema>;
export type WeChatAssistant = z.infer<typeof wechatAssistantSchema>;
export type WeChatGroupRuleLevel = z.infer<typeof wechatGroupRuleLevelSchema>;
export type WeChatGroupRule = z.infer<typeof wechatGroupRuleSchema>;
export type WeChatGroupRuleUpdate = z.infer<typeof wechatGroupRuleUpdateSchema>;
export interface WeChatReplyGroupCandidate { id: string; title: string }
export interface WeChatReplyFriend { id: string; title: string }
export type WeChatFriendCloudUpdate = z.infer<typeof wechatFriendCloudUpdateSchema>;

export interface WeChatChannelAPI {
  getState(): Promise<WeChatChannelState>;
  configureGroup(input: WeChatGroupUpdate): Promise<WeChatChannelState>;
  listReplyGroups(): Promise<WeChatReplyGroupCandidate[]>;
  addReplyGroup(id: string): Promise<WeChatChannelState>;
  getReplyFriends(): Promise<WeChatReplyFriend[]>;
  listReplyFriends(): Promise<WeChatReplyFriend[]>;
  addReplyFriend(id: string): Promise<WeChatReplyFriend[]>;
  removeReplyFriend(id: string): Promise<WeChatReplyFriend[]>;
  bindSelectedGroup(): Promise<WeChatChannelState>;
  removeGroup(id: string): Promise<WeChatChannelState>;
  getModels(): Promise<string[]>;
  configureReply(input: WeChatReply): Promise<WeChatChannelState>;
  getCloud(): Promise<WeChatCloudState>;
  configureCloud(input: WeChatCloudSettings): Promise<WeChatCloudState>;
  configureFriendCloud(input: WeChatFriendCloudUpdate): Promise<WeChatCloudState>;
  configureAssistant(input: WeChatAssistant): Promise<WeChatCloudState>;
  configureGroupRule(input: WeChatGroupRuleUpdate): Promise<WeChatCloudState>;
  recoverWindow(): Promise<WeChatWindow>;
  openVirtualMachine(): Promise<void>;
  setPaused(paused: boolean): Promise<WeChatChannelState>;
}
