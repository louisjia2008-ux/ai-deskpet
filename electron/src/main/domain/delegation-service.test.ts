// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelegationSubmit } from '../../shared/delegations';
import type { ProviderConfig } from '../../shared';
import { SafeStorageVault } from '../security';
import { ProfileBackupService, applyPendingProfileRestore } from '../profile-backup';
import type { ProviderChatRequest } from '../providers/types';
import { ProviderService } from '../providers/provider-service';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import { decryptJson } from '../persistence/encryption';
import type * as AtomicFile from '../persistence/atomic-file';
import { BackgroundJobService } from './background-job-service';
import { ChatService } from './chat-service';
import { DomainRepository } from './repository';
import { persistentStateSchema } from './schemas';

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'after' | 'hold-after', predicate: null as null | ((serialized: string) => boolean), entered: null as null | (() => void), release: null as null | Promise<void> }));
vi.mock('../persistence/atomic-file', async (original) => {
  const actual = await original<typeof AtomicFile>();
  return { ...actual, atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
    const mode = fault.predicate && !fault.predicate(String(args[1])) ? 'none' : fault.mode;
    if (mode !== 'none') { fault.mode = 'none'; fault.predicate = null; }
    if (mode === 'before') throw new Error('fixture.before-rename');
    await actual.atomicWriteFile(...args);
    if (mode === 'after') throw new Error('fixture.after-rename');
    if (mode === 'hold-after') { fault.entered?.(); await fault.release; }
  } };
});
const evidenceRoot = process.env.DESKPET_EP3_UNIT_EVIDENCE_ROOT ?? join(process.cwd(), '../../output/deskpet-electron-ep3-20261028/unitservice');
const key = Buffer.alloc(32, 87);
const first: ProviderConfig = { id: '9b5ca485-3219-43df-a940-cf154ad2ac57', kind: 'lm-studio', name: 'Synthetic child A',
  baseUrl: 'http://127.0.0.1:19972/v1', model: 'ep3-synthetic-a', enabled: true, supportsTools: true,
  localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512, secretState: 'configured' };
const second: ProviderConfig = { ...first, id: '7088e64b-7478-4985-a107-8482f233ce5a', name: 'Synthetic child B', baseUrl: 'http://127.0.0.1:19973/v1', model: 'ep3-synthetic-b' };
type Reply = { body?: string; status?: number; usage?: 'known' | 'unknown' | 'overrun'; tool?: 'modern' | 'legacy'; finishReason?: string };
type Call = { url: string; body: Record<string, unknown>; fakeCredentialPresent: boolean; respond(reply?: Reply): void };
const fixtures: Array<{ service: BackgroundJobService; calls: Call[]; snapshot(): Promise<void> }> = [];
const syntheticStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`SYNTHETIC_EP3_VAULT:${value}`), decryptString: (value: Buffer) => { const text = value.toString(); if (!text.startsWith('SYNTHETIC_EP3_VAULT:')) throw new Error('Wrong synthetic vault'); return text.slice('SYNTHETIC_EP3_VAULT:'.length); } };
const fixture = async (label: string, portable = false) => {
  const root = join(evidenceRoot, 'profiles', `${label}-${randomUUID()}`); await mkdir(root, { recursive: true });
  const path = join(root, 'profile.enc.json');
  const secrets = new Map([[first.id, 'FAKE_EP3_A_CREDENTIAL_ONLY'], [second.id, 'FAKE_EP3_B_CREDENTIAL_ONLY']]);
  const fakeVault = { getVaultKey: async () => Buffer.from(key), getSecret: async (id: string) => secrets.get(id) ?? null,
    setSecret: async (id: string, value: string) => { secrets.set(id, value); }, deleteSecret: async (id: string) => { secrets.delete(id); },
    hasSecret: async (id: string) => secrets.has(id), isAvailable: () => true };
  const vault = portable ? new SafeStorageVault(join(root, 'vault'), syntheticStorage, 'darwin') : fakeVault;
  if (portable) { await vault.setSecret(first.id, 'FAKE_EP3_A_CREDENTIAL_ONLY'); await vault.setSecret(second.id, 'FAKE_EP3_B_CREDENTIAL_ONLY'); }
  const reopen = async () => { const repo = new DomainRepository(path, vault); await repo.initialize(); return repo; };
  const repo = await reopen();
  await repo.transaction((state) => { state.providers.push(first, second); state.providerCredentialRefs[first.id] = randomUUID(); state.providerCredentialRefs[second.id] = randomUUID(); });
  const chat = new ChatService(repo); const parent = await chat.createSession('PARENT_CHAT_UNSELECTED_MARKER', 'normal');
  await chat.addMessage({ sessionId: parent.id, role: 'user', content: 'PARENT_SECRET_NOT_SELECTED', status: 'complete', errorCode: null });
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => new Promise<Response>((resolve) => {
    // A controlled fetch double deliberately ignores abort to exercise late callbacks.
    let answered = false;
    const call: Call = { url: String(url), body: JSON.parse(String(options?.body)) as Record<string, unknown>,
      fakeCredentialPresent: String((options?.headers as Record<string, string> | undefined)?.authorization ?? '').startsWith('Bearer FAKE_EP3_'),
      respond: (reply = {}) => {
        if (answered) return; answered = true;
        if ((reply.status ?? 200) !== 200) { resolve(new Response('{"error":{"code":"synthetic-http-failure"}}', { status: reply.status ?? 500 })); return; }
        const finishReason = reply.finishReason ?? (reply.tool === 'legacy' ? 'function_call' : reply.tool === 'modern' ? 'tool_calls' : 'stop');
        const fn = { name: 'workspace_write', arguments: '{"path":"must-not-exist.txt","content":"UNAUTHORIZED"}' };
        const delta = reply.tool === 'modern' ? { tool_calls: [{ index: 0, id: 'untrusted-label', function: fn }] }
          : reply.tool === 'legacy' ? { function_call: fn } : { content: reply.body ?? 'CHILD_RESULT_DEFAULT' };
        const usage = reply.usage === 'unknown' ? {} : { usage: { prompt_tokens: reply.usage === 'overrun' ? 999999 : 23, completion_tokens: 11 } };
        resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], ...usage })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      } };
    calls.push(call);
  }));
  vi.stubGlobal('fetch', fetcher);
  const makeService = (repository: DomainRepository) => {
    let service: BackgroundJobService;
    const providers = new ProviderService(repository, vault as unknown as SafeStorageVault, undefined, {
      prepared: async (record) => service.prepare(record), observed: async (record) => service.observe(record), beforeDispatch: (id) => service.assertDispatch(id),
    });
    service = new BackgroundJobService(repository, providers);
    return { service, providers };
  };
  const { service, providers } = makeService(repo);
  const spec = async (count = 2): Promise<DelegationSubmit> => {
    const draft = await service.openDelegationDraft({ sessionId: parent.id });
    return { operationId: randomUUID(), sessionId: parent.id, intentVersion: draft.intentVersion, goal: 'EXPLICIT_PARENT_GOAL',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), budget: { maxEstimatedTokens: 50_000, maxRequests: 3 },
      children: Array.from({ length: count }, (_, index) => ({ instruction: `CHILD_INSTRUCTION_${index}`, material: `CHILD_MATERIAL_${index}`,
        privacy: 'local-only', providerId: index % 2 ? second.id : first.id, model: index % 2 ? second.model : first.model, requirements: [] })) };
  };
  const arrived = async (count = 1) => { await vi.waitFor(() => expect(calls).toHaveLength(count)); return calls[count - 1]!; };
  const idle = async () => { await vi.waitFor(() => expect(service.active).toBe(false)); };
  const evidence = async (name: string) => {
    const fresh = await reopen(); const state = fresh.snapshot();
    await writeFile(join(root, `${name}.json`), JSON.stringify({ configuration: 'genuine encrypted repository + real ProviderService/OpenAI adapter; synthetic fetch ignoring abort; fresh repository read in same process', state,
      calls: calls.map(({ url, body, fakeCredentialPresent }) => ({ url, body, fakeCredentialPresent })) }, null, 2));
    return state;
  };
  fixtures.push({ service, calls, snapshot: async () => { await evidence('final-after-test'); } });
  const holdForeground = async () => {
    const binding = await providers.captureBinding(first.id, first.model);
    const request: ProviderChatRequest = { model: first.model, messages: [{ role: 'user', content: 'FOREGROUND_HOLDS_SHARED_CAPACITY' }] };
    const complete = (async () => { for await (const event of binding.adapter.streamChat(request)) void event; })();
    const call = await arrived(); return { call, complete };
  };
  return { root, path, repo, service, providers, parent, chat, vault, calls, spec, arrived, idle, evidence, reopen, makeService, holdForeground };
};
const batchFault = (mode: 'before' | 'after' | 'hold-after', cancelled = false) => {
  fault.mode = mode;
  fault.predicate = (serialized) => decryptJson(JSON.parse(serialized), key, persistentStateSchema).delegationBatches.some((batch) => !cancelled || batch.cancelRequestedAt !== null);
};
afterEach(async () => {
  fault.mode = 'none'; fault.predicate = null; fault.entered = null; fault.release = null; vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    const ending = fixture.service.shutdown(); for (const call of fixture.calls) call.respond(); await ending;
    await fixture.snapshot();
  }
  vi.unstubAllGlobals();
});

describe('durable controlled delegation service', () => {
  it('resolves a following child at approval, rejects a stale preview, and preserves the approved job model', async () => {
    const f = await fixture('follow');
    const input = await f.spec(1);
    input.children[0]!.model = null;
    input.children[0]!.reviewedDefaultModel = first.model;
    await f.providers.setModel(first.id, 'ep3-synthetic-next');
    await expect(f.service.submitDelegation(input)).rejects.toThrow('provider.bindingMismatch');
    expect(f.calls).toHaveLength(0);
    input.children[0]!.reviewedDefaultModel = 'ep3-synthetic-next';
    const batch = await f.service.submitDelegation(input);
    await f.providers.setModel(first.id, 'ep3-synthetic-later');
    const call = await f.arrived();
    expect(call.body.model).toBe('ep3-synthetic-next');
    expect(batch.children[0]?.model).toBe('ep3-synthetic-next');
    expect((await f.service.openDelegationDraft({ sessionId: f.parent.id })).childModelSelections).toEqual([{ providerId: first.id, model: null }]);
    call.respond();
    await f.idle();
  });
  it('opens a host-owned explicit command draft without any child request and does not treat ordinary text as a command', async () => {
    const f = await fixture('draft');
    const draft = await f.service.openDelegationDraft({ sessionId: f.parent.id, command: '委派文本任务：SYNTHETIC_GOAL' });
    expect(draft.goal).toBe('SYNTHETIC_GOAL'); expect(draft.currentBatchId).toBeNull();
    expect((await f.evidence('draft')).backgroundJobs).toHaveLength(0); expect(f.calls).toHaveLength(0);
    await expect(f.service.openDelegationDraft({ sessionId: f.parent.id, command: 'Can you help me?' })).rejects.toThrow();
  });

  it('atomically deduplicates a full batch and rejects changed content under the same operation', async () => {
    const f = await fixture('dedup'); const input = await f.spec();
    const [a, b] = await Promise.all([f.service.submitDelegation(input), f.service.submitDelegation(input)]);
    expect(a.id).toBe(b.id); expect(a.children.map((child) => child.jobId)).toEqual(b.children.map((child) => child.jobId));
    await expect(f.service.submitDelegation({ ...input, goal: 'DIFFERENT_GOAL' })).rejects.toThrow(/operationConflict/u);
    (await f.arrived()).respond({ body: 'A_RESULT' }); (await f.arrived(2)).respond({ body: 'B_RESULT' }); await f.idle();
    const state = await f.evidence('deduplicated'); expect(state.delegationBatches).toHaveLength(1); expect(state.backgroundJobs).toHaveLength(2); expect(f.calls).toHaveLength(2);
    expect((await f.service.submitDelegation(input)).id).toBe(a.id); expect(f.calls).toHaveLength(2);
  });

  it('rejects a fourth child before accepting any partial jobs or making requests', async () => {
    const f = await fixture('fourth'); const input = await f.spec(4);
    await expect(f.service.submitDelegation(input)).rejects.toThrow();
    const state = await f.evidence('fourth-rejected'); expect(state.delegationBatches).toHaveLength(0); expect(state.backgroundJobs).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  it('preserves a historical daily budget failure in the parent summary', async () => {
    const f = await fixture('daily-budget-summary'); const batch = await f.service.submitDelegation(await f.spec(1));
    (await f.arrived()).respond({ body: 'SYNTHETIC_RESULT' }); await f.idle();
    await f.repo.transaction(state => { const job = state.backgroundJobs.find(value => value.id === batch.children[0]!.jobId)!; job.status = 'blocked'; job.result = null; job.completionReason = 'provider.budgetExceeded'; });
    expect((await f.service.listDelegations(f.parent.id))[0]?.children[0]).toMatchObject({ status: 'blocked', completionReason: 'provider.budgetExceeded' });
  });

  it('runs all selected children despite a tiny legacy token allowance', async () => {
    const f = await fixture('legacy-token-allowance'); const input = await f.spec(3); input.budget!.maxEstimatedTokens = 10;
    const batch = await f.service.submitDelegation(input);
    for (let count = 1; count <= 3; count++) (await f.arrived(count)).respond({ body: `CHILD_${count}_FINISHED` });
    await f.idle();
    const state = await f.evidence('legacy-token-allowance');
    expect(state.delegationBatches).toHaveLength(1); expect(state.backgroundJobs).toHaveLength(3); expect(f.calls).toHaveLength(3);
    expect((await f.service.listDelegations(f.parent.id))[0]?.status).toBe('completed');
    expect((await f.service.submitDelegation(input)).id).toBe(batch.id); expect(f.calls).toHaveLength(3);
  });

  it('derives the request count from selected children and ignores old saved request allowances at dispatch', async () => {
    const f = await fixture('legacy-request-allowance'); const input = await f.spec(2); input.budget!.maxRequests = 1;
    const batch = await f.service.submitDelegation(input); expect(batch.budget.maxRequests).toBe(2);
    const firstCall = await f.arrived();
    await f.repo.transaction(state => { const saved = state.delegationBatches[0]!; saved.budget.maxRequests = 1; saved.budget.maxEstimatedTokens = 1; });
    firstCall.respond({ body: 'FIRST_FINISHED' }); (await f.arrived(2)).respond({ body: 'SECOND_FINISHED' }); await f.idle();
    const state = await f.evidence('legacy-request-allowance'); expect(state.backgroundJobs.every(job => job.status === 'succeeded')).toBe(true); expect(f.calls).toHaveLength(2);
  });

  it('accepts a budget-free submission and preserves its exact operation replay across a fresh encrypted read', async () => {
    const f = await fixture('no-token-budget'); const input = await f.spec(1); delete input.budget;
    const batch = await f.service.submitDelegation(input); expect(batch.budget).toMatchObject({ maxEstimatedTokens: 0, maxRequests: 1 });
    (await f.arrived()).respond({ body: 'RECORDED_WITHOUT_ALLOWANCE' }); await f.idle();
    const fresh = await f.reopen(); const service = f.makeService(fresh).service;
    expect((await service.submitDelegation(input)).id).toBe(batch.id); expect(f.calls).toHaveLength(1);
    expect(fresh.snapshot().delegationBatches[0]?.children[0]?.reservation).toMatchObject({ state: 'settled', chargedTokens: 34, reportedTokens: 34 });
    await service.shutdown();
  });

  it('keeps child input, frozen model, independent sessions and durable results separate from siblings and foreground writes', async () => {
    const f = await fixture('isolation'); const input = await f.spec(); const batch = await f.service.submitDelegation(input);
    const a = await f.arrived(); await f.providers.setModel(first.id, 'FOREGROUND_NEW_MODEL');
    await f.chat.addMessage({ sessionId: f.parent.id, role: 'assistant', content: 'FOREGROUND_RESULT_SURVIVES', status: 'complete', errorCode: null });
    a.respond({ body: 'CHILD_RESULT_A' }); const b = await f.arrived(2); b.respond({ body: 'CHILD_RESULT_B' }); await f.idle();
    expect(a.body).toMatchObject({ model: first.model, tool_choice: 'none' }); expect(a.body).not.toHaveProperty('tools');
    expect(b.body).toMatchObject({ model: second.model, tool_choice: 'none' });
    expect(JSON.stringify(a.body)).toContain('CHILD_MATERIAL_0'); expect(JSON.stringify(a.body)).not.toContain('CHILD_MATERIAL_1');
    expect(JSON.stringify(b.body)).toContain('CHILD_MATERIAL_1'); expect(JSON.stringify(b.body)).not.toContain('CHILD_MATERIAL_0');
    for (const call of [a, b]) { expect(JSON.stringify(call.body)).not.toContain('PARENT_SECRET'); expect(JSON.stringify(call.body)).not.toContain('FOREGROUND_RESULT'); expect(JSON.stringify(call.body)).not.toContain('FAKE_EP3'); }
    expect(new Set(batch.children.map((child) => child.sessionId)).size).toBe(2); expect(batch.children.every((child) => child.sessionId !== f.parent.id)).toBe(true);
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id })).result).toBe('CHILD_RESULT_A');
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[1]!.id })).result).toBe('CHILD_RESULT_B');
    const state = await f.evidence('isolated'); expect(state.chatMessages.some((message) => message.content === 'FOREGROUND_RESULT_SURVIVES')).toBe(true);
    expect(state.backgroundJobs.every((job) => job.binding.model !== 'FOREGROUND_NEW_MODEL')).toBe(true);
    expect((await f.service.listDelegations(f.parent.id))[0]).toMatchObject({ intentVersion: batch.intentVersion, status: 'completed' });
  });

  it('parent cancellation retains an earlier success, blocks a late running result and never sends the queued third child', async () => {
    const f = await fixture('parent-cancel'); const batch = await f.service.submitDelegation(await f.spec(3));
    (await f.arrived()).respond({ body: 'COMPLETED_BEFORE_CANCEL' }); const held = await f.arrived(2);
    await f.service.cancelDelegation(batch.id); held.respond({ body: 'LATE_AFTER_PARENT_CANCEL' }); await f.idle();
    const result = (await f.service.listDelegations(f.parent.id))[0]!; expect(result.status).toBe('cancelled');
    expect(result.children.map((child) => child.status)).toEqual(['succeeded', 'cancelled', 'cancelled']); expect(f.calls).toHaveLength(2);
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id })).result).toBe('COMPLETED_BEFORE_CANCEL');
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[1]!.id })).result).toBeNull();
    const state = await f.evidence('parent-cancel'); expect(state.backgroundJobs[2]?.request).toBeNull();
    expect(result.children[2]?.reservation.state).toBe('released'); expect(result.children).toHaveLength(3);
  });

  it('cancels one child without cancelling its sibling or parent goal', async () => {
    const f = await fixture('child-cancel'); const batch = await f.service.submitDelegation(await f.spec()); const held = await f.arrived();
    await f.service.cancelDelegationChild({ batchId: batch.id, childId: batch.children[0]!.id }); held.respond({ body: 'LATE_CANCELLED_CHILD' });
    (await f.arrived(2)).respond({ body: 'SIBLING_SURVIVES' }); await f.idle();
    const view = (await f.service.listDelegations(f.parent.id))[0]!; expect(view.children.map((child) => child.status)).toEqual(['cancelled', 'succeeded']); expect(view.status).toBe('partial');
    expect(view.cancelRequestedAt).toBeNull(); await f.evidence('child-cancel');
  });

  it('changes intention only through explicit replacement, keeps old results historical and creates no automatic new jobs', async () => {
    const f = await fixture('replace'); const originalInput = await f.spec(); const batch = await f.service.submitDelegation(originalInput);
    (await f.arrived()).respond({ body: 'HISTORICAL_RESULT' }); const held = await f.arrived(2);
    await f.chat.addMessage({ sessionId: f.parent.id, role: 'user', content: 'An ordinary follow-up does not replace the goal.', status: 'complete', errorCode: null });
    expect((await f.service.listDelegations(f.parent.id))[0]?.intentVersion).toBe(batch.intentVersion);
    const replacement = { batchId: batch.id, operationId: randomUUID(), goal: 'EXPLICIT_NEW_GOAL' };
    const draft = await f.service.replaceDelegation(replacement); held.respond({ body: 'LATE_OLD_GOAL' }); await f.idle();
    expect(draft.intentVersion).toBeGreaterThan(batch.intentVersion); expect(draft.goal).toBe('EXPLICIT_NEW_GOAL'); expect(draft.currentBatchId).toBeNull();
    expect((await f.service.replaceDelegation(replacement)).intentVersion).toBe(draft.intentVersion);
    await expect(f.service.submitDelegation({ ...originalInput, operationId: randomUUID() })).rejects.toThrow('delegation.staleIntent');
    const history = (await f.service.listDelegations(f.parent.id))[0]!; expect(history.status).toBe('historical');
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id }))).toMatchObject({ historical: true, result: 'HISTORICAL_RESULT' });
    const state = await f.evidence('replacement-draft-only'); expect(state.delegationBatches).toHaveLength(1); expect(state.backgroundJobs).toHaveLength(2); expect(f.calls).toHaveLength(2);
  });

  it('isolates an ordinary HTTP failure and keeps unknown usage reserved while another child succeeds', async () => {
    const f = await fixture('http-failure'); const batch = await f.service.submitDelegation(await f.spec());
    (await f.arrived()).respond({ status: 500 }); (await f.arrived(2)).respond({ body: 'INDEPENDENT_SUCCESS' }); await f.idle();
    const view = (await f.service.listDelegations(f.parent.id))[0]!; expect(view.status).toBe('partial'); expect(view.children.map((child) => child.status)).toEqual(['failed', 'succeeded']);
    expect(view.children[0]?.reservation.state).toBe('unknown'); expect(view.children[0]?.reservation.reportedTokens).toBeNull();
    expect(view.budget.outstandingTokens).toBeGreaterThanOrEqual(view.children[0]!.reservation.reservedTokens);
    expect(view.budget.settledTokens + view.budget.outstandingTokens).toBeLessThanOrEqual(view.budget.maxEstimatedTokens);
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[1]!.id })).result).toBe('INDEPENDENT_SUCCESS'); await f.evidence('http-failure');
  });

  it('keeps exact, word-count and unsupported requirements separate from execution and unverified facts without list-body leakage', async () => {
    const f = await fixture('checks'); const input = await f.spec(1); const body = 'A fictional garden with blue flowers, an oak tree, two round ponds, and a quiet walking path.';
    input.children[0]!.requirements = [{ id: randomUUID(), kind: 'exact-text', expected: body }, { id: randomUUID(), kind: 'english-word-count', min: 200, max: 220 }, { id: randomUUID(), kind: 'unimplemented', description: 'Verify every factual claim independently.' }];
    const batch = await f.service.submitDelegation(input); (await f.arrived()).respond({ body }); await f.idle();
    const view = (await f.service.listDelegations(f.parent.id))[0]!; const summary = view.children[0]!;
    expect(summary.status).toBe('succeeded'); expect(summary.checks.map((check) => check.status)).toEqual(['passed', 'failed', 'unchecked']); expect(summary.factVerification).toBe('unverified');
    expect(JSON.stringify(summary)).not.toContain(body); expect(summary.checks.every((check) => !('actualWordCount' in check))).toBe(true);
    const result = await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id }); expect(result.result).toBe(body); expect(result.checks[1]).toMatchObject({ status: 'failed', actualWordCount: 17 }); expect(result.factVerification).toBe('unverified'); await f.evidence('independent-check-states');
  });

  it('does not leak result text through a provider-controlled finish reason before explicit result viewing', async () => {
    const f = await fixture('reason-output-leak'); const batch = await f.service.submitDelegation(await f.spec(1)); const body = 'HIDDEN_PROVIDER_REASON_BODY_CANARY';
    (await f.arrived()).respond({ body, finishReason: body }); await f.idle();
    const list = await f.service.listDelegations(f.parent.id); expect(JSON.stringify(list)).not.toContain(body);
    const explicit = await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id });
    expect(explicit.result).toBe(body); expect(explicit.finishReason).toBe(body); await f.evidence('reason-output-leak');
  });

  it.each(['modern', 'legacy'] as const)('rejects %s tool protocol while preserving the actual finish reason and no extra attempt', async (tool) => {
    const f = await fixture(`protocol-${tool}`); const batch = await f.service.submitDelegation(await f.spec(1)); (await f.arrived()).respond({ tool }); await f.idle();
    const result = await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id });
    expect(result.status).toBe('failed'); expect(result.completionReason).toBe('job.toolsForbidden'); expect(result.finishReason).toBe(tool === 'modern' ? 'tool_calls' : 'function_call'); expect(result.result).toBeNull();
    const state = await f.evidence(`protocol-${tool}`); expect(state.sideEffects).toHaveLength(0); expect(f.calls).toHaveLength(1); expect(state.backgroundJobs).toHaveLength(1);
  });

  it.each(['empty', 'truncated'] as const)('does not publish %s output as successful execution and retains the original finish reason', async (variant) => {
    const f = await fixture(`output-${variant}`); const batch = await f.service.submitDelegation(await f.spec(1));
    (await f.arrived()).respond({ body: variant === 'empty' ? '' : 'PARTIAL_OUTPUT', finishReason: variant === 'empty' ? 'stop' : 'length' }); await f.idle();
    const result = await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id });
    expect(result.status).toBe('failed'); expect(result.result).toBeNull();
    expect(result.completionReason).toBe(variant === 'empty' ? 'job.emptyOutput' : 'provider.truncated');
    expect(result.finishReason).toBe(variant === 'empty' ? 'stop' : 'length'); expect(f.calls).toHaveLength(1); await f.evidence(`output-${variant}`);
  });

  it('records reported use above its estimate and continues the independently selected sibling', async () => {
    const f = await fixture('usage-above-estimate'); const batch = await f.service.submitDelegation(await f.spec());
    (await f.arrived()).respond({ body: 'EXECUTION_FINISHED_WITH_LARGE_USAGE', usage: 'overrun' });
    (await f.arrived(2)).respond({ body: 'SIBLING_FINISHED' }); await f.idle();
    const view = (await f.service.listDelegations(f.parent.id))[0]!;
    expect(view.children[0]?.reservation.state).toBe('settled'); expect(view.children[0]!.reservation.reportedTokens).toBeGreaterThan(view.children[0]!.reservation.reservedTokens);
    expect(view.children[0]!.reservation.chargedTokens).toBe(1000010);
    expect(view.children[1]?.status).toBe('succeeded'); expect(view.status).toBe('completed'); expect(f.calls).toHaveLength(2);
    const state = await f.evidence('usage-above-estimate'); expect(state.backgroundJobs.find((job) => job.id === batch.children[1]!.jobId)?.request).not.toBeNull();
    expect(view.budget.settledTokens).toBe(1000044); expect(view.budget.releasedTokens).toBeGreaterThanOrEqual(0);
  });

  it('keeps a parent cancellation authoritative when its acknowledgement and authority read are unavailable', async () => {
    const f = await fixture('parent-cancel-unknown'); const batch = await f.service.submitDelegation(await f.spec(3)); const held = await f.arrived();
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable')); batchFault('after', true);
    await expect(f.service.cancelDelegation(batch.id)).rejects.toThrow('repository.commitUncertain');
    await expect(f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id })).rejects.toThrow('repository.commitUncertain');
    held.respond({ body: 'LATE_AFTER_UNKNOWN_PARENT_CANCEL' }); await f.idle(); authority.mockRestore();
    const state = await f.evidence('parent-cancel-unknown'); expect(state.delegationBatches[0]?.cancelRequestedAt).toBeTruthy();
    expect(state.backgroundJobs.every((job) => job.status === 'cancelled' && job.result === null)).toBe(true); expect(f.calls).toHaveLength(1);
    const view = (await f.service.listDelegations(f.parent.id))[0]!; expect(view.status).toBe('cancelled'); expect(view.children[0]?.reservation.state).toBe('unknown');
  });

  it('rejects foreign session, forged authority fields and mismatched parent-child resource lookups', async () => {
    const f = await fixture('ownership'); await expect(f.service.openDelegationDraft({ sessionId: randomUUID() })).rejects.toThrow();
    const input = await f.spec(1); await expect(f.service.submitDelegation({ ...input, owner: 'forged' } as DelegationSubmit)).rejects.toThrow();
    const batch = await f.service.submitDelegation(input); const held = await f.arrived();
    await expect(f.service.delegationResult({ batchId: batch.id, childId: randomUUID() })).rejects.toThrow();
    await expect(f.service.cancelDelegationChild({ batchId: randomUUID(), childId: batch.children[0]!.id })).rejects.toThrow();
    held.respond(); await f.idle(); await f.evidence('ownership');
  });

  it('requires the parent-child entry even when a caller knows a child job id or its operation receipt', async () => {
    const f = await fixture('generic-child-replay'); const input = await f.spec(1);
    input.children[0]!.requirements = [{ id: randomUUID(), kind: 'unimplemented', description: 'A confirmed natural-language requirement.' }];
    const batch = await f.service.submitDelegation(input); (await f.arrived()).respond({ body: 'EXPLICIT_CHILD_ONLY_RESULT' }); await f.idle();
    const job = f.repo.snapshot().backgroundJobs.find((item) => item.id === batch.children[0]!.jobId)!;
    expect(await f.service.list()).toHaveLength(0);
    await expect(f.service.get(job.id)).rejects.toThrow('delegation.useChildEntry');
    await expect(f.service.cancel(job.id)).rejects.toThrow('delegation.useChildEntry');
    await expect(f.service.submit({ operationId: job.operationId, instruction: job.instruction, material: job.material,
      privacy: job.source.privacy, providerId: job.binding.provider.id, model: job.binding.model })).rejects.toThrow('delegation.useChildEntry');
    expect((await f.service.delegationResult({ batchId: batch.id, childId: batch.children[0]!.id })).result).toBe('EXPLICIT_CHILD_ONLY_RESULT');
    expect(f.calls).toHaveLength(1); await f.evidence('generic-child-replay');
  });

  it('checks the frozen parent deadline after shared-capacity wait and sends no expired child', async () => {
    const f = await fixture('deadline'); const front = await f.holdForeground(); const input = await f.spec(); input.deadlineAt = new Date(Date.now() + 1000).toISOString();
    const batch = await f.service.submitDelegation(input);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Date.parse(input.deadlineAt) - Date.now() + 5)));
    front.call.respond({ body: 'FOREGROUND_FINISHES_AFTER_PARENT_DEADLINE' }); await front.complete; await f.idle();
    const view = (await f.service.listDelegations(f.parent.id))[0]!; expect(view.status).toBe('expired'); expect(view.children.every((child) => child.status !== 'succeeded')).toBe(true); expect(f.calls).toHaveLength(1);
    const state = await f.evidence('expired-before-dispatch'); expect(state.backgroundJobs.every((job) => job.request === null)).toBe(true); expect(view.id).toBe(batch.id);
  });

  it('publishes parent and child acceptance atomically and pauses an uncertain commit before any request', async () => {
    const f = await fixture('commit-unknown'); const input = await f.spec();
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable')); batchFault('after');
    await expect(f.service.submitDelegation(input)).rejects.toThrow('repository.commitUncertain'); expect(f.calls).toHaveLength(0);
    await expect(f.service.listDelegations(f.parent.id)).rejects.toThrow('repository.commitUncertain'); authority.mockRestore();
    const committed = await f.evidence('acceptance-authority'); expect(committed.delegationBatches).toHaveLength(1); expect(committed.backgroundJobs).toHaveLength(2);
    const batch = await f.service.submitDelegation(input); (await f.arrived()).respond({ body: 'RECOVERED_A' }); (await f.arrived(2)).respond({ body: 'RECOVERED_B' }); await f.idle();
    expect(batch.children).toHaveLength(2); expect((await f.evidence('acceptance-reused')).delegationBatches).toHaveLength(1); expect(f.calls).toHaveLength(2);
  });

  it('does not leave a partial batch after a pre-publication write failure', async () => {
    const f = await fixture('before-write'); const input = await f.spec(3); batchFault('before');
    await expect(f.service.submitDelegation(input)).rejects.toThrow('fixture.before-rename');
    const state = await f.evidence('before-write'); expect(state.delegationBatches).toHaveLength(0); expect(state.backgroundJobs).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  it('does not dispatch a prepared child after parent cancellation is durable but its repository acknowledgement is delayed', async () => {
    const f = await fixture('cancel-durable-before-ack');
    let enteredSecret!: () => void; const secretEntered = new Promise<void>((resolve) => { enteredSecret = resolve; });
    let releaseSecret!: () => void; const secretReleased = new Promise<void>((resolve) => { releaseSecret = resolve; });
    const originalSecret = f.vault.getSecret.bind(f.vault); let secretHeld = false;
    vi.spyOn(f.vault, 'getSecret').mockImplementation(async (id) => {
      const value = await originalSecret(id);
      if (!secretHeld && f.repo.snapshot().backgroundJobs.some((job) => job.status === 'dispatching')) {
        secretHeld = true; enteredSecret(); await secretReleased;
      }
      return value;
    });
    const batch = await f.service.submitDelegation(await f.spec(1)); await secretEntered;
    expect(f.calls).toHaveLength(0);
    let cancelWritten!: () => void; const written = new Promise<void>((resolve) => { cancelWritten = resolve; });
    let releaseCancel!: () => void; const acknowledgement = new Promise<void>((resolve) => { releaseCancel = resolve; });
    fault.entered = cancelWritten; fault.release = acknowledgement; batchFault('hold-after', true);
    const cancel = f.service.cancelDelegation(batch.id); await written;
    try {
      const durable = await f.evidence('cancel-durable-before-final-dispatch');
      expect(durable.delegationBatches[0]?.cancelRequestedAt).toBeTruthy();
      expect(durable.backgroundJobs[0]?.status).toBe('cancelled');
      // Unblock the prepared provider path while cancellation confirmation is
      // still held. An event-loop barrier drains ready Promise continuations;
      // this is controlled ordering, not a random timing sleep.
      releaseSecret(); await new Promise<void>((resolve) => setImmediate(resolve));
      await f.evidence('after-prepared-path-released');
      expect(f.calls).toHaveLength(0);
    } finally {
      releaseSecret(); releaseCancel(); await cancel;
      for (const call of f.calls) call.respond({ body: 'LATE_AFTER_DURABLE_PARENT_CANCEL' }); await f.idle();
    }
  });

  it('restores an old queued parent archive as invalid historical state without rebuilding or dispatching children', async () => {
    const f = await fixture('backup-parent', true); const front = await f.holdForeground();
    const batch = await f.service.submitDelegation(await f.spec());
    await mkdir(join(evidenceRoot, 'archives'), { recursive: true });
    const backup = join(evidenceRoot, 'archives', `${randomUUID()}.deskpet-backup`); const password = 'synthetic-ep3-backup-password';
    const backups = new ProfileBackupService(f.root, f.vault as SafeStorageVault, '0.1.0');
    // Direct backup service is used to create a synthetic old queued snapshot;
    // the normal product separately prevents backup maintenance during work.
    await backups.create(backup, password); await f.evidence('queued-before-backup');
    await f.service.cancelDelegation(batch.id); await f.service.shutdown(); front.call.respond(); await front.complete;
    await f.evidence('newer-current-parent-cancelled');
    await backups.prepareRestore(backup, password); await applyPendingProfileRestore(f.root);
    const vault = new SafeStorageVault(join(f.root, 'vault'), syntheticStorage, 'darwin');
    const fresh = new DomainRepository(f.path, vault); await fresh.initialize();
    let resumed: BackgroundJobService;
    const providers = new ProviderService(fresh, vault, undefined, { prepared: async (record) => resumed.prepare(record), observed: async (record) => resumed.observe(record), beforeDispatch: (id) => resumed.assertDispatch(id) });
    resumed = new BackgroundJobService(fresh, providers); fixtures.push({ service: resumed, calls: f.calls, snapshot: async () => { await f.evidence('restored-parent-final'); } });
    await resumed.initialize(); await vi.waitFor(() => expect(resumed.active).toBe(false));
    const restored = fresh.snapshot();
    expect(restored.delegationBatches).toHaveLength(1); expect(restored.delegationBatches[0]?.invalidatedReason).toBe('delegation.restoredUnknown');
    expect(restored.backgroundJobs).toHaveLength(2); expect(restored.backgroundJobs.every((job) => job.status === 'interrupted' && job.result === null)).toBe(true);
    const view = (await resumed.listDelegations(f.parent.id))[0]!; expect(view.status).toBe('historical'); expect(f.calls).toHaveLength(1);
    expect(view.children.every((child) => child.reservation.state === 'unknown')).toBe(true);
    await writeFile(join(f.root, 'restored-parent-independent-state.json'), JSON.stringify(restored, null, 2));
  });

  it('reopens a parent-cancelled profile without resending queued or possibly-sent children', async () => {
    const f = await fixture('restart-cancelled'); const batch = await f.service.submitDelegation(await f.spec(3)); const call = await f.arrived();
    await f.service.cancelDelegation(batch.id); call.respond({ body: 'LATE_BEFORE_RESTART' }); await f.idle(); await f.service.shutdown();
    const fresh = await f.reopen(); const resumed = f.makeService(fresh); fixtures.push({ service: resumed.service, calls: f.calls, snapshot: async () => { await f.evidence('after-resumed-service'); } });
    await resumed.service.initialize(); await vi.waitFor(() => expect(resumed.service.active).toBe(false));
    const view = (await resumed.service.listDelegations(f.parent.id))[0]!; expect(view.status).toBe('cancelled'); expect(view.children.every((child) => child.status === 'cancelled')).toBe(true); expect(f.calls).toHaveLength(1);
    const state = await f.evidence('restart-parent-cancelled'); expect(state.backgroundJobs.slice(1).every((job) => job.request === null)).toBe(true);
  });
});
