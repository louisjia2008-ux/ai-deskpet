import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export const PLAYWRIGHT_MCP_VERSION = '0.0.84';
export interface PlaywrightMcpStatus { state: 'stopped' | 'starting' | 'running' | 'failed'; reasonCode?: string }
export interface PlaywrightMcpOptions {
  runtimeRoot: string;
  profileRoot: string;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnRuntime?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

/** No provider credentials or normal browser profile is inherited by the worker. */
export const playwrightMcpEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
};

/** Owns one pinned Microsoft MCP worker and one isolated browser context. */
export class PlaywrightMcpService {
  readonly #options: PlaywrightMcpOptions;
  #status: PlaywrightMcpStatus = { state: 'stopped' };
  #worker: ChildProcessWithoutNullStreams | null = null;
  #endpoint: string | null = null;
  #generation = 0;
  #starting: Promise<string> | null = null;
  #rejectStartup: ((error: Error) => void) | null = null;
  #stopping: Promise<void> | null = null;
  constructor(options: PlaywrightMcpOptions) { this.#options = options; }
  status(): PlaywrightMcpStatus { return { ...this.#status }; }
  async ensureStarted(): Promise<string> {
    if (this.#stopping) await this.#stopping;
    if (this.#worker && this.#status.reasonCode === 'extensions.playwrightStopUnconfirmed') throw new Error('extensions.playwrightStopUnconfirmed');
    if (this.#endpoint && this.#worker) return this.#endpoint;
    if (this.#starting) return this.#starting;
    const generation = ++this.#generation;
    this.#status = { state: 'starting' };
    const start = this.#start(generation).catch(error => {
      if (generation === this.#generation) {
        this.#endpoint = null;
        this.#status = { state: 'failed', reasonCode: error instanceof Error && error.message === 'extensions.playwrightBrowserMissing' ? error.message : 'extensions.playwrightUnavailable' };
        this.#worker?.kill('SIGTERM');
      }
      throw new Error(error instanceof Error && error.message === 'extensions.playwrightBrowserMissing' ? error.message : 'extensions.playwrightUnavailable');
    }).finally(() => { if (this.#starting === start) this.#starting = null; });
    this.#starting = start;
    return start;
  }
  async #start(generation: number): Promise<string> {
    const root = this.#options.runtimeRoot;
    const metadata = JSON.parse(await readFile(join(root, 'node_modules', '@playwright', 'mcp', 'package.json'), 'utf8')) as { version?: unknown };
    if (metadata.version !== PLAYWRIGHT_MCP_VERSION) throw new Error('extensions.playwrightUnavailable');
    const script = join(root, 'server.cjs');
    await access(script, constants.R_OK);
    const workspace = join(this.#options.profileRoot, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    if (generation !== this.#generation) throw new Error('extensions.playwrightUnavailable');
    return new Promise<string>((resolve, reject) => {
      let settled = false, buffer = '';
      const finish = (error?: Error, endpoint?: string): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.#rejectStartup = null;
        if (error) reject(error); else resolve(endpoint!);
      };
      const timer = setTimeout(() => finish(new Error('extensions.playwrightUnavailable')), this.#options.startupTimeoutMs ?? 15000);
      this.#rejectStartup = error => finish(error);
      try {
        const create = this.#options.spawnRuntime ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }));
        // The worker launches Playwright's bundled headless shell, never the
        // user's installed Chrome, and reports when that browser is missing.
        const worker = create(this.#options.executablePath ?? process.execPath, [script, workspace], {
          cwd: workspace, env: playwrightMcpEnvironment(this.#options.environment ?? process.env), windowsHide: true,
        });
        this.#worker = worker;
        worker.stdout.on('data', (chunk: Buffer | string) => {
          if (generation !== this.#generation || settled) return;
          buffer += String(chunk);
          if (buffer.length > 16000) { finish(new Error('extensions.playwrightUnavailable')); return; }
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          try {
            const message = JSON.parse(buffer.slice(0, newline)) as { type?: unknown; endpoint?: unknown; version?: unknown };
            if (message.type === 'browserMissing') { finish(new Error('extensions.playwrightBrowserMissing')); return; }
            if (message.type !== 'ready' || message.version !== PLAYWRIGHT_MCP_VERSION || typeof message.endpoint !== 'string') throw new Error();
            const url = new URL(message.endpoint);
            if (url.origin !== 'http://127.0.0.1:' + url.port || Number(url.port) < 1024 || !/^\/mcp\/[a-f0-9]{64}$/u.test(url.pathname) || url.search || url.hash) throw new Error();
            this.#endpoint = message.endpoint;
            this.#status = { state: 'running' };
            finish(undefined, message.endpoint);
          } catch { finish(new Error('extensions.playwrightUnavailable')); }
        });
        // Raw browser output can contain page titles, URLs and local paths.
        // Drain it without copying it into diagnostics, logs or renderer state.
        worker.stderr.on('data', () => undefined);
        worker.stdin.on('error', () => { if (generation === this.#generation) finish(new Error('extensions.playwrightUnavailable')); });
        worker.once('error', () => { if (generation === this.#generation) finish(new Error('extensions.playwrightUnavailable')); });
        worker.once('exit', () => {
          if (this.#worker === worker) this.#worker = null;
          if (generation !== this.#generation) return;
          // Keep a more specific startup failure, such as a missing browser.
          this.#endpoint = null; if (this.#status.state !== 'failed') this.#status = { state: 'failed', reasonCode: 'extensions.playwrightUnavailable' };
          finish(new Error('extensions.playwrightUnavailable'));
        });
      } catch { finish(new Error('extensions.playwrightUnavailable')); }
    });
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    ++this.#generation;
    this.#endpoint = null;
    this.#rejectStartup?.(new Error('extensions.playwrightUnavailable'));
    this.#rejectStartup = null;
    const worker = this.#worker;
    const stop = (async () => {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          let forcedTimer: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            worker.kill('SIGKILL');
            forcedTimer = setTimeout(() => reject(new Error('extensions.playwrightStopUnconfirmed')), 1000);
          }, this.#options.stopTimeoutMs ?? 3000);
          worker.once('exit', () => { clearTimeout(timer); clearTimeout(forcedTimer); resolve(); });
          worker.stdin.end();
          worker.kill('SIGTERM');
        });
      }
      if (this.#worker === worker) this.#worker = null;
      this.#status = { state: 'stopped' };
    })().catch(() => {
      this.#status = { state: 'failed', reasonCode: 'extensions.playwrightStopUnconfirmed' };
      throw new Error('extensions.playwrightStopUnconfirmed');
    }).finally(() => { if (this.#stopping === stop) this.#stopping = null; });
    this.#stopping = stop;
    return stop;
  }
  dispose(): Promise<void> { return this.stop(); }
}
