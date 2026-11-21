import { defaultNightlyStore, nightlyStoreSchema } from '../../shared/nightly-memory';
import { desktopExtensionsSchema } from '../../shared/desktop-extensions';
import { chatWorkTaskSchema } from './chat-work-schemas';
import { researchTaskSchema } from '../../shared/research-tasks';
import { chatCronScheduleSchema, chatCronRunSchema } from './chat-cron-schemas';
import { automaticTriggerSchema, defaultAutomationProactive, persistentScheduleSchema, proactiveEventSchema, proactiveObservationSchema, proactivePolicySchema, usageBudgetSchema, usageEventSchema, usageRateSchema, timezoneSchema } from '../../shared/automation-schemas';
import { consolidationCandidateSchema } from '../../shared/consolidation';
import { requirementsSchema, checkResultSchema } from '../../shared/delegation-checks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultProactiveRecord, proactiveRecordSchema } from '../../shared/proactive';
import { speakingStyleSchema } from '../../shared/conversation-import';
import { contextPrivacySchema, contextScopeSchema } from '../../shared/schemas';
import { MAX_OUTPUT_TOKENS } from '../../shared/output-limits';
import { chatImageAttachmentSchema, defaultMediaLibrary, mediaLibrarySchema } from '../../shared/media';
import { defaultWeChatOwnerCommands, wechatOwnerCommandsSchema } from '../channels/wechat/wechat-owner-command-schema';

import { companionRecentSchema, defaultCompanionRecent } from './companion-recent-state';

const id = z.string().uuid();
export const defaultMemorySleep = () => ({ settings: { enabled: true, hour: 3, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
  lastDay: null as string | null, lastRunAt: null as string | null, reports: [] as never[], recallReplacements: {} });
const timestamp = z.iso.datetime();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const memoryReferenceSchema = z.object({ id, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const contextTraceSchema = z.object({
  knowledgePolicyToken: sha256.optional(),
  wechatDigestUntil: timestamp.optional(),
  recentRevision: sha256.optional(),
  diaryReferences: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), revision: z.number().int().positive(), summarySHA256: sha256 }).strict()).max(366).optional(),
  version: z.literal(1),
  representationReferences: z.array(z.object({ batchId: id, candidateVersion: z.number().int().positive() }).strict()).max(300).optional(),
  representationDecisions: z.array(z.object({ batchId: id, candidateVersion: z.number().int().nonnegative(), sourceIds: z.array(id).max(20), representation: z.enum(['summary','original']), reason: z.string().max(128) }).strict()).max(300).optional(),
  memoryReferences: z.array(memoryReferenceSchema).max(256).refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  summaryReferences: z.array(z.object({messageId:id,contentSHA256:sha256}).strict()).max(1024).optional(),
  historyLookupReferences: z.array(z.object({sessionId:id,messageId:id,contentSHA256:sha256}).strict()).max(256).refine(items=>new Set(items.map(item=>item.messageId)).size===items.length).optional(),
  historyMessageIds: z.array(id).max(1024).refine((items) => new Set(items).size === items.length),
  privacy: contextPrivacySchema,
  scope: contextScopeSchema,
  lineage: z.enum(['complete', 'unknown']),
}).strict();
export const memoryContextMetadataSchema = z.object({
  version: z.literal(1),
  trust: z.enum(['host-confirmed', 'unverified']),
  origin: z.enum(['chat-user', 'manual-user', 'nightly-auto', 'auto-profile', 'manual-review', 'import-reviewed', 'legacy-unknown', 'assistant-candidate']),
  scope: contextScopeSchema,
  privacy: contextPrivacySchema,
  qqAllowed: z.boolean().optional(),
  telegramAllowed: z.boolean().optional(),
  wechatAllowed: z.boolean().optional(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sourceReferences: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat-user'), sessionId: id, messageId: id }).strict(),
    z.object({ kind: z.literal('manual-user'), actionId: id }).strict(),
    z.object({ kind: z.literal('manual-review'), actionId: id }).strict(),
    z.object({ kind: z.literal('import-reviewed'), importId: id, draftId: id, sourceMessageIds: z.array(id).min(1).max(100) }).strict(),
  ])).max(64),
  sourceEventIds: z.array(sha256).max(256).optional(),
  protectionAcknowledgements: z.array(id).optional(),
  reviewReason: z.enum(['protection-unknown', 'protection-conflict']).optional(),
  identity: z.object({ entity: z.string().min(1).max(240), key: z.string().min(1).max(240) }).strict().optional(),
  expiresAt: timestamp.nullable().optional(),
  overridesMemory: memoryReferenceSchema.optional(),
  /** `shallow` was picked up from conversation and may still be merged or let go; `deep` was promoted to the standing profile. */
  layer: z.enum(['shallow', 'deep']).optional(),
  sentCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastSentAt: timestamp.nullable(),
}).strict().refine((value) => value.trust !== 'host-confirmed' || value.sourceReferences.length > 0, 'Confirmed memory needs a host source.');

export const providerRequestObservationSchema = z.object({
  requestId: id,
  bindingDigest: sha256,
  bodySHA256: sha256,
  inputEstimate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(['fetch-invoked', 'response-received', 'terminal']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  outcome: z.enum(['completed', 'failed', 'aborted']).nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().nullable().optional(),
    tokenDetailsInvalid: z.boolean().optional(),
    source: z.enum(['provider-reported', 'unknown']),
    reportedCostUSD: z.number().finite().nonnegative().nullable().optional(),
  }).strict(),
  finishReason: z.string().max(128).nullable(),
}).strict();
export const chatRequestContextBindingSchema = z.object({
  providerId: id,
  model: z.string().min(1).max(240),
  destination: z.enum(['local', 'remote', 'unknown']),
  localExecutionDeclared: z.boolean(),
}).strict();
export const chatExcludedContextSchema = z.object({
  memoryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  summarizedCount: z.number().int().positive().optional(),
  compactedToolPages: z.number().int().positive().optional(),
  historyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const chatRequestPreparationSchema = z.object({
  requestId: id,
  runId: id.optional(),
  bindingDigest: sha256,
  expectedBodySHA256: sha256,
  inputEstimate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxInputTokens: z.number().int().min(1).max(131_072),
  maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
  capacitySource: z.string().min(1).max(64),
  contextTrace: contextTraceSchema,
  contextBinding: chatRequestContextBindingSchema.optional(),
  excludedContext: chatExcludedContextSchema.optional(),
  userMessageId: id.optional(),
  userMessageIds: z.array(id).min(1).max(9).refine((ids) => new Set(ids).size === ids.length, 'Duplicate user input.').optional(),
}).strict().refine((value) => value.inputEstimate <= value.maxInputTokens, 'Input exceeds its prepared budget.');
export const chatRequestReceiptSchema = z.object({
  requestId: id,
  runId: id.optional(),
  bindingDigest: sha256,
  expectedBodySHA256: sha256,
  inputEstimate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxInputTokens: z.number().int().min(1).max(131_072),
  maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
  capacitySource: z.string().min(1).max(64),
  contextTrace: contextTraceSchema,
  contextBinding: chatRequestContextBindingSchema.optional(),
  excludedContext: chatExcludedContextSchema.optional(),
  userMessageId: id.nullable(),
  userMessageIds: z.array(id).min(1).max(9).refine((ids) => new Set(ids).size === ids.length, 'Duplicate user input.').optional(),
  preparedAt: timestamp,
  phase: z.enum(['prepared', 'fetch-invoked', 'response-received', 'terminal']),
  observations: z.array(providerRequestObservationSchema.extend({ observedAt: timestamp })).max(3),
  sentCountRecorded: z.boolean(),
}).strict();

export const chatSessionSchema = z
  .object({
    id, title: z.string().max(240), kind: z.enum(['normal', 'project']), createdAt: timestamp, updatedAt: timestamp,
    analysisSource: z.literal('rea-static').optional(),
    channelBindingId: id.optional(),
    wechatTranscript: z.enum(['private', 'group', 'friend']).optional(),
    companionScope: z.enum(['owner', 'group']).optional(),
    // Optional metadata keeps existing version-1 profiles readable without rewriting their chats.
    pinnedAt: timestamp.nullable().optional(),
    archivedAt: timestamp.nullable().optional(),
    deletedAt: timestamp.nullable().optional(),
    historyPrivacy: contextPrivacySchema.optional(),
    knowledgeLocalOnly: z.literal(true).optional(),
  })
  .strict();
export const chatMessageSchema = z
  .object({
    id,
    sessionId: id,
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string().max(256_000),
    attachments: z.array(chatImageAttachmentSchema).max(1).optional(),
    createdAt: timestamp,
    status: z.enum(['streaming', 'complete', 'cancelled', 'failed']),
    errorCode: z.string().max(240).nullable(),
    wechatSender: z.string().max(160).optional(),
    companionSource: z.enum(['desktop', 'qq', 'wechat', 'telegram']).optional(),
    wechatDigest: z.literal(true).optional(),
    wechatFriend: z.literal(true).optional(),
    automationTriggerId: id.optional(),
    contextTrace: contextTraceSchema.optional(),
    memoryBaseRevision: z.number().int().nonnegative().optional(),
    nightlyEligible: z.literal(true).optional(),
    nightlyAutoEligible: z.literal(true).optional(),
    nightlyInvalidated: z.literal(true).optional(),
    nightlyReviewed: z.enum(['saved','dismissed']).optional(),
    followupToMessageId: id.optional(),
    requestReceipts: z.array(chatRequestReceiptSchema).max(128).optional(),
    timerReceipts: z.array(z.object({ timerId: id, label: z.string().max(240), seconds: z.number().int().min(1).max(86400), dueAt: timestamp, timeZone: z.string().min(1).max(128) }).strict()).max(1024).optional(),
    memoryReceipts: z.array(z.object({ memoryId: id, text: z.string().min(1).max(2000), savedAt: timestamp, reused: z.boolean(), scope: contextScopeSchema.optional(), expiresAt: timestamp.nullable().optional() }).strict()).max(1).optional(),
    memoryForget: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('deleted'), memoryId: id, text: z.string().max(32_000), deletedAt: timestamp }).strict(),
      z.object({ kind: z.literal('choices'), query: z.string().min(2).max(2000), candidates: z.array(z.object({ id, text: z.string().max(32_000), updatedAt: timestamp, revision: z.number().int().nonnegative().optional() }).strict()).min(2).max(5), totalMatches: z.number().int().min(2) }).strict(),
      z.object({ kind: z.literal('not-found'), query: z.string().min(2).max(2000) }).strict(),
    ]).optional(),
    memoryEdit: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('updated'), memoryId: id, before: z.string().max(32_000), after: z.string().min(1).max(2000), updatedAt: timestamp, scope: contextScopeSchema.optional(), expiresAt: timestamp.nullable().optional() }).strict(),
      z.object({ kind: z.literal('choices'), query: z.string().min(2).max(2000), replacement: z.string().min(1).max(2000), candidates: z.array(z.object({ id, text: z.string().max(32_000), updatedAt: timestamp, revision: z.number().int().nonnegative().optional() }).strict()).min(2).max(5), totalMatches: z.number().int().min(2) }).strict(),
      z.object({ kind: z.literal('not-found'), query: z.string().min(2).max(2000) }).strict(),
    ]).optional(),
  })
  .strict();
export const taskSchema = z
  .object({
    id,
    title: z.string().max(240),
    notes: z.string().max(16_000),
    status: z.enum(['todo', 'doing', 'done', 'cancelled']),
    dueAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const focusSchema = z
  .object({
    id,
    taskId: id.nullable(),
    startedAt: timestamp,
    lastResumedAt: timestamp.nullable(),
    plannedSeconds: z.number().int().positive(),
    elapsedSeconds: z.number().int().nonnegative(),
    status: z.enum(['running', 'paused', 'completed', 'cancelled']),
  })
  .strict();
export const memorySchema = z
  .object({
    id,
    text: z.string().max(32_000),
    tags: z.array(z.string().max(64)).max(32),
    source: z.enum(['user', 'assistant', 'migration']),
    createdAt: timestamp,
    updatedAt: timestamp,
    contextMetadata: memoryContextMetadataSchema.optional(),
  })
  .strict();
export const relationshipSchema = z
  .object({
    affinity: z.number().min(0).max(100),
    level: z.number().int().min(1).max(100),
    streakDays: z.number().int().nonnegative(),
    lastInteractionAt: timestamp.nullable(),
    nickname: z.string().max(80),
  })
  .strict();
export const scheduleSchema = z
  .object({
    id,
    title: z.string().max(240),
    enabled: z.boolean(),
    kind: z.enum(['reminder', 'focus', 'agent']),
    rrule: z.string().max(2_048),
    timezone: z.string().max(128),
    payload: z.record(z.string(), z.unknown()),
    nextRunAt: timestamp.nullable(),
    lastRunStatus: z.enum(['never', 'succeeded', 'failed', 'missed']),
  })
  .strict();
export const providerSchema = z
  .object({
    id,
    kind: z.enum(['openai', 'openrouter', 'openai-compatible', 'minimax', 'glm', 'deepseek', 'ollama', 'lm-studio']),
    name: z.string().max(240),
    baseUrl: z.url().max(2_048),
    model: z.string().max(240),
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    secretState: z.enum(['configured', 'missing', 'unavailable']),
    localExecutionConfirmed: z.boolean().optional(),
    ollamaNumCtx: z.number().int().min(512).max(131_072).optional(),
    contextWindowTokens: z.number().int().min(512).max(131_072).optional(),
    maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
    outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  })
  .strict();
export const backgroundJobSchema = z.object({
  id, profileId: id, operationId: id, specDigest: sha256, attemptId: id,
  origin: z.literal('background-jobs'), automaticTriggerId: id.optional(), skillId: id.optional(), resultOwner: id,
  consolidation: z.object({ batchId: id }).strict().optional(),
  delegation: z.object({ batchId: id, childId: id, sessionId: id, parentSessionId: id, intentVersion: z.number().int().positive(), deadlineAt: timestamp }).strict().optional(),
  instruction: z.string().min(1).max(32_000), material: z.string().max(32_000),
  source: z.object({ kind: z.literal('explicit-paste'), actionId: id, privacy: contextPrivacySchema }).strict(),
  binding: z.object({ provider: providerSchema, model: z.string().min(1).max(240), digest: sha256,
    credentialRef: id, destination: z.enum(['local', 'remote', 'unknown']),
    limits: z.object({ maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS), outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']),
      ollamaNumCtx: z.number().int().min(512).max(131_072).optional(),
      wireProtocol: z.literal('responses').optional(),
      reasoningEffort: z.literal('none').optional(),
      contextBudget: z.object({ contextWindowTokens: z.number().int().min(512).max(131072), safetyMarginTokens: z.number().int().min(256), capacitySource: z.enum(['configured', 'provider-reported', 'conservative-fallback', 'application-limit']) }).strict(),
    }).strict(),
  }).strict(),
  status: z.enum(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']),
  executionOwner: id.nullable(), cancelRequestedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp,
  completionReason: z.string().max(240).nullable(), result: z.string().max(256_000).nullable(),
  request: z.object({ requestId: id, bodySHA256: sha256, inputEstimate: z.number().int().nonnegative(), maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(), capacitySource: z.string().max(64), dispatchIntentAt: timestamp,
    observations: z.array(providerRequestObservationSchema.extend({ observedAt: timestamp })).max(3),
  }).strict().nullable(),
  receipts: z.array(z.object({ operationId: z.string().min(1).max(128), kind: z.enum(['accepted', 'dispatch-intent', 'cancel', 'terminal']), committedAt: timestamp,
    status: z.enum(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']),
  }).strict()).max(4),
}).strict();

export const delegationReservationSchema = z.object({ reservedTokens: z.number().int().nonnegative(), chargedTokens: z.number().int().nonnegative(),
  state: z.enum(['reserved', 'settled', 'released', 'unknown', 'overrun']), reportedTokens: z.number().int().nonnegative().nullable() }).strict();
export const delegationBatchSchema = z.object({
  id, profileId: id, sessionId: id, operationId: id, specDigest: sha256, intentVersion: z.number().int().positive(), goal: z.string().min(1).max(4000),
  deadlineAt: timestamp, createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: timestamp.nullable(), historicalAt: timestamp.nullable(), invalidatedReason: z.string().max(128).nullable(),
  // Retained for old profiles; zero records that no economic token limit was set.
  budget: z.object({ maxEstimatedTokens: z.number().int().min(0).max(500000), maxRequests: z.number().int().min(1).max(3) }).strict(),
  children: z.array(z.object({ id, jobId: id, sessionId: id, instruction: z.string().min(1).max(16000), requirements: requirementsSchema,
    checks: z.array(checkResultSchema).max(10), reservation: delegationReservationSchema }).strict()).min(1).max(3),
}).strict();
export const delegationIntentSchema = z.object({ sessionId: id, version: z.number().int().positive(), currentBatchId: id.nullable(), draftGoal: z.string().max(4000),
  operations: z.array(z.object({ operationId: id, digest: sha256, version: z.number().int().positive(), goal: z.string().max(4000) }).strict()).max(1000) }).strict();

export const consolidationSourceSchema = z.object({ id, revision: z.number().int().positive(), fingerprint: sha256, text: z.string().max(32000), tags: z.array(z.string().max(64)).max(32),
  privacy: contextPrivacySchema, scope: contextScopeSchema, sourceReferences: memoryContextMetadataSchema.shape.sourceReferences,
  sourceEventIds: z.array(sha256).max(256), selectionVersion: z.number().int().nonnegative() }).strict();
export const consolidationBatchSchema = z.object({
  id, profileId: id, sessionId: id, previewOperationId: id, previewDigest: sha256,
  status: z.enum(['draft','generating','review','applied','disabled','invalid','failed','cancelled']),
  sources: z.array(consolidationSourceSchema).min(1).max(20), candidate: consolidationCandidateSchema.nullable(), candidateVersion: z.number().int().nonnegative(),
  binding: backgroundJobSchema.shape.binding, budget: z.object({ inputEstimate: z.number().int().nonnegative(), maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive() }).strict(),
  createdAt: timestamp, updatedAt: timestamp, jobId: id.nullable(), invalidReason: z.string().max(128).nullable(), active: z.boolean(),
  receipts: z.array(z.object({ operationId: id, digest: sha256, kind: z.enum(['preview','generate','edit','apply','disable','cancel']), version: z.number().int().nonnegative(), committedAt: timestamp }).strict()).max(1000),
}).strict();
export const consolidationSelectionSchema = z.object({ memoryId: id, version: z.number().int().nonnegative(), batchId: id.nullable() }).strict();

export const permissionGrantSchema = z
  .object({
    capabilityId: z.string().min(1).max(128),
    scope: z.enum(['once', 'session', 'always']),
    grantedAt: timestamp,
    expiresAt: timestamp.nullable(),
    remainingUses: z.number().int().min(0).max(1).nullable(),
  })
  .strict();
export const sideEffectSchema = z
  .object({
    key: z.string().min(1).max(512),
    runId: id,
    toolId: z.string().min(1).max(128),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    completedAt: timestamp,
    output: z.unknown(),
  })
  .strict();

export const persistentStateSchema = z
  .object({
    version: z.literal(1),
    mediaLibrary: mediaLibrarySchema.default(defaultMediaLibrary),
    chatWorkTasks: z.array(chatWorkTaskSchema).max(1000).default([]),
    researchTasks: z.array(researchTaskSchema).max(300).default([]),
    chatCronSchedules: z.array(chatCronScheduleSchema).max(200).default([]),
    chatCronRuns: z.array(chatCronRunSchema).max(10000).default([]),
    wechatOwnerCommands: wechatOwnerCommandsSchema.default(defaultWeChatOwnerCommands),
    attentionReceipts: z.array(z.object({ id: z.string().min(1).max(160), fingerprint: sha256, acknowledgedAt: timestamp }).strict()).max(1600).default([]),
    usageEvents: z.array(usageEventSchema).max(20_000).default([]),
    usageRates: z.array(usageRateSchema).max(1000).default([]),
    usageBudget: usageBudgetSchema.default({ dailyRequestLimit: 100, dailyTokenLimit: 100_000 }),
    automationSchedules: z.array(persistentScheduleSchema).max(200).default([]),
    automationTriggers: z.array(automaticTriggerSchema).max(2000).default([]),
    proactivePolicy: proactivePolicySchema.default(defaultAutomationProactive),
    proactiveEvents: z.array(proactiveEventSchema).max(1000).default([]),
    proactiveObservations: z.array(proactiveObservationSchema).max(200).default([]),
    profileId: id.default(randomUUID),
    desktopExtensions: desktopExtensionsSchema.default({ skills: [], servers: [] }),
    nightlyMemory: nightlyStoreSchema.default(defaultNightlyStore),
    /** `cursors` holds, per conversation, the last message already read for the owner's profile. */
    memorySleep: z.object({
      settings: z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23), timezone: timezoneSchema }).strict(),
      lastDay: z.string().nullable(), lastRunAt: timestamp.nullable(),
      // Diary lineage outlives the short-lived undo reports. A null result means ordinary cleanup.
      recallReplacements: z.record(id, id.nullable()).default({}),
      reports: z.array(z.object({ id, at: timestamp, provider: z.string().max(240), changes: z.array(z.object({
        id, kind: z.enum(['merge', 'promote', 'drop', 'expire']), removed: z.array(memorySchema).max(16),
        resultId: id.nullable(), created: z.boolean(), after: z.string().max(32_000).nullable(), undoneAt: timestamp.nullable(),
      }).strict()).max(64) }).strict()).max(30),
    }).strict().default(defaultMemorySleep),
    autoMemory: z.object({ enabled: z.boolean(), cursors: z.record(id, id) }).strict().default(() => ({ enabled: true, cursors: {} })),
    companionRecent: companionRecentSchema.default(defaultCompanionRecent),
    consolidationBatches: z.array(consolidationBatchSchema).max(300).default([]),
    consolidationSelections: z.array(consolidationSelectionSchema).default([]),
    delegationBatches: z.array(delegationBatchSchema).max(300).default([]),
    delegationIntents: z.array(delegationIntentSchema).default([]),
    backgroundJobs: z.array(backgroundJobSchema).max(1000).default([]),
    providerCredentialRefs: z.record(id, id).default({}),
    chatSessions: z.array(chatSessionSchema),
    chatMessages: z.array(chatMessageSchema),
    tasks: z.array(taskSchema),
    focus: focusSchema.nullable(),
    proactive: proactiveRecordSchema.default(defaultProactiveRecord),
    memories: z.array(memorySchema),
    importedSourceEvents: z.array(z.object({ sourceEventId: sha256, eventFingerprint: sha256, collectionId: sha256, native: z.boolean() }).strict()).max(100_000).default([]),
    memoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    memoryTombstones: z.array(z.object({
      id, memoryId: id, textDigest: sha256, sourceEventIds: z.array(sha256).max(256),
      identityKey: z.string().max(1024).nullable(), scope: contextScopeSchema,
      deletedAt: timestamp, kind: z.enum(['deleted', 'corrected']),
      memoryRevision: z.number().int().positive().optional(),
    }).strict()).default([]),
    memoryOperations: z.array(z.object({
      operationId: z.string().min(1).max(512), digest: sha256,
      status: z.enum(['committed', 'duplicate', 'blocked', 'stale']), memoryId: id.nullable(),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), committedAt: timestamp,
    }).strict()).default([]),
    conversationImports: z.array(z.object({
      id, name: z.string().min(1).max(240), format: z.string().max(40), skipped: z.number().int().nonnegative(), createdAt: timestamp,
      messages: z.array(z.object({ id, speakerId: z.string().min(1).max(128), speaker: z.string().min(1).max(128), text: z.string().min(1).max(16_000), time: z.string().max(80).nullable(), sourceEventId: sha256.optional(), sourceEntityId: sha256.optional(), sourceIdentity: z.enum(['native', 'transcript']).optional(), sourceCollectionId: sha256.optional() }).strict()).min(1).max(2000),
      draft: z.object({
        id, createdAt: timestamp, baseMemoryRevision: z.number().int().nonnegative().optional(), providerName: z.string().max(240), speakerId: z.string().max(128), speaker: z.string().max(128), isUser: z.boolean(),
        sourceMessageIds: z.array(id).min(1).max(100), style: speakingStyleSchema, styleApplied: z.boolean(),
        memories: z.array(z.object({ id, text: z.string().min(1).max(2000), evidenceIds: z.array(id).min(1).max(8), savedMemoryId: id.nullable() }).strict()).max(20),
      }).strict().nullable(),
    }).strict()).max(20).default([]),
    activeSpeakingStyle: z.object({ importId: id, draftId: id, name: z.string().max(128), enabled: z.boolean(), style: speakingStyleSchema }).strict().nullable().default(null),
    relationship: relationshipSchema,
    schedules: z.array(scheduleSchema),
    timers: z.array(z.object({
      id, label: z.string().max(240), dueAt: timestamp, createdAt: timestamp,
      status: z.enum(['pending', 'completed', 'cancelled']), completedAt: timestamp.nullable(),
    }).strict()).default([]),
    providers: z.array(providerSchema),
    persistentPermissionGrants: z.array(permissionGrantSchema),
    researchPermissionRevision: z.number().int().min(0).default(0),
    sideEffects: z.array(sideEffectSchema),
  })
  .strict();

export type PersistentState = z.infer<typeof persistentStateSchema>;
export type PersistentFocus = z.infer<typeof focusSchema>;
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;
export type SideEffectRecord = z.infer<typeof sideEffectSchema>;

export const createDefaultState = (): PersistentState => ({
  version: 1,
  mediaLibrary: defaultMediaLibrary(),
  attentionReceipts: [],
  usageEvents: [], usageRates: [], usageBudget: { dailyRequestLimit: 100, dailyTokenLimit: 100_000 },
  automationSchedules: [], automationTriggers: [], proactivePolicy: defaultAutomationProactive(), proactiveEvents: [], proactiveObservations: [],
  profileId: randomUUID(),
  desktopExtensions: { skills: [], servers: [] },
  backgroundJobs: [],
  nightlyMemory: defaultNightlyStore(),
  autoMemory: { enabled: true, cursors: {} },
  memorySleep: defaultMemorySleep(),
  companionRecent: defaultCompanionRecent(),
  consolidationBatches: [],
  consolidationSelections: [],
  delegationBatches: [],
  delegationIntents: [],
  providerCredentialRefs: {},
  chatWorkTasks: [],
  researchTasks: [],
  chatCronSchedules: [],
  chatCronRuns: [],
  wechatOwnerCommands: defaultWeChatOwnerCommands(),
  chatSessions: [],
  chatMessages: [],
  tasks: [],
  focus: null,
  proactive: defaultProactiveRecord(),
  memories: [],
  memoryRevision: 0,
  importedSourceEvents: [],
  memoryTombstones: [],
  memoryOperations: [],
  conversationImports: [],
  activeSpeakingStyle: null,
  relationship: { affinity: 0, level: 1, streakDays: 0, lastInteractionAt: null, nickname: '' },
  schedules: [],
  timers: [],
  providers: [],
  persistentPermissionGrants: [],
  researchPermissionRevision: 0,
  sideEffects: [],
});
