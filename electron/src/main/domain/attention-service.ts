import { createHash } from 'node:crypto';
import type { AttentionAcknowledge, AttentionItem, AttentionKind, AttentionReceipt, AttentionSnapshot, AttentionStatus } from '../../shared/attention';
import type { DomainRepository } from './repository';
import type { PersistentState } from './schemas';

export const ATTENTION_RECENT_RESULT_MS = 7 * 24 * 60 * 60_000;
type Sources = Pick<PersistentState, 'profileId' | 'backgroundJobs' | 'delegationBatches' | 'consolidationBatches' | 'chatSessions' | 'automationTriggers'>
  & { attentionReceipts?: AttentionReceipt[] };
const active = new Set(['queued', 'dispatching', 'running']);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const title = (value: string): string => value.length <= 160 ? value : `${value.slice(0, 157)}…`;
const rank: Record<AttentionKind, number> = { action: 0, review: 1, result: 2, notice: 3 };
const recent = (date: string, now: number): boolean => {
  const at = Date.parse(date);
  return Number.isFinite(at) && at >= now - ATTENTION_RECENT_RESULT_MS;
};
const visibleSession = (state: Sources, id: string): boolean => state.chatSessions.some(session => session.id === id && !session.deletedAt && !session.archivedAt);

/** One card per owning entity. This reads saved state and never submits, retries,
 * cancels, changes memory or turns an unstructured model reply into a question. */
const candidates = (state: Sources, now: number): Omit<AttentionSnapshot, 'counts'> => {
  const items: AttentionItem[] = [];
  let runningCount = 0, olderResults = 0;
  const sourceCounts = { backgroundJobs: 0, delegations: 0, consolidations: 0 };
  const proactive = new Map<string, Sources['backgroundJobs']>();
  const triggers = new Map(state.automationTriggers.map(trigger => [trigger.id, trigger]));
  for (const job of state.backgroundJobs) {
    if (job.profileId !== state.profileId || job.resultOwner !== job.id || job.delegation || job.consolidation) continue;
    sourceCounts.backgroundJobs++;
    // Optional check-ins have no owner decision to request. Their diagnostics
    // belong together and must never expose an internal prompt as a task title.
    if (job.automaticTriggerId && triggers.get(job.automaticTriggerId)?.kind === 'proactive') {
      if (active.has(job.status)) runningCount++;
      const key = JSON.stringify([job.binding.provider.id, job.binding.model]);
      const group = proactive.get(key) ?? []; group.push(job); proactive.set(key, group);
      continue;
    }
    if (active.has(job.status)) { runningCount++; continue; }
    if (job.status === 'cancelled') continue;
    let kind: AttentionKind, status: AttentionStatus;
    if (job.status === 'succeeded' && job.result !== null) {
      // Published automatic replies already have their own conversation surface.
      if (job.automaticTriggerId && state.automationTriggers.some(trigger => trigger.id === job.automaticTriggerId && trigger.publishedAt)) continue;
      if (!recent(job.updatedAt, now)) { olderResults++; continue; }
      kind = 'result'; status = 'completed';
    } else if (job.status === 'failed' || job.status === 'interrupted' || job.status === 'blocked') {
      kind = 'action'; status = job.status;
    } else continue;
    items.push({ id: `background-job:${job.id}`, fingerprint: digest({ source: 'background-job', profileId: state.profileId, id: job.id,
      status: job.status, updatedAt: job.updatedAt, result: job.result, reason: job.completionReason }),
      source: 'background-job', kind, title: title(job.instruction), status, updatedAt: job.updatedAt,
      target: { kind: 'background-job', id: job.id, sessionId: null }, completedChildren: job.status === 'succeeded' ? 1 : 0, totalChildren: 1 });
  }
  for (const [key, jobs] of proactive) {
    const published = jobs.filter(job => job.status === 'succeeded' && triggers.get(job.automaticTriggerId!)?.publishedAt)
      .reduce((latest, job) => job.updatedAt > latest ? job.updatedAt : latest, '');
    const failures = jobs.filter(job => ['failed', 'interrupted', 'blocked'].includes(job.status) && job.updatedAt > published && recent(job.updatedAt, now))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const latest = failures[0]; if (!latest) continue;
    const hash = digest(key).slice(0, 32), id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    items.push({ id: `proactive:${id}`, fingerprint: digest({ key, failures: failures.map(job => [job.id, job.updatedAt, job.status, job.completionReason]), published }),
      source: 'proactive', kind: 'notice', title: '', status: latest.status as AttentionStatus, updatedAt: latest.updatedAt,
      target: { kind: 'proactive', id, sessionId: null }, completedChildren: 0, totalChildren: failures.length,
      automaticIssue: { occurrences: failures.length, providerName: latest.binding.provider.name, model: latest.binding.model,
        errorCode: latest.completionReason ?? 'job.requestFailed', firstAt: failures.at(-1)!.updatedAt } });
  }
  for (const batch of state.delegationBatches) {
    if (batch.profileId !== state.profileId || batch.historicalAt || batch.cancelRequestedAt || !visibleSession(state, batch.sessionId)) continue;
    sourceCounts.delegations++;
    const children = batch.children.map(child => state.backgroundJobs.find(job => job.id === child.jobId && job.profileId === state.profileId && job.resultOwner === job.id
      && job.delegation?.batchId === batch.id && job.delegation.childId === child.id && job.delegation.parentSessionId === batch.sessionId
      && job.delegation.sessionId === child.sessionId && job.delegation.intentVersion === batch.intentVersion && job.delegation.deadlineAt === batch.deadlineAt));
    const running = children.some(job => job && active.has(job.status));
    if (running) runningCount++;
    const completed = children.filter(job => job?.status === 'succeeded' && job.result !== null).length;
    const troubled = children.filter(job => job && ['failed', 'interrupted', 'blocked'].includes(job.status));
    const expired = Date.parse(batch.deadlineAt) <= now && children.some(job => !job || active.has(job.status));
    let kind: AttentionKind, status: AttentionStatus;
    if (batch.invalidatedReason || children.some(job => !job)) { kind = 'action'; status = 'interrupted'; }
    else if (expired) { kind = 'action'; status = 'expired'; }
    else if (troubled.length > 0) {
      kind = 'action'; status = completed > 0 || running ? 'mixed' : troubled.some(job => job!.status === 'interrupted') ? 'interrupted' : 'failed';
    } else if (completed > 0) {
      const newest = children.reduce((latest, job) => job && job.updatedAt > latest ? job.updatedAt : latest, batch.updatedAt);
      if (!recent(newest, now)) { olderResults++; continue; }
      kind = 'result'; status = 'completed';
    } else continue;
    const updatedAt = children.reduce((latest, job) => job && job.updatedAt > latest ? job.updatedAt : latest, batch.updatedAt);
    items.push({ id: `delegation:${batch.id}`, fingerprint: digest({ source: 'delegation', profileId: state.profileId, id: batch.id,
      version: batch.intentVersion, updatedAt: batch.updatedAt, invalidatedReason: batch.invalidatedReason, kind, status,
      children: children.map(job => job ? { id: job.id, status: job.status, updatedAt: job.updatedAt, result: job.result, reason: job.completionReason } : null) }),
      source: 'delegation', kind, title: title(batch.goal), status, updatedAt, target: { kind: 'delegation', id: batch.id, sessionId: batch.sessionId },
      completedChildren: completed, totalChildren: batch.children.length });
  }
  for (const batch of state.consolidationBatches) {
    if (batch.profileId !== state.profileId || !visibleSession(state, batch.sessionId)) continue;
    sourceCounts.consolidations++;
    if (batch.status === 'generating') { runningCount++; continue; }
    if (batch.status === 'draft' || batch.status === 'cancelled' || batch.status === 'applied' || batch.status === 'disabled') continue;
    const job = state.backgroundJobs.find(value => value.id === batch.jobId && value.profileId === state.profileId && value.consolidation?.batchId === batch.id);
    const kind: AttentionKind = batch.status === 'review' && batch.candidate !== null ? 'review' : 'action';
    const status: AttentionStatus = kind === 'review' ? 'review' : batch.status === 'invalid' ? 'invalid' : job?.status === 'interrupted' ? 'interrupted' : 'failed';
    const updatedAt = job && job.updatedAt > batch.updatedAt ? job.updatedAt : batch.updatedAt;
    items.push({ id: `consolidation:${batch.id}`, fingerprint: digest({ source: 'consolidation', profileId: state.profileId, id: batch.id,
      status: batch.status, updatedAt: batch.updatedAt, candidateVersion: batch.candidateVersion, candidate: batch.candidate, invalidReason: batch.invalidReason,
      job: job ? { status: job.status, updatedAt: job.updatedAt, reason: job.completionReason } : null }),
      source: 'consolidation', kind, title: '', status, updatedAt, target: { kind: 'consolidation', id: batch.id, sessionId: batch.sessionId },
      completedChildren: kind === 'review' ? 1 : 0, totalChildren: 1 });
  }
  items.sort((a, b) => rank[a.kind] - rank[b.kind] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { items, runningCount, olderResults, sourceCounts };
};
export const projectAttention = (state: Sources, now: number): AttentionSnapshot => {
  const projected = candidates(state, now);
  const receipts = new Map((state.attentionReceipts ?? []).map(receipt => [receipt.id, receipt.fingerprint]));
  const items = projected.items.filter(item => receipts.get(item.id) !== item.fingerprint);
  return { ...projected, items, counts: { action: items.filter(item => item.kind === 'action').length,
    review: items.filter(item => item.kind === 'review').length, result: items.filter(item => item.kind === 'result').length,
    notice: items.filter(item => item.kind === 'notice').length } };
};

export class AttentionService {
  constructor(private readonly repository: DomainRepository, private readonly now: () => number = Date.now) {}
  async snapshot(): Promise<AttentionSnapshot> {
    await this.repository.flush(); await this.repository.recoverAuthority();
    return projectAttention(this.repository.snapshot(), this.now());
  }
  async acknowledge(input: AttentionAcknowledge): Promise<void> {
    await this.repository.transaction(state => {
      const item = candidates(state, this.now()).items.find(value => value.id === input.id);
      if (!item || item.fingerprint !== input.fingerprint) throw new Error('attention.stale');
      state.attentionReceipts = state.attentionReceipts.filter(receipt => receipt.id !== input.id);
      state.attentionReceipts.push({ id: item.id, fingerprint: item.fingerprint, acknowledgedAt: new Date(this.now()).toISOString() });
    });
  }
}
