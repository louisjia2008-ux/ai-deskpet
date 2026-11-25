/** Learning about the owner from what they say, without being asked to remember it. */
export interface AutoMemoryStatus {
  enabled: boolean;
  /** A cheaper model the background memory tasks use for one provider; null when they use the chat model. */
  model?: { providerId: string; model: string } | null;
  /** The provider whose models can be chosen: the one chat uses now. */
  activeProviderId?: string | null;
}
export interface AutoMemoryAPI {
  status(): Promise<AutoMemoryStatus>;
  configure(input: { enabled: boolean }): Promise<AutoMemoryStatus>;
  setModel?(input: { model: { providerId: string; model: string } | null }): Promise<AutoMemoryStatus>;
}
