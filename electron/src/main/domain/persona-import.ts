import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { characterProfileSchema, hasCharacterProfile } from '../../shared/character';
import { defaultPersona, personaSchema } from '../../shared/persona';
import type { CharacterStore } from './character-store';
import type { PersonaStore } from './persona-store';

const seedSchema = z.object({ persona: personaSchema.partial().strict().optional(), character: characterProfileSchema.optional() }).strict();

/**
 * A one-time file the owner drops in the data folder to fill an empty persona and character sheet.
 * It never overwrites what was written in the app, and the plaintext file is removed either way.
 */
export const importPersonaSeed = async (path: string, persona: PersonaStore, character: CharacterStore): Promise<{ persona: boolean; character: boolean } | null> => {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { return null; }
  try {
    const seed = seedSchema.parse(JSON.parse(raw));
    const empty = JSON.stringify(persona.get()) === JSON.stringify(defaultPersona());
    const usePersona = !!seed.persona && empty, useCharacter = !!seed.character && !hasCharacterProfile(character.profile());
    if (usePersona) await persona.update(personaSchema.parse({ ...defaultPersona(), ...seed.persona }));
    if (useCharacter) await character.updateProfile(seed.character!);
    return { persona: usePersona, character: useCharacter };
  } finally {
    await rm(path, { force: true });
  }
};
