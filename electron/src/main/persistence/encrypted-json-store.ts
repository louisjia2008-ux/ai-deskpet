import { access, readFile, rename } from 'node:fs/promises';
import type { z } from 'zod';

import { atomicWriteFile, removeAbandonedTemporaryFiles } from './atomic-file';
import { decryptJson, encryptJson } from './encryption';
import { PersistenceCorruptionError } from './errors';
import { assertNoQuarantinedData } from './quarantine';

export interface VaultKeyProvider {
  getVaultKey(): Promise<Buffer>;
}

export interface EncryptedJsonStoreOptions<T> {
  path: string;
  schema: z.ZodType<T>;
  defaultValue: () => T;
  vault: VaultKeyProvider;
}

/** An attempted atomic write can fail before or after the commit rename. */
export class EncryptedStoreWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Encrypted store write failed.', { cause });
    this.name = 'EncryptedStoreWriteError';
  }
}

export class EncryptedJsonStore<T> {
  #abandonedFilesRemoved = false;
  #hasPersistedValue = false;
  readonly #options: EncryptedJsonStoreOptions<T>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: EncryptedJsonStoreOptions<T>) {
    this.#options = options;
  }

  get hasPersistedValue(): boolean { return this.#hasPersistedValue; }

  async load(): Promise<T> {
    try {
      await access(this.#options.path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await assertNoQuarantinedData(this.#options.path);
        return this.#options.defaultValue();
      }
      throw error;
    }

    // Storage/keychain availability is not evidence of corrupt ciphertext.
    // Keep the original file in place so the next unlock/restart can retry it.
    const [serialized, key] = await Promise.all([
      readFile(this.#options.path, 'utf8'),
      this.#options.vault.getVaultKey(),
    ]);
    if (key.byteLength !== 32) throw new Error('Vault key must be exactly 32 bytes.');
    try {
      const value = decryptJson(JSON.parse(serialized), key, this.#options.schema);
      this.#hasPersistedValue = true;
      return value;
    } catch (error) {
      const quarantinedPath = `${this.#options.path}.corrupt-${Date.now()}`;
      await rename(this.#options.path, quarantinedPath);
      throw new PersistenceCorruptionError('Encrypted data failed authentication or validation.', quarantinedPath, {
        cause: error,
      });
    }
  }

  async save(value: T): Promise<void> {
    const validated = this.#options.schema.parse(value);
    const key = await this.#options.vault.getVaultKey();
    const serialized = `${JSON.stringify(encryptJson(validated, key))}\n`;
    const write = async (): Promise<void> => {
      try { await atomicWriteFile(this.#options.path, serialized); }
      catch (error) { throw new EncryptedStoreWriteError(error); }
      // Only after a real write, so read-only profile inspection changes nothing.
      if (!this.#abandonedFilesRemoved) { this.#abandonedFilesRemoved = true; await removeAbandonedTemporaryFiles(this.#options.path); }
    };
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
    this.#hasPersistedValue = true;
  }

  /** Read the authority after an uncertain write without quarantining or creating data. */
  async readPersisted(): Promise<T | null> {
    let serialized: string;
    try { serialized = await readFile(this.#options.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const key = await this.#options.vault.getVaultKey();
    const value = decryptJson(JSON.parse(serialized), key, this.#options.schema);
    this.#hasPersistedValue = true;
    return value;
  }
}
