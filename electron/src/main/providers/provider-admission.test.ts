// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { providerUtilityCommandSchema } from '../../utility/provider-protocol';
import { DomainRepository } from '../domain/repository';
import type { SafeStorageVault } from '../security';
import { ProviderService } from './provider-service';
import type { ProviderUtilityClient } from './utility-client';
import type { ProviderAdapter, ProviderChatRequest, ProviderCredentials, ProviderDispatchOptions } from './types';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-provider-admission-')); roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 47) });
  await repository.initialize();
  const config = (baseUrl: string, model: string): ProviderConfig => ({ id: randomUUID(), kind: baseUrl.startsWith('https:') ? 'openai-compatible' : 'ollama',
    name: 'Synthetic admission provider', baseUrl, model, enabled: true, supportsTools: false, secretState: 'missing' });
  const first = config('http://127.0.0.1:11434/v1', 'first');
  const alias = config('http://localhost:11434/another-api', 'second');
  const remote = config('https://synthetic-provider.invalid/v1', 'remote');
  await repository.transaction(state => { state.providers.push(first, alias, remote); });
  const started = new Map([first, alias, remote].map(provider => [provider.id, deferred()]));
  const finishes = new Map([first, alias, remote].map(provider => [provider.id, deferred()]));
  const sent: Array<{ credentials: ProviderCredentials; request: ProviderChatRequest; options: ProviderDispatchOptions | undefined }> = [];
  const utility = { adapter: (credentials: ProviderCredentials): ProviderAdapter => ({
    listModels: async () => [],
    async *streamChat(request, _signal, options) {
      // Parse the real strict boundary and clone the payload: host callbacks
      // would fail either operation if they leaked into the wire request.
      providerUtilityCommandSchema.parse({ version: 1, kind: 'provider:chat', requestId: randomUUID(), credentials, request });
      structuredClone(request);
      sent.push({ credentials, request, options });
      started.get(credentials.config.id)!.resolve();
      await finishes.get(credentials.config.id)!.promise;
      yield { type: 'done', finishReason: 'stop' };
    },
  }) } as unknown as ProviderUtilityClient;
  const service = new ProviderService(repository, { getSecret: async () => null } as unknown as SafeStorageVault, utility);
  const run = async (adapter: ProviderAdapter, model: string, options?: ProviderDispatchOptions, signal?: AbortSignal, background = false) => {
    for await (const event of adapter.streamChat({ model, messages: [{ role: 'user', content: 'Synthetic request' }],
      ...(background ? { executionMode: 'background-text' as const } : {}) }, signal, options)) void event;
  };
  return { repository, service, first, alias, remote, started, finishes, sent, run };
};

describe('provider resource admission at dispatch', () => {
  it('rechecks host channel authority after queueing without leaking the callback to the provider', async () => {
    const f = await fixture(), first = await f.service.captureBinding(f.first.id), alias = await f.service.captureBinding(f.alias.id);
    const active = f.run(first.adapter, first.model); await f.started.get(f.first.id)!.promise;
    let allowed = true;
    const waiting = deferred();
    const queued = f.run(alias.adapter, alias.model, { onAdmissionState: state => { if (state === 'queued') waiting.resolve(); },
      assertCurrent: () => { if (!allowed) throw new Error('qq.authorityRevoked'); } });
    const rejected = expect(queued).rejects.toThrow('qq.authorityRevoked');
    await waiting.promise; allowed = false; f.finishes.get(f.first.id)!.resolve(); await active; await rejected;
    expect(f.sent).toHaveLength(1); expect(f.sent[0]?.options).toBeUndefined();
  });

  it('rechecks host authority again after durable preparation, directly before transport', async () => {
    const f = await fixture(), first = await f.service.captureBinding(f.first.id);
    let checks = 0;
    await expect(f.run(first.adapter, first.model, { assertCurrent: () => { if (++checks === 2) throw new Error('qq.cronApprovalStale'); } }))
      .rejects.toThrow('qq.cronApprovalStale');
    expect(checks).toBe(2); expect(f.sent).toEqual([]);
  });
  it('keeps local aliases and models in one pool while an independent provider runs', async () => {
    const f = await fixture();
    const first = await f.service.captureBinding(f.first.id);
    const alias = await f.service.captureBinding(f.alias.id);
    // Exercise the legacy adapter path as well as a captured binding.
    const remote = await f.service.adapter(f.remote.id);
    const states: string[] = [];
    const active = f.run(first.adapter, first.model, undefined, undefined, true);
    await f.started.get(f.first.id)!.promise;
    const queued = f.run(alias.adapter, alias.model, { onAdmissionState: state => states.push(`local:${state}`) });
    const independent = f.run(remote, f.remote.model, { onAdmissionState: state => states.push(`remote:${state}`) });
    await f.started.get(f.remote.id)!.promise;
    expect(states).toEqual(['local:queued', 'remote:running']);
    expect(f.sent.map(item => item.credentials.config.id)).toEqual([f.first.id, f.remote.id]);
    expect(f.sent.every(item => item.options === undefined)).toBe(true);
    f.finishes.get(f.remote.id)!.resolve(); await independent;
    f.finishes.get(f.first.id)!.resolve(); await active;
    await f.started.get(f.alias.id)!.promise;
    expect(states.at(-1)).toBe('local:running');
    f.finishes.get(f.alias.id)!.resolve(); await queued;
  });

  it.each(['endpoint', 'disabled', 'credential-reference'] as const)('revalidates a queued binding after %s changes', async mutation => {
    const f = await fixture();
    const first = await f.service.captureBinding(f.first.id);
    const alias = await f.service.captureBinding(f.alias.id);
    const active = f.run(first.adapter, first.model);
    await f.started.get(f.first.id)!.promise;
    const waiting = deferred();
    const queued = f.run(alias.adapter, alias.model, { onAdmissionState: state => { if (state === 'queued') waiting.resolve(); } });
    const rejected = expect(queued).rejects.toThrow('provider.bindingMismatch');
    await waiting.promise;
    await f.repository.transaction(state => {
      const provider = state.providers.find(item => item.id === f.alias.id)!;
      if (mutation === 'endpoint') provider.baseUrl = 'http://localhost:11435/v1';
      if (mutation === 'disabled') provider.enabled = false;
      if (mutation === 'credential-reference') state.providerCredentialRefs[provider.id] = randomUUID();
    });
    f.finishes.get(f.first.id)!.resolve(); await active;
    await rejected;
    expect(f.sent.map(item => item.credentials.config.id)).toEqual([f.first.id]);
  });

  it('cancels a queued request before transport and never reports it running', async () => {
    const f = await fixture();
    const first = await f.service.captureBinding(f.first.id);
    const alias = await f.service.captureBinding(f.alias.id);
    const active = f.run(first.adapter, first.model);
    await f.started.get(f.first.id)!.promise;
    const controller = new AbortController();
    const states: string[] = [];
    const queued = f.run(alias.adapter, alias.model, { onAdmissionState: state => states.push(state) }, controller.signal);
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await cancelled;
    f.finishes.get(f.first.id)!.resolve(); await active;
    expect(states).toEqual(['queued']);
    expect(f.sent).toHaveLength(1);
  });
});
