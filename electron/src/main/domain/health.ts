import type { HealthItem, HealthSnapshot } from '../../shared/attention';
import type { ChatCronRun, ChatCronSchedule } from '../../shared/chat-cron';
import type { KnowledgeStatus } from '../../shared/knowledge';
import type { MemorySleepStatus } from '../../shared/memory-sleep';
import type { QqChannelStatus } from '../../shared/qq-channel';
import type { TelegramChannelStatus } from '../../shared/telegram-channel';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import type { AutomaticTrigger, ProactivePolicy } from '../../shared/automation';
import { proactiveDayKey } from './proactive-policy';

export interface HealthInputs {
  now: Date;
  autoMemory: { enabled: boolean } & Pick<HealthItem, 'lastSuccessAt' | 'lastFailureAt' | 'errorCode' | 'failures'>;
  memorySleep: MemorySleepStatus;
  knowledge: KnowledgeStatus | null;
  schedules: ChatCronSchedule[];
  runs: ChatCronRun[];
  /** null where the WeChat bridge cannot run. */
  wechat: WeChatChannelState | null;
  qq: QqChannelStatus;
  telegram: TelegramChannelStatus;
  background?: HealthItem[];
}

const WEEK = 7 * 24 * 60 * 60_000;
const latest = (values: Array<string | null>): string | null => values.reduce<string | null>((top, value) => value !== null && (top === null || value > top) ? value : top, null);

/** A committed model result is not a successful channel delivery when its
 * publication callback recorded a failure or an uncertain transport receipt. */
export function proactiveHealth(input: { policy: ProactivePolicy; triggers: readonly AutomaticTrigger[]; now: number;
  errorCode: string | null; lastFailureAt: string | null; pausedByError: boolean }): HealthItem {
  const triggers = input.triggers.filter(trigger => trigger.kind === 'proactive').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const failed = triggers.filter(trigger => trigger.errorCode), success = triggers.filter(trigger => trigger.publishedAt && !trigger.errorCode);
  const errorCode = input.errorCode ?? (input.pausedByError ? 'proactive.pausedByError' : triggers.at(-1)?.errorCode ?? null);
  const lastSuccessAt = latest(success.map(trigger => trigger.publishedAt ?? null));
  return { feature: 'proactive', state: !input.policy.enabled ? 'off' : errorCode ? 'failing' : lastSuccessAt ? 'ok' : 'waiting',
    errorCode, lastSuccessAt, lastFailureAt: latest([input.lastFailureAt, ...failed.map(trigger => trigger.updatedAt)]),
    failures: errorCode ? 1 : 0, sinceLaunch: false,
    remainingToday: Math.max(0, input.policy.dailyLimit - triggers.filter(trigger => proactiveDayKey(Date.parse(trigger.createdAt), input.policy.timezone)
      === proactiveDayKey(input.now, input.policy.timezone)).length) };
}
const item = (feature: HealthItem['feature'], state: HealthItem['state'], rest: Partial<Omit<HealthItem, 'feature' | 'state'>> = {}): HealthItem =>
  ({ feature, state, lastSuccessAt: null, lastFailureAt: null, errorCode: null, failures: 0, sinceLaunch: false, ...rest });

const autoMemory = ({ enabled, ...attempts }: HealthInputs['autoMemory']): HealthItem => {
  if (!enabled) return item('auto-memory', 'off', { sinceLaunch: true });
  const failing = attempts.lastFailureAt !== null && (attempts.lastSuccessAt === null || attempts.lastFailureAt > attempts.lastSuccessAt);
  return item('auto-memory', failing ? 'failing' : attempts.lastSuccessAt ? 'ok' : 'waiting', { ...attempts, sinceLaunch: true });
};

const memorySleep = (status: MemorySleepStatus): HealthItem => {
  if (!status.settings.enabled) return item('memory-sleep', 'off');
  const rest = { lastSuccessAt: status.lastRunAt, lastFailureAt: status.lastFailureAt ?? null, errorCode: status.lastError, failures: status.lastError ? 1 : 0 };
  return item('memory-sleep', status.lastError ? 'failing' : status.lastRunAt ? 'ok' : 'waiting', rest);
};

const schedules = (all: ChatCronSchedule[], runs: ChatCronRun[], now: Date): HealthItem => {
  const active = all.filter((schedule) => schedule.enabled && !schedule.cancelledAt);
  if (!active.length) return item('schedules', 'off');
  const ids = new Set(active.map((schedule) => schedule.id));
  // A missed run means the Mac was off or asleep; it is not a fault of the schedule.
  const finished = runs.filter((run) => ids.has(run.scheduleId) && (run.status === 'succeeded' || run.status === 'failed' || run.status === 'interrupted'));
  const failed = finished.filter((run) => run.status !== 'succeeded');
  const when = (run: ChatCronRun): string => run.finishedAt ?? run.startedAt ?? run.createdAt;
  // Each schedule is judged by its own latest run, so a healthy one cannot hide a broken one.
  const broken = active.map((schedule) => finished.filter((run) => run.scheduleId === schedule.id).sort((a, b) => when(b).localeCompare(when(a)))[0])
    .filter((run): run is ChatCronRun => run !== undefined && run.status !== 'succeeded');
  const newestFailure = failed.sort((a, b) => when(b).localeCompare(when(a)))[0];
  return item('schedules', broken.length ? 'failing' : finished.length ? 'ok' : 'waiting', {
    lastSuccessAt: latest(finished.filter((run) => run.status === 'succeeded').map(when)),
    lastFailureAt: newestFailure ? when(newestFailure) : null,
    errorCode: broken.length ? (broken[0]!.errorCode ?? `cron.${broken[0]!.status}`) : null,
    failures: failed.filter((run) => now.getTime() - Date.parse(when(run)) <= WEEK).length,
  });
};

const wechat = (state: WeChatChannelState | null): HealthItem => {
  if (!state?.configured || state.paused) return item('wechat', 'off');
  const uncertain = state.uncertain + state.groups.reduce((total, group) => total + group.uncertain, 0);
  if (state.stale || state.state === 'stopped') {
    return item('wechat', 'failing', { errorCode: state.stale ? 'wechat.stale' : 'wechat.stopped', failures: uncertain });
  }
  if (state.sendReason) return item('wechat', 'failing', { errorCode: `wechat.${state.sendReason}`, failures: uncertain });
  if (state.state === 'degraded') {
    const code = state.privateStatus && state.privateStatus !== 'ready' ? `wechat.${state.privateStatus}`
      : state.groups.some(group => group.status === 'rich_reply_unavailable') ? 'wechat.rich_reply_unavailable' : 'wechat.degraded';
    return item('wechat', 'failing', { errorCode: code, failures: uncertain });
  }
  if (uncertain) return item('wechat', 'failing', { errorCode: 'wechat.uncertain', failures: uncertain });
  if (state.dropped) {
    return item('wechat', 'failing', { errorCode: 'wechat.dropped', failures: state.dropped,
      lastFailureAt: state.droppedAt ? new Date(state.droppedAt * 1000).toISOString() : null });
  }
  return item('wechat', state.state === 'running' ? 'ok' : 'waiting');
};

const remote = (feature: 'qq' | 'telegram', status: QqChannelStatus | TelegramChannelStatus): HealthItem => {
  if (!status.enabled || ('stopped' in status && status.stopped)) return item(feature, 'off');
  const failedOutbox = 'failedOutbox' in status ? status.failedOutbox : 0;
  const unconfirmed = failedOutbox + status.uncertainOutbox;
  if (status.connection === 'offline') return item(feature, 'failing', { errorCode: status.lastError ?? `${feature}.offline`, failures: unconfirmed, connectionOffline: true });
  if (unconfirmed) return item(feature, 'failing', { errorCode: failedOutbox ? `${feature}.deliveryFailed` : `${feature}.uncertain`, failures: unconfirmed });
  return item(feature, status.connection === 'online' ? 'ok' : 'waiting');
};

const friendReplies = (channel: WeChatChannelState | null): HealthItem[] =>
  (channel?.friendStatuses ?? []).map(({ status, uncertain }, index) => {
    const errorCode = uncertain ? 'wechat.friend_send_uncertain' : status.startsWith('friend_') ? `wechat.${status}` : null;
    const off = !channel?.configured || channel.paused || status === 'paused';
    return item('wechat-friend-reply', off ? 'off' : errorCode ? 'failing' : status === 'ready' ? 'ok' : 'waiting',
      { ordinal: index + 1, errorCode: off ? null : errorCode, failures: off ? 0 : errorCode ? Math.max(1, uncertain) : 0 });
  });

const KNOWLEDGE_INDEX_ERRORS = new Set([
  'knowledge.cancelled', 'knowledge.embeddingBatch', 'knowledge.embeddingModelMissing', 'knowledge.embeddingNotLocal',
  'knowledge.embeddingStillLoaded', 'knowledge.invalidEmbeddingResponse', 'knowledge.localModelBusy',
  'knowledge.ollamaRejected', 'knowledge.ollamaUnavailable', 'knowledge.readFailed', 'knowledge.residencyUnknown',
  'knowledge.rootChanged', 'knowledge.storageUnavailable',
]);
const isoTime = (value: string | null): string | null => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const knowledge = (status: KnowledgeStatus | null, now: Date): HealthItem => {
  if (!status?.vaultName) return item('knowledge', 'off');
  const lastSuccessAt = isoTime(status.lastIndexedAt), lastFailureAt = isoTime(status.lastIndexFailureAt);
  const failures = status.consecutiveIndexFailures;
  const retainedInvalidDiaries = status.retainedInvalidDiaries;
  let errorCode: string | null = null;
  if (status.embeddingStatus === 'missing') errorCode = 'knowledge.embeddingModelMissing';
  else if (status.lastError) {
    errorCode = KNOWLEDGE_INDEX_ERRORS.has(status.lastError)
      && (status.lastError !== 'knowledge.embeddingModelMissing' || status.embeddingStatus === 'unknown')
      ? status.lastError : 'knowledge.indexFailed';
  } else if (lastSuccessAt && now.getTime() - Date.parse(lastSuccessAt) > 24 * 60 * 60_000) {
    errorCode = 'knowledge.indexStale';
  }
  return item('knowledge', errorCode ? 'failing' : lastSuccessAt ? 'ok' : 'waiting', {
    lastSuccessAt, lastFailureAt, failures, errorCode,
    ...(Number.isSafeInteger(retainedInvalidDiaries) && retainedInvalidDiaries > 0 ? { retainedInvalidDiaries } : {}),
  });
};

export const buildHealth = (inputs: HealthInputs): HealthSnapshot => {
  const items = [autoMemory(inputs.autoMemory), memorySleep(inputs.memorySleep), schedules(inputs.schedules, inputs.runs, inputs.now),
    wechat(inputs.wechat), ...friendReplies(inputs.wechat), remote('qq', inputs.qq), remote('telegram', inputs.telegram), knowledge(inputs.knowledge, inputs.now), ...(inputs.background ?? [])];
  return { checkedAt: inputs.now.toISOString(), items, issues: items.filter((entry) => entry.state === 'failing').length };
};
