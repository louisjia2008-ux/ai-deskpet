import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../persistence/encrypted-json-store';
import { defaultPersona, personaSchema } from '../../shared/persona';
import type { Persona } from '../../shared/persona';

/** Its own file, so the main profile schema and a rollback to an older build stay untouched. */
export class PersonaStore {
  readonly #store: EncryptedJsonStore<Persona>;
  #persona = defaultPersona();

  constructor(path: string, vault: VaultKeyProvider) {
    this.#store = new EncryptedJsonStore({ path, vault, schema: personaSchema, defaultValue: defaultPersona });
  }

  async initialize(): Promise<void> { this.#persona = await this.#store.load(); }
  get(): Persona { return structuredClone(this.#persona); }

  async update(input: Persona): Promise<Persona> {
    const parsed = personaSchema.parse(input);
    await this.#store.save(parsed);
    this.#persona = parsed;
    return this.get();
  }
}
