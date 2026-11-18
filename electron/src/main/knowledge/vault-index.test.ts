import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { VaultKnowledgeService } from './vault-index';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('indexes a 2,402-note synthetic vault, embeds only edits, verifies sources before display, and forgets deleted notes', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'deskpet-knowledge-scale-'));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const folder = join(tmp, 'fixture-vault'),
    cache = join(tmp, 'private-index'),
    key = randomBytes(32);
  await mkdir(folder);
  await mkdir(join(folder, '.obsidian'));
  const drafts = join(folder, 'notes');
  await mkdir(drafts);
  // Serial creation keeps the real-scale fixture within file-descriptor and memory limits.
  for (let n = 0; n < 2400; n++) await writeFile(join(drafts, n + '.md'), 'General reference ' + n);
  await writeFile(join(folder, 'chosen.md'), '# Map\nSPECIAL_NORTH_PRIVATE_MARKER\n');
  await writeFile(join(folder, 'delete.md'), 'LEFT_BEHIND_PRIVATE_MARKER');
  await writeFile(join(folder, '.obsidian', 'hidden.md'), 'SPECIAL_NORTH_HIDDEN');
  await writeFile(join(tmp, 'outside.md'), 'SPECIAL_NORTH_OUTSIDE');
  await symlink(join(tmp, 'outside.md'), join(folder, 'linked.md'));
  let documents = 0,
    largestBatch = 0;
  const deps = {
    directory: cache,
    vault: { getVaultKey: async () => key },
    embeddings: {
      embed: async (inputs: string[]) => {
        largestBatch = Math.max(largestBatch, inputs.length);
        return inputs.map((text) => {
          if (!['SPECIAL_NORTH', 'SOUTH_NEW'].includes(text)) documents++;
          const vector = Array<number>(768).fill(0);
          vector[text.includes('SPECIAL_NORTH') ? 0 : text.includes('SOUTH_NEW') ? 1 : 2] = 1;
          return vector;
        });
      },
    },
  };
  const service = new VaultKnowledgeService(deps);
  await service.initialize();
  await service.selectRoot(folder);
  const first = await service.reindex();
  expect(first).toMatchObject({ indexedNotes: 2402, indexedChunks: 2402, changedNotes: 2402, skippedNotes: 0, lastError: null });
  expect(documents).toBe(2402);
  expect(largestBatch).toBeLessThanOrEqual(16);
  const hits = await service.search('SPECIAL_NORTH');
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    path: 'chosen.md',
    startLine: 1,
    endLine: 2,
    excerpt: '# Map\nSPECIAL_NORTH_PRIVATE_MARKER\n',
  });
  await writeFile(join(folder, 'chosen.md'), '# New\nSOUTH_NEW_AUTHORED\n');
  await rm(join(folder, 'delete.md'));
  expect(await service.search('SPECIAL_NORTH')).toEqual([]);
  await writeFile(join(folder, 'new.md'), 'SOUTH_NEW_ADDITION');
  const updated = await service.reindex();
  expect(updated).toMatchObject({ indexedNotes: 2402, changedNotes: 2, removedNotes: 1, lastError: null });
  expect(documents).toBe(2404);
  expect((await service.search('SOUTH_NEW')).map((h) => h.path).sort()).toEqual(['chosen.md', 'new.md']);
  const fresh = new VaultKnowledgeService(deps);
  await fresh.initialize();
  expect(fresh.status().indexedNotes).toBe(2402);
  expect((await fresh.search('SOUTH_NEW')).map((h) => h.path).sort()).toEqual(['chosen.md', 'new.md']);
  // A new ordinary directory at the same path must not inherit the previous desktop selection.
  await rename(folder, join(tmp, 'old-root'));
  await mkdir(folder);
  await expect(fresh.search('SOUTH_NEW')).rejects.toThrow('knowledge.rootChanged');
  expect((await fresh.detach()).vaultName).toBeNull();
  expect(await readFile(join(cache, 'vault.enc.json'), 'utf8')).not.toContain('fixture-vault');
}, 90_000);

it('answers with host-selected passages and withholds the answer if its source changes during generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-knowledge-answer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    key = randomBytes(32);
  await mkdir(vault);
  await writeFile(join(vault, 'Facts.md'), 'The venue is Hall Seven.');
  let alter = false,
    received = 0;
  const service = new VaultKnowledgeService({
    directory: join(root, 'index'),
    vault: { getVaultKey: async () => key },
    embeddings: { embed: async (texts) => texts.map(() => [1, 0]) },
    answerLocal: async (request) => {
      await request.assertCurrent();
      expect(request.sources[0]).toMatchObject({ path: 'Facts.md', startLine: 1, excerpt: 'The venue is Hall Seven.' });
      received++;
      if (alter) await writeFile(join(vault, 'Facts.md'), 'The venue is Hall Eight.');
      return 'Hall Seven [1]';
    },
  });
  await service.initialize();
  await service.selectRoot(vault);
  await service.reindex();
  const question = { query: 'Which hall?', providerId: 'fixture', model: 'fixture-local' };
  expect(await service.ask(question)).toMatchObject({
    answer: 'Hall Seven [1]',
    sources: [{ path: 'Facts.md', startLine: 1, endLine: 1 }],
  });
  alter = true;
  await expect(service.ask(question)).rejects.toThrow('knowledge.sourceChanged');
  expect(received).toBe(2);
});
