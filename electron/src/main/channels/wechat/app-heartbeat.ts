import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../persistence/atomic-file';

/** Only the installed, non-isolated DeskPet instance writes to the listener runtime. */
export class AppHeartbeat {
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;

  constructor(private readonly runtime: string) {}

  start(): void {
    if (this.#timer || this.#stopping) return;
    const beat = () => {
      this.#pending ??= this.#write('running').catch(() => undefined).finally(() => { this.#pending = null; });
    };
    beat();
    this.#timer = setInterval(beat, 60_000);
    this.#timer.unref();
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (!this.#timer) return Promise.resolve();
    clearInterval(this.#timer);
    this.#timer = null;
    this.#stopping = Promise.resolve(this.#pending).then(() => this.#write('stopped')).catch(() => undefined);
    return this.#stopping;
  }

  async #write(state: 'running' | 'stopped'): Promise<void> {
    const root = await lstat(this.runtime);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700) return;
    const body = { at: Math.floor(Date.now() / 1000), pid: process.pid, state };
    await atomicWriteFile(join(this.runtime, 'app-heartbeat.json'), JSON.stringify(body), { createDirectory: false });
  }
}
