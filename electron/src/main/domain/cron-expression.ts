import { resolveCalendarWallTime, validateCalendarTimezone } from './calendar-rules';

interface Field { values: readonly number[]; wildcard: boolean }
export interface CronExpression { minute: Field; hour: Field; day: Field; month: Field; weekday: Field }
const DAY = 86_400_000;
const MAX_DAYS = 8 * 366;
const formatters = new Map<string, Intl.DateTimeFormat>();

const field = (input: string, minimum: number, maximum: number, weekday = false): Field => {
  const values = new Set<number>();
  if (!input || input.length > 128) throw new Error('cron.invalidExpression');
  for (const item of input.split(',')) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,4}))?$/u.exec(item);
    if (!match) throw new Error('cron.invalidExpression');
    const base = match[1]!, step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1 || (match[2] !== undefined && base !== '*' && !base.includes('-'))) throw new Error('cron.invalidExpression');
    const [start, end] = base === '*' ? [minimum, maximum] : base.includes('-') ? base.split('-').map(Number) : [Number(base), Number(base)];
    if (start! < minimum || end! > maximum || start! > end!) throw new Error('cron.invalidExpression');
    for (let value = start!; value <= end!; value += step) values.add(weekday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: input.includes('*') };
};

/** Numeric five-field crontab syntax. Steps apply to * or a range. If neither
 * day field contains *, day-of-month/day-of-week use OR; otherwise both match.
 * No commands, macros, names, seconds, shell or system cron integration. */
export const parseCronExpression = (expression: string): CronExpression => {
  if (typeof expression !== 'string' || expression.length > 256 || /[\r\n]/u.test(expression)) throw new Error('cron.invalidExpression');
  const pieces = expression.trim().split(/\s+/u);
  if (pieces.length !== 5) throw new Error('cron.invalidExpression');
  return { minute: field(pieces[0]!, 0, 59), hour: field(pieces[1]!, 0, 23), day: field(pieces[2]!, 1, 31),
    month: field(pieces[3]!, 1, 12), weekday: field(pieces[4]!, 0, 7, true) };
};
export const validateCronTimezone = (timezone: string): void => {
  try { validateCalendarTimezone(timezone); } catch { throw new Error('cron.invalidTimezone'); }
};
const parts = (instant: number, timezone: string) => {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    validateCronTimezone(timezone);
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timezone, formatter);
  }
  const formatted = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(formatted.find((part) => part.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
};

/** Strictly after the supplied instant. Enumerates at most eight years of local
 * calendar days, filtering month/day before resolving candidate wall minutes.
 * Gaps are skipped and folds resolve to the earlier occurrence only. */
export const nextCronOccurrence = (expression: string, timezone: string, after: number | string): string | null => {
  const cron = parseCronExpression(expression); validateCronTimezone(timezone);
  const instant = typeof after === 'number' ? after : Date.parse(after);
  if (!Number.isFinite(instant)) throw new Error('cron.invalidInstant');
  const start = parts(instant, timezone), firstDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= MAX_DAYS; offset += 1) {
    const date = new Date(firstDay + offset * DAY);
    if (!cron.month.values.includes(date.getUTCMonth() + 1)) continue;
    const dom = cron.day.values.includes(date.getUTCDate()), dow = cron.weekday.values.includes(date.getUTCDay());
    if (cron.day.wildcard || cron.weekday.wildcard ? !(dom && dow) : !(dom || dow)) continue;
    for (const hour of cron.hour.values) {
      if (offset === 0 && hour < start.hour) continue;
      for (const minute of cron.minute.values) {
        if (offset === 0 && hour === start.hour && minute < start.minute) continue;
        const value = resolveCalendarWallTime({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, timezone);
        if (value !== null && Date.parse(value) > instant) return value;
      }
    }
  }
  return null;
};
export const cronPreview = (input: { expression: string; timezone: string; after: string; count: number }): string[] => {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) throw new Error('cron.invalidPreviewCount');
  const result: string[] = []; let after = input.after;
  for (let index = 0; index < input.count; index += 1) {
    const next = nextCronOccurrence(input.expression, input.timezone, after);
    if (next === null) break;
    result.push(next); after = next;
  }
  return result;
};
