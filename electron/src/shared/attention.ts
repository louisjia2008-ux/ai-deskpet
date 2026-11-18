import type { DoctorStatus } from './doctor';
export type AttentionSource = 'background-job' | 'delegation' | 'consolidation' | 'proactive';
export type AttentionKind = 'action' | 'review' | 'result' | 'notice';
export type AttentionStatus = 'completed' | 'failed' | 'interrupted' | 'blocked' | 'mixed' | 'expired' | 'invalid' | 'review';
export interface AttentionTarget { kind: AttentionSource; id: string; sessionId: string | null }
export interface AttentionItem {
  id: string; fingerprint: string; source: AttentionSource; kind: AttentionKind;
  title: string; status: AttentionStatus; updatedAt: string; target: AttentionTarget;
  completedChildren: number; totalChildren: number;
  automaticIssue?: { occurrences: number; providerName: string; model: string; errorCode: string; firstAt: string };
}
/** Acknowledges one exact source revision, without changing the underlying work. */
export interface AttentionReceipt { id: string; fingerprint: string; acknowledgedAt: string }
export interface AttentionAcknowledge { id: string; fingerprint: string }
export interface AttentionSnapshot {
  items: AttentionItem[];
  counts: { action: number; review: number; result: number; notice?: number };
  runningCount: number; olderResults: number;
  sourceCounts: { backgroundJobs: number; delegations: number; consolidations: number };
}
/** Background features that run without the owner watching. */
export type HealthFeature = 'auto-memory' | 'memory-sleep' | 'schedules' | 'wechat' | 'qq' | 'telegram' | 'wechat-moments' | 'wechat-cron' | 'wechat-group-digest' | 'wechat-followup' | 'wechat-official-brief' | 'wechat-friends-moments' | 'wechat-friend-reply' | 'asr' | 'diary' | 'proactive' | 'knowledge';
/** off: not enabled; waiting: enabled, nothing attempted yet; failing: the latest attempt or connection is not working. */
export type HealthState = 'ok' | 'failing' | 'waiting' | 'off';
/** Codes, times and counts only. */
export interface HealthItem {
  feature: HealthFeature; state: HealthState;
  lastSuccessAt: string | null; lastFailureAt: string | null;
  errorCode: string | null;
  /** Failed attempts in a row, failed schedule runs in the last week, or messages whose delivery is unconfirmed. */
  failures: number;
  /** Confirmed parts and total parts of a failed multipart delivery, with no content. */
  deliveryProgress?: { sent: number; total: number };
  /** True when the times only cover the time since the app last started. */
  sinceLaunch: boolean;
  remainingToday?: number;
  /** Vault diary copies retained because the owner changed the file. */
  retainedInvalidDiaries?: number;
  /** Position in the listener's friend status list, with no contact identifier. */
  ordinal?: number;
  /** A failing item's revision, which 「知道了」 acknowledges. */
  fingerprint?: string;
  /** The owner acknowledged this exact problem; it no longer counts as an issue until it changes or grows. */
  acknowledged?: boolean;
}
/** `issues` counts failing items the owner has not acknowledged. */
export interface HealthSnapshot { checkedAt: string; items: HealthItem[]; issues: number }
export interface HealthAcknowledge { key: string; fingerprint: string }
export interface AttentionAPI {
  snapshot(): Promise<AttentionSnapshot>;
  health?(): Promise<HealthSnapshot>;
  acknowledgeHealth?(input: HealthAcknowledge): Promise<HealthSnapshot>;
  /** The doctor: a second agent that watches the background features and reports problems. */
  doctor?(): Promise<DoctorStatus>;
  setDoctor?(enabled: boolean): Promise<DoctorStatus>;
  checkDoctor?(): Promise<DoctorStatus>;
  testDoctorWeChat?(): Promise<DoctorStatus>;
  acknowledge(input: AttentionAcknowledge): Promise<void>;
  onChanged?(listener: () => void): () => void;
}
