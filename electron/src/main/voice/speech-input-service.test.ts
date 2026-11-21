// @vitest-environment node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ASR_MODEL } from '../../shared/speech-input';
import { SpeechInputService } from './speech-input-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
class Worker extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  requests: Array<{ id: string; pcm: string; rate: number }> = [];
  kill = vi.fn(() => { this.signalCode = 'SIGKILL'; this.emit('exit', null, 'SIGKILL'); return true; });
  constructor() { super(); this.stdin.on('data', (data: Buffer) => this.requests.push(JSON.parse(data.toString()) as typeof this.requests[number])); }
  say(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n'); }
}
const pcm = Buffer.alloc(16_000).toString('base64');
async function fixture(options: { timeoutMs?: number; idleMs?: number; beforeStart?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-asr-')); roots.push(root);
  await mkdir(join(root, '.venv/bin'), { recursive: true }); await writeFile(join(root, '.venv/bin/python'), '#!');
  await mkdir(join(root, 'hf/hub', `models--${ASR_MODEL.replace('/', '--')}`, 'snapshots'), { recursive: true });
  const workers: Worker[] = [], beforeStart = options.beforeStart ?? vi.fn(async () => undefined);
  const spawn = vi.fn(() => { const worker = new Worker(); workers.push(worker); return worker; });
  const settingsPath = join(root, 'speech.json');
  const service = new SpeechInputService({ settingsPath, workerScript: '/fixture/asr_worker.py', runtimeDir: () => root,
    beforeStart, spawn: spawn as never, ...options });
  await service.initialize();
  return { root, service, spawn, workers, settingsPath };
}

it('persists draft-only defaults; bounds and canonicalizes PCM before starting any worker', async () => {
  const f = await fixture();
  expect(f.service.status()).toMatchObject({ mode: 'hold', autoSend: false, state: 'idle' });
  for (const bad of ['', 'not base64', Buffer.alloc(7998).toString('base64'), Buffer.alloc(1_920_002).toString('base64'), 'AAAA====']) {
    await expect(f.service.transcribe(bad)).rejects.toThrow();
  }
  expect(f.spawn).not.toHaveBeenCalled();
  await f.service.configure({ mode: 'toggle', autoSend: true });
  expect(await readFile(f.settingsPath, 'utf8')).not.toContain(pcm);
  const again = new SpeechInputService({ settingsPath: f.settingsPath, workerScript: '', runtimeDir: () => null, beforeStart: async () => undefined });
  await again.initialize(); expect(again.status()).toMatchObject({ mode: 'toggle', autoSend: true });
});

it('reuses one isolated offline model, handles split UTF-8 and releases after idle', async () => {
  const f = await fixture({ idleMs: 15 });
  const result = f.service.transcribe(pcm);
  await vi.waitFor(() => expect(f.workers[0]?.requests).toHaveLength(1));
  const worker = f.workers[0]!, id = worker.requests[0]!.id;
  expect(f.spawn.mock.calls[0]).toEqual([join(f.root, '.venv/bin/python'), ['-I', '-B', '/fixture/asr_worker.py', ASR_MODEL, '--pcm'],
    expect.objectContaining({ env: expect.objectContaining({ HF_HUB_OFFLINE: '1', HF_HOME: join(f.root, 'hf') }) })]);
  worker.say({ ready: true }); worker.say({ id: 'stale', text: 'wrong' });
  const wire = Buffer.from(JSON.stringify({ id, text: '  合成语音输入  ' }) + '\n');
  for (const byte of wire) worker.stdout.write(Buffer.from([byte]));
  expect(await result).toBe('合成语音输入'); expect(f.service.status().lastSuccessAt).not.toBeNull();
  const next = f.service.transcribe(pcm);
  await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
  worker.say({ id: worker.requests[1]!.id, text: '第二句' }); expect(await next).toBe('第二句');
  expect(f.spawn).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(worker.kill).toHaveBeenCalled());
  expect(f.service.status().state).toBe('idle');
});

it('cancels setup before spawning; rejects concurrent requests and never accepts late replies', async () => {
  let release!: () => void;
  const f = await fixture({ beforeStart: () => new Promise<void>(resolve => { release = resolve; }) });
  const result = f.service.transcribe(pcm); void result.catch(() => undefined);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(f.service.transcribe(pcm)).rejects.toThrow('asr.busy');
  await f.service.release(); release();
  await expect(result).rejects.toThrow('asr.cancelled'); expect(f.spawn).not.toHaveBeenCalled();
});

it.each(['null', '{broken', 'x'.repeat(33_000)])('fails bounded malformed worker protocol without hanging: %s', async wire => {
  const f = await fixture(); const result = f.service.transcribe(pcm); void result.catch(() => undefined);
  await vi.waitFor(() => expect(f.workers[0]?.requests).toHaveLength(1));
  f.workers[0]!.stdout.write(wire + '\n'); await expect(result).rejects.toThrow('asr.protocol');
  expect(f.service.status()).toMatchObject({ state: 'error', errorCode: 'asr.protocol' }); await f.service.release();
});

it('times out one request, kills its worker and allows a subsequent recording', async () => {
  const f = await fixture({ timeoutMs: 100 }); const result = f.service.transcribe(pcm); void result.catch(() => undefined);
  await expect(result).rejects.toThrow('asr.timeout'); expect(f.workers[0]?.kill).toHaveBeenCalled();
  const next = f.service.transcribe(pcm); await vi.waitFor(() => expect(f.workers[1]?.requests).toHaveLength(1));
  const worker = f.workers[1]!; worker.say({ id: worker.requests[0]!.id, text: '恢复了' }); expect(await next).toBe('恢复了');
  await f.service.release();
});

it('restarts a killed local ASR process and verifies readiness without replaying PCM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-asr-doctor-')); roots.push(root);
  await mkdir(join(root, '.venv/bin'), { recursive: true });
  await writeFile(join(root, '.venv/bin/python'), '#!');
  await mkdir(join(root, 'hf/hub', `models--${ASR_MODEL.replace('/', '--')}`, 'snapshots'), { recursive: true });
  const workers: ReturnType<typeof spawn>[] = [];
  const fakeScript = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    process.stdout.write('{"ready":true}\\n');
    lines.on('line', line => {
      const { id } = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id, text: 'fixture transcript' }) + '\\n');
    });
    setInterval(() => {}, 1000);
  `;
  const launch: typeof spawn = (() => {
    const child = spawn(process.execPath, ['-e', fakeScript], { stdio: ['pipe', 'pipe', 'pipe'] });
    workers.push(child);
    return child;
  }) as unknown as typeof spawn;
  const service = new SpeechInputService({ settingsPath: join(root, 'speech.json'), workerScript: '/fixture/asr.py',
    runtimeDir: () => root, beforeStart: async () => undefined, spawn: launch, timeoutMs: 3000 });
  try {
    await service.initialize();
    expect(await service.transcribe(pcm)).toBe('fixture transcript');
    const priorSuccess = service.status().lastSuccessAt;
    expect(workers[0]!.kill('SIGKILL')).toBe(true);
    await vi.waitFor(() => expect(service.canRestartWorker()).toBe(true));
    expect(await service.restartWorker(() => true)).toBe('recovered');
    expect(workers).toHaveLength(2);
    expect(workers[1]!.pid).not.toBe(workers[0]!.pid);
    expect(service.status()).toMatchObject({ state: 'ready', errorCode: null, lastSuccessAt: priorSuccess });
  } finally {
    await service.release();
  }
});
