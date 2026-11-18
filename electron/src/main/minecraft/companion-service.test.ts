// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinecraftCompanionConfig } from '../../shared/minecraft-companion';
import { MinecraftCompanionService } from './companion-service';

type Message = Record<string, unknown>;
const enqueue = (callback: () => void): void => { void Promise.resolve().then(callback); };
class Worker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Message[] = [];
  readonly signals: string[] = [];
  stopped = false;
  task: Message | null = null;
  generation = 1;
  handler: ((message: Message) => boolean) | null = null;
  status: Message = { engine: { running: null, paused: false, blocked: false, disposed: false, goal: null }, observation: null, safetyActive: true };
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      const message = JSON.parse(line) as Message;
      this.writes.push(message);
      if (this.handler?.(message)) continue;
      if (message.type === 'connect') {
        this.event({ type: 'connection', state: 'connecting', generation: this.generation });
        this.reply(message, { connection: { state: 'connecting', generation: this.generation } });
      } else if (message.type === 'shutdown') {
        if (this.task && !['completed', 'failed', 'cancelled'].includes(String(this.task.status))) this.taskEvent('cancelled');
        this.reply(message, {}); enqueue(() => this.exit());
      } else if (message.name === 'getStatus') this.reply(message, { ...this.status, task: this.task });
      else if (message.name === 'cancel') { this.taskEvent('cancelled'); this.reply(message, { task: this.task }); }
      else if (message.type === 'tool') {
        this.task = { taskId: `task-${this.writes.length}`, requestId: message.id, name: message.name, status: 'accepted', paused: false, createdAt: 1, updatedAt: 1, connectionGeneration: this.generation };
        this.event({ type: 'task', task: this.task }); this.taskEvent('running'); this.reply(message, { task: this.task, dispatchOnly: true });
      }
    }
    callback();
  } });
  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  event(event: Message): void { this.send({ version: 1, type: 'event', event }); }
  reply(message: Message, result: Message): void { this.send({ version: 1, type: 'reply', id: message.id, ok: true, result }); }
  taskEvent(status: string, extra: Message = {}): void {
    if (!this.task) throw new Error('No task');
    this.task = { ...this.task, ...extra, status, updatedAt: Number(this.task.updatedAt) + 1 };
    this.event({ type: 'task', task: this.task });
  }
  world(): void { this.event({ type: 'connection', state: 'ready', generation: this.generation }); }
  exit(code = 0): void { this.stopped = true; this.emit('exit', code, null); this.emit('close', code, null); }
  kill(signal = 'SIGTERM'): boolean { this.signals.push(signal); this.exit(); return true; }
  asProcess(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

const config: MinecraftCompanionConfig = { host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline', version: '1.21.8' };
const directories: string[] = [];
const services: MinecraftCompanionService[] = [];
async function fixture(options: { ready?: boolean; requestTimeoutMs?: number; statusTimeoutMs?: number; shutdownTimeoutMs?: number; onChanged?: () => void;
  onTaskFinished?: (task: unknown) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-companion-')); directories.push(root);
  const workers: Worker[] = []; const captured: Array<{ executable: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  const service = new MinecraftCompanionService({
    runtimePath: join(root, 'runtime', 'index.js'), dataDirectory: join(root, 'independent-companion'), executablePath: '/electron',
    environment: { PATH: '/bin', HOME: '/user', OPENAI_API_KEY: 'do-not-leak', NODE_OPTIONS: '--require=bad', MC_DATA_DIR: '/old-world' },
    requestTimeoutMs: options.requestTimeoutMs ?? 1000, ...(options.statusTimeoutMs ? { statusTimeoutMs: options.statusTimeoutMs } : {}), shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30, readyTimeoutMs: 50, pollIntervalMs: 10,
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    ...(options.onTaskFinished ? { onTaskFinished: options.onTaskFinished } : {}),
    spawnRuntime(executable, args, spawnOptions) {
      captured.push({ executable, args, options: spawnOptions }); const worker = new Worker(); workers.push(worker);
      if (options.ready !== false) enqueue(() => worker.send({ version: 1, type: 'ready', engine: 'core', capabilities: { taskLifecycle: true } }));
      return worker.asProcess();
    },
  }); services.push(service);
  return { service, workers, captured };
}
async function connected() {
  const result = await fixture(); await result.service.connect(config); const worker = result.workers[0] as Worker;
  worker.world(); await Promise.resolve(); return { ...result, worker };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('independent core Companion service', () => {
  it('spawns only on connect with explicit core, isolated paths and a secret-free environment', async () => {
    const { service, workers, captured } = await fixture();
    expect(captured).toHaveLength(0);
    const state = await service.connect(config);
    expect(captured[0]?.args).toEqual([expect.stringContaining('/runtime/index.js'), '--engine', 'core', '--data-dir', expect.stringContaining('/independent-companion')]);
    expect(captured[0]?.options.env).toEqual({ PATH: '/bin', HOME: '/user', ELECTRON_RUN_AS_NODE: '1' });
    expect(captured[0]?.options.shell).toBeUndefined();
    expect(state.runtimeState).toBe('ready'); expect(state.connectionState).toBe('connecting');
    await expect(service.start({ name: 'gatherLogs', parameters: { count: 1 } })).rejects.toThrow('尚未进入世界');
    (workers[0] as Worker).world();
    const dispatched = await service.start({ name: 'gatherLogs', parameters: { count: 3 } });
    expect(dispatched.task?.status).toBe('running'); expect(dispatched.task?.taskId).toBeTruthy();
    expect((workers[0] as Worker).writes.at(-1)).toMatchObject({ type: 'tool', name: 'gatherLogs', arguments: { count: 3 } });
  });

  it('keeps cancel pending until a joined terminal receipt, including retirement failures', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 2 } });
    let request: Message | undefined;
    worker.handler = (message) => { if (message.name === 'cancel') { request = message; return true; } return false; };
    const cancellation = service.cancel();
    expect(service.getState().controlPending).toBe('cancel'); expect(service.getState().task?.status).toBe('running');
    await Promise.resolve();
    worker.taskEvent('failed', { error: { code: 'retirement_timeout', message: 'Body is still retiring' } });
    worker.send({ version: 1, type: 'reply', id: request?.id, ok: false, error: { code: 'retirement_timeout', message: 'Body is still retiring' }, task: worker.task });
    await expect(cancellation).rejects.toThrow('Body is still retiring');
    expect(service.getState().task?.status).toBe('failed'); expect(service.getState().controlPending).toBeNull();
  });

  it('reports a finished task once, with the death causes the engine gave', async () => {
    const finished = vi.fn();
    const { service, workers } = await fixture({ onTaskFinished: finished }); await service.connect(config);
    const worker = workers[0] as Worker; worker.world(); await Promise.resolve();
    await service.start({ name: 'homestead', parameters: {} });
    expect(finished).not.toHaveBeenCalled();
    worker.taskEvent('failed', { error: { code: 'goal_failed', message: 'death_loop: was slain by Husk at 3,64,-9; was shot by Skeleton at 5,40,-2' } });
    worker.taskEvent('failed', { error: { code: 'goal_failed', message: 'death_loop: repeated' } });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
    expect(finished.mock.calls[0]?.[0]).toMatchObject({ name: 'homestead', status: 'failed', error: expect.stringContaining('slain by Husk') });
  });

  it('sends a danger policy only once the bot is in the world, and returns what the engine applied', async () => {
    const { service, workers } = await fixture(); await service.connect(config);
    const worker = workers[0] as Worker;
    await expect(service.setPolicy({ risk: 'bold' })).rejects.toThrow('尚未进入世界');
    worker.world(); await Promise.resolve();
    worker.handler = (message) => {
      if (message.name !== 'setPolicy') return false;
      worker.reply(message, { policy: { risk: 'bold', guard: 'owner_first' } }); return true;
    };
    await expect(service.setPolicy({ risk: 'bold', guard: 'owner_first' })).resolves.toEqual({ risk: 'bold', guard: 'owner_first' });
    expect(worker.writes.at(-1)).toMatchObject({ type: 'tool', name: 'setPolicy', arguments: { risk: 'bold', guard: 'owner_first' } });
    await expect(service.setPolicy({})).rejects.toThrow();
  });

  it('uses a fresh cancel request id, the actual task id and a confirmed cancelled result', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    const task = service.getState().task;
    const state = await service.cancel();
    expect(state.task?.status).toBe('cancelled'); expect(state.controlPending).toBeNull();
    expect(worker.writes.at(-1)).toMatchObject({ name: 'cancel', arguments: { taskId: task?.taskId } });
    expect(worker.writes.at(-1)?.id).not.toBe(task?.requestId);
  });

  it('does not turn a cancel timeout into a cancelled task', async () => {
    const { service, workers } = await fixture({ requestTimeoutMs: 15 }); await service.connect(config);
    const worker = workers[0] as Worker; worker.world(); await service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    worker.handler = (message) => message.name === 'cancel';
    await expect(service.cancel()).rejects.toThrow('unconfirmed'); expect(service.getState().task?.status).toBe('running');
  });

  it('preserves immutable terminals and accepts a subsequent fast completed task', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    worker.taskEvent('completed', { progress: { logs: 5 } }); const previous = { ...worker.task };
    worker.taskEvent('running'); expect(service.getState().task?.status).toBe('completed');
    worker.handler = (message) => {
      if (message.name !== 'homestead') return false;
      worker.task = { ...previous, taskId: 'new-fast-task', requestId: message.id, name: 'homestead', status: 'completed' };
      worker.reply(message, { task: worker.task, dispatchOnly: true }); return true;
    };
    const state = await service.start({ name: 'homestead', parameters: {} });
    expect(state.task).toMatchObject({ taskId: 'new-fast-task', status: 'completed' });
    worker.event({ type: 'task', task: previous }); expect(service.getState().task?.taskId).toBe('new-fast-task');
  });

  it('bounds fresh observation and progress without treating a snapshot as task completion', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 2 } });
    worker.status = { safetyActive: true,
      engine: { running: 'gatherLogs', goal: { name: 'gatherLogs', taskId: worker.task?.taskId, progress: { logs: 1 }, stalls: 0 }, blocked: false },
      observation: { at: 3, alive: true, health: 18, food: 17, dimension: 'overworld', position: { x: 1.5, y: 64, z: -2 }, inventory: { oak_log: 1, bad: -4 },
        home: { anchor: { x: -75, y: 68, z: 529 }, finished: true, extra: 'dropped' } },
    };
    await vi.waitFor(() => expect(service.getState().observation?.health).toBe(18));
    expect(service.getState().observation?.inventory).toEqual({ oak_log: 1 });
    expect(service.getState().observation?.home).toEqual({ x: -75, y: 68, z: 529, finished: true });
    expect(service.getState().task).toMatchObject({ status: 'running', progress: { logs: 1 } });
    worker.status.engine = { blocked: true, disposed: false, goal: null };
    await vi.waitFor(() => expect(service.getState().safetyActive).toBe(false));
  });

  it('isolates old workers and lower connection generations after explicit reconnect', async () => {
    const { service, worker } = await connected(); await service.disconnect(); await service.connect(config);
    const workers = (await Promise.resolve(service.getState())); expect(workers.connectionState).toBe('connecting');
    worker.world(); worker.event({ type: 'connection', state: 'error', generation: 100 });
    expect(service.getState().connectionState).toBe('connecting');
  });

  it('checks authorization again after handshake and immediately before the task write', async () => {
    const { service, captured } = await fixture(); let count = 0;
    await expect(service.connect(config, () => { if (++count >= 3) throw new Error('permission revoked'); })).rejects.toThrow('permission revoked');
    expect(captured).toHaveLength(1);
    expect(service.getState().connectionState).toBe('disconnected');
    await service.connect(config); const state = service.getState(); expect(state.connectionState).toBe('connecting');
  });

  it('rejects a revoked task write without sending it to the runtime', async () => {
    const { service, worker } = await connected(); let calls = 0;
    await expect(service.start({ name: 'gatherLogs', parameters: { count: 1 } }, () => { if (++calls === 2) throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(worker.writes.some((message) => message.name === 'gatherLogs')).toBe(false);
  });

  it('shuts down gracefully without claiming cancellation on an unacknowledged exit', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    worker.handler = (message) => { if (message.type === 'shutdown') { worker.reply(message, {}); enqueue(() => worker.exit()); return true; } return false; };
    const state = await service.disconnect();
    expect(state.task?.status).toBe('unknown'); expect(state.controlPending).toBeNull(); expect(worker.signals).toHaveLength(0);
    expect(worker.writes.at(-1)?.type).toBe('shutdown');
  });

  it('bounds owned helper teardown when it refuses shutdown', async () => {
    const { service, worker } = await connected(); worker.handler = (message) => message.type === 'shutdown';
    await service.disconnect(); expect(worker.signals).toEqual(['SIGTERM']); expect(worker.stopped).toBe(true);
  });

  it('rejects malformed and oversized transport without presenting a success', async () => {
    const { service, worker } = await connected(); await service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    worker.stdout.write('not-json\n');
    await vi.waitFor(() => expect(worker.stopped).toBe(true));
    expect(service.getState().lastError).toMatch(/Invalid Companion/);
    expect(service.getState().task?.status).not.toBe('completed');
  });

  it('does not let an observer failure strand the child and closes permanently on dispose', async () => {
    const { service, workers } = await fixture({ onChanged: () => { throw new Error('UI gone'); } });
    await service.connect(config); await service.dispose();
    expect((workers[0] as Worker).stopped).toBe(true);
    await expect(service.connect(config)).rejects.toThrow('disposed');
  });

  it('allows a disconnected no-worker service to connect later', async () => {
    const { service } = await fixture(); await service.disconnect();
    await expect(service.connect(config)).resolves.toMatchObject({ connectionState: 'connecting' });
  });

  it('does not resurrect startup after a disconnect while mkdir is still pending', async () => {
    const { service, captured } = await fixture();
    const connecting = service.connect(config);
    const rejection = expect(connecting).rejects.toThrow('superseded');
    await service.disconnect(); await rejection;
    expect(captured).toHaveLength(0); expect(service.getState().connectionState).toBe('disconnected');
  });

  it('rejects a guard that synchronously closes the connection before stdin write', async () => {
    const { service, worker } = await connected(); let calls = 0;
    await expect(service.start({ name: 'gatherLogs', parameters: { count: 1 } }, () => {
      if (++calls === 2) void service.disconnect();
    })).rejects.toThrow('superseded');
    expect(worker.writes.some((message) => message.name === 'gatherLogs')).toBe(false);
  });

  it('remembers cancellation while dispatch has no task id and cancels that task after acceptance', async () => {
    const { service, worker } = await connected(); let dispatch: Message | undefined;
    worker.handler = (message) => { if (message.name === 'gatherLogs') { dispatch = message; return true; } return false; };
    const starting = service.start({ name: 'gatherLogs', parameters: { count: 3 } });
    const cancelling = service.cancel();
    const pendingControl = service.getState().controlPending;
    worker.task = { taskId: 'late-dispatch', requestId: dispatch?.id, name: 'gatherLogs', status: 'running', connectionGeneration: 1 };
    worker.reply(dispatch as Message, { task: worker.task, dispatchOnly: true });
    await starting; const stopped = await cancelling;
    expect(pendingControl).toBe('cancel');
    expect(stopped.task).toMatchObject({ taskId: 'late-dispatch', status: 'cancelled' });
    expect(worker.writes.filter((message) => message.name === 'cancel')).toHaveLength(1);
  });

  it('retires an accepted task if its caller authorization is revoked after dispatch', async () => {
    const { service, worker } = await connected(); let checks = 0;
    await expect(service.start({ name: 'gatherLogs', parameters: { count: 1 } }, () => { if (++checks === 3) throw new Error('post-dispatch revoked'); })).rejects.toThrow('post-dispatch revoked');
    expect(service.getState().task?.status).toBe('cancelled');
    expect(worker.writes.some((message) => message.name === 'cancel')).toBe(true);
  });

  it('closes the owned helper when a cancelled dispatch never yields a task id', async () => {
    const { service, workers } = await fixture({ requestTimeoutMs: 15 }); await service.connect(config);
    const worker = workers[0] as Worker; worker.world();
    worker.handler = (message) => message.name === 'gatherLogs';
    const starting = service.start({ name: 'gatherLogs', parameters: { count: 1 } });
    const rejected = expect(starting).rejects.toThrow('unconfirmed');
    const stopped = await service.cancel(); await rejected;
    expect(worker.stopped).toBe(true); expect(stopped.connectionState).toBe('disconnected');
    expect(stopped.task).toBeNull(); expect(stopped.controlPending).toBeNull();
  });

  it('does not invent cancelled when dispatch completes before pending cancellation joins', async () => {
    const { service, worker } = await connected(); let dispatch: Message | undefined;
    worker.handler = (message) => { if (message.name === 'homestead') { dispatch = message; return true; } return false; };
    const starting = service.start({ name: 'homestead', parameters: {} });
    const cancelling = service.cancel();
    worker.reply(dispatch as Message, { task: { taskId: 'already-done', requestId: dispatch?.id, name: 'homestead', status: 'completed', connectionGeneration: 1 }, dispatchOnly: true });
    await starting; const state = await cancelling;
    expect(state.task?.status).toBe('completed'); expect(state.controlPending).toBeNull();
    expect(worker.writes.some((message) => message.name === 'cancel')).toBe(false);
  });

  it('stops a helper that no longer answers status reads, so a frozen bot shows as an error and not a running task', async () => {
    const result = await fixture({ statusTimeoutMs: 20 });
    await result.service.connect(config);
    const worker = result.workers[0] as Worker;
    worker.world(); await Promise.resolve();
    await result.service.start({ name: 'homestead', parameters: {} });
    // The helper's event loop is stuck: nothing is answered any more.
    worker.handler = (message) => message.name === 'getStatus';
    await vi.waitFor(() => expect(worker.signals).toEqual(['SIGKILL']), { timeout: 2000 });
    const state = result.service.getState();
    expect(state.connectionState).toBe('error');
    expect(state.lastError).toContain('stopped responding');
    expect(state.task?.status).toBe('unknown');
  });

  it('rejects oversized stdout and legacy ready frames with bounded helper cleanup', async () => {
    const { service, worker } = await connected();
    worker.stdout.write(Buffer.alloc(1024 * 1024 + 1, 'a'));
    await vi.waitFor(() => expect(worker.stopped).toBe(true));
    expect(service.getState().lastError).toContain('size limit');
    const second = await fixture({ ready: false }); const connecting = second.service.connect(config);
    const rejected = expect(connecting).rejects.toThrow('Invalid Companion');
    await vi.waitFor(() => expect(second.workers).toHaveLength(1));
    (second.workers[0] as Worker).send({ version: 1, type: 'ready' });
    await rejected;
  });
});
