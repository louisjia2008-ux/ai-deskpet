import { createHash } from 'node:crypto';
import type { HealthSnapshot } from '../../shared/attention';
import { doctorStateSchema, doctorSelfTestResultSchema, doctorVmHealthSchema, doctorProviderTestResultSchema, doctorDiagnosisSchema, type DoctorCase, type DoctorProviderTestResult, type DoctorSelfTestResult, type DoctorState, type DoctorStatus, type DoctorVmHealth } from '../../shared/doctor';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import { AtomicJsonStore } from '../persistence/atomic-json-store';
import {
  DOCTOR_DAILY_LIMIT, acknowledgedDoctorKeys, doctorFindings, formatCheckup, formatDoctorReport, isDoctorQuiet, planDoctorReport, reconcileDoctor, sanitizeDoctorCase,
} from './doctor';
import { afterDoctorMorning, applySelfTest, doctorDay, observeSelfTestDay, selfTestDays, selfTestDue, selfTestFindings, selfTestPassRate } from './doctor-self-test';
import { applyVmHealth, formatVmHealth, vmHealthDue, vmHealthFindings } from './doctor-vm';
import { doctorDeadline, doctorDiagnosisInput, type DoctorDiagnosisInput } from './doctor-diagnosis';
import { doctorRunbook } from './doctor-runbook';
import { providerTestFindings } from './doctor-provider-test';

export interface DoctorServiceDeps {
  path: string;
  inputs(): Promise<{ health: HealthSnapshot; wechat: WeChatChannelState | null }>;
  diskFree(): Promise<number | null>;
  /** True only when QQ confirmed the message. */
  sendQq(text: string): Promise<boolean>;
  notifyDesktop(text: string): boolean;
  /** False while the app is closing or its profile is in maintenance. */
  available(): boolean;
  changed(): void;
  now?(): Date;
  timeZone?: string;
  wechatSelfTest?(input: { id: string; text: string }): Promise<DoctorSelfTestResult>;
  vmHealth?(): Promise<DoctorVmHealth>;
  diagnose?(input: DoctorDiagnosisInput, localOnly: boolean, signal: AbortSignal): Promise<{ text: string; source: 'cloud' | 'local' } | null>;
  providerTest?(signal: AbortSignal): Promise<DoctorProviderTestResult | null>;
}

const initial = (): DoctorState => doctorStateSchema.parse({ enabled: true, cases: [], alerts: { day: '', count: 0 }, session: null });
const same = (a: DoctorCase, b: DoctorCase): boolean => a.key === b.key && a.openedAt === b.openedAt;

/** A second agent that watches the first: it reads health and reports problems to the owner,
 * over QQ when it can and a desktop notification when it cannot. It only looks and tells. */
export class DoctorService {
  readonly #store: AtomicJsonStore<DoctorState>;
  #state = initial();
  #uncleanExitOf: string | null = null;
  #lastCheckAt: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #timers: NodeJS.Timeout[] = [];
  #ready = false;
  #checking: Promise<void> | null = null;

  constructor(private readonly deps: DoctorServiceDeps) {
    this.#store = new AtomicJsonStore({ path: deps.path, schemaVersion: 1, schema: doctorStateSchema, defaultValue: initial });
  }

  #now(): Date { return this.deps.now?.() ?? new Date(); }

  async initialize(): Promise<void> {
    // An unreadable case log is quarantined by the store; the doctor starts over rather than stopping the app.
    this.#state = await this.#store.load().catch(initial);
    this.#state.cases = this.#state.cases.map(sanitizeDoctorCase);
    this.#state.selfTestDays = selfTestDays(this.#state.selfTestDays, this.#state.selfTests, this.deps.timeZone);
    const previous = this.#state.session;
    this.#uncleanExitOf = previous && !previous.cleanExit ? previous.startedAt : null;
    this.#state = { ...this.#state, session: { startedAt: this.#now().toISOString(), cleanExit: false } };
    await this.#store.save(this.#state);
    this.#ready = true;
  }

  start(intervalMs = 60_000, firstDelayMs = 90_000): void {
    // Give the channels time to connect before the first look.
    this.#timers.push(setTimeout(() => { void this.check().catch(() => undefined); }, firstDelayMs),
      setInterval(() => { void this.check().catch(() => undefined); }, intervalMs));
  }

  async shutdown(): Promise<void> {
    this.dispose();
    if (!this.#ready || !this.#state.session) return;
    this.#state = { ...this.#state, session: { ...this.#state.session, cleanExit: true } };
    await this.#store.save(this.#state);
  }

  dispose(): void { for (const timer of this.#timers.splice(0)) clearTimeout(timer); }

  status(): DoctorStatus {
    const cases = [...this.#state.cases].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    return { enabled: this.#state.enabled, lastCheckAt: this.#lastCheckAt, open: cases.filter(entry => entry.resolvedAt === null).length,
      alertsToday: this.#state.alerts.day === this.#day() ? this.#state.alerts.count : 0, dailyLimit: DOCTOR_DAILY_LIMIT, cases,
      selfTests: structuredClone(this.#state.selfTests), selfTestPassRate: selfTestPassRate(this.#state.selfTests, this.#now(), this.deps.timeZone, this.#state.selfTestDays),
      manualSelfTestsToday: this.#state.selfTestSchedule.manualDay === this.#day() ? this.#state.selfTestSchedule.manualCount : 0,
      vm: structuredClone(this.#state.vm), diagnosis: this.#state.diagnosis ? { ...this.#state.diagnosis } : null,
      runbooks: Object.fromEntries(cases.map(entry => [entry.code, structuredClone(doctorRunbook(entry.code))])), providerTests: structuredClone(this.#state.providerTests) };
  }

  async setEnabled(enabled: boolean): Promise<DoctorStatus> {
    await this.#serial(async () => { this.#state = { ...this.#state, enabled }; await this.#store.save(this.#state); });
    this.deps.changed();
    return this.status();
  }

  acknowledgeHealth(health: HealthSnapshot, wechat: WeChatChannelState | null): Promise<void> {
    const keys = acknowledgedDoctorKeys(health, wechat);
    return this.#serial(async () => {
      if (!this.#ready || !keys.size) return;
      const now = this.#now().toISOString();
      const cases = this.#state.cases.map(entry => entry.resolvedAt === null && keys.has(entry.key)
        ? { ...entry, resolvedAt: now, acknowledged: true as const } : entry);
      if (!cases.some((entry, index) => entry !== this.#state.cases[index])) return;
      const next = { ...this.#state, cases };
      await this.#store.save(next);
      this.#state = next;
    });
  }

  check(): Promise<void> {
    this.#checking ??= this.#serial(() => this.#check()).finally(() => { this.#checking = null; });
    return this.#checking;
  }

  testWeChatNow(): Promise<DoctorStatus> {
    return this.#serial(async () => {
      if (!this.#ready || !this.#state.enabled || !this.deps.available() || !this.deps.wechatSelfTest) throw new Error('doctor.unavailable');
      const { wechat } = await this.deps.inputs();
      if (!wechat?.configured) throw new Error('doctor.unavailable');
      const schedule = this.#state.selfTestSchedule;
      if (schedule.manualDay === this.#day() && schedule.manualCount >= 5) throw new Error('doctor.manualLimit');
      if (schedule.pending) await this.#runSelfTest(schedule.pending.source);
      await this.#runSelfTest('manual');
      return this.status();
    });
  }

  async #runSelfTest(source: 'auto' | 'manual'): Promise<void> {
    if (!this.deps.wechatSelfTest || !this.deps.available() || !this.#ready || !this.#state.enabled) return;
    let schedule = this.#state.selfTestSchedule;
    if (!schedule.pending) {
      schedule = { ...schedule, pending: { at: this.#now().toISOString(), source } };
      if (source === 'manual') schedule = { ...schedule, manualDay: this.#day(), manualCount: (schedule.manualDay === this.#day() ? schedule.manualCount : 0) + 1 };
      else schedule = { ...schedule, day: this.#day(), attempts: (schedule.day === this.#day() ? schedule.attempts : 0) + 1, complete: false };
      this.#state = { ...this.#state, selfTestSchedule: schedule };
      await this.#store.save(this.#state); // Persist the attempt before crossing the process boundary.
    }
    const pending = schedule.pending!;
    const ordinal = pending.source === 'manual' ? schedule.manualCount : schedule.attempts;
    const id = createHash('sha256').update(`doctor/self-test/v2/${pending.source}/${pending.at}/${ordinal}`).digest('hex');
    const marker = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: this.deps.timeZone }).format(new Date(pending.at));
    const started = Date.now();
    let result: DoctorSelfTestResult;
    try { result = doctorSelfTestResultSchema.parse(await this.deps.wechatSelfTest({ id, text: `【医生】每日发送自检 ${marker}，不用回复。#${id.slice(0, 8)}` })); }
    catch { result = { status: 'uncertain', code: 'self_test_db_unconfirmed', durationMs: Date.now() - started,
      stages: { lock: false, open: false, title: false, paste: false, click: false, ocrReceipt: false, dbReceipt: false } }; }
    const record = { ...result, ...pending };
    this.#state = { ...this.#state, selfTestSchedule: applySelfTest(schedule, record, this.#now(), this.deps.timeZone), selfTests: [...this.#state.selfTests, record].slice(-14),
      selfTestDays: selfTestDays(this.#state.selfTestDays, [record], this.deps.timeZone) };
    await this.#store.save(this.#state);
    this.deps.changed();
  }

  async #sampleVm(): Promise<void> {
    if (!this.deps.vmHealth || !this.#ready || !this.deps.available() || !vmHealthDue(this.#state.vm, this.#now())) return;
    const now = this.#now();
    this.#state = { ...this.#state, vm: { ...this.#state.vm, attemptedAt: now.toISOString() } };
    await this.#store.save(this.#state);
    let health: DoctorVmHealth | null;
    try { health = doctorVmHealthSchema.parse(await this.deps.vmHealth()); } catch { health = null; }
    this.#state = { ...this.#state, vm: applyVmHealth(this.#state.vm, health, now) };
    await this.#store.save(this.#state);
    this.deps.changed();
  }

  async #diagnose(cases: DoctorCase[], diskFreeBytes: number | null): Promise<string | null> {
    const day = this.#day();
    const count = this.#state.diagnoses.day === day ? this.#state.diagnoses.count : 0;
    if (!this.deps.diagnose || count >= 6 || !this.deps.available()) return null;
    // Reserve before calling: failed, timed out and interrupted calls count as attempts too.
    this.#state = { ...this.#state, diagnoses: { day, count: count + 1 } };
    await this.#store.save(this.#state);
    const now = this.#now();
    const input = doctorDiagnosisInput({ cases, diskFreeBytes, selfTests: this.#state.selfTests, vm: this.#state.vm,
      startedAt: this.#state.session?.startedAt ?? now.toISOString(), uncleanExit: this.#uncleanExitOf !== null }, now);
    try {
      const localOnly = cases.some(entry => entry.resolvedAt === null && entry.code.startsWith('provider.'));
      const result = await doctorDeadline(signal => this.deps.diagnose!(input, localOnly, signal), 25_000);
      if (!result || (localOnly && result.source !== 'local') || !this.deps.available()) return null;
      const diagnosis = doctorDiagnosisSchema.parse({ at: this.#now().toISOString(), source: result.source, text: result.text });
      this.#state = { ...this.#state, diagnosis };
      await this.#store.save(this.#state);
      this.deps.changed();
      return result.text;
    } catch { return null; }
  }

  async #probeProvider(): Promise<void> {
    if (!this.deps.providerTest || !afterDoctorMorning(this.#now(), this.deps.timeZone) || this.#state.providerTestDay === this.#day() || !this.deps.available()) return;
    const at = this.#now().toISOString(), day = this.#day(), started = Date.now();
    this.#state = { ...this.#state, providerTestDay: day };
    await this.#store.save(this.#state);
    let result: DoctorProviderTestResult;
    try {
      const output = await doctorDeadline(signal => this.deps.providerTest!(signal), 45_000);
      result = output === null ? { status: 'skipped', code: null, durationMs: 0 } : doctorProviderTestResultSchema.parse(output);
    } catch { result = { status: 'failed', code: 'provider.timeout', durationMs: Date.now() - started }; }
    this.#state = { ...this.#state, providerTests: [...this.#state.providerTests, { ...result, at, day }].slice(-14) };
    await this.#store.save(this.#state);
    this.deps.changed();
  }

  /** A fresh look for the owner's 「体检」. It does not open or report cases. */
  checkup(): Promise<string> {
    return this.#serial(async () => {
      const { health, wechat } = await this.deps.inputs(), disk = await this.deps.diskFree();
      if (wechat && (wechat.configured || this.#state.vm.attemptedAt)) await this.#sampleVm();
      const findings = this.#findings(health, wechat, disk);
      const acknowledged = acknowledgedDoctorKeys(health, wechat);
      const cases = reconcileDoctor(this.#state.cases, findings, this.#now(), acknowledged);
      const diagnosis = await this.#diagnose(cases.filter(entry => !acknowledged.has(entry.key)), disk);
      const text = formatCheckup(health, findings, disk, this.#now(), this.deps.timeZone, diagnosis);
      return wechat && (wechat.configured || this.#state.vm.attemptedAt) ? `${text}\n${formatVmHealth(this.#state.vm)}` : text;
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #day(): string { return doctorDay(this.#now(), this.deps.timeZone); }

  #findings(health: HealthSnapshot, wechat: WeChatChannelState | null, disk: number | null) {
    return [...doctorFindings(health, { diskFreeBytes: disk, uncleanExitOf: this.#uncleanExitOf, wechat }),
      ...selfTestFindings(this.#state.selfTestSchedule, this.#now(), this.deps.timeZone), ...vmHealthFindings(this.#state.vm), ...providerTestFindings(this.#state.providerTests)];
  }

  async #check(): Promise<void> {
    if (!this.#ready || !this.#state.enabled || !this.deps.available()) return;
    const { health, wechat } = await this.deps.inputs(), disk = await this.deps.diskFree();
    if (wechat && (wechat.configured || this.#state.vm.attemptedAt)) await this.#sampleVm();
    if (!this.deps.available()) return;
    const paused = wechat?.paused === true || wechat?.state === 'paused';
    if (wechat?.configured && this.deps.wechatSelfTest && (paused || afterDoctorMorning(this.#now(), this.deps.timeZone))) {
      const schedule = observeSelfTestDay(this.#state.selfTestSchedule, this.#now(), paused, this.deps.timeZone);
      if (JSON.stringify(schedule) !== JSON.stringify(this.#state.selfTestSchedule)) {
        this.#state = { ...this.#state, selfTestSchedule: schedule };
        await this.#store.save(this.#state);
      }
    }
    if (wechat?.configured && !paused && this.deps.wechatSelfTest && !vmHealthFindings(this.#state.vm).some(entry => entry.code === 'wechat.vmDiskCritical')
      && selfTestDue(this.#state.selfTestSchedule, this.#now(), this.deps.timeZone)) await this.#runSelfTest('auto');
    if (!vmHealthFindings(this.#state.vm).some(entry => entry.code === 'wechat.vmDiskCritical')) await this.#probeProvider();
    const now = this.#now();
    const findings = this.#findings(health, wechat, disk);
    const acknowledged = acknowledgedDoctorKeys(health, wechat);
    let cases = reconcileDoctor(this.#state.cases, findings, now, acknowledged);
    const reportable = cases.filter(entry => !acknowledged.has(entry.key));
    const plan = planDoctorReport(reportable, isDoctorQuiet(now, this.deps.timeZone));
    const at = now.toISOString();
    cases = cases.map(entry => plan.held.some(held => same(held, entry)) ? { ...entry, reported: 'held' as const, reportedAt: at } : entry);
    let alerts = this.#state.alerts.day === this.#day() ? this.#state.alerts : { day: this.#day(), count: 0 };
    const diagnosis = plan.problems.some(entry => entry.severity === 'error') ? await this.#diagnose(reportable, disk) : null;
    const text = formatDoctorReport(plan, this.deps.timeZone, diagnosis);
    if (text && this.deps.available()) {
      let via: DoctorCase['reported'] = 'failed';
      if (alerts.count < DOCTOR_DAILY_LIMIT && await this.deps.sendQq(text).catch(() => false)) {
        via = 'qq'; alerts = { ...alerts, count: alerts.count + 1 };
      } else if (this.deps.notifyDesktop(text)) via = 'desktop';
      cases = cases.map(entry => plan.problems.some(problem => same(problem, entry)) ? { ...entry, reported: via, reportedAt: at }
        : plan.recovered.some(recovered => same(recovered, entry)) ? { ...entry, recoveryReported: true } : entry);
    }
    this.#lastCheckAt = at;
    const next = { ...this.#state, cases, alerts };
    if (JSON.stringify(next) !== JSON.stringify(this.#state)) {
      this.#state = next;
      await this.#store.save(next);
      this.deps.changed();
    }
  }
}
