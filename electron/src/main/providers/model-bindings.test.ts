import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared/contracts';
import { DomainRepository } from '../domain/repository';
import { ModelBindingService, type ModelBinding } from './model-bindings';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-model-binding-'));
  roots.push(root);
  const path = join(root, 'profile.enc.json'), vault = { getVaultKey: async () => Buffer.alloc(32, 11) };
  const repository = new DomainRepository(path, vault);
  await repository.initialize();
  const provider: ProviderConfig = { id: randomUUID(), name: 'Fixture service', model: 'm1', enabled: true,
    baseUrl: 'http://127.0.0.1:1234', kind: 'lm-studio', supportsTools: false, secretState: 'missing' };
  await repository.transaction(state => { state.providers = [provider]; });
  const bindings: ModelBinding[] = [];
  const add = (id: string, model: string | null) => {
    const binding: ModelBinding = { id, model, providerId: provider.id, label: 'Fixture schedule', feature: 'schedule',
      follow: vi.fn(async expected => {
        if (binding.model !== expected.model || binding.providerId !== expected.providerId) return false;
        binding.model = null;
        return true;
      }),
    };
    bindings.push(binding);
    return binding;
  };
  const changed = vi.fn();
  const list = vi.fn(async () => bindings);
  const service = new ModelBindingService({ repository, list, changed });
  const save = (model: string) => async () => repository.transaction(state => {
    state.providers[0]!.model = model;
    return state.providers[0]!;
  });
  return { provider, repository, path, vault, add, list, service, save };
}

it('migrates current-default copies once and preserves new explicit pins across restarts', async () => {
  const f = await fixture(), equal = f.add('schedule:equal', 'm1'), other = f.add('schedule:other', 'm2');
  await f.service.migrate();
  expect(equal.model).toBeNull();
  expect(other.model).toBe('m2');
  const bytes = await readFile(f.path);
  const newPin = f.add('schedule:new', 'm1');
  const reopened = new DomainRepository(f.path, f.vault);
  await reopened.initialize();
  await new ModelBindingService({ repository: reopened, list: f.list, changed: vi.fn() }).migrate();
  expect(newPin.model).toBe('m1');
  expect(await readFile(f.path)).toEqual(bytes);
  expect(f.list).toHaveBeenCalledTimes(1);
});

it('retries only the original pending selection after a partial migration', async () => {
  const f = await fixture(), first = f.add('schedule:first', 'm1'), second = f.add('schedule:retry', 'm1');
  vi.mocked(second.follow).mockRejectedValueOnce(new Error('fixture.write'));
  await f.service.migrate();
  expect(first.model).toBeNull();
  expect(second.model).toBe('m1');
  expect(f.repository.read('modelFollowMigration')).toEqual([{ id: second.id, model: 'm1', providerId: f.provider.id }]);
  const newPin = f.add('schedule:new', 'm1');
  await f.service.migrate();
  expect(second.model).toBeNull();
  expect(newPin.model).toBe('m1');
  expect(f.repository.read('modelFollowMigration')).toBe(true);
});

it('updates only opted-in pins on the saved old default and rejects stale confirmation', async () => {
  const f = await fixture(), { id } = f.provider;
  const keep = f.add('schedule:keep', 'm1'), convert = f.add('schedule:convert', 'm1'), other = f.add('schedule:other', 'm2');
  f.add('schedule:follow', null);
  expect(await f.service.impact(id)).toMatchObject({ previousModel: 'm1', followers: 1, pinned: [{ id: keep.id }, { id: convert.id }] });
  const selection = { previousModel: 'm1', followIds: [convert.id, other.id] };
  expect(await f.service.change(id, 'm3', selection, f.save('m3'))).toMatchObject({ model: 'm3', modelChange: { followers: 2, failed: 0 } });
  expect([keep.model, convert.model, other.model]).toEqual(['m1', null, 'm2']);
  await expect(f.service.change(id, 'm4', selection, f.save('m4'))).rejects.toThrow('provider.defaultModelChanged');
});

it('projects only current failures and clears them on success or a manual switch to follow', async () => {
  const f = await fixture(), binding = f.add('schedule:unavailable', 'm0');
  const request = { id: binding.id, providerId: f.provider.id, model: 'm0' };
  f.service.failed(request.id, request.providerId, request.model, new Error('provider.modelUnavailable'));
  // An older request's failure must not hide the current model's problem.
  f.service.failed(request.id, request.providerId, 'old', new Error('provider.modelUnavailable'));
  await f.repository.flush();
  expect(await f.service.issues()).toMatchObject([{ ...request, code: 'provider.pinnedModelUnavailable', followModel: 'm1' }]);
  await f.service.followIssue(request);
  expect(binding.model).toBeNull();
  expect(await f.service.issues()).toEqual([]);
  f.service.failed(request.id, request.providerId, 'm1', new Error('provider.modelUnavailable'));
  await f.repository.flush();
  expect(await f.service.issues()).toMatchObject([{ code: 'provider.modelUnavailable', followModel: null }]);
  f.service.succeeded(request.id, request.providerId, 'm1');
  await f.repository.flush();
  expect(await f.service.issues()).toEqual([]);
  f.service.failed(request.id, request.providerId, 'm1', { code: 'provider.modelUnavailable' });
  f.service.succeeded(request.id, request.providerId, 'm1');
  await f.repository.flush();
  expect(await f.service.issues()).toEqual([]);
});
