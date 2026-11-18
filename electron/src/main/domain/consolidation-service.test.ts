// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationApplyInput, ConsolidationBatch, ConsolidationCandidate, ConsolidationPreviewInput } from '../../shared/consolidation';
import type { ContextPrivacy, MemoryItem, ProviderConfig } from '../../shared';
import { SafeStorageVault } from '../security';
import { ProfileBackupService, applyPendingProfileRestore } from '../profile-backup';
import type { ProviderChatRequest } from '../providers/types';
import { ProviderService } from '../providers/provider-service';
import { prepareProviderChatRequest } from '../providers/request-budget';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import { decryptJson } from '../persistence/encryption';
import type * as AtomicFile from '../persistence/atomic-file';
import { BackgroundJobService } from './background-job-service';
import { ConsolidationService } from './consolidation-service';
import { memorySemanticFingerprint } from './consolidation-state';
import { prepareChatContext } from './chat-context';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { persistentStateSchema } from './schemas';
import type { PersistentState } from './schemas';

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'after', predicate: null as null | ((serialized: string) => boolean) }));
vi.mock('../persistence/atomic-file', async (original) => {
  const actual = await original<typeof AtomicFile>();
  return { ...actual, atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
    const mode = fault.predicate && !fault.predicate(String(args[1])) ? 'none' : fault.mode;
    if (mode !== 'none') { fault.mode = 'none'; fault.predicate = null; }
    if (mode === 'before') throw new Error('fixture.ep4-before-rename');
    await actual.atomicWriteFile(...args);
    if (mode === 'after') throw new Error('fixture.ep4-after-rename');
  } };
});
const evidenceRoot = process.env.DESKPET_EP4_UNIT_EVIDENCE_ROOT ?? join(process.cwd(), '../../output/deskpet-electron-ep4-20261029/unitservice');
const key = Buffer.alloc(32, 94);
const local: ProviderConfig = { id: 'dc40fc79-5813-49da-92cd-49e35d972a20', kind: 'lm-studio', name: 'Synthetic consolidation local', baseUrl: 'http://127.0.0.1:19841/v1', model: 'ep4-synthetic-text', enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 2048, secretState: 'configured' };
const remote: ProviderConfig = { ...local, id: 'f64a8f43-8a49-4b89-8896-acce3da79d41', kind: 'openai', name: 'Synthetic remote destination', baseUrl: 'https://synthetic.invalid/v1', localExecutionConfirmed: false };
type Reply = { body?: string; finishReason?: string; tool?: 'modern' | 'legacy'; usage?: 'known' | 'unknown' };
type Call = { url: string; body: Record<string, unknown>; fakeCredentialPresent: boolean; respond(reply?: Reply): void };
const fixtures: Array<{ jobs: BackgroundJobService; calls: Call[]; evidence(name: string): Promise<PersistentState> }> = [];
const syntheticStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`SYNTHETIC_EP4_VAULT:${value}`), decryptString: (value: Buffer) => { const text = value.toString(); if (!text.startsWith('SYNTHETIC_EP4_VAULT:')) throw new Error('Wrong synthetic vault'); return text.slice('SYNTHETIC_EP4_VAULT:'.length); } };
const fixture = async (label: string, portable = false) => {
  const root = join(evidenceRoot, 'profiles', `${label}-${randomUUID()}`); await mkdir(root, { recursive: true }); const path = join(root, 'profile.enc.json');
  const secrets = new Map([[local.id, 'FAKE_EP4_REQUIRED_LOCAL'], [remote.id, 'FAKE_EP4_REQUIRED_REMOTE']]);
  const fakeVault = { getVaultKey: async () => Buffer.from(key), getSecret: async (id: string) => secrets.get(id) ?? null, setSecret: async (id: string, value: string) => { secrets.set(id, value); }, deleteSecret: async (id: string) => { secrets.delete(id); }, hasSecret: async (id: string) => secrets.has(id), isAvailable: () => true };
  const vault = portable ? new SafeStorageVault(join(root, 'vault'), syntheticStorage, 'darwin') : fakeVault;
  if (portable) { await vault.setSecret(local.id, 'FAKE_EP4_REQUIRED_LOCAL'); await vault.setSecret(remote.id, 'FAKE_EP4_REQUIRED_REMOTE'); }
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repo = await reopen(); await repo.transaction((state) => { state.providers.push(local, remote); state.providerCredentialRefs[local.id] = randomUUID(); state.providerCredentialRefs[remote.id] = randomUUID(); });
  const chat = new ChatService(repo); const memory = new MemoryService(repo); const session = await chat.createSession('EP4_SYNTHETIC_SESSION', 'normal');
  await chat.addMessage({ sessionId: session.id, role: 'user', content: 'UNSELECTED_CHAT_CANARY_NOT_FOR_CONSOLIDATION', status: 'complete', errorCode: null });
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => new Promise<Response>((resolve) => {
    let answered = false; calls.push({ url: String(url), body: JSON.parse(String(options?.body)) as Record<string, unknown>, fakeCredentialPresent: String((options?.headers as Record<string, string> | undefined)?.authorization ?? '').startsWith('Bearer FAKE_EP4_'),
      respond: (reply = {}) => { if (answered) return; answered = true;
        const fn = { name: 'workspace_write', arguments: '{"path":"never-created.txt","content":"MUST_NOT_EXECUTE"}' };
        const delta = reply.tool === 'modern' ? { tool_calls: [{ index: 0, id: 'untrusted-tool-label', function: fn }] } : reply.tool === 'legacy' ? { function_call: fn } : { content: reply.body ?? 'SYNTHETIC_DEFAULT_REPLY' };
        const finishReason = reply.finishReason ?? (reply.tool === 'modern' ? 'tool_calls' : reply.tool === 'legacy' ? 'function_call' : 'stop');
        const usage = reply.usage === 'unknown' ? {} : { usage: { prompt_tokens: 132, completion_tokens: 51 } };
        resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], ...usage })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      } });
  })); vi.stubGlobal('fetch', fetcher);
  const makeServices = (repository: DomainRepository, activeVault = vault) => {
    let jobs: BackgroundJobService;
    const providers = new ProviderService(repository, activeVault as SafeStorageVault, undefined, { prepared: async (record) => jobs.prepare(record), observed: async (record) => jobs.observe(record), beforeDispatch: (id) => jobs.assertDispatch(id) });
    jobs = new BackgroundJobService(repository, providers); const service = new ConsolidationService(repository, providers, jobs); return { service, jobs, providers };
  };
  const { service, jobs, providers } = makeServices(repo);
  const add = async (text = `EP4_ORIGINAL_A: Subject A uses 12 mg on weekdays, never on public holidays. ${'This source is the authoritative synthetic material and all conditions remain applicable. '.repeat(8)}`, privacy: ContextPrivacy = 'local-only') => memory.upsert({ id: randomUUID(), operationId: randomUUID(), expectedRevision: 0, text, tags: ['synthetic', 'conditions'], privacy, scope: { kind: 'global' } });
  const spec = (ids: string[], provider = local): ConsolidationPreviewInput => ({ operationId: randomUUID(), sessionId: session.id, memoryIds: ids, providerId: provider.id, model: provider.model });
  const arrived = async (count = 1) => { await vi.waitFor(() => expect(calls).toHaveLength(count)); return calls[count - 1]!; };
  const idle = async () => { await vi.waitFor(() => expect(jobs.active).toBe(false)); };
  const candidate = (ids: string[], text = 'EP4_SUMMARY_A: A uses 12 mg on weekdays; never on public holidays.'): ConsolidationCandidate => ({ segments: [{ text, sourceIds: ids }], coveredMemoryIds: ids, uncoveredMemoryIds: [], conflicts: [] });
  const generate = async (batch: ConsolidationBatch, body = candidate(batch.sources.map((source) => source.id))) => { const previous = calls.length; await service.generate({ id: batch.id, operationId: randomUUID() }); (await arrived(previous + 1)).respond({ body: JSON.stringify(body) }); await idle(); return service.get(batch.id); };
  const ready = async (items?: MemoryItem[]) => { const sources = items ?? [await add()]; return generate(await service.preview(spec(sources.map((item) => item.id)))); };
  const apply = (batch: ConsolidationBatch, enableRepresentation = true): ConsolidationApplyInput => ({ id: batch.id, operationId: randomUUID(), expectedVersion: batch.candidateVersion, fidelityReviewed: true, enableRepresentation });
  const context = (state = repo.snapshot(), evaluationRepresentation?: 'original' | 'summary' | 'both') => prepareChatContext({ sessionId: session.id, memories: state.memories, consolidationState: state, history: [], query: 'Which synthetic scheduling conditions apply?', locale: 'en', binding: { providerId: local.id, kind: local.kind, baseUrl: local.baseUrl, model: local.model, localExecutionConfirmed: true }, requiredMessages: [{ role: 'user', content: 'REQUIRED_CURRENT_USER_QUESTION' }], maxOutputTokens: 512, contextBudget: { contextWindowTokens: 32768, safetyMarginTokens: 256, capacitySource: 'configured' }, ...(evaluationRepresentation ? { evaluationRepresentation } : {}) });
  const evidence = async (name: string) => { const fresh = await reopen(); const state = fresh.snapshot(); await writeFile(join(root, `${name}.json`), JSON.stringify({ configuration: 'real encrypted repository, real ProviderService/OpenAI adapter, synthetic fetch deliberately ignoring abort, fresh repository instance read in same process; no utility or GUI claim', state, calls: calls.map(({ url, body, fakeCredentialPresent }) => ({ url, body, fakeCredentialPresent })) }, null, 2)); return state; };
  const holdForeground = async () => { const binding = await providers.captureBinding(local.id, local.model); const request: ProviderChatRequest = { model: local.model, messages: [{ role: 'user', content: 'SYNTHETIC_FOREGROUND_OCCUPIES_CAPACITY' }] }; const complete = (async () => { for await (const event of binding.adapter.streamChat(request)) void event; })(); const call = await arrived(); return { call, complete }; };
  fixtures.push({ jobs, calls, evidence });
  return { root, path, repo, chat, memory, session, service, jobs, providers, vault, calls, add, spec, arrived, idle, candidate, generate, ready, apply, context, evidence, reopen, makeServices, holdForeground };
};
const batchFault = (kind: string, mode: 'before' | 'after') => { fault.mode = mode; fault.predicate = (serialized) => decryptJson(JSON.parse(serialized), key, persistentStateSchema).consolidationBatches.some((batch) => batch.receipts.some((receipt) => receipt.kind === kind)); };
afterEach(async () => {
  fault.mode = 'none'; fault.predicate = null; vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { const ending = f.jobs.shutdown(); for (const call of f.calls) call.respond(); await ending; await f.evidence('final-after-test'); }
  vi.unstubAllGlobals();
});

describe('manual sourced consolidation authority', () => {
  it('offers only current confirmed sourced memories in the calling session', async () => {
    const f = await fixture('eligible-sources'); const good = await f.add();
    await f.memory.upsert({ id: randomUUID(), text: 'UNVERIFIED_ASSISTANT', tags: [] }, 'assistant');
    await f.memory.upsert({ id: randomUUID(), text: 'EXPIRED_MEMORY', tags: [], expiresAt: '2020-01-01T00:00:00.000Z' });
    const other = await f.chat.createSession('OTHER_SESSION', 'normal'); await f.memory.upsert({ id: randomUUID(), text: 'OTHER_SCOPE', tags: [], scope: { kind: 'session', sessionId: other.id } });
    const sources = await f.service.sources(f.session.id); expect(sources.map((source) => source.id)).toEqual([good.id]); expect(sources[0]?.sourceEventIds).toHaveLength(1); expect(sources[0]?.fingerprint).toBe(memorySemanticFingerprint(good)); await f.evidence('source-selection');
  });

  it('freezes actual binding and material without a job, deduplicates the preview and rejects conflicting content', async () => {
    const f = await fixture('preview'); const source = await f.add(); const input = f.spec([source.id]); const before = f.repo.snapshot();
    const [a,b] = await Promise.all([f.service.preview(input), f.service.preview(input)]); expect(a.id).toBe(b.id); expect(a.binding.model).toBe(local.model); expect(a.budget.inputEstimate).toBeGreaterThan(source.text.length / 4);
    expect(f.repo.snapshot().backgroundJobs).toHaveLength(0); expect(f.calls).toHaveLength(0); expect(f.repo.snapshot().memories).toEqual(before.memories);
    await expect(f.service.preview({ ...input, model: 'CHANGED_MODEL' })).rejects.toThrow('consolidation.operationConflict'); await f.evidence('frozen-preview');
  });

  it('blocks local-only input for a remote binding and allows explicitly cloud-allowed input without relaxing dependencies', async () => {
    const f = await fixture('privacy'); const privateSource = await f.add(); await expect(f.service.preview(f.spec([privateSource.id], remote))).rejects.toThrow('consolidation.privacyBlocked');
    const shareable = await f.add('SHAREABLE_SOURCE: current preference is a blue cup, only at work.', 'cloud-allowed'); const batch = await f.service.preview(f.spec([shareable.id], remote)); expect(batch.binding.destination).toBe('remote'); expect(batch.sources[0]?.privacy).toBe('cloud-allowed'); expect(f.calls).toHaveLength(0); await f.evidence('privacy-allow-deny');
  });

  it('deduplicates a single generation operation, rejects another attempt and sends only selected material with no tools', async () => {
    const f = await fixture('single-attempt'); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); const input = { id: batch.id, operationId: randomUUID() };
    await Promise.all([f.service.generate(input), f.service.generate(input)]); const call = await f.arrived(); const wire = JSON.stringify(call.body);
    expect(call.body.tools).toBeUndefined(); expect(call.body.tool_choice).toBe('none'); expect(wire).toContain(source.text); expect(wire).not.toContain('UNSELECTED_CHAT_CANARY'); expect(wire).not.toContain('FAKE_EP4_'); expect(call.fakeCredentialPresent).toBe(true);
    call.respond({ body: JSON.stringify(f.candidate([source.id])) }); await f.idle(); expect((await f.service.generate(input)).status).toBe('review'); await expect(f.service.generate({ id: batch.id, operationId: randomUUID() })).rejects.toThrow('consolidation.alreadyGenerated'); expect(f.calls).toHaveLength(1); expect(f.repo.snapshot().backgroundJobs).toHaveLength(1); await f.evidence('one-job-one-fetch');
  });

  it('binds a consolidation operation ID across batches and action kinds rather than treating it as new generation authorization', async () => {
    const f = await fixture('global-operation-key'); const source = await f.add(); const a = await f.service.preview(f.spec([source.id])); const b = await f.service.preview(f.spec([source.id])); const operationId = randomUUID(); await f.service.generate({ id: a.id, operationId }); await expect(f.service.generate({ id: b.id, operationId })).rejects.toThrow('consolidation.operationConflict'); await expect(f.service.cancel({ id: a.id, operationId })).rejects.toThrow('consolidation.operationConflict'); await expect(f.service.preview({ ...f.spec([source.id]), operationId })).rejects.toThrow('consolidation.operationConflict'); (await f.arrived()).respond({ body: JSON.stringify(f.candidate([source.id])) }); await f.idle(); const state = await f.evidence('global-id-bound-to-original-content'); expect(state.backgroundJobs).toHaveLength(1); expect(state.consolidationBatches.find((batch) => batch.id === b.id)?.status).toBe('draft'); expect(f.calls).toHaveLength(1);
  });

  it('keeps candidate outside context before review, atomically applies one representation without changing facts, evidence or semantic revisions', async () => {
    const f = await fixture('apply'); const batch = await f.ready(); const before = f.repo.snapshot(); const raw = JSON.stringify(f.context().messages); expect(raw).toContain('EP4_ORIGINAL_A'); expect(raw).not.toContain('EP4_SUMMARY_A');
    const input = f.apply(batch); await f.service.apply(input); const state = await f.evidence('applied'); expect(state.memories).toEqual(before.memories); expect(state.memoryRevision).toBe(before.memoryRevision); expect(state.memoryOperations).toEqual(before.memoryOperations); expect(state.conversationImports).toEqual(before.conversationImports);
    const prepared = f.context(state); const wire = JSON.stringify(prepared.messages); expect(wire).toContain('EP4_SUMMARY_A'); expect(wire).not.toContain('EP4_ORIGINAL_A'); expect(wire).toContain('REQUIRED_CURRENT_USER_QUESTION'); expect(prepared.projection.memoryReferences).toHaveLength(1); expect(prepared.projection.representationReferences).toEqual([{ batchId: batch.id, candidateVersion: 1 }]);
    await f.service.apply(input); expect(f.repo.snapshot().memories).toEqual(before.memories); expect(f.repo.snapshot().consolidationSelections[0]?.version).toBe(1); expect(f.repo.snapshot().consolidationBatches[0]?.receipts.filter((receipt) => receipt.kind === 'apply')).toHaveLength(1);
    await expect(f.service.apply({ ...input, enableRepresentation: false })).rejects.toThrow('consolidation.operationConflict');
  });

  it('binds edits and confirmation to the reviewed candidate version while preserving original evidence', async () => {
    const f = await fixture('edit-version'); const batch = await f.ready(); const before = f.repo.snapshot().memories; const input = { id: batch.id, operationId: randomUUID(), expectedVersion: 1, candidate: f.candidate(batch.sources.map((source) => source.id), 'EDITED_SUMMARY: A 12 mg, weekdays only, excluding public holidays.') };
    const edited = await f.service.edit(input); expect(edited.candidateVersion).toBe(2); expect((await f.service.edit(input)).candidateVersion).toBe(2); expect(f.repo.snapshot().memories).toEqual(before);
    await expect(f.service.apply(f.apply(batch))).rejects.toThrow('consolidation.staleCandidate'); await expect(f.service.edit({ ...input, candidate: f.candidate(input.candidate.coveredMemoryIds, 'DIFFERENT') })).rejects.toThrow('consolidation.operationConflict'); await f.service.apply(f.apply(edited)); await f.evidence('edited-version-applied');
  });

  it('rejects invalid source references and invalid coverage without inventing a repair candidate or retry', async () => {
    const f = await fixture('invalid-reference'); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); const invalid = f.candidate([randomUUID()]); await f.service.generate({ id: batch.id, operationId: randomUUID() }); (await f.arrived()).respond({ body: JSON.stringify(invalid) }); await f.idle();
    const view = await f.service.get(batch.id); expect(view.status).toBe('failed'); expect(view.candidate).toBeNull(); expect(view.rawResponse).toBe(JSON.stringify(invalid)); expect(view.invalidReason).toBe('consolidation.invalidCandidate'); expect(f.calls).toHaveLength(1); await expect(f.service.apply({ ...f.apply(view), expectedVersion: 1 })).rejects.toThrow('consolidation.staleCandidate'); await f.evidence('invalid-candidate-no-repair');
  });

  it.each(['modern','legacy','truncated'] as const)('retains %s generation failure with no candidate, tool execution or follow-up', async (kind) => {
    const f = await fixture(`failure-${kind}`); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); await f.service.generate({ id: batch.id, operationId: randomUUID() });
    (await f.arrived()).respond(kind === 'truncated' ? { body: JSON.stringify(f.candidate([source.id])), finishReason: 'length' } : { tool: kind }); await f.idle(); const view = await f.service.get(batch.id);
    expect(view.status).toBe('failed'); expect(view.candidate).toBeNull(); expect(view.rawResponse).toBeNull(); expect(view.completionReason).toBe(kind === 'truncated' ? 'provider.truncated' : 'job.toolsForbidden'); expect(f.calls).toHaveLength(1); expect(f.repo.snapshot().backgroundJobs).toHaveLength(1); await f.evidence('protocol-failure');
  });

  it('hides derived jobs from generic job listing, reading, cancelling and replay submission', async () => {
    const f = await fixture('generic-job-block'); const batch = await f.ready(); const job = f.repo.snapshot().backgroundJobs.find((item) => item.id === batch.jobId)!; expect(await f.jobs.list()).toEqual([]);
    await expect(f.jobs.get(job.id)).rejects.toThrow('consolidation.useReviewEntry'); await expect(f.jobs.cancel(job.id)).rejects.toThrow('consolidation.useReviewEntry'); await expect(f.jobs.submit({ operationId: job.operationId, instruction: job.instruction, material: job.material, privacy: job.source.privacy, providerId: local.id, model: local.model })).rejects.toThrow('consolidation.useReviewEntry'); expect(f.calls).toHaveLength(1); await f.evidence('generic-entry-blocked');
  });

  it('invalidates and purges all derived body copies when a source is corrected before confirmation', async () => {
    const f = await fixture('correct-before-apply'); const batch = await f.ready(); const old = f.repo.snapshot().memories[0]!; await f.memory.upsert({ id: old.id, operationId: randomUUID(), expectedRevision: old.contextMetadata!.revision, text: 'CURRENT_CORRECTION: A uses 8 mg on weekends only.', tags: old.tags });
    const current = await f.service.get(batch.id); expect(current.status).toBe('invalid'); expect(current.sources.every((source) => source.text === '' && source.tags.length === 0)).toBe(true); expect(current.candidate).toBeNull(); expect(current.rawResponse).toBeNull(); await expect(f.service.apply(f.apply(batch))).rejects.toThrow('consolidation.sourceChanged');
    const state = await f.evidence('corrected-purged'); const job = state.backgroundJobs.find((item) => item.id === batch.jobId)!; expect(job.material).toBe(''); expect(job.result).toBeNull(); const wire = JSON.stringify(f.context(state).messages); expect(wire).toContain('CURRENT_CORRECTION'); expect(wire).not.toContain('EP4_SUMMARY_A'); expect(wire).not.toContain('EP4_ORIGINAL_A');
  });

  it('deletes an applied source without retaining its body in candidate, job result or material and never reactivates via historical apply receipt', async () => {
    const f = await fixture('delete-applied'); const batch = await f.ready(); const input = f.apply(batch); await f.service.apply(input); const source = f.repo.snapshot().memories[0]!; await f.memory.remove(source.id, { expectedRevision: source.contextMetadata!.revision, operationId: randomUUID() });
    const replay = await f.service.apply(input); expect(replay.active).toBe(false); expect(replay.status).toBe('invalid'); const state = await f.evidence('deleted-derived-purged'); expect(state.memories).toHaveLength(0); expect(state.memoryTombstones).toHaveLength(1); expect(state.consolidationSelections.every((selection) => selection.batchId === null)).toBe(true);
    const derived = JSON.stringify({ batches: state.consolidationBatches, jobs: state.backgroundJobs }); expect(derived).not.toContain('EP4_ORIGINAL_A'); expect(derived).not.toContain('EP4_SUMMARY_A'); expect(JSON.stringify(f.context(state).messages)).not.toContain('EP4_SUMMARY_A'); await f.service.disable({ id: batch.id, operationId: randomUUID() }); expect(f.repo.snapshot().memories).toEqual([]);
  });

  it('invalidates on related sharing withdrawal and preserves restrictions from all generation inputs, even uncited input', async () => {
    const f = await fixture('permission-withdrawal'); const a = await f.add(); const b = await f.add('SHAREABLE_OTHER_INPUT: B likes green tea at work only.', 'cloud-allowed'); const preview = await f.service.preview(f.spec([a.id,b.id])); const body = f.candidate([b.id]); body.uncoveredMemoryIds = [a.id]; const batch = await f.generate(preview, body); await f.service.apply(f.apply(batch));
    expect(f.repo.snapshot().backgroundJobs[0]?.source.privacy).toBe('local-only'); const original = f.repo.snapshot().memories.find((item) => item.id === b.id)!; await f.memory.upsert({ id: b.id, operationId: randomUUID(), expectedRevision: original.contextMetadata!.revision, text: original.text, tags: original.tags, privacy: 'local-only' }); const view = await f.service.get(batch.id); expect(view.status).toBe('invalid'); expect(view.rawResponse).toBeNull(); expect(view.sources.every((source) => source.text === '')).toBe(true); await f.evidence('all-input-privacy-inherited');
  });

  it('rejects a stale per-memory selection baseline instead of replacing a newer confirmed representation', async () => {
    const f = await fixture('selection-conflict'); const source = await f.add(); const first = await f.generate(await f.service.preview(f.spec([source.id]))); const second = await f.generate(await f.service.preview(f.spec([source.id])), f.candidate([source.id], 'WINNER_SUMMARY: A 12 mg weekdays, excluding public holidays.'));
    await f.service.apply(f.apply(second)); let rejected: unknown; try { await f.service.apply(f.apply(first)); } catch (cause) { rejected = cause; }
    // Persist observation before assertions so the temporary known-wrong copy
    // must reveal a genuinely overwritten selection, not a build/test failure.
    const state = await f.evidence('selection-conflict-observation'); await writeFile(join(f.root, 'selection-expected.json'), JSON.stringify({ winner: second.id, stale: first.id, sourceId: source.id, rejection: rejected instanceof Error ? rejected.message : null }, null, 2));
    expect(state.consolidationSelections.find((selection) => selection.memoryId === source.id)?.batchId).toBe(second.id); expect(state.consolidationBatches.find((batch) => batch.id === first.id)?.status).toBe('review'); expect(rejected).toBeInstanceOf(Error); expect(String(rejected)).toContain('consolidation.selectionConflict'); expect((await f.service.get(first.id)).candidate).not.toBeNull();
  });

  it('ignores unrelated chat writes and sent telemetry while keeping semantic revisions and evidence stable', async () => {
    const f = await fixture('unrelated-writes'); const batch = await f.ready(); const before = f.repo.snapshot(); await f.chat.addMessage({ sessionId: f.session.id, role: 'user', content: 'UNRELATED_NEW_MESSAGE', status: 'complete', errorCode: null });
    await f.repo.transaction((state) => { const memory = state.memories[0]!; memory.contextMetadata!.sentCount += 1; memory.contextMetadata!.lastSentAt = new Date().toISOString(); }); await f.service.apply(f.apply(batch)); const current = await f.evidence('telemetry-not-semantic'); expect(current.memoryRevision).toBe(before.memoryRevision); expect(current.memories[0]?.contextMetadata?.revision).toBe(before.memories[0]?.contextMetadata?.revision); expect(current.memories[0]?.contextMetadata?.sourceEventIds).toEqual(before.memories[0]?.contextMetadata?.sourceEventIds); expect(memorySemanticFingerprint(current.memories[0]!)).toBe(batch.sources[0]?.fingerprint); expect(current.chatMessages.some((message) => message.content === 'UNRELATED_NEW_MESSAGE')).toBe(true);
  });

  it('invalidates a global dependency shadowed by a newer session override even when the global fact itself is unchanged', async () => {
    const f = await fixture('scope-overlay'); const batch = await f.ready(); const original = f.repo.snapshot().memories[0]!; const overlay = await f.memory.upsert({ id: randomUUID(), operationId: randomUUID(), text: 'SESSION_OVERRIDE: A uses 8 mg in this session.', tags: ['synthetic'], scope: { kind: 'session', sessionId: f.session.id }, privacy: 'local-only' });
    // The host-owned override reference models the existing explicit chat
    // override path. Renderer does not supply this provenance field.
    await f.repo.transaction((state) => { state.memories.find((item) => item.id === overlay.id)!.contextMetadata!.overridesMemory = { id: original.id, revision: original.contextMetadata!.revision }; }); const view = await f.service.get(batch.id); const state = await f.evidence('projected-scope-invalidates-dependency'); expect(memorySemanticFingerprint(state.memories.find((item) => item.id === original.id)!)).toBe(batch.sources[0]?.fingerprint); expect(view.status).toBe('invalid'); expect(view.candidate).toBeNull(); expect(view.sources.every((source) => source.text === '' && source.tags.length === 0)).toBe(true); expect((await f.service.sources(f.session.id)).map((source) => source.id)).toEqual([overlay.id]);
  });

  it('keeps original retrieval facts and falls back for partial coverage without dropping uncovered material', async () => {
    const f = await fixture('partial-range'); const a = await f.add(); const b = await f.add('UNCOVERED_ORIGINAL_B: B has an amber cup only at home.'); const candidate = f.candidate([a.id]); candidate.uncoveredMemoryIds = [b.id]; const batch = await f.generate(await f.service.preview(f.spec([a.id,b.id])), candidate); await f.service.apply(f.apply(batch)); const prepared = f.context(); const wire = JSON.stringify(prepared.messages);
    expect(wire).toContain('EP4_ORIGINAL_A'); expect(wire).toContain('UNCOVERED_ORIGINAL_B'); expect(wire).not.toContain('EP4_SUMMARY_A'); expect(prepared.projection.memoryReferences.map((reference) => reference.id).sort()).toEqual([a.id,b.id].sort()); expect(prepared.projection.representationDecisions?.some((decision) => decision.reason === 'partial-coverage')).toBe(true); await f.evidence('partial-current-originals');
  });

  it('does not double inject overlapping confirmed ranges or discard the remaining source', async () => {
    const f = await fixture('overlap'); const a = await f.add(); const b = await f.add(`ORIGINAL_B_ONLY: B prefers green cups at work only. ${'Synthetic source B retains its complete scoped preference. '.repeat(8)}`); const c = await f.add(`ORIGINAL_C_ONLY: C uses a red plate at home only. ${'Synthetic source C retains its full scoped preference. '.repeat(8)}`);
    const first = await f.ready([a,b]); await f.service.apply(f.apply(first)); const second = await f.generate(await f.service.preview(f.spec([b.id,c.id])), f.candidate([b.id,c.id], 'BC_SUMMARY: B prefers green cups only at work; C uses a red plate only at home.')); await f.service.apply(f.apply(second)); const prepared = f.context(); const wire = JSON.stringify(prepared.messages);
    expect(wire).toContain('BC_SUMMARY'); expect(wire).toContain('EP4_ORIGINAL_A'); expect(wire).not.toContain('ORIGINAL_B_ONLY'); expect(wire).not.toContain('ORIGINAL_C_ONLY'); expect(wire).not.toContain('EP4_SUMMARY_A'); expect(prepared.projection.memoryReferences).toHaveLength(3); expect(prepared.projection.representationReferences).toHaveLength(1); await f.evidence('overlap-single-range-plus-remainder');
  });

  it('uses current originals when the summary wrapper has no complete-input byte benefit', async () => {
    const f = await fixture('no-benefit'); const source = await f.add('SHORT_ORIGINAL: A is blue.'); const batch = await f.ready([source]); await f.service.apply(f.apply(batch)); const prepared = f.context(); expect(JSON.stringify(prepared.messages)).toContain('SHORT_ORIGINAL'); expect(JSON.stringify(prepared.messages)).not.toContain('EP4_SUMMARY_A'); expect(prepared.projection.representationDecisions?.[0]?.reason).toBe('no-input-byte-benefit'); await f.evidence('no-benefit-original-fallback');
  });

  it('disables only representation selection and returns current originals without extra evidence', async () => {
    const f = await fixture('disable'); const batch = await f.ready(); await f.service.apply(f.apply(batch)); const before = f.repo.snapshot(); const input = { id: batch.id, operationId: randomUUID() }; await f.service.disable(input); await f.service.disable(input); const state = await f.evidence('disabled'); expect(state.memories).toEqual(before.memories); expect(state.memoryRevision).toBe(before.memoryRevision); expect(state.consolidationSelections[0]?.batchId).toBeNull(); expect(state.consolidationSelections[0]?.version).toBe(2); const wire = JSON.stringify(f.context().messages); expect(wire).toContain('EP4_ORIGINAL_A'); expect(wire).not.toContain('EP4_SUMMARY_A');
  });

  it('cancels a generating batch before a late response without publishing a candidate or retry', async () => {
    const f = await fixture('cancel-late'); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); await f.service.generate({ id: batch.id, operationId: randomUUID() }); const call = await f.arrived(); await f.service.cancel({ id: batch.id, operationId: randomUUID() }); call.respond({ body: JSON.stringify(f.candidate([source.id])), usage: 'unknown' }); await f.idle(); const result = await f.service.get(batch.id); expect(result.status).toBe('cancelled'); expect(result.candidate).toBeNull(); expect(result.rawResponse).toBeNull(); expect(f.calls).toHaveLength(1); await f.evidence('cancel-late-no-publication');
  });

  it('blocks queued generation after the frozen credential reference is withdrawn', async () => {
    const f = await fixture('queued-revocation'); const front = await f.holdForeground(); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); await f.service.generate({ id: batch.id, operationId: randomUUID() }); await f.repo.transaction((state) => { state.providerCredentialRefs[local.id] = randomUUID(); }); front.call.respond(); await front.complete; await f.idle(); const result = await f.service.get(batch.id); expect(result.status).toBe('failed'); expect(result.jobStatus).toBe('blocked'); expect(result.completionReason).toBe('provider.bindingMismatch'); expect(f.calls).toHaveLength(1); await f.evidence('revoked-before-dispatch');
  });

  it('publishes neither representation nor apply receipt when rename has not occurred', async () => {
    const f = await fixture('pre-rename'); const batch = await f.ready(); const input = f.apply(batch); const bytes = await readFile(f.path); batchFault('apply','before'); await expect(f.service.apply(input)).rejects.toThrow('fixture.ep4-before-rename'); expect(await readFile(f.path)).toEqual(bytes); const state = await f.evidence('pre-rename-not-published'); expect(state.consolidationSelections).toEqual([]); expect(state.consolidationBatches[0]?.receipts.some((receipt) => receipt.kind === 'apply')).toBe(false); await f.service.apply(input); expect(f.repo.snapshot().consolidationSelections).toHaveLength(1);
  });

  it('recovers apply acknowledgement loss from authenticated disk without a duplicate selection update', async () => {
    const f = await fixture('post-rename'); const batch = await f.ready(); const input = f.apply(batch); batchFault('apply','after'); const result = await f.service.apply(input); expect(result.status).toBe('applied'); const fresh = await f.reopen(); const resumed = f.makeServices(fresh); await resumed.service.apply(input); const state = await f.evidence('ack-loss-reused'); expect(state.consolidationSelections[0]?.version).toBe(1); expect(state.consolidationBatches[0]?.receipts.filter((receipt) => receipt.kind === 'apply')).toHaveLength(1); expect(f.calls).toHaveLength(1); await resumed.jobs.shutdown();
  });

  it('keeps an unreadable generation commit unknown and never dispatches until original authority is recovered', async () => {
    const f = await fixture('uncertain-generate'); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); const input = { id: batch.id, operationId: randomUUID() }; const read = vi.spyOn(EncryptedJsonStore.prototype,'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable')); batchFault('generate','after');
    await expect(f.service.generate(input)).rejects.toThrow('repository.commitUncertain'); expect(f.calls).toHaveLength(0); await expect(f.service.get(batch.id)).rejects.toThrow('repository.commitUncertain'); expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain'); read.mockRestore(); const recovered = await f.service.generate(input); expect(recovered.jobId).not.toBeNull(); (await f.arrived()).respond({ body: JSON.stringify(f.candidate([source.id])) }); await f.idle(); const state = await f.evidence('uncertain-generate-recovered'); expect(state.backgroundJobs).toHaveLength(1); expect(f.calls).toHaveLength(1);
  });

  it('does not use an unconfirmed representation while apply authority is unreadable, then reuses its original receipt', async () => {
    const f = await fixture('uncertain-apply'); const batch = await f.ready(); const input = f.apply(batch); const read = vi.spyOn(EncryptedJsonStore.prototype,'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable')); batchFault('apply','after'); await expect(f.service.apply(input)).rejects.toThrow('repository.commitUncertain'); expect(() => f.context()).toThrow('repository.commitUncertain'); await expect(f.service.apply(input)).rejects.toThrow('repository.commitUncertain'); read.mockRestore(); expect((await f.service.apply(input)).active).toBe(true); const state = await f.evidence('uncertain-apply-receipt-recovered'); expect(state.consolidationSelections[0]?.version).toBe(1); expect(state.consolidationBatches[0]?.receipts.filter((receipt) => receipt.kind === 'apply')).toHaveLength(1); expect(f.calls).toHaveLength(1);
  });

  it('recovers an unknown result publication through consolidation authority and resumes a queued legal batch without generic job APIs', async () => {
    const f = await fixture('publish-unknown-recovery'); const source = await f.add(); const first = await f.service.preview(f.spec([source.id])); const started = await f.service.generate({ id: first.id, operationId: randomUUID() }); const held = await f.arrived(); const second = await f.service.preview(f.spec([source.id])); await f.service.generate({ id: second.id, operationId: randomUUID() });
    const genericList = vi.spyOn(f.jobs,'list'); const genericGet = vi.spyOn(f.jobs,'get'); const genericSubmit = vi.spyOn(f.jobs,'submit'); const read = vi.spyOn(EncryptedJsonStore.prototype,'readPersisted').mockRejectedValue(new Error('fixture.publish-authority-unreadable')); fault.mode = 'after'; fault.predicate = (serialized) => decryptJson(JSON.parse(serialized),key,persistentStateSchema).backgroundJobs.some((job) => job.id === started.jobId && job.status === 'succeeded'); held.respond({body:JSON.stringify(f.candidate([source.id]))}); await f.idle();
    expect(f.calls).toHaveLength(1); expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain'); await expect(f.service.get(first.id)).rejects.toThrow('repository.commitUncertain'); expect(f.calls).toHaveLength(1); read.mockRestore(); const recovered = await f.service.get(first.id); expect(recovered.status).toBe('review'); expect(recovered.candidateVersion).toBe(1); expect(recovered.candidate).toEqual(f.candidate([source.id]));
    (await f.arrived(2)).respond({body:JSON.stringify(f.candidate([source.id],'SECOND_LEGAL_SUMMARY: A 12 mg weekdays, excluding public holidays.'))}); await f.idle(); expect((await f.service.get(second.id)).status).toBe('review'); expect(genericList).not.toHaveBeenCalled(); expect(genericGet).not.toHaveBeenCalled(); expect(genericSubmit).not.toHaveBeenCalled(); const state = await f.evidence('publish-unknown-host-recovered-worker'); expect(state.backgroundJobs).toHaveLength(2); expect(state.backgroundJobs.every((job) => job.status === 'succeeded')).toBe(true); expect(state.backgroundJobs.find((job) => job.id === started.jobId)?.receipts.filter((receipt) => receipt.kind === 'terminal')).toHaveLength(1); expect(f.calls).toHaveLength(2);
  });

  it('retains private representation lineage through summarized ancestors and refuses a prepared send after disable', async () => {
    const f = await fixture('ancestor-final-send'); const batch = await f.ready(); await f.service.apply(f.apply(batch)); const source = f.repo.snapshot().memories[0]!;
    const prepareTurn = async (assistantId: string, userContent: string, history: ReturnType<ChatService['listMessages']>, query: string) => {
      const state = f.repo.snapshot(); const prepared = prepareChatContext({ sessionId: f.session.id, memories: state.memories, consolidationState: state, history, query, locale: 'en', binding: { providerId: local.id, kind: local.kind, baseUrl: local.baseUrl, model: local.model, localExecutionConfirmed: true }, requiredMessages: [{ role: 'user', content: userContent }], maxOutputTokens: 512, contextBudget: { contextWindowTokens: 32768, safetyMarginTokens: 256, capacitySource: 'configured' } });
      const requestId = randomUUID(); const wire = prepareProviderChatRequest({ model:local.model,messages:prepared.messages,maxOutputTokens:512,contextBudget:{contextWindowTokens:32768,safetyMarginTokens:256,capacitySource:'configured'} });
      await f.chat.prepareRequest(assistantId,{requestId,bindingDigest:batch.binding.digest,expectedBodySHA256:wire.bodySHA256,inputEstimate:wire.inputEstimate,maxInputTokens:wire.maxInputTokens!,maxOutputTokens:512,capacitySource:'configured',contextTrace:prepared.projection}); return {prepared,requestId};
    };
    // Real host request-preparation records create the historic lineage. No
    // extra provider invocation is performed for these synthetic chat replies.
    // Spaced filler keeps the same history-character pressure without turning
    // this lineage test into a repeated-token BPE performance benchmark.
    const oldUser = await f.chat.addMessage({sessionId:f.session.id,role:'user',content:'OLD_SOURCE_QUESTION '+ 'x'.repeat(990),status:'complete',errorCode:null}); const oldReply = await f.chat.addMessage({sessionId:f.session.id,role:'assistant',content:'',status:'streaming',errorCode:null}); await prepareTurn(oldReply.id,oldUser.content,[],'conditions'); await f.chat.updateMessage(oldReply.id,{content:'ANCESTOR_SUMMARY_CANARY '+ 'x '.repeat(9975),status:'complete',errorCode:null});
    for (let index=0;index<20;index+=1) await f.add(`priority independent current fact ${index}.`,'cloud-allowed');
    const midHistory=f.chat.listMessages(f.session.id).filter((message)=>message.id===oldUser.id||message.id===oldReply.id); const midUser=await f.chat.addMessage({sessionId:f.session.id,role:'user',content:'MID_USER_SUMMARY_CANARY '+ 'x'.repeat(2970),status:'complete',errorCode:null}); const midReply=await f.chat.addMessage({sessionId:f.session.id,role:'assistant',content:'',status:'streaming',errorCode:null}); await prepareTurn(midReply.id,midUser.content,midHistory,'priority'); await f.chat.updateMessage(midReply.id,{content:'DESCENDANT_SUMMARY_CANARY '+ 'x'.repeat(2970),status:'complete',errorCode:null});
    const history=f.chat.listMessages(f.session.id).filter((message)=>[oldUser.id,oldReply.id,midUser.id,midReply.id].includes(message.id)); const current=await f.chat.addMessage({sessionId:f.session.id,role:'user',content:'priority CURRENT_QUESTION',status:'complete',errorCode:null}); const reply=await f.chat.addMessage({sessionId:f.session.id,role:'assistant',content:'',status:'streaming',errorCode:null}); const {prepared,requestId}=await prepareTurn(reply.id,current.content,history,'priority'); f.chat.assertPreparedRequest(reply.id,requestId);
    await f.service.disable({id:batch.id,operationId:randomUUID()}); let rejection:unknown; try{f.chat.assertPreparedRequest(reply.id,requestId);}catch(cause){rejection=cause;}
    const state=await f.evidence('ancestor-disabled-finalguard-state'); await writeFile(join(f.root,'ancestor-disabled-finalguard-observation.json'),JSON.stringify({configuration:'actual prepareChatContext + actual encrypted ChatService prepareRequest + disable + final assertPreparedRequest; synthetic prior replies, no chat HTTP invocation',sourceId:source.id,batchId:batch.id,requestId,assistantId:reply.id,ancestorFullBodyOmitted:!prepared.messages.some(message=>message.content===history.find(item=>item.id===oldReply.id)?.content),ancestorSummarized:prepared.projection.summaryReferences?.some(reference=>reference.messageId===oldReply.id),descendantRetained:prepared.projection.historyMessageIds.includes(midReply.id),descendantBodyPresent:JSON.stringify(prepared.messages).includes('DESCENDANT_SUMMARY_CANARY'),projection:prepared.projection,rejection:rejection instanceof Error?rejection.message:null,stateBatchStatus:state.consolidationBatches.find((item)=>item.id===batch.id)?.status},null,2));
    const originalBody = history.find(item => item.id === oldReply.id)!.content;
    expect(prepared.messages.some(message => message.content === originalBody)).toBe(false);
    expect(prepared.projection.summaryReferences?.map(reference => reference.messageId)).toContain(oldReply.id);
    expect(prepared.projection.historyMessageIds).toContain(oldReply.id);
    expect(prepared.projection.privacy).toBe('local-only');
    expect(state.consolidationBatches.find(item => item.id === batch.id)?.status).toBe('disabled');
    expect(prepared.projection.historyMessageIds).toContain(midReply.id); expect(JSON.stringify(prepared.messages)).toContain('DESCENDANT_SUMMARY_CANARY'); expect(prepared.projection.memoryReferences.some((reference)=>reference.id===source.id)).toBe(true); expect(rejection).toBeInstanceOf(Error); expect(String(rejection)).toContain('chat.contextStale'); expect(prepared.projection.representationReferences).toContainEqual({batchId:batch.id,candidateVersion:batch.candidateVersion});
  });

  it('rejects a late generation result after source deletion and purges the in-flight material', async () => {
    const f = await fixture('delete-during-generation'); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); await f.service.generate({ id: batch.id, operationId: randomUUID() }); const call = await f.arrived(); await f.memory.remove(source.id, { expectedRevision: source.contextMetadata!.revision, operationId: randomUUID() }); call.respond({ body: JSON.stringify(f.candidate([source.id])), finishReason: 'MODEL_RAW_BODY_CANARY' }); await f.idle();
    const state = await f.evidence('deleted-before-result'); const view = await f.service.get(batch.id); expect(view.status).toBe('invalid'); expect(view.candidate).toBeNull(); expect(view.rawResponse).toBeNull(); const job = state.backgroundJobs.find((item) => item.id === view.jobId)!; expect(job.material).toBe(''); expect(job.result).toBeNull(); expect(job.request?.observations.every((observation) => observation.finishReason === null)).toBe(true); expect(f.calls).toHaveLength(1);
  });

  it('invalidates a derived representation when its original chat source becomes unavailable', async () => {
    const f = await fixture('original-chat-unavailable'); const origin = await f.chat.createSession('EXPLICIT_ORIGINAL_SOURCE', 'normal'); const text = `ORIGINAL_CHAT_FACT: Subject C uses 7 ml only at home. ${'The recorded place and unit are part of this synthetic user statement. '.repeat(8)}`; await f.chat.addMessage({ sessionId: origin.id, role: 'user', content: `Remember that ${text}`, status: 'complete', errorCode: null }); const reply = await f.chat.addMessage({ sessionId: origin.id, role: 'assistant', content: '', status: 'complete', errorCode: null }); const receipt = await f.memory.saveFromChat(reply.id,text); const source = f.repo.snapshot().memories.find((memory) => memory.id === receipt.memoryId)!; const batch = await f.ready([source]); await f.service.apply(f.apply(batch)); await f.chat.removeSession(origin.id); const current = await f.service.get(batch.id); expect(current.status).toBe('invalid'); expect(current.candidate).toBeNull(); expect(current.rawResponse).toBeNull(); expect((await f.service.sources(f.session.id)).some((item) => item.id === source.id)).toBe(false); const state = await f.evidence('origin-chat-removed'); expect(state.memories.some((item) => item.id === source.id)).toBe(true); expect(state.chatSessions.find((item) => item.id === origin.id)?.deletedAt).toBeTruthy();
  });

  it('cannot restore a deleted source or its derived copies through an older applied backup', async () => {
    const f = await fixture('backup-deleted-source',true); const batch = await f.ready(); await f.service.apply(f.apply(batch)); await f.jobs.shutdown(); await mkdir(join(evidenceRoot,'archives'),{recursive:true}); const path = join(evidenceRoot,'archives',`${randomUUID()}.deskpet-backup`); const backups = new ProfileBackupService(f.root,f.vault as SafeStorageVault,'0.1.0'); await backups.create(path,'synthetic-ep4-backup-password'); const source = f.repo.snapshot().memories[0]!; await f.memory.remove(source.id,{expectedRevision:source.contextMetadata!.revision,operationId:randomUUID()}); await backups.prepareRestore(path,'synthetic-ep4-backup-password'); await applyPendingProfileRestore(f.root); const vault = new SafeStorageVault(join(f.root,'vault'),syntheticStorage,'darwin'); const fresh = new DomainRepository(f.path,vault); await fresh.initialize(); const resumed = f.makeServices(fresh,vault); await resumed.jobs.initialize(); await vi.waitFor(() => expect(resumed.jobs.active).toBe(false)); const state = fresh.snapshot(); const view = await resumed.service.get(batch.id); expect(state.memories).toEqual([]); expect(state.memoryTombstones.length).toBeGreaterThan(0); expect(view.status).toBe('invalid'); expect(view.active).toBe(false); expect(view.candidate).toBeNull(); expect(view.rawResponse).toBeNull(); expect(state.backgroundJobs[0]?.material).toBe(''); expect(f.calls).toHaveLength(1); await writeFile(join(f.root,'old-backup-after-newer-deletion.json'),JSON.stringify(state,null,2)); await resumed.jobs.shutdown();
  });

  it('keeps a current cancelled draft cancelled when an older ungenerated draft backup is restored', async () => {
    const f = await fixture('backup-draft-cancel',true); const source = await f.add(); const batch = await f.service.preview(f.spec([source.id])); await f.jobs.shutdown(); await mkdir(join(evidenceRoot,'archives'),{recursive:true}); const path = join(evidenceRoot,'archives',`${randomUUID()}.deskpet-backup`); const backups = new ProfileBackupService(f.root,f.vault as SafeStorageVault,'0.1.0'); await backups.create(path,'synthetic-ep4-backup-password'); const cancel = { id: batch.id, operationId: randomUUID() }; await f.service.cancel(cancel); await backups.prepareRestore(path,'synthetic-ep4-backup-password'); await applyPendingProfileRestore(f.root); const vault = new SafeStorageVault(join(f.root,'vault'),syntheticStorage,'darwin'); const fresh = new DomainRepository(f.path,vault); await fresh.initialize(); const resumed = f.makeServices(fresh,vault); await resumed.jobs.initialize(); await vi.waitFor(() => expect(resumed.jobs.active).toBe(false)); const view = await resumed.service.get(batch.id); expect(view.status).toBe('cancelled'); expect(view.jobId).toBeNull(); expect(view.receipts.some((receipt) => receipt.operationId === cancel.operationId && receipt.kind === 'cancel')).toBe(true); await expect(resumed.service.generate({id:batch.id,operationId:randomUUID()})).rejects.toThrow('consolidation.alreadyGenerated'); expect(f.calls).toHaveLength(0); expect(fresh.snapshot().backgroundJobs).toHaveLength(0); await writeFile(join(f.root,'old-draft-backup-current-cancel-preserved.json'),JSON.stringify(fresh.snapshot(),null,2)); await resumed.jobs.shutdown();
  });

  it('restores valid saved candidates without generation or re-enabling an applied selection', async () => {
    const f = await fixture('backup-candidate',true); const batch = await f.ready(); await f.service.apply(f.apply(batch)); await f.jobs.shutdown(); await mkdir(join(evidenceRoot,'archives'),{recursive:true}); const path = join(evidenceRoot,'archives',`${randomUUID()}.deskpet-backup`); const backups = new ProfileBackupService(f.root,f.vault as SafeStorageVault,'0.1.0'); await backups.create(path,'synthetic-ep4-backup-password'); await backups.prepareRestore(path,'synthetic-ep4-backup-password'); await applyPendingProfileRestore(f.root); const vault = new SafeStorageVault(join(f.root,'vault'),syntheticStorage,'darwin'); const fresh = new DomainRepository(f.path,vault); await fresh.initialize(); const resumed = f.makeServices(fresh,vault); await resumed.jobs.initialize(); await vi.waitFor(() => expect(resumed.jobs.active).toBe(false)); const view = await resumed.service.get(batch.id); expect(view.status).toBe('disabled'); expect(view.active).toBe(false); expect(view.candidate).toEqual(batch.candidate); expect(f.calls).toHaveLength(1); expect(fresh.snapshot().consolidationSelections.every((selection) => selection.batchId === null)).toBe(true); await writeFile(join(f.root,'restored-candidate-independent-state.json'),JSON.stringify(fresh.snapshot(),null,2)); await resumed.jobs.shutdown();
  });
});
