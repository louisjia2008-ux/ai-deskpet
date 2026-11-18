import type { ChatWorkTask, ChatHistoryHit, ChatHistoryReadPage, ChatArtifactSearch, ChatArtifactPage, ChatArtifactReference, ChatArtifactPreview, ChatArtifactEntry } from './chat-work';
import type { ChatCronCapability, ChatCronSchedule } from './chat-cron';
import type { Unsubscribe } from './contracts';
export interface ChatWorkPanelApi {
  list(sessionId: string): Promise<ChatWorkTask[]>;
  get(sessionId: string, id: string): Promise<ChatWorkTask | null>;
  openArtifact(input: {sessionId: string; taskId: string; path: string}): Promise<void>;
  searchArtifacts(input: ChatArtifactSearch): Promise<ChatArtifactPage>;
  previewArtifact(input: ChatArtifactReference): Promise<ChatArtifactPreview>;
  exportArtifactPdf(input: ChatArtifactReference): Promise<ChatArtifactEntry>;
  searchHistory(input: {sessionId: string; query: string; targetSessionId?: string; limit?: number}): Promise<ChatHistoryHit[]>;
  readHistory(input: {sessionId: string; messageId: string; offset?: number; maxCharacters?: number}): Promise<ChatHistoryReadPage | null>;
  listCron(sessionId: string): Promise<ChatCronSchedule[]>;
  pauseCron(input: {sessionId: string; id: string}): Promise<void>;
  resumeCron(input: {sessionId: string; id: string; expectedRevision:number; allowedCapabilities:ChatCronCapability[]}): Promise<void>;
  cancelCron(input: {sessionId: string; id: string}): Promise<void>;
  onChanged(listener: () => void): Unsubscribe;
}
