import { z } from 'zod';
import { formatTimerDeadline } from '../../shared/timer-time';
import type { ModelDecision, ModelTurnMessage } from '../runtime';

export type DirectToolCommand =
  | { toolId: 'cron.list'; input: { limit: 20 }; language: 'zh' | 'en' }
  | { toolId: 'time.current'; input: { timezone?: string } }
  | { toolId: 'timer.create'; input: { seconds: number; label: string } };

const amount = '(?<amount>\\d+(?:\\.\\d+)?|[一二两三四五六七八九十]{1,3}|半)';
const duration = `${amount}\\s*(?<unit>秒钟?|分钟?|小时)`;
const timerPatterns = [
  new RegExp(`^(?:请)?(?:帮我)?(?:在)?${duration}(?:之后|后)提醒我(?<label>.+)$`, 'u'),
  new RegExp(`^(?:请)?(?:帮我)?(?:现在)?(?:创建|设置|设|定)(?:一个)?\\s*${duration}的?(?:计时器|倒计时)[，,](?:名字叫|名叫|名称是)(?<label>.+)$`, 'u'),
  new RegExp(`^从现在开始计时\\s*${duration}[，,]到时提醒我(?<activity>[^，,。]+)[，,]提醒名叫(?<label>.+)[。.]请现在创建计时器$`, 'u'),
];

export const timerNumber = (text: string): number => {
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  if (text === '半') return 0.5;
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text.length === 1 && text !== '十') return digits[text] ?? NaN;
  const tens = text.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  return tens ? (tens[1] ? digits[tens[1]]! : 1) * 10 + (tens[2] ? digits[tens[2]]! : 0) : NaN;
};

// Only complete, single-purpose commands belong here. Anything contextual,
// conditional, quoted, ambiguous, or compound stays with the reasoning model.
// This returns a proposal: AgentRuntime still validates, authorizes and executes it.
export const parseDirectToolCommand = (query: string): DirectToolCommand | null => {
  if (query.length > 240 || /[\r\n]/u.test(query)) return null;
  const text = query.trim().replace(/^Kitty\s*[，,]\s*/iu, '').replace(/[。.!！?？]$/u, '').trim();
  if (/^(?:(?:(?:我|本对话|当前对话|这个对话)(?:里|中)?(?:现在|目前|当前)?|现在|目前)?有哪些|(?:请)?(?:帮我)?(?:列出|查看|列一下)(?:(?:我|本对话|当前对话|这个对话)(?:里|中)?(?:现在|目前|当前)?(?:的|已有的?)?)?)(?:周期|周期性|定时|循环)任务$/u.test(text)) {
    return { toolId: 'cron.list', input: { limit: 20 }, language: 'zh' };
  }
  if (/^(?:(?:please )?(?:list|show)(?: me)? (?:my |the |all )?(?:current )?recurring tasks(?: in this (?:chat|conversation))?|what recurring tasks (?:do I (?:currently )?have|are (?:there )?in this (?:chat|conversation)))$/iu.test(text)) {
    return { toolId: 'cron.list', input: { limit: 20 }, language: 'en' };
  }
  if (/^(?:请)?(?:告诉我)?现在(?:是)?几点(?:了|钟)?$/u.test(text)) return { toolId: 'time.current', input: {} };
  const time = text.match(/^(?:请)?(?:帮我)?(?:查一下|查询一下|查询|告诉我)?现在(?:(上海|北京|本地)的?)?(?:准确)?(?:日期和时间|日期与时间|时间|日期)$/u);
  if (time) return { toolId: 'time.current', input: time[1] === '上海' || time[1] === '北京' ? { timezone: 'Asia/Shanghai' } : {} };
  if (/[?？]|不|别|取消|修改|如果|假如|假设|假定|比如|例如|示例|示范|演示|举例|仅|只要|只需|参考|翻译|转述|说法|句子|这句|解释|怎么|如何|是否|能否|可以|吗|然后|顺便|并且|同时|或|还是|每隔|每天|明天|明早|今晚/u.test(query)) return null;
  for (const pattern of timerPatterns) {
    const match = text.match(pattern)?.groups;
    if (!match) continue;
    const seconds = timerNumber(match.amount!) * (match.unit === '小时' ? 3_600 : match.unit?.startsWith('分') ? 60 : 1);
    let label = match.label!.trim();
    if (/^“[^“”]+”$/u.test(label) || /^"[^"\n]+"$/u.test(label)) label = label.slice(1, -1).trim();
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400 || !label || label.length > 120) return null;
    if (/[“”"'`，,。.;；:：!?！？()[\]{}<>（）【】「」]/u.test(label) || /提醒|计时|倒计时|和|及|再|后|先|\d+\s*(?:秒|分|小时)/u.test(label)) return null;
    return { toolId: 'timer.create', input: { seconds, label } };
  }
  return null;
};

export const directCommandForContext = (query: string, context: readonly ModelTurnMessage[]): DirectToolCommand | null => {
  // A preceding general conversation may have changed the meaning (e.g. "my
  // next sentence is only an example"). Do not guess which context to discard.
  const parsed = parseDirectToolCommand(query);
  if (parsed?.toolId === 'cron.list') {
    // This explicit read refers to the current chat even after ordinary conversation.
    // Keep quoted/rehearsed or delegated wording with the model.
    const staged = context.some(message => /翻译|示例|例句|举例|仅演示|不要执行|别执行|不要调用|别调用|只复述|下一(?:句|条)|(?:translate|translation|example|pretend|roleplay|repeat after|next (?:sentence|message)|do not (?:execute|run|use)|don't (?:execute|run|use))/iu.test(message.content));
    return staged ? null : parsed;
  }
  if (context.some((message) => message.role === 'user' && parseDirectToolCommand(message.content) === null)) return null;
  return parsed;
};

export const isIllustrativeCommand = (query: string): boolean => {
  // The annotation must qualify one complete command, outside any quoted name.
  // Compound requests remain with the model; an example in one clause must not
  // accidentally disable an independently requested action in another clause.
  const match = query.trim().match(/^([^\r\n]+)[（(](?:仅|只|只是)(?:演示|示范|举例|示例)(?:这句话|一下)?[）)][。.!！]?$/u);
  return match !== null && parseDirectToolCommand(match[1]!) !== null;
};

const timerResult = z.object({ timerId: z.string().uuid(), label: z.string().max(240), seconds: z.number().int().min(1).max(86_400), dueAt: z.iso.datetime(), timeZone: z.string(), localDueAt: z.string() });
const timeResult = z.object({ iso: z.iso.datetime() });

// Acknowledgement is generated only from the completed tool result, including
// replayed results on retry. Never infer success from the proposed arguments.
export const directToolConfirmation = (command: Exclude<DirectToolCommand, { toolId: 'cron.list' }>, result: unknown): string => {
  if (command.toolId === 'time.current') {
    const time = timeResult.parse(result);
    return `现在是 ${formatTimerDeadline(time.iso, command.input.timezone)}。`;
  }
  const timer = timerResult.parse(result);
  const length = timer.seconds % 3_600 === 0 ? `${timer.seconds / 3_600} 小时`
    : timer.seconds % 60 === 0 ? `${timer.seconds / 60} 分钟` : `${timer.seconds} 秒`;
  return `已创建「${timer.label}」计时器，时长 ${length}。到时提醒你，喵。`;
};

const scheduleListPage = z.object({
  schedules: z.array(z.object({
    id: z.string(), sessionId: z.string(), title: z.string(), expression: z.string(), timezone: z.string(),
    enabled: z.boolean(), cancelledAt: z.string().nullable(), nextRunAt: z.string().nullable(),
  })).max(20),
  nextOffset: z.number().int().min(1).max(200).nullable(),
});

// Only host-authored tool successes count as pages, never quoted text or user JSON.
// Discovery does not read schedules. All reads go back through AgentRuntime's
// schema validation, the task.records permission, and cron.list's session binding.
export function directScheduleList(command: Extract<DirectToolCommand, { toolId: 'cron.list' }>,
  sessionId: string, catalogActive: boolean, messages: readonly ModelTurnMessage[], callId: string): ModelDecision {
  const calls = new Map(messages.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call.name]));
  const results = messages.filter(message => message.role === 'tool');
  if (results.some(message => message.hostToolResult !== 'success')) throw new Error('tool.invalidArguments');
  const call = (toolId: string, input: unknown): ModelDecision => ({ type: 'tools', calls: [{ id: callId, toolId, input }] });
  if (catalogActive && !results.some(result => calls.get(result.toolCallId!) === 'tools.discover')) {
    return call('tools.discover', { group: 'schedules' });
  }
  const pages = results.filter(result => calls.get(result.toolCallId!) === 'cron.list')
    .map(result => scheduleListPage.parse(JSON.parse(result.content)));
  if (!pages.length) return call('cron.list', command.input);
  const schedules = pages.flatMap(page => page.schedules);
  if (schedules.some(schedule => schedule.sessionId !== sessionId)) throw new Error('tool.channelBlocked');
  const next = pages.at(-1)!.nextOffset;
  if (next !== null) {
    if (next !== schedules.length || (pages.length > 1 && next <= pages.at(-2)!.nextOffset!)) throw new Error('tool.invalidArguments');
    return call('cron.list', { ...command.input, offset: next });
  }
  const current = [...new Map(schedules.map(schedule => [schedule.id, schedule])).values()].filter(schedule => !schedule.cancelledAt);
  const zh = command.language === 'zh';
  if (!current.length) return { type: 'final', content: zh ? '当前对话还没有周期任务。' : 'There are no recurring tasks in this conversation.' };
  const lines = current.map(schedule => {
    const title = schedule.title.replace(/\s+/gu, ' ').trim();
    const status = schedule.enabled ? (zh ? '已启用' : 'active') : (zh ? '已暂停' : 'paused');
    const nextRun = schedule.enabled && schedule.nextRunAt
      ? (zh ? '，下次运行 ' : ', next run ') + new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
        timeZone: schedule.timezone, dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date(schedule.nextRunAt)) : '';
    return '- ' + title + (zh ? '（' : ' (') + status + nextRun + (zh ? '，' : ', ') + schedule.expression + ' ' + schedule.timezone + (zh ? '）' : ')');
  });
  return { type: 'final', content: (zh ? '当前对话有 ' + current.length + ' 个周期任务。' : 'Recurring tasks in this conversation:') + '\n' + lines.join('\n') };
}
