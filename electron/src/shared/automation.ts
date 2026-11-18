import type { BackgroundJob, BackgroundJobInput } from './background-jobs';
import type { ContextPrivacy, ProviderConfig } from './contracts';

/** Host-owned v1 contract. Feature copies must not implement alternate IPC/storage. */
export type UsageScope = 'chat' | 'background-job' | 'delegation' | 'consolidation' | 'schedule' | 'proactive' | 'other';
export type UsageCurrency = 'USD' | 'CNY';
export interface UsageLongContextPrice {
  inputThreshold: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number | null | undefined;
  cacheWriteInputPerMillion?: number | null | undefined;
}
/** A host-captured price, scoped to the endpoint that receives the request. */
export interface UsagePriceSnapshot {
  currency: UsageCurrency;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number | null | undefined;
  cacheWriteInputPerMillion?: number | null | undefined;
  longContext?: UsageLongContextPrice | undefined;
  source: 'reference' | 'provider-api' | 'manual';
  sourceUrl?: string | undefined;
  checkedAt: string;
  endpoint: string;
  note?: string | undefined;
}
export interface UsageEvent {
  requestId: string; ownerId: string; scope: UsageScope; batchId: string | null;
  providerId: string; model: string; preparedAt: string; dispatchedAt: string | null; terminalAt: string | null;
  phase: 'prepared' | 'fetch-invoked' | 'response-received' | 'terminal';
  outcome: 'completed' | 'failed' | 'aborted' | null;
  inputEstimate: number; maxOutputTokens: number;
  inputTokens: number | null; outputTokens: number | null;
  tokenSource: 'provider-reported' | 'unknown';
  reportedCostUSD: number | null;
  cachedInputTokens?: number | null | undefined;
  cacheWriteInputTokens?: number | null | undefined;
  reasoningOutputTokens?: number | null | undefined;
  tokenDetailsInvalid?: boolean | undefined;
  endpoint?: string | undefined;
  /** Frozen request-time price. Missing/null may use a separately labelled current reference. */
  priceSnapshot?: UsagePriceSnapshot | null | undefined;
  pricingUnavailableReason?: 'missing-rate' | 'endpoint-mismatch' | 'invalid-rate' | undefined;
}
export interface LegacyUsageRate { providerId: string; model: string; inputUSDPerMillion: number; outputUSDPerMillion: number; updatedAt: string }
export interface PricedUsageRate { providerId: string; model: string; price: UsagePriceSnapshot; updatedAt: string }
export type UsageRate = LegacyUsageRate | PricedUsageRate;
export interface UsageRateTarget { providerId: string; model: string }
/** The host binds this manual edit to the currently saved provider endpoint. */
export interface UsageRateInput extends UsageRateTarget {
  currency: UsageCurrency;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number | null | undefined;
  cacheWriteInputPerMillion?: number | null | undefined;
  longContext?: UsageLongContextPrice | undefined;
}
export interface UsageBudget { dailyRequestLimit: number; dailyTokenLimit: number }
export interface UsageSnapshot { events: UsageEvent[]; rates: UsageRate[]; budget?: UsageBudget }
export interface ReplySegment { id: string; text: string; expression: 'neutral' | 'happy' | 'curious' | 'reassuring' }

export type CalendarRule = { kind: 'once'; at: string } | { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; weekday: number };
export interface PersistentSchedule {
  id: string; title: string; instruction: string; material: string; privacy: ContextPrivacy; providerId: string; model: string;
  rule: CalendarRule; timezone: string; missedPolicy: 'skip' | 'run-once'; enabled: boolean;
  revision: number; createdAt: string; updatedAt: string; nextRunAt: string | null; cancelledAt: string | null;
}
export type PersistentScheduleInput = Omit<PersistentSchedule, 'revision' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'cancelledAt'>;
export type ProactiveMode = 'off' | 'observe' | 'auto';
export type ProactiveObservationReason = 'rules-matched' | 'disabled' | 'event-unselected' | 'invalid-event' | 'event-expired' | 'clock-before-event' | 'quiet' | 'cooldown' | 'daily-limit' | 'suspended' | 'locked' | 'busy' | 'hidden' | 'permission' | 'no-provider' | 'closed' | 'cancelled' | 'policy-changed' | 'observation-only';
export interface ProactiveObservation {
  id: string; eventId: string; kind: ProactiveEventKind; summary: string; occurredAt: string; observedAt: string;
  policyRevision: number; decision: 'would-act' | 'would-skip'; reason: ProactiveObservationReason;
}
/** Missing mode retains the exact legacy enabled/off behavior. */
export const proactiveMode = (policy: Pick<ProactivePolicy, 'enabled' | 'mode'>): ProactiveMode => policy.mode ?? (policy.enabled ? 'auto' : 'off');
export type ProactiveEventKind = 'task-completed' | 'focus-completed' | 'explicit-check-in';
export interface ProactivePolicy {
  enabled: boolean; mode?: ProactiveMode | undefined; revision: number; eventKinds: ProactiveEventKind[];
  quietStart: string; quietEnd: string; timezone: string; cooldownMinutes: number; dailyLimit: number;
  topics: string[]; privacy: ContextPrivacy; providerId: string | null; model: string;
}
export type ProactivePolicyInput = Omit<ProactivePolicy, 'revision'>;
export interface ProactiveEvent {
  id: string; kind: ProactiveEventKind; occurredAt: string; summary: string;
  status: 'pending' | 'consumed' | 'dismissed'; reason: string | null;
  observation?: { observedAt: string; policyRevision: number; matched: boolean } | undefined;
}
export interface AutomaticTrigger {
  id: string; key: string; kind: 'schedule' | 'proactive'; sourceId: string; dueAt: string;
  policyRevision: number; status: 'reserved' | 'submitted' | 'missed' | 'cancelled' | 'blocked' | 'unknown' | 'succeeded' | 'failed';
  publishedAt?: string | null | undefined;
  jobId: string | null; messageId: string | null; createdAt: string; updatedAt: string;
  cancelledAt: string | null; errorCode: string | null;
}
export interface AutomationState {
  automationSchedules: PersistentSchedule[]; automationTriggers: AutomaticTrigger[];
  proactivePolicy: ProactivePolicy; proactiveEvents: ProactiveEvent[];
  proactiveObservations?: ProactiveObservation[] | undefined;
}
export interface AutomationStore {
  snapshot(): AutomationState;
  transaction<T>(mutation: (draft: AutomationState) => T | Promise<T>): Promise<T>;
}
export interface AutomaticTaskPort {
  /** trigger.id is the one durable operationId. Never generate a new id on retry/restart. */
  submit(trigger: AutomaticTrigger, input: Omit<BackgroundJobInput, 'operationId'>): Promise<BackgroundJob>;
  cancel(jobId: string): Promise<void>;
  getByOperation(operationId: string): BackgroundJob | null;
}
export interface ProactiveEnvironment { suspended: boolean; locked: boolean; busy: boolean; visible: boolean; permission: boolean;
  lastInteractionAt?: string | null; fullscreen?: boolean }
export interface AutomationSnapshot extends AutomationState { jobs: BackgroundJob[] }
export interface AutomationAPI {
  snapshot(): Promise<AutomationSnapshot>;
  triggerResult(id: string): Promise<{triggerId: string; jobId: string; status: string; result: string | null}>;
  scheduleUpsert(input: PersistentScheduleInput): Promise<PersistentSchedule>;
  schedulePause(id: string): Promise<void>;
  scheduleCancel(id: string): Promise<void>;
  scheduleRunNow(input: { id: string; operationId: string }): Promise<AutomaticTrigger>;
  schedulePreview(input: { rule: CalendarRule; timezone: string; after: string; count: number }): Promise<string[]>;
  configureProactive(input: ProactivePolicyInput): Promise<ProactivePolicy>;
  explicitCheckIn(input: { operationId: string }): Promise<void>;
  cancelTrigger(id: string): Promise<void>;
}
/** Price edits affect future requests and labelled legacy estimates, never admission. */
export interface UsageAPI {
  snapshot(): Promise<UsageSnapshot>;
  upsertRate?(input: UsageRateInput): Promise<UsageSnapshot>;
  removeRate?(input: UsageRateTarget): Promise<UsageSnapshot>;
}
export interface AutomationUIProps { api: AutomationAPI; providers: ProviderConfig[]; locale: string }
