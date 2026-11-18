// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calendarPreview, resolveCalendarWallTime } from './calendar-rules';

describe('calendar rules in an explicit IANA timezone', () => {
  it('uses an absolute one-time instant and requires an explicit offset', () => {
    expect(calendarPreview({ rule: { kind: 'once', at: '2026-11-01T09:00:00+08:00' }, timezone: 'Asia/Shanghai', after: '2026-11-01T00:00:00Z', count: 1 })).toEqual(['2026-11-01T01:00:00.000Z']);
    expect(() => calendarPreview({ rule: { kind: 'once', at: '2026-11-01T09:00' }, timezone: 'UTC', after: '2026-11-01T00:00:00Z', count: 1 })).toThrow('schedule.invalidInstant');
    expect(calendarPreview({ rule: { kind: 'once', at: '2026-11-01T00:00:00Z' }, timezone: 'UTC', after: '2026-11-01T00:00:00Z', count: 1 })).toEqual([]);
  });
  it('keeps local daily time across the spring DST gap and skips nonexistent time', () => {
    expect(calendarPreview({ rule: { kind: 'daily', time: '02:30' }, timezone: 'America/New_York', after: '2026-03-07T08:00:00Z', count: 3 })).toEqual([
      '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z', '2026-03-11T06:30:00.000Z',
    ]);
    expect(resolveCalendarWallTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')).toBeNull();
  });
  it('chooses the earlier fold instant once and never returns the later duplicate', () => {
    expect(calendarPreview({ rule: { kind: 'daily', time: '01:30' }, timezone: 'America/New_York', after: '2026-10-31T08:00:00Z', count: 2 })).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    expect(calendarPreview({ rule: { kind: 'daily', time: '01:30' }, timezone: 'America/New_York', after: '2026-11-01T05:45:00Z', count: 1 })).toEqual(['2026-11-02T06:30:00.000Z']);
  });
  it('handles a half-hour DST gap and a quarter-hour fixed offset', () => {
    expect(resolveCalendarWallTime({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, 'Australia/Lord_Howe')).toBeNull();
    expect(calendarPreview({ rule: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Kathmandu', after: '2026-10-29T00:00:00Z', count: 1 })).toEqual(['2026-10-29T03:15:00.000Z']);
  });
  it('computes weekly days in the chosen local calendar across year boundaries', () => {
    expect(calendarPreview({ rule: { kind: 'weekly', weekday: 1, time: '08:00' }, timezone: 'Pacific/Auckland', after: '2026-12-31T20:00:00Z', count: 2 })).toEqual(['2027-01-03T19:00:00.000Z', '2027-01-10T19:00:00.000Z']);
  });
  it('rejects unknown zones, malformed rules, calendar rollover dates and unbounded previews', () => {
    const base = { rule: { kind: 'daily', time: '09:00' } as const, timezone: 'UTC', after: '2026-10-29T00:00:00Z', count: 1 };
    expect(() => calendarPreview({ ...base, timezone: 'Unknown/Timezone' })).toThrow('schedule.invalidTimezone');
    expect(() => calendarPreview({ ...base, rule: { kind: 'daily', time: '24:00' } })).toThrow('schedule.invalidTime');
    expect(() => calendarPreview({ ...base, rule: { kind: 'weekly', time: '09:00', weekday: 7 } })).toThrow('schedule.invalidWeekday');
    expect(() => calendarPreview({ ...base, rule: { kind: 'once', at: '2026-02-30T10:00:00Z' } })).toThrow('schedule.invalidInstant');
    expect(() => calendarPreview({ ...base, count: 1000 })).toThrow('schedule.invalidPreviewCount');
  });
});
