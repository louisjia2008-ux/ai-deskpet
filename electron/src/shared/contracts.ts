import type { MemoryRecallAPI } from './memory-recall';
import type { ResearchTasksApi } from './research-tasks';
import type { AutoMemoryAPI } from './auto-memory';
import type { MemorySleepAPI } from './memory-sleep';
import type { ChatImageAttachment, MediaAPI } from './media';
import type { ModelRouting } from './model-routing';
import type { DefaultModelChange, DefaultModelImpact, ModelChangeConsent } from './model-bindings';
import type { ChatWorkPanelApi } from './chat-work-api';
import type { CodingTask, CodingTaskInput } from './coding-tasks';
import type { VmSandboxAPI } from './vm-sandbox';
import type { ReaAPI } from './rea';
import type { PluginsAPI } from './plugins';
import type { TelegramChannelAPI } from './telegram-channel';
import type { KnowledgeAPI } from './knowledge';
import type { QqChannelAPI } from './qq-channel';
import type { WeChatChannelAPI } from './wechat-channel';
import type { WeChatInboxAPI } from './wechat-inbox';
import type { WeChatDigestsAPI } from './wechat-digests';
import type { WeChatFollowupAPI } from './wechat-followup';
import type { Persona } from './persona';
import type { CharacterProfile, CharacterState as CompanionCharacterState } from './character';
import type { AttentionAPI } from './attention';
import type { AutomationAPI, UsageAPI } from './automation';
import type { ConsolidationApplyInput, ConsolidationBatch, ConsolidationEditInput, ConsolidationPreviewInput, ConsolidationSource, MemoryRepresentationTrace } from './consolidation';
import type { DelegationBatch, DelegationDraft, DelegationResult, DelegationSubmit } from './delegations';
import type { ModelPricing, ProviderDiscoveryInput } from './provider-catalog';
import type { ProviderUsageTokenDetails } from './providers';
import type { BackgroundJob, BackgroundJobInput } from './background-jobs';
import type { ProactiveConfig, ProactiveState } from './proactive';
import type { MinecraftCompanionConfig, MinecraftCompanionSnapshot, MinecraftCompanionTaskInput } from './minecraft-companion';
import type { MinecraftDedicatedIdentity, MinecraftDedicatedSettings, MinecraftDedicatedSnapshot } from './minecraft-dedicated';
import type { CompanionRecentAPI } from './companion-recent';
import type { CharacterReaction, CompanionPointer } from './character-reactions';
import type { VoiceChunk, VoiceStatus } from './voice';
import type { SpeechInputAPI } from './speech-input';
import type { CompanionJournalAPI } from './companion-journal';
import type { ImportState, ImportPreview, ImportedConversation, DistillInput, ApplyDistillationInput, ActiveSpeakingStyle, SpeakingStyle } from './conversation-import';

export const API_VERSION = 1 as const;

export type ApiVersion = typeof API_VERSION;
export type Locale = 'system' | 'en' | 'zh-CN';
export type ResolvedLocale = Exclude<Locale, 'system'>;
export type Theme = 'system' | 'light' | 'dark';
export type AutoLaunchState = 'enabled' | 'disabled' | 'approval-required' | 'unavailable' | 'error';
export type WindowRole = 'console' | 'overlay';
export type CapabilityState = 'available' | 'degraded' | 'unavailable';
export type RiskLevel = 'low' | 'medium' | 'high';
export type SecretState = 'configured' | 'missing' | 'unavailable';
export type ProviderKind =
  | 'openai'
  | 'openrouter'
  | 'openai-compatible'
  | 'minimax'
  | 'glm'
  | 'deepseek'
  | 'ollama'
  | 'lm-studio';

export interface PlatformCapability {
  id:
    | 'overlay-position'
    | 'always-on-top'
    | 'precise-click-through'
    | 'global-shortcut'
    | 'tray'
    | 'notifications'
    | 'auto-launch'
    | 'secret-storage'
    | 'native-migration';
  state: CapabilityState;
  reasonCode: string;
  requiredPermission: string | null;
  canRequestPermission: boolean;
}

export interface AppState {
  version: string;
  platform: NodeJS.Platform;
  locale: Locale;
  resolvedLocale: ResolvedLocale;
  theme: Theme;
  hotkey: string;
  hotkeyRegistered: boolean;
  autoLaunch: boolean;
  autoLaunchState?: AutoLaunchState;
  activeProviderId?: string | null;
  dataDirectory: string;
  capabilities: PlatformCapability[];
}

export interface DiagnosticSnapshot {
  generatedAt: string;
  appVersion: string;
  electronVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  sessionType: string | null;
  windowRoles: WindowRole[];
  capabilities: PlatformCapability[];
  vault: { state: 'ready' | 'locked' | 'unavailable'; backend: string };
  core: { state: 'missing' | 'ready' | 'invalid'; hash: string | null };
  model: { state: 'missing' | 'ready' | 'invalid'; name: string | null };
  providerSecrets: Record<string, SecretState>;
  runtimeIdentity?: {
    pid: number;
    appPath: string;
    executablePath: string;
    dataDirectory: string;
    isPackaged: boolean;
    artifactMode?: 'daily' | 'validation-candidate';
    runtimeApplicationName?: string;
    mainBundleSHA256: string | null;
    utilityBundleSHA256: string | null;
    build: { sourceSHA256: string; sourceFileCount: number; builtAtUTC: string } | null;
  } | undefined;
}

export interface CharacterState {
  mood?: CompanionCharacterState['mood'];
  coreState: 'missing' | 'ready' | 'invalid';
  modelState: 'missing' | 'loading' | 'ready' | 'invalid';
  coreUrl: string | null;
  modelUrl: string | null;
  pendingImportId: string | null;
  importError?: 'setup.loadFailed' | 'setup.restoredModel' | null;
  modelName: string | null;
  scale: number;
  position: { displayId: string; x: number; y: number } | null;
  expression: string | null;
  expressions: string[];
  action: string | null;
  actionRevision: number;
  bubble: string | null;
  bubbleRevision?: number;
  bubbleExpiresAt?: string | null;
  bubbleSessionId?: string | null;
}

export interface ImportProgress {
  phase: 'validating' | 'copying' | 'extracting' | 'loading' | 'committing' | 'complete' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  messageCode: string;
}

export interface ChatSession {
  id: string;
  title: string;
  kind: 'normal' | 'project';
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null | undefined;
  archivedAt?: string | null | undefined;
  deletedAt?: string | null | undefined;
  analysisSource?: 'rea-static' | undefined;
  /** Host-only origin marker; a desktop retry must never upgrade a QQ session. */
  channelBindingId?: string | undefined;
  /** A read-only transcript of a verified WeChat conversation. */
  wechatTranscript?: 'private' | 'group' | 'friend' | undefined;
  /** Set only by the host when a conversation actually runs on a known channel. */
  companionScope?: 'owner' | 'group' | undefined;
  /** Sticky restriction for later history; never authorizes sending the current user input. */
  historyPrivacy?: ContextPrivacy | undefined;
  /** A conversation that read device-only notes continues only on this device. */
  knowledgeLocalOnly?: true | undefined;
  modelSelection?: ChatModelSelection | undefined;
}

export interface ChatModelSelection {
  providerId: string;
  model: string | null;
}

export interface ChatSessionListOptions {
  scope?: 'active' | 'archived' | 'deleted' | 'all' | undefined;
  query?: string | undefined;
}

export interface TimerReceipt {
  timerId: string;
  label: string;
  seconds: number;
  dueAt: string;
  timeZone: string;
}

export interface ChatMessage {
  attachments?: ChatImageAttachment[] | undefined;
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
  status: 'streaming' | 'complete' | 'cancelled' | 'failed';
  errorCode: string | null;
  wechatSender?: string | undefined;
  companionSource?: 'desktop' | 'qq' | 'wechat' | 'telegram' | undefined;
  /** A delivered summary in the local-only WeChat transcript mirror. */
  wechatDigest?: true | undefined;
  /** Read-only WeChat friend transcript excluded from the owner's memory and context. */
  wechatFriend?: true | undefined;
  timerReceipts?: TimerReceipt[] | undefined;
  memoryReceipts?: MemoryReceipt[] | undefined;
  memoryForget?: MemoryForgetResult | undefined;
  memoryEdit?: MemoryEditResult | undefined;
  automationTriggerId?: string | undefined;
  /** Host recorded an ordinary owner-composed desktop turn while nightly processing was enabled. */
  nightlyEligible?: true | undefined;
  nightlyAutoEligible?: true | undefined;
  nightlyInvalidated?: true | undefined;
  nightlyReviewed?: 'saved' | 'dismissed' | undefined;
  /** Host-written provenance. Missing metadata remains unknown, not automatically trusted. */
  contextTrace?: ContextTrace | undefined;
  requestReceipts?: ChatRequestReceipt[] | undefined;
  /** Host snapshot observed when the source command entered the profile. */
  memoryBaseRevision?: number | undefined;
  /** Host-linked user addition to an existing reply; older profiles omit it. */
  followupToMessageId?: string | undefined;
}

export type MemoryEditResult =
  | { kind: 'updated'; memoryId: string; before: string; after: string; updatedAt: string; scope?: ContextScope | undefined; expiresAt?: string | null | undefined }
  | { kind: 'choices'; query: string; replacement: string; candidates: Array<{ id: string; text: string; updatedAt: string; revision?: number | undefined }>; totalMatches: number }
  | { kind: 'not-found'; query: string };

export type MemoryForgetResult =
  | { kind: 'deleted'; memoryId: string; text: string; deletedAt: string }
  | { kind: 'choices'; query: string; candidates: Array<{ id: string; text: string; updatedAt: string; revision?: number | undefined }>; totalMatches: number }
  | { kind: 'not-found'; query: string };

export interface MemoryReceipt {
  memoryId: string;
  text: string;
  savedAt: string;
  reused: boolean;
  scope?: ContextScope | undefined;
  expiresAt?: string | null | undefined;
}

export type ChatProgress =
  | { phase: 'preparing' | 'queued' | 'thinking' | 'composing' | 'responding' | 'awaiting-approval' }
  | { phase: 'tool' | 'recovering'; toolId: string };

export type ChatApprovalDecision = 'allow-once' | 'allow-run' | 'deny';

export interface ChatApprovalRequest {
  id: string;
  runId: string;
  sessionId: string;
  messageId: string;
  toolId: string;
  capabilityId: string;
  titleCode: string;
  detailCode: string;
  risk: RiskLevel;
  inputPreview: string;
  inputTruncated: boolean;
  expiresAt: string;
  /** The host offers a grant lasting until this task ends. */
  allowRun: boolean;
  /** Set when approving also sends the tool result to a non-local model. */
  disclosure?: { providerName: string; model: string; destination: 'remote' | 'unknown' } | undefined;
}

export interface ChatInteractionState {
  runId: string;
  sessionId: string;
  messageId: string;
  acceptingFollowups: boolean;
  canFollowup: boolean;
  queuedFollowups: number;
  approval: ChatApprovalRequest | null;
  progress: ChatProgress;
}

export type ChatEvent =
  | { type: 'started'; runId: string; sessionId: string; messageId: string }
  | { type: 'interaction'; state: ChatInteractionState }
  | { type: 'followup'; runId: string; sessionId: string; messageId: string; message: ChatMessage }
  | { type: 'progress'; runId: string; messageId: string; progress: ChatProgress }
  | { type: 'delta'; runId: string; messageId: string; text: string }
  | { type: 'timer-created'; runId: string; messageId: string; receipt: TimerReceipt }
  | { type: 'memory-saved'; runId: string; messageId: string; receipt: MemoryReceipt }
  | { type: 'tool'; runId: string; taskId: string; toolId: string; status: TaskRunStatus }
  | { type: 'finished'; runId: string; message: ChatMessage }
  | { type: 'failed'; runId: string; messageId: string; errorCode: string };

export interface DeskTask {
  id: string;
  title: string;
  notes: string;
  status: 'todo' | 'doing' | 'done' | 'cancelled';
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  startedAt: string;
  plannedSeconds: number;
  elapsedSeconds: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
}

export type ContextPrivacy = 'local-only' | 'cloud-allowed';
/** Global means this encrypted profile only; it is not permission to cross profiles. */
export type ContextScope = { kind: 'global' } | { kind: 'session'; sessionId: string };
export interface MemoryReference { id: string; revision: number }
export type MemorySourceReference =
  | { kind: 'chat-user'; sessionId: string; messageId: string }
  | { kind: 'manual-user'; actionId: string }
  | { kind: 'manual-review'; actionId: string }
  | { kind: 'import-reviewed'; importId: string; draftId: string; sourceMessageIds: string[] };

export interface MemoryContextMetadata {
  version: 1;
  trust: 'host-confirmed' | 'unverified';
  origin: 'chat-user' | 'manual-user' | 'nightly-auto' | 'auto-profile' | 'manual-review' | 'import-reviewed' | 'legacy-unknown' | 'assistant-candidate';
  scope: ContextScope;
  privacy: ContextPrivacy;
  /** Explicit owner opt-in for use in QQ-originated turns. No memory is QQ-visible by default. */
  qqAllowed?: boolean | undefined;
  telegramAllowed?: boolean | undefined;
  wechatAllowed?: boolean | undefined;
  /** Changes with the fact or its sharing policy, never with request accounting alone. */
  revision: number;
  /** Absent on anything the owner wrote or edited; those are never tidied away. */
  layer?: 'shallow' | 'deep' | undefined;
  sourceReferences: MemorySourceReference[];
  /** Host-owned stable event identities; batching and model output cannot create evidence. */
  sourceEventIds?: string[] | undefined;
  /** Host-observed protection records at an explicit new save or correction. */
  protectionAcknowledgements?: string[] | undefined;
  reviewReason?: 'protection-unknown' | 'protection-conflict' | undefined;
  /** Explicitly chosen fact address. Similar phrasing never invents this address. */
  identity?: { entity: string; key: string } | undefined;
  expiresAt?: string | null | undefined;
  overridesMemory?: MemoryReference | undefined;
  /** Number of observed HTTP fetch attempts containing this revision, not model adoption. */
  sentCount: number;
  lastSentAt: string | null;
}

export interface ContextTrace {
  /** Version of the owner-only rolling summary that informed this context. */
  recentRevision?: string | undefined;
  /** Opaque vault approval identity for messages derived from a notes tool. */
  knowledgePolicyToken?: string | undefined;
  /** Private WeChat digest context and its derivatives expire at this instant. */
  wechatDigestUntil?: string | undefined;
  /** Encrypted diary versions whose summaries entered this answer. Fail closed without a live journal. */
  diaryReferences?: Array<{ date: string; revision: number; summarySHA256: string }> | undefined;
  version: 1;
  memoryReferences: MemoryReference[];
  historyMessageIds: string[];
  summaryReferences?: Array<{messageId:string;contentSHA256:string}> | undefined;
  historyLookupReferences?: Array<{sessionId:string;messageId:string;contentSHA256:string}> | undefined;
  privacy: ContextPrivacy;
  scope: ContextScope;
  lineage: 'complete' | 'unknown';
  representationReferences?: Array<{ batchId: string; candidateVersion: number }> | undefined;
  representationDecisions?: MemoryRepresentationTrace[] | undefined;
}

export interface ProviderRequestObservation {
  requestId: string;
  bindingDigest: string;
  bodySHA256: string;
  inputEstimate: number;
  phase: 'fetch-invoked' | 'response-received' | 'terminal';
  httpStatus: number | null;
  outcome: 'completed' | 'failed' | 'aborted' | null;
  usage: ProviderUsageTokenDetails & { inputTokens: number | null; outputTokens: number | null; source: 'provider-reported' | 'unknown'; reportedCostUSD?: number | null | undefined };
  finishReason: string | null;
}

export interface ChatRequestContextBinding {
  providerId: string;
  model: string;
  destination: 'local' | 'remote' | 'unknown';
  /** A user declaration, not proof of where an upstream service executes. */
  localExecutionDeclared: boolean;
}

export interface ChatExcludedContext {
  summarizedCount?: number | undefined;
  compactedToolPages?: number | undefined;
  memoryCount: number;
  historyCount: number;
}

export interface ChatRequestPreparation {
  requestId: string;
  /** Existing chat run identity; separates a retry from the tool rounds of one run. */
  runId?: string | undefined;
  bindingDigest: string;
  expectedBodySHA256: string;
  inputEstimate: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  capacitySource: string;
  contextTrace: ContextTrace;
  /** Optional only for compatibility; missing historic values remain unknown. */
  contextBinding?: ChatRequestContextBinding | undefined;
  excludedContext?: ChatExcludedContext | undefined;
  userMessageId?: string | undefined;
  /** Ordered current-turn user inputs actually adopted by this request. */
  userMessageIds?: string[] | undefined;
}

export interface ChatRequestReceipt {
  requestId: string;
  runId?: string | undefined;
  bindingDigest: string;
  expectedBodySHA256: string;
  inputEstimate: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  capacitySource: string;
  contextTrace: ContextTrace;
  contextBinding?: ChatRequestContextBinding | undefined;
  excludedContext?: ChatExcludedContext | undefined;
  userMessageId: string | null;
  /** Older receipts retain only userMessageId. */
  userMessageIds?: string[] | undefined;
  preparedAt: string;
  phase: 'prepared' | ProviderRequestObservation['phase'];
  observations: Array<ProviderRequestObservation & { observedAt: string }>;
  /** Accounting describes an HTTP attempt. It never proves model adoption or server cancellation. */
  sentCountRecorded: boolean;
}

export interface MemoryInput {
  id: string;
  text: string;
  tags: string[];
  /** Only sharing choices are writable by the user-facing API; provenance is host-owned. */
  privacy?: ContextPrivacy | undefined;
  scope?: ContextScope | undefined;
  confirmForChat?: boolean | undefined;
  telegramAllowed?: boolean | undefined;
  wechatAllowed?: boolean | undefined;
  expectedRevision?: number | undefined;
  operationId?: string | undefined;
  identity?: { entity: string; key: string } | undefined;
  expiresAt?: string | null | undefined;
}

export interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  source: 'user' | 'assistant' | 'migration';
  createdAt: string;
  updatedAt: string;
  contextMetadata?: MemoryContextMetadata | undefined;
}

export interface RelationshipState {
  affinity: number;
  level: number;
  streakDays: number;
  lastInteractionAt: string | null;
  nickname: string;
}

export interface ChatTimer {
  id: string;
  label: string;
  dueAt: string;
  createdAt: string;
  status: 'pending' | 'completed' | 'cancelled';
  completedAt: string | null;
}

export interface ScheduleDefinition {
  id: string;
  title: string;
  enabled: boolean;
  kind: 'reminder' | 'focus' | 'agent';
  rrule: string;
  timezone: string;
  payload: Record<string, unknown>;
  nextRunAt: string | null;
  lastRunStatus: 'never' | 'succeeded' | 'failed' | 'missed';
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  supportsTools: boolean;
  secretState: SecretState;
  localExecutionConfirmed?: boolean | undefined;
  /** Explicit Ollama loader option, independent of the application request budget. */
  ollamaNumCtx?: number | undefined;
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  outputTokenParameter?: 'max_tokens' | 'max_completion_tokens' | undefined;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  supportsTools: boolean;
  availability?: 'provider-listed' | 'reference' | undefined;
  pricing?: ModelPricing | undefined;
}

export interface PermissionDescriptor {
  capabilityId: string;
  titleCode: string;
  detailCode: string;
  risk: RiskLevel;
  state: 'not-requested' | 'session' | 'always' | 'denied';
  expiresAt: string | null;
}

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'missed';

export interface TaskRunEvent {
  id: string;
  runId: string;
  sequence: number;
  createdAt: string;
  type: 'state' | 'model' | 'tool' | 'approval' | 'effect' | 'error';
  status: TaskRunStatus;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface MigrationPreview {
  available: boolean;
  sourcePath: string | null;
  sourceDigest: string | null;
  requiresKeychainConfirmation: boolean;
  categories: Array<{
    id: 'conversations' | 'memory' | 'tasks' | 'relationship' | 'schedules' | 'providers' | 'appearance' | 'live2d-model';
    count: number;
    containsSecrets: boolean;
  }>;
  warnings: string[];
}

export interface MigrationResult {
  markerId: string;
  imported: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  sourceDigest: string;
  completedAt: string;
}

export type Unsubscribe = () => void;

export interface StartupRecoveryState {
  locale: ResolvedLocale;
  affectedFile: string;
  dataDirectory: string;
  snapshots: Array<{ id: string; label: string }>;
}

export interface DeskPetApi {
  vmSandbox: VmSandboxAPI;
  memoryRecall?: MemoryRecallAPI;
  research?: ResearchTasksApi;
  media?: MediaAPI;
  coding?: {
    pickRepository(): Promise<{ selectionId: string; path: string } | null>;
    list(): Promise<CodingTask[]>;
    start(input: Omit<CodingTaskInput, 'repository'> & { selectionId: string }): Promise<CodingTask>;
    interrupt(id: string): Promise<CodingTask>;
    resume(id: string): Promise<CodingTask>;
  };
  autoMemory: AutoMemoryAPI;
  companionRecent: CompanionRecentAPI;
  speech?: SpeechInputAPI;
  journal?: CompanionJournalAPI;
  memorySleep: MemorySleepAPI;
  chatWork: ChatWorkPanelApi;
  plugins: PluginsAPI;
  telegram: TelegramChannelAPI;
  knowledge: KnowledgeAPI;
  qq: QqChannelAPI;
  wechat: WeChatChannelAPI;
  wechatInbox?: WeChatInboxAPI;
  wechatDigests?: WeChatDigestsAPI;
  wechatFollowup?: WeChatFollowupAPI;
  persona: { get(): Promise<Persona>; update(persona: Persona): Promise<Persona>; getCharacter(): Promise<CharacterProfile>; updateCharacter(profile: CharacterProfile): Promise<CharacterProfile> };
  attention: AttentionAPI & { onOpenRequested(listener: () => void): Unsubscribe };
  rea: ReaAPI;
  usage: UsageAPI;
  automation: AutomationAPI;
  consolidation: {
    sources(sessionId: string): Promise<ConsolidationSource[]>;
    preview(input: ConsolidationPreviewInput): Promise<ConsolidationBatch>;
    generate(input: { id: string; operationId: string }): Promise<ConsolidationBatch>;
    list(sessionId: string): Promise<ConsolidationBatch[]>;
    get(id: string): Promise<ConsolidationBatch>;
    edit(input: ConsolidationEditInput): Promise<ConsolidationBatch>;
    apply(input: ConsolidationApplyInput): Promise<ConsolidationBatch>;
    disable(input: { id: string; operationId: string }): Promise<ConsolidationBatch>;
    cancel(input: { id: string; operationId: string }): Promise<ConsolidationBatch>;
    onChanged(listener: () => void): Unsubscribe;
  };
  delegations: {
    openDraft(input: { sessionId: string; command?: string }): Promise<DelegationDraft>;
    submit(input: DelegationSubmit): Promise<DelegationBatch>;
    list(sessionId: string): Promise<DelegationBatch[]>;
    getResult(input: { batchId: string; childId: string }): Promise<DelegationResult>;
    cancelBatch(id: string): Promise<DelegationBatch>;
    cancelChild(input: { batchId: string; childId: string }): Promise<DelegationBatch>;
    replace(input: { batchId: string; operationId: string; goal: string }): Promise<DelegationDraft>;
    onChanged(listener: () => void): Unsubscribe;
  };
  jobs: {
    submit(input: BackgroundJobInput): Promise<BackgroundJob>;
    list(): Promise<BackgroundJob[]>;
    get(id: string): Promise<BackgroundJob>;
    cancel(id: string): Promise<BackgroundJob>;
    onChanged(listener: () => void): Unsubscribe;
  };
  proactive: {
    getState(): Promise<ProactiveState>;
    configure(config: ProactiveConfig): Promise<ProactiveState>;
    noteInteraction(): Promise<void>;
    onChanged(listener: (state: ProactiveState) => void): Unsubscribe;
  };
  minecraftCompanion?: {
    getState(): Promise<MinecraftCompanionSnapshot>;
    connect(config: MinecraftCompanionConfig): Promise<MinecraftCompanionSnapshot>;
    start(input: MinecraftCompanionTaskInput): Promise<MinecraftCompanionSnapshot>;
    cancel(): Promise<MinecraftCompanionSnapshot>;
    disconnect(): Promise<MinecraftCompanionSnapshot>;
    onChanged(listener: (state: MinecraftCompanionSnapshot) => void): Unsubscribe;
  };
  minecraftDedicated?: {
    getState(): Promise<MinecraftDedicatedSnapshot>;
    updateSettings(patch: Partial<MinecraftDedicatedSettings>): Promise<MinecraftDedicatedSnapshot>;
    updateIdentity(identity: MinecraftDedicatedIdentity): Promise<MinecraftDedicatedSnapshot>;
    acceptEula(): Promise<MinecraftDedicatedSnapshot>;
    start(): Promise<MinecraftDedicatedSnapshot>;
    stop(): Promise<MinecraftDedicatedSnapshot>;
    restart(): Promise<MinecraftDedicatedSnapshot>;
    backup(): Promise<MinecraftDedicatedSnapshot>;
    openBackups(): Promise<void>;
    onChanged(listener: (state: MinecraftDedicatedSnapshot) => void): Unsubscribe;
  };
  app: {
    getState(): Promise<AppState>;
    setLocale(locale: Locale): Promise<AppState>;
    setTheme(theme: Theme): Promise<AppState>;
    setHotkey(accelerator: string): Promise<AppState>;
    setAutoLaunch(enabled: boolean): Promise<AppState>;
    openLoginSettings(): Promise<void>;
    showConsole(): Promise<void>;
    setOverlayVisible(visible: boolean): Promise<void>;
    getDiagnostics(): Promise<DiagnosticSnapshot>;
    onChanged(listener: (state: AppState) => void): Unsubscribe;
  };
  backup: {
    create(password: string): Promise<{ path: string; files: number; bytes: number } | null>;
    restore(password: string): Promise<{ sessions: number; messages: number; files: number; memoryProtection?: 'preserved' | 'unavailable' } | null>;
    restart(): Promise<void>;
    /** Sets a prepared restore aside (nothing has moved yet) and reopens DeskPet with the current data. */
    cancelRestore(): Promise<void>;
  };
  recovery: {
    getState(): Promise<StartupRecoveryState | null>;
    restoreSnapshot(id: string): Promise<boolean>;
    restoreBackup(password: string): Promise<boolean>;
  };
  character: {
    getState(): Promise<CharacterState>;
    getPreview(): Promise<string | null>;
    importCore(): Promise<CharacterState>;
    importModel(): Promise<CharacterState>;
    cancelImport(): Promise<void>;
    acknowledgeModelLoaded(importId: string): Promise<CharacterState>;
    modelLoadFailed(importId: string): Promise<CharacterState>;
    setScale(scale: number): Promise<CharacterState>;
    setPosition(position: CharacterState['position']): Promise<CharacterState>;
    playAction(action: string): Promise<void>;
    setExpression(expression: string | null): Promise<void>;
    setBubble(text: string | null): Promise<void>;
    tap(): Promise<void>;
    dismissBubble(revision: number): Promise<void>;
    setInteractive(interactive: boolean): Promise<void>;
    onChanged(listener: (state: CharacterState) => void): Unsubscribe;
    onPointer(listener: (point: CompanionPointer) => void): Unsubscribe;
    onReaction(listener: (reaction: CharacterReaction) => void): Unsubscribe;
    getVoice(): Promise<VoiceStatus>;
    setVoiceEnabled(enabled: boolean): Promise<VoiceStatus>;
    chooseVoiceFolder(): Promise<VoiceStatus>;
    testVoice(): Promise<boolean>;
    stopVoice(): Promise<void>;
    onVoice(listener: (chunk: VoiceChunk) => void): Unsubscribe;
    onImportProgress(listener: (progress: ImportProgress) => void): Unsubscribe;
  };
  chat: {
    openSession(sessionId: string): Promise<void>;
    onOpenRequested(listener: (sessionId: string) => void): Unsubscribe;
    listSessions(options?: ChatSessionListOptions): Promise<ChatSession[]>;
    createSession(input: { title: string; kind: ChatSession['kind'] }): Promise<ChatSession>;
    renameSession(id: string, title: string): Promise<ChatSession>;
    setPinned(id: string, pinned: boolean): Promise<ChatSession>;
    setArchived(id: string, archived: boolean): Promise<ChatSession>;
    setModelSelection(id: string, selection: ChatModelSelection | null): Promise<ChatSession>;
    removeSession(id: string): Promise<ChatSession>;
    restoreSession(id: string): Promise<ChatSession>;
    listMessages(sessionId: string): Promise<ChatMessage[]>;
    send(input: { sessionId: string; content: string; providerId?: string; model?: string; workerIdentity?: string[] }): Promise<{ runId: string }>;
    getInteraction(sessionId: string): Promise<ChatInteractionState | null>;
    followup(input: { runId: string; sessionId: string; operationId: string; content: string }): Promise<ChatMessage>;
    resolveApproval(input: { runId: string; sessionId: string; approvalId: string; decision: ChatApprovalDecision }): Promise<void>;
    cancel(runId: string): Promise<void>;
    retry(messageId: string): Promise<{ runId: string }>;
    forgetMemory(messageId: string, memoryId: string): Promise<ChatMessage>;
    editMemory(messageId: string, memoryId: string): Promise<ChatMessage>;
    onEvent(listener: (event: ChatEvent) => void): Unsubscribe;
    onSessionsChanged(listener: () => void): Unsubscribe;
  };
  tasks: {
    list(): Promise<DeskTask[]>;
    upsert(input: Pick<DeskTask, 'id' | 'title' | 'notes' | 'status' | 'dueAt'>): Promise<DeskTask>;
    remove(id: string): Promise<void>;
    getFocus(): Promise<FocusSession | null>;
    startFocus(input: { taskId: string | null; plannedSeconds: number }): Promise<FocusSession>;
    pauseFocus(): Promise<FocusSession>;
    resumeFocus(): Promise<FocusSession>;
    stopFocus(status: 'completed' | 'cancelled'): Promise<FocusSession>;
    listRunEvents(options?: { limit?: number; beforeId?: string }): Promise<TaskRunEvent[]>;
    onChanged(listener: () => void): Unsubscribe;
  };
  memory: {
    list(): Promise<MemoryItem[]>;
    upsert(input: MemoryInput): Promise<MemoryItem>;
    remove(id: string, options?: { expectedRevision?: number; operationId?: string }): Promise<void>;
    /** Marks every local-only memory as allowed for cloud models; resolves with how many changed. */
    shareAllWithCloud(): Promise<number>;
    onChanged(listener: (items: MemoryItem[]) => void): Unsubscribe;
  };
  imports: {
    getState(): Promise<ImportState>;
    preview(input: { name: string; text: string }): Promise<ImportPreview>;
    pickFile(): Promise<ImportPreview | null>;
    savePreview(id: string): Promise<ImportedConversation>;
    remove(id: string): Promise<void>;
    distill(input: DistillInput): Promise<ImportedConversation>;
    cancel(id: string): Promise<void>;
    apply(input: ApplyDistillationInput): Promise<ImportState>;
    setStyle(input: { enabled: boolean; style: SpeakingStyle }): Promise<ActiveSpeakingStyle>;
  };
  relationship: {
    get(): Promise<RelationshipState>;
    setNickname(nickname: string): Promise<RelationshipState>;
    onChanged(listener: (state: RelationshipState) => void): Unsubscribe;
  };
  timers: {
    list(): Promise<ChatTimer[]>;
    cancel(id: string): Promise<void>;
    onChanged(listener: (items: ChatTimer[]) => void): Unsubscribe;
  };
  providers: {
    getRouting(): Promise<ModelRouting>;
    setRouting(value: ModelRouting): Promise<ModelRouting>;
    select(id: string): Promise<AppState>;
    defaultModelImpact?(id: string): Promise<DefaultModelImpact | null>;
    setModel(id: string, model: string, consent?: ModelChangeConsent): Promise<ProviderConfig & { modelChange?: DefaultModelChange }>;
    list(): Promise<ProviderConfig[]>;
    upsert(input: Omit<ProviderConfig, 'secretState'> & { apiKey?: string; consent?: ModelChangeConsent }): Promise<ProviderConfig & { modelChange?: DefaultModelChange }>;
    remove(id: string): Promise<void>;
    clearSecret(id: string): Promise<ProviderConfig>;
    test(id: string): Promise<{ ok: boolean; messageCode: string; latencyMs: number | null }>;
    listModels(id: string): Promise<ProviderModel[]>;
    discoverModels(input: ProviderDiscoveryInput): Promise<ProviderModel[]>;
    onChanged(listener: (items: ProviderConfig[]) => void): Unsubscribe;
  };
  permissions: {
    list(): Promise<PermissionDescriptor[]>;
    request(input: { capabilityId: string; duration: 'once' | 'session' | 'always' }): Promise<PermissionDescriptor>;
    revoke(capabilityId: string): Promise<PermissionDescriptor>;
    onChanged(listener: (items: PermissionDescriptor[]) => void): Unsubscribe;
  };
  migration: {
    preview(): Promise<MigrationPreview>;
    start(input: { categories: string[]; confirmProviderSecrets: boolean }): Promise<MigrationResult>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: ImportProgress) => void): Unsubscribe;
  };
}
