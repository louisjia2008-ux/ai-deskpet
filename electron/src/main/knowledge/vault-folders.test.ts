import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import { encryptJson } from '../persistence/encryption';
import { VaultKnowledgeService } from './vault-index';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(embed = async (texts: string[]) => texts.map(() => [1, 0])) {
  const temp = await mkdtemp(join(tmpdir(), 'deskpet-folder-policy-'));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'synthetic');
  const directory = join(temp, 'index');
  const key = randomBytes(32);
  const deps = { directory, vault: { getVaultKey: async () => key }, embeddings: { embed } };
  const notes: Record<string, string> = {
    'Private/hidden-title.md': 'PRIVATE_BODY_MARKER',
    'Shared/visible-title.md': 'SHARED_BODY_MARKER',
    'loose-title.md': 'ROOT_BODY_MARKER',
  };
  await mkdir(join(root, 'Private'), { recursive: true });
  await mkdir(join(root, 'Shared'));
  for (const [path, body] of Object.entries(notes)) await writeFile(join(root, path), body);
  const service = new VaultKnowledgeService(deps);
  await service.initialize();
  await service.selectRoot(root);
  expect(await service.reindex()).toMatchObject({ lastError: null });
  return { root, directory, deps, service };
}

it('clips cloud and remote search before ranking and marks mixed desktop results local-only', async () => {
  const { service, root } = await fixture();
  expect(await service.searchForTool('query', 'cloud')).toEqual({ hits: [], privacy: 'cloud-allowed' });
  await service.setFolderSharing('Shared', 'shareable');
  // New folders are local even after other folders have been approved.
  await mkdir(join(root, 'New'));
  await writeFile(join(root, 'New', 'new-title.md'), 'NEW_BODY_MARKER');
  await service.reindex();
  for (const destination of ['cloud', 'remote'] as const) {
    const result = await service.searchForTool('query', destination);
    expect(result).toMatchObject({ privacy: 'cloud-allowed', hits: [{ path: 'Shared/visible-title.md', excerpt: 'SHARED_BODY_MARKER' }] });
    expect(JSON.stringify(result)).not.toMatch(/private|hidden-title|loose-title|new-title|PRIVATE_BODY|ROOT_BODY|NEW_BODY/iu);
    await expect(service.readNoteForTool('Private/hidden-title.md', destination)).rejects.toThrow(/^knowledge\.folderPrivate$/u);
    await expect(service.readNoteForTool('New/new-title.md', destination)).rejects.toThrow(/^knowledge\.folderPrivate$/u);
    expect(await service.readNoteForTool('Shared/visible-title.md', destination)).toMatchObject({ privacy: 'cloud-allowed', text: 'SHARED_BODY_MARKER' });
  }
  const desktop = await service.searchForTool('query', 'local');
  expect(desktop.privacy).toBe('local-only');
  expect(desktop.hits.map(note => note.path).sort()).toEqual([
    'New/new-title.md', 'Private/hidden-title.md', 'Shared/visible-title.md', 'loose-title.md',
  ]);
  expect(await service.readNoteForTool('Private/hidden-title.md', 'local')).toMatchObject({ privacy: 'local-only', text: 'PRIVATE_BODY_MARKER' });
});

it('keeps sharing encrypted and bound to the current grant, including the root group', async () => {
  const { service, directory, deps, root } = await fixture();
  await service.setFolderSharing(null, 'shareable');
  await service.setFolderSharing('Shared', 'shareable');
  const token = service.policyToken();
  await service.reindex();
  expect(service.policyToken()).toBe(token);
  const metadata = await readFile(join(directory, 'vault.enc.json'), 'utf8');
  expect(metadata).not.toMatch(/shareable|Shared|synthetic|loose-title/u);
  const restarted = new VaultKnowledgeService(deps);
  await restarted.initialize();
  expect(restarted.policyToken()).toBe(token);
  expect(await restarted.readNoteForTool('loose-title.md', 'cloud')).toMatchObject({ text: 'ROOT_BODY_MARKER', privacy: 'cloud-allowed' });
  await restarted.detach();
  expect(restarted.policyToken()).toBeNull();
  await restarted.selectRoot(root);
  expect(restarted.policyToken()).not.toBe(token);
  await expect(restarted.readNoteForTool('loose-title.md', 'remote')).rejects.toThrow('knowledge.folderPrivate');
  await expect(restarted.readNoteForTool('Shared/visible-title.md', 'remote')).rejects.toThrow('knowledge.folderPrivate');
});

it('leaves a legacy linked vault untouched until the owner explicitly selects a directory again', async () => {
  const { directory, deps, root } = await fixture();
  const canonical = await realpath(root);
  const { dev, ino } = await lstat(canonical);
  const legacy = JSON.stringify(encryptJson({
    root: { id: 'f09fc647-81de-41ee-92c3-13d52f28b255', path: canonical, dev, ino },
    indexedNotes: 3, indexedChunks: 3, lastIndexedAt: '2026-01-01T00:00:00.000Z',
    embeddingModel: 'qwen3-embedding:0.6b', autoIndex: false,
  }, await deps.vault.getVaultKey()));
  const metadata = join(directory, 'vault.enc.json');
  await writeFile(metadata, legacy);
  const resumed = new VaultKnowledgeService(deps);
  await resumed.initialize();
  expect(resumed.status()).toMatchObject({ vaultName: null, indexedNotes: 0, embeddingModel: 'qwen3-embedding:0.6b', autoIndex: false });
  expect(resumed.policyToken()).toBeNull();
  expect(await resumed.inboxExportGrant()).toBeNull();
  await expect(resumed.searchForTool('query', 'local')).rejects.toThrow('knowledge.noVault');
  expect(await readFile(metadata, 'utf8')).toBe(legacy);
  expect(await readFile(join(root, 'loose-title.md'), 'utf8')).toBe('ROOT_BODY_MARKER');
  await resumed.selectRoot(root);
  const reopened = new VaultKnowledgeService(deps);
  await reopened.initialize();
  expect(reopened.status()).toMatchObject({ vaultName: 'synthetic', indexedNotes: 0, embeddingModel: 'qwen3-embedding:0.6b', autoIndex: false });
  await expect(reopened.readNoteForTool('loose-title.md', 'cloud')).rejects.toThrow('knowledge.folderPrivate');
});

it('rejects path traversal, alternate casing, symlinks, and hard links in exposed note reads', async () => {
  const { service, root } = await fixture();
  await service.setFolderSharing('Shared', 'shareable');
  await expect(service.setFolderSharing('shared', 'shareable')).rejects.toThrow('knowledge.invalidPath');
  for (const path of [
    '../Private/hidden-title.md', 'Shared/../Private/hidden-title.md', join(root, 'Private', 'hidden-title.md'),
    'C:\\Private\\hidden-title.md', './Private/hidden-title.md', 'Shared//visible-title.md', 'Shared/.hidden/note.md',
  ]) await expect(service.readNoteForTool(path, 'cloud')).rejects.toThrow(/^knowledge\.invalidPath$/u);
  for (const path of ['pRIVATE/hidden-title.md', 'shared/visible-title.md']) {
    await expect(service.readNoteForTool(path, 'remote')).rejects.toThrow(/^knowledge\.folderPrivate$/u);
  }
  await symlink(join(root, 'Private'), join(root, 'Shared', 'linked'));
  await symlink(join(root, 'Private', 'hidden-title.md'), join(root, 'Shared', 'symlink.md'));
  await link(join(root, 'Private', 'hidden-title.md'), join(root, 'Shared', 'hardlink.md'));
  for (const path of ['Shared/linked/hidden-title.md', 'Shared/symlink.md', 'Shared/hardlink.md']) {
    await expect(service.readNoteForTool(path, 'cloud')).rejects.toThrow(/^knowledge\.readFailed$/u);
  }
  await service.reindex();
  expect(await service.searchForTool('query', 'remote')).toMatchObject({ hits: [{ path: 'Shared/visible-title.md' }] });
});

it('fails closed when approved directory is replaced by a previously private directory', async () => {
  const { service, root } = await fixture();
  await service.setFolderSharing('Shared', 'shareable');
  const token = service.policyToken();
  await rename(join(root, 'Shared'), join(root, 'Old'));
  await rename(join(root, 'Private'), join(root, 'Shared'));
  await service.reindex();
  expect(service.policyToken()).not.toBe(token);
  expect(await service.searchForTool('query', 'cloud')).toEqual({ hits: [], privacy: 'cloud-allowed' });
  await expect(service.readNoteForTool('Shared/hidden-title.md', 'remote')).rejects.toThrow('knowledge.folderPrivate');
});

it('returns only safe error codes to settings when the selected directory vanishes or is replaced', async () => {
  const { service, root } = await fixture();
  const missing = join(root, 'SYNTHETIC_PATH_MARKER');
  await expect(service.selectRoot(missing)).rejects.toThrow(/^knowledge\.invalidRoot$/u);
  await rename(root, `${root}-old`);
  await expect(service.folders()).rejects.toThrow(/^knowledge\.rootChanged$/u);
  await expect(service.setFolderSharing('Shared', 'shareable')).rejects.toThrow(/^knowledge\.rootChanged$/u);
  await mkdir(root);
  await expect(service.folders()).rejects.toThrow(/^knowledge\.rootChanged$/u);
  await expect(service.setWritableFolders(['Shared'])).rejects.toThrow(/^knowledge\.rootChanged$/u);
});

it('discards an in-flight search when sharing changes during embedding', async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let pause = false;
  const { service } = await fixture(async texts => {
    if (pause) {
      started();
      await waiting;
    }
    return texts.map(() => [1, 0]);
  });
  await service.setFolderSharing('Shared', 'shareable');
  pause = true;
  const result = service.searchForTool('query', 'cloud');
  const assertion = expect(result).rejects.toThrow(/^knowledge\.policyChanged$/u);
  await entered;
  await service.setFolderSharing('Shared', 'local');
  release();
  await assertion;
});

it('keeps a revocation fail-closed when encrypted metadata committed before reporting a write error', async () => {
  const { service, deps } = await fixture();
  await service.setFolderSharing('Shared', 'shareable');
  const save = EncryptedJsonStore.prototype.save;
  const failingSave = vi.spyOn(EncryptedJsonStore.prototype, 'save').mockImplementationOnce(async function (this: EncryptedJsonStore<unknown>, value) {
    await save.call(this, value);
    throw new Error('Synthetic post-commit failure');
  });
  try {
    await expect(service.setFolderSharing('Shared', 'local')).rejects.toThrow('knowledge.storageUnavailable');
    expect(service.policyToken()).toBeNull();
    await expect(service.readNoteForTool('Shared/visible-title.md', 'cloud')).rejects.toThrow('knowledge.policyChanged');
    await expect(service.reindex()).rejects.toThrow('knowledge.storageUnavailable');
    const restarted = new VaultKnowledgeService(deps);
    await restarted.initialize();
    await expect(restarted.readNoteForTool('Shared/visible-title.md', 'cloud')).rejects.toThrow('knowledge.folderPrivate');
    await service.setFolderSharing(null, 'shareable');
    await expect(service.readNoteForTool('Shared/visible-title.md', 'cloud')).rejects.toThrow('knowledge.folderPrivate');
  } finally {
    failingSave.mockRestore();
  }
});
