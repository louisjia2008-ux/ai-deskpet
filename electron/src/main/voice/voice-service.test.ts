// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_MODEL, speakableText } from '../../shared/voice';
import type { VoiceChunk } from '../../shared/voice';
import { VoiceService, checkVoiceRuntime } from './voice-service';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const runtime = async (parts: { python?: boolean; model?: boolean; reference?: boolean } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-voice-')); roots.push(dir);
  if (parts.python !== false) { await mkdir(join(dir, '.venv', 'bin'), { recursive: true }); await writeFile(join(dir, '.venv', 'bin', 'python'), '#!'); }
  if (parts.model !== false) await mkdir(join(dir, 'hf', 'hub', `models--${VOICE_MODEL.replace('/', '--')}`, 'snapshots'), { recursive: true });
  if (parts.reference !== false) { await mkdir(join(dir, 'voice')); await writeFile(join(dir, 'voice', 'reference.wav'), 'RIFF'); await writeFile(join(dir, 'voice', 'reference.txt'), '你好'); }
  return dir;
};

class FakeWorker extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  requests: Array<Record<string, string>> = [];
  constructor() {
    super();
    this.stdin.on('data', (data: Buffer) => { for (const line of data.toString().split('\n').filter(Boolean)) this.requests.push(JSON.parse(line) as Record<string, string>); });
    this.stdin.on('finish', () => this.exit(0));
  }
  say(message: object): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  exit(code: number): void { this.exitCode = code; this.emit('exit', code, null); }
  kill(): boolean { this.exit(137); return true; }
}

const setup = async (dir: string | null) => {
  const settingsPath = join(await mkdtemp(join(tmpdir(), 'deskpet-voice-settings-')), 'voice-settings.json'); roots.push(join(settingsPath, '..'));
  const workers: FakeWorker[] = [], sent: VoiceChunk[] = [];
  const spawn = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const voice = new VoiceService({ settingsPath, workerScript: '/app/voice-runtime/tts_worker.py', send: (chunk) => sent.push(chunk), spawn: spawn as never, idleMs: 50 });
  await voice.initialize();
  if (dir !== null) await voice.update({ enabled: true, runtimeDir: dir });
  return { voice, workers, sent, spawn, settingsPath };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('her runtime folder', () => {
  it('names the first missing piece', async () => {
    expect(await checkVoiceRuntime(null)).toBe('folder');
    expect(await checkVoiceRuntime('relative/path')).toBe('folder');
    expect(await checkVoiceRuntime(await runtime({ python: false }))).toBe('python');
    expect(await checkVoiceRuntime(await runtime({ model: false }))).toBe('model');
    expect(await checkVoiceRuntime(await runtime({ reference: false }))).toBe('reference');
    expect(await checkVoiceRuntime(await runtime())).toBeNull();
  });
});

describe('speaking', () => {
  it('starts the worker offline in her folder, streams only the current reply and unloads when quiet', async () => {
    const dir = await runtime();
    const { voice, workers, sent, spawn } = await setup(dir);
    expect(voice.status()).toMatchObject({ enabled: true, state: 'idle', problem: null });
    expect(voice.speak('哥哥，**你好**呀！`code` https://example.com')).toBe(true);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(command).toBe(join(dir, '.venv', 'bin', 'python'));
    expect(args).toEqual(['-I', '-B', '/app/voice-runtime/tts_worker.py', VOICE_MODEL]);
    expect(options.cwd).toBe(dir);
    expect(options.env).toMatchObject({ HF_HOME: join(dir, 'hf'), HF_HUB_OFFLINE: '1' });
    expect(Object.keys(options.env)).not.toContain('OPENAI_API_KEY');
    const worker = workers[0]!;
    await tick();
    const first = worker.requests[0]!;
    expect(first.text).toBe('哥哥，你好呀！');
    expect(voice.status().state).toBe('loading');
    worker.say({ ready: true }); await tick();
    expect(voice.status().state).toBe('speaking');
    worker.say({ id: 'someone-else', pcm: 'AAAA', rate: 24000 });
    worker.say({ id: first.id, pcm: 'AQID', rate: 24000 });
    worker.say({ id: first.id, done: true }); await tick();
    expect(sent).toEqual([{ id: first.id, pcm: 'AQID', rate: 24000 }, { id: first.id, done: true }]);
    expect(voice.status().state).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(voice.status().state).toBe('idle');
    expect(worker.exitCode).toBe(0);
  });

  it('cuts off the last reply for a new one, and says nothing when off or when nothing is speakable', async () => {
    const { voice, workers, sent } = await setup(await runtime());
    voice.speak('第一句。'); voice.speak('第二句。'); await tick();
    const worker = workers[0]!;
    expect(workers).toHaveLength(1);
    expect(worker.requests.map((request) => request.cancel ?? request.text)).toEqual(['第一句。', worker.requests[0]!.id, '第二句。']);
    expect(sent).toEqual([{ id: null, stop: true }]);
    worker.say({ ready: true }); worker.say({ id: worker.requests[0]!.id, pcm: 'AA', rate: 24000 }); await tick();
    expect(sent).toHaveLength(1);
    expect(voice.speak('```\ncode only\n```')).toBe(false);
    await voice.update({ enabled: false });
    expect(voice.status().state).toBe('off');
    expect(voice.speak('你好')).toBe(false);
  });

  it('reports a worker that dies before loading, and a folder that is incomplete', async () => {
    const { voice, workers } = await setup(await runtime());
    voice.speak('你好'); workers[0]!.exit(1); await tick();
    expect(voice.status()).toMatchObject({ state: 'error', problem: 'worker' });
    const incomplete = await setup(await runtime({ reference: false }));
    expect(incomplete.voice.status()).toMatchObject({ state: 'missing', problem: 'reference' });
    expect(incomplete.voice.speak('你好')).toBe(false);
    expect(incomplete.spawn).not.toHaveBeenCalled();
  });
});

describe('what she says aloud', () => {
  it('drops code, links, markdown and emoji, and stops long replies at a sentence end', () => {
    expect(speakableText('# 标题\n- **第一点** [链接](https://x.y)\n```js\nx()\n```\n好的😊')).toBe('标题\n第一点 链接\n好的');
    const long = `${'这是一句话。'.repeat(80)}`;
    const spoken = speakableText(long);
    expect(spoken.length).toBeLessThanOrEqual(400);
    expect(spoken.endsWith('。')).toBe(true);
  });
});
