import { z } from 'zod';

export const speakingStyleSchema = z.object({
  tone: z.enum(['warm', 'neutral', 'playful', 'direct']),
  length: z.enum(['brief', 'balanced', 'detailed']),
  sentences: z.enum(['short', 'mixed']),
  emoji: z.enum(['none', 'light']),
  phrases: z.array(z.string().trim().min(1).max(16)).max(3).default([]),
}).strict();
export type SpeakingStyle = z.infer<typeof speakingStyleSchema>;
export interface ImportedMessage {
  id: string; speakerId: string; speaker: string; text: string; time: string | null;
  sourceEventId?: string | undefined; sourceEntityId?: string | undefined;
  sourceIdentity?: 'native' | 'transcript' | undefined; sourceCollectionId?: string | undefined;
}
export interface ImportPreview { id: string; name: string; format: string; messages: ImportedMessage[]; skipped: number }
export interface DistilledMemory { id: string; text: string; evidenceIds: string[]; savedMemoryId: string | null }
export interface ConversationDistillation {
  id: string; createdAt: string; providerName: string; speakerId: string; speaker: string; isUser: boolean;
  sourceMessageIds: string[]; style: SpeakingStyle; memories: DistilledMemory[]; styleApplied: boolean;
  baseMemoryRevision?: number | undefined;
}
export interface ImportedConversation extends ImportPreview { createdAt: string; draft: ConversationDistillation | null }
export interface ActiveSpeakingStyle { importId: string; draftId: string; name: string; enabled: boolean; style: SpeakingStyle }
export interface ImportState { records: ImportedConversation[]; activeStyle: ActiveSpeakingStyle | null }
export interface DistillInput { id: string; speakerId: string; isUser: boolean; messageIds: string[]; providerId: string }
export interface ApplyDistillationInput { id: string; draftId: string; memories: Array<{ id: string; text: string }>; applyStyle: boolean }
