import { randomUUID } from 'node:crypto';
import type { AutomaticTaskPort, AutomaticTrigger, AutomationSnapshot } from '../../shared/automation';
import type { BackgroundJob, BackgroundJobInput } from '../../shared/background-jobs';
import type { ChatMessage, ContextTrace } from '../../shared';
import type { DomainRepository } from './repository';
import type { BackgroundJobService } from './background-job-service';

interface Dependencies {
  assertPermission(): void;
  available(): boolean;
  proactiveAdmission(trigger: AutomaticTrigger, phase: 'dispatch' | 'publish'): { allowed: boolean; reason: string | null };
  published(message: ChatMessage): Promise<void>;
  changed(): void;
  suppressMessage(id: string): void;
  checkInTitle?(): string;
  proactiveContext?(job: BackgroundJob): ContextTrace;
}
const CHECK_IN_TITLES = ['Event check-ins', '主动问候'];
const pending = (t: AutomaticTrigger): boolean => t.status === 'reserved' || t.status === 'submitted';
/** Common durable submission/publication boundary. No provider/tool implementation lives here. */
export class AutomaticTaskCoordinator implements AutomaticTaskPort {
  #publishing: Promise<void> = Promise.resolve();
  constructor(private readonly repository: DomainRepository, private readonly jobs: BackgroundJobService, private readonly dependencies: Dependencies) {}
  getByOperation(id: string): BackgroundJob | null { return this.repository.snapshot().backgroundJobs.find((j) => j.operationId === id && j.automaticTriggerId === id) ?? null; }
  async cancel(jobId: string): Promise<void> { const s = this.repository.snapshot(); const job = s.backgroundJobs.find((j) => j.id === jobId && j.automaticTriggerId !== undefined && s.automationTriggers.some((t) => t.id === j.automaticTriggerId)); if (!job) throw new Error('automation.unavailable'); await this.jobs.cancel(jobId); }
  assertJob(job: BackgroundJob, phase: 'dispatch' | 'publish'): void {
    const s = this.repository.snapshot(), trigger = s.automationTriggers.find((t) => t.id === job.operationId);
    if (!trigger && job.automaticTriggerId) throw new Error('automation.sourceMissing');
    if (!job.automaticTriggerId) return; // Explicit ordinary E-P2 jobs retain their existing contract.
    if (!trigger || job.automaticTriggerId !== trigger.id) throw new Error('automation.identityConflict');
    if (!this.dependencies.available() || (!pending(trigger) && !(phase === 'publish' && trigger.kind === 'proactive' && trigger.status === 'succeeded' && trigger.messageId !== null)) || trigger.cancelledAt) throw new Error('automation.cancelled');
    this.dependencies.assertPermission();
    if (trigger.kind === 'schedule') {
      const schedule = s.automationSchedules.find((v) => v.id === trigger.sourceId);
      if (!schedule || !schedule.enabled || schedule.cancelledAt || schedule.revision !== trigger.policyRevision) throw new Error('automation.scheduleChanged');
      if (schedule.providerId !== job.binding.provider.id || (schedule.model !== null && schedule.model !== job.binding.model) || schedule.privacy !== job.source.privacy) throw new Error('automation.bindingChanged');
    } else {
      const decision = this.dependencies.proactiveAdmission(trigger, phase);
      if (!decision.allowed) throw new Error('automation.proactiveBlocked');
      const model = s.proactivePolicy.model ?? (phase === 'publish' ? job.binding.model
        : s.providers.find(provider => provider.id === s.proactivePolicy.providerId && provider.enabled)?.model);
      if (s.proactivePolicy.providerId !== job.binding.provider.id || model !== job.binding.model
        || s.proactivePolicy.privacy !== job.source.privacy) throw new Error('automation.bindingChanged');
      this.dependencies.proactiveContext?.(job);
    }
  }
  async submit(trigger: AutomaticTrigger, input: Omit<BackgroundJobInput, 'operationId'>): Promise<BackgroundJob> {
    const current = this.repository.snapshot().automationTriggers.find((t) => t.id === trigger.id && t.key === trigger.key);
    if (!current || !pending(current) || current.cancelledAt) throw new Error('automation.cancelled');
    this.dependencies.assertPermission();
    if (!this.dependencies.available()) throw new Error('automation.unavailable');
    // E-P2 owns the immutable input digest, credential ref, admission and one attempt.
    // Reusing this durable operationId resolves an existing job; it does not retry it.
    return this.jobs.submit({ ...input, operationId: current.id }, current.id);
  }
  snapshot(): AutomationSnapshot {
    const s = this.repository.snapshot();
    return { automationSchedules: s.automationSchedules, automationTriggers: s.automationTriggers, proactivePolicy: s.proactivePolicy, proactiveEvents: s.proactiveEvents, proactiveObservations: s.proactiveObservations ?? [],
      jobs: s.backgroundJobs.filter((j) => j.automaticTriggerId !== undefined && s.automationTriggers.some((t) => t.id === j.automaticTriggerId))
        .map((j) => ({ ...j, instruction: '', material: '', result: null })) };
  }
  triggerResult(id: string): { triggerId: string; jobId: string; status: string; result: string | null } {
    const s = this.repository.snapshot(), trigger = s.automationTriggers.find((t) => t.id === id), job = trigger && s.backgroundJobs.find((j) => j.operationId === trigger.id && j.automaticTriggerId === trigger.id && j.profileId === s.profileId);
    if (!trigger || !job) throw new Error('automation.resultUnavailable');
    return { triggerId: trigger.id, jobId: job.id, status: trigger.status, result: trigger.status === 'succeeded' && job.status === 'succeeded' ? job.result : null };
  }
  async cancelTrigger(id: string, reason = 'automation.cancelled'): Promise<void> {
    const jobId = await this.repository.transaction((s) => {
      const trigger = s.automationTriggers.find((v) => v.id === id); if (!trigger) throw new Error('automation.unavailable');
      if (!pending(trigger)) return null;
      trigger.status = 'cancelled'; trigger.cancelledAt = new Date().toISOString(); trigger.updatedAt = trigger.cancelledAt; trigger.errorCode = reason;
      return trigger.jobId ?? s.backgroundJobs.find((j) => j.operationId === id && j.automaticTriggerId === id)?.id ?? null;
    });
    if (jobId) await this.jobs.cancel(jobId);
    this.dependencies.changed();
  }
  async revokePermission(): Promise<void> {
    const ids = this.repository.snapshot().automationTriggers.filter(pending).map((t) => t.id);
    for (const id of ids) await this.cancelTrigger(id, 'automation.permissionRevoked');
  }
  /** Serial, idempotent publication. Guard is repeated inside the authoritative transaction. */
  changed(): void {
    this.dependencies.changed();
    this.#publishing = this.#publishing.then(async () => {
      const initial = this.repository.snapshot();
      const ids = initial.automationTriggers.filter((t) => pending(t) && initial.backgroundJobs.some((j) => j.automaticTriggerId === t.id && !['queued','dispatching','running'].includes(j.status))).map((t) => t.id);
      for (const id of ids) {
        let message: ChatMessage | null = null;
        try {
          message = await this.repository.transaction((s) => {
            const trigger = s.automationTriggers.find((t) => t.id === id); if (!trigger || !pending(trigger)) return null;
            const job = s.backgroundJobs.find((j) => j.operationId === id && j.automaticTriggerId === id); if (!job) return null;
            trigger.jobId ??= job.id;
            if (job.status === 'queued' || job.status === 'dispatching' || job.status === 'running') return null;
            trigger.updatedAt = new Date().toISOString();
            if (job.status !== 'succeeded') { trigger.status = job.status === 'interrupted' ? 'unknown' : job.status === 'cancelled' ? 'cancelled' : 'failed'; trigger.errorCode = job.completionReason; return null; }
            try { this.assertJob(job, 'publish'); }
            catch { trigger.status = 'blocked'; trigger.errorCode = 'automation.publicationBlocked'; return null; }
            if (trigger.kind === 'schedule') { trigger.status = 'succeeded'; return null; }
            if (trigger.messageId) { trigger.status = 'succeeded'; return null; }
            // One message identity, one result. No memory write and no additional generation.
            let session = s.chatSessions.find((v) => CHECK_IN_TITLES.includes(v.title) && v.analysisSource !== 'rea-static' && !v.wechatTranscript && !v.deletedAt && !v.archivedAt);
            if (!session) { session = { id: randomUUID(), title: this.dependencies.checkInTitle?.() ?? CHECK_IN_TITLES[0]!, kind: 'normal', createdAt: trigger.updatedAt, updatedAt: trigger.updatedAt, historyPrivacy: job.source.privacy }; s.chatSessions.push(session); }
            const saved: ChatMessage = { id: randomUUID(), sessionId: session.id, role: 'assistant', content: job.result ?? '', automationTriggerId: trigger.id, status: 'complete', createdAt: trigger.updatedAt, errorCode: null,
              contextTrace: { ...(this.dependencies.proactiveContext?.(job) ?? { version: 1, memoryReferences: [], historyMessageIds: [], privacy: job.source.privacy, lineage: 'complete' }), scope: { kind: 'session', sessionId: session.id } } };
            s.chatMessages.push(saved); session.updatedAt = trigger.updatedAt; trigger.messageId = saved.id; trigger.publishedAt = null; trigger.status = 'succeeded'; return saved;
          });
          if (message) {
            const visible = message;
            try {
              await this.repository.transaction((s) => {
                const trigger = s.automationTriggers.find((v) => v.id === id), job = s.backgroundJobs.find((v) => v.operationId === id);
                if (!trigger || !job || trigger.messageId !== visible.id) throw new Error('automation.publicationBlocked');
                this.assertJob(job, 'publish'); trigger.publishedAt = new Date().toISOString();
              });
              const job = this.getByOperation(id); if (!job) throw new Error('automation.publicationBlocked');
              this.assertJob(job, 'publish');
              await this.dependencies.published(visible);
            } catch {
              // Hide synchronously while the durable withdrawal is queued, so no
              // chat read can expose a post-commit rejected complete message.
              this.dependencies.suppressMessage(visible.id);
              await this.repository.transaction((s) => {
                const trigger = s.automationTriggers.find((v) => v.id === id), stored = s.chatMessages.find((v) => v.id === visible.id);
                if (trigger) { trigger.status = 'blocked'; trigger.cancelledAt ??= new Date().toISOString(); trigger.publishedAt = null; trigger.errorCode = 'automation.publicationBlocked'; }
                if (stored) { stored.content = ''; stored.status = 'cancelled'; stored.errorCode = 'automation.publicationBlocked'; }
              });
            }
          }
        } catch { /* Authority failures stay uncommitted and are retried only as read/publication reconciliation, never inference. */ }
      }
      this.dependencies.changed();
    }).catch(() => undefined);
  }
  async initialize(): Promise<void> {
    const s = this.repository.snapshot();
    if (s.automationTriggers.some((v) => v.kind === 'proactive' && v.messageId !== null && v.status === 'succeeded' && v.publishedAt == null)) {
      await this.repository.transaction((state) => {
        for (const v of state.automationTriggers) if (v.kind === 'proactive' && v.messageId !== null && v.status === 'succeeded' && v.publishedAt == null) {
          v.status = 'unknown'; v.errorCode = 'automation.publicationUnconfirmed';
        }
      });
    }
  }
  async flush(): Promise<void> { await this.#publishing; }
}
