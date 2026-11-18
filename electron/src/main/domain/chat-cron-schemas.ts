import { z } from 'zod';
import { CHAT_CRON_CAPABILITIES } from '../../shared/chat-cron';
import { parseCronExpression, validateCronTimezone } from './cron-expression';
import { QQ_CHANNEL_POLICY_VERSION, qqCronApprovalSchema } from '../../shared/qq-channel';

const id = z.string().uuid(), timestamp = z.iso.datetime();
export const chatCronCapabilitiesSchema = z.array(z.enum(CHAT_CRON_CAPABILITIES)).max(CHAT_CRON_CAPABILITIES.length)
  .refine((values) => new Set(values).size === values.length, 'Duplicate scheduled capability.');
export const chatCronInputSchema = z.object({
  title: z.string().trim().min(1).max(240), instruction: z.string().trim().min(1).max(8000),
  expression: z.string().trim().min(1).max(256).refine((value) => { try { parseCronExpression(value); return true; } catch { return false; } }, 'Invalid numeric five-field cron expression.'),
  timezone: z.string().min(1).max(128).refine((value) => { try { validateCronTimezone(value); return true; } catch { return false; } }, 'Invalid IANA timezone.'),
  allowedCapabilities: chatCronCapabilitiesSchema, missedPolicy: z.enum(['skip', 'run-once']),
}).strict();
export const chatCronUpdateSchema = chatCronInputSchema.partial().extend({ allowedCapabilities: chatCronCapabilitiesSchema }).strict();
export const chatCronScheduleSchema = chatCronInputSchema.extend({
  id, sessionId: id, providerId: id, model: z.string().min(1).max(240), enabled: z.boolean(), revision: z.number().int().positive(),
  nextRunAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp, cancelledAt: timestamp.nullable(),
  telegramDelivery: z.object({ bindingId: id, revision: z.number().int().positive(), grantedAt: timestamp }).strict().optional(),
  qqDelivery: z.object({ bindingId: id, revision: z.number().int().positive(), grantedAt: timestamp }).strict().optional(),
  channel: z.object({ kind: z.literal('qq'), bindingId: z.string().min(1).max(128), senderId: z.string().min(1), policyVersion: z.literal([1, QQ_CHANNEL_POLICY_VERSION]), approval: qqCronApprovalSchema.optional() }).strict().optional(),
}).strict();
export const chatCronRunSchema = z.object({
  id, key: z.string().min(1).max(256), scheduleId: id, sessionId: id, scheduleRevision: z.number().int().positive(), dueAt: timestamp,
  status: z.enum(['reserved', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'missed']),
  createdAt: timestamp, startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), errorCode: z.string().max(240).nullable(),
}).strict();
