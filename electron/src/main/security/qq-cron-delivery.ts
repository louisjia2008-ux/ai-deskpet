import type { ChatCronSchedule, ChatCronState } from '../../shared/chat-cron';
import type { QqOutboxItem } from '../../shared/qq-channel';

/** Result delivery is still an action of the approved run. A completed model
 * reply alone does not authorize sending after cancellation or revision changes. */
export const assertQqCronDelivery = (item: QqOutboxItem, state: ChatCronState,
  assertSchedule: (schedule: ChatCronSchedule) => void, assertRunning: (runId: string) => void): void => {
  const schedule = state.chatCronSchedules.find(value => value.id === item.scheduleId);
  const run = state.chatCronRuns.find(value => value.id === item.runId);
  if (!schedule || !run || item.kind !== 'cron' || schedule.revision !== item.scheduleRevision || run.scheduleId !== schedule.id
    || run.scheduleRevision !== item.scheduleRevision || !['running', 'succeeded'].includes(run.status)
    || schedule.sessionId !== item.authority.sessionId || run.sessionId !== item.authority.sessionId
    || schedule.channel?.bindingId !== item.authority.bindingId || schedule.channel.senderId !== item.authority.senderId
    || schedule.channel.approval?.authorityId !== item.authority.authorityId) throw new Error('qq.disclosureBlocked');
  assertSchedule(schedule);
  if (run.status === 'running') assertRunning(run.id);
};
