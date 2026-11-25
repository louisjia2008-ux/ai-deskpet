import { z } from 'zod';

/** Learning about the owner from what they say, without being asked to remember it. */
export interface AutoMemoryStatus {
  enabled: boolean;
  /** A cheaper model the background memory tasks use for one provider; null when they use the chat model. */
  model?: { providerId: string; model: string } | null;
  /** The provider whose models can be chosen: the default one chat uses now. */
  activeProviderId?: string | null;
  activeProviderName?: string | null;
}
export interface AutoMemoryAPI {
  status(): Promise<AutoMemoryStatus>;
  configure(input: { enabled: boolean }): Promise<AutoMemoryStatus>;
  setModel?(input: { model: { providerId: string; model: string } | null }): Promise<AutoMemoryStatus>;
}

/** The same model identifier rule as a provider's model catalog, so anything listed can be chosen. */
export const backgroundModelIdSchema = z.string().min(1).max(240).refine((value) => value.trim() === value
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'Use a model identifier.');
