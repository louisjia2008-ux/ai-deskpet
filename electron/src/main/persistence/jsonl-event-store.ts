import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';

import { atomicWriteFile } from './atomic-file';

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class JsonlEventStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  #writeQueue: Promise<void> = Promise.resolve();
  recovery: { retained: number; quarantinedPath: string } | null = null;

  constructor(path: string, schema: z.ZodType<T>) {
    this.#path = path;
    this.#schema = schema;
  }

  async append(event: T): Promise<void> {
    const validated = this.#schema.parse(event);
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600 });
    };
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }

  async readAll(): Promise<T[]> {
    const read = this.#writeQueue.then(() => this.#readAll(), () => this.#readAll());
    this.#writeQueue = read.then(() => undefined, () => undefined);
    return read;
  }

  async #readAll(): Promise<T[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    const valid: T[] = [];
    for (const line of contents.split('\n').filter((value) => value.length > 0)) {
      try { valid.push(this.#schema.parse(JSON.parse(line))); }
      catch {
        const quarantinedPath = `${this.#path}.corrupt-${Date.now()}`;
        await atomicWriteFile(quarantinedPath, contents);
        await atomicWriteFile(this.#path, valid.map((event) => `${JSON.stringify(event)}\n`).join(''));
        this.recovery = { retained: valid.length, quarantinedPath };
        break;
      }
    }
    return valid;
  }
}
