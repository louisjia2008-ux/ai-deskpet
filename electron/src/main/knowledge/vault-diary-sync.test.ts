import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { KnowledgeDiaryCopy } from '../../shared/knowledge';
import { publishDiaryCopy, removeDiaryStage, revokeDiaryCopy, stageDiaryCopy } from './vault-diary-sync';
import { folderIdentity } from './vault-folders';
import { VaultKnowledgeService } from './vault-index';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const syntheticDiary = (day: number): KnowledgeDiaryCopy => ({
  date: `2025-02-${String(day).padStart(2, '0')}`, createdAt: '2025-02-10T00:00:00.000Z', text: `SYNTHETIC_DIARY_BODY_${day}`,
});

async function fixture() {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'deskpet-diary-export-')));
  const root = join(temporary, 'fixture');
  await mkdir(root);
  await mkdir(join(root, 'Shared'));
  const directory = join(temporary, 'index');
  const deps = { directory, vault: { getVaultKey: async () => Buffer.alloc(32, 5) },
    embeddings: { embed: async (texts: string[]) => texts.map(() => [1, 0]) } };
  const service = new VaultKnowledgeService(deps);
  await service.initialize();
  await service.selectRoot(root);
  cleanups.push(async () => {
    if (service.status().vaultName !== null) await service.reindex().catch(() => undefined);
    service.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  return { service, root, temporary, directory, deps };
}

it('starts disabled, rejects shared diary targets, and blocks writing or sharing the active target', async () => {
  const { service, root } = await fixture();
  expect(service.status()).toMatchObject({ diarySync: { enabled: false, folder: '日记' }, retainedInvalidDiaries: 0 });
  await service.syncDiaryCopies(() => [syntheticDiary(1)]);
  expect(await readdir(root)).not.toContain('日记');

  await service.setFolderSharing('Shared', 'shareable');
  await expect(service.setDiarySync({ enabled: true, folder: 'Shared' })).rejects.toThrow('knowledge.diaryFolderShareable');
  await expect(service.setDiarySync({ enabled: true, folder: '../unsafe' })).rejects.toThrow('knowledge.diaryFolderInvalid');
  await service.setDiarySync({ enabled: true, folder: '收集' });
  const placement = (await service.folders()).find(item => item.name === '收集');
  expect(placement).toMatchObject({ diaryProtected: true, sharing: 'local', writable: false });
  await expect(service.setFolderSharing('收集', 'shareable')).rejects.toThrow('knowledge.diaryFolderProtected');
  await expect(service.setWritableFolders(['收集'])).rejects.toThrow('knowledge.diaryFolderProtected');
  await expect(service.saveNote({ title: 'Synthetic', markdown: 'synthetic note' }, 'desktop', 'local')).rejects.toThrow('knowledge.folderNotWritable');
});

it('backfills active entries without overwriting, then keeps the exports private after disabling or renaming', async () => {
  const { service, root, directory, deps } = await fixture();
  await mkdir(join(root, 'Diaries'));
  await writeFile(join(root, 'Diaries', '2025-02-02.md'), 'SYNTHETIC_PREEXISTING');
  await service.setDiarySync({ enabled: true, folder: 'Diaries' });
  await service.syncDiaryCopies(() => [syntheticDiary(1), syntheticDiary(2)]);
  const exported = await readFile(join(root, 'Diaries', '2025-02-01.md'), 'utf8');
  expect(exported).toEqual('---\ncreated: 2025-02-10T00:00:00.000Z\nby: deskpet\nkind: diary\n---\n\nSYNTHETIC_DIARY_BODY_1');
  expect(await readFile(join(root, 'Diaries', '2025-02-02.md'), 'utf8')).toBe('SYNTHETIC_PREEXISTING');
  expect((await readdir(join(root, 'Diaries'))).sort()).toEqual(['2025-02-01.md', '2025-02-02.md']);
  await service.reindex();
  expect((await service.searchForTool('synthetic', 'remote')).hits).toEqual([]);
  expect(await service.readNoteForTool('Diaries/2025-02-01.md', 'local')).toMatchObject({ privacy: 'local-only' });
  expect(await readFile(join(directory, 'vault.enc.json'), 'utf8')).not.toMatch(/2025-02-01|SYNTHETIC_DIARY_BODY_1|Diaries/u);

  await service.setDiarySync({ enabled: false, folder: 'Different' });
  await service.syncDiaryCopies(() => [syntheticDiary(1), syntheticDiary(2), syntheticDiary(3)]);
  expect(await readdir(root)).not.toContain('Different');
  const reopened = new VaultKnowledgeService(deps);
  await reopened.initialize();
  try {
    await expect(reopened.setFolderSharing('diaries', 'shareable')).rejects.toThrow('knowledge.diaryFolderProtected');
    await rename(join(root, 'Diaries'), join(root, 'Renamed'));
    await expect(reopened.setFolderSharing('Renamed', 'shareable')).rejects.toThrow('knowledge.diaryFolderProtected');
  } finally { reopened.dispose(); }
});

it('continues revoking after disabling sync, preserving edited and replaced paths without diagnostics disclosure', async () => {
  const { service, root, temporary } = await fixture();
  const entries = [syntheticDiary(1), syntheticDiary(2), syntheticDiary(3), syntheticDiary(4)];
  await service.setDiarySync({ enabled: true, folder: '日记' });
  await service.syncDiaryCopies(() => entries);
  const diary = join(root, '日记');
  const outside = join(temporary, 'synthetic-outside.md');
  await writeFile(outside, 'SYNTHETIC_DO_NOT_DELETE');
  await writeFile(join(diary, '2025-02-02.md'), 'SYNTHETIC_OWNER_EDIT');
  await rename(join(diary, '2025-02-03.md'), join(temporary, 'original-third.md'));
  await symlink(outside, join(diary, '2025-02-03.md'));
  const exact = await readFile(join(diary, '2025-02-04.md'), 'utf8');
  await rename(join(diary, '2025-02-04.md'), join(temporary, 'original-fourth.md'));
  await writeFile(join(diary, '2025-02-04.md'), exact);

  await service.setDiarySync({ enabled: false, folder: '日记' });
  await service.syncDiaryCopies(() => null);
  expect((await readdir(diary)).sort()).toHaveLength(4);
  const result = await service.syncDiaryCopies(() => []);
  expect((await readdir(diary)).sort()).toEqual(['2025-02-02.md', '2025-02-03.md', '2025-02-04.md']);
  expect(await readFile(join(diary, '2025-02-02.md'), 'utf8')).toBe('SYNTHETIC_OWNER_EDIT');
  expect(await readFile(outside, 'utf8')).toBe('SYNTHETIC_DO_NOT_DELETE');
  expect(await readFile(join(diary, '2025-02-04.md'), 'utf8')).toBe(exact);
  expect(result.retainedInvalidDiaries).toBe(3);
  expect(JSON.stringify(result)).not.toMatch(/2025-02|SYNTHETIC/u);
  await expect(service.setFolderSharing('日记', 'shareable')).rejects.toThrow('knowledge.diaryFolderProtected');
});

it('protects moved or byte-identical exports even inside an already shared directory', async () => {
  const { service, root } = await fixture();
  await service.setFolderSharing('Shared', 'shareable');
  await service.setDiarySync({ enabled: true, folder: '日记' });
  await service.syncDiaryCopies(() => [syntheticDiary(1), syntheticDiary(2)]);
  const original = join(root, '日记', '2025-02-01.md');
  const untouched = join(root, '日记', '2025-02-02.md');
  await writeFile(join(root, 'Shared', 'copied.md'), await readFile(original));
  await writeFile(join(root, 'Shared', 'copied-revoked.md'), await readFile(untouched));
  await rename(original, join(root, 'Shared', 'moved.md'));
  await writeFile(join(root, 'Shared', 'moved.md'), 'SYNTHETIC_EDIT_OF_MOVED_DIARY');
  await writeFile(join(root, 'Shared', 'regular.md'), 'SYNTHETIC_SHARED_NOTE');
  await service.reindex();
  await service.syncDiaryCopies(() => []);
  await service.reindex();
  await expect(readFile(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const file of ['copied.md', 'copied-revoked.md', 'moved.md']) {
    await expect(service.readNoteForTool('Shared/' + file, 'cloud')).rejects.toThrow('knowledge.folderPrivate');
    expect((await service.readNoteForTool('Shared/' + file, 'local')).privacy).toBe('local-only');
  }
  expect((await service.searchForTool('synthetic', 'remote')).hits.map(hit => hit.path)).toEqual(['Shared/regular.md']);
});

it('leaves the prior root untouched after detaching the vault', async () => {
  const { service, root } = await fixture();
  await service.setDiarySync({ enabled: true, folder: '日记' });
  await service.syncDiaryCopies(() => [syntheticDiary(1)]);
  await service.detach();
  await service.syncDiaryCopies(() => []);
  expect(await readFile(join(root, '日记', '2025-02-01.md'), 'utf8')).toContain('SYNTHETIC_DIARY_BODY_1');
  expect(service.status()).toMatchObject({ diarySync: { enabled: false, folder: '日记' }, retainedInvalidDiaries: 0 });
});

it('checks content after the final authority callback can edit the same inode', async () => {
  const { root } = await fixture();
  const folder = join(root, 'Diaries');
  await mkdir(folder);
  const grant = { path: root, ...folderIdentity(root, null)! };
  const entry = syntheticDiary(1);
  const allow = () => undefined;
  const copy = (await stageDiaryCopy(grant, { folder: 'Diaries', enabled: true, target: folderIdentity(root, 'Diaries')!, copies: [] }, entry, allow))!;
  expect(publishDiaryCopy(grant, copy, entry, allow)).toBe(true);
  expect(removeDiaryStage(grant, copy, allow)).toBe(true);
  const target = join(root, copy.path);
  let checks = 0;
  expect(revokeDiaryCopy(grant, copy, () => {
    if (++checks === 2) writeFileSync(target, 'SYNTHETIC_EDIT_DURING_AUTHORITY');
  })).toBe('changed');
  expect(await readFile(target, 'utf8')).toBe('SYNTHETIC_EDIT_DURING_AUTHORITY');
});

it('resumes a durably staged copy while the journal was temporarily unavailable', async () => {
  const { service, root, deps } = await fixture();
  await service.setDiarySync({ enabled: true, folder: '日记' });
  const entry = syntheticDiary(1);
  let calls = 0;
  await service.syncDiaryCopies(() => ++calls === 1 ? [entry] : null);
  const diary = join(root, '日记');
  expect(await readdir(diary)).toEqual([expect.stringMatching(/^\.deskpet-diary-/u)]);
  const reopened = new VaultKnowledgeService(deps);
  await reopened.initialize();
  try {
    await reopened.syncDiaryCopies(() => [entry]);
    expect(await readdir(diary)).toEqual(['2025-02-01.md']);
    expect(await readFile(join(diary, '2025-02-01.md'), 'utf8')).toContain(entry.text);
    await reopened.reindex();
  } finally { reopened.dispose(); }
});
