import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { PROFILE_ROOTS } from '../profile-backup';
import { DEDICATED_READY, MinecraftDedicatedConsole } from './dedicated-console';
import { MinecraftDedicatedServer, offlinePlayerUuid } from './dedicated-server';
import { maintainBackups, snapshotWorld } from './dedicated-world-storage';

async function fixture(packaged: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-dedicated-test-'));
  const resourcesPath = join(root, 'resources');
  const userDataPath = join(root, 'profile');
  const resources = join(resourcesPath, 'minecraft-dedicated');
  const managed = join(userDataPath, 'minecraft-dedicated');
  const jar = join(resources, 'deskpet-mod.jar');
  await mkdir(resources, { recursive: true });
  const bytes = Buffer.from('test artifact');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(jar, bytes);
  await writeFile(join(resources, 'manifest.json'), JSON.stringify(packaged
    ? { version: 1, packaged, jar: 'deskpet-mod.jar', modVersion: '0.1.0', sha256 }
    : { version: 1, packaged }));
  const options = { resourcesPath, userDataPath, onChanged: vi.fn() };
  return { root, managed, jar, options, server: new MinecraftDedicatedServer(options) };
}

test('requires explicit consent, merges queued settings and honors a persistent disabled world', async () => {
  const { root, managed, options, server } = await fixture(true);
  let reopened: MinecraftDedicatedServer | null = null;
  try {
    await server.initialize();
    expect(server.getState().settings).toEqual({ enabled: true, memoryGb: 3, allowPlanApproval: false, autonomyRange: 'overworld', offlineModelDailyLimit: 20 });
    expect((await server.start()).status).toBe('eula_required');
    await expect(stat(join(managed, 'server', 'eula.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await Promise.all([server.setSettings({ enabled: false }), server.setSettings({ memoryGb: 5, autonomyRange: 'end' }), server.setSettings({ offlineModelDailyLimit: 0 })]);
    await server.setIdentity({ ownerName: 'TestOwner', botName: 'TestRobot' });
    const accepted = await server.acceptEula();
    expect(accepted.status).toBe('stopped');
    expect(accepted.settings).toEqual({ enabled: false, memoryGb: 5, allowPlanApproval: false, autonomyRange: 'end', offlineModelDailyLimit: 0 });
    const consent = accepted.eulaAcceptedAt;
    expect(consent).not.toBeNull();
    expect(await readFile(join(managed, 'server', 'eula.txt'), 'utf8')).toMatch(/^eula=true$/mu);
    await server.dispose();
    reopened = new MinecraftDedicatedServer(options);
    expect((await reopened.start()).status).toBe('stopped');
    expect(reopened.getState().eulaAcceptedAt).toBe(consent);
    expect(reopened.getState().settings.autonomyRange).toBe('end');
    expect(reopened.getState()).toMatchObject({ ownerName: 'TestOwner', botName: 'TestRobot' });
    await expect(stat(join(managed, 'downloads'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await server.dispose();
    await reopened?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a changed Mod before downloads and cannot start from an unavailable build', async () => {
  const tampered = await fixture(true);
  const missing = await fixture(false);
  try {
    await tampered.server.initialize();
    await writeFile(tampered.jar, 'best artifact');
    expect(await tampered.server.acceptEula()).toMatchObject({ status: 'error', error: expect.stringMatching(/Mod verification failed.*SHA256/u) });
    await expect(stat(join(tampered.managed, 'downloads'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await missing.server.acceptEula()).toMatchObject({ status: 'unpackaged', eulaAcceptedAt: null });
    await expect(stat(join(missing.managed, 'server', 'eula.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await tampered.server.dispose();
    await missing.server.dispose();
    await rm(tampered.root, { recursive: true, force: true });
    await rm(missing.root, { recursive: true, force: true });
  }
});

test('disabling during first provisioning aborts it and persists the stop', async () => {
  const { root, managed, server } = await fixture(true);
  let fetchCount = 0;
  let observeFetch: () => void = () => undefined;
  const fetching = new Promise<void>(resolve => { observeFetch = resolve; });
  vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => {
    if (++fetchCount === 4) observeFetch();
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  try {
    const starting = server.acceptEula();
    await fetching;
    const stopped = server.setSettings({ enabled: false });
    await starting;
    expect(await stopped).toMatchObject({ status: 'stopped', settings: { enabled: false } });
    expect(fetchCount).toBe(4);
    await expect(stat(join(managed, 'server-pid.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await server.dispose();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

test('rotates only completed world snapshots and excludes locks and raw worlds from profile archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-dedicated-world-'));
  const world = join(root, 'server', 'world');
  const backups = join(root, 'backups');
  try {
    await mkdir(world, { recursive: true });
    await writeFile(join(world, 'session.lock'), '');
    await writeFile(join(world, 'level.dat'), 'test level');
    await maintainBackups(backups);
    await writeFile(join(backups, 'other-user-file'), 'keep');
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let day = 1; day <= 4; day++) {
      vi.setSystemTime(new Date(`2020-01-0${day}T12:00:00.000Z`));
      expect(await snapshotWorld(world, backups, new AbortController().signal)).toBe(new Date().toISOString());
    }
    const paths = (await readdir(backups)).filter(name => name.startsWith('2020-'));
    expect(paths).toHaveLength(3);
    expect(paths.every(name => !name.startsWith('2020-01-01'))).toBe(true);
    for (const snapshot of paths) {
      expect(await readdir(join(backups, snapshot, 'world'))).toEqual(['level.dat']);
      expect(await readFile(join(backups, snapshot, 'world', 'level.dat'), 'utf8')).toBe('test level');
    }
    expect(await readFile(join(backups, 'other-user-file'), 'utf8')).toBe('keep');
    expect(PROFILE_ROOTS).not.toContain('minecraft-dedicated');
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('parses immediate owner presence and rejects chat as a console acknowledgement', async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
  const players = vi.fn();
  const server = new MinecraftDedicatedConsole(child as unknown as ChildProcessWithoutNullStreams, players);
  const ready = server.waitFor(DEDICATED_READY, 1000, 'readiness');
  stdout.write('[12:00:01] [Server thread/INFO]: Done (0.5s)! For help, type "help"\n');
  await ready;
  stdout.write('[12:00:01] [Server thread/INFO]: <Visitor> Owner joined the game\n');
  expect(players).not.toHaveBeenCalled();
  stdout.write('[12:00:01] [Server thread/INFO]: Owner joined the game\n');
  stdout.write('[12:00:02] [Server thread/INFO]: There are 1 of a max of 5 players online: Owner\n');
  stdout.write('[12:00:03] [Server thread/INFO]: Owner left the game\n');
  expect(players.mock.calls).toEqual([[{ name: 'Owner', joined: true }], [['Owner']], [{ name: 'Owner', joined: false }]]);
  const reload = server.waitFor(/^DeskPet plan configuration reloaded$/u, 1000, 'reload', undefined, 'deskpet planreload');
  expect(stdin.read().toString()).toBe('deskpet planreload\n');
  stdout.write('[12:00:04] [Server thread/INFO]: <Visitor> DeskPet plan configuration reloaded\n');
  child.emit('close', 1, null);
  await expect(reload).rejects.toThrow('server exited');
  expect(offlinePlayerUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
});
