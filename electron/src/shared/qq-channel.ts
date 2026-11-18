import { z } from 'zod';

/** Host-owned state, encrypted with a separate channel vault outside profile
 * backups. Profile restore must explicitly invalidate this state as well. */

export const QQ_CHANNEL_POLICY_VERSION = 2;
export const QQ_CONTROL_PREFIX = '/';
export const QQ_PAIRING_COMMAND = /^\/pair\s+(\d{6})$/u;
export const QQ_MAX_MESSAGE_CHARACTERS = 8_000;

/** The OneBot token travels in this URL, so it must never leave the machine. */
export const isLoopbackOneBotUrl = (value: string): boolean => {
  try {
    const target = new URL(value);
    return target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port !== ''
      && !target.username && !target.password && !target.search && !target.hash && target.pathname === '/' && value.length <= 256;
  } catch { return false; }
};
export const QQ_TRANSPORTS = ['official', 'onebot'] as const;
export type QqTransportKind = typeof QQ_TRANSPORTS[number];
export const qqOneBotUrlSchema = z.string().trim().max(256).refine(value => value === '' || isLoopbackOneBotUrl(value), 'OneBot must use a loopback ws:// URL.');

export const qqChannelConfigSchema = z.object({
  enabled: z.boolean(),
  transport: z.enum(QQ_TRANSPORTS).default('official'),
  appId: z.string().trim(),
  onebotUrl: qqOneBotUrlSchema.default(''),
  providerId: z.string().uuid().nullable(),
  model: z.string().max(240).nullable(),
  dailyRequestLimit: z.number().int().min(1).max(1_000),
  webCallLimit: z.number().int().min(1).max(50),
  pairingCode: z.string().max(16).nullable(),
  pairingExpiresAt: z.string().max(40).nullable(),
}).strict();

export const qqBindingSchema = z.object({
  remindersAuthorityId: z.string().uuid().optional(),
  id: z.string().min(1).max(128),
  senderId: z.string().min(1),
  sessionId: z.string().uuid(),
  displayName: z.string().max(120),
  privateCareGrant: z.object({ id: z.string().uuid(), authorityId: z.string().uuid() }).strict().optional(),
  privateCareUsage: z.object({
    day: z.string().max(10), count: z.number().int().nonnegative(), lastAt: z.iso.datetime(),
    slots: z.array(z.enum(['morning', 'afternoon', 'evening'])).max(3),
  }).strict().optional(),
  boundAt: z.string().max(40),
}).strict();

export const qqAuthoritySchema = z.object({
  authorityId: z.string().uuid(),
  bindingId: z.string().min(1).max(128),
  senderId: z.string().min(1),
  sessionId: z.string().uuid(),
}).strict();
export type QqAuthority = z.infer<typeof qqAuthoritySchema>;

/** Accepted owner messages live in the encrypted channel store. A running
 * attempt is never replayed after restart; only undispatched queued work runs. */
export const QQ_MAX_QUEUED_MESSAGES = 8;
export const QQ_MAX_INBOUND_RECORDS = 64;
export const qqInboundQueueItemSchema = z.object({
  id: z.string().uuid(), messageId: z.string().min(1), authority: qqAuthoritySchema,
  content: z.string().max(QQ_MAX_MESSAGE_CHARACTERS),
  providerId: z.string().uuid().nullable(), model: z.string().max(240).nullable(),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'cancelled', 'interrupted']),
  reservedDate: z.string().max(10), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().refine(item => !['queued', 'running', 'paused'].includes(item.status) || item.content.length > 0);
export type QqInboundQueueItem = z.infer<typeof qqInboundQueueItemSchema>;

/** Stable managed-asset references only. Image bytes never enter the outbox. */
export const qqReplyImageSchema = z.object({
  assetId: z.string().regex(/^[a-f0-9]{64}$/u),
  alt: z.string().trim().min(1).max(240),
}).strict();
export type QqReplyImage = z.infer<typeof qqReplyImageSchema>;

export const qqCronInputSchema = z.object({
  title: z.string().min(1).max(240), instruction: z.string().min(1).max(4_000),
  expression: z.string().min(1).max(256), timezone: z.string().min(1).max(128),
  allowedCapabilities: z.array(z.enum(['web.search', 'web.read', 'math.calculate', 'time.read'])).max(4),
  missedPolicy: z.literal('skip'),
}).strict();
export const qqCronApprovalSchema = z.object({
  version: z.literal(1), authorityId: z.string().uuid(),
  providerDigest: z.string().regex(/^[a-f0-9]{64}$/u), credentialRef: z.string().uuid(),
  permissionSessionId: z.string().uuid(), permissionRevisions: z.record(z.string().max(128), z.number().int().nonnegative()),
  webCallLimit: z.number().int().min(1).max(50),
  modelCallLimit: z.literal(4), outputTokenLimit: z.literal(2048), runtimeLimitMs: z.literal(120_000),
  confirmationId: z.string().uuid(),
}).strict();
export const qqCronOperationSchema = z.object({
  version: z.literal(1), action: z.enum(['create', 'update', 'resume']), authority: qqAuthoritySchema,
  owner: z.object({ sessionId: z.string().uuid(), providerId: z.string().uuid(), model: z.string().min(1).max(240) }).strict(),
  scheduleId: z.string().uuid(), expectedRevision: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  input: qqCronInputSchema, approval: qqCronApprovalSchema,
}).strict();
export type QqCronApproval = z.infer<typeof qqCronApprovalSchema>;
export type QqCronOperation = z.infer<typeof qqCronOperationSchema>;

export const qqPairingCandidateSchema = z.object({
  id: z.string().uuid(), senderId: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();

/** Each group is its own session and authority: no private history, memory, tasks or files. */
export const QQ_MAX_GROUPS = 5;
export const QQ_GROUP_DAILY_LIMIT = 30;
const QQ_GROUP_SENDER_PREFIX = 'group:';
export const qqGroupSender = (groupId: string): string => `${QQ_GROUP_SENDER_PREFIX}${groupId}`;
export const qqGroupIdFromSender = (senderId: string): string | null => senderId.startsWith(QQ_GROUP_SENDER_PREFIX) ? senderId.slice(QQ_GROUP_SENDER_PREFIX.length) : null;
export const qqGroupSchema = z.object({
  id: z.string().uuid(), groupId: z.string().min(1), ownerMemberId: z.string().min(1),
  sessionId: z.string().uuid(), openToMembers: z.boolean(), titleMigrated: z.boolean().default(false), boundAt: z.string().max(40),
}).strict();
export const qqGroupCandidateSchema = z.object({
  id: z.string().uuid(), groupId: z.string().min(1), senderId: z.string().min(1), expiresAt: z.iso.datetime(),
}).strict();

const EMPTY_REPLY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const qqOutboxItemSchema = z.object({
  /** Present only on host-created one-time private reminders, never on passive replies. */
  reminderDueAt: z.iso.datetime().optional(),
  reminderSourceMessageSHA256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** Only used to restate a delayed creation receipt against its original deadline. */
  reminderReceipt: z.object({ reminderId: z.string().uuid(), label: z.string().min(1).max(120), dueAt: z.iso.datetime() }).strict().optional(),
  id: z.string().uuid(),
  authority: qqAuthoritySchema,
  kind: z.enum(['reply', 'cron', 'system', 'care']),
  runId: z.string().uuid().nullable(),
  assistantMessageId: z.string().uuid().nullable(),
  scheduleId: z.string().uuid().nullable().optional(),
  scheduleRevision: z.number().int().positive().nullable().optional(),
  confirmationId: z.string().uuid().nullable().optional(),
  /** A transient owner decision for this live run; never resumed after restart. */
  webBudgetRunId: z.string().uuid().optional(),
  content: z.string().min(1).max(8_000),
  attachment: qqReplyImageSchema.optional(),
  /** The text bubble must have a confirmed receipt before its optional picture. */
  afterMessageId: z.string().uuid().optional(),
  /** One passive private image reply with no companion text bubble. */
  standaloneImage: z.literal(true).optional(),
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  replyTo: z.string().min(1).nullable(),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown', 'discarded']),
  attempts: z.number().int().nonnegative().max(99),
  createdAt: z.string().max(40),
  lastAttemptAt: z.string().max(40).nullable(),
  errorCode: z.string().max(120).nullable(),
}).strict().refine(item => {
  if (!item.attachment) return item.afterMessageId === undefined && item.standaloneImage === undefined;
  if (!['reply', 'cron'].includes(item.kind) || item.runId === null || item.assistantMessageId === null
    || item.sourceSHA256 === undefined || item.content !== item.attachment.alt) return false;
  if (item.kind === 'cron') return !item.standaloneImage && item.afterMessageId !== undefined
    && !!item.scheduleId && !!item.scheduleRevision && qqGroupIdFromSender(item.authority.senderId) === null;
  if (!item.standaloneImage) return item.afterMessageId !== undefined;
  return item.afterMessageId === undefined && item.replyTo !== null && item.sourceSHA256 === EMPTY_REPLY_SHA256
    && qqGroupIdFromSender(item.authority.senderId) === null
    && item.scheduleId === undefined && item.scheduleRevision === undefined && item.confirmationId === undefined
    && item.webBudgetRunId === undefined && item.reminderDueAt === undefined && item.reminderReceipt === undefined
    && item.reminderSourceMessageSHA256 === undefined;
}, { message: 'Image outbox entries require source provenance and a linked text reply or private inbound reply.' });

export const qqConfirmationSchema = z.object({
  id: z.string().uuid(),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operation: qqCronOperationSchema,
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  noticeId: z.string().uuid(),
  runId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative().max(5),
}).strict();

export const qqChannelStateSchema = z.object({
  version: z.literal(2),
  profileId: z.string().uuid().nullable(),
  authorityId: z.string().uuid(),
  config: qqChannelConfigSchema,
  binding: qqBindingSchema.nullable(),
  pairingCandidate: qqPairingCandidateSchema.nullable(),
  pairingAttempts: z.number().int().min(0).max(5),
  processedMessageIds: z.array(z.string().min(1)).max(1_024),
  inboundQueue: z.array(qqInboundQueueItemSchema).max(QQ_MAX_INBOUND_RECORDS).default([]),
  outbox: z.array(qqOutboxItemSchema).max(200),
  confirmations: z.array(qqConfirmationSchema).max(20).default([]),
  dailyUsage: z.object({ date: z.string().max(10), requests: z.number().int().nonnegative() }).strict(),
  groups: z.array(qqGroupSchema).max(QQ_MAX_GROUPS).default([]),
  groupCandidate: qqGroupCandidateSchema.nullable().default(null),
  groupPairing: z.object({ code: z.string().max(16), expiresAt: z.iso.datetime(), attempts: z.number().int().min(0).max(5) }).strict().nullable().default(null),
  groupUsage: z.object({ date: z.string().max(10), requests: z.number().int().nonnegative() }).strict().default({ date: '', requests: 0 }),
  stopped: z.boolean(),
  lastError: z.string().max(200).nullable(),
}).strict();

export type QqChannelConfig = z.infer<typeof qqChannelConfigSchema>;
export type QqBinding = z.infer<typeof qqBindingSchema>;
export type QqOutboxItem = z.infer<typeof qqOutboxItemSchema>;
export type QqChannelState = z.infer<typeof qqChannelStateSchema>;

export const defaultQqChannelState = (): QqChannelState => qqChannelStateSchema.parse({
  version: 2,
  profileId: null,
  authorityId: globalThis.crypto.randomUUID(),
  config: { enabled: false, appId: '', providerId: null, model: null, dailyRequestLimit: 50, webCallLimit: 10, pairingCode: null, pairingExpiresAt: null },
  binding: null,
  pairingCandidate: null,
  pairingAttempts: 0,
  processedMessageIds: [],
  outbox: [],
  confirmations: [],
  dailyUsage: { date: '', requests: 0 },
  stopped: false,
  lastError: null,
});

/** Surface shown to the console renderer. Never includes secrets. */
/** Why the last message from an unbound sender did not pair. Never holds its text. */
/** Names and counts only: this never holds message content or who sent it. */
export interface QqGatewayEvent { type: string; count: number; lastAt: string; delivered: number; lowSequence: number; lastDrop: string | null }
export type QqPairingIssue = 'no-active-code' | 'wrong-format' | 'wrong-code' | 'attempts-exhausted';
export interface QqChannelStatus {
  privateBindingId?: string | null;
  privateCareEnabled?: boolean;
  privateCareResult?: 'sent' | 'offline' | 'quiet' | 'frequency' | 'setup' | 'unknown' | 'failed';
  privateRemindersEnabled?: boolean;
  enabled: boolean;
  stopped: boolean;
  connection: 'disabled' | 'connecting' | 'online' | 'offline';
  transport: QqTransportKind;
  /** The endpoint for the selected transport: AppID or OneBot URL. */
  appIdConfigured: boolean;
  appId: string;
  onebotUrl: string;
  secretConfigured: boolean;
  bound: boolean;
  bindingDisplayName: string | null;
  pairingCandidate: { id: string; senderId: string; expiresAt: string } | null;
  pairingIssue: QqPairingIssue | null;
  groupPairingIssue: QqPairingIssue | null;
  gatewayEvents: QqGatewayEvent[];
  groups: Array<{ id: string; groupId: string; openToMembers: boolean }>;
  groupCandidate: { id: string; groupId: string; expiresAt: string } | null;
  groupRequests: number;
  groupDailyLimit: number;
  providerId: string | null;
  model: string | null;
  dailyRequests: number;
  dailyRequestLimit: number;
  webCallLimit: number;
  pendingOutbox: number;
  failedOutbox: number;
  uncertainOutbox: number;
  lastPrivatePush: { status: QqOutboxItem['status']; at: string; errorCode: string | null } | null;
  lastError: string | null;
}

export type QqConfigureInput = Partial<Pick<QqChannelConfig,
  'enabled' | 'transport' | 'appId' | 'onebotUrl' | 'providerId' | 'model' | 'dailyRequestLimit' | 'webCallLimit'>> & { appSecret?: string | null };

export interface QqPrivateImageTestResult {
  status: 'sent' | 'failed' | 'unknown';
  title: string;
  error: string | null;
}

export interface QqChannelAPI {
  sendPrivateImageTest(expectedBindingId: string): Promise<QqPrivateImageTestResult>;
  setPrivateCare(expectedBindingId: string, enabled: boolean): Promise<QqChannelStatus>;
  sendPrivateCareNow(expectedBindingId: string): Promise<QqChannelStatus>;
  setPrivateReminders(bindingId: string, enabled: boolean): Promise<QqChannelStatus>;
  getState(): Promise<QqChannelStatus>;
  configure(input: QqConfigureInput): Promise<QqChannelStatus>;
  startPairing(): Promise<{ code: string; expiresAt: string }>;
  confirmPairing(candidateId: string): Promise<QqChannelStatus>;
  stop(): Promise<QqChannelStatus>;
  unbind(): Promise<QqChannelStatus>;
  retryDeliveries(): Promise<void>;
  /** Also send a desktop schedule's results to the bound private chat. */
  setCronDelivery(input: { scheduleId: string; expectedBindingId: string | null; expectedRevision: number; enabled: boolean }): Promise<void>;
  startGroupPairing(): Promise<{ code: string; expiresAt: string }>;
  confirmGroupPairing(candidateId: string): Promise<QqChannelStatus>;
  setGroupOpen(groupId: string, openToMembers: boolean): Promise<QqChannelStatus>;
  removeGroup(groupId: string): Promise<QqChannelStatus>;
}
