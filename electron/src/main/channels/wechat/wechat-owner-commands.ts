import { createHash } from 'node:crypto';
import { nextCronOccurrence, parseCronExpression } from '../../domain/cron-expression';
import { parseDirectToolCommand } from '../../domain/direct-tool-command';
import { compactWeChatCheckup } from '../../domain/doctor-wechat-checkup';
import type { DomainRepository } from '../../domain/repository';
import { QQ_CRON_MIN_INTERVAL_MS, QQ_CRON_TASK_LIMIT } from '../../security/qq-cron-policy';
import { parseQqReminder, REMINDER_GRACE_MS } from '../qq/qq-reminders';
import { wechatOwnerDigest } from './wechat-owner-command-schema';
import type { WeChatOwnerCommandState } from './wechat-owner-command-schema';
import { cancelScheduledTask, matchWeChatScheduledTask, printableWeChatLine, taskSummaries, WeChatScheduledTasks } from './wechat-scheduled-tasks';
import type { WeChatScheduledCommand, WeChatScheduledTaskHost } from './wechat-scheduled-tasks';

export type { WeChatScheduledTaskAuthority } from './wechat-owner-command-schema';
export { WECHAT_SCHEDULED_TASK_LIMITS, WECHAT_SCHEDULED_TASK_TOOLS } from './wechat-scheduled-tasks';
export type { WeChatScheduledTaskRun } from './wechat-scheduled-tasks';

export interface WeChatOwnerInput { binding: string; eventId: string; text: string }
export interface WeChatOwnerDelivery { binding: string; deliveryId: string; text: string }
export interface WeChatOwnerHost {
  available(): boolean;
  currentBinding(): Promise<string | null>;
  status(): Promise<string>;
  model(): Promise<string>;
  checkup?(): Promise<string>;
  deliver(input: WeChatOwnerDelivery): Promise<'sent' | 'retry' | 'uncertain'>;
  scheduledTask?: WeChatScheduledTaskHost;
  now?(): number;
  timezone?(): string;
}

type State = WeChatOwnerCommandState;
type Reminder = State['reminders'][number];
type OneOff = NonNullable<ReturnType<typeof parseQqReminder>>;
type Cron =
  | { kind: 'cron-help' }
  | { kind: 'cron-format'; syntax: 'once' | 'task' | 'confirm' }
  | { kind: 'cron-list'; scope?: 'tasks' | 'reminders' }
  | { kind: 'cron-add'; expression: string; label: string }
  | { kind: 'cron-cancel'; id: string };
type Command = OneOff | Cron | WeChatScheduledCommand | { kind: 'help-all' | 'ping' | 'status' | 'model' | 'checkup' };

const commandsHelp = '微信私聊指令：体检（/checkup）、/ping、/status、/model；/search 关键词、/read 链接、/calc 算式、/time；/queue、/pause-queue、/resume-queue、/cancel-queue；/sticker 优先用微信收藏，/sticker library 只用图库。可以说“十分钟后提醒我喝水”，或发 /reminders 查看。发 /cron 查看周期提醒和模型任务用法。';
const remindersHelp = '可说“十分钟后提醒我喝水”或“明早八点半提醒我出门”。发 /reminders 查看，发 /cancel-reminder 编号 取消。';
const cronHelp = '固定提醒：/cron add 分 时 日 月 周 -- 提醒内容。模型任务：/cron task 分 时 日 月 周 -- 任务内容，或 /cron once 40s -- 任务内容（确认后计时）。用 /cron list 查看，/cron cancel 编号 取消。';
const recurringGraceMs = 5 * 60_000;
const maxOneOff = 10;
const safeLine = printableWeChatLine;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const shortId = (row: { id: string }): string => row.id.slice(0, 8);
const displayTime = (epoch: number, timezone: string): string => new Intl.DateTimeFormat('zh-CN', {
  timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(epoch);

const cronFormat = {
  once: '格式：/cron once 40s -- 任务内容',
  task: '格式：/cron task 分 时 日 月 周 -- 任务内容',
  confirm: '格式：/confirm 12 位确认码',
} as const;

const normalizeScheduledCommand = (text: string): string => {
  const foldWidth = (value: string): string => value.replace(/[\uFF01-\uFF5E]/gu,
    character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0));
  const line = text.replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(/\u3000/gu, ' ');
  const folded = foldWidth(line);
  // Fold only recognized command syntax. Preserve fullwidth punctuation in the task itself.
  const prefix = folded.match(/^\/(?:cron|task|confirm)(?:\s|$)/iu);
  if (!prefix) return text;
  const duration = /^\/(?:cron\s+once|task\s+(?:in|after))\s+\d{1,5}[smh]\s*[-–—]{1,2}\s*/iu.exec(folded);
  const recurring = /^\/cron\s+(?:task|add)\s+(?:[\d*,/-]+\s+){4}[\d*,/-]+\s+--\s+/iu.exec(folded);
  const delimiter = duration?.[0].length ?? recurring?.[0].length ?? line.length;
  return foldWidth(line.slice(0, delimiter)) + line.slice(delimiter);
};

export function matchWeChatOwnerCommand(raw: string, now = new Date()): Command | null {
  const text = normalizeScheduledCommand(raw.trim());
  if (!text || [...text].length > 500 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(text)) return null;
  if (/^(?:体检|\/checkup)$/iu.test(text.normalize('NFKC'))) return { kind: 'checkup' };
  if (/^\/ping$/iu.test(text)) return { kind: 'ping' };
  if (/^\/status$/iu.test(text)) return { kind: 'status' };
  if (/^\/model$/iu.test(text)) return { kind: 'model' };
  const task = matchWeChatScheduledTask(text);
  if (task) return task;
  if (/^\/(?:cron\s+once|task\s+(?:in|after))(?:\s|$)/iu.test(text)) return { kind: 'cron-format', syntax: 'once' };
  if (/^\/cron\s+task(?:\s|$)/iu.test(text)) return { kind: 'cron-format', syntax: 'task' };
  if (/^\/confirm(?:\s|$)/iu.test(text)) return { kind: 'cron-format', syntax: 'confirm' };
  const list = /^\/cron\s+list(?:\s+(tasks|reminders))?$/iu.exec(text);
  if (list || parseDirectToolCommand(text)?.toolId === 'cron.list') {
    const scope = list?.[1]?.toLowerCase();
    return { kind: 'cron-list', ...(scope === 'tasks' || scope === 'reminders' ? { scope } : {}) };
  }
  const cancel = /^\/cron\s+cancel\s+([a-f0-9]{8})$/iu.exec(text);
  if (cancel) return { kind: 'cron-cancel', id: cancel[1]!.toLowerCase() };
  const create = /^\/cron\s+add\s+((?:[\d*,/-]+\s+){4}[\d*,/-]+)\s+--\s+(.{1,120})$/iu.exec(text);
  if (create) return { kind: 'cron-add', expression: create[1]!.split(/\s+/u).join(' '), label: create[2]!.trim() };
  if (/^\/(?:cron|task)(?:\s|$)/iu.test(text)) return { kind: 'cron-help' };
  return parseQqReminder(text, now) ?? (/^\//u.test(text) ? { kind: 'help-all' } : null);
}

function cronDue(expression: string, timezone: string, now: number): number | null {
  const cron = parseCronExpression(expression);
  const times = cron.hour.values.flatMap(hour => cron.minute.values.map(minute => hour * 60 + minute));
  const first = times[0]!;
  if (times.some((minute, index) => ((times[index + 1] ?? first + 1_440) - minute) * 60_000 < QQ_CRON_MIN_INTERVAL_MS)) return null;
  const next = nextCronOccurrence(expression, timezone, now);
  return next === null ? null : Date.parse(next);
}

function listRows(rows: Reminder[], timezone: string, recurring: boolean): string {
  if (rows.length === 0) return recurring ? '你没有待运行的微信周期提醒。' : '你没有待发送的微信提醒。';
  const summaries = rows.map(row => {
    const label = [...row.label].slice(0, 12).join('');
    const status = row.delivery?.status === 'uncertain' ? '送达未确认' : displayTime(row.dueAt, row.recurrence?.timezone ?? timezone);
    return `${shortId(row)} ${status} ${label}`;
  });
  const heading = recurring ? `周期提醒（${timezone}）：` : '待发微信提醒：';
  return heading + summaries.join(' ｜ ');
}

function cancelRow(rows: Reminder[]): string {
  if (rows.length === 0) return '没找到这条待发提醒。';
  if (rows.length > 1) return '有多条同名提醒，请用编号取消。';
  const row = rows[0]!;
  if (row.state !== 'active') return '这条提醒已经处理了。';
  if (row.delivery?.status === 'pending') return '这条提醒正在发送，等发送状态更新后再试。';
  row.state = 'cancelled';
  row.delivery = null;
  return `已取消「${row.label}」。`;
}

function schedule(state: State, input: WeChatOwnerInput, label: string, dueAt: number, recurrence: Reminder['recurrence']): string | null {
  const recurring = recurrence !== null;
  const relevant = state.reminders.filter(row => row.binding === input.binding && (row.recurrence !== null) === recurring);
  if (relevant.filter(row => row.state === 'active').length >= (recurring ? QQ_CRON_TASK_LIMIT : maxOneOff)) return null;
  const id = digest(`deskpet/wechat/reminder/v1\0${input.binding}\0${input.eventId}`);
  if (relevant.some(row => shortId(row) === id.slice(0, 8))
    || (recurring && state.tasks.some(row => row.binding === input.binding && shortId(row) === id.slice(0, 8)))) return null;
  if (state.reminders.length === 200) {
    const removable = state.reminders.findIndex(row => row.state !== 'active');
    if (removable < 0) return null;
    state.reminders.splice(removable, 1);
  }
  state.reminders.push({ id, binding: input.binding, label, dueAt, recurrence, delivery: null, state: 'active' });
  return id.slice(0, 8);
}

export class WeChatOwnerCommands {
  #ticking: Promise<void> | null = null;
  readonly #tasks: WeChatScheduledTasks;

  constructor(private readonly repository: DomainRepository, private readonly host: WeChatOwnerHost) {
    this.#tasks = new WeChatScheduledTasks(repository, host);
  }

  async handle(input: WeChatOwnerInput): Promise<string | null> {
    if (!wechatOwnerDigest.safeParse(input.eventId).success || !wechatOwnerDigest.safeParse(input.binding).success) throw new Error('wechat.ownerCommandInvalid');
    const now = this.host.now?.() ?? Date.now();
    const command = matchWeChatOwnerCommand(input.text, new Date(now));
    if (!command) return null;
    const scheduledGeneration = this.#tasks.generation;
    if (!await this.#bound(input.binding)) throw new Error('wechat.ownerBindingChanged');
    const textDigest = digest(input.text);
    const previous = this.#prior(this.repository.read('wechatOwnerCommands'), input, textDigest);
    if (previous) return previous;
    const detail = command.kind === 'model' ? await this.host.model() : command.kind === 'status' ? await this.host.status()
      : command.kind === 'checkup' ? compactWeChatCheckup(await this.host.checkup?.() ?? '医生暂时不可用，请在桌宠医生页查看。') : null;
    const isTask = command.kind === 'task-propose' || command.kind === 'task-confirm';
    const authority = isTask ? await this.#tasks.capture(input.binding, scheduledGeneration) : null;
    const timezone = this.host.timezone?.() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const result = await this.repository.transaction(async profile => {
      if (!await this.#bound(input.binding)) throw new Error('wechat.ownerBindingChanged');
      const state = profile.wechatOwnerCommands;
      const replay = this.#prior(state, input, textDigest);
      if (replay) return replay;
      const output = isTask ? this.#tasks.isCurrentGeneration(scheduledGeneration)
        ? this.#tasks.apply(state, input, command, now, timezone, authority, cronDue)
        : '微信模型任务授权已变化，请重新提交。'
        : this.#apply(state, input, command, now, timezone, detail);
      const reply = [...safeLine(output)].slice(0, 500).join('');
      state.receipts.push({ id: input.eventId, binding: input.binding, textDigest, reply });
      if (state.receipts.length > 1_024) state.receipts.shift();
      return reply;
    });
    if (command.kind === 'cron-cancel') {
      const cancelled = this.repository.read('wechatOwnerCommands').tasks.find(row => row.binding === input.binding
        && row.state === 'cancelled' && shortId(row) === command.id);
      if (cancelled) this.#tasks.interrupt(cancelled.id);
    }
    return result;
  }

  #prior(state: State, input: WeChatOwnerInput, textDigest: string): string | null {
    const prior = state.receipts.find(row => row.binding === input.binding && row.id === input.eventId);
    if (!prior) return null;
    if (prior.textDigest !== textDigest) throw new Error('wechat.ownerCommandConflict');
    return prior.reply;
  }

  #apply(state: State, input: WeChatOwnerInput, command: Exclude<Command, WeChatScheduledCommand>, now: number, timezone: string, detail: string | null): string {
    const reminders = state.reminders.filter(row => row.binding === input.binding && row.recurrence === null);
    const recurring = state.reminders.filter(row => row.binding === input.binding && row.recurrence !== null);
    const active = (rows: Reminder[]) => rows.filter(row => row.state === 'active');
    switch (command.kind) {
      case 'ping': return '在呢。微信私聊可以收到你的消息。';
      case 'model': return '当前微信私聊模型：' + (detail || '暂不可用');
      case 'status': return '微信私聊状态：' + (detail || '暂不可用');
      case 'checkup': return detail || '医生暂时不可用，请在桌宠医生页查看。';
      case 'help-all': return commandsHelp;
      case 'cron-help': return cronHelp;
      case 'cron-format': return cronFormat[command.syntax];
      case 'help': return remindersHelp;
      case 'invalid-time': return '这个时间无效或已经过去。' + remindersHelp;
      case 'list': return listRows(active(reminders), timezone, false);
      case 'cancel': return cancelRow(active(reminders).filter(row => shortId(row) === command.id));
      case 'cancel-latest': return cancelRow(reminders.slice(-1));
      case 'cancel-label': return cancelRow(active(reminders).filter(row => row.label === command.label));
      case 'cron-list': {
        const reminders = listRows(active(recurring), timezone, true);
        if (command.scope === 'reminders') return reminders;
        const tasks = taskSummaries(state, input.binding, timezone).join(' ｜ ');
        if (command.scope === 'tasks') return tasks || '你没有微信模型任务。';
        const combined = tasks && recurring.length ? `${tasks} ｜ ${reminders}` : tasks || reminders;
        return [...combined].length > 500 ? '记录较多。发 /cron list tasks 查看模型任务，或 /cron list reminders 查看周期提醒。' : combined;
      }
      case 'cron-cancel': {
        const fixed = active(recurring).filter(row => shortId(row) === command.id);
        if (fixed.length > 0 && state.tasks.some(row => row.binding === input.binding && shortId(row) === command.id)) return '提醒编号冲突，请在桌面查看。';
        return fixed.length > 0 ? cancelRow(fixed) : cancelScheduledTask(state, input.binding, command.id) ?? cancelRow([]);
      }
      case 'create': {
        const label = safeLine(command.label);
        if (!label) return remindersHelp;
        const id = schedule(state, input, label, command.due, null);
        return id ? `已设微信提醒 ${id}，${displayTime(command.due, timezone)} 提醒你「${label}」。` : '待发提醒已满，请先取消一条。';
      }
      case 'cron-add': {
        const label = safeLine(command.label);
        let due = null;
        try { due = cronDue(command.expression, timezone, now); } catch { /* Invalid numeric schedule. */ }
        if (!label || due === null) return '周期格式无效，或间隔少于 15 分钟。' + cronHelp;
        const id = schedule(state, input, label, due, { expression: command.expression, timezone });
        return id ? `已设微信周期提醒 ${id}「${label}」，首次 ${displayTime(due, timezone)}（${timezone}）。` : '周期提醒已满，请先取消一条。';
      }
    }
  }

  async #bound(binding: string): Promise<boolean> {
    return this.host.available() && await this.host.currentBinding() === binding && this.host.available();
  }

  tick(): Promise<void> {
    if (!this.host.available()) return Promise.resolve();
    this.#ticking ??= this.#tick().finally(() => { this.#ticking = null; });
    return this.#ticking;
  }

  tickScheduledTasks(): Promise<void> { return this.#tasks.tick(); }

  invalidateScheduledAuthority(): Promise<void> { return this.#tasks.invalidateAuthority(); }

  async drain(): Promise<void> { await Promise.all([this.#ticking?.catch(() => undefined), this.#tasks.drain()]); }

  async #tick(): Promise<void> {
    const now = this.host.now?.() ?? Date.now();
    if (!this.repository.read('wechatOwnerCommands').reminders.some(row => row.state === 'active' && row.dueAt <= now && row.delivery?.status !== 'uncertain')) return;
    const binding = await this.host.currentBinding();
    if (!binding || !this.host.available()) return;
    const row = await this.repository.transaction(profile => {
      if (!this.host.available()) return null;
      const current = profile.wechatOwnerCommands.reminders.find(row => row.binding === binding && row.state === 'active'
        && row.dueAt <= now && row.delivery?.status !== 'uncertain');
      if (!current) return null;
      const grace = current.recurrence ? recurringGraceMs : REMINDER_GRACE_MS;
      if (!current.delivery && now - current.dueAt > grace) { this.#advance(current, now, false); return null; }
      current.delivery ??= { id: digest(`deskpet/wechat/reminder-delivery/v1\0${current.id}\0${current.dueAt}`), dueAt: current.dueAt, status: 'pending' };
      return structuredClone(current);
    });
    if (!row?.delivery || !await this.#bound(binding)) return;
    const deliveryId = row.delivery.id;
    const text = row.recurrence ? `周期提醒：${row.label}` : `微信提醒：${row.label}`;
    // An interrupted exchange is replayed with the same delivery ID. Only the
    // worker can report whether it attempted a send.
    const outcome = await this.host.deliver({ binding, deliveryId, text }).catch(() => null);
    if (outcome === null) return;
    await this.repository.transaction(profile => {
      const current = profile.wechatOwnerCommands.reminders.find(candidate => candidate.id === row.id && candidate.delivery?.id === deliveryId);
      if (!current?.delivery || current.state !== 'active') return;
      if (outcome === 'sent') this.#advance(current, now, true);
      else if (outcome === 'uncertain') current.delivery.status = 'uncertain';
      else if (now - current.dueAt > (current.recurrence ? recurringGraceMs : REMINDER_GRACE_MS)) this.#advance(current, now, false);
      else current.delivery = null;
    });
  }

  #advance(row: Reminder, now: number, sent: boolean): void {
    row.delivery = null;
    if (row.recurrence) {
      const next = nextCronOccurrence(row.recurrence.expression, row.recurrence.timezone, now);
      if (next !== null) { row.dueAt = Date.parse(next); return; }
    }
    row.state = sent ? 'sent' : 'expired';
  }
}
