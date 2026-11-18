import type { DoctorProviderTestRecord } from '../../shared/doctor';
import type { DoctorFinding } from './doctor';

export const providerTestFindings = (records: readonly DoctorProviderTestRecord[]): DoctorFinding[] => {
  const last = records.at(-1), previous = records.at(-2);
  if (!last || last.status === 'skipped') return [];
  const findings: DoctorFinding[] = [];
  const adjacent = previous && Date.parse(last.day) - Date.parse(previous.day) === 86_400_000;
  if (adjacent && last.status === 'failed' && previous.status === 'failed')
    findings.push({ key: 'provider:provider.selfTestFailed', feature: 'provider', code: 'provider.selfTestFailed', severity: 'warning', event: false, detail: '2' });
  if (adjacent && previous.status !== 'skipped' && previous.durationMs > 30_000 && last.durationMs > 30_000)
    findings.push({ key: 'provider:provider.selfTestSlow', feature: 'provider', code: 'provider.selfTestSlow', severity: 'warning', event: false, detail: String(last.durationMs) });
  return findings;
};
