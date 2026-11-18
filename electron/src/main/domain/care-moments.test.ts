import { describe, expect, it } from 'vitest';
import { CareMoments } from './care-moments';

const MINUTE = 60_000, start = Date.parse('2026-11-04T00:00:00Z');
const at = (minute: number, patch: { idleSeconds?: number; locked?: boolean; day?: string; minuteOfDay?: number } = {}) => ({
  now: start + minute * MINUTE, idleSeconds: 0, locked: false, day: '2026-11-04', minuteOfDay: 15 * 60, ...patch,
});

describe('care moments', () => {
  it('greets the first morning use once a day, and again the next day', () => {
    const care = new CareMoments(), morning = at(0, { minuteOfDay: 8 * 60 });
    const moment = care.next(morning)!;
    expect(moment.key).toBe('morning');
    care.offered(moment, morning);
    expect(care.next(at(1, { minuteOfDay: 8 * 60 + 1 }))).toBeNull();
    expect(care.next(at(1440, { minuteOfDay: 8 * 60, day: '2026-11-05' }))?.key).toBe('morning');
  });

  it('keeps a moment available until it is actually offered', () => {
    const care = new CareMoments(), late = at(0, { minuteOfDay: 23 * 60 + 30 });
    expect(care.next(late)?.key).toBe('late-night');
    expect(care.next(at(1, { minuteOfDay: 23 * 60 + 31 }))?.key).toBe('late-night');
    care.offered(care.next(late)!, late);
    expect(care.next(at(2, { minuteOfDay: 23 * 60 + 32 }))).toBeNull();
  });

  it('suggests a break after a long session, and a real break resets the count', () => {
    const care = new CareMoments();
    care.next(at(0));
    expect(care.next(at(60))).toBeNull();
    const long = care.next(at(95))!;
    expect(long.key).toBe('long-session');
    expect(long.summary).toContain('95 minutes');
    care.offered(long, at(95));
    expect(care.next(at(100))).toBeNull();
    care.next(at(150));
    care.next(at(156, { idleSeconds: 360 }));
    expect(care.next(at(160))).toBeNull();
    expect(care.next(at(200))).toBeNull();
    expect(care.next(at(255))?.key).toBe('long-session');
  });

  it('welcomes the owner back only after a long absence', () => {
    const care = new CareMoments();
    care.next(at(0));
    care.next(at(30, { idleSeconds: 600 }));
    expect(care.next(at(60))).toBeNull();
    care.next(at(70, { locked: true }));
    const back = care.next(at(250))!;
    expect(back.key).toBe('return');
    expect(back.summary).toContain('3 hours');
    care.offered(back, at(250));
    expect(care.next(at(251))).toBeNull();
  });

  it('does nothing while the computer is locked or idle', () => {
    const care = new CareMoments();
    expect(care.next(at(0, { locked: true, minuteOfDay: 8 * 60 }))).toBeNull();
    expect(care.next(at(1, { idleSeconds: 400, minuteOfDay: 8 * 60 }))).toBeNull();
  });
});
