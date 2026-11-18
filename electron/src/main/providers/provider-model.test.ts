import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DomainRepository } from '../domain/repository';
import type { SafeStorageVault } from '../security';
import { ProviderService } from './provider-service';

it('persists only the selected model and never reads or rewrites credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-provider-model-'));
  const path = join(root, 'profile.enc.json');
  const key = { getVaultKey: async () => Buffer.alloc(32, 23) };
  const open = async () => { const repository = new DomainRepository(path, key); await repository.initialize(); return repository; };
  const original = { id: randomUUID(), kind: 'openai-compatible' as const, name: 'Synthetic provider', baseUrl: 'https://provider.example/v1', model: 'alpha', enabled: true, supportsTools: false, secretState: 'configured' as const };
  try {
    const repository = await open();
    await repository.transaction((state) => { state.providers.push(original); });
    const vault = new Proxy({}, { get: () => { throw new Error('Model selection must not touch credentials'); } }) as SafeStorageVault;
    const service = new ProviderService(repository, vault);
    expect(await service.setModel(original.id, ' beta ')).toEqual({ ...original, model: 'beta' });
    expect((await open()).snapshot().providers).toEqual([{ ...original, model: 'beta' }]);
    await expect(service.setModel(randomUUID(), 'gamma')).rejects.toThrow('unavailable');
    for (const invalid of ['', 'x'.repeat(241), 'bad\nmodel', 'bad\u0000model']) await expect(service.setModel(original.id, invalid)).rejects.toThrow('invalidModel');
    await repository.transaction((state) => { state.providers[0]!.enabled = false; });
    await expect(service.setModel(original.id, 'gamma')).rejects.toThrow('unavailable');
    expect(repository.snapshot().providers[0]?.model).toBe('beta');
  } finally { await rm(root, { recursive: true, force: true }); }
});
