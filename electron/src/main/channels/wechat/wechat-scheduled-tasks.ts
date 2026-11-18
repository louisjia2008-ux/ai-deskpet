import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { nextCronOccurrence } from '../../domain/cron-expression';
import type { DomainRepository } from '../../domain/repository';
import { QQ_CRON_MIN_INTERVAL_MS, QQ_CRON_TASK_LIMIT } from '../../security/qq-cron-policy';
import { sameWeChatScheduledTaskAuthority, wechatScheduledTaskAuthoritySchema } from './wechat-owner-command-schema';
import type { WeChatOwnerCommandState, WeChatScheduledTaskAuthority } from './wechat-owner-command-schema';
import type { WeChatOwnerHost, WeChatOwnerInput } from './wechat-owner-commands';

export const WECHAT_SCHEDULED_TASK_TOOLS = ['time.current', 'math.calculate', 'web.search', 'web.read'] as const;
export const WECHAT_SCHEDULED_TASK_LIMITS = Object.freeze({ modelCalls: 4, webCalls: 4, outputTokens: 1_024, runtimeMs: 90_000 });
export interface WeChatScheduledTaskRun {
  binding: string; runId: string; taskId: string; instruction: string; authority: WeChatScheduledTaskAuthority;
  allowedTools: typeof WECHAT_SCHEDULED_TASK_TOOLS; limits: typeof WECHAT_SCHEDULED_TASK_LIMITS; signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface WeChatScheduledTaskHost {
  capture(binding: string): Promise<WeChatScheduledTaskAuthority | null>;
  run(input: WeChatScheduledTaskRun): Promise<string>;
}

type State = WeChatOwnerCommandState;
type Task = State['tasks'][number];
type Timing = Task['timing'];
type Proposal = { kind: 'task-propose'; instruction: string; timing: { expression: string } | { delayMs: number } };
export type WeChatScheduledCommand = Proposal | { kind: 'task-confirm'; code: string };
type Outcome = NonNullable<Task['outcome']>;
const grace = 5 * 60_000;
const draftLifetime = 10 * 60_000;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const short = (row: { id: string }): string => row.id.slice(0, 8);
const modelAuthorityEqual = sameWeChatScheduledTaskAuthority;
const inactive = (status: Task['state']): boolean => status === 'cancelled' || status === 'completed';
const bounded = (value: string, limit: number): string => [...value].slice(0, limit).join('');
export const printableWeChatLine = (value: string): string => value.replace(/[\p{C}\p{Z}]+/gu, ' ').trim();
const displayTime = (epoch: number, timeZone: string): string => new Intl.DateTimeFormat('zh-CN', {
  timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(epoch);
const authorityChanged = (): never => { throw new Error('wechat.taskAuthorityChanged'); };

export function matchWeChatScheduledTask(text: string): WeChatScheduledCommand | null {
  const confirm = /^\/confirm\s+([a-f0-9]{12})$/iu.exec(text);
  if (confirm) return { kind: 'task-confirm', code: confirm[1]!.toLowerCase() };
  const recurrent = /^\/cron\s+task\s+((?:[\d*,/-]+\s+){4}[\d*,/-]+)\s+--\s+(.+)$/iu.exec(text);
  if (recurrent && recurrent[1]!.length <= 96 && [...recurrent[2]!].length <= 145) {
    return { kind: 'task-propose', instruction: recurrent[2]!, timing: { expression: recurrent[1]!.split(/\s+/u).join(' ') } };
  }
  const oneOff = /^(?:\/cron\s+once|\/task\s+(?:in|after))\s+(\d{1,5})([smh])(?:\s+--\s+|\s*[-–—]{1,2}\s*(?![-–—]))([^\s].*)$/iu.exec(text);
  if (!oneOff || [...oneOff[3]!].length > 145) return null;
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  const delayMs = Number(oneOff[1]) * multipliers[oneOff[2]!.toLowerCase()]!;
  return delayMs >= 10_000 && delayMs <= 86_400_000
    ? { kind: 'task-propose', instruction: oneOff[3]!, timing: { delayMs } } : null;
}

export function taskSummaries(state: State, binding: string, timezone: string): string[] {
  const statuses = { sent: '已送达', missed: '已错过', interrupted: '执行中断', failed: '执行失败', authority_changed: '授权变化', restored: '恢复后需重新确认' };
  return state.tasks.filter(row => row.binding === binding && row.state !== 'cancelled').slice(-QQ_CRON_TASK_LIMIT).map(task => {
    const time = task.state === 'active' ? displayTime(task.dueAt, task.timing.kind === 'recurring' ? task.timing.timezone : timezone) : '';
    const status = task.run?.phase === 'uncertain' ? '送达未确认' : task.run ? '进行中' : task.outcome && statuses[task.outcome];
    return [short(task), '模型任务', time, status, bounded(task.instruction, 10)].filter(Boolean).join(' ');
  });
}

export function cancelScheduledTask(state: State, binding: string, id: string): string | null {
  const task = state.tasks.find(row => row.binding === binding && short(row) === id);
  if (!task) return null;
  if (inactive(task.state)) return '这项微信模型任务已经结束。';
  const pendingDelivery = task.run?.phase === 'delivering' || task.run?.phase === 'uncertain';
  task.state = 'cancelled';
  task.run = null;
  return pendingDelivery ? '已取消后续任务。上一次结果可能已经送出。' : '已取消微信模型任务。';
}

export class WeChatScheduledTasks {
  #pending: Promise<void> | null = null;
  #execution: { id: string; controller: AbortController } | null = null;
  #generation = 0;
  #committedGeneration = 0;

  constructor(private readonly repository: DomainRepository, private readonly host: WeChatOwnerHost) {}

  get generation(): number { return this.#generation; }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.#generation && generation === this.#committedGeneration;
  }

  async capture(binding: string, generation: number): Promise<WeChatScheduledTaskAuthority | null> {
    if (!this.isCurrentGeneration(generation) || !this.host.scheduledTask || !await this.#bound(binding)) return null;
    return wechatScheduledTaskAuthoritySchema.nullable().parse(await this.host.scheduledTask.capture(binding));
  }

  apply(state: State, input: WeChatOwnerInput, command: WeChatScheduledCommand, now: number, timezone: string,
    authority: WeChatScheduledTaskAuthority | null, cronDue: (expression: string, timezone: string, now: number) => number | null): string {
    const priorDraft = state.taskDrafts.find(row => row.binding === input.binding);
    state.taskDrafts = state.taskDrafts.filter(row => row.expiresAt > now);
    if (command.kind === 'task-confirm') {
      if (!priorDraft || priorDraft.code !== command.code || priorDraft.expiresAt <= now) return '确认码无效或已过期。请重新发送任务。';
      state.taskDrafts = state.taskDrafts.filter(row => row !== priorDraft);
      if (!modelAuthorityEqual(authority, priorDraft.authority)) return '模型、服务或权限已变化。请重新提交任务确认。';
      const owned = state.tasks.filter(row => row.binding === input.binding && !inactive(row.state));
      if (owned.length >= QQ_CRON_TASK_LIMIT) return '微信模型任务已满，请先取消一项。';
      if (state.tasks.length === 200) {
        const removable = state.tasks.findIndex(row => inactive(row.state));
        if (removable < 0) return '微信模型任务记录已满。';
        state.tasks.splice(removable, 1);
      }
      const spec = {
        id: priorDraft.id, binding: priorDraft.binding, instruction: priorDraft.instruction, timing: priorDraft.timing, authority: priorDraft.authority,
      };
      if (state.tasks.some(row => row.binding === input.binding && short(row) === short(spec))) return '这项任务已确认。';
      if (state.reminders.some(row => row.binding === input.binding && short(row) === short(spec))) return '任务编号冲突，请重新提交。';
      const dueAt = spec.timing.kind === 'once' ? now + spec.timing.delayMs : cronDue(spec.timing.expression, spec.timing.timezone, now);
      if (dueAt === null) return '没有可执行的时间。';
      state.tasks.push({ ...spec, dueAt, state: 'active', run: null, outcome: null, lastFinishedAt: null });
      const displayZone = spec.timing.kind === 'recurring' ? spec.timing.timezone : timezone;
      return `已确认 ${short(spec)}，${displayTime(dueAt, displayZone)} 执行。`;
    }
    if (!authority) return '当前微信模型任务暂不可用。';
    const instruction = printableWeChatLine(command.instruction);
    if (!instruction) return '请填写模型任务内容。';
    const timing: Timing = 'expression' in command.timing ? { kind: 'recurring', expression: command.timing.expression, timezone }
      : { kind: 'once', delayMs: command.timing.delayMs };
    if (timing.kind === 'recurring') {
      try { if (cronDue(timing.expression, timezone, now) === null) return '周期无效，或间隔少于 15 分钟。'; }
      catch { return '周期格式无效。'; }
    }
    const id = hash(`deskpet/wechat/scheduled-task/v1\0${input.binding}\0${input.eventId}`);
    if (state.tasks.some(row => row.binding === input.binding && short(row) === short({ id }))) return '这项任务已确认。';
    const code = randomBytes(6).toString('hex');
    const when = timing.kind === 'once' ? `确认后${timing.delayMs / 1_000}秒` : `${timing.expression} ${timing.timezone}`;
    const destination = authority.destination === 'remote' ? '云端' : '本机';
    const model = printableWeChatLine(authority.model);
    if (!model || model !== authority.model) return '微信模型名称无法安全显示。';
    const reply = `任务 ${JSON.stringify(instruction)} ｜ ${when} ｜ ${destination} ${model} ｜ 搜索/网页/计算/时间 ｜ 10分钟内 /confirm ${code}`;
    if ([...reply].length > 500) return '确认摘要过长，请缩短任务或周期表达式。';
    state.taskDrafts = state.taskDrafts.filter(row => row.binding !== input.binding).slice(-19);
    state.taskDrafts.push({ id, binding: input.binding, instruction, timing, authority, code, expiresAt: now + draftLifetime });
    return reply;
  }

  interrupt(id: string): void {
    if (this.#execution?.id === id) this.#execution.controller.abort();
  }

  async invalidateAuthority(): Promise<void> {
    const generation = ++this.#generation;
    this.#execution?.controller.abort();
    await this.repository.transaction(profile => {
      const state = profile.wechatOwnerCommands;
      state.taskDrafts = [];
      for (const task of state.tasks) if (task.state === 'active') this.#advance(task, 'authority_changed');
    });
    this.#committedGeneration = Math.max(this.#committedGeneration, generation);
  }

  async drain(): Promise<void> {
    this.#execution?.controller.abort();
    await this.#pending?.catch(() => undefined);
  }

  tick(): Promise<void> {
    const generation = this.#generation;
    if (!this.isCurrentGeneration(generation) || !this.host.scheduledTask || !this.host.available()) return Promise.resolve();
    this.#pending ??= this.#tick(generation).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  #now(): number { return this.host.now?.() ?? Date.now(); }
  async #bound(binding: string): Promise<boolean> {
    return this.host.available() && await this.host.currentBinding() === binding && this.host.available();
  }

  #advance(task: Task, outcome: Exclude<Outcome, 'restored'>): void {
    const now = this.#now();
    task.run = null;
    task.outcome = outcome;
    task.lastFinishedAt = now;
    if (outcome === 'authority_changed') { task.state = 'blocked'; return; }
    if (task.timing.kind === 'recurring') {
      const after = Math.max(now, task.dueAt + QQ_CRON_MIN_INTERVAL_MS - 1);
      const next = nextCronOccurrence(task.timing.expression, task.timing.timezone, after);
      if (next !== null) { task.dueAt = Date.parse(next); return; }
    }
    task.state = 'completed';
  }

  async #tick(generation: number): Promise<void> {
    const now = this.#now();
    const due = (task: Task): boolean => task.state === 'active' && task.dueAt <= now && task.run?.phase !== 'uncertain';
    if (!this.repository.read('wechatOwnerCommands').tasks.some(due)) return;
    const binding = await this.host.currentBinding();
    if (!binding || !this.host.available()) return;
    const work = await this.repository.transaction(profile => {
      if (!this.isCurrentGeneration(generation) || !this.host.available()) return null;
      const task = profile.wechatOwnerCommands.tasks.find(row => row.binding === binding && due(row));
      if (!task) return null;
      if (task.run?.phase === 'running') { this.#advance(task, 'interrupted'); return null; }
      if ((!task.run || task.run.phase === 'ready') && now - task.dueAt > grace) { this.#advance(task, 'missed'); return null; }
      task.run ??= { phase: 'running', id: randomUUID(), deliveryId: hash(`deskpet/wechat/scheduled-delivery/v1\0${task.id}\0${task.dueAt}`) };
      return structuredClone(task);
    });
    if (!work?.run || !this.isCurrentGeneration(generation)) return;
    if (work.run.phase === 'running') await this.#execute(work, work.run.id, generation);
    else await this.#deliver(work, work.run, generation);
  }

  async #assertCurrent(work: Task, runId: string, generation: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isCurrentGeneration(generation)) authorityChanged();
    if (!this.host.available()) throw new Error('wechat.taskCancelled');
    const binding = await this.host.currentBinding();
    if (binding !== work.binding) authorityChanged();
    if (!modelAuthorityEqual(await this.host.scheduledTask!.capture(work.binding), work.authority)) authorityChanged();
    signal?.throwIfAborted();
    if (!this.isCurrentGeneration(generation)) authorityChanged();
    const current = this.repository.read('wechatOwnerCommands').tasks.find(row => row.id === work.id);
    if (!this.host.available() || current?.state !== 'active' || current.run?.id !== runId) throw new Error('wechat.taskCancelled');
  }

  async #execute(work: Task, runId: string, generation: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WECHAT_SCHEDULED_TASK_LIMITS.runtimeMs);
    timer.unref();
    this.#execution = { id: work.id, controller };
    const assertCurrent = () => this.#assertCurrent(work, runId, generation, controller.signal);
    try {
      await assertCurrent();
      if (!this.isCurrentGeneration(generation)) authorityChanged();
      const result = await this.host.scheduledTask!.run({
        binding: work.binding, runId, taskId: work.id, instruction: work.instruction, authority: work.authority,
        allowedTools: WECHAT_SCHEDULED_TASK_TOOLS, limits: WECHAT_SCHEDULED_TASK_LIMITS, signal: controller.signal, assertCurrent,
      });
      await assertCurrent();
      const text = bounded(printableWeChatLine(result), 480);
      if (!text) throw new Error('wechat.taskEmpty');
      await this.repository.transaction(profile => {
        if (!this.isCurrentGeneration(generation)) return;
        const task = profile.wechatOwnerCommands.tasks.find(row => row.id === work.id);
        if (task?.state === 'active' && task.run?.id === runId && task.run.phase === 'running') {
          task.run = { ...task.run, phase: 'ready', text: `模型任务 ${short(task)}：${text}` };
        }
      });
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return;
      await this.#finish(work.id, runId, generation, error instanceof Error && error.message === 'wechat.taskAuthorityChanged'
        ? 'authority_changed' : controller.signal.aborted || !this.host.available() ? 'interrupted' : 'failed');
    } finally {
      clearTimeout(timer);
      this.#execution = null;
    }
  }

  async #deliver(work: Task, run: Exclude<NonNullable<Task['run']>, { phase: 'running' }>, generation: number): Promise<void> {
    try { await this.#assertCurrent(work, run.id, generation); }
    catch (error) {
      if (error instanceof Error && error.message === 'wechat.taskAuthorityChanged' && this.host.available()) await this.#finish(work.id, run.id, generation, 'authority_changed');
      return;
    }
    const admitted = await this.repository.transaction(profile => {
      const task = profile.wechatOwnerCommands.tasks.find(row => row.id === work.id);
      if (!this.isCurrentGeneration(generation) || !this.host.available() || task?.state !== 'active' || task.run?.id !== run.id || task.run.phase === 'running') return false;
      task.run.phase = 'delivering';
      return true;
    });
    if (!admitted) return;
    try { await this.#assertCurrent(work, run.id, generation); }
    catch (error) {
      if (error instanceof Error && error.message === 'wechat.taskAuthorityChanged' && this.host.available()) await this.#finish(work.id, run.id, generation, 'authority_changed');
      return;
    }
    if (!this.isCurrentGeneration(generation)) return;
    // A crash between dispatch and acknowledgement reuses this same durable ID.
    const outcome = await this.host.deliver({ binding: work.binding, deliveryId: run.deliveryId, text: run.text }).catch(() => null);
    if (outcome === null) return;
    if (outcome === 'sent') { await this.#finish(work.id, run.id, generation, 'sent'); return; }
    await this.repository.transaction(profile => {
      if (!this.isCurrentGeneration(generation)) return;
      const task = profile.wechatOwnerCommands.tasks.find(row => row.id === work.id);
      if (task?.state === 'active' && task.run?.id === run.id && task.run.phase === 'delivering') {
        task.run.phase = outcome === 'uncertain' ? 'uncertain' : 'ready';
      }
    });
  }

  async #finish(id: string, runId: string, generation: number, outcome: Exclude<Outcome, 'restored'>): Promise<void> {
    await this.repository.transaction(profile => {
      if (!this.isCurrentGeneration(generation)) return;
      const task = profile.wechatOwnerCommands.tasks.find(row => row.id === id);
      if (task?.state === 'active' && task.run?.id === runId) this.#advance(task, outcome);
    });
  }
}
