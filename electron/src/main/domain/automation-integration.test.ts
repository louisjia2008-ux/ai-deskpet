// @vitest-environment node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ProviderConfig } from '../../shared';
import type { AutomaticTrigger, AutomationStore, PersistentScheduleInput, ProactiveEnvironment } from '../../shared/automation';
import type { BackgroundJobInput } from '../../shared/background-jobs';
import type { PersistentState } from './schemas';
import type { SafeStorageVault } from '../security/safe-storage-vault';
import { DomainRepository } from './repository';
import { ChatService } from './chat-service';
import { BackgroundJobService } from './background-job-service';
import { AutomaticTaskCoordinator } from './automatic-task-coordinator';
import { PersistentScheduleService } from './persistent-schedule-service';
import { EventProactiveService } from './event-proactive-service';
import { UsageLedger } from './usage-ledger';
import { ProviderService } from '../providers/provider-service';
import { PermissionGate } from '../runtime/permissions';
import { segmentAssistantReply } from '../../renderer/console/reply-segments';

const outputRoot = process.env.DESKPET_AUTOMATION_INTEGRATION_EVIDENCE ?? join(tmpdir(), 'deskpet-automation-integration');
const runRoot = join(outputRoot, `integration-core-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const capability = 'automation.generate';
const startTime = Date.parse('2026-10-30T22:59:00.000Z');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
interface HTTPCall { at: string; body: Record<string, unknown>; bodySHA256: string; credentialPresent: boolean; response: ServerResponse; responded: boolean; respond(text?: string, status?: number): void }
interface Options { now?: number }

const fixtures: Array<{ close(): Promise<void> }> = [];
const fixture = async (label: string, options: Options = {}) => {
  const directory = join(runRoot, `${label}-${randomUUID()}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'profile.enc.json'), key = randomBytes(32), calls: HTTPCall[] = [], gates: Array<() => void> = [];
  const dispatched: Array<{ requestId: string; bodySHA256: string }> = [];
  let clock = options.now ?? startTime, available = true;
  const environment: ProactiveEnvironment = { suspended: false, locked: false, busy: false, visible: true, permission: true };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      const wire = Buffer.concat(chunks);
      const call: HTTPCall = { at: new Date().toISOString(), body: JSON.parse(wire.toString()) as Record<string, unknown>, bodySHA256: sha(wire),
        credentialPresent: typeof request.headers.authorization === 'string', response, responded: false,
        respond(text = 'SYNTHETIC_INTEGRATED_REPLY\n\nWould a short review help?', status = 200) {
          if (call.responded) return; call.responded = true;
          if (response.destroyed) return;
          if (status !== 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'SYNTHETIC_HTTP_FAILURE' } })); return; }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 7, cost: 0.0031, cost_currency: 'USD' } })}\n\ndata: [DONE]\n\n`);
        } };
      response.on('error', () => undefined); calls.push(call);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture.listenerUnavailable');
  const provider: ProviderConfig = { id: randomUUID(), kind: 'lm-studio', name: 'SYNTHETIC_INTEGRATION_HTTP', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'synthetic-core', enabled: true, supportsTools: true, secretState: 'configured', localExecutionConfirmed: true, contextWindowTokens: 8192, maxOutputTokens: 512 };
  // Unit-only vault double. Production AES-GCM/file store is real; OS safeStorage
  // and utility-process coverage belong to the mainline packaged acceptance.
  const vault = { getVaultKey: async () => Buffer.from(key), getSecret: async () => 'FAKE_INTEGRATION_HTTP_KEY', hasSecret: async () => true,
    setSecret: async () => undefined, deleteSecret: async () => undefined, isAvailable: () => true } as unknown as SafeStorageVault;
  const repo = new DomainRepository(path, vault); await repo.initialize();
  await repo.transaction((s) => { s.providers.push(provider); s.providerCredentialRefs[provider.id] = randomUUID(); s.usageBudget = { dailyRequestLimit: 30, dailyTokenLimit: 1_000_000 }; });
  const permissions = new PermissionGate(repo); await permissions.grant(capability, 'always', null, new Date(clock));
  const ledger = new UsageLedger(repo, () => clock), chat = new ChatService(repo), published: ChatMessage[] = [], suppressed: string[] = [];
  let jobs!: BackgroundJobService, coordinator!: AutomaticTaskCoordinator, proactive!: EventProactiveService;
  const providers = new ProviderService(repo, vault, undefined, {
    prepared: async (record) => { await jobs.prepare(record); await ledger.prepare(record); },
    observed: async (observation) => { if (observation.phase === 'fetch-invoked') dispatched.push({ requestId: observation.requestId, bodySHA256: observation.bodySHA256 }); await jobs.observe(observation); await ledger.observe(observation); },
    beforeDispatch: (requestId) => { ledger.assertDispatch(requestId); jobs.assertDispatch(requestId); },
  });
  jobs = new BackgroundJobService(repo, providers, () => coordinator?.changed(), () => available, (job, phase) => coordinator.assertJob(job, phase));
  coordinator = new AutomaticTaskCoordinator(repo, jobs, {
    assertPermission: () => permissions.assertPersistent(capability, new Date(clock)), available: () => available,
    proactiveAdmission: (trigger, phase) => proactive.admission(trigger, phase),
    published: async (message) => { published.push(structuredClone(message)); }, changed: () => undefined,
    suppressMessage: (id) => { suppressed.push(id); chat.suppressMessage(id); },
  });
  const store: AutomationStore = { snapshot: () => repo.snapshot(), transaction: (mutation) => repo.transaction(mutation) };
  const schedules = new PersistentScheduleService(store, coordinator, { now: () => clock });
  proactive = new EventProactiveService(store, coordinator, { now: () => clock, environment: () => environment });
  await jobs.initialize();
  const idle = async (): Promise<void> => { await vi.waitFor(() => expect(jobs.active).toBe(false), { timeout: 6000, interval: 5 }); await coordinator.flush(); await repo.flush(); };
  const arrived = async (count = 1): Promise<HTTPCall> => { await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(count), { timeout: 6000, interval: 5 }); return calls[count - 1]!; };
  const scheduleInput = (): PersistentScheduleInput => ({ id: randomUUID(), title: 'Synthetic persistent schedule', instruction: 'SYNTHETIC_SCHEDULE_ONLY_INSTRUCTION', material: 'SYNTHETIC_SELECTED_MATERIAL',
    privacy: 'local-only', providerId: provider.id, model: provider.model, rule: { kind: 'once', at: new Date(clock + 3_600_000).toISOString() }, timezone: 'UTC', missedPolicy: 'skip', enabled: true });
  const enableProactive = async (): Promise<void> => { await proactive.configure({ enabled: true, eventKinds: ['task-completed', 'explicit-check-in'], quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC', cooldownMinutes: 1, dailyLimit: 3,
    topics: ['synthetic reading'], privacy: 'local-only', providerId: provider.id, model: provider.model }); };
  const offer = async (id = randomUUID()): Promise<AutomaticTrigger> => {
    await proactive.offer({ id, kind: 'task-completed', occurredAt: new Date(clock).toISOString(), summary: 'SYNTHETIC_EXPLICIT_TASK_FINISHED' }); await proactive.tick();
    const trigger = repo.snapshot().automationTriggers.find((t) => t.kind === 'proactive' && t.sourceId === id); if (!trigger) throw new Error('fixture.noProactiveTrigger'); return trigger;
  };
  const ordinaryInput = (operationId = randomUUID()): BackgroundJobInput => ({ operationId, instruction: 'SYNTHETIC_ORDINARY_TASK', material: 'SYNTHETIC_ORDINARY_MATERIAL', privacy: 'local-only', providerId: provider.id, model: provider.model });
  const holdForeground = async () => {
    const binding = await providers.captureBinding(provider.id, provider.model);
    const operation = (async () => { for await (const event of binding.adapter.streamChat({ model: provider.model, messages: [{ role: 'user', content: 'SYNTHETIC_FOREGROUND_HOLDS_SLOT' }] })) void event; })();
    void operation.catch(() => undefined); return { operation, call: await arrived(calls.length + 1) };
  };
  const save = async (name: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await repo.flush(); const fresh = new DomainRepository(path, vault); await fresh.initialize(); const s = fresh.snapshot();
    const bytes = await readFile(path);
    const record = { configuration: 'Production encrypted file/repository, ProviderService, direct OpenAI-compatible adapter and real loopback HTTP; UNIT-ONLY vault/key adapter; no Electron, preload or utility claim',
      clocks: { injectedPolicyAndLedgerUTC: new Date(clock).toISOString(), evidenceWallUTC: new Date().toISOString(), note: 'B/C/ledger use an explicit fixed injected clock; production job lifecycle and HTTP timestamps use wall time.' },
      profile: path, ciphertextSHA256: sha(bytes), ciphertextBytes: bytes.length, encryptionEnvelopeVersion: (JSON.parse(bytes.toString()) as { version: number }).version,
      realModelCalls: 0, observedHTTPCount: calls.length,
      http: calls.map((c, index) => ({ order: index + 1, at: c.at, bodySHA256: c.bodySHA256, hostRequestId: dispatched[index]?.requestId ?? null,
        matchesHostWireDigest: dispatched[index]?.bodySHA256 === c.bodySHA256, credentialPresent: c.credentialPresent, toolsAbsent: !('tools' in c.body), toolChoice: c.body.tool_choice, responded: c.responded })),
      ledger: ledger.snapshot(), triggers: s.automationTriggers, jobs: s.backgroundJobs.map((j) => ({ id: j.id, operationId: j.operationId, automaticTriggerId: j.automaticTriggerId ?? null, requestId: j.attemptId, status: j.status,
        cancelRequestedAt: j.cancelRequestedAt, resultPresent: j.result !== null, completionReason: j.completionReason, wireSHA256: j.request?.bodySHA256 ?? null,
        terminalReceipts: j.receipts.filter((r) => r.kind === 'terminal').length })), publishedIds: published.map((m) => m.id), suppressedIds: suppressed, ...extra };
    await writeFile(join(directory, `${name}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
  };
  const f = { directory, path, provider, vault, repo, permissions, ledger, providers, jobs, coordinator, schedules, proactive, chat, calls, published, suppressed, environment, gates,
    now: () => clock, advance: (ms: number) => { clock += ms; }, arrived, idle, scheduleInput, enableProactive, offer, ordinaryInput, holdForeground, save,
    async close(): Promise<void> {
      for (const release of gates) release(); for (const call of calls) call.respond();
      await proactive.shutdown(); await jobs.shutdown(); await coordinator.flush(); await repo.flush(); available = false;
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); key.fill(0);
      await writeFile(join(directory, 'owned-cleanup.json'), JSON.stringify({ listenerClosed: !server.listening, jobsActive: jobs.active, proactiveActive: proactive.active,
        retainedEncryptedProfile: path, fixtureKeyBufferZeroed: true, realModelCalls: 0, HTTPCount: calls.length,
        scope: 'Only this unit fixture server/services; no Electron or daily App process existed.' }, null, 2));
    },
  };
  fixtures.push(f); return f;
};

afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); }, 15_000);

describe('new automation, usage and publication core integration', () => {
  it('binds real HTTP schedule/proactive receipts to one ledger row each and reads the saved encrypted result', async () => {
    const f = await fixture('receipt-scope');
    const scheduled = await f.schedules.upsert(f.scheduleInput());
    const first = await f.schedules.runNow({ id: scheduled.id, operationId: randomUUID() });
    const scheduleCall = await f.arrived(); scheduleCall.respond('SYNTHETIC_SCHEDULE_RESULT'); await f.idle();
    await f.enableProactive(); const proactive = await f.offer();
    const proactiveCall = await f.arrived(2); proactiveCall.respond('SYNTHETIC_PROACTIVE_RESULT\n\nWould a short review help?'); await f.idle();
    f.coordinator.changed(); f.coordinator.changed(); await f.coordinator.flush();
    const state = f.repo.snapshot();
    expect(f.calls).toHaveLength(2); expect(f.ledger.snapshot().events.map((e) => e.scope).sort()).toEqual(['proactive', 'schedule']);
    for (const job of state.backgroundJobs) {
      const observation = job.request?.observations.at(-1); expect(observation).toBeDefined(); await f.ledger.observe(observation!);
      expect(f.calls.some((call) => call.bodySHA256 === job.request?.bodySHA256)).toBe(true);
    }
    expect(f.ledger.snapshot().events).toHaveLength(2); expect(f.ledger.snapshot().events.every((e) => e.inputTokens === 31 && e.outputTokens === 7 && e.reportedCostUSD === 0.0031)).toBe(true);
    expect(f.coordinator.triggerResult(first.id).result).toBe('SYNTHETIC_SCHEDULE_RESULT');
    expect(f.published).toHaveLength(1); expect(state.chatMessages.filter((m) => m.automationTriggerId === proactive.id)).toHaveLength(1);
    const oneMessage = f.published[0]!; const segments = segmentAssistantReply(oneMessage.id, oneMessage.content);
    expect(segments).toHaveLength(2); expect(segments.every((segment) => segment.id.startsWith(`${oneMessage.id}:segment:`))).toBe(true);
    expect(state.memories).toHaveLength(0); expect(f.ledger.snapshot().events.filter((row) => row.scope === 'proactive')).toHaveLength(1);
    expect(state.automationTriggers.find((t) => t.id === proactive.id)?.publishedAt).not.toBeNull();
    expect(f.chat.listMessages(f.published[0]!.sessionId)).toHaveLength(1);
    expect(f.coordinator.snapshot().jobs.every((job) => job.instruction === '' && job.material === '' && job.result === null)).toBe(true);
    expect((await readFile(f.path, 'utf8'))).not.toContain('SYNTHETIC_PROACTIVE_RESULT');
    expect(f.calls.every((call) => call.body.tool_choice === 'none' && !('tools' in call.body))).toBe(true);
    await f.save('real-http-and-encrypted-readback', { scheduleTriggerId: first.id, proactiveTriggerId: proactive.id });
  }, 12_000);

  it('dispatches with a zero legacy budget and records concurrent requests without daily caps', async () => {
    const f = await fixture('accounting-with-legacy-zero');
    await f.repo.transaction(state => { state.usageBudget = { dailyRequestLimit: 0, dailyTokenLimit: 0 }; });
    const job = await f.jobs.submit(f.ordinaryInput());
    (await f.arrived()).respond('SYNTHETIC_ZERO_LEGACY_BUDGET_COMPLETE'); await f.idle();
    expect(f.repo.snapshot().backgroundJobs.find((j) => j.id === job.id)?.status).toBe('succeeded');
    expect(f.calls).toHaveLength(1); expect(f.ledger.snapshot().events).toHaveLength(1);
    expect(f.ledger.snapshot().events[0]).toMatchObject({ inputTokens: 31, outputTokens: 7, tokenSource: 'provider-reported' });
    const prepared = { bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), providerId: f.provider.id, model: f.provider.model,
      inputEstimate: 100, maxInputTokens: 1000, maxOutputTokens: 100, capacitySource: 'configured' };
    const records = [{ ...prepared, requestId: randomUUID() }, { ...prepared, requestId: randomUUID() }];
    await Promise.all(records.map(record => f.ledger.prepare(record)));
    expect(f.ledger.snapshot().events).toHaveLength(3);
    for (const record of records) expect(() => f.ledger.assertDispatch(record.requestId)).not.toThrow();
    await Promise.all(records.map(record => f.ledger.prepare(record)));
    expect(f.ledger.snapshot().events).toHaveLength(3); expect(f.calls).toHaveLength(1);
    await f.save('legacy-zero-and-concurrent-accounting', { actualHTTPCount: 1, uniqueRecordedRequests: 3 });
  }, 12_000);

  it('continues dispatch when only a legacy daily budget changes after preparation', async () => {
    const f = await fixture('post-prepare-legacy-budget'), entered = deferred(), release = deferred(); f.gates.push(release.resolve);
    const prepare = f.ledger.prepare.bind(f.ledger);
    vi.spyOn(f.ledger, 'prepare').mockImplementation(async (record) => { await prepare(record); entered.resolve(); await release.promise; });
    const job = await f.jobs.submit(f.ordinaryInput()); await entered.promise;
    expect(f.ledger.snapshot().events).toHaveLength(1); expect(f.ledger.snapshot().events[0]?.dispatchedAt).toBeNull(); expect(f.calls).toHaveLength(0);
    await f.repo.transaction(state => { state.usageBudget = { dailyRequestLimit: 0, dailyTokenLimit: 0 }; }); release.resolve();
    (await f.arrived()).respond('SYNTHETIC_ACCOUNTING_CONTINUES'); await f.idle();
    const status = f.repo.snapshot().backgroundJobs.find((j) => j.id === job.id)?.status;
    await f.save('post-prepare-legacy-budget', { actualHTTPCount: f.calls.length, jobStatus: status });
    expect(f.calls).toHaveLength(1); expect(status).toBe('succeeded'); expect(f.ledger.snapshot().events[0]?.dispatchedAt).not.toBeNull();
  }, 12_000);

  it('keeps failed and locally cancelled dispatched attempts in usage after a late controlled server response', async () => {
    const f = await fixture('failed-cancelled'); const failed = await f.jobs.submit(f.ordinaryInput());
    (await f.arrived()).respond('', 500); await f.idle();
    expect(f.repo.snapshot().backgroundJobs.find((j) => j.id === failed.id)?.status).toBe('failed');
    const cancelled = await f.jobs.submit(f.ordinaryInput()); const late = await f.arrived(2);
    await f.jobs.cancel(cancelled.id); late.respond('SYNTHETIC_LATE_MUST_NOT_SUCCEED'); await f.idle();
    const stored = f.repo.snapshot().backgroundJobs.find((j) => j.id === cancelled.id)!;
    expect(stored.status).toBe('cancelled'); expect(stored.result).toBeNull(); expect(stored.receipts.filter((r) => r.status === 'succeeded')).toHaveLength(0);
    expect(f.calls).toHaveLength(2); expect(f.ledger.snapshot().events).toHaveLength(2);
    expect(f.ledger.snapshot().events.every((row) => row.dispatchedAt !== null)).toBe(true);
    expect(f.ledger.snapshot().events.map((row) => row.outcome).sort()).toEqual(['aborted', 'failed']);
    await f.save('failed-cancelled-usage');
  }, 12_000);

  it.each(['cancel-target', 'permission-revoke', 'quiet-transition'] as const)('rechecks %s after queueing and before the actual provider dispatch', async (control) => {
    const f = await fixture(`queued-${control}`); const front = await f.holdForeground();
    await f.enableProactive(); const trigger = await f.offer();
    const job = f.repo.snapshot().backgroundJobs.find((j) => j.operationId === trigger.id)!; expect(job.status).toBe('queued'); expect(f.calls).toHaveLength(1);
    if (control === 'cancel-target') await f.coordinator.cancelTrigger(trigger.id);
    else if (control === 'permission-revoke') await f.permissions.revoke(capability, new Date(f.now()));
    else f.advance(120_000);
    front.call.respond('SYNTHETIC_FOREGROUND_COMPLETE'); await front.operation; await f.idle();
    const saved = f.repo.snapshot().backgroundJobs.find((j) => j.id === job.id)!;
    expect(saved.status).not.toBe('succeeded'); expect(saved.result).toBeNull(); expect(saved.request).toBeNull();
    expect(f.calls).toHaveLength(1); expect(f.published).toHaveLength(0);
    expect(f.ledger.snapshot().events).toHaveLength(1); // Only the held foreground request actually dispatched.
    await f.save('queued-control', { control, targetTriggerId: trigger.id });
  }, 12_000);

  it.each(['quiet-transition', 'permission-revoke', 'cancel-target'] as const)('checks late %s before publishing and keeps dispatched usage visible', async (control) => {
    const f = await fixture(`late-${control}`); await f.enableProactive(); const trigger = await f.offer(); const call = await f.arrived();
    if (control === 'quiet-transition') f.advance(120_000);
    else if (control === 'permission-revoke') await f.permissions.revoke(capability, new Date(f.now()));
    else await f.coordinator.cancelTrigger(trigger.id);
    call.respond('SYNTHETIC_CONTROLLED_LATE_RESULT'); await f.idle();
    const job = f.repo.snapshot().backgroundJobs.find((j) => j.operationId === trigger.id)!;
    expect(job.status).not.toBe('succeeded'); expect(job.result).toBeNull(); expect(f.published).toHaveLength(0); expect(f.repo.snapshot().chatMessages).toHaveLength(0);
    const receipt = f.ledger.snapshot().events[0]!; expect(receipt.scope).toBe('proactive'); expect(receipt.dispatchedAt).not.toBeNull();
    if (control === 'cancel-target') { expect(job.status).toBe('cancelled'); expect(receipt.outcome).toBe('aborted'); }
    else expect(receipt).toMatchObject({ outcome: 'completed', inputTokens: 31, outputTokens: 7, reportedCostUSD: 0.0031 });
    await f.save('late-control-publication', { control });
  }, 12_000);

  it('does not attach or cancel an existing ordinary job when a manual trigger operation collides', async () => {
    const f = await fixture('ordinary-collision'); const specification = f.ordinaryInput(); const ordinary = await f.jobs.submit(specification); const call = await f.arrived();
    const scheduled = await f.schedules.upsert({ ...f.scheduleInput(), instruction: specification.instruction, material: specification.material });
    const trigger = await f.schedules.runNow({ id: scheduled.id, operationId: specification.operationId });
    expect(trigger.jobId).toBeNull(); expect(f.coordinator.getByOperation(trigger.id)).toBeNull();
    await expect(f.coordinator.cancel(ordinary.id)).rejects.toThrow('automation.unavailable');
    await f.coordinator.cancelTrigger(trigger.id); expect(f.repo.snapshot().backgroundJobs.find((j) => j.id === ordinary.id)?.cancelRequestedAt).toBeNull();
    call.respond('SYNTHETIC_ORDINARY_SURVIVES'); await f.idle(); expect(f.repo.snapshot().backgroundJobs.find((j) => j.id === ordinary.id)?.status).toBe('succeeded'); expect(f.calls).toHaveLength(1);
    await f.save('ordinary-operation-collision');
  }, 12_000);

  it('rejects a concurrent automatic/ordinary operation collision at acceptance and keeps ordinary usage scope', async () => {
    const f = await fixture('concurrent-collision'); const operationId = randomUUID(), specification = f.ordinaryInput(operationId);
    const scheduled = await f.schedules.upsert({ ...f.scheduleInput(), instruction: specification.instruction, material: specification.material });
    const trigger: AutomaticTrigger = { id: operationId, key: `schedule-manual:${operationId}`, kind: 'schedule', sourceId: scheduled.id, dueAt: new Date(f.now()).toISOString(), policyRevision: scheduled.revision,
      status: 'reserved', jobId: null, messageId: null, createdAt: new Date(f.now()).toISOString(), updatedAt: new Date(f.now()).toISOString(), cancelledAt: null, errorCode: null };
    await f.repo.transaction((s) => { s.automationTriggers.push(trigger); });
    const entered = deferred(), releaseOrdinary = deferred(), releaseAutomatic = deferred(); f.gates.push(releaseOrdinary.resolve, releaseAutomatic.resolve);
    const capture = f.providers.captureBinding.bind(f.providers); let captures = 0;
    vi.spyOn(f.providers, 'captureBinding').mockImplementation(async (...args) => { const binding = await capture(...args); const n = captures++; if (n === 0) await releaseOrdinary.promise; else if (n === 1) { entered.resolve(); await releaseAutomatic.promise; } return binding; });
    const ordinary = f.jobs.submit(specification); const automatic = f.coordinator.submit(trigger, { instruction: specification.instruction, material: specification.material, privacy: specification.privacy, providerId: specification.providerId, model: specification.model });
    const automaticResult = automatic.then((job) => ({ ok: true as const, job }), (error: unknown) => ({ ok: false as const, error }));
    await entered.promise; releaseOrdinary.resolve(); const accepted = await ordinary; releaseAutomatic.resolve();
    const outcome = await automaticResult; const call = await f.arrived(); call.respond('SYNTHETIC_ORDINARY_CONCURRENT_RESULT'); await f.idle();
    await f.save('concurrent-collision-counterexample', { automaticResolved: outcome.ok, ordinaryJobId: accepted.id, automaticReturnedJobId: outcome.ok ? outcome.job.id : null });
    expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error);
    expect(f.repo.snapshot().backgroundJobs).toHaveLength(1); expect(f.repo.snapshot().backgroundJobs[0]?.automaticTriggerId).toBeUndefined();
    expect(f.ledger.snapshot().events[0]?.scope).toBe('background-job'); expect(f.calls).toHaveLength(1);
  }, 12_000);

  it('hides the staged proactive body in message and session-search reads, then withdraws a post-commit rejected publication', async () => {
    const f = await fixture('publication-visibility'); await f.enableProactive(); const trigger = await f.offer(); const call = await f.arrived();
    const staged = deferred(), release = deferred(); f.gates.push(release.resolve); let held = false;
    const original = f.repo.transaction.bind(f.repo);
    vi.spyOn(f.repo, 'transaction').mockImplementation((<T>(mutation: (state: PersistentState) => T | Promise<T>): Promise<T> => original(mutation).then(async (result) => {
      const t = f.repo.snapshot().automationTriggers.find((v) => v.id === trigger.id);
      if (!held && t?.messageId && t.status === 'succeeded' && t.publishedAt == null) { held = true; staged.resolve(); await release.promise; }
      return result;
    })) as DomainRepository['transaction']);
    call.respond('SYNTHETIC_UNPUBLISHED_BODY_CANARY'); await staged.promise;
    const stage = f.repo.snapshot(), message = stage.chatMessages.find((m) => m.automationTriggerId === trigger.id)!;
    const before = { visibleMessages: f.chat.listMessages(message.sessionId).length, matchingSessionSearch: f.chat.listSessions({ query: 'SYNTHETIC_UNPUBLISHED_BODY_CANARY' }).map((s) => s.id), publishedAt: stage.automationTriggers.find((t) => t.id === trigger.id)?.publishedAt ?? null };
    f.advance(120_000); release.resolve(); await f.idle();
    const state = f.repo.snapshot(), saved = state.chatMessages.find((m) => m.id === message.id)!;
    await f.save('staged-publication-counterexample', { before, after: { visibleMessages: f.chat.listMessages(message.sessionId).length, status: saved.status, bodyCleared: saved.content.length === 0 } });
    expect(before.visibleMessages).toBe(0); expect(before.matchingSessionSearch).toHaveLength(0);
    expect(f.published).toHaveLength(0); expect(f.suppressed).toContain(message.id); expect(saved.status).toBe('cancelled'); expect(saved.content).toBe('');
    expect(state.automationTriggers.find((t) => t.id === trigger.id)).toMatchObject({ status: 'blocked', publishedAt: null }); expect(f.chat.listMessages(message.sessionId)).toHaveLength(0);
  }, 12_000);

  it('keeps a possibly dispatched trigger unknown across fresh repository/services and never sends it again', async () => {
    const f = await fixture('restart-unknown'); const scheduled = await f.schedules.upsert(f.scheduleInput()); const operationId = randomUUID();
    const trigger = await f.schedules.runNow({ id: scheduled.id, operationId }); await f.arrived(); await f.jobs.shutdown(); await f.coordinator.flush();
    expect(f.repo.snapshot().backgroundJobs[0]?.status).toBe('interrupted');
    const fresh = new DomainRepository(f.path, f.vault); await fresh.initialize();
    const freshLedger = new UsageLedger(fresh, f.now); let newJobs!: BackgroundJobService;
    const freshProviders = new ProviderService(fresh, f.vault, undefined, {
      prepared: async (record) => { await newJobs.prepare(record); await freshLedger.prepare(record); },
      observed: async (record) => { await newJobs.observe(record); await freshLedger.observe(record); },
      beforeDispatch: (id) => { freshLedger.assertDispatch(id); newJobs.assertDispatch(id); },
    });
    newJobs = new BackgroundJobService(fresh, freshProviders); await newJobs.initialize();
    const port = { submit: vi.fn(f.coordinator.submit.bind(f.coordinator)), cancel: f.coordinator.cancel.bind(f.coordinator), getByOperation: (id: string) => fresh.snapshot().backgroundJobs.find((j) => j.operationId === id && j.automaticTriggerId === id) ?? null };
    const service = new PersistentScheduleService({ snapshot: () => fresh.snapshot(), transaction: (mutation) => fresh.transaction(mutation) }, port, { now: f.now });
    await service.tick({ startup: true }); const replay = await service.runNow({ id: scheduled.id, operationId });
    expect(replay.id).toBe(trigger.id); expect(replay.status).toBe('unknown'); expect(port.submit).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1);
    await newJobs.shutdown(); await f.save('unknown-no-auto-retry', { freshTriggerStatus: replay.status, freshSubmitCalls: port.submit.mock.calls.length });
  }, 12_000);
});
