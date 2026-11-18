import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { resolveContextDestination } from '../domain/chat-context-policy';
import { DomainRepository } from '../domain/repository';
import type { SafeStorageVault } from '../security';
import type { ProviderUtilityClient } from './utility-client';
import { ProviderService } from './provider-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-discovery-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const repository = new DomainRepository(path, { getVaultKey: async () => Buffer.alloc(32, 73) });
  await repository.initialize();
  const config: ProviderConfig = { id: randomUUID(), name: 'Synthetic saved service', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: 'main-model', enabled: true, supportsTools: false, secretState: 'configured' };
  await repository.transaction((state) => { state.providers.push(config); });
  const vault = { isAvailable: vi.fn(() => true), hasSecret: vi.fn(async () => true), getSecret: vi.fn(async () => 'synthetic-key-only'), setSecret: vi.fn(async () => {}) };
  const listModels = vi.fn(async () => [{ id: 'child-model', displayName: 'Child model', contextWindow: null, supportsTools: false }]);
  const adapter = vi.fn(() => ({ listModels, streamChat: vi.fn(() => { throw new Error('Discovery cannot generate'); }) }));
  const service = new ProviderService(repository, vault as unknown as SafeStorageVault, { adapter } as unknown as ProviderUtilityClient);
  return { root, path, repository, config, vault, listModels, adapter, service };
};

describe('ephemeral provider discovery', () => {
  it('uses only metadata with an entered fake key, without changing settings, secrets, ciphertext or usage', async () => {
    const f = await fixture(); const before = await readFile(f.path);
    expect(await f.service.discoverModels({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'synthetic-new-key' })).toHaveLength(1);
    expect(f.adapter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-new-key', config: expect.objectContaining({ kind: 'openrouter', model: '__catalog_only__' }) }));
    expect(f.vault.getSecret).not.toHaveBeenCalled(); expect(f.vault.setSecret).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(before); expect(f.repository.snapshot().providers).toEqual([f.config]);
    expect(f.repository.snapshot().usageEvents).toEqual([]); expect(f.repository.snapshot().providerCredentialRefs).toEqual({});
  });
  it('reuses a saved key only for the same normalized endpoint and kind, and does not persist a model', async () => {
    const f = await fixture(); const before = await readFile(f.path);
    await f.service.discoverModels({ kind: f.config.kind, baseUrl: `${f.config.baseUrl}/`, existingProviderId: f.config.id });
    expect(f.adapter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-key-only' }));
    expect(await readFile(f.path)).toEqual(before); expect(f.repository.snapshot().providers[0]?.model).toBe('main-model');
  });
  it('rejects missing cloud credentials before creating a transport', async () => {
    const f = await fixture();
    await expect(f.service.discoverModels({ kind: 'openai', baseUrl: f.config.baseUrl })).rejects.toThrow('provider.credentialsRequired');
    expect(f.adapter).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'openai' as const, baseUrl: 'https://different.example/v1' },
    { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' },
  ])('never sends a retained key to a changed draft endpoint or kind: %j', async (changed) => {
    const f = await fixture();
    await expect(f.service.discoverModels({ ...changed, existingProviderId: f.config.id })).rejects.toThrow('provider.credentialEndpointChanged');
    expect(f.vault.getSecret).not.toHaveBeenCalled(); expect(f.adapter).not.toHaveBeenCalled();
  });
  it('rejects an unknown saved provider without attempting a key read', async () => {
    const f = await fixture();
    await expect(f.service.discoverModels({ kind: 'openai', baseUrl: f.config.baseUrl, existingProviderId: randomUUID() })).rejects.toThrow('provider.credentialEndpointChanged');
    expect(f.vault.getSecret).not.toHaveBeenCalled();
  });
  it('allows explicit fresh credentials for a changed draft, with no key rewrite', async () => {
    const f = await fixture();
    await f.service.discoverModels({ kind: 'openai-compatible', baseUrl: 'https://different.example/v1', apiKey: 'synthetic-replacement', existingProviderId: f.config.id });
    expect(f.adapter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-replacement' })); expect(f.vault.getSecret).not.toHaveBeenCalled(); expect(f.vault.setSecret).not.toHaveBeenCalled();
  });
  it('local discovery does not require or create a secret', async () => {
    const f = await fixture();
    await f.service.discoverModels({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(f.adapter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: null })); expect(f.vault.setSecret).not.toHaveBeenCalled();
  });
  it.each([['http://cloud.example/v1', 'provider.discoveryFailed'], ['https://user:password@cloud.example/v1', 'provider.request'], ['https://cloud.example/v1?apiKey=private', 'provider.request'], ['file:///tmp/private', 'provider.discoveryFailed']])('rejects unsafe endpoint %s before reading keys or opening a transport', async (baseUrl, expectedCode) => {
    const f = await fixture();
    await expect(f.service.discoverModels({ kind: 'openai', baseUrl, existingProviderId: f.config.id })).rejects.toThrow(expectedCode!);
    expect(f.vault.getSecret).not.toHaveBeenCalled(); expect(f.adapter).not.toHaveBeenCalled();
  });
  it('withholds a stale response after saved endpoint or credentials change', async () => {
    const f = await fixture();
    let release!: () => void;
    f.listModels.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; });
    const pending = f.service.discoverModels({ kind: 'openai', baseUrl: f.config.baseUrl, existingProviderId: f.config.id });
    await vi.waitFor(() => expect(f.listModels).toHaveBeenCalled());
    await f.repository.transaction((state) => { state.providers[0]!.baseUrl = 'https://changed.example/v1'; });
    release(); await expect(pending).rejects.toThrow('provider.bindingMismatch');
  });
  it('bounds overlapping discoveries and releases admission after errors', async () => {
    const f = await fixture(); const releases: Array<() => void> = [];
    f.listModels.mockImplementation(async () => { await new Promise<void>((resolve) => { releases.push(resolve); }); return []; });
    const input = { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1' };
    const first = f.service.discoverModels(input); const second = f.service.discoverModels(input);
    await expect(f.service.discoverModels(input)).rejects.toThrow('provider.discoveryBusy');
    await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.forEach((release) => release()); await Promise.all([first, second]);
    f.listModels.mockRejectedValueOnce(new Error('untrusted response with synthetic-key-only and upstream body'));
    await expect(f.service.discoverModels(input)).rejects.toThrow(/^provider.discoveryFailed$/u);
    f.listModels.mockResolvedValueOnce([]); await expect(f.service.discoverModels(input)).resolves.toEqual([]);
  });
  it('preserves safe HTTP errors while redacting arbitrary upstream diagnostics', async () => {
    const f = await fixture(); const input = { kind: 'ollama' as const, baseUrl: 'http://localhost:11434/v1' };
    f.listModels.mockRejectedValueOnce({ code: 'provider.authentication', body: 'do-not-expose' });
    await expect(f.service.discoverModels(input)).rejects.toThrow(/^provider.authentication$/u);
  });
  it('rejects a saved endpoint change without an explicit replacement key', async () => {
    const f = await fixture(); const { secretState: _secretState, ...config } = f.config; void _secretState;
    await expect(f.service.upsert({ ...config, baseUrl: 'https://changed.example/v1' })).rejects.toThrow('provider.credentialEndpointChanged');
    expect(f.vault.setSecret).not.toHaveBeenCalled(); expect(f.repository.snapshot().providers).toEqual([f.config]);
  });
  it('always treats OpenRouter as remote even if a custom proxy claims local execution', () => {
    expect(resolveContextDestination({ providerId: randomUUID(), kind: 'openrouter', baseUrl: 'https://localhost/v1', model: 'synthetic', localExecutionConfirmed: true, serviceExecution: 'local' })).toBe('remote');
  });
  it('blocks retained credentials across process restart when key rotation succeeds but the endpoint commit fails', async () => {
    const f = await fixture(); let secret = 'synthetic-old-key';
    f.vault.getSecret.mockImplementation(async () => secret); f.vault.setSecret.mockImplementation(async (_id?: string, value?: string) => { secret = value!; });
    const transaction = f.repository.transaction.bind(f.repository); let commits = 0;
    vi.spyOn(f.repository, 'transaction').mockImplementation(async (mutation) => { commits++; if (commits === 2) throw new Error('synthetic-config-commit-failure'); return transaction(mutation); });
    const { secretState: _secretState, ...config } = f.config; void _secretState;
    await expect(f.service.upsert({ ...config, baseUrl: 'https://new-service.example/v1' }, 'synthetic-new-key')).rejects.toThrow('synthetic-config-commit-failure');
    expect(secret).toBe('synthetic-new-key');
    const reopened = new DomainRepository(f.path, { getVaultKey: async () => Buffer.alloc(32, 73) }); await reopened.initialize();
    const restarted = new ProviderService(reopened, f.vault as unknown as SafeStorageVault, { adapter: f.adapter } as unknown as ProviderUtilityClient);
    await expect(restarted.adapter(config.id)).rejects.toThrow('provider.credentialsRequired');
    await expect(restarted.discoverModels({ kind: config.kind, baseUrl: config.baseUrl, existingProviderId: config.id })).rejects.toThrow('provider.credentialsRequired');
    expect(reopened.snapshot().providers[0]).toMatchObject({ enabled: false, secretState: 'unavailable', baseUrl: config.baseUrl });
    expect(f.adapter).not.toHaveBeenCalled();
    await expect(restarted.upsert({ ...config, enabled: true })).rejects.toThrow('provider.credentialsRequired');
    await restarted.upsert({ ...config, baseUrl: 'https://new-service.example/v1' }, 'synthetic-confirmed-key');
    expect(reopened.snapshot().providers[0]).toMatchObject({ enabled: true, secretState: 'configured', baseUrl: 'https://new-service.example/v1' });
  });
  it('rejects overlapping same-provider credential mutations while preserving the one accepted update', async () => {
    const f = await fixture(); let release!: () => void;
    f.vault.setSecret.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const { secretState: _secretState, ...config } = f.config; void _secretState;
    const pending = f.service.upsert({ ...config, baseUrl: 'https://new-service.example/v1' }, 'synthetic-new-key');
    await vi.waitFor(() => expect(f.vault.setSecret).toHaveBeenCalled());
    await expect(f.service.upsert(config, 'synthetic-other-key')).rejects.toThrow('provider.configurationBusy');
    await expect(f.service.clearSecret(config.id)).rejects.toThrow('provider.configurationBusy');
    await expect(f.service.remove(config.id)).rejects.toThrow('provider.configurationBusy');
    release(); await pending;
    expect(f.repository.snapshot().providers[0]).toMatchObject({ baseUrl: 'https://new-service.example/v1', enabled: true, secretState: 'configured' });
    expect(f.vault.setSecret).toHaveBeenCalledTimes(1);
  });
});
