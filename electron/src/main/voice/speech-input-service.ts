import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AtomicJsonStore } from '../persistence';
import { ASR_MODEL, defaultSpeechInputSettings, speechInputSettingsSchema, speechPcmSchema } from '../../shared/speech-input';
import type { SpeechInputSettings, SpeechInputStatus } from '../../shared/speech-input';

interface Options {
  settingsPath: string; workerScript: string; runtimeDir(): string | null;
  beforeStart(): Promise<void>; spawn?: typeof spawn; idleMs?: number; timeoutMs?: number;
}

/** One bounded in-memory PCM request. Audio is never written to disk or sent to a provider. */
export class SpeechInputService {
  readonly #store: AtomicJsonStore<SpeechInputSettings>;
  #settings = defaultSpeechInputSettings();
  #child: ChildProcessWithoutNullStreams | null = null;
  #stopping: Promise<void> = Promise.resolve();
  #pending: { id: string; resolve(text: string): void; reject(error: Error): void; timer: NodeJS.Timeout } | null = null;
  #idle: NodeJS.Timeout | null = null;
  #ready = false;
  #generation = 0;
  #lastSuccessAt: string | null = null;
  #lastFailureAt: string | null = null;
  #errorCode: string | null = null;

  constructor(private readonly options: Options) {
    this.#store = new AtomicJsonStore({ path: options.settingsPath, schemaVersion: 1, schema: speechInputSettingsSchema, defaultValue: defaultSpeechInputSettings });
  }
  async initialize(): Promise<void> { this.#settings = await this.#store.load(); }
  status(): SpeechInputStatus {
    return { ...this.#settings, state: this.#errorCode ? 'error' : this.#pending ? this.#ready ? 'transcribing' : 'loading' : this.#ready ? 'ready' : 'idle',
      lastSuccessAt: this.#lastSuccessAt, lastFailureAt: this.#lastFailureAt, errorCode: this.#errorCode };
  }
  async configure(settings: SpeechInputSettings): Promise<SpeechInputStatus> {
    const next = speechInputSettingsSchema.parse(settings); await this.#store.save(next); this.#settings = next; return this.status();
  }
  problem(code: string): void { this.#errorCode = code; this.#lastFailureAt = new Date().toISOString(); }

  async transcribe(raw: string): Promise<string> {
    const { pcm } = speechPcmSchema.parse({ pcm: raw });
    const data = Buffer.from(pcm, 'base64');
    if (data.length < 8_000 || data.length > 1_920_000 || data.length % 2 || data.toString('base64') !== pcm) throw new Error('asr.audioInvalid');
    if (this.#pending) throw new Error('asr.busy');
    const generation = this.#generation;
    let settle!: (text: string) => void, fail!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
    // Attach a handler before any asynchronous setup can fail or cancel the request.
    void result.catch(() => undefined);
    const id = randomUUID();
    const timer = setTimeout(() => { this.#fail('asr.timeout'); void this.release(); }, this.options.timeoutMs ?? 120_000);
    timer.unref();
    this.#pending = { id, resolve: settle, reject: fail, timer }; this.#errorCode = null;
    if (this.#idle) clearTimeout(this.#idle);
    try {
      await this.#stopping;
      await this.options.beforeStart();
      if (generation !== this.#generation) throw new Error('asr.cancelled');
      if (!this.#child) {
        const dir = this.options.runtimeDir();
        if (!dir || !isAbsolute(dir)) throw new Error('asr.folder');
        for (const path of [join(dir, '.venv/bin/python'), join(dir, 'hf/hub', `models--${ASR_MODEL.replace('/', '--')}`, 'snapshots')]) await stat(path);
        if (generation !== this.#generation) throw new Error('asr.cancelled');
        this.#start(dir);
      }
      this.#child!.stdin.write(JSON.stringify({ id, pcm, rate: 16_000 }) + '\n');
    } catch (error) {
      if (this.#pending?.id === id) this.#fail(error instanceof Error && /^asr\./u.test(error.message) ? error.message : 'asr.runtime');
    }
    return result;
  }
  #start(dir: string): void {
    const child = (this.options.spawn ?? spawn)(join(dir, '.venv/bin/python'), ['-I', '-B', this.options.workerScript, ASR_MODEL, '--pcm'], {
      cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: homedir(), HF_HOME: join(dir, 'hf'), HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child; this.#ready = false; child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdin.on('error', () => { if (this.#child === child) this.#fail('asr.worker'); });
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      if (child !== this.#child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32_768) { this.#fail('asr.protocol'); void this.release(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); this.#receive(line); }
    });
    const exited = () => { if (this.#child === child) { this.#child = null; this.#ready = false; this.#fail('asr.worker'); } };
    child.once('error', exited); child.once('exit', exited);
  }
  #receive(line: string): void {
    let value: { ready?: boolean; id?: string; text?: string; error?: string };
    try { value = JSON.parse(line) as typeof value; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
    catch { this.#fail('asr.protocol'); void this.release(); return; }
    if (value.ready === true) { this.#ready = true; return; }
    const pending = this.#pending;
    if (!pending || value.id !== pending.id) return;
    if (typeof value.text !== 'string' || value.text.length > 8_000 || !value.text.trim() || /[\p{Cc}]/u.test(value.text.replace(/[\n\r\t]/gu, ''))) { this.#fail('asr.transcription'); return; }
    clearTimeout(pending.timer); this.#pending = null; this.#errorCode = null; this.#lastSuccessAt = new Date().toISOString();
    pending.resolve(value.text.trim()); this.#armIdle();
  }
  #fail(code: string): void {
    if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(new Error(code)); this.#pending = null; }
    this.problem(code); this.#armIdle();
  }
  #armIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#child) { this.#idle = setTimeout(() => void this.release(), this.options.idleMs ?? 600_000); this.#idle.unref(); }
  }
  async release(): Promise<void> {
    this.#generation++;
    if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(new Error('asr.cancelled')); this.#pending = null; }
    if (this.#idle) clearTimeout(this.#idle); this.#idle = null;
    const child = this.#child; this.#child = null; this.#ready = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.#stopping;
    this.#stopping = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); child.kill('SIGKILL'); });
    await this.#stopping;
  }
}
