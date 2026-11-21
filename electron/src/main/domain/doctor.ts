import type { HealthItem, HealthSnapshot } from '../../shared/attention';
import { DOCTOR_FEATURES, describeDoctorCase, doctorClock, safeDoctorCode, safeDoctorDetail, safeDoctorFeature, type DoctorCase } from '../../shared/doctor';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import { doctorStaticAdvice, groupDoctorProblems } from './doctor-runbook';

/** What one check found. Codes, counts and times only. */
export interface DoctorFinding {
  key: string; feature: string; code: string; severity: 'error' | 'warning'; event: boolean; detail: string | null;
}
export interface DoctorExtras {
  /** null when the free space could not be read. */
  diskFreeBytes: number | null;
  /** When the previous run started, if it never reached a normal shutdown. */
  uncleanExitOf: string | null;
  wechat: WeChatChannelState | null;
}

const GB = 1024 ** 3;
export const DISK_WARNING_BYTES = 10 * GB;
export const DISK_CRITICAL_BYTES = 3 * GB;
/** Proactive QQ messages a day; anything beyond goes to a desktop notification. */
export const DOCTOR_DAILY_LIMIT = 6;
const MAX_CASES = 200;
// Owner messages she is not expected to answer; skipping them is normal.
const UNREMARKABLE_KINDS = new Set(['sticker', 'system', 'recall', 'call', 'friend_rate_limited']);
const SERIOUS = /^(?:wechat\.(?:stale|stopped|degraded|[a-z_]+)|qq\.offline|telegram\.offline|provider\.(?:authentication|quota)|asr\.(?:worker|runtime)|diary\.storage)$/u;
// Worth knowing about, not about to stop her answering.
const MINOR = new Set(['wechat.uncertain', 'wechat.send_receipt_unconfirmed', 'wechat.send_receipt_unstored', 'wechat.friend_rate_limited', 'wechat.friend_send_uncertain', 'wechat.momentPreviewFallback', 'provider.rateLimit', 'proactive.screenUnknown', 'proactive.speechBusy']);

function healthFinding(item: HealthItem, wechat: WeChatChannelState | null): DoctorFinding | null {
  if (item.state !== 'failing' || !item.errorCode) return null;
  if (item.errorCode === 'wechat.dropped') {
    // Dropped messages are events, projected once from the listener below.
    return wechat?.droppedAt ? droppedFinding(wechat) : null;
  }
  if (item.feature === 'knowledge') {
    const code = item.errorCode === 'knowledge.embeddingModelMissing' ? item.errorCode
      : item.failures >= 2 ? 'knowledge.indexRepeatedFailures' : null;
    return code ? { key: `knowledge:${code}`, feature: 'knowledge', code,
      severity: 'warning', event: false, detail: item.failures ? String(item.failures) : null } : null;
  }
  const feature = safeDoctorFeature(item.feature);
  const reconnectable = item.connectionOffline && (feature === 'qq' || feature === 'telegram') &&
    !/(?:auth|credential|storage|targetBlocked|processing|invalid|rateLimit|quota|http4)/iu.test(item.errorCode);
  const code = safeDoctorCode(reconnectable ? `${feature}.offline` : item.errorCode);
  const scope = item.ordinal === undefined || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1 ? feature : `${feature}:${item.ordinal}`;
  return { key: `${scope}:${code}`, feature, code, event: false,
    severity: MINOR.has(code) || !SERIOUS.test(code) ? 'warning' : 'error', detail: safeDoctorDetail(item.failures ? String(item.failures) : null) };
}

const droppedFinding = (wechat: WeChatChannelState): DoctorFinding => ({ key: `wechat.dropped@${wechat.droppedAt}`, feature: 'wechat', code: 'wechat.dropped',
  severity: 'error', event: true, detail: String(wechat.dropped) });

export const acknowledgedDoctorKeys = (health: HealthSnapshot, wechat: WeChatChannelState | null): ReadonlySet<string> =>
  new Set(health.items.flatMap(item => {
    const finding = item.acknowledged ? healthFinding(item, wechat) : null;
    return finding ? [finding.key] : [];
  }));

/** Turn one health snapshot and the doctor's own checks into findings. */
export const doctorFindings = (health: HealthSnapshot, extras: DoctorExtras): DoctorFinding[] => {
  const findings: DoctorFinding[] = health.items.flatMap(item => {
    const finding = !item.acknowledged && item.errorCode !== 'wechat.dropped' ? healthFinding(item, extras.wechat) : null;
    return finding ? [finding] : [];
  });
  const wechat = extras.wechat;
  if (wechat?.configured && !wechat.paused) {
    if (wechat.dropped && wechat.droppedAt && !health.items.some(item => item.acknowledged && item.errorCode === 'wechat.dropped'))
      findings.push(droppedFinding(wechat));
    // One notice per kind while it stays in the listener's last-day window.
    for (const kind of wechat.skipped ? wechat.skippedKinds ?? [] : []) {
      if (!UNREMARKABLE_KINDS.has(kind)) {
        const safeKind = safeDoctorDetail(kind) ?? 'other';
        findings.push({ key: `wechat.skipped:${safeKind}`, feature: 'wechat', code: 'wechat.skipped', severity: 'warning', event: true, detail: safeKind });
      }
    }
  }
  if (extras.diskFreeBytes !== null && extras.diskFreeBytes < DISK_WARNING_BYTES) {
    const critical = extras.diskFreeBytes < DISK_CRITICAL_BYTES;
    findings.push({ key: critical ? 'system:diskCritical' : 'system:diskLow', feature: 'system', code: critical ? 'system.diskCritical' : 'system.diskLow',
      severity: critical ? 'error' : 'warning', event: false, detail: `${(extras.diskFreeBytes / GB).toFixed(1)} GB` });
  }
  if (extras.uncleanExitOf) findings.push({ key: `app.uncleanExit@${extras.uncleanExitOf}`, feature: 'app', code: 'app.uncleanExit',
    severity: 'warning', event: true, detail: extras.uncleanExitOf });
  return findings;
};

/** Open, update and close cases. A problem must still be there at the next check before it is reported, except one-off events. */
export const reconcileDoctor = (cases: readonly DoctorCase[], findings: readonly DoctorFinding[], now: Date,
  acknowledged: ReadonlySet<string> = new Set()): DoctorCase[] => {
  const at = now.toISOString(), current = new Map(findings.filter(finding => !acknowledged.has(finding.key)).map(finding => [finding.key, finding]));
  const next = cases.map(entry => {
    if (entry.resolvedAt !== null) return entry;
    if (acknowledged.has(entry.key)) return { ...entry, resolvedAt: at, acknowledged: true as const };
    const finding = current.get(entry.key);
    if (!finding) return { ...entry, resolvedAt: at };
    current.delete(entry.key);
    return { ...entry, seen: entry.seen + 1, lastSeenAt: at, detail: finding.detail, severity: finding.severity };
  });
  for (const finding of current.values()) next.push({ ...finding, openedAt: at, lastSeenAt: at, resolvedAt: null, seen: 1,
    reported: null, reportedAt: null, recoveryReported: false });
  // Keep every open case and the newest closed ones.
  const closed = next.filter(entry => entry.resolvedAt !== null).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const keep = new Set(closed.slice(0, Math.max(0, MAX_CASES - next.filter(entry => entry.resolvedAt === null).length)));
  return next.filter(entry => entry.resolvedAt === null || keep.has(entry));
};

export interface DoctorReport {
  /** New problems, or during the morning digest everything held overnight. */
  problems: DoctorCase[];
  recovered: DoctorCase[];
  /** Problems first noticed during quiet hours, to mark held. */
  held: DoctorCase[];
  digest: boolean;
}

const urgentDisk = (entry: DoctorCase): boolean => entry.code === 'system.diskCritical' || entry.code === 'wechat.vmDiskCritical';
const ready = (entry: DoctorCase): boolean => entry.resolvedAt === null && entry.reported === null && (entry.event || entry.seen >= 2 || urgentDisk(entry));

/** A newly confirmed symptom may belong to a root cause whose older symptom was already reported. */
const rootCauseContext = (selected: DoctorCase[], cases: readonly DoctorCase[]): DoctorCase[] => {
  const result = new Set(selected);
  for (const group of groupDoctorProblems(cases.filter(entry => entry.resolvedAt === null || selected.includes(entry))))
    if (group.title && group.entries.some(entry => result.has(entry))) group.entries.forEach(entry => result.add(entry));
  return [...result];
};

/** What to tell the owner now. Quiet hours hold everything but a nearly full disk until the morning. */
export const planDoctorReport = (cases: readonly DoctorCase[], quiet: boolean): DoctorReport => {
  const fresh = cases.filter(ready);
  if (quiet) {
    const urgent = fresh.filter(urgentDisk);
    return { problems: urgent, recovered: [], held: fresh.filter(entry => !urgent.includes(entry)), digest: false };
  }
  const held = cases.filter(entry => entry.reported === 'held' && !entry.acknowledged);
  return { problems: rootCauseContext([...held, ...fresh], cases), held: [], digest: held.length > 0,
    recovered: cases.filter(entry => entry.resolvedAt !== null && !entry.event && !entry.recoveryReported && !entry.acknowledged
      && (entry.reported === 'qq' || entry.reported === 'desktop')) };
};

export const formatDoctorReport = (report: Pick<DoctorReport, 'problems' | 'recovered' | 'digest'>, timeZone?: string, diagnosis?: string | null): string | null => {
  const lines: string[] = [];
  if (report.problems.length) {
    const groups = groupDoctorProblems(report.problems);
    lines.push(report.digest ? `【医生】夜里记录到 ${groups.length} 个问题：` : `【医生】发现 ${groups.length} 个问题：`);
    groups.forEach((group, index) => {
      if (group.title) {
        lines.push(`${index + 1}. ${group.title}：`);
        group.entries.forEach(entry => lines.push(`  - ${describeDoctorCase(entry, timeZone)}${entry.resolvedAt ? '（已恢复）' : ''}`));
      } else lines.push(`${index + 1}. ${describeDoctorCase(group.entries[0]!, timeZone)}${group.entries[0]!.resolvedAt ? '（已恢复）' : ''}`);
    });
  }
  if (report.recovered.length) {
    const names = [...new Set(report.recovered.map(entry => DOCTOR_FEATURES[safeDoctorFeature(entry.feature)]))].join('、');
    lines.push(report.problems.length ? `已恢复：${names}。` : `【医生】已恢复：${names}。`);
  }
  if (!lines.length) return null;
  if (report.problems.length) lines.push(diagnosis ? `医生的看法：${diagnosis}` : doctorStaticAdvice(report.problems), '详情见桌宠「动态 → 医生」。');
  return lines.join('\n');
};

/** The owner's 「体检」: everything the doctor can see right now. */
export const formatCheckup = (health: HealthSnapshot, findings: readonly DoctorFinding[], diskFreeBytes: number | null, now: Date, timeZone?: string, diagnosis?: string | null): string => {
  const name = (feature: string): string => DOCTOR_FEATURES[safeDoctorFeature(feature)]!;
  const by = (state: string): string[] => health.items.filter(item => item.state === state).map(item => name(item.feature));
  const acknowledged = [...new Set(health.items.filter(item => item.state === 'failing' && item.acknowledged).map(item => name(item.feature)))];
  const lines = [`【医生】体检结果（${doctorClock(now.toISOString(), timeZone)}）`];
  const groups = groupDoctorProblems(findings);
  lines.push(groups.length ? `异常 ${groups.length} 项：` : '没有发现异常。');
  for (const group of groups) {
    if (group.title) lines.push(`- ${group.title}：`);
    for (const finding of group.entries) lines.push(`${group.title ? '  ' : ''}- ${describeDoctorCase(finding, timeZone)}`);
  }
  if (acknowledged.length) lines.push(`已知道：${acknowledged.join('、')}`);
  const ok = by('ok'), waiting = by('waiting'), off = by('off');
  if (ok.length) lines.push(`正常：${ok.join('、')}`);
  if (waiting.length) lines.push(`还没运行过：${waiting.join('、')}`);
  if (off.length) lines.push(`未开启：${off.join('、')}`);
  if (diskFreeBytes !== null) lines.push(`系统盘剩余 ${(diskFreeBytes / GB).toFixed(1)} GB。`);
  lines.push(diagnosis ? `医生的看法：${diagnosis}` : doctorStaticAdvice(findings));
  return lines.join('\n');
};

/** Migrate v1 case metadata without ever persisting arbitrary upstream error text. */
export const sanitizeDoctorCase = (entry: DoctorCase): DoctorCase => {
  const code = safeDoctorCode(entry.code), feature = safeDoctorFeature(entry.feature), detail = safeDoctorDetail(entry.detail);
  let key = `${feature}:${code}`;
  if (entry.key === key || new RegExp(`^${feature}:[0-9]{1,6}:` + code.replaceAll('.', '\\.') + '$', 'u').test(entry.key)) key = entry.key;
  if (code === 'system.diskCritical' || code === 'system.diskLow') key = code.replace('.', ':');
  if (code === 'app.uncleanExit') key = `app.uncleanExit@${detail ?? entry.openedAt}`;
  if (code === 'wechat.dropped' && /^wechat\.dropped@\d{1,16}$/u.test(entry.key)) key = entry.key;
  if (code === 'wechat.skipped') key = `wechat.skipped:${detail ?? 'other'}`;
  return { ...entry, code, feature, detail, key };
};

/** 23:00–08:00 on the Mac's clock. */
export const isDoctorQuiet = (now: Date, timeZone?: string): boolean => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(now));
  return hour >= 23 || hour < 8;
};
