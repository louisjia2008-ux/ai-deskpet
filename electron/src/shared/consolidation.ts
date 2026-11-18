import { z } from 'zod';
import type { BackgroundJob } from './background-jobs';
import type { ContextPrivacy, ContextScope, MemorySourceReference } from './contracts';

const id = z.string().uuid();
export const consolidationCandidateSchema = z.object({
  segments: z.array(z.object({ text: z.string().trim().min(1).max(6000), sourceIds: z.array(id).min(1).max(20) }).strict()).min(1).max(40),
  coveredMemoryIds: z.array(id).min(1).max(20),
  uncoveredMemoryIds: z.array(id).max(20),
  conflicts: z.array(z.string().trim().min(1).max(2000)).max(20),
}).strict();
export type ConsolidationCandidate = z.infer<typeof consolidationCandidateSchema>;
export interface ConsolidationSource {
  id: string; revision: number; fingerprint: string; text: string; tags: string[];
  privacy: ContextPrivacy; scope: ContextScope; sourceReferences: MemorySourceReference[]; sourceEventIds: string[];
  selectionVersion: number;
}
export interface ConsolidationPreviewInput { operationId: string; sessionId: string; memoryIds: string[]; providerId: string; model: string }
export interface ConsolidationEditInput { id: string; operationId: string; expectedVersion: number; candidate: ConsolidationCandidate }
export interface ConsolidationApplyInput { id: string; operationId: string; expectedVersion: number; fidelityReviewed: true; enableRepresentation: boolean }
export interface ConsolidationBatch {
  id: string; sessionId: string; status: 'draft' | 'generating' | 'review' | 'applied' | 'disabled' | 'invalid' | 'failed' | 'cancelled';
  sources: ConsolidationSource[]; candidate: ConsolidationCandidate | null; candidateVersion: number;
  binding: BackgroundJob['binding']; budget: { inputEstimate: number; maxInputTokens: number; maxOutputTokens: number };
  createdAt: string; updatedAt: string; jobId: string | null; jobStatus: BackgroundJob['status'] | null;
  completionReason: string | null; invalidReason: string | null; active: boolean;
  request: BackgroundJob['request']; rawResponse: string | null;
  receipts: Array<{ operationId: string; kind: string; version: number; committedAt: string }>;
}
export interface MemoryRepresentationTrace {
  batchId: string; candidateVersion: number; sourceIds: string[]; representation: 'summary' | 'original'; reason: string;
}
