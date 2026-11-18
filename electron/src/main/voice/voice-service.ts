import { spawn as spawnProcess } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AtomicJsonStore } from '../persistence';
import { VOICE_MODEL, defaultVoiceSettings, speakableText, voiceSettingsSchema } from '../../shared/voice';
import type { VoiceChunk, VoiceProblem, VoiceSettings, VoiceStatus } from '../../shared/voice';

const IDLE_UNLOAD_MS = 10 * 60_000;
const EXIT_GRACE_MS = 5_000;

const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile() && info.size > 0, () => false);
const isDirectory = (path: string): Promise<boolean> => stat(path).then((info) => info.isDirectory(), () => false);

/** What the owner's folder still lacks, checked before the worker is ever started. */
export const checkVoiceRuntime = async (dir: string | null): Promise<VoiceProblem | null> => {
  if (dir === null || !isAbsolute(dir) || !await isDirectory(dir)) return 'folder';
  if (!await isFile(join(dir, '.venv', 'bin', 'python'))) return 'python';
  if (!await isDirectory(join(dir, 'hf', 'hub', `models--${VOICE_MODEL.replace('/', '--')}`, 'snapshots'))) return 'model';
  if (!await isFile(join(dir, 'voice', 'reference.wav')) || !await isFile(join(dir, 'voice', 'reference.txt'))) return 'reference';
  return null;
};

type Options = {
  settingsPath: string;
  workerScript: string;
  /** Speech for the overlay to play. */
  send(chunk: VoiceChunk): void;
  spawn?: typeof spawnProcess;
  idleMs?: number;
};

/**
 * Runs the local speech worker only while she is talking or has just talked, so the
 * model's memory comes back when she is quiet. One reply at a time: a new one cuts off the last.
 */
export class VoiceService {
  readonly #store: AtomicJsonStore<VoiceSettings>;
  #settings = defaultVoiceSettings();
  #problem: VoiceProblem | null = 'folder';
  #child: ChildProcessWithoutNullStreams | null = null;
  #terminating: ChildProcessWithoutNullStreams | null = null;
  #stopping: Promise<void> = Promise.resolve();
  #ready = false;
  #current: string | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #workerFailed = false;

  constructor(private readonly options: Options) {
    this.#store = new AtomicJsonStore({ path: options.settingsPath, schemaVersion: 1, schema: voiceSettingsSchema, defaultValue: defaultVoiceSettings });
  }

  async initialize(): Promise<void> {
    this.#settings = await this.#store.load();
    this.#problem = await checkVoiceRuntime(this.#settings.runtimeDir);
  }

  status(): VoiceStatus {
    const state: VoiceStatus['state'] = !this.#settings.enabled ? 'off'
      : this.#problem !== null ? 'missing'
        : this.#workerFailed ? 'error'
          : this.#child === null ? 'idle'
            : !this.#ready ? 'loading'
              : this.#current !== null ? 'speaking' : 'ready';
    return { ...this.#settings, state, problem: this.#problem ?? (this.#workerFailed ? 'worker' : null) };
  }

  async update(patch: Partial<VoiceSettings>): Promise<VoiceStatus> {
    const next = voiceSettingsSchema.parse({ ...this.#settings, ...patch });
    await this.#store.save(next);
    const moved = next.runtimeDir !== this.#settings.runtimeDir;
    this.#settings = next;
    this.#problem = await checkVoiceRuntime(next.runtimeDir);
    this.#workerFailed = false;
    if (!next.enabled || moved) this.#shutdown();
    return this.status();
  }

  /** Say a finished reply. Returns false when there is nothing to say or voice is off. */
  speak(text: string): boolean {
    const spoken = speakableText(text);
    if (this.#terminating || !this.#settings.enabled || this.#problem !== null || this.#settings.runtimeDir === null || spoken.length === 0) return false;
    this.stop();
    const child = this.#child ?? this.#start(this.#settings.runtimeDir);
    const id = randomUUID();
    this.#current = id;
    this.#clearIdle();
    child.stdin.write(`${JSON.stringify({ id, text: spoken })}\n`);
    return true;
  }

  /** Cut her off: the owner started a new message, or turned voice off. */
  stop(): void {
    if (this.#current === null) return;
    this.#child?.stdin.write(`${JSON.stringify({ cancel: this.#current })}\n`);
    this.#current = null;
    this.options.send({ id: null, stop: true });
    this.#armIdle();
  }

  dispose(): void { this.#shutdown(); }

  /** Before loading ASR: wait until TTS has really exited, not just stopped playback. */
  async release(): Promise<void> {
    this.#shutdown();
    const child = this.#terminating;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await this.#stopping;
  }

  #start(dir: string): ChildProcessWithoutNullStreams {
    const child = (this.options.spawn ?? spawnProcess)(join(dir, '.venv', 'bin', 'python'), ['-I', '-B', this.options.workerScript, VOICE_MODEL], {
      cwd: dir,
      // Nothing from the app's environment: offline, its own model cache only.
      env: { PATH: '/usr/bin:/bin', HOME: homedir(), HF_HOME: join(dir, 'hf'), HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#ready = false;
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    createInterface({ input: child.stdout }).on('line', (line) => this.#receive(child, line));
    child.on('error', () => this.#exited(child));
    child.on('exit', () => this.#exited(child));
    return child;
  }

  #receive(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.#child) return;
    let message: { ready?: unknown; id?: unknown; pcm?: unknown; rate?: unknown; done?: unknown; error?: unknown };
    try { message = JSON.parse(line) as typeof message; }
    catch { return; }
    if (message.ready === true) { this.#ready = true; return; }
    if (typeof message.id !== 'string' || message.id !== this.#current) return;
    if (typeof message.pcm === 'string' && typeof message.rate === 'number') {
      this.options.send({ id: message.id, pcm: message.pcm, rate: message.rate });
      return;
    }
    if (message.done === true || typeof message.error === 'string') {
      this.options.send({ id: message.id, done: true });
      this.#current = null;
      this.#armIdle();
    }
  }

  #exited(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.#child) return;
    // Dying before it ever loaded is a broken setup; a later exit is just the idle unload.
    if (!this.#ready) this.#workerFailed = true;
    if (this.#current !== null) this.options.send({ id: null, stop: true });
    this.#child = null;
    this.#ready = false;
    this.#current = null;
    this.#clearIdle();
  }

  #armIdle(): void {
    this.#clearIdle();
    if (this.#child === null) return;
    this.#idle = setTimeout(() => this.#shutdown(), this.options.idleMs ?? IDLE_UNLOAD_MS);
    this.#idle.unref?.();
  }

  #clearIdle(): void {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
  }

  #shutdown(): void {
    this.#clearIdle();
    const child = this.#child;
    if (child === null) return;
    if (this.#current !== null) this.options.send({ id: null, stop: true });
    this.#child = null;
    this.#ready = false;
    this.#current = null;
    this.#terminating = child;
    this.#stopping = new Promise<void>(resolve => {
      const exited = (): void => { if (this.#terminating === child) this.#terminating = null; resolve(); };
      child.once('exit', exited); child.once('error', exited);
      if (child.exitCode !== null || child.signalCode !== null) exited();
    });
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, EXIT_GRACE_MS).unref?.();
  }
}
