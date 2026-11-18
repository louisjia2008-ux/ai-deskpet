import { z } from 'zod';

const platformId = z.string().min(1);
const uuid = z.string().uuid();
const authoritySchema = z.object({ bindingId: uuid, sessionId: uuid, userId: platformId, chatId: platformId }).strict();
export type TelegramAuthority = z.infer<typeof authoritySchema>;
export interface TelegramRunInput extends TelegramAuthority {
  runId: string;
  text: string;
  /** Provenance of current message text, used only for note creation authorization. */
  noteIntentAllowed?: true | undefined;
  signal: AbortSignal;
  providerId: string | null;
  model: string | null;
  memoryAllowed: boolean;
}
export interface TelegramReply {
  content: string;
  sourceId: string;
  requiresApproval?: boolean;
}
export interface TelegramDelivery extends TelegramAuthority {
  content: string;
  sourceId: string;
  digest: string;
  approved: boolean;
  kind: 'reply' | 'cron';
}
const diagnosticSchema = z
  .object({
    at: z.iso.datetime(),
    type: z.string(),
    outcome: z.enum(['accepted', 'rejected']),
    field: z.string().nullable(),
  })
  .strict();
export type TelegramDiagnostic = z.infer<typeof diagnosticSchema>;
const candidateSchema = z
  .object({ id: uuid, userId: platformId, chatId: platformId, displayName: z.string(), expiresAt: z.iso.datetime() })
  .strict();
export type TelegramPairingCandidate = z.infer<typeof candidateSchema>;
export interface TelegramConfigureInput {
  token?: string | null | undefined;
  enabled?: boolean | undefined;
  model?: string | null | undefined;
  providerId?: string | null | undefined;
  memoryAllowed?: boolean | undefined;
}
export interface TelegramChannelStatus {
  enabled: boolean;
  bound: boolean;
  bindingId: string | null;
  secretConfigured: boolean;
  bindingDisplayName: string | null;
  bindingSessionId: string | null;
  connection: 'disabled' | 'connecting' | 'online' | 'offline';
  providerId: string | null;
  model: string | null;
  memoryAllowed: boolean;
  pairingCandidate: TelegramPairingCandidate | null;
  diagnostics: TelegramDiagnostic[];
  lastError: string | null;
  pendingInbox: number;
  pendingOutbox: number;
  uncertainOutbox: number;
}
export interface TelegramPendingResult {
  id: string;
  reference: string;
  kind: 'reply' | 'cron';
  sourceId: string;
  digest: string;
  content: string;
}
export interface TelegramChannelAPI {
  pendingResults(): Promise<TelegramPendingResult[]>;
  getState(): Promise<TelegramChannelStatus>;
  configure(input: TelegramConfigureInput): Promise<TelegramChannelStatus>;
  startPairing(): Promise<{ code: string; expiresAt: string }>;
  confirmPairing(candidateId: string): Promise<TelegramChannelStatus>;
  setCronDelivery(input: {
    scheduleId: string;
    expectedRevision: number;
    expectedBindingId: string | null;
    enabled: boolean;
  }): Promise<void>;
  unbind(): Promise<TelegramChannelStatus>;
  retryDeliveries(): Promise<TelegramChannelStatus>;
}

const inboxSchema = z
  .object({
    runId: uuid,
    text: z.string(),
    noteIntentAllowed: z.literal(true).optional(),
    authority: authoritySchema,
    status: z.enum(['queued', 'running', 'appending']),
  })
  .strict();
const outboxSchema = z
  .object({
    id: uuid,
    authority: authoritySchema,
    kind: z.enum(['control', 'reply', 'cron']),
    content: z.string().min(1),
    sourceId: z.string().nullable(),
    digest: z.string(),
    approved: z.boolean(),
    approvalId: uuid.nullable(),
    status: z.enum(['approval', 'pending', 'sending', 'failed', 'unknown', 'sent', 'discarded']),
    sentChars: z.number().int().nonnegative(),
    error: z.string().nullable(),
    retryAt: z.number().nullable(),
    attempts: z.number().int().nonnegative(),
    buttons: z.object({ id: uuid }).nullable(),
  })
  .strict();
export type TelegramOutbox = z.infer<typeof outboxSchema>;
const approvalSchema = z
  .object({
    id: uuid,
    authority: authoritySchema,
    kind: z.enum(['workspace', 'disclose']),
    runId: uuid.nullable(),
    outboxId: uuid.nullable(),
    digest: z.string().nullable(),
    expiresAt: z.number(),
  })
  .strict();
export const telegramStateSchema = z
  .object({
    version: z.literal(1),
    tokenConfigured: z.boolean().default(false),
    profileId: z.string().nullable(),
    enabled: z.boolean(),
    providerId: uuid.nullable(),
    model: z.string().nullable(),
    memoryAllowed: z.boolean(),
    botId: platformId.nullable(),
    binding: authoritySchema.extend({ displayName: z.string() }).nullable(),
    pairing: z.object({ hash: z.string(), expiresAt: z.iso.datetime(), attempts: z.number().int().nonnegative() }).nullable(),
    candidate: candidateSchema.nullable(),
    offset: z.number().int().nonnegative().nullable(),
    lastUpdateAt: z.number().nullable(),
    inbox: z.array(inboxSchema),
    outbox: z.array(outboxSchema),
    approvals: z.array(approvalSchema),
    diagnostics: z.array(diagnosticSchema),
  })
  .strict();
export type TelegramState = z.infer<typeof telegramStateSchema>;
export const defaultTelegramState = (): TelegramState => ({
  version: 1,
  tokenConfigured: false,
  profileId: null,
  enabled: false,
  providerId: null,
  model: null,
  memoryAllowed: false,
  botId: null,
  binding: null,
  pairing: null,
  candidate: null,
  offset: null,
  lastUpdateAt: null,
  inbox: [],
  outbox: [],
  approvals: [],
  diagnostics: [],
});
