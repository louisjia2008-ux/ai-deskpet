import { safeDoctorCode, safeDoctorDetail, safeDoctorFeature, type DoctorCase, type DoctorSelfTestRecord, type DoctorState } from '../../shared/doctor';
import { doctorRunbook, groupDoctorProblems } from './doctor-runbook';

export interface DoctorDiagnosisFacts {
  cases: readonly DoctorCase[];
  selfTests: readonly DoctorSelfTestRecord[];
  vm: DoctorState['vm'];
  diskFreeBytes: number | null;
  startedAt: string;
  uncleanExit: boolean;
}

/** Explicit projection, never object spreading runtime errors, provider configs or health snapshots. */
export const doctorDiagnosisInput = (facts: DoctorDiagnosisFacts, now: Date) => {
  const entry = (item: DoctorCase) => ({ feature: safeDoctorFeature(item.feature), code: safeDoctorCode(item.code), severity: item.severity,
    detail: safeDoctorDetail(item.detail), openedAt: item.openedAt, seen: item.seen });
  const open = facts.cases.filter(item => item.resolvedAt === null);
  const closed = facts.cases.filter(item => !item.acknowledged && item.resolvedAt !== null && Date.parse(item.resolvedAt) >= now.getTime() - 86_400_000);
  const vm = facts.vm.latest;
  return {
    open: open.map(entry), closed: closed.map(item => ({ ...entry(item), resolvedAt: item.resolvedAt })),
    selfTests: facts.selfTests.slice(-3).map(item => ({ at: item.at, status: item.status, code: item.code,
      stages: { lock: item.stages.lock, open: item.stages.open, title: item.stages.title, paste: item.stages.paste,
        click: item.stages.click, ocrReceipt: item.stages.ocrReceipt, dbReceipt: item.stages.dbReceipt }, durationMs: item.durationMs })),
    vm: vm ? { at: vm.at, totalBytes: vm.totalBytes, freeBytes: vm.freeBytes, authLogBytes: vm.authLogBytes,
      journalBytes: vm.journalBytes, uptimeSeconds: vm.uptimeSeconds, wechatRunning: vm.wechatRunning, growth24hBytes: vm.growth24hBytes } : null,
    diskFreeBytes: facts.diskFreeBytes, startedAt: facts.startedAt, uncleanExit: facts.uncleanExit,
    runbook: [...new Set([...open, ...closed].map(item => safeDoctorCode(item.code)))].map(code => ({ code, ...doctorRunbook(code) })),
    groups: groupDoctorProblems(open).filter(group => group.title).map(group => ({ type: group.title, codes: group.entries.map(item => safeDoctorCode(item.code)) })),
  };
};
export type DoctorDiagnosisInput = ReturnType<typeof doctorDiagnosisInput>;

/** A hard wall-clock timeout, including adapters or metadata calls that ignore AbortSignal. */
export const doctorDeadline = async <T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> => {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('doctor.timeout')), { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try { signal.throwIfAborted(); return await Promise.race([work(signal), abort]); }
  finally { clearTimeout(timer); controller.abort(); }
};
