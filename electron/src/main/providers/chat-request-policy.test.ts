import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextTrace, ProviderConfig } from '../../shared';
import { DomainRepository } from '../domain/repository';
import type { SafeStorageVault } from '../security';
import type { ProviderUtilityClient } from './utility-client';
import type { ProviderAdapter, ProviderChatRequest } from './types';
import { ProviderService } from './provider-service';
import type { ProviderDispatchHooks } from './provider-service';
import { chatRequestLimits, mergeTurnContextTrace } from './chat-request-policy';
import { UsageLedger } from '../domain/usage-ledger';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const setup = async (getSecret: () => Promise<string | null> = async () => null) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-binding-snapshot-')); roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 37) });
  await repository.initialize();
  const config: ProviderConfig = { id: randomUUID(), kind: 'ollama', name: 'Synthetic binding', baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'alpha', enabled: true, supportsTools: false, secretState: 'missing', localExecutionConfirmed: true, contextWindowTokens: 8192 };
  await repository.transaction((state) => { state.providers.push(config); });
  const sent: ProviderChatRequest[] = [];
  const adapter: ProviderAdapter = {
    async *streamChat(request) { sent.push(request); yield { type: 'text', text: 'Synthetic response' }; yield { type: 'done', finishReason: 'stop' }; },
    listModels: async () => [],
    inspectModel: async () => ({ contextWindowTokens: 262_144, executionDestination: 'unknown', source: 'ollama-show' }),
  };
  const service = new ProviderService(repository, { getSecret } as unknown as SafeStorageVault, { adapter: () => adapter } as unknown as ProviderUtilityClient);
  return { repository, config, service, sent, adapter };
};

describe('default output allowance', () => {
  const binding = (provider: Partial<ProviderConfig>) => ({ provider: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', ...provider }, inspection: { contextWindowTokens: null }, model: 'alpha' }) as unknown as Parameters<typeof chatRequestLimits>[0];
  it.each([[undefined, 4096], [131_072, 4096], [16_384, 4096], [8192, 2048], [4096, 1024], [1024, 512]])('uses a window-sized default for window %s', (contextWindowTokens, expected) => {
    expect(chatRequestLimits(binding(contextWindowTokens === undefined ? {} : { contextWindowTokens })).maxOutputTokens).toBe(expected);
  });
  it('keeps an explicit limit, including one above the default', () => {
    expect(chatRequestLimits(binding({ maxOutputTokens: 256 })).maxOutputTokens).toBe(256);
    expect(chatRequestLimits(binding({ maxOutputTokens: 32_768 })).maxOutputTokens).toBe(32_768);
  });
});

describe('captured production provider policy', () => {
  it('keeps the sent model selection while the default changes during credential resolution', async () => {
    let resolveKey!: (value: null) => void;
    const key = new Promise<null>((resolve) => { resolveKey = resolve; });
    const f = await setup(() => key);
    const pending = f.service.captureBinding(f.config.id, 'alpha');
    await f.repository.transaction((state) => { state.providers[0]!.model = 'beta'; });
    resolveKey(null);
    const binding = await pending;
    expect(binding.model).toBe('alpha');
    const request: ProviderChatRequest = { model: 'alpha', messages: [{ role: 'user', content: 'Synthetic question' }],
      ...chatRequestLimits(binding), identity: { requestId: randomUUID(), bindingDigest: binding.bindingDigest } };
    for await (const _event of binding.adapter.streamChat(request)) void _event;
    expect(f.sent).toHaveLength(1); expect(f.sent[0]?.model).toBe('alpha');
    expect(f.repository.snapshot().providers[0]?.model).toBe('beta');
  });

  it.each(['endpoint', 'declaration', 'disabled'] as const)('rejects a revoked %s before posting the captured request', async (change) => {
    const f = await setup(); const binding = await f.service.captureBinding(f.config.id, 'alpha');
    await f.repository.transaction((state) => {
      if (change === 'endpoint') state.providers[0]!.baseUrl = 'http://127.0.0.1:9999/v1';
      if (change === 'declaration') state.providers[0]!.localExecutionConfirmed = false;
      if (change === 'disabled') state.providers[0]!.enabled = false;
    });
    const run = async () => { for await (const event of binding.adapter.streamChat({ model: 'alpha', messages: [{ role: 'user', content: 'Private synthetic input' }],
      ...chatRequestLimits(binding), identity: { requestId: randomUUID(), bindingDigest: binding.bindingDigest } })) void event; };
    await expect(run()).rejects.toThrow('provider.bindingMismatch'); expect(f.sent).toEqual([]);
  });

  it('keeps unknown allocation distinct from a confirmed limit and respects metadata ceilings', async () => {
    const f = await setup(); const binding = await f.service.captureBinding(f.config.id);
    expect(chatRequestLimits(binding).contextBudget.contextWindowTokens).toBe(8192);
    const missingConfiguration = { ...binding, provider: { ...binding.provider } }; delete missingConfiguration.provider.contextWindowTokens;
    expect(chatRequestLimits(missingConfiguration).contextBudget).toMatchObject({ contextWindowTokens: 131072, capacitySource: 'application-limit' });
    expect(chatRequestLimits({ ...missingConfiguration, inspection: { ...binding.inspection, contextWindowTokens: 16384 } }).contextBudget).toMatchObject({ contextWindowTokens: 16384, capacitySource: 'application-limit' });
    expect(chatRequestLimits({ ...binding, inspection: { ...binding.inspection, contextWindowTokens: 2048 } }).contextBudget.contextWindowTokens).toBe(2048);
    expect(() => chatRequestLimits({ ...binding, inspection: { ...binding.inspection, contextWindowTokens: 512 } })).toThrow('provider.invalidRequestBudget');
  });

  it('routes existing non-chat generation calls through the same frozen limits and audit boundary', async () => {
    const f = await setup(); const prepared: Parameters<ProviderDispatchHooks['prepared']>[0][] = [];
    const service = new ProviderService(f.repository, { getSecret: async () => null } as unknown as SafeStorageVault,
      { adapter: () => f.adapter } as unknown as ProviderUtilityClient,
      { prepared: async (record) => { prepared.push(record); }, observed: async () => undefined });
    const adapter = await service.adapter(f.config.id);
    for await (const event of adapter.streamChat({ model: 'alpha', messages: [{ role: 'user', content: 'Synthetic auxiliary request' }] })) void event;
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ maxOutputTokens: 2048, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256 } });
    expect(prepared).toHaveLength(1); expect(prepared[0]?.requestId).toBe(f.sent[0]?.identity?.requestId);
    expect(prepared[0]?.bodySHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not dispatch if its shared prepared audit fails or the endpoint changes during that write', async () => {
    for (const failure of ['storage', 'endpoint'] as const) {
      const f = await setup();
      const service = new ProviderService(f.repository, { getSecret: async () => null } as unknown as SafeStorageVault,
        { adapter: () => f.adapter } as unknown as ProviderUtilityClient,
        { prepared: async () => {
          if (failure === 'storage') throw new Error('Synthetic storage unavailable');
          await f.repository.transaction((state) => { state.providers[0]!.baseUrl = 'http://127.0.0.1:9998/v1'; });
        }, observed: async () => undefined });
      const binding = await service.captureBinding(f.config.id, 'alpha');
      const run = async () => { for await (const event of binding.adapter.streamChat({ model: 'alpha', messages: [{ role: 'user', content: 'Synthetic request' }] })) void event; };
      await expect(run()).rejects.toThrow(failure === 'storage' ? 'provider.requestRecordFailed' : 'provider.bindingMismatch');
      expect(f.sent).toEqual([]);
    }
  });

  it.each(['audit', 'revocation', 'cancellation'] as const)('persists an undispatched ledger receipt when %s prevents adapter entry', async failure => {
    const f = await setup(), ledger = new UsageLedger(f.repository), controller = new AbortController();
    const service = new ProviderService(f.repository, { getSecret: async () => null } as unknown as SafeStorageVault,
      { adapter: () => f.adapter } as unknown as ProviderUtilityClient, {
        prepared: async record => {
          await ledger.prepare(record);
          if (failure === 'audit') throw new Error('Synthetic audit failure');
          if (failure === 'cancellation') controller.abort();
          if (failure === 'revocation') await f.repository.transaction(state => { state.providers[0]!.enabled = false; });
        },
        observed: observation => ledger.observe(observation),
        notDispatched: (id, outcome) => ledger.releaseUndispatched(id, outcome),
      });
    const binding = await service.captureBinding(f.config.id);
    const run = async () => { for await (const event of binding.adapter.streamChat({ model: 'alpha', messages: [{ role: 'user', content: 'Synthetic pre-dispatch failure' }] }, controller.signal)) void event; };
    await expect(run()).rejects.toBeDefined();
    expect(f.sent).toEqual([]);
    expect(f.repository.snapshot().usageEvents).toHaveLength(1);
    expect(f.repository.snapshot().usageEvents[0]).toMatchObject({ dispatchedAt: null, phase: 'terminal', outcome: failure === 'cancellation' ? 'aborted' : 'failed' });
    await expect(ledger.prepare({ requestId: randomUUID(), bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), providerId: f.config.id, model: 'alpha', inputEstimate: 100, maxInputTokens: 7424, maxOutputTokens: 512, capacitySource: 'configured' })).resolves.toBeUndefined();
  });
});

describe('causal lineage across model tool rounds', () => {
  const trace = (patch: Partial<ContextTrace> = {}): ContextTrace => ({ version: 1, memoryReferences: [], historyMessageIds: [],
    privacy: 'cloud-allowed', scope: { kind: 'global' }, lineage: 'complete', ...patch });
  it('keeps the sources and privacy of earlier rounds when later optional context is omitted', () => {
    const earlier = trace({ memoryReferences: [{ id: 'source', revision: 1 }], historyMessageIds: ['earlier'], privacy: 'local-only', scope: { kind: 'session', sessionId: 'owner' } });
    const later = trace({ historyMessageIds: ['recent'] });
    expect(mergeTurnContextTrace(earlier, later)).toEqual({ ...earlier, historyMessageIds: ['earlier', 'recent'] });
    expect(later.memoryReferences).toEqual([]);
  });
  it('refuses to wash an old revision, unknown lineage or foreign owner into the next tool chain', () => {
    const original = trace({ memoryReferences: [{ id: 'source', revision: 1 }], scope: { kind: 'session', sessionId: 'owner' } });
    expect(() => mergeTurnContextTrace(original, trace({ memoryReferences: [{ id: 'source', revision: 2 }] }))).toThrow('chat.contextStale');
    expect(() => mergeTurnContextTrace(original, trace({ lineage: 'unknown' }))).toThrow('chat.contextStale');
    expect(() => mergeTurnContextTrace(original, trace({ scope: { kind: 'session', sessionId: 'other' } }))).toThrow('chat.contextStale');
  });
});
