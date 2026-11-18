import type { ContextPrivacy, ProviderConfig, ProviderRequestObservation } from './contracts';

export interface BackgroundJobInput {
  operationId: string;
  instruction: string;
  material: string;
  privacy: ContextPrivacy;
  providerId: string;
  model: string;
}
export type BackgroundJobStatus = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked';
export interface BackgroundJob {
  id: string;
  profileId: string;
  operationId: string;
  specDigest: string;
  attemptId: string;
  origin: 'background-jobs';
  /** Written only by host automatic-task submission, never accepted in renderer job input. */
  automaticTriggerId?: string | undefined;
  /** Host-only provenance for an explicitly invoked local skill. */
  skillId?: string | undefined;
  consolidation?: { batchId: string } | undefined;
  delegation?: { batchId: string; childId: string; sessionId: string; parentSessionId: string; intentVersion: number; deadlineAt: string } | undefined;
  resultOwner: string;
  instruction: string;
  material: string;
  source: { kind: 'explicit-paste'; actionId: string; privacy: ContextPrivacy };
  binding: { provider: ProviderConfig; model: string; digest: string; credentialRef: string; destination: 'local' | 'remote' | 'unknown'; limits: { ollamaNumCtx?: number | undefined; wireProtocol?: 'responses' | undefined; maxOutputTokens: number; outputTokenParameter: 'max_tokens' | 'max_completion_tokens'; reasoningEffort?: 'none' | undefined; contextBudget: { contextWindowTokens: number; safetyMarginTokens: number; capacitySource: 'configured' | 'provider-reported' | 'conservative-fallback' | 'application-limit' } } };
  status: BackgroundJobStatus;
  executionOwner: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completionReason: string | null;
  result: string | null;
  request: null | {
    requestId: string; bodySHA256: string; inputEstimate: number; maxInputTokens: number;
    maxOutputTokens: number; capacitySource: string; dispatchIntentAt: string;
    observations: Array<ProviderRequestObservation & { observedAt: string }>;
  };
  receipts: Array<{ operationId: string; kind: 'accepted' | 'dispatch-intent' | 'cancel' | 'terminal'; committedAt: string; status: BackgroundJobStatus }>;
}
