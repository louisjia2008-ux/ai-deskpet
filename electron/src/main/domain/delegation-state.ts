import type { BackgroundJob } from '../../shared/background-jobs';
import type { DelegationBatch, DelegationResult } from '../../shared/delegations';
import { evaluateRequirements } from '../../shared/delegation-checks';
import type { PersistentState } from './schemas';

export type StoredBatch = PersistentState['delegationBatches'][number];
export const jobTerminal = (status: BackgroundJob['status']): boolean => !['queued', 'dispatching', 'running'].includes(status);
export const assertParentSession = (state: PersistentState, id: string): void => {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session || session.deletedAt || session.archivedAt || session.wechatTranscript) throw new Error('delegation.sessionUnavailable');
};
export const ownedBatch = (state: PersistentState, id: string): StoredBatch => {
  const batch = state.delegationBatches.find((item) => item.id === id && item.profileId === state.profileId);
  if (!batch || !state.chatSessions.some((item) => item.id === batch.sessionId)) throw new Error('delegation.unavailable');
  return batch;
};
export const childJob = (state: PersistentState, batch: StoredBatch, childId: string): BackgroundJob => {
  const child = batch.children.find((item) => item.id === childId);
  const job = child && state.backgroundJobs.find((item) => item.id === child.jobId);
  const link = job?.delegation;
  if (!child || !job || job.profileId !== state.profileId || job.resultOwner !== job.id || !link || link.batchId !== batch.id
    || link.childId !== child.id || link.sessionId !== child.sessionId || link.parentSessionId !== batch.sessionId || link.intentVersion !== batch.intentVersion
    || link.deadlineAt !== batch.deadlineAt) throw new Error('delegation.relationship');
  return job;
};
export const budgetTotals = (batch: StoredBatch) => ({
  maxEstimatedTokens: batch.budget.maxEstimatedTokens, maxRequests: batch.budget.maxRequests,
  settledTokens: batch.children.reduce((sum, child) => sum + (child.reservation.state === 'settled' ? child.reservation.chargedTokens : 0), 0),
  outstandingTokens: batch.children.reduce((sum, child) => sum + (['reserved', 'unknown', 'overrun'].includes(child.reservation.state) ? child.reservation.reservedTokens : 0), 0),
  releasedTokens: batch.children.reduce((sum, child) => sum + (child.reservation.state === 'released' ? child.reservation.reservedTokens : child.reservation.state === 'settled' ? Math.max(0, child.reservation.reservedTokens - child.reservation.chargedTokens) : 0), 0),
  reservedRequests: batch.children.filter((child) => child.reservation.state !== 'released').length,
});
export const assertDelegationActive = (state: PersistentState, job: BackgroundJob): void => {
  if (!job.delegation) return;
  const batch = ownedBatch(state, job.delegation.batchId); childJob(state, batch, job.delegation.childId); assertParentSession(state, batch.sessionId);
  const intent = state.delegationIntents.find((item) => item.sessionId === batch.sessionId);
  if (batch.cancelRequestedAt) throw new Error('delegation.cancelled');
  if (batch.historicalAt || batch.invalidatedReason || !intent || intent.version !== batch.intentVersion || intent.currentBatchId !== batch.id) throw new Error('delegation.staleIntent');
  if (Date.now() >= Date.parse(batch.deadlineAt)) throw new Error('delegation.deadlineExceeded');
  // The reviewed child set bounds execution. Legacy economic token/request
  // budgets are inert; reported use never prevents an independent sibling.
  if (batch.children.length < 1 || batch.children.length > 3) throw new Error('delegation.invalidDraft');
};
export const syncDelegations = (state: PersistentState): void => {
  for (const batch of state.delegationBatches) {
    if (batch.profileId !== state.profileId) continue;
    for (const child of batch.children) {
      const job = childJob(state, batch, child.id);
      if (job.status === 'succeeded' && job.result !== null && child.checks.length === 0) child.checks = evaluateRequirements(job.result, child.requirements);
      const reservation = child.reservation;
      const usage = job.request?.observations.find((item) => item.phase === 'terminal')?.usage;
      if (usage?.source === 'provider-reported' && usage.inputTokens !== null && usage.outputTokens !== null) {
        const actual = usage.inputTokens + usage.outputTokens; reservation.reportedTokens = actual;
        reservation.state = 'settled'; reservation.chargedTokens = actual;
      } else if (jobTerminal(job.status)) {
        // A restored snapshot cannot prove that a once-queued request stayed unsent.
        if (!job.request && job.status !== 'interrupted' && !batch.invalidatedReason) { reservation.state = 'released'; reservation.chargedTokens = 0; }
        else { reservation.state = 'unknown'; reservation.chargedTokens = 0; }
      }
    }
  }
};
const standardFinish = (reason: string | null): string | null => reason !== null && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'end_turn'].includes(reason) ? reason : null;
const summaryReason = (job: BackgroundJob): string | null => {
  if (job.completionReason === null) return null;
  if (job.status === 'succeeded') return 'job.completed';
  const allowed = new Set(['job.toolsForbidden', 'job.emptyOutput', 'job.deadlineExceeded', 'job.resultTooLarge', 'job.requestFailed', 'job.interruptedUnknown', 'job.restoredUnknown',
    'provider.truncated', 'provider.authentication', 'provider.quota', 'provider.rateLimit', 'provider.timeout', 'provider.unavailable', 'provider.failed', 'provider.request', 'provider.bindingMismatch',
    'provider.contextBudgetExceeded', 'provider.invalidRequestBudget', 'provider.budgetExceeded', 'provider.streamInterrupted', 'provider.transportUncertain', 'provider.requestRecordFailed', 'repository.commitUncertain',
    'delegation.cancelled', 'delegation.staleIntent', 'delegation.deadlineExceeded', 'delegation.sessionUnavailable', 'delegation.budgetExceeded',
    'delegation.parentCancelledBeforeDispatch', 'delegation.parentCancelledRemoteUnknown', 'delegation.childCancelledBeforeDispatch', 'delegation.childCancelledRemoteUnknown',
    'delegation.replacedBeforeDispatch', 'delegation.replacedRemoteUnknown']);
  return allowed.has(job.completionReason) ? job.completionReason : 'job.requestFailed';
};
export const batchView = (state: PersistentState, batch: StoredBatch): DelegationBatch => {
  const jobs = batch.children.map((child) => childJob(state, batch, child.id));
  const status: DelegationBatch['status'] = batch.historicalAt ? 'historical' : batch.cancelRequestedAt ? 'cancelled' : batch.invalidatedReason ? 'interrupted'
    : Date.now() >= Date.parse(batch.deadlineAt) && jobs.some((job) => job.status !== 'succeeded') ? 'expired'
      : jobs.every((job) => job.status === 'succeeded') ? 'completed' : jobs.some((job) => !jobTerminal(job.status)) ? 'active'
        : jobs.some((job) => job.status === 'interrupted') ? 'interrupted' : 'partial';
  return { id: batch.id, profileId: batch.profileId, sessionId: batch.sessionId, operationId: batch.operationId, intentVersion: batch.intentVersion, goal: batch.goal,
    deadlineAt: batch.deadlineAt, createdAt: batch.createdAt, cancelRequestedAt: batch.cancelRequestedAt, historicalAt: batch.historicalAt, status, budget: budgetTotals(batch),
    children: batch.children.map((child, index) => {
      const job = jobs[index]!;
      return { id: child.id, jobId: job.id, sessionId: child.sessionId, instruction: child.instruction, providerName: job.binding.provider.name, model: job.binding.model,
        status: job.status, completionReason: summaryReason(job), finishReason: standardFinish(job.request?.observations.at(-1)?.finishReason ?? null),
        checks: child.requirements.map((rule) => ({ id: rule.id, kind: rule.kind, status: child.checks.find((item) => item.id === rule.id)?.status ?? 'unchecked' })),
        factVerification: 'unverified', reservation: structuredClone(child.reservation) };
    }) };
};
export const resultView = (state: PersistentState, batchId: string, childId: string): DelegationResult => {
  const batch = ownedBatch(state, batchId); const job = childJob(state, batch, childId); const child = batch.children.find((item) => item.id === childId)!;
  return { batchId, childId, sessionId: child.sessionId, status: job.status, completionReason: job.completionReason,
    finishReason: job.request?.observations.at(-1)?.finishReason ?? null, result: job.result,
    checks: child.checks.length ? structuredClone(child.checks) : child.requirements.map((rule) => ({ id: rule.id, kind: rule.kind, status: 'unchecked', policy: 'unsupported' })),
    factVerification: 'unverified', historical: Boolean(batch.historicalAt || batch.invalidatedReason) };
};
