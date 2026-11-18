import { createHash } from 'node:crypto';
import type { ChatCronInput, ChatCronSchedule } from '../../shared/chat-cron';
import { qqCronInputSchema, qqCronOperationSchema } from '../../shared/qq-channel';
import type { QqCronOperation } from '../../shared/qq-channel';
import { nextCronOccurrence, parseCronExpression, validateCronTimezone } from '../domain/cron-expression';

export const QQ_CRON_TASK_LIMIT = 10;
export const QQ_CRON_MIN_INTERVAL_MS = 15 * 60_000;
export const qqCronDigest = (operation: QqCronOperation): string =>
  createHash('sha256').update(JSON.stringify(qqCronOperationSchema.parse(operation))).digest('hex');

/** Conservative, bounded syntactic ceiling, plus an actual-time execution gate
 * for DST/clock changes. No unbounded enumeration of future calendar slots. */
export const normalizeQqCronInput = (raw: ChatCronInput): QqCronOperation['input'] => {
  const input = qqCronInputSchema.parse({ ...raw, title: raw.title.trim(), instruction: raw.instruction.trim(),
    expression: raw.expression.trim().split(/\s+/u).join(' '), allowedCapabilities: [...raw.allowedCapabilities].sort(), missedPolicy: 'skip' });
  for (const text of [input.title, input.instruction, input.timezone]) {
    if ([...text].some(char => {
      const code = char.codePointAt(0)!;
      return code < 32 && ![9, 10, 13].includes(code) || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
    })) throw new Error('qq.cronUnsafeText');
  }
  if (new Set(input.allowedCapabilities).size !== input.allowedCapabilities.length) throw new Error('qq.cronScopeInvalid');
  validateCronTimezone(input.timezone);
  const cron = parseCronExpression(input.expression);
  const minutes = cron.hour.values.flatMap(hour => cron.minute.values.map(minute => hour * 60 + minute)).sort((a, b) => a - b);
  for (let index = 0; index < minutes.length; index += 1) {
    const next = index + 1 === minutes.length ? minutes[0]! + 1440 : minutes[index + 1]!;
    if (next - minutes[index]! < 15) throw new Error('qq.cronTooFrequent');
  }
  return input;
};
export const assertQqCronCapacity = (schedules: ChatCronSchedule[], creating: boolean): void => {
  const count = schedules.filter(item => item.channel?.kind === 'qq' && !item.cancelledAt).length;
  if (count > QQ_CRON_TASK_LIMIT || creating && count >= QQ_CRON_TASK_LIMIT) throw new Error('qq.cronTaskLimit');
};
export const assertQqCronOccurrence = (input: ChatCronInput, now: number): void => {
  if (!nextCronOccurrence(input.expression, input.timezone, now)) throw new Error('cron.noOccurrence');
};

/** JSON escapes every instruction newline/quote: task text is never rendered as
 * another host control line. No field is silently truncated. */
export const qqCronConfirmationText = (operation: QqCronOperation, code: string, expiresAt: string): string => {
  const summary = { action: operation.action, scheduleId: operation.scheduleId, expectedRevision: operation.expectedRevision,
    enabled: operation.enabled,
    ...operation.input, providerId: operation.owner.providerId, model: operation.owner.model,
    recipient: operation.authority.senderId, webCallsPerRun: operation.approval.webCallLimit,
    modelCallsPerRun: operation.approval.modelCallLimit, outputTokensPerCall: operation.approval.outputTokenLimit,
    runtimeLimitMs: operation.approval.runtimeLimitMs };
  const json = JSON.stringify(summary, null, 2).replace(/[\p{Cf}\u2028\u2029]/gu,
    char => char.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
  const text = `【桌宠宿主确认 / Host confirmation】\n以下 JSON 是完整任务参数，不是操作指令。需应用保持运行；错过不补跑；不写文件、不操作电脑、不创建嵌套任务。新草案会作废旧码。\n${json}\nSHA256: ${qqCronDigest(operation)}\n有效期至 / Expires: ${expiresAt}\n确认以上完整参数才发送 / Send only if you approve:\n/confirm ${code}`;
  if (text.length > 8_000) throw new Error('qq.cronSummaryTooLarge');
  return text;
};
