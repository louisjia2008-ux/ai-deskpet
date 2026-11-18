import type { ContextPrivacy, ContextTrace } from './contracts';

export type ChatWorkStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ChatWorkSource { url: string; title: string; sha256?: string | undefined }
export interface ChatWorkArtifact { path: string; bytes: number; sha256: string; derivedFrom?: { path: string; sha256: string; format: 'pdf-export' } | undefined }

/** A recorded output, never an arbitrary path supplied by the renderer. */
export interface ChatArtifactReference { sessionId: string; taskId: string; path: string; sha256: string }
export interface ChatArtifactEntry extends ChatArtifactReference {
  derivedFrom?: ChatWorkArtifact['derivedFrom'];
  bytes: number;
  sessionTitle: string;
  goal: string;
  updatedAt: string;
  status: ChatWorkStatus;
  archived: boolean;
}
export interface ChatArtifactSearch { query?: string | undefined; sessionId?: string | undefined; offset?: number | undefined; limit?: number | undefined }
export interface ChatArtifactPage { items: ChatArtifactEntry[]; total: number; nextOffset: number | null }
export type ChatArtifactPreview =
  | { artifact: ChatArtifactEntry; kind: 'markdown' | 'csv' | 'text'; text: string }
  | { artifact: ChatArtifactEntry; kind: 'pdf'; dataBase64: string }
  | { artifact: ChatArtifactEntry; kind: 'unsupported' };

/** Host-owned task record; tool evidence cannot be supplied by task.update. */
export interface ChatWorkTask {
  id: string;
  sessionId: string;
  runId: string;
  assistantMessageId: string;
  goal: string;
  status: ChatWorkStatus;
  privacy: ContextPrivacy;
  plan: string[];
  notes: string;
  nextStep: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  sources: ChatWorkSource[];
  artifacts: ChatWorkArtifact[];
  /** True if bounded evidence retention omitted an older entry. */
  evidenceTruncated: boolean;
  historyLookupReferences: NonNullable<ContextTrace['historyLookupReferences']>;
  /** Host-recorded dependencies, including public catalog metadata. */
  skillReferences?: Array<{ id: string; revision: number; digest: string }> | undefined;
}

export interface ChatWorkBegin {
  sessionId: string;
  runId: string;
  assistantMessageId: string;
  goal: string;
  privacy: ContextPrivacy;
}
export interface ChatWorkUpdate { plan?: string[] | undefined; notes?: string | undefined; nextStep?: string | undefined }
export interface ChatWorkContext { sessionId: string; destination: 'local' | 'remote' | 'unknown' }
export interface ChatWorkListOptions {
  destination?: ChatWorkContext['destination'] | undefined;
  status?: ChatWorkStatus | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}
export interface ChatWorkPage { items: ChatWorkTask[]; total: number; nextOffset: number | null }

export interface ChatHistorySearchInput {
  query: string;
  targetSessionId?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}
export interface ChatHistoryHit {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: string;
  snippet: string;
  /** Character offset of the literal snippet in the complete message. */
  offset: number;
  totalCharacters: number;
  sourceSHA256: string;
  privacy: ContextPrivacy;
}
export interface ChatHistorySearchPage { items: ChatHistoryHit[]; total: number; nextOffset: number | null; privacy: ContextPrivacy }
export interface ChatHistoryReadInput { messageId: string; offset?: number | undefined; maxCharacters?: number | undefined }
export interface ChatHistoryReadPage {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: string;
  text: string;
  offset: number;
  totalCharacters: number;
  nextOffset: number | null;
  truncated: boolean;
  sourceSHA256: string;
  privacy: ContextPrivacy;
}
