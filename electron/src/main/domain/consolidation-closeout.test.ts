// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationBatch, ConsolidationCandidate } from '../../shared/consolidation';
import type { MemoryItem, ProviderConfig } from '../../shared';
import type { SafeStorageVault } from '../security';
import { ProviderService } from '../providers/provider-service';
import { OpenAICompatibleAdapter } from '../providers/openai-compatible';
import { prepareProviderChatRequest } from '../providers/request-budget';
import { BackgroundJobService, backgroundTextRequest } from './background-job-service';
import { ConsolidationService } from './consolidation-service';
import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { backgroundJobSchema } from './schemas';
import type { PersistentState } from './schemas';
import { prepareChatContext } from './chat-context';

const prior = '/private/tmp/deskpet/output/deskpet-electron-ep4-20261029/fidelity/run-2026-10-29T08-00-29.157Z';
const evidenceRoot = '/private/tmp/deskpet/output/deskpet-electron-ep4-summary-closeout-20261029/validation/unit';
const compactTexts = [
  'Luma Orchard: blue north gate opens Thursdays at 09:00 local; closed on public holidays even Thursdays. Check seedling labels before watering. Limit 1.5 litres per seedling per visit, not per day or whole orchard. No apple harvesting; applies only to this orchard.',
  'Mara learning-review only: English default, one conclusion sentence, two reasons, one everyday example. Explain terms plainly before use. Excludes small talk, code-only requests and emergencies. Current explicit language/format takes priority; not Lin or everyone.',
  'Aster lab: Lin corrected deadline on 2026-04-30. Current 2026-05-14 16:30 UTC+08:00; old 2026-05-12 18:00 UTC+08:00 superseded. Amount 250 millilitres, not litres; this correction changed deadline only, not amount.',
  'Cedar Room: green door, exactly eight desks. Niko checks desk labels on Mondays. Sources provide no founding date or ticket price; do not infer free entry. Separate from Orchard, Mara and Aster.',
];
const owned: Array<{ jobs: BackgroundJobService; capture(label: string): Promise<PersistentState> }> = [];
const fixture = async (label: string, providerChange: Partial<ProviderConfig> = {}) => {
  const historical = JSON.parse(await readFile(join(prior, 'summary-persisted.state.json'), 'utf8')) as PersistentState;
  const oldJob = historical.backgroundJobs.find((job) => job.consolidation)!;
  const provider = { ...oldJob.binding.provider, ...providerChange };
  const profile = join(evidenceRoot, `${label}-${randomUUID()}`); await mkdir(profile, { recursive: true });
  const vault = { getVaultKey: async () => Buffer.alloc(32, 62), getSecret: async () => null, hasSecret: async () => false, isAvailable: () => true } as unknown as SafeStorageVault;
  const repo = new DomainRepository(join(profile, 'profile.enc.json'), vault); await repo.initialize();
  await repo.transaction((state) => { state.providers.push(provider); });
  const chat = new ChatService(repo), memory = new MemoryService(repo);
  const session = await chat.createSession('SYNTHETIC_CLOSEOUT_REVIEW', 'normal');
  for (const source of historical.memories) await memory.upsert({ id: source.id, operationId: randomUUID(), expectedRevision: 0, text: source.text, tags: source.tags, privacy: 'local-only', scope: { kind: 'global' } });
  const ids = historical.memories.map((source) => source.id);
  const candidate = (): ConsolidationCandidate => ({ segments: compactTexts.map((text, index) => ({ text, sourceIds: [ids[index]!] })), coveredMemoryIds: ids, uncoveredMemoryIds: [], conflicts: [] });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []; let reply: unknown = candidate();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return new Response(JSON.stringify({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 }, data: [{ id: provider.model }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 12 } });
    return new Response(`data: ${body}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  let jobs: BackgroundJobService;
  const providers = new ProviderService(repo, vault, undefined, { prepared: async (record) => jobs.prepare(record), observed: async (observation) => jobs.observe(observation), beforeDispatch: (id) => jobs.assertDispatch(id) });
  jobs = new BackgroundJobService(repo, providers); const service = new ConsolidationService(repo, providers, jobs);
  const preview = () => service.preview({ operationId: randomUUID(), sessionId: session.id, memoryIds: ids, providerId: provider.id, model: provider.model });
  const generate = async (batch: ConsolidationBatch, value: unknown = candidate()) => { reply = value; await service.generate({ id: batch.id, operationId: randomUUID() }); await vi.waitFor(() => expect(jobs.active).toBe(false), { timeout: 10000 }); return service.get(batch.id); };
  const apply = (batch: ConsolidationBatch) => service.apply({ id: batch.id, operationId: randomUUID(), expectedVersion: batch.candidateVersion, fidelityReviewed: true, enableRepresentation: true });
  const context = () => { const state = repo.snapshot(); return prepareChatContext({ sessionId: session.id, memories: state.memories, history: [], consolidationState: state, query: 'Give current Luma Orchard, Mara, Aster and Cedar source facts.', locale: 'en', binding: { providerId: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, localExecutionConfirmed: true }, requiredMessages: [{ role: 'user', content: 'SYNTHETIC_REQUIRED_QUESTION' }], maxOutputTokens: 1536, contextBudget: { contextWindowTokens: 16384, safetyMarginTokens: 256, capacitySource: 'configured' } }); };
  const capture = async (name: string) => { const fresh = new DomainRepository(join(profile, 'profile.enc.json'), vault); await fresh.initialize(); const state = fresh.snapshot(); await writeFile(join(profile, `${name}.json`), JSON.stringify({ configuration: 'real encrypted repository and production services with synthetic fetch; no utility/GUI/real-model claim', state, calls }, null, 2)); return state; };
  owned.push({ jobs, capture });
  return { profile, repo, memory, chat, session, service, jobs, provider, ids, candidate, calls, preview, generate, apply, context, capture, oldJob };
};
const facts = (items: MemoryItem[]) => items.map((memory) => ({ id: memory.id, text: memory.text, tags: memory.tags, revision: memory.contextMetadata?.revision, sourceReferences: memory.contextMetadata?.sourceReferences, sourceEventIds: memory.contextMetadata?.sourceEventIds }));
afterEach(async () => { for (const item of owned.splice(0)) { await item.jobs.shutdown(); await item.capture('final'); } vi.unstubAllGlobals(); });

// Replays a recorded local evidence run; skipped when that archive is not on this machine.
describe.skipIf(!existsSync(prior))('bounded summary closeout mapping and preserved safety', () => {
  it('freezes only reasoning none for eligible new local Ollama consolidation and changes only that original wire field', async () => {
    const f = await fixture('single-variable'); const preview = await f.preview();
    expect(preview.binding.limits.reasoningEffort).toBe('none'); expect(preview.binding.limits.maxOutputTokens).toBe(1536);
    expect(preview.binding.limits.contextBudget.contextWindowTokens).toBe(16384); expect(f.calls).toHaveLength(0);
    const ready = await f.generate(preview); expect(ready.status).toBe('review'); expect(f.calls).toHaveLength(1);
    const wire = f.calls[0]!.body; expect(wire.reasoning_effort).toBe('none'); expect(wire.max_tokens).toBe(1536); expect(wire.max_completion_tokens).toBeUndefined(); expect(wire.tools).toBeUndefined(); expect(wire.tool_choice).toBe('none');
    const original = JSON.parse(await readFile(join(prior, 'generation-01.json'), 'utf8')) as { body: Record<string, unknown> };
    const { reasoning_effort: reasoning, ...unchanged } = wire; expect(reasoning).toBe('none'); expect(unchanged).toEqual(original.body);
    const state = await f.capture('same-wire-except-reasoning'); expect(state.backgroundJobs[0]?.binding.limits.reasoningEffort).toBe('none'); expect(state.backgroundJobs[0]?.request?.inputEstimate).toBe(preview.budget.inputEstimate);
  });
  it('does not retrofit the optional policy into an existing frozen job or its serialized request', async () => {
    const f = await fixture('legacy'); const parsed = backgroundJobSchema.parse(f.oldJob); expect(parsed.binding.limits.reasoningEffort).toBeUndefined();
    const wire = prepareProviderChatRequest(backgroundTextRequest(parsed)); expect(wire.body).not.toHaveProperty('reasoning_effort'); expect((wire.body as Record<string, unknown>).max_tokens).toBe(1536);
    const historical = JSON.parse(await readFile(join(prior, 'generation-01.json'), 'utf8')) as { body: unknown; requestBodySHA256: string };
    expect(wire.body).toEqual(historical.body); expect(wire.bodySHA256).toBe(historical.requestBodySHA256); await f.capture('legacy-request-byte-identical');
  });
  it('leaves other provider modes and a general text job unchanged', async () => {
    for (const change of [{ supportsTools: true }, { kind: 'lm-studio' as const, supportsTools: false }]) {
      const f = await fixture('other-mode', change); expect((await f.preview()).binding.limits.reasoningEffort).toBeUndefined();
    }
    const f = await fixture('general-job'); const job = await f.jobs.submit({ operationId: randomUUID(), instruction: 'Return fixture text only.', material: 'SYNTHETIC_GENERAL_MATERIAL', privacy: 'local-only', providerId: f.provider.id, model: f.provider.model });
    await vi.waitFor(() => expect(f.jobs.active).toBe(false), { timeout: 10000 }); expect(job.binding.limits.reasoningEffort).toBeUndefined(); expect(f.calls[0]?.body).not.toHaveProperty('reasoning_effort'); await f.capture('general-job-unchanged');
  });
  it('replays the exact old truncated SSE and preserves content, usage and length failure without repairing JSON', async () => {
    const f = await fixture('old-sse'); const old = JSON.parse(await readFile(join(prior, 'generation-01.json'), 'utf8')) as { rawSSE: string; stream: { content: string } };
    const adapter = new OpenAICompatibleAdapter({ config: f.provider, apiKey: null }, async () => new Response(old.rawSSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const request = backgroundTextRequest({ ...f.oldJob, binding: { ...f.oldJob.binding, limits: { ...f.oldJob.binding.limits, reasoningEffort: 'none' } } });
    let content = '', failure = '', finish: string | null = null; let usage: unknown;
    try { for await (const event of adapter.streamChat(request)) { if (event.type === 'text') content += event.text; if (event.type === 'usage') usage = [event.inputTokens, event.outputTokens]; if (event.type === 'request-observation' && event.observation.phase === 'terminal') finish = event.observation.finishReason; } } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    expect(content).toBe(old.stream.content); expect(failure).toBe('provider.truncated'); expect(finish).toBe('length'); expect(usage).toEqual([1016,1536]); expect(() => JSON.parse(content)).toThrow(); expect(content).not.toContain('Cedar Room');
    await writeFile(join(f.profile,'old-sse-replay.json'), JSON.stringify({ content, failure, finish, usage, modelCalls: 0, configuration: 'exact prior SSE replay through production adapter with synthetic fetch' }, null, 2));
  });
  it('accepts a complete fixture with all dependencies and keeps fact evidence unchanged through apply and disable', async () => {
    const f = await fixture('complete-fixture'); const before = facts(f.repo.snapshot().memories); const ready = await f.generate(await f.preview());
    expect(ready.candidate).toEqual(f.candidate()); expect(ready.sources.map((source) => source.id)).toEqual(f.ids); expect(ready.sources.every((source) => source.fingerprint.length === 64 && source.revision === 1 && source.privacy === 'local-only' && source.sourceReferences.length === 1)).toBe(true);
    await f.apply(ready); const prepared = f.context(); expect(prepared.projection.representationReferences).toEqual([{ batchId: ready.id, candidateVersion: 1 }]); expect(JSON.stringify(prepared.messages)).toContain('Reviewed derived memory representation'); expect(JSON.stringify(prepared.messages)).not.toContain(f.repo.snapshot().memories[0]!.text);
    await f.service.disable({ id: ready.id, operationId: randomUUID() }); expect(JSON.stringify(f.context().messages)).toContain(f.repo.snapshot().memories[0]!.text); const state = await f.capture('complete-fixture-applied-disabled'); expect(facts(state.memories)).toEqual(before); expect(state.memoryRevision).toBe(4);
  });
  it('retains current original representation for partial coverage and rejects a foreign source ID', async () => {
    const f = await fixture('partial-invalid'); const partial = f.candidate(); partial.segments = partial.segments.slice(0,3); partial.coveredMemoryIds = f.ids.slice(0,3); partial.uncoveredMemoryIds = f.ids.slice(3);
    const ready = await f.generate(await f.preview(), partial); await f.apply(ready); const prepared = f.context(); expect(prepared.projection.representationReferences).toHaveLength(0); expect(prepared.projection.representationDecisions?.some((decision) => decision.reason === 'partial-coverage')).toBe(true); for (const source of f.repo.snapshot().memories) expect(JSON.stringify(prepared.messages)).toContain(source.text);
    const invalid = f.candidate(); invalid.segments[0]!.sourceIds = [randomUUID()]; const failed = await f.generate(await f.preview(), invalid); expect(failed.status).toBe('failed'); expect(failed.candidate).toBeNull(); expect(failed.invalidReason).toBe('consolidation.invalidCandidate'); expect(f.calls).toHaveLength(2); await f.capture('partial-and-invalid-no-bypass');
  });
  it('still invalidates and redacts complete fixture dependencies when source scope permission changes', async () => {
    const f = await fixture('scope-revocation'); const ready = await f.generate(await f.preview()); await f.apply(ready); const other = await f.chat.createSession('OTHER_SYNTHETIC_SCOPE', 'normal'); const source = f.repo.snapshot().memories[0]!;
    await f.memory.upsert({ id: source.id, operationId: randomUUID(), expectedRevision: source.contextMetadata!.revision, text: source.text, tags: source.tags, privacy: 'local-only', scope: { kind: 'session', sessionId: other.id } });
    const invalid = await f.service.get(ready.id); expect(invalid.status).toBe('invalid'); expect(invalid.active).toBe(false); expect(invalid.candidate).toBeNull(); expect(invalid.sources.every((item) => item.text === '' && item.tags.length === 0)).toBe(true); expect(JSON.stringify(f.context().messages)).not.toContain(source.text); await expect(f.apply(ready)).rejects.toThrow('consolidation.sourceChanged');
    const state = await f.capture('scope-withdrawn-derived-body-purged'); expect(state.backgroundJobs[0]?.result).toBeNull(); expect(state.backgroundJobs[0]?.material).toBe('');
  });
});
