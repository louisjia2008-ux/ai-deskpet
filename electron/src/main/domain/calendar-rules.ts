import type { CalendarRule } from '../../shared/automation';

const MINUTE = 60_000;
const DAY = 86_400_000;
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const formatters = new Map<string, Intl.DateTimeFormat>();
interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }

export const validateCalendarTimezone = (timezone: string): void => {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 128) throw new Error('schedule.invalidTimezone');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(0); }
  catch { throw new Error('schedule.invalidTimezone'); }
};

const formatter = (timezone: string): Intl.DateTimeFormat => {
  let value = formatters.get(timezone);
  if (!value) {
    validateCalendarTimezone(timezone);
    value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    // User-defined zones must not make an unbounded long-lived cache.
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timezone, value);
  }
  return value;
};

const localParts = (instant: number, timezone: string): LocalParts => {
  const parts = formatter(timezone).formatToParts(new Date(instant));
  const get = (name: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === name)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
};
const sameLocal = (left: LocalParts, right: LocalParts): boolean =>
  left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute;

/** Resolve wall time with only Intl's IANA data. A gap is skipped; a fold uses its earlier instant only. */
export const resolveCalendarWallTime = (parts: LocalParts, timezone: string): string | null => {
  validateCalendarTimezone(timezone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  // Includes either side of ordinary/half-hour DST transitions and a dateline change.
  for (let step = -6; step <= 6; step += 1) {
    const sample = wall + step * 6 * 60 * MINUTE;
    const local = localParts(sample, timezone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
  }
  const candidates = [...offsets].map((offset) => wall - offset).filter((instant) => sameLocal(localParts(instant, timezone), parts)).sort((a, b) => a - b);
  return candidates.length ? new Date(candidates[0]!).toISOString() : null;
};

const absoluteInstant = (input: string): number => {
  if (typeof input !== 'string' || input.length > 80
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input)) throw new Error('schedule.invalidInstant');
  const [year, month, day, hour, minute] = input.slice(0, 16).split(/[-T:]/u).map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || hour! > 23 || minute! > 59) throw new Error('schedule.invalidInstant');
  const value = Date.parse(input);
  if (!Number.isFinite(value)) throw new Error('schedule.invalidInstant');
  return value;
};

export const validateCalendarRule = (rule: CalendarRule): void => {
  if (!rule || !['once', 'daily', 'weekly'].includes(rule.kind)) throw new Error('schedule.invalidRule');
  if (rule.kind === 'once') { absoluteInstant(rule.at); return; }
  if (!validTime.test(rule.time)) throw new Error('schedule.invalidTime');
  if (rule.kind === 'weekly' && (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6)) throw new Error('schedule.invalidWeekday');
};

export const calendarPreview = (input: { rule: CalendarRule; timezone: string; after: string; count: number }): string[] => {
  validateCalendarTimezone(input.timezone);
  validateCalendarRule(input.rule);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) throw new Error('schedule.invalidPreviewCount');
  const after = absoluteInstant(input.after);
  if (input.rule.kind === 'once') {
    const once = absoluteInstant(input.rule.at);
    return once > after ? [new Date(once).toISOString()] : [];
  }
  const start = localParts(after, input.timezone);
  const [hour, minute] = input.rule.time.split(':').map(Number);
  const values: string[] = [];
  const calendarDay = Date.UTC(start.year, start.month - 1, start.day);
  // Ten weekly previews plus DST gaps fit well within this explicit bound.
  for (let day = 0; day < 400 && values.length < input.count; day += 1) {
    const date = new Date(calendarDay + day * DAY);
    if (input.rule.kind === 'weekly' && date.getUTCDay() !== input.rule.weekday) continue;
    const value = resolveCalendarWallTime({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(), hour: hour!, minute: minute! }, input.timezone);
    if (value !== null && Date.parse(value) > after) values.push(value);
  }
  if (values.length < input.count) throw new Error('schedule.previewBound');
  return values;
};
