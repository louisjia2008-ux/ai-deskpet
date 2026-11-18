// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfileRecoveryService } from './profile-recovery';
import { DomainRepository } from './domain/repository';
import { JsonlEventStore } from './persistence/jsonl-event-store';
import { AtomicJsonStore } from './persistence/atomic-json-store';
import { applyPendingProfileRestore } from './profile-backup';
import { SafeStorageVault } from './security';
import { z } from 'zod';

vi.mock('electron', () => ({ app: {}, dialog: {}, safeStorage: {}, ipcMain: {} }));
const adapter = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`fixture:${text}`), decryptString: (data: Buffer) => data.toString().slice(8) };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-recovery-')); roots.push(root);
  const vault = new SafeStorageVault(join(root, 'vault'), adapter);
  const path = join(root, 'profile.enc.json');
  const repository = new DomainRepository(path, vault); await repository.initialize();
  await repository.transaction((state) => { state.relationship.nickname = 'Fixture Kitty'; });
  return { root, vault, path };
}
it('continues to require recovery on every launch instead of creating an empty profile', async () => {
  const f = await fixture(); await writeFile(f.path, '{broken');
  for (let attempt = 0; attempt < 2; attempt++) await expect(new DomainRepository(f.path, f.vault).initialize()).rejects.toThrow();
  expect((await readdir(f.root)).filter((name) => name.startsWith('profile.enc.json.corrupt-'))).toHaveLength(1);
  const plain = join(f.root, 'settings.json'); await writeFile(plain, '{broken');
  const store = () => new AtomicJsonStore({ path: plain, schemaVersion: 1, schema: z.object({ ok: z.boolean() }), defaultValue: () => ({ ok: false }) });
  await expect(store().load()).rejects.toThrow(); await expect(store().load()).rejects.toThrow();
});
it('restores a selected local snapshot through the authenticated backup transaction and keeps current files', async () => {
  const f = await fixture();
  const id = randomUUID(); const snapshot = join(f.root, 'recovery', id, 'previous'); await mkdir(snapshot, { recursive: true });
  await cp(f.path, join(snapshot, 'profile.enc.json')); await cp(join(f.root, 'vault'), join(snapshot, 'vault'), { recursive: true });
  const current = new DomainRepository(f.path, f.vault); await current.initialize();
  await current.transaction((state) => { state.relationship.nickname = 'Current fixture'; });
  const currentBytes = await readFile(f.path);
  const service = new ProfileRecoveryService(f.root, join(f.root, 'backups'), adapter, '0.1.0');
  const snapshots = await service.snapshots(); expect(snapshots).toHaveLength(1);
  await expect(service.prepareSnapshot(randomUUID())).rejects.toThrow('invalidSnapshot');
  await service.prepareSnapshot(snapshots[0]!.id);
  expect(await readFile(f.path)).toEqual(currentBytes);
  await applyPendingProfileRestore(f.root);
  const recovered = new DomainRepository(f.path, new SafeStorageVault(join(f.root, 'vault'), adapter)); await recovered.initialize();
  expect(recovered.snapshot().relationship.nickname).toBe('Fixture Kitty');
  const journalDirs = (await readdir(join(f.root, 'recovery'))).filter((name) => name !== id);
  const previous = await Promise.all(journalDirs.map((name) => readFile(join(f.root, 'recovery', name, 'previous/profile.enc.json')).catch(() => Buffer.alloc(0))));
  expect(previous.some((bytes) => bytes.equals(currentBytes))).toBe(true);
});
it('keeps unreadable current authority intact when snapshot restore cannot prove automatic-work safety', async () => {
  const f = await fixture();
  const id = randomUUID(), snapshot = join(f.root, 'recovery', id, 'previous'); await mkdir(snapshot, { recursive: true });
  await cp(f.path, join(snapshot, 'profile.enc.json')); await cp(join(f.root, 'vault'), join(snapshot, 'vault'), { recursive: true });
  await writeFile(f.path, 'damaged current profile');
  const service = new ProfileRecoveryService(f.root, join(f.root, 'backups'), adapter, '0.1.0');
  const [selected] = await service.snapshots();
  await service.prepareSnapshot(selected!.id);
  expect(await readFile(f.path, 'utf8')).toBe('damaged current profile');
  await applyPendingProfileRestore(f.root);
  expect(await readFile(f.path, 'utf8')).not.toBe('damaged current profile');
});
it('preserves the valid log prefix and the original truncated file without preventing startup', async () => {
  const f = await fixture(); const path = join(f.root, 'events.jsonl');
  await writeFile(path, '{"n":1}\n{"n":2}\n{"n":');
  const store = new JsonlEventStore(path, z.object({ n: z.number() }));
  expect(await store.readAll()).toEqual([{ n: 1 }, { n: 2 }]);
  expect(await readFile(store.recovery!.quarantinedPath, 'utf8')).toContain('{"n":');
  expect(await new JsonlEventStore(path, z.object({ n: z.number() })).readAll()).toEqual([{ n: 1 }, { n: 2 }]);
});
