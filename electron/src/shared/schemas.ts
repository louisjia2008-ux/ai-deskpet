import { codingTaskIdSchema, codingTaskStartSchema } from './coding-tasks';
import { mediaAssetIdSchema, mediaGenerateSchema, mediaSettingsSchema, mediaUpdateSchema } from './media';
import { memoryRecallInputs } from './memory-recall';
import { researchTaskInputSchema, researchTaskResumeSchema } from './research-tasks';
import { extensionInputs } from './desktop-extensions';
import { minecraftCompanionConfigSchema, minecraftCompanionTaskSchema } from './minecraft-companion';
import { minecraftDedicatedIdentitySchema, minecraftDedicatedSettingsSchema } from './minecraft-dedicated';
import { CHAT_CRON_CAPABILITIES } from './chat-cron';
import { calendarRuleSchema, persistentScheduleInputSchema, proactivePolicyInputSchema, timezoneSchema, usageRateInputSchema, usageRateTargetSchema } from './automation-schemas';
import { consolidationCandidateSchema } from './consolidation';
import { requirementsSchema } from './delegation-checks';
import { proactiveConfigSchema } from './proactive';
import { personaSchema } from './persona';
import { characterProfileSchema } from './character';
import { speakingStyleSchema } from './conversation-import';
import { modelRoutingSchema } from './model-routing';
import { z } from 'zod';
import { speechInputSettingsSchema, speechPcmSchema } from './speech-input';
import { companionPreferencesSchema } from './companion-journal';
import { MAX_OUTPUT_TOKENS } from './output-limits';
import { pluginConfigurationSchema } from './plugins';
import { KNOWLEDGE_EMBEDDING_MODELS } from './knowledge-embedding';
import { isKnowledgeFolderName } from './knowledge';

import { API_VERSION } from './contracts';
import { wechatDigestGroupIdSchema, wechatDigestGroupSettingsSchema, wechatFriendsMomentsSettingsSchema, wechatOfficialBriefSettingsSchema } from './wechat-digests';
import { wechatFollowupActionSchema, wechatFollowupSettingsSchema } from './wechat-followup';
import { wechatInboxIdSchema, wechatInboxQuerySchema } from './wechat-inbox';
import { QQ_TRANSPORTS, qqOneBotUrlSchema } from './qq-channel';
import { wechatAssistantSchema, wechatCloudSettingsSchema, wechatFriendCloudUpdateSchema, wechatFriendIdSchema, wechatFriendRosterIdSchema, wechatGroupRuleUpdateSchema, wechatGroupIdSchema, wechatGroupUpdateSchema, wechatReplySchema } from './wechat-channel';

const idSchema = z.string().uuid();
const textSchema = z.string().trim().min(1).max(32_000);
const shortTextSchema = z.string().trim().min(1).max(240);
const nullableShortTextSchema = z.string().trim().max(240).nullable();
const emptySchema = z.object({}).strict();
const hasControlCharacters = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 32);
const chatModelSchema = shortTextSchema.refine((value) => !hasControlCharacters(value), 'Use a model identifier.');

const knowledgeFolderSchema = z.string().min(1).max(255).refine((value) =>
  !value.startsWith('.') && !value.includes('/') && !value.includes('\\') && !hasControlCharacters(value));

export const localeSchema = z.enum(['system', 'en', 'zh-CN']);
export const themeSchema = z.enum(['system', 'light', 'dark']);
export const contextPrivacySchema = z.enum(['local-only', 'cloud-allowed']);
export const contextScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: idSchema }).strict(),
]);
export const providerKindSchema = z.enum([
  'openai',
  'openrouter',
  'openai-compatible',
  'minimax',
  'glm',
  'deepseek',
  'ollama',
  'lm-studio',
]);

export const providerInputSchema = z
  .object({
    id: idSchema,
    kind: providerKindSchema,
    name: shortTextSchema,
    baseUrl: z.url().max(2_048),
    model: shortTextSchema,
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    apiKey: z.string().max(16_384).optional(),
    localExecutionConfirmed: z.boolean().optional(),
    ollamaNumCtx: z.number().int().min(512).max(131_072).optional(),
    contextWindowTokens: z.number().int().min(512).max(131_072).optional(),
    maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
    outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  })
  .strict();

export const taskInputSchema = z
  .object({
    id: idSchema,
    title: shortTextSchema,
    notes: z.string().max(16_000),
    status: z.enum(['todo', 'doing', 'done', 'cancelled']),
    dueAt: z.iso.datetime().nullable(),
  })
  .strict();

export const memoryInputSchema = z
  .object({
    id: idSchema,
    text: textSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(32),
    privacy: contextPrivacySchema.optional(),
    scope: contextScopeSchema.optional(),
    confirmForChat: z.boolean().optional(),
    telegramAllowed: z.boolean().optional(),
    wechatAllowed: z.boolean().optional(),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    operationId: idSchema.optional(),
    identity: z.object({ entity: z.string().trim().min(1).max(240), key: z.string().trim().min(1).max(240) }).strict().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const minecraftConnectionSchema = z.object({
  host: z.string().trim().min(1).max(253).refine((value) => !/[\s/\\?#@]/u.test(value) && !hasControlCharacters(value), 'Use a server hostname or IP address.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(254).refine((value) => !hasControlCharacters(value)),
  auth: z.enum(['offline', 'microsoft']),
  version: z.string().trim().max(32).regex(/^(auto|1\.\d+(?:\.\d+)?)$/u),
  ownerName: z.string().trim().max(16).regex(/^[A-Za-z0-9_]*$/u),
  executorMode: z.enum(['strict', 'hybrid']),
  providerId: idSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.auth === 'offline' && !/^[A-Za-z0-9_]{1,16}$/u.test(value.username)) {
    context.addIssue({ code: 'custom', path: ['username'], message: 'Offline player names use 1–16 letters, numbers or underscores.' });
  }
  if (value.executorMode === 'hybrid' && value.providerId === null) {
    context.addIssue({ code: 'custom', path: ['providerId'], message: 'Select an AI provider for hybrid mode.' });
  }
});

export const invokePayloadSchemas = {
  'media:snapshot': emptySchema,
  'media:import-images': emptySchema,
  'media:import-folder': emptySchema,
  'media:update': mediaUpdateSchema,
  'media:remove': z.object({ id: mediaAssetIdSchema }).strict(),
  'media:restore': z.object({ id: mediaAssetIdSchema }).strict(),
  'media:configure': mediaSettingsSchema,
  'media:generate': mediaGenerateSchema,
  'media:attach': z.object({ sessionId: idSchema, assetId: mediaAssetIdSchema }).strict(),
  ...extensionInputs,
  ...memoryRecallInputs,
  'research:list': emptySchema,
  'research:get': z.object({id:idSchema}).strict(),
  'research:submit': researchTaskInputSchema,
  'research:resume': researchTaskResumeSchema,
  'research:cancel': z.object({id:idSchema}).strict(),
  'research:open-result': z.object({id:idSchema}).strict(),
  'persona:get': emptySchema,
  'speech:status': emptySchema,
  'speech:configure': speechInputSettingsSchema,
  'speech:prepare': emptySchema,
  'speech:transcribe': speechPcmSchema,
  'speech:cancel': emptySchema,
  'journal:preferences': emptySchema,
  'journal:configure': companionPreferencesSchema,
  'journal:list': emptySchema,
  'journal:edit': z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), revision: z.number().int().positive(), text: z.string().trim().min(1).max(6000) }).strict(),
  'journal:remove': z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), revision: z.number().int().positive() }).strict(),
  'persona:update': personaSchema,
  'persona:character-get': emptySchema,
  'persona:character-update': characterProfileSchema,
  'telegram:get-state': emptySchema,
  'telegram:pending-results': emptySchema,
  'telegram:configure': z.object({
    enabled: z.boolean().optional(), token: z.string().trim().min(1).nullable().optional(),
    providerId: idSchema.nullable().optional(), model: chatModelSchema.nullable().optional(),
    memoryAllowed: z.boolean().optional(),
  }).strict(),
  'telegram:start-pairing': emptySchema,
  'telegram:confirm-pairing': z.object({ candidateId: idSchema }).strict(),
  'telegram:unbind': emptySchema,
  'telegram:retry-deliveries': emptySchema,
  'telegram:set-cron-delivery': z.object({ scheduleId: idSchema, expectedBindingId: idSchema.nullable(), expectedRevision: z.number().int().positive(), enabled: z.boolean() }).strict(),
  'knowledge:get-state': emptySchema,
  'knowledge:choose-vault': emptySchema,
  'knowledge:detach': emptySchema,
  'knowledge:reindex': emptySchema,
  'knowledge:list-folders': emptySchema,
  'knowledge:set-folder-sharing': z.object({ folder: knowledgeFolderSchema.nullable(), level: z.enum(['local', 'shareable']) }).strict(),
  'knowledge:set-writable-folders': z.object({ folders: z.array(knowledgeFolderSchema).max(512) }).strict(),
  'knowledge:set-embedding-model': z.object({ model: z.enum(KNOWLEDGE_EMBEDDING_MODELS) }).strict(),
  'knowledge:set-auto-index': z.object({ enabled: z.boolean() }).strict(),
  'knowledge:set-diary-sync': z.object({ enabled: z.boolean(), folder: z.string().refine(isKnowledgeFolderName) }).strict(),
  'knowledge:ask': z.object({query:z.string().trim().min(1).max(1400), providerId:z.string().uuid(), model:z.string().trim().min(1).max(240)}).strict(),
  'knowledge:search': z.object({query:z.string().trim().min(1).max(1400)}).strict(),
  'qq:get-state': emptySchema,
  'wechat:get-state': emptySchema,
  'wechat:configure-group': wechatGroupUpdateSchema,
  'wechat:list-reply-groups': emptySchema,
  'wechat:add-reply-group': z.strictObject({ id: wechatDigestGroupIdSchema }),
  'wechat:get-reply-friends': emptySchema,
  'wechat:list-reply-friends': emptySchema,
  'wechat:add-reply-friend': z.strictObject({ id: wechatFriendRosterIdSchema }),
  'wechat:remove-reply-friend': z.strictObject({ id: wechatFriendIdSchema }),
  'wechat:bind-selected-group': emptySchema,
  'wechat:remove-group': z.object({ id: wechatGroupIdSchema }).strict(),
  'wechat:get-models': emptySchema,
  'wechat:configure-reply': wechatReplySchema,
  'wechat:get-cloud': emptySchema,
  'wechat:configure-assistant': wechatAssistantSchema,
  'wechat:configure-group-rule': wechatGroupRuleUpdateSchema,
  'wechat:configure-cloud': wechatCloudSettingsSchema,
  'wechat:configure-friend-cloud': wechatFriendCloudUpdateSchema,
  'wechat:recover-window': emptySchema,
  'wechat:open-vm': emptySchema,
  'wechat:set-paused': z.object({ paused: z.boolean() }).strict(),
  'wechat-digests:get-groups': emptySchema,
  'wechat-digests:set-groups': wechatDigestGroupSettingsSchema,
  'wechat-digests:group-results': emptySchema,
  'wechat-digests:get-official': emptySchema,
  'wechat-digests:set-official': wechatOfficialBriefSettingsSchema,
  'wechat-digests:get-friends-moments': emptySchema,
  'wechat-digests:set-friends-moments': wechatFriendsMomentsSettingsSchema,
  'wechat-followup:get-settings': emptySchema,
  'wechat-followup:configure': wechatFollowupSettingsSchema,
  'wechat-followup:list': emptySchema,
  'wechat-followup:act': wechatFollowupActionSchema,
  'wechat-inbox:list': z.strictObject({ query: wechatInboxQuerySchema }),
  'wechat-inbox:remove': z.strictObject({ id: wechatInboxIdSchema }),
  'wechat-inbox:get-export': emptySchema,
  'wechat-inbox:set-export': z.strictObject({ enabled: z.boolean() }),
  'qq:send-private-image-test': z.object({ expectedBindingId: idSchema }).strict(),
  'qq:set-private-care': z.object({ expectedBindingId: idSchema, enabled: z.boolean() }).strict(),
  'qq:send-private-care-now': z.object({ expectedBindingId: idSchema }).strict(),
  'qq:configure': z.object({
    enabled: z.boolean().optional(),
    transport: z.enum(QQ_TRANSPORTS).optional(),
    appId: z.string().trim().optional(),
    onebotUrl: qqOneBotUrlSchema.optional(),
    appSecret: z.string().max(256).nullable().optional(),
    providerId: idSchema.nullable().optional(),
    model: z.string().max(240).nullable().optional(),
    dailyRequestLimit: z.number().int().min(1).max(1_000).optional(),
    webCallLimit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  'qq:start-pairing': emptySchema,
  'qq:confirm-pairing': z.object({ candidateId: idSchema }).strict(),
  'qq:stop': emptySchema,
  'qq:unbind': emptySchema,
  'qq:retry-deliveries': emptySchema,
  'qq:set-cron-delivery': z.object({ scheduleId: idSchema, expectedBindingId: idSchema.nullable(), expectedRevision: z.number().int().positive(), enabled: z.boolean() }).strict(),
  'qq:set-private-reminders': z.object({bindingId:z.string().uuid(), enabled:z.boolean()}).strict(),
  'qq:start-group-pairing': emptySchema,
  'qq:confirm-group-pairing': z.object({ candidateId: idSchema }).strict(),
  'qq:set-group-open': z.object({ groupId: idSchema, openToMembers: z.boolean() }).strict(),
  'qq:remove-group': z.object({ groupId: idSchema }).strict(),
  'plugins:get-state': emptySchema,
  'plugins:configure': pluginConfigurationSchema,
  'plugins:test': z.object({ kind: z.enum(['searxng', 'crawl4ai']) }).strict(),
  'rea:check-runtime': emptySchema,
  'rea:status': emptySchema,
  'rea:choose-target': z.object({sessionId:idSchema}).strict(),
  'rea:analyze': z.object({sessionId:idSchema,targetId:idSchema}).strict(),
  'rea:inspect': z.object({sessionId:idSchema,targetId:idSchema,resultId:idSchema,view:z.enum(['summary','modules','boundaries'])}).strict(),
  'rea:cancel': z.object({sessionId:idSchema}).strict(),
  'rea:ask': z.object({sessionId:idSchema,resultId:idSchema,question:z.string().trim().min(1).max(2000),providerId:idSchema,model:chatModelSchema}).strict(),
  'usage:snapshot': emptySchema,
  'usage:rate-upsert': usageRateInputSchema,
  'usage:rate-remove': usageRateTargetSchema,
  'attention:snapshot': emptySchema,
  'attention:health': emptySchema,
  'attention:acknowledge-health': z.object({ key: z.string().regex(/^[a-z-]{1,40}:\d{1,2}$/u), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  'doctor:status': emptySchema,
  'doctor:set-enabled': z.object({ enabled: z.boolean() }).strict(),
  'doctor:check': emptySchema,
  'doctor:wechat-self-test': emptySchema,
  'attention:acknowledge': z.object({ id: z.string().regex(/^(background-job|delegation|consolidation|proactive):[a-f0-9-]{36}$/u), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  'automation:snapshot': emptySchema,
  'automation:trigger-result': z.object({id:idSchema}).strict(),
  'automation:schedule-upsert': persistentScheduleInputSchema,
  'automation:schedule-pause': z.object({id:idSchema}).strict(),
  'automation:schedule-cancel': z.object({id:idSchema}).strict(),
  'automation:schedule-run-now': z.object({id:idSchema,operationId:idSchema}).strict(),
  'automation:schedule-preview': z.object({rule:calendarRuleSchema,timezone:timezoneSchema,after:z.iso.datetime(),count:z.number().int().min(1).max(10)}).strict(),
  'automation:configure-proactive': proactivePolicyInputSchema,
  'automation:explicit-check-in': z.object({operationId:idSchema}).strict(),
  'automation:cancel-trigger': z.object({id:idSchema}).strict(),
  'proactive:get-state': emptySchema,
  'proactive:configure': proactiveConfigSchema,
  'proactive:interaction': emptySchema,
  'chat:open-session': z.object({ sessionId: idSchema }).strict(),
  'minecraft:get-state': emptySchema,
  'minecraft-companion:get-state': emptySchema,
  'minecraft-companion:connect': minecraftCompanionConfigSchema,
  'minecraft-companion:start': minecraftCompanionTaskSchema,
  'minecraft-companion:cancel': emptySchema,
  'minecraft-companion:disconnect': emptySchema,
  'minecraft-dedicated:get-state': emptySchema,
  'minecraft-dedicated:update-settings': minecraftDedicatedSettingsSchema.partial(),
  'minecraft-dedicated:update-identity': minecraftDedicatedIdentitySchema,
  'minecraft-dedicated:accept-eula': emptySchema,
  'minecraft-dedicated:start': emptySchema,
  'minecraft-dedicated:stop': emptySchema,
  'minecraft-dedicated:restart': emptySchema,
  'minecraft-dedicated:backup': emptySchema,
  'minecraft-dedicated:open-backups': emptySchema,
  'minecraft:connect': minecraftConnectionSchema,
  'minecraft:disconnect': emptySchema,
  'minecraft:submit': z.object({ command: z.string().trim().min(1).max(2000) }).strict(),
  'minecraft:control': z.object({ action: z.enum(['pause', 'resume', 'cancel', 'stop', 'refresh']) }).strict(),
  'minecraft:chat': z.object({ message: z.string().trim().min(1).max(240).refine((value) => !value.startsWith('/') && !hasControlCharacters(value), 'Enter a chat message, without server commands.') }).strict(),
  'app:get-state': emptySchema,
  'app:set-locale': z.object({ locale: localeSchema }).strict(),
  'app:set-theme': z.object({ theme: themeSchema }).strict(),
  'app:set-hotkey': z.object({ accelerator: z.string().trim().min(1).max(128) }).strict(),
  'app:set-auto-launch': z.object({ enabled: z.boolean() }).strict(),
  'app:open-login-settings': emptySchema,
  'backup:create': z.object({ password: z.string().min(12).max(256) }).strict(),
  'backup:restore': z.object({ password: z.string().min(12).max(256) }).strict(),
  'backup:restart': emptySchema,
  'recovery:get-state': emptySchema,
  'recovery:restore-snapshot': z.object({ id: idSchema }).strict(),
  'recovery:restore-backup': z.object({ password: z.string().min(12).max(256) }).strict(),
  'app:show-console': emptySchema,
  'app:set-overlay-visible': z.object({ visible: z.boolean() }).strict(),
  'app:get-diagnostics': emptySchema,
  'character:get-state': emptySchema,
  'character:get-preview': emptySchema,
  'character:import-core': emptySchema,
  'character:import-model': emptySchema,
  'character:cancel-import': emptySchema,
  'character:ack-model-loaded': z.object({ importId: idSchema }).strict(),
  'character:model-load-failed': z.object({ importId: idSchema }).strict(),
  'character:set-scale': z.object({ scale: z.number().min(0.2).max(3) }).strict(),
  'character:set-position': z
    .object({
      position: z
        .object({ displayId: z.string().min(1).max(128), x: z.number().finite(), y: z.number().finite() })
        .strict()
        .nullable(),
    })
    .strict(),
  'character:play-action': z.object({ action: shortTextSchema }).strict(),
  'character:set-expression': z.object({ expression: nullableShortTextSchema }).strict(),
  'character:set-bubble': z.object({ text: z.string().max(2_000).nullable() }).strict(),
  'character:tap': emptySchema,
  'character:dismiss-bubble': z.object({ revision: z.number().int().nonnegative() }).strict(),
  'character:set-interactive': z.object({ interactive: z.boolean() }).strict(),
  'character:voice-get': emptySchema,
  'character:voice-update': z.object({ enabled: z.boolean() }).strict(),
  'character:voice-choose-folder': emptySchema,
  'character:voice-test': emptySchema,
  'character:voice-stop': emptySchema,
  'chat:list-sessions': z.object({ scope: z.enum(['active', 'archived', 'deleted', 'all']).optional(), query: z.string().trim().max(240).optional() }).strict(),
  'chat:create-session': z.object({ title: shortTextSchema, kind: z.enum(['normal', 'project']) }).strict(),
  'chat:rename-session': z.object({ id: idSchema, title: z.string().trim().min(1).max(240) }).strict(),
  'chat:set-pinned': z.object({ id: idSchema, pinned: z.boolean() }).strict(),
  'chat:set-archived': z.object({ id: idSchema, archived: z.boolean() }).strict(),
  'chat:remove-session': z.object({ id: idSchema }).strict(),
  'chat:restore-session': z.object({ id: idSchema }).strict(),
  'chat:list-messages': z.object({ sessionId: idSchema }).strict(),
  'chat:send': z.object({ sessionId: idSchema, content: textSchema, providerId: idSchema, model: chatModelSchema.optional() }).strict(),
  'chat:get-interaction': z.object({ sessionId: idSchema }).strict(),
  'chat:followup': z.object({ runId: idSchema, sessionId: idSchema, operationId: idSchema, content: z.string().trim().min(1).max(8_000) }).strict(),
  'chat:resolve-approval': z.object({ runId: idSchema, sessionId: idSchema, approvalId: idSchema, decision: z.enum(['allow-once', 'allow-run', 'deny']) }).strict(),
  'chat-work:list': z.object({sessionId:idSchema}).strict(),
  'chat-work:get': z.object({sessionId:idSchema,id:idSchema}).strict(),
  'chat-work:open-artifact': z.object({sessionId:idSchema,taskId:idSchema,path:z.string().min(1).max(1024)}).strict(),
  'chat-work:search-artifacts': z.object({ query:z.string().trim().max(200).optional(), sessionId:idSchema.optional(), offset:z.number().int().min(0).max(40_000).optional(), limit:z.number().int().min(1).max(50).optional() }).strict(),
  'chat-work:preview-artifact': z.object({sessionId:idSchema,taskId:idSchema,path:z.string().min(1).max(1024).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&!/^[a-z]:/iu.test(value)&&value.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..')),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),
  'chat-work:export-artifact-pdf': z.object({sessionId:idSchema,taskId:idSchema,path:z.string().min(1).max(1024).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&!/^[a-z]:/iu.test(value)&&value.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..')),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),
  'chat-work:search-history': z.object({sessionId:idSchema,query:z.string().trim().min(1).max(200),limit:z.number().int().min(1).max(50).optional(),targetSessionId:idSchema.optional()}).strict(),
  'chat-work:read-history': z.object({sessionId:idSchema,messageId:idSchema,offset:z.number().int().min(0).optional(),maxCharacters:z.number().int().min(1).max(8000).optional()}).strict(),
  'chat-work:list-cron': z.object({sessionId:idSchema}).strict(),
  'chat-work:pause-cron': z.object({sessionId:idSchema,id:idSchema}).strict(),
  'chat-work:resume-cron': z.object({sessionId:idSchema,id:idSchema,expectedRevision:z.number().int().positive(),allowedCapabilities:z.array(z.enum(CHAT_CRON_CAPABILITIES)).max(CHAT_CRON_CAPABILITIES.length)}).strict(),
  'chat-work:cancel-cron': z.object({sessionId:idSchema,id:idSchema}).strict(),
  'chat:cancel': z.object({ runId: idSchema }).strict(),
  'chat:retry': z.object({ messageId: idSchema }).strict(),
  'chat:forget-memory': z.object({ messageId: idSchema, memoryId: idSchema }).strict(),
  'chat:edit-memory': z.object({ messageId: idSchema, memoryId: idSchema }).strict(),
  'delegations:open-draft': z.object({ sessionId: idSchema, command: z.string().min(1).max(8000).optional() }).strict(),
  'delegations:submit': z.object({ operationId: idSchema, sessionId: idSchema, intentVersion: z.number().int().positive(), goal: z.string().trim().min(1).max(4000), deadlineAt: z.iso.datetime(),
    // Old clients may replay their exact reviewed operation, including its legacy budget.
    budget: z.object({ maxEstimatedTokens: z.number().int().min(0).max(500000), maxRequests: z.number().int().min(1).max(3) }).strict().optional(),
    children: z.array(z.object({ instruction: z.string().trim().min(1).max(16000), material: z.string().max(16000), privacy: contextPrivacySchema, providerId: idSchema, model: chatModelSchema, requirements: requirementsSchema }).strict()).min(1).max(3),
  }).strict(),
  'delegations:list': z.object({ sessionId: idSchema }).strict(),
  'delegations:get-result': z.object({ batchId: idSchema, childId: idSchema }).strict(),
  'delegations:cancel-batch': z.object({ id: idSchema }).strict(),
  'delegations:cancel-child': z.object({ batchId: idSchema, childId: idSchema }).strict(),
  'delegations:replace': z.object({ batchId: idSchema, operationId: idSchema, goal: z.string().trim().min(1).max(4000) }).strict(),
  'auto-memory:status': z.object({}).strict(),
  'auto-memory:configure': z.object({ enabled: z.boolean() }).strict(),
  'memory-sleep:status': z.object({}).strict(),
  'memory-sleep:configure': z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23), timezone: z.string().min(1).max(128) }).strict(),
  'memory-sleep:run': z.object({}).strict(),
  'memory-sleep:undo': z.object({ reportId: idSchema, changeId: idSchema }).strict(),
  'consolidation:sources': z.object({ sessionId: idSchema }).strict(),
  'consolidation:preview': z.object({ operationId: idSchema, sessionId: idSchema, memoryIds: z.array(idSchema).min(1).max(20).refine((v) => new Set(v).size === v.length), providerId: idSchema, model: chatModelSchema }).strict(),
  'consolidation:generate': z.object({ id: idSchema, operationId: idSchema }).strict(),
  'consolidation:list': z.object({ sessionId: idSchema }).strict(),
  'consolidation:get': z.object({ id: idSchema }).strict(),
  'consolidation:edit': z.object({ id: idSchema, operationId: idSchema, expectedVersion: z.number().int().positive(), candidate: consolidationCandidateSchema }).strict(),
  'consolidation:apply': z.object({ id: idSchema, operationId: idSchema, expectedVersion: z.number().int().positive(), fidelityReviewed: z.literal(true), enableRepresentation: z.boolean() }).strict(),
  'consolidation:disable': z.object({ id: idSchema, operationId: idSchema }).strict(),
  'consolidation:cancel': z.object({ id: idSchema, operationId: idSchema }).strict(),
  'jobs:submit': z.object({ operationId: idSchema, instruction: textSchema, material: z.string().max(32_000), privacy: contextPrivacySchema, providerId: idSchema, model: chatModelSchema }).strict(),
  'jobs:list': emptySchema,
  'coding:pick-repository': emptySchema,
  'coding:list': emptySchema,
  'coding:start': codingTaskStartSchema.omit({ repository: true }).extend({ selectionId: codingTaskIdSchema }),
  'coding:interrupt': z.object({ id: codingTaskIdSchema }).strict(),
  'coding:resume': z.object({ id: codingTaskIdSchema }).strict(),
  'jobs:get': z.object({ id: idSchema }).strict(),
  'jobs:cancel': z.object({ id: idSchema }).strict(),
  'tasks:list': emptySchema,
  'tasks:upsert': taskInputSchema,
  'tasks:remove': z.object({ id: idSchema }).strict(),
  'tasks:get-focus': emptySchema,
  'tasks:start-focus': z.object({ taskId: idSchema.nullable(), plannedSeconds: z.number().int().min(60).max(86_400) }).strict(),
  'tasks:pause-focus': emptySchema,
  'tasks:resume-focus': emptySchema,
  'tasks:stop-focus': z.object({ status: z.enum(['completed', 'cancelled']) }).strict(),
  'tasks:list-run-events': z.object({ limit: z.number().int().min(1).max(200).optional(), beforeId: idSchema.optional() }).strict(),
  'imports:get-state': emptySchema,
  'imports:preview': z.object({ name: z.string().trim().min(1).max(240), text: z.string().min(1).max(60_000) }).strict(),
  'imports:pick-file': emptySchema,
  'imports:save-preview': z.object({ id: idSchema }).strict(),
  'imports:remove': z.object({ id: idSchema }).strict(),
  'imports:cancel': z.object({ id: idSchema }).strict(),
  'imports:distill': z.object({ id: idSchema, speakerId: z.string().min(1).max(128), isUser: z.boolean(), messageIds: z.array(idSchema).min(1).max(100), providerId: idSchema }).strict(),
  'imports:apply': z.object({ id: idSchema, draftId: idSchema, memories: z.array(z.object({ id: idSchema, text: z.string().trim().min(1).max(2000) }).strict()).max(20), applyStyle: z.boolean() }).strict(),
  'imports:set-style': z.object({ enabled: z.boolean(), style: speakingStyleSchema }).strict(),
  'memory:list': emptySchema,
  'memory:upsert': memoryInputSchema,
  'memory:share-all': emptySchema,
  'vm:status': emptySchema,
  'vm:setup': emptySchema,
  'vm:stop': emptySchema,
  'vm:remove': emptySchema,
  'vm:open-folder': emptySchema,
  'memory:remove': z.object({ id: idSchema, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), operationId: idSchema.optional() }).strict(),
  'relationship:get': emptySchema,
  'relationship:set-nickname': z.object({ nickname: z.string().trim().max(80) }).strict(),
  'timers:list': emptySchema,
  'timers:cancel': z.object({ id: idSchema }).strict(),
  'providers:get-routing': emptySchema,
  'providers:set-routing': modelRoutingSchema,
  'providers:list': emptySchema,
  'providers:select': z.object({ id: idSchema }).strict(),
  'providers:set-model': z.object({ id: idSchema, model: chatModelSchema }).strict(),
  'providers:upsert': providerInputSchema,
  'providers:remove': z.object({ id: idSchema }).strict(),
  'providers:clear-secret': z.object({ id: idSchema }).strict(),
  'providers:test': z.object({ id: idSchema }).strict(),
  'providers:list-models': z.object({ id: idSchema }).strict(),
  'providers:discover-models': z.object({
    kind: providerKindSchema,
    baseUrl: z.url().max(2_048),
    apiKey: z.string().min(1).max(16_384).refine((value) => !hasControlCharacters(value)).optional(),
    existingProviderId: idSchema.optional(),
  }).strict(),
  'permissions:list': emptySchema,
  'permissions:request': z
    .object({ capabilityId: z.string().min(1).max(128), duration: z.enum(['once', 'session', 'always']) })
    .strict(),
  'permissions:revoke': z.object({ capabilityId: z.string().min(1).max(128) }).strict(),
  'migration:preview': emptySchema,
  'migration:start': z
    .object({ categories: z.array(z.string().min(1).max(128)).max(16), confirmProviderSecrets: z.boolean() })
    .strict(),
  'migration:cancel': emptySchema,
} as const;

export type InvokeChannel = keyof typeof invokePayloadSchemas;
export type InvokePayload<C extends InvokeChannel> = z.infer<(typeof invokePayloadSchemas)[C]>;

export const eventChannels = [
  'media:changed',
  'chat-work:changed',
  'attention:changed',
  'attention:open-requested',
  'proactive:changed',
  'chat:open-requested',
  'minecraft:changed',
  'minecraft-companion:changed',
  'minecraft-dedicated:changed',
  'app:changed',
  'character:changed',
  'character:pointer',
  'character:reaction',
  'character:voice',
  'character:import-progress',
  'chat:event',
  'chat:sessions-changed',
  'tasks:changed',
  'consolidation:changed',
  'jobs:changed',
  'research:changed',
  'delegations:changed',
  'memory:changed',
  'relationship:changed',
  'timers:changed',
  'providers:changed',
  'vm:changed',
  'permissions:changed',
  'migration:progress',
] as const;

export type EventChannel = (typeof eventChannels)[number];

export const requestEnvelopeSchema = <T extends z.ZodType>(payload: T) =>
  z
    .object({
      version: z.literal(API_VERSION),
      payload,
    })
    .strict();

export const MAX_IPC_BYTES = 256 * 1024;

export const parseInvokeRequest = <C extends InvokeChannel>(channel: C, value: unknown): InvokePayload<C> => {
  const envelope = requestEnvelopeSchema(invokePayloadSchemas[channel]).parse(value);
  return envelope.payload as InvokePayload<C>;
};
