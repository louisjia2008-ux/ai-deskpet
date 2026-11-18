// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { characterDraft } from '../../shared/character';
import { CharacterStore } from './character-store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const vault = { getVaultKey: async () => Buffer.alloc(32, 9) };

it('keeps her sheet and what she last felt across restarts, without one write losing another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-character-')); roots.push(dir);
  let now = new Date('2026-11-15T12:00:00.000Z');
  const store = new CharacterStore(join(dir, 'character.enc.json'), vault, () => now);
  await store.initialize();
  expect(store.profile().bible).toBe('');
  await Promise.all([store.updateProfile({ ...characterDraft(), age: 16, ageSince: '2026-11-15' }), store.noteMood('pout'), store.noteOwnerTurn()]);
  now = new Date('2026-11-15T13:00:00.000Z');
  await store.noteOwnerTurn();
  const reopened = new CharacterStore(join(dir, 'character.enc.json'), vault);
  await reopened.initialize();
  expect(reopened.profile()).toMatchObject({ age: 16, ageSince: '2026-11-15' });
  expect(reopened.state()).toEqual({ lastOwnerTurnAt: '2026-11-15T13:00:00.000Z', mood: { name: 'pout', at: '2026-11-15T12:00:00.000Z' } });
  await expect(store.updateProfile({ ...characterDraft(), age: 0 })).rejects.toThrow();
  expect(store.profile().age).toBe(16);
});

it('stores only the optional owner month and day, encrypted, and can remove the field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-character-')); roots.push(dir);
  const path = join(dir, 'character.enc.json');
  const store = new CharacterStore(path, vault);
  await store.initialize();
  expect(store.profile().ownerBirthday).toBeUndefined();
  await store.updateProfile({ ...store.profile(), ownerBirthday: '02-29' });
  expect(await readFile(path, 'utf8')).not.toContain('02-29');
  const reopened = new CharacterStore(path, vault);
  await reopened.initialize();
  expect(reopened.profile().ownerBirthday).toBe('02-29');
  await reopened.updateProfile({ ...reopened.profile(), ownerBirthday: undefined });
  await store.initialize();
  expect(store.profile()).not.toHaveProperty('ownerBirthday');
});
