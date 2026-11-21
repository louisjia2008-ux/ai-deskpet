export interface CompanionRecentStatus {
  text: string;
  updatedAt: string | null;
  localOnly: boolean;
  containsLocal: boolean;
}

export interface CompanionRecentAPI {
  status(): Promise<CompanionRecentStatus>;
  onChanged(listener: () => void): () => void;
  clear(): Promise<CompanionRecentStatus>;
  setLocalOnly(localOnly: boolean): Promise<CompanionRecentStatus>;
}
