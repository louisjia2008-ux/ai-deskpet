import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER_INFO = /^\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (.+)$/u;
const PLAYER_EVENT = /^([A-Za-z0-9_]{1,16}) (joined|left) the game$/u;
const PLAYER_LIST = /^There are \d+ of a max of \d+ players online:(.*)$/u;

export const DEDICATED_READY = /^Done \([\d.]+s\)! For help, type "help"$/u;

/** Commands are only hard-coded strings and acknowledgements only match server-thread output. */
export class MinecraftDedicatedConsole {
  readonly exit: Promise<void>;
  readonly #waiters = new Set<(line: string | null) => void>();
  #closed = false;
  #lastError: string | null = null;
  stopping = false;

  constructor(readonly child: ChildProcessWithoutNullStreams, onPlayers: (event: { name: string; joined: boolean } | string[]) => void) {
    this.exit = new Promise<void>((resolve) => {
      child.once('error', (error) => { this.#lastError = error.message; });
      child.once('close', (code, signal) => {
        this.#closed = true;
        this.#lastError ??= `Minecraft server exited (${signal ?? code ?? 'unknown result'}).`;
        for (const waiter of this.#waiters) waiter(null);
        resolve();
      });
    });
    child.stdin.on('error', (error) => { this.#lastError = error.message; });
    createInterface({ input: child.stdout }).on('line', (line: string) => {
      // Java server diagnostics may contain player chat. Use only console-shaped state messages.
      const info = SERVER_INFO.exec(line)?.[1];
      if (!info) return;
      for (const waiter of this.#waiters) waiter(info);
      const player = PLAYER_EVENT.exec(info);
      if (player?.[1]) onPlayers({ name: player[1], joined: player[2] === 'joined' });
      const names = PLAYER_LIST.exec(info)?.[1];
      if (names !== undefined) onPlayers(names.split(',').map(name => name.trim()).filter(name => /^[A-Za-z0-9_]{1,16}$/u.test(name)));
    });
    // Java launcher errors such as an invalid runtime or failed bind give the UI useful context.
    createInterface({ input: child.stderr }).on('line', (line: string) => {
      if (line.trim()) this.#lastError = line.trim().slice(0, 300);
    });
  }

  get closed(): boolean { return this.#closed; }
  get error(): string | null { return this.#lastError; }

  send(command: string): void {
    if (this.#closed || !this.child.stdin.writable) throw new Error('Minecraft server console is unavailable.');
    this.child.stdin.write(`${command}\n`);
  }

  waitFor(pattern: RegExp, timeoutMs: number, description: string, signal?: AbortSignal, command?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (error?: Error) => {
        this.#waiters.delete(onLine);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onLine = (line: string | null) => {
        if (line === null) settle(new Error(this.#lastError ?? 'Minecraft server console closed.'));
        else if (pattern.test(line)) settle();
      };
      const onAbort = () => settle(new Error('Minecraft server operation was stopped.'));
      const timer = setTimeout(() => settle(new Error(`Minecraft server did not acknowledge ${description}.`)), timeoutMs);
      this.#waiters.add(onLine);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (this.#closed) { onLine(null); return; }
      try { if (command) this.send(command); }
      catch (error) { settle(error instanceof Error ? error : new Error('Minecraft server command failed.')); }
    });
  }
}
