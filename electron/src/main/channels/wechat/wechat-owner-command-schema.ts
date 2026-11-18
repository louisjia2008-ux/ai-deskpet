import { z } from 'zod';

export const wechatOwnerDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.number().int().nonnegative().max(8_640_000_000_000_000);
const recurrence = z.object({ expression: z.string().min(1).max(256), timezone: z.string().min(1).max(100) }).strict();
const delivery = z.object({ id: wechatOwnerDigest, dueAt: date, status: z.enum(['pending', 'uncertain']) }).strict();

export const wechatScheduledTaskAuthoritySchema = z.object({
  providerId: z.uuid(), providerDigest: wechatOwnerDigest, credentialRef: z.uuid(), model: z.string().min(1).max(160),
  destination: z.enum(['local', 'remote']), routeFingerprint: wechatOwnerDigest, permissionFingerprint: wechatOwnerDigest,
}).strict();
const taskTiming = z.discriminatedUnion('kind', [
  recurrence.extend({ kind: z.literal('recurring') }),
  z.object({ kind: z.literal('once'), delayMs: z.number().int().min(10_000).max(86_400_000) }).strict(),
]);
const taskSpec = z.object({
  id: wechatOwnerDigest, binding: wechatOwnerDigest, instruction: z.string().min(1).max(290),
  timing: taskTiming, authority: wechatScheduledTaskAuthoritySchema,
}).strict();
const taskOutcome = z.enum(['sent', 'missed', 'interrupted', 'failed', 'authority_changed', 'restored']);
const taskRun = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('running'), id: z.uuid(), deliveryId: wechatOwnerDigest }).strict(),
  z.object({ phase: z.enum(['ready', 'delivering', 'uncertain']), id: z.uuid(), deliveryId: wechatOwnerDigest,
    text: z.string().min(1).max(1_000) }).strict(),
]);

export const wechatOwnerCommandsSchema = z.object({
  receipts: z.array(z.object({
    id: wechatOwnerDigest, binding: wechatOwnerDigest, textDigest: wechatOwnerDigest, reply: z.string().min(1).max(1_000),
  }).strict()).max(1_024),
  reminders: z.array(z.object({
    id: wechatOwnerDigest, binding: wechatOwnerDigest, label: z.string().min(1).max(240),
    dueAt: date, recurrence: recurrence.nullable(), delivery: delivery.nullable(),
    state: z.enum(['active', 'sent', 'cancelled', 'expired']),
  }).strict()).max(200),
  taskDrafts: z.array(taskSpec.extend({
    code: z.string().regex(/^[a-f0-9]{12}$/u), expiresAt: date,
  })).max(20).default([]),
  tasks: z.array(taskSpec.extend({
    dueAt: date, state: z.enum(['active', 'completed', 'cancelled', 'blocked']),
    run: taskRun.nullable(), outcome: taskOutcome.nullable(), lastFinishedAt: date.nullable(),
  })).max(200).default([]),
}).strict();

export type WeChatOwnerCommandState = z.infer<typeof wechatOwnerCommandsSchema>;
export type WeChatScheduledTaskAuthority = z.infer<typeof wechatScheduledTaskAuthoritySchema>;
export const sameWeChatScheduledTaskAuthority = (a: WeChatScheduledTaskAuthority | null, b: WeChatScheduledTaskAuthority): boolean =>
  a !== null && a.providerId === b.providerId && a.providerDigest === b.providerDigest && a.credentialRef === b.credentialRef
  && a.model === b.model && a.destination === b.destination && a.routeFingerprint === b.routeFingerprint
  && a.permissionFingerprint === b.permissionFingerprint;
export const defaultWeChatOwnerCommands = (): WeChatOwnerCommandState => ({ receipts: [], reminders: [], taskDrafts: [], tasks: [] });
