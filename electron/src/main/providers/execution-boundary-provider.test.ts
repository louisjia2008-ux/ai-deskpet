// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { DomainRepository } from '../domain/repository';
import { SafeStorageVault } from '../security/safe-storage-vault';
import { ProviderService } from './provider-service';
import type { ProviderUtilityClient } from './utility-client';
import type { ProviderAdapter, ProviderChatRequest, ProviderCredentials } from './types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: ProviderChatRequest = { model: 'synthetic-model', messages: [{ role: 'user', content: 'Synthetic credential boundary probe, no network.' }] };
const drain = async (adapter: ProviderAdapter): Promise<void> => { for await (const event of adapter.streamChat(request)) void event; };
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-provider-boundary-')); roots.push(root);
  const vault = new SafeStorageVault(join(root, 'vault'), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`synthetic:${value}`),
    decryptString: (value) => value.toString('utf8').slice('synthetic:'.length),
  }, 'darwin');
  const repository = new DomainRepository(join(root, 'profile.enc.json'), vault); await repository.initialize();
  const observed: Array<{ credentialPresent: boolean; initialCredential: boolean }> = [];
  const metadataObserved: Array<{ method: 'models' | 'inspect'; credentialPresent: boolean; initialCredential: boolean }> = [];
  const initialKey = 'SYNTHETIC_TEST_CREDENTIAL_INITIAL';
  const adapter = (credentials: ProviderCredentials): ProviderAdapter => ({
    listModels: async () => { metadataObserved.push({ method: 'models', credentialPresent: credentials.apiKey !== null, initialCredential: credentials.apiKey === initialKey }); return []; },
    inspectModel: async () => { metadataObserved.push({ method: 'inspect', credentialPresent: credentials.apiKey !== null, initialCredential: credentials.apiKey === initialKey }); return { contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' }; },
    streamChat: async function* () {
      observed.push({ credentialPresent: credentials.apiKey !== null, initialCredential: credentials.apiKey === initialKey });
      yield { type: 'text', text: 'Synthetic fixed result.' }; yield { type: 'done', finishReason: 'stop' };
    },
  });
  const utility = { adapter } as unknown as ProviderUtilityClient;
  const service = new ProviderService(repository, vault, utility);
  const config: Omit<ProviderConfig, 'secretState'> = { id: randomUUID(), kind: 'openai-compatible', name: 'Synthetic provider credential boundary',
    baseUrl: 'https://synthetic-provider.invalid/v1', model: request.model, enabled: true, supportsTools: false, contextWindowTokens: 4096, maxOutputTokens: 512 };
  await service.upsert(config, initialKey);
  return { service, vault, repository, observed, metadataObserved, config };
};

describe('provider credential authority at a new transport boundary', () => {
  it('keeps legal current captured credentials usable across successive requests', async () => {
    const f = await fixture(); const binding = await f.service.captureBinding(f.config.id, request.model);
    await drain(binding.adapter); await drain(binding.adapter);
    expect(f.observed).toEqual([{ credentialPresent: true, initialCredential: true }, { credentialPresent: true, initialCredential: true }]);
  });
  it('rejects a new request from a captured binding after the user clears its credential', async () => {
    const f = await fixture(); const binding = await f.service.captureBinding(f.config.id, request.model);
    await f.service.clearSecret(f.config.id);
    expect(await f.vault.hasSecret(f.config.id)).toBe(false);
    expect(f.repository.snapshot().providers[0]?.secretState).toBe('missing');
    await expect(drain(binding.adapter)).rejects.toThrow('provider.bindingMismatch');
    expect(f.observed).toEqual([]);
  });
  it('rejects captured old credentials after replacement even when the visible provider configuration is otherwise unchanged', async () => {
    const f = await fixture(); const binding = await f.service.captureBinding(f.config.id, request.model);
    await f.service.upsert(f.config, 'SYNTHETIC_TEST_CREDENTIAL_REPLACEMENT');
    expect(f.repository.snapshot().providers[0]?.secretState).toBe('configured');
    await expect(drain(binding.adapter)).rejects.toThrow('provider.bindingMismatch');
    expect(f.observed).toEqual([]);
    const fresh = await f.service.captureBinding(f.config.id, request.model); await drain(fresh.adapter);
    expect(f.observed).toEqual([{ credentialPresent: true, initialCredential: false }]);
  });
  it('rejects a new request after its provider is removed', async () => {
    const f = await fixture(); const binding = await f.service.captureBinding(f.config.id, request.model);
    await f.service.remove(f.config.id);
    await expect(drain(binding.adapter)).rejects.toThrow('provider.bindingMismatch');
    expect(f.observed).toEqual([]);
  });
  it.each(['models', 'inspect'] as const)('rejects adapter metadata %s after credential revocation before a new network action', async (method) => {
    const f = await fixture(); const adapter = await f.service.adapter(f.config.id);
    await f.service.clearSecret(f.config.id); f.metadataObserved.length = 0;
    await expect(method === 'models' ? adapter.listModels() : adapter.inspectModel!(request.model)).rejects.toThrow('provider.bindingMismatch');
    expect(f.metadataObserved).toEqual([]);
  });
  it.each(['models', 'inspect'] as const)('rejects captured-binding metadata %s after credential replacement', async (method) => {
    const f = await fixture(); const binding = await f.service.captureBinding(f.config.id, request.model);
    await f.service.upsert(f.config, 'SYNTHETIC_TEST_CREDENTIAL_REPLACEMENT'); f.metadataObserved.length = 0;
    await expect(method === 'models' ? binding.adapter.listModels() : binding.adapter.inspectModel!(request.model)).rejects.toThrow('provider.bindingMismatch');
    expect(f.metadataObserved).toEqual([]);
  });

});
