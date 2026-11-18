// @vitest-environment node
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultCharacterProfile } from '../../shared/character';
import { CharacterStore } from './character-store';
import { importPersonaSeed } from './persona-import';
import { PersonaStore } from './persona-store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const vault = { getVaultKey: async () => Buffer.alloc(32, 9) };
const sheet = { ...defaultCharacterProfile(), bible: 'SEEDED_BIBLE', likes: ['草莓'], age: 16, ageSince: '2026-11-15' };
const gone = (path: string) => access(path).then(() => false, () => true);

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-seed-')); roots.push(dir);
  const persona = new PersonaStore(join(dir, 'persona.enc.json'), vault), character = new CharacterStore(join(dir, 'character.enc.json'), vault);
  await persona.initialize(); await character.initialize();
  return { seed: join(dir, 'persona-import.json'), persona, character };
};

it('fills an empty persona and sheet once, then removes the plaintext file', async () => {
  const { seed, persona, character } = await setup();
  await writeFile(seed, JSON.stringify({ persona: { name: '小桌宠', addressUser: '哥哥' }, character: sheet }));
  expect(await importPersonaSeed(seed, persona, character)).toEqual({ persona: true, character: true });
  expect(persona.get()).toMatchObject({ name: '小桌宠', addressUser: '哥哥', identity: '' });
  expect(character.profile()).toEqual(sheet);
  expect(await gone(seed)).toBe(true);
  expect(await importPersonaSeed(seed, persona, character)).toBeNull();
});

it('never overwrites what was written in the app, and removes an invalid file too', async () => {
  const { seed, persona, character } = await setup();
  await persona.update({ ...persona.get(), name: 'Mine' });
  await character.updateProfile({ ...sheet, bible: 'MINE' });
  await writeFile(seed, JSON.stringify({ persona: { name: '小桌宠' }, character: sheet }));
  expect(await importPersonaSeed(seed, persona, character)).toEqual({ persona: false, character: false });
  expect(persona.get().name).toBe('Mine'); expect(character.profile().bible).toBe('MINE');
  await writeFile(seed, JSON.stringify({ character: { ...sheet, age: 0 } }));
  await expect(importPersonaSeed(seed, persona, character)).rejects.toThrow();
  expect(await gone(seed)).toBe(true);
});
