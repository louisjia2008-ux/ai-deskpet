// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundJob } from '../../shared/background-jobs';
import { AttentionService, ATTENTION_RECENT_RESULT_MS, projectAttention } from './attention-service';
import { DomainRepository } from './repository';
import { createDefaultState } from './schemas';
import type { PersistentState } from './schemas';

const now = Date.parse('2026-11-01T13:00:00.000Z'), current = new Date(now).toISOString();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const jobFor = (state: PersistentState, status: BackgroundJob['status'] = 'succeeded'): BackgroundJob => {
  const id = randomUUID();
  return { id, profileId: state.profileId, operationId: randomUUID(), specDigest: 'a'.repeat(64), attemptId: randomUUID(), origin: 'background-jobs', resultOwner: id,
    instruction: 'Read the completed synthetic task', material: 'SYNTHETIC_MATERIAL', source: { kind: 'explicit-paste', actionId: randomUUID(), privacy: 'local-only' },
    binding: { provider: { id: randomUUID(), name: 'Synthetic provider', kind: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'synthetic', enabled: true, supportsTools: false, secretState: 'missing', localExecutionConfirmed: true },
      model: 'synthetic', digest: 'b'.repeat(64), credentialRef: randomUUID(), destination: 'local', limits: { maxOutputTokens: 512, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } } },
    status, executionOwner: null, cancelRequestedAt: null, createdAt: current, updatedAt: current, completionReason: null,
    result: status === 'succeeded' ? 'PRIVATE_RESULT_BODY_DO_NOT_COPY' : null, request: null, receipts: [] };
};
const sessionFor = (state: PersistentState): string => {
  const id = randomUUID(); state.chatSessions.push({ id, title: 'Synthetic chat', kind: 'normal', createdAt: current, updatedAt: current }); return id;
};
const delegationFor = (state: PersistentState, statuses: BackgroundJob['status'][] = ['succeeded', 'failed']) => {
  const id = randomUUID(), sessionId = sessionFor(state);
  const jobs = statuses.map(status => jobFor(state, status));
  const children = jobs.map(job => {
    const childId = randomUUID(), childSession = randomUUID();
    job.delegation = { batchId: id, childId, sessionId: childSession, parentSessionId: sessionId, intentVersion: 1, deadlineAt: new Date(now + 60_000).toISOString() };
    return { id: childId, jobId: job.id, sessionId: childSession, instruction: job.instruction, requirements: [], checks: [], reservation: { reservedTokens: 100, chargedTokens: 0, state: 'unknown' as const, reportedTokens: null } };
  });
  const batch: PersistentState['delegationBatches'][number] = { id, profileId: state.profileId, sessionId, operationId: randomUUID(), specDigest: 'c'.repeat(64), intentVersion: 1, goal: 'One owning delegation',
    deadlineAt: new Date(now + 60_000).toISOString(), createdAt: current, updatedAt: current, cancelRequestedAt: null, historicalAt: null, invalidatedReason: null,
    budget: { maxEstimatedTokens: 0, maxRequests: statuses.length }, children };
  state.backgroundJobs.push(...jobs); state.delegationBatches.push(batch); return { batch, jobs };
};
const consolidationFor = (state: PersistentState) => {
  const sessionId = sessionFor(state), id = randomUUID(), job = jobFor(state); job.consolidation = { batchId: id };
  const sourceId = randomUUID();
  const batch: PersistentState['consolidationBatches'][number] = { id, sessionId, profileId: state.profileId, previewOperationId: randomUUID(), previewDigest: 'd'.repeat(64),
    status: 'review', sources: [], candidate: { segments: [{ text: 'PRIVATE_CANDIDATE_BODY_DO_NOT_COPY', sourceIds: [sourceId] }], coveredMemoryIds: [sourceId], uncoveredMemoryIds: [], conflicts: [] },
    candidateVersion: 1, binding: job.binding, budget: { inputEstimate: 100, maxInputTokens: 7000, maxOutputTokens: 512 }, createdAt: current, updatedAt: current,
    jobId: job.id, invalidReason: null, active: false, receipts: [] };
  state.backgroundJobs.push(job); state.consolidationBatches.push(batch); return batch;
};

describe('attention projection from saved owners', () => {
  it('shows one owning card per task, delegation and memory review without copying result or candidate bodies', () => {
    const state = createDefaultState(); state.backgroundJobs.push(jobFor(state)); delegationFor(state); consolidationFor(state);
    const before = structuredClone(state), snapshot = projectAttention(state, now);
    expect(snapshot.items).toHaveLength(3); expect(snapshot.counts).toEqual({ action: 1, review: 1, result: 1, notice: 0 });
    expect(snapshot.items.map(item => item.source)).toEqual(['delegation', 'consolidation', 'background-job']);
    expect(snapshot.items[0]).toMatchObject({ status: 'mixed', completedChildren: 1, totalChildren: 2 });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_RESULT_BODY'); expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_CANDIDATE_BODY');
    expect(state).toEqual(before);
  });

  it('keeps unresolved failures and reviews, limits old successes, and leaves active or cancelled work out of the list', () => {
    const state = createDefaultState(), old = new Date(now - ATTENTION_RECENT_RESULT_MS - 1).toISOString();
    state.backgroundJobs.push({ ...jobFor(state), updatedAt: old }, { ...jobFor(state, 'interrupted'), updatedAt: old }, jobFor(state, 'running'), jobFor(state, 'cancelled'));
    const snapshot = projectAttention(state, now);
    expect(snapshot.items).toHaveLength(1); expect(snapshot.items[0]?.status).toBe('interrupted');
    expect(snapshot.runningCount).toBe(1); expect(snapshot.olderResults).toBe(1);
  });

  it('does not duplicate already published automatic replies, foreign profiles or historical/deleted parent work', () => {
    const state = createDefaultState(), triggerId = randomUUID(), automatic = jobFor(state); automatic.automaticTriggerId = triggerId;
    state.backgroundJobs.push(automatic, { ...jobFor(state), profileId: randomUUID() });
    state.automationTriggers.push({ id: triggerId, key: 'synthetic', kind: 'schedule', sourceId: randomUUID(), dueAt: current, policyRevision: 1, status: 'succeeded', publishedAt: current,
      jobId: automatic.id, messageId: randomUUID(), createdAt: current, updatedAt: current, cancelledAt: null, errorCode: null });
    const historical = delegationFor(state); historical.batch.historicalAt = current;
    const deleted = delegationFor(state); state.chatSessions.find(session => session.id === deleted.batch.sessionId)!.deletedAt = current;
    expect(projectAttention(state, now).items).toEqual([]);
  });

  it('suppresses only the acknowledged revision and brings back source updates and revised candidates', () => {
    const state = createDefaultState(), job = jobFor(state); state.backgroundJobs.push(job); const memory = consolidationFor(state);
    const first = projectAttention(state, now); state.attentionReceipts = first.items.map(item => ({ id: item.id, fingerprint: item.fingerprint, acknowledgedAt: current }));
    expect(projectAttention(state, now).items).toEqual([]);
    job.updatedAt = new Date(now + 1).toISOString(); memory.candidateVersion++;
    const next = projectAttention(state, now); expect(next.items).toHaveLength(2);
    expect(next.items.every(item => first.items.find(old => old.id === item.id)?.fingerprint !== item.fingerprint)).toBe(true);
  });

  it('brings an acknowledged partial result back when the parent deadline expires without a new provider event', () => {
    const state = createDefaultState(), { batch } = delegationFor(state, ['succeeded', 'running']);
    const first = projectAttention(state, now).items[0]!; expect(first.kind).toBe('result');
    state.attentionReceipts = [{ id: first.id, fingerprint: first.fingerprint, acknowledgedAt: current }];
    const next = projectAttention(state, Date.parse(batch.deadlineAt) + 1).items[0]!;
    expect(next.status).toBe('expired'); expect(next.fingerprint).not.toBe(first.fingerprint);
  });
});

describe('attention acknowledgements in the shared encrypted repository', () => {
  it('combines optional proactive failures without changing saved jobs, and clears only the recovered model group', () => {
    const state = createDefaultState();
    const automatic = (status: BackgroundJob['status'], minute: number, model = 'synthetic') => {
      const job = jobFor(state, status), triggerId = randomUUID(); job.automaticTriggerId = triggerId;
      job.updatedAt = new Date(now + minute * 60_000).toISOString(); job.binding.model = model;
      job.completionReason = status === 'succeeded' ? 'stop' : 'provider.request';
      state.backgroundJobs.push(job);
      state.automationTriggers.push({ id: triggerId, key: `proactive:${triggerId}`, kind: 'proactive', sourceId: randomUUID(), dueAt: current, policyRevision: 1,
        status: status === 'succeeded' ? 'succeeded' : 'failed', publishedAt: status === 'succeeded' ? job.updatedAt : null,
        jobId: job.id, messageId: status === 'succeeded' ? randomUUID() : null, createdAt: current, updatedAt: job.updatedAt, cancelledAt: null, errorCode: job.completionReason });
      return job;
    };
    const first = automatic('failed', 0), second = automatic('failed', 1); second.binding.provider.id = first.binding.provider.id;
    const manual = jobFor(state, 'failed'); state.backgroundJobs.push(manual);
    const before = structuredClone(state), result = projectAttention(state, now + 60_000);
    expect(result.counts).toEqual({ action: 1, review: 0, result: 0, notice: 1 });
    const notice = result.items.find(item => item.kind === 'notice')!;
    expect(notice).toMatchObject({ source: 'proactive', title: '', automaticIssue: { occurrences: 2, errorCode: 'provider.request' } });
    expect(JSON.stringify(notice)).not.toContain(first.instruction); expect(state).toEqual(before);
    state.attentionReceipts.push({ id: notice.id, fingerprint: notice.fingerprint, acknowledgedAt: current });
    expect(projectAttention(state, now + 60_000).items).toHaveLength(1);
    const third = automatic('failed', 2); third.binding.provider.id = first.binding.provider.id;
    expect(projectAttention(state, now + 120_000).counts.notice).toBe(1);
    const other = automatic('failed', 2, 'another-model'); other.binding.provider.id = first.binding.provider.id;
    const success = automatic('succeeded', 3); success.binding.provider.id = first.binding.provider.id;
    const recovered = projectAttention(state, now + 180_000);
    expect(recovered.counts.action).toBe(1); expect(recovered.counts.notice).toBe(1);
    expect(recovered.items.find(item => item.kind === 'notice')?.automaticIssue?.model).toBe('another-model');
    expect(state.backgroundJobs).toHaveLength(6);
    expect(projectAttention(state, now + ATTENTION_RECENT_RESULT_MS + 180_001).counts.notice).toBe(0);
  });

  it('persists one exact acknowledgement across restart without changing the job or starting work, and rejects stale revision writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-attention-')); roots.push(root); const path = join(root, 'profile.enc.json');
    const vault = { getVaultKey: async () => Buffer.alloc(32, 73) }, repository = new DomainRepository(path, vault); await repository.initialize();
    await repository.transaction(state => { state.backgroundJobs.push(jobFor(state)); });
    const service = new AttentionService(repository, () => now), item = (await service.snapshot()).items[0]!, before = repository.snapshot().backgroundJobs;
    await service.acknowledge({ id: item.id, fingerprint: item.fingerprint }); await service.acknowledge({ id: item.id, fingerprint: item.fingerprint });
    expect(repository.snapshot().attentionReceipts).toHaveLength(1); expect(repository.snapshot().backgroundJobs).toEqual(before);
    const restored = new DomainRepository(path, vault); await restored.initialize(); const next = new AttentionService(restored, () => now + 1);
    expect((await next.snapshot()).items).toEqual([]);
    await restored.transaction(state => { state.backgroundJobs[0]!.updatedAt = new Date(now + 1).toISOString(); });
    await expect(next.acknowledge({ id: item.id, fingerprint: item.fingerprint })).rejects.toThrow('attention.stale');
    expect((await next.snapshot()).items).toHaveLength(1); expect(restored.snapshot().backgroundJobs).toHaveLength(1);
  });
});
