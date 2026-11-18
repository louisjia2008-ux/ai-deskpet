/** Nightly tidying of what was learned during the day: merge, promote, let go. */
export interface MemorySleepSettings { enabled: boolean; hour: number; timezone: string }
export interface MemorySleepChange {
  id: string;
  kind: 'merge' | 'promote' | 'drop' | 'expire';
  /** What the entries said before; for a promotion, the entry itself. */
  before: string[];
  /** What remains afterwards, or null when nothing does. */
  after: string | null;
  undoneAt: string | null;
}
export interface MemorySleepReport { id: string; at: string; provider: string; changes: MemorySleepChange[] }
export interface MemorySleepStatus {
  settings: MemorySleepSettings;
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  /** Since launch only. */
  lastFailureAt?: string | null;
  shallow: number;
  deep: number;
  reports: MemorySleepReport[];
}
export interface MemorySleepAPI {
  status(): Promise<MemorySleepStatus>;
  configure(input: MemorySleepSettings): Promise<MemorySleepStatus>;
  runNow(): Promise<MemorySleepStatus>;
  undo(input: { reportId: string; changeId: string }): Promise<MemorySleepStatus>;
}
