import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../shared';
import { BackgroundMemoryModelStore } from './background-memory-model';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const path = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'deskpet-background-model-')); roots.push(root); return join(root, 'background-memory-model.json'); };
const provider: ProviderConfig = { id: '11111111-1111-4111-8111-111111111111', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.2-sol',
  enabled: true, supportsTools: true, secretState: 'configured' };
const other: ProviderConfig = { ...provider, id: '22222222-2222-4222-8222-222222222222' };

describe('background memory model', () => {
  it('follows chat until a model is chosen, applies only to its provider, and survives a restart', async () => {
    const file = await path();
    const store = new BackgroundMemoryModelStore(file);
    expect(store.get()).toBeNull(); expect(store.modelFor(provider)).toBeUndefined();
    store.set(provider, 'gpt-6-luna');
    expect(store.modelFor(provider)).toBe('gpt-6-luna'); expect(store.modelFor(other)).toBeUndefined();
    expect(new BackgroundMemoryModelStore(file).get()).toEqual({ providerId: provider.id, model: 'gpt-6-luna' });
    store.set(null);
    expect(new BackgroundMemoryModelStore(file).get()).toBeNull();
  });

  it('stops applying when the provider entry is edited to point at another service', async () => {
    const store = new BackgroundMemoryModelStore(await path());
    store.set(provider, 'gpt-6-luna');
    expect(store.modelFor({ ...provider, baseUrl: 'https://relay.example/v1' })).toBeUndefined();
    expect(store.modelFor({ ...provider, kind: 'openai-compatible' })).toBeUndefined();
    expect(store.modelFor({ ...provider, name: 'Renamed' })).toBe('gpt-6-luna');
  });

  it('treats a damaged or foreign file as "same as chat" and rejects invalid choices', async () => {
    const file = await path();
    await writeFile(file, '{"version":2,"providerId":"x","model":"m"}');
    expect(new BackgroundMemoryModelStore(file).get()).toBeNull();
    await writeFile(file, 'not json');
    const store = new BackgroundMemoryModelStore(file);
    expect(store.get()).toBeNull();
    expect(() => store.set({ ...provider, id: 'not-a-uuid' }, 'm')).toThrow();
    expect(() => store.set(provider, 'bad\nmodel')).toThrow();
    expect(() => store.set(provider, ' padded ')).toThrow();
    expect(await readFile(file, 'utf8')).toBe('not json');
  });
});
