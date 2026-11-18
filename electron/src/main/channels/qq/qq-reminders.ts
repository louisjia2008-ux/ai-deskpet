import { createHash, randomUUID } from 'node:crypto';
import type { QqAuthority, QqChannelState, QqOutboxItem } from '../../../shared/qq-channel';
import { parseDirectToolCommand, timerNumber } from '../../domain/direct-tool-command';

export const REMINDER_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const HELP =
  '可以跟我说“十分钟后提醒我喝水”，或“明早八点半提醒我出门”。想改主意就说“取消刚才那条提醒”。发“我的提醒”可以看时间和编号。';

type ReminderCommand =
  | { kind: 'create'; due: number; label: string; afterSeconds?: number }
  | { kind: 'cancel'; id: string }
  | { kind: 'cancel-latest' }
  | { kind: 'cancel-label'; label: string }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'invalid-time' };

/** Only complete owner-authored commands enter the scheduler, never assistant
 * output, group messages, desktop timers or the contents of a workspace. */
export function parseQqReminder(text: string, now: Date): ReminderCommand | null {
  const query = text.trim();
  if (/^(?:\/reminders|查看提醒|我的提醒|提醒列表)$/iu.test(query)) return { kind: 'list' };
  const cancel = /^(?:\/cancel-reminder\s+|取消提醒\s*)([0-9a-f]{8})$/iu.exec(query);
  if (cancel) return { kind: 'cancel', id: cancel[1]!.toLowerCase() };
  if (/^(?:请)?(?:帮我)?取消(?:刚才|刚刚)那条(?:提醒)?[。！!]?$/u.test(query)) return { kind: 'cancel-latest' };
  const named = /^(?:请)?(?:帮我)?取消([^\r\n?？]{1,120}?)(?:的)?提醒[。！!]?$/u.exec(query);
  if (named?.[1]?.trim()) return { kind: 'cancel-label', label: named[1].trim() };
  const direct = parseDirectToolCommand(query);
  if (direct?.toolId === 'timer.create')
    return { kind: 'create', due: now.getTime() + direct.input.seconds * 1000, label: direct.input.label, afterSeconds: direct.input.seconds };
  const relative = /^\/remind\s+(\d{1,6})([smhd])\s+([^\r\n]{1,120})$/iu.exec(query);
  if (relative) {
    const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    const seconds = Number(relative[1]) * units[relative[2]!.toLowerCase()]!;
    const label = relative[3]!.trim();
    return seconds > 0 && seconds <= 30 * 86400 && label
      ? { kind: 'create', due: now.getTime() + seconds * 1000, label, afterSeconds: seconds }
      : { kind: 'help' };
  }
  const absolute =
    /^(?:请)?(?:在)?(今天|明天|今晚|明早|明晚)\s*(?:(\d{1,2})[:：](\d{2})|([\d一二两三四五六七八九十]{1,3})点(?:(半)|([\d一二三四五六七八九十]{1,3})分)?)\s*提醒我\s*([^\r\n]{1,120})$/u.exec(
      query,
    );
  if (absolute) {
    let hour = absolute[2] ? Number(absolute[2]) : timerNumber(absolute[4]!);
    const minute = absolute[3]
      ? Number(absolute[3])
      : absolute[5]
        ? 30
        : absolute[6]
          ? timerNumber(absolute[6])
          : 0;
    const label = absolute[7]!
      .trim()
      .replace(/[。！!]$/u, '')
      .trim();
    if (/[?？]|(?:请问|可以|是否|能否|吗)[。！!]?$/u.test(query)) return null;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59 || !label)
      return { kind: 'invalid-time' };
    if (absolute[1]!.endsWith('晚') && hour >= 1 && hour <= 11) hour += 12;
    if (absolute[1] === '明早' && hour >= 12) return { kind: 'invalid-time' };
    const due = new Date(now);
    if (absolute[1]!.startsWith('明')) due.setDate(due.getDate() + 1);
    due.setHours(hour, minute, 0, 0);
    return due.getTime() > now.getTime() && due.getHours() === hour && due.getMinutes() === minute
      ? { kind: 'create', due: due.getTime(), label }
      : { kind: 'invalid-time' };
  }
  return /^\/(?:remind(?:ers)?|cancel-reminder)(?:\s|$)/iu.test(query) ? { kind: 'help' } : null;
}

function appendQqOutbox(state: QqChannelState, ...items: QqOutboxItem[]): void {
  while (state.outbox.length + items.length > 200) {
    const i = state.outbox.findIndex((row) => row.status === 'sent' || row.status === 'discarded');
    if (i < 0) throw new Error('qq.outboxFull');
    state.outbox.splice(i, 1);
  }
  state.outbox.push(...items);
}

// Leave the stored reminder text in its original version-two form. It is the
// owner's label, not the voice we have to use on the wire.
const storedPrefix = '提醒：';
function reminderLabel(item: QqOutboxItem): string {
  return item.content.startsWith(storedPrefix) ? item.content.slice(storedPrefix.length) : item.content;
}

function spokenNumber(n: number): string {
  const digits = '零一二三四五六七八九';
  if (n < 10) return digits.charAt(n);
  if (n >= 100) return String(n);
  return (n < 20 ? '' : digits.charAt(Math.floor(n / 10))) + '十' + (n % 10 ? digits.charAt(n % 10) : '');
}

function durationPhrase(seconds: number): string {
  const [count, unit] = seconds % 3600 === 0 ? [seconds / 3600, '小时'] as const
    : seconds % 60 === 0 ? [seconds / 60, '分钟'] as const : [seconds, '秒'] as const;
  return (count === 2 ? '两' : spokenNumber(count)) + unit + '后';
}

function dayName(due: Date, now: Date): string {
  const sameDay = (date: Date) => due.toDateString() === date.toDateString();
  if (sameDay(now)) return '今天';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(tomorrow)) return '明天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(yesterday)) return '昨天';
  return (due.getFullYear() === now.getFullYear() ? '' : due.getFullYear() + '年') +
    (due.getMonth() + 1) + '月' + due.getDate() + '日';
}

function clockPhrase(due: Date, now: Date): string {
  const hours = due.getHours(), minutes = due.getMinutes();
  const period = hours < 6 ? '凌晨' : hours < 11 ? '早上' : hours < 14 ? '中午' : hours < 18 ? '下午' : '晚上';
  const hour = hours > 12 ? hours - 12 : hours;
  const minute = minutes === 30 ? '半' : minutes === 0 ? '' : (minutes < 10 ? '零' : '') + spokenNumber(minutes) + '分';
  return dayName(due, now) + period + (hour === 2 ? '两' : spokenNumber(hour)) + '点' + minute;
}

function labelInSpeech(label: string): string {
  return /^(?:喝(?:水|茶|点水|口水)|出门|休息|起床|读书|拿快递|开会|关火|吃饭)$/u.test(label) ? label : '「' + label + '」';
}

function listTime(iso: string, now: Date): string {
  const due = new Date(iso);
  const hhmm = [due.getHours(), due.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
  return dayName(due, now) + ' ' + hhmm + (due.getSeconds() ? ':' + String(due.getSeconds()).padStart(2, '0') : '');
}

/** Called at actual transport dispatch so catching up after sleep doesn't
 * present an overdue meeting or medication as something to do right now. */
export function qqReminderDeliveryText(item: QqOutboxItem, now: Date): string {
  if (item.kind !== 'system') return item.content;
  if (!item.reminderDueAt) {
    const receipt = item.reminderReceipt;
    if (receipt && (now.getTime() - Date.parse(item.createdAt) >= 60_000 || now.getTime() >= Date.parse(receipt.dueAt))) {
      return '你设的「' + receipt.label + '」提醒，时间是' + listTime(receipt.dueAt, now) + '。';
    }
    return item.content;
  }
  const due = new Date(item.reminderDueAt), label = reminderLabel(item);
  if (now.getTime() - due.getTime() >= 60_000) {
    return '这条提醒来晚了，你原本让我' + clockPhrase(due, now) + '提醒你' + labelInSpeech(label) + '。';
  }
  if (['喝水', '喝点水', '喝口水'].includes(label)) return '喝口水吧。';
  if (label === '喝茶') return '喝口茶吧。';
  if (label === '休息') return '歇一会儿吧。';
  if (label === '出门') return '该出门啦。';
  return '你记下的「' + label + '」，到时间啦。';
}

export function applyQqReminder(
  state: QqChannelState,
  authority: QqAuthority,
  command: ReminderCommand,
  replyTo: string,
  now: Date,
): void {
  const reminders = state.outbox.filter(
    (row) =>
      row.reminderDueAt &&
      row.authority.authorityId === authority.authorityId &&
      row.authority.bindingId === authority.bindingId,
  );
  const rows = reminders.filter((row) => ['pending', 'sending', 'failed', 'unknown'].includes(row.status));
  const row = (content: string, replyId: string | null): QqOutboxItem => ({
    id: randomUUID(),
    authority,
    kind: 'system',
    content,
    runId: null,
    assistantMessageId: null,
    replyTo: replyId,
    status: 'pending',
    attempts: 0,
    createdAt: now.toISOString(),
    lastAttemptAt: null,
    errorCode: null,
  });
  const acknowledge = (text: string) => appendQqOutbox(state, row(text, replyTo));
  if (command.kind === 'help') return acknowledge(HELP);
  if (state.binding?.remindersAuthorityId !== authority.authorityId)
    return acknowledge('请先在桌面的 QQ 设置中，为已配对本人开启“一次性私聊提醒”。');
  if (command.kind === 'invalid-time') return acknowledge('这个时间无效或已经过去。' + HELP);
  if (command.kind === 'list') {
    if (!reminders.length) return acknowledge('你还没设提醒。');
    const labels = {
      pending: '待发送',
      sending: '发送中',
      failed: '发送失败',
      unknown: '送达未确认',
      sent: '已送达',
      discarded: '已取消',
    };
    const completed = reminders.filter((item) => item.status === 'sent' || item.status === 'discarded').slice(-3);
    return acknowledge(
      [...rows.slice(-MAX_PENDING), ...completed]
        .map((item) => {
          const label = Array.from(reminderLabel(item));
          const short = label.length > 16 ? label.slice(0, 16).join('') + '…' : label.join('');
          const status = item.errorCode === 'qq.reminderExpired' ? '过期未发' : labels[item.status];
          return (
            item.id.slice(0, 8) +
            ' · ' +
            listTime(item.reminderDueAt!, now) +
            ' · ' +
            status +
            ' · ' +
            short
          );
        })
        .join('\n'),
    );
  }
  if (command.kind === 'cancel' || command.kind === 'cancel-latest' || command.kind === 'cancel-label') {
    // "The last one" refers to the last one created, even if already sent or
    // cancelled. Skipping it could silently cancel a different reminder.
    const matches = command.kind === 'cancel-latest' ? reminders.slice(-1)
      : command.kind === 'cancel' ? rows.filter(item => item.id.startsWith(command.id))
      : rows.filter(item => reminderLabel(item) === command.label);
    if (!matches.length) return acknowledge('没找到这条待发提醒。发“我的提醒”可以看看。');
    if (matches.length > 1) return acknowledge('有好几条。请发对应的取消指令。\n' +
      matches.map(item => listTime(item.reminderDueAt!, now) + '　/cancel-reminder ' + item.id.slice(0, 8)).join('\n'));
    const item = matches[0]!;
    if (item.status === 'sent') return acknowledge('刚才那条已经发过啦。');
    if (item.status === 'discarded') return acknowledge('那条已经不在待发提醒里了。');
    if (item.status === 'unknown' || item.status === 'sending')
      return acknowledge('那条已经交给 QQ 了，可能已经发出。');
    item.status = 'discarded';
    item.errorCode = 'qq.reminderCancelled';
    for (const receipt of state.outbox) {
      if (receipt.reminderReceipt?.reminderId === item.id && (receipt.status === 'pending' || receipt.status === 'failed')) {
        receipt.status = 'discarded';
        receipt.errorCode = 'qq.reminderCancelled';
      }
    }
    return acknowledge('好，「' + reminderLabel(item) + '」这条就不提醒了。');
  }
  // The general inbox remembers only recent messages. Retain the idempotency
  // key on the scheduled effect for as long as that reminder is retained.
  const sourceMessageSHA256 = createHash('sha256').update(replyTo, 'utf8').digest('hex');
  if (state.outbox.some(item => item.reminderDueAt && item.authority.bindingId === authority.bindingId &&
    item.reminderSourceMessageSHA256 === sourceMessageSHA256)) return;
  if (rows.filter((item) => item.status === 'pending' || item.status === 'sending').length >= MAX_PENDING)
    return acknowledge('待发私聊提醒已达 20 条，请先取消不需要的提醒。');
  const notification = row(storedPrefix + command.label, null);
  // A short, unambiguous cancel handle is scoped to this owner's active reminders.
  while (rows.some((item) => item.id.startsWith(notification.id.slice(0, 8)))) notification.id = randomUUID();
  notification.reminderDueAt = new Date(command.due).toISOString();
  notification.reminderSourceMessageSHA256 = sourceMessageSHA256;
  const when = command.afterSeconds === undefined ? clockPhrase(new Date(command.due), now) : durationPhrase(command.afterSeconds);
  const receipt = row('好，' + when + '我提醒你' + labelInSpeech(command.label) + '。', replyTo);
  receipt.reminderReceipt = { reminderId: notification.id, label: command.label, dueAt: notification.reminderDueAt };
  appendQqOutbox(state, receipt, notification);
}
