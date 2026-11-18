import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorSelfTestResultSchema, doctorSelfTestScheduleSchema, type DoctorSelfTestResult } from '../../shared/doctor';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import { DoctorService } from './doctor-service';
import { applySelfTest, observeSelfTestDay, selfTestDays, selfTestDue, selfTestFindings, selfTestPassRate } from './doctor-self-test';

const at = (time: string) => new Date(`2026-11-17T${time}:00+08:00`);
const result = (status: DoctorSelfTestResult['status']): DoctorSelfTestResult => ({ status, code: status === 'failed' ? 'self_test_target' : null,
  durationMs: 10, stages: { lock: true, open: status === 'passed', title: status === 'passed', paste: status === 'passed', click: status === 'passed', ocrReceipt: status === 'passed', dbReceipt: status === 'passed' } });
const TZ = 'Asia/Shanghai';
const dayAt = (day: string, time = '09:00') => new Date(`${day}T${time}:00+08:00`);
const skipped = (schedule: ReturnType<typeof doctorSelfTestScheduleSchema.parse>, now: Date) => selfTestFindings(schedule, now, TZ).some(item => item.code === 'wechat.selfTestSkipped');
const missDay = (schedule: ReturnType<typeof doctorSelfTestScheduleSchema.parse>, day: string, status: 'busy' | 'skipped' | 'paused' = 'busy', attempts = 6) => {
  for (let n = 1; n <= attempts; n++) schedule = applySelfTest({ ...schedule, day, attempts: n },
    { ...result(status), source: 'auto', at: dayAt(day).toISOString() }, dayAt(day), TZ);
  return schedule;
};
describe('doctor send schedule', () => {
  it('does not run before 07:00, catches up after sleep, retries at 30 minutes, opens after two failures and recovers on one pass', () => {
    let schedule = doctorSelfTestScheduleSchema.parse({});
    expect(selfTestDue(schedule, at('06:59'), TZ)).toBe(false);
    expect(selfTestDue(schedule, at('10:00'), TZ)).toBe(true);
    schedule = applySelfTest({ ...schedule, day: '2026-11-17', attempts: 1 }, { ...result('failed'), source: 'auto', at: at('10:00').toISOString() });
    expect(selfTestFindings(schedule, at('10:00'), TZ)).toEqual([]);
    expect(selfTestDue(schedule, at('10:29'), TZ)).toBe(false);
    expect(selfTestDue(schedule, at('10:30'), TZ)).toBe(true);
    schedule = applySelfTest(schedule, { ...result('failed'), source: 'auto', at: at('10:30').toISOString() });
    expect(selfTestFindings(schedule, at('10:30'), TZ)[0]).toMatchObject({ code: 'wechat.selfTestFailed', severity: 'error', detail: 'open' });
    expect(selfTestFindings(applySelfTest(schedule, { ...result('passed'), source: 'manual', at: at('11:00').toISOString() }), at('11:00'), TZ)).toEqual([]);
  });

  it('bounds busy retries and keeps manual failures out of proactive findings', () => {
    let schedule = doctorSelfTestScheduleSchema.parse({ day: '2026-11-17' });
    for (let attempt = 1; attempt <= 6; attempt++) {
      schedule = { ...schedule, attempts: attempt };
      schedule = applySelfTest(schedule, { ...result('busy'), source: 'auto', at: at('07:00').toISOString() });
    }
    expect(selfTestDue(schedule, at('08:00'), TZ)).toBe(false);
    for (let i = 0; i < 5; i++) schedule = applySelfTest(schedule, { ...result('failed'), source: 'manual', at: at('10:00').toISOString() });
    expect(selfTestFindings(schedule, at('10:00'), TZ)).toEqual([]);
  });

  it('does not accept OCR-only success and preserves 14 daily results regardless of retry/manual history churn', () => {
    expect(doctorSelfTestResultSchema.safeParse({ ...result('passed'), stages: { ...result('passed').stages, dbReceipt: false } }).success).toBe(false);
    let days: ReturnType<typeof selfTestDays> = [];
    for (let n = 4; n <= 17; n++) days = selfTestDays(days, [{ ...result(n === 17 ? 'failed' : 'passed'),
      at: new Date(`2026-11-${String(n).padStart(2, '0')}T07:00:00+08:00`).toISOString(), source: 'auto' }], TZ);
    expect(days).toHaveLength(14);
    const manualHistory = Array.from({ length: 14 }, () => ({ ...result('passed'), source: 'manual' as const, at: at('08:00').toISOString() }));
    expect(selfTestPassRate(manualHistory, at('09:00'), TZ, days)).toBe(13 / 14);
    days = selfTestDays(days, [{ ...result('passed'), source: 'auto', at: at('09:30').toISOString() }], TZ);
    expect(selfTestPassRate(manualHistory, at('10:00'), TZ, days)).toBe(1);
  });

  it('warns only after two adjacent local dates without conclusions, not six retries on one date', () => {
    let schedule = missDay(doctorSelfTestScheduleSchema.parse({}), '2026-11-17');
    expect(skipped(schedule, dayAt('2026-11-17'))).toBe(false);
    schedule = missDay(schedule, '2026-11-18', 'skipped', 5);
    expect(skipped(schedule, dayAt('2026-11-18'))).toBe(false);
    schedule = missDay(schedule, '2026-11-18', 'skipped');
    expect(selfTestFindings(schedule, dayAt('2026-11-18'), TZ)).toEqual([
      expect.objectContaining({ code: 'wechat.selfTestSkipped', severity: 'warning', detail: '2' }),
    ]);
    schedule = observeSelfTestDay(schedule, dayAt('2026-11-19'), false, TZ);
    expect(skipped(schedule, dayAt('2026-11-19'))).toBe(true); // No spurious recovery at the next date boundary.
  });

  it('counts ended dates but does not invent offline dates or count explicitly paused dates', () => {
    let schedule = missDay(doctorSelfTestScheduleSchema.parse({}), '2026-11-17', 'skipped', 1);
    schedule = missDay(schedule, '2026-11-18', 'busy', 1);
    expect(skipped(schedule, dayAt('2026-11-18'))).toBe(false);
    expect(skipped(schedule, dayAt('2026-11-19'))).toBe(true);
    schedule = observeSelfTestDay(schedule, dayAt('2026-11-18'), true, TZ);
    expect(skipped(schedule, dayAt('2026-11-19'))).toBe(false);
    schedule = missDay(schedule, '2026-11-19');
    expect(skipped(schedule, dayAt('2026-11-19'))).toBe(false);
    expect(skipped(missDay(schedule, '2026-11-21'), dayAt('2026-11-21'))).toBe(false);
    expect(skipped(missDay(schedule, '2026-11-20', 'paused'), dayAt('2026-11-21'))).toBe(false);
  });

  it.each(['passed', 'failed', 'uncertain'] as const)('one %s conclusion clears skipped dates, including manual results without adding failures', status => {
    const schedule = missDay(missDay(doctorSelfTestScheduleSchema.parse({}), '2026-11-17'), '2026-11-18');
    for (const source of ['auto', 'manual'] as const) {
      const next = applySelfTest(schedule, { ...result(status), source, at: dayAt('2026-11-18', '10:00').toISOString() }, dayAt('2026-11-18', '10:00'), TZ);
      expect(skipped(next, dayAt('2026-11-18', '11:00'))).toBe(false);
      if (source === 'manual') expect(next.failures).toBe(0);
    }
  });
});

describe('doctor send integration', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it('persists attempts, caps manual tests, never tests on checkup and closes an already reported case on pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'doctor-self-test-'));
    let now = at('06:59');
    const test = vi.fn(async () => result('failed')), sendQq = vi.fn(async () => true);
    const doctor = new DoctorService({ path: join(root, 'doctor.json'), timeZone: TZ, now: () => now,
      inputs: async () => ({ health: { checkedAt: now.toISOString(), items: [], issues: 0 }, wechat: { configured: true } as WeChatChannelState }),
      available: () => true, diskFree: async () => null, notifyDesktop: () => true, sendQq, changed: () => undefined, wechatSelfTest: test });
    await doctor.initialize();
    await doctor.check(); expect(test).not.toHaveBeenCalled();
    now = at('09:00'); await doctor.check();
    expect(doctor.status().open).toBe(0);
    now = at('09:29'); await doctor.check(); expect(test).toHaveBeenCalledTimes(1);
    now = at('09:30'); await doctor.check(); await doctor.check();
    expect(doctor.status().cases[0]).toMatchObject({ code: 'wechat.selfTestFailed', reported: 'qq' });
    await doctor.checkup(); expect(test).toHaveBeenCalledTimes(2);
    test.mockImplementation(async () => result('passed'));
    const before = sendQq.mock.calls.length;
    await doctor.testWeChatNow(); expect(sendQq.mock.calls.length).toBe(before);
    await doctor.check();
    expect(doctor.status().open).toBe(0);
    expect(sendQq).toHaveBeenCalledTimes(before + 1);
    for (let n = 1; n < 5; n++) await doctor.testWeChatNow();
    await expect(doctor.testWeChatNow()).rejects.toThrow('doctor.manualLimit');
    const saved = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).data;
    expect(saved.selfTests).toHaveLength(7);
    expect(saved.selfTests.some((row: object) => 'text' in row || 'id' in row)).toBe(false);
    expect(doctor.status().manualSelfTestsToday).toBe(5);
    await doctor.shutdown();
  });

  it('persists skipped-date coverage across restart and recovers on a manual conclusion without alerting on that action', async () => {
    root = await mkdtemp(join(tmpdir(), 'doctor-self-test-'));
    let now = dayAt('2026-11-17');
    const test = vi.fn(async () => result('skipped')), sendQq = vi.fn(async () => true);
    const deps = { path: join(root, 'doctor.json'), timeZone: TZ, now: () => now,
      inputs: async () => ({ health: { checkedAt: now.toISOString(), items: [], issues: 0 }, wechat: { configured: true, paused: false } as WeChatChannelState }),
      available: () => true, diskFree: async () => null, notifyDesktop: () => true, sendQq, changed: () => undefined, wechatSelfTest: test };
    const doctor = new DoctorService(deps); await doctor.initialize();
    for (const day of ['2026-11-17', '2026-11-18']) {
      for (let n = 0; n < 6; n++) { now = new Date(+dayAt(day) + n * 10 * 60_000); await doctor.check(); }
      await doctor.check();
    }
    expect(test).toHaveBeenCalledTimes(12);
    expect(doctor.status().cases).toEqual([expect.objectContaining({ code: 'wechat.selfTestSkipped', reported: 'qq' })]);
    expect(sendQq).toHaveBeenCalledOnce();
    await doctor.shutdown();
    const restarted = new DoctorService(deps); await restarted.initialize(); await restarted.check();
    expect(test).toHaveBeenCalledTimes(12);
    expect(restarted.status().open).toBe(1);
    now = dayAt('2026-11-19'); await restarted.check();
    expect(restarted.status().open).toBe(1);
    test.mockImplementation(async () => result('failed'));
    await restarted.testWeChatNow(); expect(sendQq).toHaveBeenCalledOnce();
    await restarted.check();
    expect(restarted.status().open).toBe(0);
    expect(sendQq).toHaveBeenCalledTimes(2); // Ordinary recovery, not a manual-test alert.
    const saved = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).data;
    expect(saved.selfTestSchedule.failures).toBe(0);
    expect(saved.selfTestSchedule.coverage).toHaveLength(3);
    await restarted.shutdown();
  });

  it('does not spend automatic attempts or count days while the owner has paused the listener', async () => {
    root = await mkdtemp(join(tmpdir(), 'doctor-self-test-'));
    let now = dayAt('2026-11-17', '06:00'), paused = true;
    const test = vi.fn(async () => result('busy'));
    const doctor = new DoctorService({ path: join(root, 'doctor.json'), timeZone: TZ, now: () => now,
      inputs: async () => ({ health: { checkedAt: now.toISOString(), items: [], issues: 0 }, wechat: { configured: true, paused, state: paused ? 'paused' : 'running' } as WeChatChannelState }),
      available: () => true, diskFree: async () => null, notifyDesktop: () => true, sendQq: async () => true, changed: () => undefined, wechatSelfTest: test });
    await doctor.initialize(); await doctor.check();
    now = dayAt('2026-11-17'); await doctor.check(); expect(test).not.toHaveBeenCalled();
    paused = false;
    for (let n = 0; n < 6; n++) { now = new Date(+dayAt('2026-11-18') + n * 10 * 60_000); await doctor.check(); }
    await doctor.check(); expect(doctor.status().open).toBe(0);
    const saved = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).data;
    expect(saved.selfTestSchedule.coverage[0]).toEqual({ day: '2026-11-17', attempts: 0, paused: true });
    await doctor.shutdown();
  });
});
