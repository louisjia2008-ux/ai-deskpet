import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_KNOWLEDGE_EMBEDDING_MODEL, KNOWLEDGE_EMBEDDING_PREFIXES } from '../../shared/knowledge-embedding';
import { decryptBytes, encryptJson } from '../persistence/encryption';
import { KnowledgeIndexScheduler } from './index-scheduler';
import type { KnowledgeEmbeddings } from './ollama-embedding';
import { VaultKnowledgeService } from './vault-index';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(embeddings: KnowledgeEmbeddings) {
  const tmp = await mkdtemp(join(tmpdir(), 'deskpet-index-profile-'));
  cleanup.push(() => rm(tmp, { force: true, recursive: true }));
  const vault = join(tmp, 'vault');
  await mkdir(vault);
  await writeFile(join(vault, 'one.md'), 'First synthetic reference.');
  await writeFile(join(vault, 'two.md'), 'Second synthetic reference.');
  const key = randomBytes(32);
  const directory = join(tmp, 'index');
  const deps = { directory, vault: { getVaultKey: async () => key }, embeddings };
  const service = new VaultKnowledgeService(deps);
  await service.initialize();
  await service.selectRoot(vault);
  return { service, vault, deps, metadata: join(directory, 'vault.enc.json'), key };
}

it('rebuilds every unchanged note when the selected embedding model changes and applies the selected prefixes', async () => {
  const embed = vi.fn<KnowledgeEmbeddings['embed']>(async (texts, _signal, model) =>
    texts.map(() => model === 'qwen3-embedding:0.6b' ? [1, 0, 0] : [1, 0]));
  const { service } = await fixture({ embed });
  expect(service.status().embeddingModel).toBe('bge-m3');
  await service.reindex();
  expect(embed.mock.calls.flatMap(([batch]) => batch)).toEqual(expect.arrayContaining([
    'First synthetic reference.', 'Second synthetic reference.',
  ]));
  embed.mockClear();
  await service.reindex();
  expect(embed).not.toHaveBeenCalled();
  await service.setEmbeddingModel('qwen3-embedding:0.6b');
  expect(await service.reindex()).toMatchObject({ changedNotes: 2, indexedNotes: 2, lastError: null });
  expect(await service.search('What is there?')).toHaveLength(2);
  expect(embed.mock.calls.map(([, , model]) => model)).toEqual(expect.arrayContaining(['qwen3-embedding:0.6b']));
  expect(embed.mock.calls.flatMap(([batch]) => batch)).toEqual(expect.arrayContaining([
    'First synthetic reference.', 'Second synthetic reference.',
    KNOWLEDGE_EMBEDDING_PREFIXES['qwen3-embedding:0.6b'].queryPrefix + 'What is there?',
  ]));
});

it('keeps an explicit Nomic choice and automatically rebuilds an implicit Nomic index at startup', async () => {
  const embed = vi.fn<KnowledgeEmbeddings['embed']>(async (texts, _signal, model) =>
    texts.map(() => model === 'bge-m3' ? [1, 0, 0] : [1, 0]));
  const { service, deps, metadata, key } = await fixture({ embed });
  await service.setEmbeddingModel('nomic-embed-text');
  expect(await service.reindex()).toMatchObject({ embeddingModel: 'nomic-embed-text', indexedNotes: 2, lastError: null });
  service.dispose();

  const explicit = new VaultKnowledgeService(deps);
  await explicit.initialize();
  embed.mockClear();
  expect(await explicit.reindex()).toMatchObject({ embeddingModel: 'nomic-embed-text', changedNotes: 0, lastError: null });
  expect(embed).not.toHaveBeenCalled();
  explicit.dispose();

  const legacy = JSON.parse(decryptBytes(JSON.parse(await readFile(metadata, 'utf8')), key).toString('utf8')) as Record<string, unknown>;
  delete legacy.embeddingModel;
  await writeFile(metadata, JSON.stringify(encryptJson(legacy, key)), { mode: 0o600 });
  const implicit = new VaultKnowledgeService(deps);
  await implicit.initialize();
  expect(implicit.status().embeddingModel).toBe('bge-m3');
  implicit.startAutoIndex();
  try {
    await expect.poll(() => implicit.status()).toMatchObject({ indexing: false, changedNotes: 2, indexedNotes: 2, lastError: null });
    expect(await implicit.search('Find references')).toHaveLength(2);
    expect(embed.mock.calls.map(([, , model]) => model)).toEqual(['bge-m3', 'bge-m3', 'bge-m3']);
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual(expect.arrayContaining([
      'First synthetic reference.', 'Second synthetic reference.', 'Find references',
    ]));
  } finally {
    implicit.dispose();
  }
});

it('rebuilds all saved vectors when the query reports a different dimension and then retrieves from the fresh generation', async () => {
  let vector = [1, 0];
  const embed = vi.fn<KnowledgeEmbeddings['embed']>(async texts => texts.map(() => vector));
  const { service } = await fixture({ embed });
  await service.reindex();
  vector = [1, 0, 0];
  embed.mockClear();
  expect(await service.search('Find the references.')).toHaveLength(2);
  expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual(expect.arrayContaining([
    'Find the references.', 'First synthetic reference.', 'Second synthetic reference.',
  ]));
  expect(service.status()).toMatchObject({ changedNotes: 2, indexedNotes: 2, lastError: null });
});

it('indexes just the new path after a save, even while periodic indexing is disabled', async () => {
  const embed = vi.fn<KnowledgeEmbeddings['embed']>(async texts => texts.map(() => [1, 0]));
  const { service, vault } = await fixture({ embed });
  await service.reindex();
  await service.setAutoIndex(false);
  await writeFile(join(vault, 'new.md'), 'New synthetic reference.');
  await writeFile(join(vault, 'two.md'), 'An unrelated external edit.');
  embed.mockClear();
  expect(await service.indexNote('new.md')).toMatchObject({ changedNotes: 1, checkedNotes: 1, indexedNotes: 3, autoIndex: false });
  expect(embed.mock.calls.map(([texts, , model]) => ({ texts, model }))).toEqual([
    { texts: ['New synthetic reference.'], model: DEFAULT_KNOWLEDGE_EMBEDDING_MODEL },
  ]);
});

it('keeps incompatible generations unavailable after a failed rebuild and retries from a clean index', async () => {
  let failCandidate = true;
  const embed = vi.fn<KnowledgeEmbeddings['embed']>(async (texts, _signal, model) => {
    if (model === 'qwen3-embedding:0.6b' && failCandidate && texts.some(text => text.includes('Second')))
      throw new Error('knowledge.embeddingModelMissing');
    return texts.map(() => [1, 0]);
  });
  const { service } = await fixture({ embed });
  await service.reindex();
  await service.setEmbeddingModel('qwen3-embedding:0.6b');
  expect(await service.reindex()).toMatchObject({ lastError: 'knowledge.embeddingModelMissing', consecutiveIndexFailures: 1 });
  await expect(service.search('Find the references.')).rejects.toThrow('knowledge.embeddingModelMissing');
  expect(service.status()).toMatchObject({ embeddingStatus: 'missing', consecutiveIndexFailures: 2 });
  failCandidate = false;
  expect(await service.search('Find the references.')).toHaveLength(2);
  expect(service.status()).toMatchObject({ embeddingStatus: 'installed', consecutiveIndexFailures: 0, lastIndexFailureAt: null });
});

it('refreshes on startup and every two hours, honors the toggle and stops on disposal', () => {
  vi.useFakeTimers();
  const reindex = vi.fn<VaultKnowledgeService['reindex']>().mockResolvedValue({} as ReturnType<VaultKnowledgeService['status']>);
  let autoIndex = true;
  const scheduler = new KnowledgeIndexScheduler({
    status: () => ({ vaultName: 'Synthetic', autoIndex }) as ReturnType<VaultKnowledgeService['status']>, reindex,
  });
  scheduler.start();
  expect(reindex).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2 * 60 * 60 * 1000);
  expect(reindex).toHaveBeenCalledTimes(2);
  autoIndex = false;
  vi.advanceTimersByTime(2 * 60 * 60 * 1000);
  expect(reindex).toHaveBeenCalledTimes(2);
  autoIndex = true;
  scheduler.refresh();
  expect(reindex).toHaveBeenCalledTimes(3);
  scheduler.dispose();
  vi.advanceTimersByTime(4 * 60 * 60 * 1000);
  expect(reindex).toHaveBeenCalledTimes(3);
});
