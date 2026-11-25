import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundMemoryModelStore } from './background-memory-model';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const path = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'deskpet-background-model-')); roots.push(root); return join(root, 'background-memory-model.json'); };
const provider = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';

describe('background memory model', () => {
  it('follows chat until a model is chosen, applies only to its provider, and survives a restart', async () => {
    const file = await path();
    const store = new BackgroundMemoryModelStore(file);
    expect(store.get()).toBeNull(); expect(store.modelFor(provider)).toBeUndefined();
    store.set({ providerId: provider, model: '  gpt-6-luna ' });
    expect(store.modelFor(provider)).toBe('gpt-6-luna'); expect(store.modelFor(other)).toBeUndefined();
    expect(new BackgroundMemoryModelStore(file).get()).toEqual({ providerId: provider, model: 'gpt-6-luna' });
    store.set(null);
    expect(new BackgroundMemoryModelStore(file).get()).toBeNull();
  });

  it('treats a damaged or foreign file as "same as chat" and rejects invalid choices', async () => {
    const file = await path();
    await writeFile(file, '{"version":2,"providerId":"x","model":"m"}');
    expect(new BackgroundMemoryModelStore(file).get()).toBeNull();
    await writeFile(file, 'not json');
    const store = new BackgroundMemoryModelStore(file);
    expect(store.get()).toBeNull();
    expect(() => store.set({ providerId: 'not-a-uuid', model: 'm' })).toThrow();
    expect(() => store.set({ providerId: provider, model: 'bad\nmodel' })).toThrow();
    expect(await readFile(file, 'utf8')).toBe('not json');
  });
});
