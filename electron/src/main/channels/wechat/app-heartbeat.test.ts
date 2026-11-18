// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AppHeartbeat } from './app-heartbeat';

it('writes only at, pid and state once a minute and leaves a final private stopped record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-heartbeat-'));
  const path = join(root, 'app-heartbeat.json');
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  const start = 1_800_000_000;
  const heartbeat = new AppHeartbeat(root);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(start * 1000);
  try {
    heartbeat.start();
    await expect.poll(read).toEqual({ at: start, pid: process.pid, state: 'running' });
    vi.advanceTimersByTime(59_999);
    expect(await read()).toEqual({ at: start, pid: process.pid, state: 'running' });
    vi.advanceTimersByTime(1);
    await expect.poll(read).toEqual({ at: start + 60, pid: process.pid, state: 'running' });
    // Stop while another tick may still be writing. No running write may overtake it.
    vi.advanceTimersByTime(60_000);
    await heartbeat.stop();
    vi.advanceTimersByTime(60_000);
    expect(await read()).toEqual({ at: start + 120, pid: process.pid, state: 'stopped' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await heartbeat.stop();
    vi.useRealTimers();
    await rm(root, { force: true, recursive: true });
  }
});

it('does not create an absent listener runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-heartbeat-'));
  const runtime = join(root, 'missing');
  const heartbeat = new AppHeartbeat(runtime);
  try {
    heartbeat.start();
    await heartbeat.stop();
    await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { force: true, recursive: true }); }
});
