import type { BackgroundJobStatus } from './background-jobs';
import type { ContextPrivacy } from './contracts';
import type { CheckResult, Requirement } from './delegation-checks';
export interface DelegationDraft { sessionId: string; intentVersion: number; goal: string; currentBatchId: string | null }
export interface DelegationSubmit {
  operationId: string; sessionId: string; intentVersion: number; goal: string; deadlineAt: string;
  /** Legacy input retained for exact operation replay; token values never limit execution. */
  budget?: { maxEstimatedTokens: number; maxRequests: number } | undefined;
  children: Array<{ instruction: string; material: string; privacy: ContextPrivacy; providerId: string; model: string; requirements: Requirement[] }>;
}
export interface DelegationReservation { reservedTokens: number; chargedTokens: number; state: 'reserved' | 'settled' | 'released' | 'unknown' | 'overrun'; reportedTokens: number | null }
export type DelegationStatus = 'active' | 'completed' | 'partial' | 'cancelled' | 'expired' | 'interrupted' | 'historical';
export interface DelegationBatch {
  id: string; profileId: string; sessionId: string; operationId: string; intentVersion: number; goal: string;
  deadlineAt: string; createdAt: string; cancelRequestedAt: string | null; historicalAt: string | null;
  status: DelegationStatus;
  budget: { maxEstimatedTokens: number; maxRequests: number; settledTokens: number; outstandingTokens: number; releasedTokens: number; reservedRequests: number };
  children: Array<{ id: string; jobId: string; sessionId: string; instruction: string; providerName: string; model: string;
    status: BackgroundJobStatus; completionReason: string | null; finishReason: string | null;
    checks: Array<Pick<CheckResult, 'id' | 'kind' | 'status'>>; factVerification: 'unverified'; reservation: DelegationReservation }>;
}
export interface DelegationResult {
  batchId: string; childId: string; sessionId: string; status: BackgroundJobStatus; completionReason: string | null;
  finishReason: string | null; result: string | null; checks: CheckResult[]; factVerification: 'unverified'; historical: boolean;
}
/** Only an explicit user submit handler invokes the host draft API. Never scan generated text. */
export const parseDelegationCommand = (text: string): string | null => {
  const match = /^委派文本任务[：:]\s*([\s\S]+)$/u.exec(text.trim());
  return match && match[1]!.trim().length > 0 ? match[1]!.trim() : null;
};
