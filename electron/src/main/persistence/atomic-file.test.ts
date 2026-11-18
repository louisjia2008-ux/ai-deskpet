// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicWriteFile, removeAbandonedTemporaryFiles } from './atomic-file';

const directories: string[] = [];
const fixture = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), 'deskpet-atomic-')); directories.push(directory); return directory; };
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const old = async (path: string): Promise<void> => { await writeFile(path, 'x'); const when = new Date(Date.now() - 2 * 60 * 60_000); await utimes(path, when, when); };

it('removes only old temporary files that belong to the same store', async () => {
  const directory = await fixture(), path = join(directory, 'profile.enc.json');
  const abandoned = '.profile.enc.json.11111111-1111-4111-8111-111111111111.tmp', recent = '.profile.enc.json.22222222-2222-4222-8222-222222222222.tmp';
  const other = '.settings.json.33333333-3333-4333-8333-333333333333.tmp', unrelated = '.profile.enc.json.notes.tmp';
  await writeFile(path, 'live'); await old(join(directory, abandoned)); await writeFile(join(directory, recent), 'x');
  await old(join(directory, other)); await old(join(directory, unrelated));
  await expect(removeAbandonedTemporaryFiles(path)).resolves.toBe(1);
  expect((await readdir(directory)).sort()).toEqual([recent, other, unrelated, 'profile.enc.json'].sort());
});

it('leaves no temporary file behind when a write cannot finish', async () => {
  const directory = await fixture(), target = join(directory, 'target');
  await mkdir(target); await writeFile(join(target, 'occupied'), 'x');
  await expect(atomicWriteFile(target, 'data')).rejects.toThrow();
  expect((await readdir(directory))).toEqual(['target']);
});
