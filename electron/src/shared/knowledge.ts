import type { KnowledgeEmbeddingModel, KnowledgeEmbeddingStatus } from './knowledge-embedding';

export type KnowledgePrivacy = 'cloud-allowed' | 'local-only';
export type KnowledgeDestination = 'local' | 'cloud' | 'remote';
export type KnowledgeSharing = 'local' | 'shareable';
export type KnowledgeNoteSource = 'desktop' | 'wechat' | 'qq' | 'telegram';

export const DEFAULT_KNOWLEDGE_DIARY_FOLDER = '日记';

export interface KnowledgeDiarySync {
  enabled: boolean;
  folder: string;
}

/** The in-process source for a Markdown diary copy. */
export interface KnowledgeDiaryCopy {
  date: string;
  createdAt: string;
  text: string;
}

export function isKnowledgeFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('.') &&
    !/[/\\\p{Cc}]/u.test(name) && !/^[a-z]:/iu.test(name);
}

export interface KnowledgeNoteDraft {
  title: string;
  markdown: string;
  folder?: string;
}

export interface KnowledgeSaveResult {
  path: string | null;
  privacy: KnowledgePrivacy;
}

export interface KnowledgeFolder {
  /** Null represents Markdown files directly inside the linked root. */
  name: string | null;
  sharing: KnowledgeSharing;
  writable: boolean;
  diaryProtected: boolean;
}

export interface KnowledgeHit {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  revision: string;
  score: number;
}
export interface KnowledgeStatus {
  vaultName: string | null;
  indexing: boolean;
  indexedNotes: number;
  indexedChunks: number;
  checkedNotes: number;
  skippedNotes: number;
  changedNotes: number;
  removedNotes: number;
  lastIndexedAt: string | null;
  lastIndexFailureAt: string | null;
  consecutiveIndexFailures: number;
  embeddingModel: KnowledgeEmbeddingModel;
  embeddingStatus: KnowledgeEmbeddingStatus;
  autoIndex: boolean;
  diarySync: KnowledgeDiarySync;
  retainedInvalidDiaries: number;
  lastError: string | null;
}
export interface KnowledgeQuestion {
  query: string;
  providerId: string;
  model: string;
}
export interface KnowledgeAnswer {
  answer: string;
  sources: KnowledgeHit[];
}
export interface KnowledgeAPI {
  getState(): Promise<KnowledgeStatus>;
  chooseVault(): Promise<KnowledgeStatus>;
  detach(): Promise<KnowledgeStatus>;
  reindex(): Promise<KnowledgeStatus>;
  listFolders(): Promise<KnowledgeFolder[]>;
  setFolderSharing(input: { folder: string | null; level: KnowledgeSharing }): Promise<KnowledgeFolder[]>;
  setWritableFolders(folders: string[]): Promise<KnowledgeFolder[]>;
  setEmbeddingModel(model: KnowledgeEmbeddingModel): Promise<KnowledgeStatus>;
  setAutoIndex(enabled: boolean): Promise<KnowledgeStatus>;
  setDiarySync(settings: KnowledgeDiarySync): Promise<KnowledgeStatus>;
  search(query: string): Promise<KnowledgeHit[]>;
  ask(input: KnowledgeQuestion): Promise<KnowledgeAnswer>;
}
