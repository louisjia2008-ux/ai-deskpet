import { z } from 'zod';

export const memoryRecallInputs = {
  /** Without a conversation, only general (not conversation-specific) memories are searched. */
  'memory-recall:search': z.object({ operationId: z.string().uuid(), sessionId: z.string().uuid().optional(), query: z.string().trim().min(1).max(3200) }).strict(),
  'memory-recall:cancel': z.object({ operationId: z.string().uuid() }).strict(),
};
export type MemoryRecallSearchInput = z.infer<typeof memoryRecallInputs['memory-recall:search']>;
export type MemoryRecallMode = 'semantic' | 'partial' | 'lexical';
export type MemoryRecallReason = 'ready' | 'limit' | 'unavailable' | 'backoff' | 'empty';
export type MemoryRecallUnavailableReason = 'model-busy' | 'model-missing' | 'not-local' | 'invalid-response' | 'unavailable';
export interface MemoryRecallSearchResult {
  query: string;
  mode: MemoryRecallMode;
  reason: MemoryRecallReason;
  unavailableReason?: MemoryRecallUnavailableReason;
  consideredCount: number;
  eligibleCount: number;
  matches: Array<{
    id: string;
    revision: number;
    text: string;
    tags: string[];
    privacy: 'local-only' | 'cloud-allowed';
    sourceCount: number;
    /** Only present for an actual semantic match, not a keyword fallback. */
    similarity?: number;
  }>;
}
export interface MemoryRecallAPI {
  search(input: MemoryRecallSearchInput): Promise<MemoryRecallSearchResult>;
  cancel(input: { operationId: string }): Promise<void>;
}
