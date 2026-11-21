import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { initialMinecraftCompanionSnapshot, minecraftCompanionConfigSchema, minecraftCompanionPolicySchema, minecraftCompanionTaskSchema } from '../../shared/minecraft-companion';
import type { MinecraftAutonomyRange } from '../../shared/minecraft-dedicated';
import type { MinecraftCompanionConfig, MinecraftCompanionEngine, MinecraftCompanionObservation, MinecraftCompanionPolicy, MinecraftCompanionSnapshot, MinecraftCompanionTask, MinecraftCompanionTaskInput } from '../../shared/minecraft-companion';
import { minecraftAutonomyRangeSchema, minecraftAutonomyStatusSchema, minecraftSurveyPlanStatusSchema } from '../../shared/minecraft-dedicated';
import type { MinecraftSurveyPlanStatus } from '../../shared/minecraft-dedicated';
import { adaptationHelpSchema } from './adaptation-choice';
import type { MinecraftAdaptationHelp } from './adaptation-choice';

const MAX_LINE_BYTES = 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 2000): string | null => typeof value === 'string' ? value.slice(0, max) : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message.slice(0, 2000) : 'Minecraft Companion request failed.';
const errorText = (value: unknown): string => text(value) ?? text(record(value)?.message) ?? 'Minecraft Companion request failed.';
class SurveyOwnsBody extends Error {}

/** Keep engine counters data-only and bounded, including unusually deep/malformed plugin output. */
function boundedData(value: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => boundedData(item, depth + 1));
  const object = record(value);
  return object ? Object.fromEntries(Object.entries(object).slice(0, 64).map(([key, item]) => [key.slice(0, 80), boundedData(item, depth + 1)])) : null;
}

export interface MinecraftCompanionServiceOptions {
  /** Absolute path to the complete production runtime's index.js, outside ASAR. */
  runtimePath: string;
  /** An independent Companion profile; never the legacy worker's data directory. */
  dataDirectory: string;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  spawnRuntime?(executable: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  onChanged?(snapshot: MinecraftCompanionSnapshot): void;
  /** Raw in-game chat from other players. Untrusted: the parent decides whether it is addressed and authorized. */
  onPlayerChat?(chat: { username: string; message: string }): void;
  /** A task reached completed, failed or cancelled (once per task). */
  onTaskFinished?(task: MinecraftCompanionTask): void;
  onSurveyPlan?(event: { worldId: string; initial: boolean; plan: MinecraftSurveyPlanStatus | null }): void;
  onManagedReview?(event: { reason: 'death' | 'task_failure'; detail: string }): void;
  onAdaptationHelp?(request: MinecraftAdaptationHelp): Promise<string | null>;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  /** A healthy helper answers a status read in milliseconds; this long means it is stuck. */
  statusTimeoutMs?: number;
}

// Status reads in a row that went unanswered before the helper counts as hung.
const STALLED_STATUS_READS = 3;

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Dispatch {
  id: string;
  sent: boolean;
  joined: Promise<void>;
  finish(): void;
}

/** Provider keys, NODE_OPTIONS and unrelated application configuration never cross this boundary. */
export function minecraftCompanionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA']);
  return { ...Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.has(key) && value !== undefined)), ELECTRON_RUN_AS_NODE: '1' };
}

/** Structured core JSONL adapter. Dispatch, body retirement and task completion remain separate. */
export class MinecraftCompanionService {
  readonly #options: MinecraftCompanionServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #taskRequests = new Set<string>();
  #state = initialMinecraftCompanionSnapshot();
  #worker: ChildProcessWithoutNullStreams | null = null;
  #generation = 0;
  #buffer = Buffer.alloc(0);
  #disposed = false;
  #connecting = false;
  #starting = false;
  #dispatchRequestId: string | null = null;
  #dispatch: Dispatch | null = null;
  #closing: Promise<MinecraftCompanionSnapshot> | null = null;
  #cancelling: Promise<MinecraftCompanionSnapshot> | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #statusMisses = 0;
  #stalled = false;
  #ready: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  #exit: Promise<void> = Promise.resolve();

  constructor(options: MinecraftCompanionServiceOptions) {
    if (!isAbsolute(options.runtimePath) || !isAbsolute(options.dataDirectory)) throw new Error('Companion runtime and profile paths must be absolute.');
    this.#options = options;
  }

  getState(): MinecraftCompanionSnapshot { return structuredClone(this.#state); }

  async connect(input: MinecraftCompanionConfig, guard?: () => void, managed?: { dataDirectory: string; execute: boolean; autonomyRange?: MinecraftAutonomyRange }): Promise<MinecraftCompanionSnapshot> {
    guard?.();
    if (this.#disposed) throw new Error('Minecraft Companion service is disposed.');
    if (this.#worker || this.#connecting || this.#closing) throw new Error('Disconnect the current Companion connection before connecting again.');
    const config = minecraftCompanionConfigSchema.parse(input);
    if (managed && (!isAbsolute(managed.dataDirectory) || config.host !== '127.0.0.1' || config.auth !== 'offline')) {
      throw new Error('The managed Minecraft helper requires the local dedicated world.');
    }
    this.#connecting = true;
    const generation = ++this.#generation;
    this.#stalled = false; this.#statusMisses = 0;
    this.#state = { ...initialMinecraftCompanionSnapshot(), runtimeState: 'starting', config };
    this.#publish();
    try {
      await mkdir(managed?.dataDirectory ?? this.#options.dataDirectory, { recursive: true, mode: 0o700 });
      this.#assertCurrent(generation); guard?.();
      await this.#launch(generation, managed);
      this.#assertCurrent(generation); guard?.();
      // An empty owner name means in-game commands are off; the core takes the same field.
      await this.#request({ type: 'connect', config: { ...config, ownerName: config.ownerName || undefined, ...(managed?.autonomyRange ? { autonomyRange: managed.autonomyRange } : {}) } }, guard);
      this.#assertCurrent(generation); guard?.();
      return this.getState();
    } catch (error) {
      if (generation === this.#generation) {
        this.#state.lastError = errorMessage(error);
        this.#publish();
        // An aborted connection setup must not leave a world connection running.
        await this.disconnect();
      }
      throw error;
    } finally { this.#connecting = false; }
  }

  async start(input: MinecraftCompanionTaskInput, guard?: () => void): Promise<MinecraftCompanionSnapshot> {
    guard?.();
    const task = minecraftCompanionTaskSchema.parse(input);
    if (this.#disposed || this.#state.connectionState !== 'ready' || this.#closing) throw new Error('Minecraft Companion 尚未进入世界。');
    if (['confirmed', 'running', 'paused'].some(status => this.#state.plan?.status === status)) {
      throw new SurveyOwnsBody('The Minecraft owner controls the active survey from the wand menu.');
    }
    if (this.#starting || this.#state.controlPending || (this.#state.task && !TERMINAL.has(this.#state.task.status))) throw new Error('Minecraft Companion already has an active task.');
    this.#starting = true;
    const generation = this.#generation;
    const id = randomUUID();
    this.#dispatchRequestId = id;
    let finish = (): void => {};
    const joined = new Promise<void>((resolve) => { finish = resolve; });
    const dispatch: Dispatch = { id, sent: false, joined, finish };
    this.#dispatch = dispatch;
    this.#taskRequests.add(id);
    if (this.#taskRequests.size > 256) this.#taskRequests.delete(this.#taskRequests.values().next().value as string);
    try {
      try {
        const result = await this.#request({ type: 'tool', name: task.name, arguments: task.parameters }, guard, id, undefined, () => { dispatch.sent = true; });
        this.#assertCurrent(generation);
        this.#acceptTask(result.task);
      } finally { dispatch.finish(); }
      guard?.();
      this.#publish();
      return this.getState();
    } catch (error) {
      if (dispatch.sent && !(error instanceof SurveyOwnsBody)) {
        try { await this.cancel(); } catch { await this.disconnect(); }
      }
      this.#state.lastError = errorMessage(error); this.#publish(); throw error;
    } finally {
      dispatch.finish();
      this.#starting = false; this.#dispatchRequestId = null;
      if (this.#dispatch === dispatch) this.#dispatch = null;
    }
  }

  /** One plain in-game chat line; never a command. */
  async say(value: string): Promise<void> {
    const line = value.replace(/\s+/gu, ' ').trim().replace(/^\/+/u, '').trim().slice(0, 256);
    if (!line) return;
    if (this.#disposed || this.#state.connectionState !== 'ready' || this.#closing) throw new Error('Minecraft Companion 尚未进入世界。');
    await this.#request({ type: 'say', text: line });
  }

  /** Risk and guard order for the survival reflexes; kept by the helper until it disconnects. */
  async setPolicy(policy: MinecraftCompanionPolicy): Promise<Required<MinecraftCompanionPolicy>> {
    const parsed = minecraftCompanionPolicySchema.parse(policy);
    if (this.#disposed || this.#state.connectionState !== 'ready' || this.#closing) throw new Error('Minecraft Companion 尚未进入世界。');
    const result = await this.#request({ type: 'tool', name: 'setPolicy', arguments: parsed });
    const applied = record(result.policy);
    return { risk: (applied?.risk ?? 'normal') as Required<MinecraftCompanionPolicy>['risk'],
      guard: (applied?.guard ?? 'self_first') as Required<MinecraftCompanionPolicy>['guard'] };
  }

  async setAutonomyRange(range: MinecraftAutonomyRange): Promise<void> {
    const selected = minecraftAutonomyRangeSchema.parse(range);
    await this.#request({ type: 'tool', name: 'setAutonomyRange', arguments: { range: selected } });
  }

  cancel(): Promise<MinecraftCompanionSnapshot> {
    if (this.#cancelling) return this.#cancelling;
    const dispatch = this.#dispatch;
    const initialTask = this.#state.task;
    if (!dispatch && (!initialTask || TERMINAL.has(initialTask.status))) return Promise.resolve(this.getState());
    this.#state.controlPending = 'cancel';
    this.#publish();
    this.#cancelling = (async () => {
      try {
        await Promise.resolve();
        if (dispatch) await dispatch.joined;
        const task = this.#state.task;
        if (dispatch?.sent && (!task || task.requestId !== dispatch.id)) {
          this.#state.lastError = 'Task dispatch outcome is unconfirmed; disconnecting the owned helper.';
          await this.disconnect();
        } else if (task && !TERMINAL.has(task.status)) {
          const result = await this.#request({ type: 'tool', name: 'cancel', arguments: { taskId: task.taskId } });
          this.#acceptTask(result.task);
        }
      } catch (error) { this.#state.lastError = errorMessage(error); throw error; }
      finally {
        this.#cancelling = null;
        if (this.#state.controlPending === 'cancel') this.#state.controlPending = null;
        this.#publish();
      }
      return this.getState();
    })();
    return this.#cancelling;
  }

  disconnect(): Promise<MinecraftCompanionSnapshot> {
    if (this.#closing) return this.#closing;
    if (!this.#worker) this.#generation += 1; // invalidate setup still awaiting mkdir, before any worker exists
    // Yield once so even the no-worker path installs its ownership promise before cleanup.
    this.#state.controlPending = 'disconnect';
    this.#stopPoll();
    this.#publish();
    this.#closing = (async () => {
      try {
        await Promise.resolve();
        if (this.#worker) {
          this.#state.runtimeState = 'stopping'; this.#publish();
          // shutdown invokes the same joined detach as disconnect, then closes the JSONL host.
          try { await this.#request({ type: 'shutdown' }, undefined, undefined, this.#options.shutdownTimeoutMs ?? 7000); }
          catch (error) { this.#state.lastError = errorMessage(error); }
          this.#worker?.stdin.end();
          if (!await this.#waitExit(this.#options.shutdownTimeoutMs ?? 7000)) {
            this.#worker?.kill('SIGTERM');
            if (!await this.#waitExit(1000)) {
              this.#worker?.kill('SIGKILL');
              if (!await this.#waitExit(1000)) throw new Error('Companion helper did not exit; a new connection remains blocked.');
            }
          }
        }
        this.#state.runtimeState = 'stopped';
        this.#state.connectionState = this.#disposed ? 'disposed' : 'disconnected';
        this.#unavailable();
      } finally { this.#state.controlPending = null; this.#closing = null; this.#publish(); }
      return this.getState();
    })();
    return this.#closing;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.disconnect();
  }

  #assertCurrent(generation: number): void {
    if (this.#disposed || generation !== this.#generation || this.#closing) throw new Error('Minecraft Companion operation was superseded.');
  }

  #publish(): void {
    this.#state.updatedAt = Date.now();
    try { this.#options.onChanged?.(this.getState()); } catch { /* UI observers do not own the body. */ }
  }

  #event(type: string, summary: string, taskId: string | null = null): void {
    this.#state.events.push({ at: Date.now(), type: type.slice(0, 80), taskId, summary: summary.slice(0, 500) });
    this.#state.events = this.#state.events.slice(-100);
  }

  #unavailable(): void {
    this.#state.observation = null; this.#state.engine = null; this.#state.auth = null; this.#state.safetyActive = false;
    if (this.#state.plan !== undefined) this.#state.plan = null;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (this.#ready) { clearTimeout(this.#ready.timer); this.#ready.reject(error); this.#ready = null; }
  }

  #launch(generation: number, managed?: { dataDirectory: string; execute: boolean; autonomyRange?: MinecraftAutonomyRange }): Promise<void> {
    this.#buffer = Buffer.alloc(0);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (generation === this.#generation) this.#transportError('Companion core handshake timed out.');
      }, this.#options.readyTimeoutMs ?? 10000);
      this.#ready = { resolve, reject, timer };
    });
    try {
      const args = [this.#options.runtimePath, '--engine', 'core', '--data-dir', managed?.dataDirectory ?? this.#options.dataDirectory];
      if (managed) args.push('--managed-world-autonomy', '--survey-plan-observe');
      if (managed?.execute) args.push('--survey-plan-execute');
      const worker = (this.#options.spawnRuntime ?? spawn)(this.#options.executablePath ?? process.execPath, args,
        { cwd: dirname(this.#options.runtimePath), env: minecraftCompanionEnvironment(this.#options.environment ?? process.env), stdio: 'pipe', windowsHide: true });
      this.#worker = worker;
      this.#exit = new Promise<void>((resolve) => {
        let exited = false;
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (exited) return; exited = true; resolve();
          if (generation !== this.#generation || this.#worker !== worker) return;
          this.#worker = null; this.#stopPoll();
          this.#rejectPending(new Error(`Companion helper exited (${signal ?? code ?? 'unknown'}).`));
          if (this.#state.task && !TERMINAL.has(this.#state.task.status)) {
            this.#state.task = { ...this.#state.task, status: 'unknown', error: 'Connection ended before a confirmed task terminal state.', updatedAt: Date.now() };
          }
          if (!this.#closing) {
            this.#state.runtimeState = 'error'; this.#state.connectionState = 'error';
            this.#state.lastError = this.#stalled
              ? 'Minecraft Companion helper stopped responding and was stopped. Reconnect explicitly; tasks are not replayed.'
              : 'Minecraft Companion helper stopped. Reconnect explicitly; tasks are not replayed.';
          }
          this.#unavailable(); this.#publish();
        };
        worker.once('exit', onExit); worker.once('close', onExit);
      });
      worker.on('error', (error) => { if (generation === this.#generation && this.#worker === worker) this.#transportError(errorMessage(error)); });
      worker.stdin.on('error', (error) => { if (generation === this.#generation && this.#worker === worker) this.#transportError(errorMessage(error)); });
      worker.stdout.on('data', (chunk: Buffer | string) => {
        if (generation !== this.#generation || this.#worker !== worker) return;
        this.#read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), managed !== undefined);
      });
      // Drain stderr without retaining an unbounded or potentially credential-bearing log.
      worker.stderr.on('data', () => {});
    } catch (error) { this.#transportError(errorMessage(error)); }
    return ready;
  }

  #transportError(message: string): void {
    this.#state.runtimeState = 'error'; this.#state.connectionState = 'error'; this.#state.lastError = message;
    this.#unavailable(); this.#rejectPending(new Error(message)); this.#publish();
    if (this.#worker && !this.#closing) void this.disconnect().catch(() => {});
  }

  #read(chunk: Buffer, managed: boolean): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(10);
    while (newline >= 0) {
      if (newline > MAX_LINE_BYTES) { this.#transportError('Companion JSONL line exceeded its size limit.'); return; }
      const line = this.#buffer.subarray(0, newline).toString('utf8').trim();
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line) {
        try {
          const message = record(JSON.parse(line));
          if (!message || message.version !== 1) throw new Error('Invalid Companion JSONL frame.');
          this.#message(message, managed);
        } catch { this.#transportError('Invalid Companion JSONL frame.'); return; }
      }
      newline = this.#buffer.indexOf(10);
    }
    if (this.#buffer.length > MAX_LINE_BYTES) this.#transportError('Companion JSONL buffer exceeded its size limit.');
  }

  #message(message: Record<string, unknown>, managed: boolean): void {
    if (message.type === 'ready') {
      if (message.engine !== 'core' || record(message.capabilities)?.taskLifecycle !== true) throw new Error('A core task host is required.');
      if (this.#ready) { clearTimeout(this.#ready.timer); this.#ready.resolve(); this.#ready = null; }
      this.#state.runtimeState = 'ready'; this.#publish(); return;
    }
    if (message.type === 'reply') {
      const pending = typeof message.id === 'string' ? this.#pending.get(message.id) : undefined;
      if (!pending) return;
      this.#pending.delete(message.id as string); clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(record(message.result) ?? {});
      else {
        this.#acceptTask(message.task);
        const ErrorType = record(message.error)?.code === 'survey_owns_body' ? SurveyOwnsBody : Error;
        pending.reject(new ErrorType(errorText(message.error)));
        this.#publish();
      }
      return;
    }
    const event = message.type === 'event' ? record(message.event) : null;
    if (!event) return;
    if (event.type === 'connection') {
      const generation = finite(event.generation);
      if (generation === null || generation < this.#state.connectionGeneration) return;
      if (!['disconnected', 'connecting', 'ready', 'error', 'disposed'].includes(String(event.state))) return;
      this.#state.connectionGeneration = generation;
      this.#state.connectionState = event.state as MinecraftCompanionSnapshot['connectionState'];
      if (event.error) this.#state.lastError = errorText(event.error);
      if (event.state === 'ready') { this.#state.auth = null; this.#startPoll(); }
      else { this.#stopPoll(); this.#unavailable(); }
      this.#event('connection', String(event.state));
    } else if (event.type === 'task') this.#acceptTask(event.task);
    else if (event.type === 'player_chat' && event.connectionGeneration === this.#state.connectionGeneration) {
      const username = text(event.username, 64); const chat = text(event.message, 256);
      if (username && chat) {
        this.#event('chat', `${username}: ${chat}`);
        try { this.#options.onPlayerChat?.({ username, message: chat }); } catch { /* the chat observer does not own the body */ }
      }
    }
    else if (event.type === 'auth_device_code') {
      const uri = text(event.verificationURI, 2048); const code = text(event.userCode, 64);
      if (uri && code && /^https:\/\//i.test(uri)) this.#state.auth = { userCode: code, verificationURI: uri, expiresIn: finite(event.expiresIn) };
    } else if (event.type === 'core' && event.connectionGeneration === this.#state.connectionGeneration) {
      const payload = record(event.payload); const kind = text(payload?.type, 80);
      if (kind) this.#event(kind, text(payload?.reason, 500) ?? text(payload?.milestone, 80) ?? kind, text(event.taskId, 128));
      if (managed && kind === 'adaptation_help' && this.#state.connectionState === 'ready') {
        const parsed = adaptationHelpSchema.safeParse(payload);
        if (parsed.success) {
          const { data: request } = parsed;
          const generation = this.#generation;
          const epoch = this.#state.connectionGeneration;
          const current = () => generation === this.#generation && epoch === this.#state.connectionGeneration
            && this.#state.connectionState === 'ready' && Date.now() < request.deadline;
          void Promise.resolve().then(() => current() ? this.#options.onAdaptationHelp?.(request) ?? null : null)
            .catch(() => null).then(choice => {
              if (!current()) return;
              return this.#request({ type: 'adaptation_reply', requestId: request.requestId, connectionGeneration: epoch,
                choice: choice && request.choices.includes(choice) ? choice : null }, undefined, randomUUID(), 2000);
            }).catch(() => undefined);
        }
      }
    } else if (managed && ['connecting', 'ready'].includes(this.#state.connectionState) && event.connectionGeneration === this.#state.connectionGeneration) {
      if (event.type === 'survey_plan_status') {
        const worldId = text(event.worldId, 128);
        const plan = minecraftSurveyPlanStatusSchema.nullable().safeParse(event.plan);
        if (!worldId || !plan.success) return;
        const previous = this.#state.plan;
        if (event.current !== false) {
          if (plan.data && previous?.planId === plan.data.planId && plan.data.revision < previous.revision) return;
          this.#state.plan = plan.data;
        }
        try { this.#options.onSurveyPlan?.({ worldId, initial: event.initial === true, plan: plan.data }); } catch { /* Observer only. */ }
      } else if (event.type === 'managed_world_review' && this.#state.connectionState === 'ready' && (event.reason === 'death' || event.reason === 'task_failure')) {
        const detail = text(event.detail, 600);
        if (detail) {
          try { this.#options.onManagedReview?.({ reason: event.reason, detail }); } catch { /* Observer only. */ }
        }
      }
    }
    this.#publish();
  }

  #acceptTask(value: unknown): void {
    const raw = record(value);
    if (!raw || typeof raw.taskId !== 'string' || raw.taskId.length > 128 || typeof raw.requestId !== 'string' || !this.#taskRequests.has(raw.requestId)) return;
    const current = this.#state.task;
    if (current?.taskId === raw.taskId && TERMINAL.has(current.status)) return;
    if (current && current.taskId !== raw.taskId && (!TERMINAL.has(current.status) || raw.requestId !== this.#dispatchRequestId)) return;
    if (!['gatherLogs', 'gatherMaterials', 'homestead', 'farm', 'followOwner'].includes(String(raw.name)) || !['accepted', 'running', 'completed', 'failed', 'cancelled'].includes(String(raw.status))) return;
    if (current?.taskId !== raw.taskId && raw.connectionGeneration !== this.#state.connectionGeneration) return;
    const task: MinecraftCompanionTask = {
      taskId: raw.taskId, requestId: raw.requestId, name: raw.name as MinecraftCompanionTask['name'], status: raw.status as MinecraftCompanionTask['status'],
      paused: raw.paused === true, createdAt: finite(raw.createdAt) ?? Date.now(), updatedAt: finite(raw.updatedAt) ?? Date.now(),
      connectionGeneration: finite(raw.connectionGeneration) ?? this.#state.connectionGeneration, progress: boundedData(raw.progress), error: raw.error ? errorText(raw.error) : null,
    };
    const finished = TERMINAL.has(task.status) && !(current?.taskId === task.taskId && TERMINAL.has(current.status));
    this.#state.task = task;
    this.#event('task', task.status, task.taskId);
    if (finished) { try { this.#options.onTaskFinished?.({ ...task }); } catch { /* observers do not own the body */ } }
  }

  #request(body: Record<string, unknown>, guard?: () => void, requestId = randomUUID(), timeoutMs = this.#options.requestTimeoutMs ?? 35000, onDispatch?: () => void): Promise<Record<string, unknown>> {
    if (!this.#worker || this.#pending.size >= 64) return Promise.reject(new Error('Companion helper is unavailable or busy.'));
    const worker = this.#worker;
    const line = JSON.stringify({ version: 1, id: requestId, ...body });
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return Promise.reject(new Error('Companion request is too large.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error('Companion request timed out; task outcome is unconfirmed.')); }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        guard?.();
        if (this.#worker !== worker || (this.#closing && body.type !== 'shutdown')) throw new Error('Companion request was superseded before dispatch.');
        onDispatch?.();
        worker.stdin.write(`${line}\n`);
      }
      catch (error) { clearTimeout(timer); this.#pending.delete(requestId); reject(error instanceof Error ? error : new Error(errorMessage(error))); }
    });
  }

  #startPoll(): void {
    if (this.#poll || this.#closing || this.#disposed) return;
    this.#poll = setInterval(() => { void this.#refresh(); }, this.#options.pollIntervalMs ?? 1000);
    this.#poll.unref?.();
    void this.#refresh();
  }

  #stopPoll(): void { if (this.#poll) clearInterval(this.#poll); this.#poll = null; }

  async #refresh(): Promise<void> {
    if (this.#polling || this.#state.connectionState !== 'ready' || this.#closing) return;
    this.#polling = true;
    const generation = this.#generation;
    const connectionGeneration = this.#state.connectionGeneration;
    try {
      const result = await this.#request({ type: 'tool', name: 'getStatus', arguments: {} }, undefined, randomUUID(), this.#options.statusTimeoutMs ?? 10000);
      this.#statusMisses = 0;
      if (generation !== this.#generation || connectionGeneration !== this.#state.connectionGeneration || this.#state.connectionState !== 'ready') return;
      this.#acceptTask(result.task);
      const observation = record(result.observation);
      const position = record(observation?.position);
      const inventory = record(observation?.inventory);
      const home = record(observation?.home); const corner = record(home?.anchor);
      this.#state.observation = observation ? {
        at: finite(observation.at) ?? Date.now(), alive: observation.alive === true, health: finite(observation.health), food: finite(observation.food), dimension: text(observation.dimension, 128),
        position: position && finite(position.x) !== null && finite(position.y) !== null && finite(position.z) !== null ? { x: position.x as number, y: position.y as number, z: position.z as number } : null,
        inventory: Object.fromEntries(Object.entries(inventory ?? {}).slice(0, 256).filter(([key, count]) => /^[a-z0-9_:]{1,100}$/.test(key) && Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 1_000_000)) as Record<string, number>,
        home: corner && [corner.x, corner.y, corner.z].every(Number.isInteger) ? { x: corner.x as number, y: corner.y as number, z: corner.z as number, finished: home?.finished === true } : null,
      } satisfies MinecraftCompanionObservation : null;
      const engine = record(result.engine); const goal = record(engine?.goal);
      const autonomy = minecraftAutonomyStatusSchema.safeParse(engine?.autonomy);
      this.#state.engine = engine ? {
        ...(autonomy.success ? { autonomy: autonomy.data } : {}),
        running: text(engine.running, 120), paused: engine.paused === true, blocked: engine.blocked === true, disposed: engine.disposed === true,
        goal: goal ? { name: text(goal.name, 120) ?? '', taskId: text(goal.taskId, 128), progress: boundedData(goal.progress), stalls: finite(goal.stalls) ?? 0 } : null,
      } satisfies MinecraftCompanionEngine : null;
      if (this.#state.task && !TERMINAL.has(this.#state.task.status) && this.#state.engine?.goal?.taskId === this.#state.task.taskId) this.#state.task.progress = this.#state.engine.goal.progress;
      this.#state.safetyActive = result.safetyActive === true && !this.#state.engine?.blocked && !this.#state.engine?.disposed;
      this.#publish();
    } catch (error) {
      if (generation === this.#generation && !this.#closing) { this.#state.lastError = errorMessage(error); this.#publish(); }
      // A helper whose event loop is stuck answers nothing, chat included: the
      // bot froze in game for 22 minutes with the task still shown running.
      // Stop it, so the task turns unknown and the error shows.
      if (generation === this.#generation && !this.#closing && /timed out/.test(errorMessage(error)) && ++this.#statusMisses >= STALLED_STATUS_READS && this.#worker) {
        this.#stalled = true;
        this.#worker.kill('SIGKILL');
      }
    } finally { this.#polling = false; }
  }

  async #waitExit(ms: number): Promise<boolean> {
    if (!this.#worker) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([this.#exit.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
