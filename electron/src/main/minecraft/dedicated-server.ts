import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defaultMinecraftDedicatedSettings, minecraftDedicatedIdentitySchema, minecraftDedicatedSettingsSchema } from '../../shared/minecraft-dedicated';
import type { MinecraftDedicatedIdentity, MinecraftDedicatedServerSnapshot, MinecraftDedicatedSettings } from '../../shared/minecraft-dedicated';
import { atomicWriteFile, removeAbandonedTemporaryFiles } from '../persistence/atomic-file';
import { assertChecksum, dedicatedEnvironment, dedicatedJavaVersion, DEDICATED_DATA_DIRECTORY, DEDICATED_HOST, DEDICATED_MINECRAFT_VERSION,
  inspectPackagedMod, prepareDedicatedRuntime } from './dedicated-artifacts';
import type { ArtifactFetch, DedicatedPackagedMod } from './dedicated-artifacts';
import { DEDICATED_READY, MinecraftDedicatedConsole } from './dedicated-console';
import { DEDICATED_LOG_CONFIG, maintainBackups, snapshotWorld, trimServerLogs } from './dedicated-world-storage';

const DEFAULT_PORT = 25565;
const DAILY_CHECK_MS = 60_000;
const STARTUP_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const RESTART_BACKOFF_MS = [1500, 5000] as const;
const PID_FILE = 'server-pid.json';
const DEFAULT_IDENTITY = { ownerName: '', botName: 'DeskPetCore' } as const;
const storedSchema = z.object({
  version: z.literal(1), settings: minecraftDedicatedSettingsSchema,
  identity: minecraftDedicatedIdentitySchema.default(DEFAULT_IDENTITY),
  port: z.number().int().min(DEFAULT_PORT).max(65_535), eulaAcceptedAt: z.iso.datetime().nullable(),
}).strict();
type Stored = z.infer<typeof storedSchema>;
type ServerStatus = MinecraftDedicatedServerSnapshot['status'];

export interface MinecraftDedicatedServerOptions {
  userDataPath: string;
  /** Parent of the generated minecraft-dedicated resources directory. */
  resourcesPath: string;
  /** Downloads the pinned runtime files; defaults to Node's fetch. */
  fetch?: ArtifactFetch;
  onChanged(snapshot: MinecraftDedicatedServerSnapshot): void;
}

const message = (error: unknown): string => error instanceof Error ? error.message.slice(0, 500) : 'Local Minecraft operation failed.';
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Same name-sensitive version-3 UUID as UUID.nameUUIDFromBytes("OfflinePlayer:" + name). */
export function offlinePlayerUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x30;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

async function selectPort(preferred: number, signal: AbortSignal): Promise<number> {
  const ports = Array.from({ length: 100 }, (_, index) => preferred + index).filter(port => port <= 65_535);
  for (const port of ports) {
    signal.throwIfAborted();
    const available = await new Promise<boolean>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false); else reject(error);
      });
      probe.listen({ host: DEDICATED_HOST, port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No local Minecraft port is available.');
}

/** Intentionally use an allowlisted, fixed server configuration. The world lives under level-name. */
function dedicatedProperties(port: number): string {
  return [
    `server-ip=${DEDICATED_HOST}`, `server-port=${port}`, 'level-name=world', 'online-mode=false', 'enforce-secure-profile=false',
    'pause-when-empty-seconds=0', 'max-players=5', 'enable-rcon=false', 'enable-query=false', 'enable-jmx-monitoring=false',
    'enable-command-block=false', 'broadcast-rcon-to-ops=false', 'motd=DeskPet Local World', '',
  ].join('\n');
}

export class MinecraftDedicatedServer {
  readonly #root: string;
  readonly #directory: string;
  readonly #stateFile: string;
  readonly #options: MinecraftDedicatedServerOptions;
  #snapshot: MinecraftDedicatedServerSnapshot;
  #stored: Stored = { version: 1, settings: { ...defaultMinecraftDedicatedSettings }, identity: { ...DEFAULT_IDENTITY },
    port: DEFAULT_PORT, eulaAcceptedAt: null };
  #packaged: DedicatedPackagedMod | null = null;
  #initialization: Promise<void> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #operation: AbortController | null = null;
  #server: MinecraftDedicatedConsole | null = null;
  #crashes: number[] = [];
  #retry: ReturnType<typeof setTimeout> | null = null;
  #daily: ReturnType<typeof setInterval> | null = null;
  #stopping = false;
  #stopSequence = 0;
  #disposed = false;

  constructor(options: MinecraftDedicatedServerOptions) {
    if (!isAbsolute(options.userDataPath) || !isAbsolute(options.resourcesPath)) throw new Error('Minecraft directories must be absolute.');
    this.#options = options;
    this.#root = join(options.userDataPath, DEDICATED_DATA_DIRECTORY);
    this.#directory = join(this.#root, 'server');
    this.#stateFile = join(this.#root, 'state.json');
    this.#snapshot = {
      settings: this.#stored.settings, port: this.#stored.port, eulaAcceptedAt: null,
      status: 'unpackaged', error: null, startedAt: null, players: [],
      ...DEFAULT_IDENTITY, worldPath: join(this.#directory, 'world'),
      backupPath: join(this.#root, 'backups'), lastBackupAt: null,
      versions: { java: dedicatedJavaVersion(), minecraft: DEDICATED_MINECRAFT_VERSION, mod: null, modSha256: null },
    };
  }

  getState(): MinecraftDedicatedServerSnapshot { return structuredClone(this.#snapshot); }

  initialize(): Promise<void> {
    this.#initialization ??= this.#load().catch(error => {
      this.#update({ status: 'error', error: message(error) });
      throw error;
    });
    return this.#initialization;
  }

  start(): Promise<MinecraftDedicatedServerSnapshot> {
    return this.#serialize(async () => {
      this.#cancelRetry();
      if (!this.#stopping) this.#crashes = [];
      return this.#start();
    });
  }

  stop(): Promise<MinecraftDedicatedServerSnapshot> {
    const sequence = this.#requestStop();
    return this.#serialize(async () => {
      try { return await this.#stop(); }
      finally { this.#finishStop(sequence); }
    });
  }

  restart(): Promise<MinecraftDedicatedServerSnapshot> {
    const sequence = this.#requestStop();
    return this.#serialize(async () => {
      try { await this.#stop(); }
      finally { this.#finishStop(sequence); }
      this.#crashes = [];
      return this.#start();
    });
  }

  acceptEula(): Promise<MinecraftDedicatedServerSnapshot> {
    return this.#serialize(async () => {
      await this.initialize();
      if (!this.#packaged || this.#disposed) return this.getState();
      if (!this.#stored.eulaAcceptedAt) await this.#save({ ...this.#stored, eulaAcceptedAt: new Date().toISOString() });
      await this.#writeEula();
      if (this.#stored.settings.enabled) return this.#start();
      return this.#update({ status: this.#idleStatus(), error: null });
    });
  }

  setIdentity(input: MinecraftDedicatedIdentity): Promise<MinecraftDedicatedServerSnapshot> {
    const identity = minecraftDedicatedIdentitySchema.parse(input);
    return this.#serialize(async () => {
      await this.initialize();
      if (this.#snapshot.ownerName === identity.ownerName && this.#snapshot.botName === identity.botName) return this.getState();
      await this.#save({ ...this.#stored, identity }, false);
      // Publish the identity after applying it to the running authority.
      try { await this.#applyPlanConfiguration(identity, this.#stored.settings); }
      finally { this.#update(identity); }
      return this.getState();
    });
  }

  setSettings(input: { [K in keyof MinecraftDedicatedSettings]?: MinecraftDedicatedSettings[K] | undefined }): Promise<MinecraftDedicatedServerSnapshot> {
    const patch = minecraftDedicatedSettingsSchema.partial().parse(input);
    const sequence = patch.enabled === false ? this.#requestStop() : null;
    return this.#serialize(async () => {
      try {
        await this.initialize();
        const previous = this.#stored.settings;
        const settings = minecraftDedicatedSettingsSchema.parse({
          enabled: patch.enabled ?? previous.enabled,
          memoryGb: patch.memoryGb ?? previous.memoryGb,
          allowPlanApproval: patch.allowPlanApproval ?? previous.allowPlanApproval,
          offlineModelDailyLimit: patch.offlineModelDailyLimit ?? previous.offlineModelDailyLimit,
        });
        await this.#save({ ...this.#stored, settings }, false);
        try {
          if (settings.enabled && settings.allowPlanApproval !== previous.allowPlanApproval) {
            await this.#applyPlanConfiguration(this.#snapshot, settings);
          }
        } finally { this.#update({ settings }); }
        if (!settings.enabled) return await this.#stop();
        return previous.enabled ? this.getState() : this.#start();
      } finally { if (sequence !== null) this.#finishStop(sequence); }
    });
  }

  backup(): Promise<MinecraftDedicatedServerSnapshot> {
    return this.#serialize(async () => {
      await this.initialize();
      if (this.#disposed || this.#stopping) throw new Error('Minecraft server is shutting down.');
      const operation = new AbortController();
      this.#operation = operation;
      try {
        await this.#ensureNoOrphan();
        const server = this.#server;
        const signal = operation.signal;
        let lastBackupAt: string | null;
        if (server && !server.closed) {
          try {
            await server.waitFor(/^(?:Automatic saving is now disabled|Saving is already turned off)$/u, 15_000, 'save-off', signal, 'save-off');
            await server.waitFor(/^Saved the game$/u, 45_000, 'save-all flush', signal, 'save-all flush');
            lastBackupAt = await snapshotWorld(this.#snapshot.worldPath, this.#snapshot.backupPath, signal);
          } finally { await this.#resumeSaving(server); }
        } else lastBackupAt = await snapshotWorld(this.#snapshot.worldPath, this.#snapshot.backupPath, signal);
        if (!lastBackupAt) throw new Error('There is no Minecraft world to back up yet.');
        return this.#update({ lastBackupAt, error: null });
      } catch (error) {
        if (!operation.signal.aborted) this.#update({ error: message(error) });
        throw error;
      } finally { if (this.#operation === operation) this.#operation = null; }
    });
  }

  async #resumeSaving(server: MinecraftDedicatedConsole): Promise<void> {
    if (server.closed) return;
    try { await server.waitFor(/^(?:Automatic saving is now enabled|Saving is already turned on)$/u, 8000, 'save-on', undefined, 'save-on'); }
    catch (error) { await this.#stop(); throw error; }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#daily) clearInterval(this.#daily);
    this.#daily = null;
    await this.stop();
  }

  async #load(): Promise<void> {
    const state = await readFile(this.#stateFile, 'utf8').catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (state !== null) this.#stored = storedSchema.parse(JSON.parse(state));
    this.#packaged = await inspectPackagedMod(this.#options.resourcesPath);
    const lastBackupAt = await maintainBackups(this.#snapshot.backupPath);
    await removeAbandonedTemporaryFiles(this.#stateFile);
    this.#update({ ...this.#stored.identity, settings: this.#stored.settings, port: this.#stored.port, eulaAcceptedAt: this.#stored.eulaAcceptedAt,
      lastBackupAt, status: this.#idleStatus(), versions: { ...this.#snapshot.versions, mod: this.#packaged?.version ?? null,
        modSha256: this.#packaged?.sha256 ?? null } });
    if (!this.#disposed) {
      this.#daily = setInterval(() => { void this.#maintain().catch(error => this.#update({ error: message(error) })); }, DAILY_CHECK_MS);
      this.#daily.unref();
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #update(patch: Partial<MinecraftDedicatedServerSnapshot>): MinecraftDedicatedServerSnapshot {
    this.#snapshot = { ...this.#snapshot, ...patch };
    const state = this.getState();
    this.#options.onChanged(state);
    return state;
  }

  #idleStatus(): ServerStatus {
    if (!this.#packaged || !this.#snapshot.versions.java) return 'unpackaged';
    return this.#stored.eulaAcceptedAt ? 'stopped' : 'eula_required';
  }

  async #save(stored: Stored, publish = true): Promise<void> {
    await atomicWriteFile(this.#stateFile, JSON.stringify(stored, null, 2) + '\n');
    this.#stored = stored;
    if (publish) this.#update({ settings: stored.settings, port: stored.port, eulaAcceptedAt: stored.eulaAcceptedAt });
  }

  #writeEula(): Promise<void> {
    if (!this.#stored.eulaAcceptedAt) throw new Error('Minecraft EULA has not been accepted.');
    return atomicWriteFile(join(this.#directory, 'eula.txt'), '# https://www.minecraft.net/eula\neula=true\n');
  }

  #writePlanConfiguration(identity: MinecraftDedicatedIdentity, settings: MinecraftDedicatedSettings): Promise<void> {
    const config = { enabled: settings.allowPlanApproval && !!identity.ownerName,
      ownerUuid: identity.ownerName ? offlinePlayerUuid(identity.ownerName) : '',
      botUuid: offlinePlayerUuid(identity.botName), botName: identity.botName };
    return atomicWriteFile(join(this.#directory, 'config', 'deskpet-plan.json'), JSON.stringify(config, null, 2) + '\n');
  }

  async #applyPlanConfiguration(identity: MinecraftDedicatedIdentity, settings: MinecraftDedicatedSettings): Promise<void> {
    const server = this.#server;
    // Before first launch the current settings and identity are applied as part of startup.
    if (!server || server.closed || this.#stopping) return;
    try {
      await this.#writePlanConfiguration(identity, settings);
      await server.waitFor(/^DeskPet plan configuration reloaded$/u, 8000, 'the plan permissions change', undefined, 'deskpet planreload');
    } catch (error) {
      // Fail closed rather than leave an old owner or grant active after a settings change.
      await this.#stop();
      this.#update({ status: 'error', error: message(error) });
      throw error;
    }
  }

  #setPlayers(event: string[] | { name: string; joined: boolean }): void {
    if (this.#snapshot.status !== 'running') return;
    const previous = this.#snapshot.players;
    const players = Array.isArray(event) ? event : event.joined ? [...new Set([...previous, event.name])] : previous.filter(name => name !== event.name);
    if (JSON.stringify([...players].sort()) !== JSON.stringify([...previous].sort())) this.#update({ players });
  }

  async #ensureNoOrphan(): Promise<void> {
    if (this.#server && !this.#server.closed) return;
    const path = join(this.#root, PID_FILE);
    const raw = await readFile(path, 'utf8').catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (raw === null) return;
    const pid = z.number().int().min(2).parse(JSON.parse(raw));
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await rm(path, { force: true });
      return;
    }
    throw new Error(`A previous Minecraft server process (PID ${pid}) is still active. Stop it before opening or backing up the world again.`);
  }

  async #start(): Promise<MinecraftDedicatedServerSnapshot> {
    await this.initialize();
    if (this.#disposed || this.#stopping || (this.#server && !this.#server.closed)) return this.getState();
    if (!this.#stored.settings.enabled || this.#idleStatus() !== 'stopped' || !this.#packaged) {
      return this.#update({ status: this.#idleStatus() });
    }
    const operation = new AbortController();
    this.#operation = operation;
    const signal = operation.signal;
    let session: MinecraftDedicatedConsole | null = null;
    this.#update({ status: 'starting', startedAt: null, players: [], error: null });
    try {
      await this.#ensureNoOrphan();
      await assertChecksum(this.#packaged.path, 'sha256', this.#packaged.sha256, signal).catch(error => {
        throw new Error(`Packaged Minecraft Mod verification failed. ${message(error)}`);
      });
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const runtime = await prepareDedicatedRuntime(this.#root, this.#directory, signal, this.#options.fetch);
      const unexpected = (await readdir(join(this.#directory, 'mods'))).filter(file => !runtime.modArtifacts.includes(file));
      if (unexpected.length) throw new Error('The dedicated Minecraft mods directory contains unverified files.');
      await trimServerLogs(this.#directory);
      const lastBackupAt = await snapshotWorld(this.#snapshot.worldPath, this.#snapshot.backupPath, signal);
      if (lastBackupAt) this.#update({ lastBackupAt });

      const port = await selectPort(this.#stored.port, signal);
      if (port !== this.#stored.port) await this.#save({ ...this.#stored, port });
      await this.#writeEula();
      await this.#writePlanConfiguration(this.#snapshot, this.#stored.settings);
      await atomicWriteFile(join(this.#directory, 'server.properties'), dedicatedProperties(port));
      const logConfig = join(this.#directory, 'deskpet-log4j.xml');
      await atomicWriteFile(logConfig, DEDICATED_LOG_CONFIG);
      const javaHome = join(this.#root, 'java-home');
      const javaTemp = join(this.#root, 'java-tmp');
      await mkdir(javaHome, { recursive: true, mode: 0o700 });
      await mkdir(javaTemp, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();

      const child = spawn(runtime.java, [
        `-Xmx${this.#stored.settings.memoryGb}G`, '-Djava.awt.headless=true', '-Duser.language=en', '-Duser.country=US',
        `-Duser.home=${javaHome}`, `-Djava.io.tmpdir=${javaTemp}`,
        '-Dfabric.gameJarPath=server.jar', `-Dfabric.addMods=${this.#packaged.path}`, `-Dlog4j.configurationFile=${logConfig}`,
        '-XX:ErrorFile=logs/hs_err_pid%p.log', '-cp', runtime.libraries.join(delimiter),
        'net.fabricmc.loader.impl.launch.knot.KnotServer', 'nogui',
      ], { cwd: this.#directory, env: { ...dedicatedEnvironment(), HOME: javaHome, USERPROFILE: javaHome, TMPDIR: javaTemp, TEMP: javaTemp, TMP: javaTemp },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      session = new MinecraftDedicatedConsole(child, event => this.#setPlayers(event));
      this.#server = session;
      const ready = session.waitFor(DEDICATED_READY, STARTUP_TIMEOUT_MS, 'readiness', signal);
      // Observe a fast launch failure immediately, even while committing the PID record.
      void ready.catch(() => undefined);
      if (child.pid) await atomicWriteFile(join(this.#root, PID_FILE), JSON.stringify(child.pid));
      const running = session;
      void running.exit.then(() => this.#onExit(running)).catch(error => this.#update({ status: 'error', error: message(error) }));
      await ready;
      if (running.closed || signal.aborted) throw new Error(running.error ?? 'Minecraft server stopped during launch.');
      running.send('list');
      return this.#update({ status: 'running', startedAt: new Date().toISOString(), error: null });
    } catch (error) {
      if (session && !session.closed && !this.#stopping) await this.#stop();
      return this.#update(signal.aborted ? { status: 'stopping' } : { status: 'error', error: message(error) });
    } finally { if (this.#operation === operation) this.#operation = null; }
  }

  #cancelRetry(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  #requestStop(): number {
    this.#stopping = true;
    this.#cancelRetry();
    this.#operation?.abort();
    return ++this.#stopSequence;
  }

  #finishStop(sequence: number): void {
    if (sequence === this.#stopSequence) this.#stopping = false;
  }

  async #stop(): Promise<MinecraftDedicatedServerSnapshot> {
    const server = this.#server;
    if (server && !server.closed) {
      server.stopping = true;
      this.#update({ status: 'stopping', players: [] });
      try { server.send('stop'); } catch { /* A process exiting concurrently can close stdin first. */ }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exited = await Promise.race([server.exit.then(() => true), new Promise<false>(resolve => {
          timeout = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        })]);
        if (!exited) { server.child.kill('SIGKILL'); await server.exit; }
      } finally { if (timeout) clearTimeout(timeout); }
    }
    if (server) await this.#forgetExited(server);
    return this.#update({ status: this.#idleStatus(), error: null, startedAt: null, players: [] });
  }

  async #forgetExited(server: MinecraftDedicatedConsole): Promise<void> {
    if (this.#server !== server || !server.closed) return;
    await rm(join(this.#root, PID_FILE), { force: true });
    this.#server = null;
  }

  #onExit(server: MinecraftDedicatedConsole): Promise<void> {
    if (this.#server === server && this.#snapshot.status === 'running') {
      this.#update({ status: this.#stopping || server.stopping ? 'stopping' : 'restarting', startedAt: null, players: [] });
    }
    return this.#serialize(async () => {
      if (this.#server !== server || !server.closed) return;
      await this.#forgetExited(server);
      if (server.stopping || this.#stopping || this.#disposed || !this.#stored.settings.enabled) return;
      const now = Date.now();
      this.#crashes = [...this.#crashes.filter(time => now - time < CRASH_WINDOW_MS), now];
      const delay = RESTART_BACKOFF_MS[this.#crashes.length - 1];
      const error = server.error ?? 'Minecraft server exited unexpectedly.';
      if (delay === undefined) { this.#update({ status: 'gave_up', error }); return; }
      this.#update({ status: 'restarting', error });
      this.#retry = setTimeout(() => {
        this.#retry = null;
        void this.#serialize(() => this.#start()).catch(error => this.#update({ status: 'error', error: message(error) }));
      }, delay);
      this.#retry.unref();
    });
  }

  async #maintain(): Promise<void> {
    if (this.#stopping || this.#disposed || this.#snapshot.status !== 'running' || this.#server?.closed) return;
    this.#server?.send('list');
    await trimServerLogs(this.#directory);
    const last = this.#snapshot.lastBackupAt;
    if (!last || new Date(last).toDateString() !== new Date().toDateString()) await this.backup();
  }
}
