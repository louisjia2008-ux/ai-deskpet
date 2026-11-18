import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { KnowledgeNoteSource } from '../../shared/knowledge';
import { VaultKnowledgeService } from './vault-index';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'deskpet-note-create-'));
  let service: VaultKnowledgeService | undefined;
  cleanups.push(async () => {
    await service?.reindex().catch(() => undefined);
    service?.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, 'fixture');
  const outside = join(temporary, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'Shared'));
  await mkdir(join(root, 'Private'));
  await writeFile(join(root, 'Shared', 'preexisting.md'), 'SYNTHETIC_EXISTING_MARKER');
  const key = randomBytes(32);
  let fail = false;
  const embedded: string[] = [];
  const deps = {
    directory: join(temporary, 'index'),
    vault: { getVaultKey: async () => key },
    embeddings: { embed: async (texts: string[]) => {
      if (fail) throw new Error('knowledge.embeddingModelMissing');
      embedded.push(...texts);
      return texts.map(() => [1, 0]);
    } },
  };
  service = new VaultKnowledgeService(deps);
  await service.initialize();
  await service.selectRoot(root);
  await service.reindex();
  return { root, outside, service, deps, embedded, failEmbedding: () => { fail = true; } };
}

it('creates the default collection locally, sanitizes a title, and indexes only the new note', async () => {
  const { service, root, embedded } = await fixture();
  expect(await service.folders()).toContainEqual({ name: '收集', sharing: 'local', writable: true, diaryProtected: false });
  const result = await service.saveNote({ title: '... /合\\成:标题?"<>|', markdown: '# 合成参考\n示例正文。' }, 'desktop', 'local');
  expect(result).toEqual({ path: '收集/合成标题.md', privacy: 'local-only' });
  const contents = await readFile(join(root, result.path!), 'utf8');
  expect(contents).toMatch(/^---\ncreated: \d{4}-\d\d-\d\dT[^\n]+Z\nsource: desktop\nby: deskpet\n---\n\n# 合成参考\n示例正文。$/u);
  await expect.poll(() => service.status()).toMatchObject({ indexedNotes: 2, checkedNotes: 1, changedNotes: 1, lastError: null });
  expect(embedded).toHaveLength(2);
  expect(embedded.at(-1)).toContain('示例正文');
  expect((await service.searchForTool('reference', 'local')).hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: '收集/合成标题.md', excerpt: expect.stringContaining('示例正文') }),
  ]));
});

it('suffixes same-name and concurrent writes without replacing any existing note or link', async () => {
  const { service, root, outside } = await fixture();
  await service.setWritableFolders(['Shared']);
  await writeFile(join(outside, 'untouched.md'), 'SYNTHETIC_OUTSIDE_MARKER');
  await symlink(join(outside, 'untouched.md'), join(root, 'Shared', 'preexisting (2).md'));
  const results = await Promise.all([
    service.saveNote({ folder: 'Shared', title: 'preexisting', markdown: 'First fixture' }, 'desktop', 'local'),
    service.saveNote({ folder: 'Shared', title: 'preexisting', markdown: 'Second fixture' }, 'desktop', 'local'),
  ]);
  expect(results.map(result => result.path).sort()).toEqual(['Shared/preexisting (3).md', 'Shared/preexisting (4).md']);
  expect((await readdir(join(root, 'Shared'))).sort()).toEqual([
    'preexisting (2).md', 'preexisting (3).md', 'preexisting (4).md', 'preexisting.md',
  ]);
  expect(await readFile(join(root, 'Shared', 'preexisting.md'), 'utf8')).toBe('SYNTHETIC_EXISTING_MARKER');
  expect(await readFile(join(outside, 'untouched.md'), 'utf8')).toBe('SYNTHETIC_OUTSIDE_MARKER');
});

it('guards writable folder identity, resolves only approved top-level names, and honors disabling the default', async () => {
  const { service, root, outside, deps } = await fixture();
  const draft = { title: 'write fixture', markdown: 'Synthetic body' };
  await service.setWritableFolders(['Shared']);
  await expect(service.saveNote(draft, 'desktop', 'local')).rejects.toThrow('knowledge.folderNotWritable');
  for (const folder of ['../outside', join(root, 'Shared'), 'Shared/../Private', '.hidden', 'Shared\\Private']) {
    await expect(service.saveNote({ ...draft, folder }, 'desktop', 'local')).rejects.toThrow(/^knowledge\.invalidPath$/u);
  }
  await expect(service.saveNote({ ...draft, folder: 'Private' }, 'desktop', 'local')).rejects.toThrow(/^knowledge\.folderNotWritable$/u);
  await rename(join(root, 'Shared'), join(root, 'Moved'));
  await symlink(outside, join(root, 'Shared'));
  await expect(service.saveNote({ ...draft, folder: 'Shared' }, 'desktop', 'local')).rejects.toThrow(/^knowledge\.folderNotWritable$/u);
  expect(await readdir(outside)).toEqual([]);
  await rm(join(root, 'Shared'));
  await mkdir(join(root, 'Shared'));
  await expect(service.saveNote({ ...draft, folder: 'Shared' }, 'desktop', 'local')).rejects.toThrow(/^knowledge\.folderNotWritable$/u);
  const resumed = new VaultKnowledgeService(deps);
  await resumed.initialize();
  expect(await resumed.folders()).toContainEqual({ name: '收集', sharing: 'local', writable: false, diaryProtected: false });
  await expect(resumed.saveNote(draft, 'desktop', 'local')).rejects.toThrow('knowledge.folderNotWritable');
});

it('pins the first default collection identity before concurrent writes and rejects a replacement after restart', async () => {
  const { service, root, deps } = await fixture();
  const draft = { title: 'fixture', markdown: 'Synthetic body' };
  const saves = await Promise.all([service.saveNote(draft, 'desktop', 'local'), service.saveNote(draft, 'desktop', 'local')]);
  expect(saves.map(result => result.path).sort()).toEqual(['收集/fixture (2).md', '收集/fixture.md']);
  await service.reindex();
  await rename(join(root, '收集'), join(root, 'former-collection'));
  await mkdir(join(root, '收集'));
  await expect(service.saveNote(draft, 'desktop', 'local')).rejects.toThrow(/^knowledge\.folderNotWritable$/u);
  const resumed = new VaultKnowledgeService(deps);
  await resumed.initialize();
  expect(await resumed.folders()).toEqual(expect.arrayContaining([expect.objectContaining({ name: '收集', writable: false })]));
  await expect(resumed.saveNote(draft, 'desktop', 'local')).rejects.toThrow(/^knowledge\.folderNotWritable$/u);
  expect(await readdir(join(root, '收集'))).toEqual([]);
  expect((await readdir(join(root, 'former-collection'))).sort()).toEqual(['fixture (2).md', 'fixture.md']);
  resumed.dispose();
});

it('returns remote and cloud confirmations without paths for private placements and discloses only approved paths', async () => {
  const { service, root } = await fixture();
  await service.setWritableFolders(['Private', 'Shared']);
  for (const source of ['wechat', 'qq', 'telegram', 'desktop'] satisfies KnowledgeNoteSource[]) {
    const result = await service.saveNote({ title: source, markdown: 'Synthetic body', folder: 'Private' }, source,
      source === 'desktop' ? 'cloud' : 'remote');
    expect(result).toEqual({ path: null, privacy: 'cloud-allowed' });
    expect(await readFile(join(root, 'Private', `${source}.md`), 'utf8')).toContain(`source: ${source}\nby: deskpet`);
  }
  await service.setFolderSharing('Shared', 'shareable');
  expect(await service.saveNote({ title: 'approved', markdown: 'Synthetic public body', folder: 'Shared' }, 'wechat', 'remote'))
    .toEqual({ path: 'Shared/approved.md', privacy: 'cloud-allowed' });
  expect(await service.folders()).toContainEqual({ name: 'Private', sharing: 'local', writable: true, diaryProtected: false });
});

it('limits note size, checks approval before file mutation, and confirms a saved note after an indexing failure', async () => {
  const { service, root, failEmbedding } = await fixture();
  const draft = { title: 'fixture', markdown: 'Synthetic saved contents' };
  await expect(service.saveNote({ ...draft, markdown: '文'.repeat(50_001) }, 'desktop', 'local')).rejects.toThrow('knowledge.noteInvalid');
  await expect(service.saveNote({ ...draft, title: '..//\0' }, 'desktop', 'local')).rejects.toThrow('knowledge.noteInvalid');
  await expect(service.saveNote(draft, 'desktop', 'local', undefined, () => { throw new Error('knowledge.policyChanged'); }))
    .rejects.toThrow('knowledge.policyChanged');
  expect(await readdir(root)).not.toContain('收集');
  failEmbedding();
  expect(await service.saveNote(draft, 'desktop', 'local')).toEqual({ path: '收集/fixture.md', privacy: 'local-only' });
  expect(await readFile(join(root, '收集', 'fixture.md'), 'utf8')).toContain(draft.markdown);
  await expect.poll(() => service.status().lastError).toBe('knowledge.embeddingModelMissing');
});
