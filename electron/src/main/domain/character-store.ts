import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../persistence/encrypted-json-store';
import { characterFileSchema, characterProfileSchema, defaultCharacterFile } from '../../shared/character';
import type { CharacterFile, CharacterProfile, CharacterState } from '../../shared/character';
import type { CharacterMood } from '../../shared/character-reactions';

/** Its own file, like the persona, so the profile schema and a rollback to an older build stay untouched. */
export class CharacterStore {
  readonly #store: EncryptedJsonStore<CharacterFile>;
  #value = defaultCharacterFile();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(path: string, vault: VaultKeyProvider, private readonly now: () => Date = () => new Date()) {
    this.#store = new EncryptedJsonStore({ path, vault, schema: characterFileSchema, defaultValue: defaultCharacterFile });
  }

  async initialize(): Promise<void> { this.#value = await this.#store.load(); }
  profile(): CharacterProfile { return structuredClone(this.#value.profile); }
  state(): CharacterState { return structuredClone(this.#value.state); }

  async updateProfile(input: CharacterProfile): Promise<CharacterProfile> {
    const profile = characterProfileSchema.parse(input);
    await this.#write((value) => ({ ...value, profile }));
    return this.profile();
  }

  /** An owner turn has finished: the next one measures the gap from here. */
  noteOwnerTurn(): Promise<void> {
    const at = this.now().toISOString();
    return this.#write((value) => ({ ...value, state: { ...value.state, lastOwnerTurnAt: at } }));
  }

  noteMood(name: CharacterMood): Promise<void> {
    const at = this.now().toISOString();
    return this.#write((value) => ({ ...value, state: { ...value.state, mood: { name, at } } }));
  }

  // One write at a time, each from the latest value, so a mood and a turn cannot overwrite each other.
  #write(change: (value: CharacterFile) => CharacterFile): Promise<void> {
    const next = this.#writes.then(async () => {
      const value = characterFileSchema.parse(change(structuredClone(this.#value)));
      await this.#store.save(value);
      this.#value = value;
    });
    this.#writes = next.catch(() => undefined);
    return next;
  }
}
