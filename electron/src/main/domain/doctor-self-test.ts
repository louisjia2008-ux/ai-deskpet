import { DOCTOR_SELF_TEST_STAGES, type DoctorSelfTestDay, type DoctorSelfTestRecord, type DoctorState } from '../../shared/doctor';
import type { DoctorFinding } from './doctor';

type Schedule = DoctorState['selfTestSchedule'];
export const doctorDay = (now: Date, timeZone?: string): string => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
export const afterDoctorMorning = (now: Date, timeZone?: string): boolean =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now)) >= 7;

export const selfTestDue = (schedule: Schedule, now: Date, timeZone?: string): boolean => {
  if (!afterDoctorMorning(now, timeZone)) return false;
  if (schedule.pending) return true; // Replay the same ID after an interrupted host exchange.
  if (schedule.day !== doctorDay(now, timeZone)) return true;
  return !schedule.complete && schedule.attempts < 6 && (!schedule.nextAt || Date.parse(schedule.nextAt) <= now.getTime());
};

/** Observe only actual eligible local dates; never invent coverage for time the app was offline. */
export const observeSelfTestDay = (schedule: Schedule, now: Date, paused: boolean, timeZone?: string): Schedule => {
  const day = doctorDay(now, timeZone), previous = schedule.coverage.find(item => item.day === day);
  const coverage = { day, attempts: Math.max(previous?.attempts ?? 0, schedule.day === day ? schedule.attempts : 0), paused: paused || (previous?.paused ?? false) };
  return { ...schedule, coverage: [...schedule.coverage.filter(item => item.day !== day), coverage].sort((a, b) => a.day.localeCompare(b.day)).slice(-14) };
};

export const applySelfTest = (schedule: Schedule, record: DoctorSelfTestRecord, completedAt = new Date(record.at), timeZone?: string): Schedule => {
  let next = { ...schedule, pending: null };
  if (record.source === 'auto' || record.status === 'paused') next = { ...observeSelfTestDay(next, new Date(record.at), record.status === 'paused', timeZone), pending: null };
  if (record.status === 'passed' || record.status === 'failed' || record.status === 'uncertain') next.lastConclusiveAt = completedAt.toISOString();
  if (record.status === 'passed') { next.failures = 0; next.failure = null; }
  if (record.source === 'manual') return next; // Manual failures are page-only, never proactive reports.
  if (record.status === 'passed') next.complete = true;
  else if (record.status === 'failed' || record.status === 'uncertain') {
    next.failures++;
    next.failure = { status: record.status, stage: DOCTOR_SELF_TEST_STAGES.find(stage => !record.stages[stage]) ?? 'dbReceipt' };
    next.nextAt = new Date(Date.parse(record.at) + 30 * 60_000).toISOString();
    if (next.failures >= 2) next.complete = true;
  } else next.nextAt = new Date(Date.parse(record.at) + 10 * 60_000).toISOString();
  return next;
};

export const selfTestFindings = (schedule: Schedule, now: Date, timeZone?: string): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  if (schedule.failures >= 2 && schedule.failure) {
    const uncertain = schedule.failure.status === 'uncertain';
    const code = uncertain ? 'wechat.selfTestUncertain' : 'wechat.selfTestFailed';
    findings.push({ key: `wechat:${code}`, feature: 'wechat', code, severity: uncertain ? 'warning' : 'error', event: false, detail: schedule.failure.stage });
  }
  const today = doctorDay(now, timeZone);
  const last = schedule.lastConclusiveAt ? doctorDay(new Date(schedule.lastConclusiveAt), timeZone) : '';
  const missed = schedule.coverage.filter(item => item.day > last && item.day <= today && !item.paused && (item.day < today || item.attempts >= 6));
  if (missed.some((item, index) => index > 0 && Date.parse(item.day) - Date.parse(missed[index - 1]!.day) === 86_400_000))
    findings.push({ key: 'wechat:wechat.selfTestSkipped', feature: 'wechat', code: 'wechat.selfTestSkipped', severity: 'warning', event: false, detail: '2' });
  return findings;
};

/** Daily pass rate (not retries): latest conclusive automatic result on each of the last 14 local days. */
export const selfTestDays = (days: readonly DoctorSelfTestDay[], records: readonly DoctorSelfTestRecord[], timeZone?: string): DoctorSelfTestDay[] => {
  const byDay = new Map(days.map(day => [day.day, day]));
  for (const record of records) {
    if (record.source !== 'auto' || (record.status !== 'passed' && record.status !== 'failed' && record.status !== 'uncertain')) continue;
    const day = doctorDay(new Date(record.at), timeZone);
    if (!byDay.has(day) || record.at >= byDay.get(day)!.at) byDay.set(day, { day, at: record.at, status: record.status });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
};

export const selfTestPassRate = (records: readonly DoctorSelfTestRecord[], now: Date, timeZone?: string, history: readonly DoctorSelfTestDay[] = []): number | null => {
  const days = new Map<string, boolean>();
  const today = doctorDay(now, timeZone), first = new Date(Date.parse(today) - 13 * 86_400_000).toISOString().slice(0, 10);
  for (const day of selfTestDays(history, records, timeZone)) if (day.day >= first && day.day <= today) days.set(day.day, day.status === 'passed');
  return days.size ? [...days.values()].filter(Boolean).length / days.size : null;
};
