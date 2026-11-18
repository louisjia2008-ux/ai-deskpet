import type { QQ_CHANNEL_POLICY_VERSION } from './qq-channel';

import type { QqCronApproval } from './qq-channel';
export const CHAT_CRON_CAPABILITIES = ['web.search', 'web.read', 'workspace.write', 'math.calculate', 'time.read'] as const;
export type ChatCronCapability = typeof CHAT_CRON_CAPABILITIES[number];
export interface ChatCronBinding { sessionId: string; providerId: string; model: string }
/** Present when the schedule was created from a bound QQ channel; execution and
 * delivery then carry QQ restrictions for the schedule's lifetime. */
export interface ChatCronChannelRef { kind: 'qq'; bindingId: string; senderId: string; policyVersion: 1 | typeof QQ_CHANNEL_POLICY_VERSION; approval?: QqCronApproval | undefined }
export interface ChatCronInput {
  title: string;
  instruction: string;
  expression: string;
  timezone: string;
  allowedCapabilities: ChatCronCapability[];
  missedPolicy: 'skip' | 'run-once';
}
export type ChatCronUpdate = Partial<Omit<ChatCronInput, 'allowedCapabilities'>> & Pick<ChatCronInput, 'allowedCapabilities'>;
export interface ChatCronSchedule extends ChatCronBinding, ChatCronInput {
  id: string;
  enabled: boolean;
  revision: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  channel?: ChatCronChannelRef | undefined;
  telegramDelivery?: { bindingId: string; revision: number; grantedAt: string } | undefined;
  /** The owner's choice to also send this desktop schedule's results to their own QQ private chat. */
  qqDelivery?: { bindingId: string; revision: number; grantedAt: string } | undefined;
}
export type ChatCronRunStatus = 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'missed';
export interface ChatCronRun {
  id: string;
  key: string;
  scheduleId: string;
  sessionId: string;
  scheduleRevision: number;
  dueAt: string;
  status: ChatCronRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}
export interface ChatCronState {
  chatCronSchedules: ChatCronSchedule[];
  chatCronRuns: ChatCronRun[];
  chatSessions: Array<{ id: string; channelBindingId?: string | undefined; archivedAt?: string | null | undefined; deletedAt?: string | null | undefined }>;
}
export interface ChatCronStore {
  snapshot(): ChatCronState;
  transaction<T>(mutation: (state: ChatCronState) => T | Promise<T>): Promise<T>;
}
