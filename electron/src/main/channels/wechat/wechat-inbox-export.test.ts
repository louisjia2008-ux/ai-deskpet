import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exportInboxItem, WECHAT_INBOX_VAULT_FOLDER, type InboxVaultItem } from './wechat-inbox-export';

const item: InboxVaultItem = {
  id: 'a'.repeat(64), kind: 'article', title: 'Synthetic title', source: 'Fixture',
  summary: 'A line\n<img src=https://example.test/image />\n![](https://example.test/image)',
  at: Date.parse('2026-01-02T03:04:05Z'), url: 'https://example.test/article?a=b',
};
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-inbox-export-')));
  cleanups.push(root);
  const vault = join(root, 'vault');
  const outside = join(root, 'outside');
  await mkdir(vault, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  const { dev, ino } = await stat(vault);
  const grant = { id: '00000000-0000-4000-8000-000000000001', dev, ino, path: vault };
  const folder = join(vault, WECHAT_INBOX_VAULT_FOLDER);
  return { grant, vault, outside, folder, note: join(folder, item.id + '.md') };
}

it('publishes once with separate consent and harmless Markdown syntax', async () => {
  const f = await fixture();
  const deny = () => { throw new Error('wechat.inboxExportRevoked'); };
  await expect(exportInboxItem(f.grant, item, deny)).rejects.toThrow('wechat.inboxExportRevoked');
  expect(await readdir(f.vault)).toEqual([]);
  const allowed = () => undefined;
  await expect(exportInboxItem(f.grant, item, allowed)).resolves.toBe('created');
  await expect(exportInboxItem(f.grant, item, allowed)).resolves.toBe('exists');
  expect(await readdir(f.vault)).toEqual([WECHAT_INBOX_VAULT_FOLDER]);
  expect((await stat(f.note)).nlink).toBe(1);
  expect((await stat(f.note)).mode & 0o777).toBe(0o600);
  const note = await readFile(f.note, 'utf8');
  expect(note).toContain('# Synthetic title\n');
  expect(note).toContain('2026-01-02T03:04:05.000Z');
  expect(note).not.toContain('\n> <img');
  expect(note).not.toContain('\n> ![]');
});

it('refuses a replaced vault, a linked folder, and an invalid note ID', async () => {
  const f = await fixture();
  const allowed = () => undefined;
  await expect(exportInboxItem(f.grant, { ...item, id: '../other' }, allowed)).rejects.toThrow('wechat.inboxExportInvalid');
  await symlink(f.outside, f.folder);
  await expect(exportInboxItem(f.grant, item, allowed)).rejects.toThrow('wechat.inboxExportUnsafe');
  expect(await readdir(f.outside)).toEqual([]);
  await rename(f.vault, f.vault + '-old');
  await mkdir(f.vault, { mode: 0o700 });
  await expect(exportInboxItem(f.grant, item, allowed)).rejects.toThrow('wechat.inboxExportUnsafe');
  expect(await readdir(f.vault)).toEqual([]);
});

it('leaves a preexisting note, symlink, or hardlink intact', async () => {
  const f = await fixture();
  const allowed = () => undefined;
  const externalFile = join(f.outside, 'note.md');
  await mkdir(f.folder, { mode: 0o700 });
  await writeFile(externalFile, 'unrelated text', { mode: 0o600 });
  await writeFile(f.note, 'user edits', { mode: 0o600 });
  await expect(exportInboxItem(f.grant, item, allowed)).rejects.toThrow('wechat.inboxExportConflict');
  expect(await readFile(f.note, 'utf8')).toBe('user edits');
  await rm(f.note);
  for (const alias of [symlink, link]) {
    await alias(externalFile, f.note);
    await expect(exportInboxItem(f.grant, item, allowed)).rejects.toThrow('wechat.inboxExportConflict');
    expect(await readFile(externalFile, 'utf8')).toBe('unrelated text');
    await rm(f.note);
  }
});

it('checks consent again before file creation for an existing export directory', async () => {
  const f = await fixture();
  await mkdir(f.folder, { mode: 0o700 });
  let calls = 0;
  const expires = () => {
    if (++calls === 3) throw new Error('wechat.inboxExportRevoked');
  };
  await expect(exportInboxItem(f.grant, item, expires)).rejects.toThrow('wechat.inboxExportRevoked');
  expect(await readdir(f.folder)).toEqual([]);
});
