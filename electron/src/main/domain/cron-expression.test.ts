// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cronPreview, nextCronOccurrence, parseCronExpression } from './cron-expression';

describe('numeric five-field cron calendar', () => {
  it('supports lists, ranges, steps and Sunday aliases without command syntax', () => {
    const cron = parseCronExpression('0,15,30,45 9-17/2 * 1,6-8 0,7');
    expect(cron.minute.values).toEqual([0, 15, 30, 45]);
    expect(cron.hour.values).toEqual([9, 11, 13, 15, 17]);
    expect(cron.month.values).toEqual([1, 6, 7, 8]); expect(cron.weekday.values).toEqual([0]);
  });
  it.each(['@daily', '* * * * * echo test', '* * * * *\n', '60 * * * *', '* 24 * * *', '* * 0 * *',
    '* * * 13 *', '* * * * 8', '*/0 * * * *', '4/2 * * * *', '8-2 * * * *', '* * * * MON', '1,,2 * * * *'])('rejects invalid or executable expression %s', (expression) => {
    expect(() => parseCronExpression(expression)).toThrow('cron.invalidExpression');
  });
  it('finds the next minute strictly after the supplied instant in the selected timezone', () => {
    expect(nextCronOccurrence('*/15 9-10 * * 1-5', 'Asia/Shanghai', '2026-11-02T01:15:00Z')).toBe('2026-11-02T01:30:00.000Z');
    expect(nextCronOccurrence('* * * * *', 'UTC', '2026-11-02T01:15:59.999Z')).toBe('2026-11-02T01:16:00.000Z');
  });
  it('uses OR for restricted day-of-month and weekday fields', () => {
    expect(cronPreview({ expression: '0 9 13 * 1', timezone: 'UTC', after: '2026-11-01T00:00:00Z', count: 4 })).toEqual([
      '2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-13T09:00:00.000Z', '2026-11-16T09:00:00.000Z',
    ]);
  });
  it('skips nonexistent DST wall times and executes a repeated wall time only once', () => {
    expect(nextCronOccurrence('30 2 * * *', 'America/New_York', '2026-03-08T00:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
    expect(nextCronOccurrence('30 1 * * *', 'America/New_York', '2026-11-01T00:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(nextCronOccurrence('30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');
  });
  it('finds leap days and returns null for an impossible calendar date', () => {
    expect(nextCronOccurrence('0 0 29 2 *', 'UTC', '2026-11-02T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(nextCronOccurrence('0 0 31 2 *', 'UTC', '2026-11-02T00:00:00Z')).toBeNull();
  });
  it('rejects invalid timezone, instant and preview bounds', () => {
    expect(() => nextCronOccurrence('* * * * *', 'Not/A_Timezone', '2026-11-02T00:00:00Z')).toThrow('cron.invalidTimezone');
    expect(() => nextCronOccurrence('* * * * *', 'UTC', 'bad-date')).toThrow('cron.invalidInstant');
    expect(() => cronPreview({ expression: '* * * * *', timezone: 'UTC', after: '2026-11-02T00:00:00Z', count: 11 })).toThrow('cron.invalidPreviewCount');
  });
});
