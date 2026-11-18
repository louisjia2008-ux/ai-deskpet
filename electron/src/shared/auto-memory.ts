/** Learning about the owner from what they say, without being asked to remember it. */
export interface AutoMemoryStatus { enabled: boolean }
export interface AutoMemoryAPI {
  status(): Promise<AutoMemoryStatus>;
  configure(input: { enabled: boolean }): Promise<AutoMemoryStatus>;
}
