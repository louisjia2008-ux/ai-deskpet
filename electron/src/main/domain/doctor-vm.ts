import type { DoctorState, DoctorVmHealth } from '../../shared/doctor';
import type { DoctorFinding } from './doctor';

type VmState = DoctorState['vm'];
const GB = 1024 ** 3;
export const vmHealthDue = (state: VmState, now: Date): boolean => !state.attemptedAt || now.getTime() - Date.parse(state.attemptedAt) >= 30 * 60_000;

export const applyVmHealth = (state: VmState, health: DoctorVmHealth | null, now: Date): VmState => {
  const at = now.toISOString();
  if (!health) return { ...state, attemptedAt: at, failures: state.failures + 1 };
  const logBytes = health.authLogBytes + health.journalBytes;
  // Compare before dropping the oldest of the previous 48 half-hour samples.
  const before = [...state.samples].reverse().find(sample => Date.parse(sample.at) <= now.getTime() - 86_400_000
    && Date.parse(sample.at) >= now.getTime() - 26 * 3_600_000);
  return { attemptedAt: at, failures: 0, latest: { ...health, at, growth24hBytes: before ? Math.max(0, logBytes - before.logBytes) : null },
    samples: [...state.samples, { at, logBytes }].slice(-48) };
};

export const vmHealthFindings = (state: VmState): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  const add = (code: string, severity: DoctorFinding['severity'], detail: string | null) =>
    findings.push({ key: `wechat:${code}`, feature: 'wechat', code, severity, event: false, detail });
  if (state.failures >= 2) add('wechat.vmUnreachable', 'warning', String(state.failures));
  const latest = state.latest;
  if (!latest) return findings;
  if (latest.freeBytes < 4 * GB) add(latest.freeBytes < 1.5 * GB ? 'wechat.vmDiskCritical' : 'wechat.vmDiskLow', latest.freeBytes < 1.5 * GB ? 'error' : 'warning', String(latest.freeBytes));
  if (latest.authLogBytes + latest.journalBytes > GB || (latest.growth24hBytes ?? 0) > 300 * 1024 ** 2)
    add('wechat.vmLogGrowth', 'warning', String(latest.authLogBytes + latest.journalBytes));
  return findings;
};

export const formatVmHealth = (state: VmState): string => state.latest
  ? `微信虚拟机：磁盘剩余 ${(state.latest.freeBytes / GB).toFixed(1)} GB，日志 ${((state.latest.authLogBytes + state.latest.journalBytes) / 1024 ** 2).toFixed(0)} MB。${state.failures ? '（上次成功采样）' : ''}`
  : '微信虚拟机：尚未取得体检数据。';
