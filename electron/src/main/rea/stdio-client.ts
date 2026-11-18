import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ReaAllowedTool = 'analyze_javascript_application' | 'inspect_analysis_view';
export interface ReaToolContract { name: ReaAllowedTool; inputSchema: unknown; outputSchema?: unknown }
export interface ReaRuntimeConfig {
  executablePath: string; executableSHA256: string; entryPath: string; entrySHA256: string;
  packageRoot: string; sessionRoot: string; manifestPath: string; manifestSHA256: string;
  expectedToolContractsSHA256: string;
  darwinSwiftcPath?: string; darwinSwiftcSHA256?: string; darwinSDKRoot?: string;
  maxFrameBytes?: number; maxStderrBytes?: number; startupTimeoutMs?: number; toolTimeoutMs?: number; shutdownTimeoutMs?: number;
}
export interface ReaToolReply {
  isError: boolean; structuredContent?: unknown; content: unknown[];
  provenance: { untrusted: true; localOnly: true; sessionId: string; requestId: number };
}
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }
interface ManifestEntry { path: string; sha256?: string; type: 'file' | 'symlink'; target?: string }
const allowedTools: readonly ReaAllowedTool[] = ['analyze_javascript_application', 'inspect_analysis_view'];
const fail = (code: string): Error => new Error(`rea.${code}`);
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);
const safeRelative = (path: string): boolean => !!path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..');
export const canonicalReaJSON = (value: unknown): string => {
  if (value === null || typeof value !== 'object') { const encoded = JSON.stringify(value); if (typeof encoded !== 'string') throw fail('invalidJSON'); return encoded; }
  return Array.isArray(value) ? `[${value.map(canonicalReaJSON).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalReaJSON((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
export const reaToolContractsDigest = (tools: readonly ReaToolContract[]): string => digest(canonicalReaJSON([...tools].sort((a, b) => a.name.localeCompare(b.name))));

/** One fixed stdio process/session. No model, shell, setup, tool discovery registration or retry. */
export class ReaStdioClient {
  readonly sessionId = randomUUID();
  readonly #pending = new Map<number, Pending>();
  readonly #config: Required<ReaRuntimeConfig>;
  readonly #stderrHash = createHash('sha256');
  readonly #retainedEvidence = new Set<string>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #contracts: ReaToolContract[] = [];
  #ready = false;
  #busy = false;
  #closing: Promise<void> | null = null;
  #closed = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #stderrBytes = 0;
  #stdoutBytes = 0;
  #notifications = 0;
  #failureCode: string | null = null;
  #forced = false;
  #groupEmpty = true;
  #startPromise: Promise<void> | null = null;
  #temporaryRoot: string | null = null;
  #temporaryIdentity: { dev: number; ino: number } | null = null;
  #temporaryRetained = false;

  constructor(config: ReaRuntimeConfig) {
    this.#config = { ...config, darwinSwiftcPath: config.darwinSwiftcPath ?? '', darwinSwiftcSHA256: config.darwinSwiftcSHA256 ?? '', darwinSDKRoot: config.darwinSDKRoot ?? '', maxFrameBytes: config.maxFrameBytes ?? 16 * 1024 * 1024,
      maxStderrBytes: config.maxStderrBytes ?? 65536, startupTimeoutMs: config.startupTimeoutMs ?? 30000,
      toolTimeoutMs: config.toolTimeoutMs ?? 70000, shutdownTimeoutMs: config.shutdownTimeoutMs ?? 5000 };
    for (const key of ['executablePath', 'entryPath', 'packageRoot', 'sessionRoot', 'manifestPath'] as const) {
      if (!isAbsolute(config[key])) throw fail('runtimePathInvalid');
    }
    for (const key of ['executableSHA256', 'entrySHA256', 'manifestSHA256', 'expectedToolContractsSHA256'] as const) {
      if (!/^[a-f0-9]{64}$/u.test(config[key])) throw fail('runtimeIdentityInvalid');
    }
    if ([this.#config.darwinSwiftcPath, this.#config.darwinSwiftcSHA256, this.#config.darwinSDKRoot].some(Boolean)
      && (!isAbsolute(this.#config.darwinSwiftcPath) || !isAbsolute(this.#config.darwinSDKRoot) || !/^[a-f0-9]{64}$/u.test(this.#config.darwinSwiftcSHA256))) throw fail('runtimeIdentityInvalid');
    for (const key of ['maxFrameBytes', 'maxStderrBytes', 'startupTimeoutMs', 'toolTimeoutMs', 'shutdownTimeoutMs'] as const) {
      if (!Number.isSafeInteger(this.#config[key]) || this.#config[key] < 1) throw fail('runtimeLimitsInvalid');
    }
    if (this.#config.maxFrameBytes > 32 * 1024 * 1024 || this.#config.toolTimeoutMs > 120000
      || this.#config.startupTimeoutMs > 60000 || this.#config.shutdownTimeoutMs > 10000) throw fail('runtimeLimitsInvalid');
  }

  async #verifyRuntime(): Promise<void> {
    if (process.platform === 'win32') throw fail('runtimePlatformUnsupported');
    const c = this.#config;
    for (const directory of [c.packageRoot, c.sessionRoot]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== resolve(directory)) throw fail('runtimePathInvalid');
    }
    if (((await lstat(c.sessionRoot)).mode & 0o077) !== 0 || inside(c.packageRoot, c.sessionRoot) || inside(c.sessionRoot, c.packageRoot)) throw fail('runtimeSessionInvalid');
    const check = async (path: string, expected: string, maximum = 64 * 1024 * 1024): Promise<void> => {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || digest(await readFile(path)) !== expected) throw fail('runtimeIdentityMismatch');
    };
    await check(c.executablePath, c.executableSHA256, 256 * 1024 * 1024);
    if (process.platform === 'darwin' && c.darwinSwiftcPath) {
      await check(await realpath(c.darwinSwiftcPath), c.darwinSwiftcSHA256, 512 * 1024 * 1024);
      if (!(await lstat(c.darwinSDKRoot)).isDirectory()) throw fail('runtimePathInvalid');
    }
    await check(c.entryPath, c.entrySHA256); await check(c.manifestPath, c.manifestSHA256);
    if (!inside(c.packageRoot, await realpath(c.entryPath))) throw fail('runtimePathInvalid');
    const manifest: unknown = JSON.parse(await readFile(c.manifestPath, 'utf8'));
    if (!object(manifest) || manifest.version !== 1 || manifest.packageRoot !== c.packageRoot || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw fail('runtimeManifestInvalid');
    const expectedNames = new Set<string>();
    for (const raw of manifest.files as unknown[]) {
      if (!object(raw) || typeof raw.path !== 'string' || !safeRelative(raw.path) || expectedNames.has(raw.path)) throw fail('runtimeManifestInvalid');
      const entry = raw as unknown as ManifestEntry, path = join(c.packageRoot, entry.path), info = await lstat(path); expectedNames.add(entry.path);
      if (entry.type === 'symlink') {
        if (!info.isSymbolicLink() || typeof entry.target !== 'string' || await readlink(path) !== entry.target || !inside(c.packageRoot, await realpath(path))) throw fail('runtimeIdentityMismatch');
      } else if (entry.type === 'file' && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256)) {
        if (!inside(c.packageRoot, await realpath(path))) throw fail('runtimePathInvalid');
        await check(path, entry.sha256);
      } else throw fail('runtimeManifestInvalid');
    }
    const actualNames = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path); else actualNames.add(relative(c.packageRoot, path).split(sep).join('/'));
      }
    };
    await walk(c.packageRoot);
    if (actualNames.size !== expectedNames.size || [...actualNames].some((name) => !expectedNames.has(name))) throw fail('runtimeIdentityMismatch');
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(fail('sessionClosed'));
    this.#startPromise ??= this.#start().catch(async (error: unknown) => { await this.close().catch(() => undefined); throw error; });
    return this.#startPromise;
  }
  async #start(): Promise<void> {
    await this.#verifyRuntime();
    if (this.#closed) throw fail('sessionClosed');
    const c = this.#config;
    for (const name of ['cwd', 'tmp', 'cache', 'config', 'state', 'output']) {
      const path = join(c.sessionRoot, name);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail('runtimeSessionInvalid');
    }
    if (this.#closed) throw fail('sessionClosed');
    // The installed Darwin Swift compiler rejects this host's external-volume
    // TMPDIR. Give each session a new private system temp root, never HOME.
    if (process.platform === 'darwin') {
      this.#temporaryRoot = await mkdtemp('/private/tmp/deskpet-rea-');
      const identity = await lstat(this.#temporaryRoot); this.#temporaryIdentity = { dev: identity.dev, ino: identity.ino }; this.#temporaryRetained = true;
    }
    if (this.#closed) throw fail('sessionClosed');
    const temporary = this.#temporaryRoot ?? join(c.sessionRoot, 'tmp');
    const environment: NodeJS.ProcessEnv = { PATH: `${dirname(c.executablePath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
      TMPDIR: `${temporary}/`, XDG_CACHE_HOME: join(c.sessionRoot, 'cache'), XDG_CONFIG_HOME: join(c.sessionRoot, 'config'),
      XDG_STATE_HOME: join(c.sessionRoot, 'state'), HOPPER_LAUNCHER_PATH: join(c.sessionRoot, 'disabled-native-provider'),
      REA_LOG_LEVEL: 'error', REA_MCP_INPUT_SCHEMA_PROFILE: 'full', REA_MCP_OUTPUT_SCHEMA_PROFILE: 'full',
      REA_MCP_MAX_RESPONSE_BYTES: String(Math.max(10 * 1024 * 1024, c.maxFrameBytes)) };
    if (process.env.HOME !== undefined) environment.HOME = process.env.HOME;
    if (process.platform === 'darwin') {
      environment.REA_DARWIN_MODULE_CACHE_PATH = join(temporary, 'swift-module-cache');
      if (c.darwinSwiftcPath) { environment.REA_DARWIN_SWIFTC_PATH = c.darwinSwiftcPath; environment.SDKROOT = c.darwinSDKRoot; }
    }
    this.#child = spawn(c.executablePath, ['--max-old-space-size=512', c.entryPath, 'mcp'], {
      cwd: join(c.sessionRoot, 'cwd'), env: environment, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#groupEmpty = false;
    this.#child.once('error', () => this.#fatal('spawnFailed'));
    this.#child.stdin.on('error', () => { if (!this.#closed) this.#fatal('stdinFailed'); });
    this.#child.stdout.on('error', () => { if (!this.#closed) this.#fatal('stdoutFailed'); });
    this.#child.stderr.on('error', () => { if (!this.#closed) this.#fatal('stderrFailed'); });
    this.#child.once('exit', (code, signal) => {
      this.#exit = { code, signal }; this.#ready = false;
      for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(fail('serverExited')); }
      this.#pending.clear();
    });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderrBytes += chunk.length; this.#stderrHash.update(chunk);
      if (this.#stderrBytes > c.maxStderrBytes) this.#fatal('stderrLimit');
    });
    this.#child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk));
    const initialized = await this.#request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'deskpet-controlled-rea', version: '1' } }, c.startupTimeoutMs);
    if (!object(initialized) || initialized.protocolVersion !== '2025-11-25' || !object(initialized.serverInfo)
      || initialized.serverInfo.name !== 'rea' || initialized.serverInfo.version !== '6.8.0') throw fail('serverIdentityMismatch');
    this.#notify('notifications/initialized', undefined);
    const listed = await this.#request('tools/list', {}, c.startupTimeoutMs);
    if (!object(listed) || !Array.isArray(listed.tools) || listed.nextCursor !== undefined) throw fail('toolCatalogInvalid');
    const contracts = listed.tools.filter((tool) => object(tool) && typeof tool.name === 'string' && allowedTools.includes(tool.name as ReaAllowedTool))
      .map((raw) => { const tool = raw as Record<string, unknown>; return { name: tool.name as ReaAllowedTool, inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }) }; });
    if (contracts.length !== 2 || new Set(contracts.map((tool) => tool.name)).size !== 2 || reaToolContractsDigest(contracts) !== c.expectedToolContractsSHA256) throw fail('toolContractMismatch');
    this.#contracts = contracts; this.#ready = true;
  }
  tools(): ReaToolContract[] { if (!this.#ready) throw fail('notReady'); return structuredClone(this.#contracts); }

  #notify(method: string, params: unknown): void {
    if (!this.#child || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }
  #request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.#child || this.#closed || this.#exit !== null) return Promise.reject(fail('sessionClosed'));
    if (signal?.aborted) return Promise.reject(fail('cancelled'));
    const id = ++this.#nextId;
    return new Promise((resolveRequest, reject) => {
      const finishAbort = (): void => { this.#notify('notifications/cancelled', { requestId: id, reason: 'User cancelled.' }); this.#fatal('cancelled'); };
      const timer = setTimeout(() => { this.#notify('notifications/cancelled', { requestId: id, reason: 'Host deadline.' }); this.#fatal('timeout'); }, timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finishAbort); };
      this.#pending.set(id, { resolve: resolveRequest, reject, cleanup }); signal?.addEventListener('abort', finishAbort, { once: true });
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (Buffer.byteLength(frame) > 128 * 1024) { this.#fatal('requestLimit'); return; }
      this.#child!.stdin.write(`${frame}\n`, (error) => { if (error) this.#fatal('stdinFailed'); });
    });
  }
  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#stdoutBytes += chunk.length; this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(10);
      if (newline < 0) { if (this.#buffer.length > this.#config.maxFrameBytes) this.#fatal('frameLimit'); return; }
      if (newline > this.#config.maxFrameBytes) { this.#fatal('frameLimit'); return; }
      const frame = this.#buffer.subarray(0, newline); this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.length === 0) continue;
      let response: unknown;
      try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); } catch { this.#fatal('invalidFrame'); return; }
      if (!object(response) || response.jsonrpc !== '2.0') { this.#fatal('invalidFrame'); return; }
      if (typeof response.method === 'string') {
        if (++this.#notifications > 128) { this.#fatal('notificationLimit'); return; }
        // No sampling, elicitation, resource reads, registrations or external calls.
        if (response.id !== undefined) this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32601, message: 'Client capability unavailable.' } })}\n`);
        continue;
      }
      if (typeof response.id !== 'number' || !this.#pending.has(response.id)) { this.#fatal('unexpectedResponse'); return; }
      const pending = this.#pending.get(response.id)!; this.#pending.delete(response.id); pending.cleanup();
      if (Object.hasOwn(response, 'error')) pending.reject(fail('rpcError')); else if (Object.hasOwn(response, 'result')) pending.resolve(response.result);
      else { pending.reject(fail('invalidFrame')); this.#fatal('invalidFrame'); return; }
    }
  }
  #fatal(code: string): void {
    this.#failureCode ??= `rea.${code}`; this.#ready = false;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(fail(code)); }
    this.#pending.clear(); void this.close().catch(() => { this.#failureCode = 'rea.cleanupUnconfirmed'; });
  }

  async #admitArguments(name: ReaAllowedTool, args: Record<string, unknown>): Promise<void> {
    if (name === 'analyze_javascript_application') {
      const keys = ['input_path', 'format', 'integrity_policy', 'detail', 'source_paths', 'max_heap_mb', 'max_semantic_nodes', 'max_semantic_nodes_per_file', 'max_semantic_unknowns', 'max_semantic_unknowns_per_file', 'analysis_timeout_ms'];
      if (Object.keys(args).some((key) => !keys.includes(key)) || typeof args.input_path !== 'string' || !inside(this.#config.sessionRoot, await realpath(args.input_path))
        || typeof args.format !== 'string' || !['directory', 'asar'].includes(args.format) || args.integrity_policy !== 'fail' || args.detail !== 'summary') throw fail('toolArgumentsOutOfScope');
      if (args.source_paths !== undefined && (!Array.isArray(args.source_paths) || args.source_paths.length > 512 || args.source_paths.some((path) => typeof path !== 'string' || !safeRelative(path)))) throw fail('toolArgumentsOutOfScope');
      for (const [key, min, max] of [['max_heap_mb', 128, 512], ['max_semantic_nodes', 1, 10000], ['max_semantic_nodes_per_file', 1, 2000], ['max_semantic_unknowns', 1, 2000], ['max_semantic_unknowns_per_file', 1, 500], ['analysis_timeout_ms', 1, 30000]] as const) {
        if (!Number.isSafeInteger(args[key]) || (args[key] as number) < min || (args[key] as number) > max) throw fail('toolArgumentsOutOfScope');
      }
    } else {
      if (Object.keys(args).some((key) => !['source', 'view'].includes(key)) || !object(args.source) || Object.keys(args.source).some((key) => !['kind', 'evidence_id'].includes(key))
        || args.source.kind !== 'retained-evidence' || typeof args.source.evidence_id !== 'string' || !this.#retainedEvidence.has(args.source.evidence_id) || !object(args.view)
        || typeof args.view.kind !== 'string' || !['summary', 'javascript', 'javascript-facts'].includes(args.view.kind)) throw fail('toolArgumentsOutOfScope');
      if (args.view.kind !== 'summary' && (!Number.isSafeInteger(args.view.offset) || (args.view.offset as number) < 0 || !Number.isSafeInteger(args.view.limit)
        || (args.view.limit as number) < 1 || (args.view.limit as number) > 64)) throw fail('toolArgumentsOutOfScope');
    }
  }
  async callTool(name: ReaAllowedTool, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReaToolReply> {
    if (typeof name !== 'string' || !allowedTools.includes(name)) throw fail('toolNotAllowed');
    if (!this.#ready || this.#closed) throw fail('notReady');
    if (this.#busy) throw fail('sessionBusy');
    if (!object(args)) throw fail('toolArgumentsOutOfScope');
    if (options.signal?.aborted) throw fail('cancelled');
    const timeout = options.timeoutMs ?? this.#config.toolTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw fail('runtimeLimitsInvalid');
    // Freeze host-constructed arguments across asynchronous admission; callers
    // cannot swap a path or retained evidence source after it was checked.
    const admitted = structuredClone(args);
    this.#busy = true;
    try {
      await this.#admitArguments(name, admitted);
      const requestId = this.#nextId + 1, raw = await this.#request('tools/call', { name, arguments: admitted }, timeout, options.signal);
      if (!object(raw) || !Array.isArray(raw.content) || (raw.isError !== undefined && typeof raw.isError !== 'boolean')) throw fail('toolReplyInvalid');
      if (name === 'analyze_javascript_application' && raw.isError !== true && object(raw.structuredContent)) {
        const normalized = raw.structuredContent.normalized_result;
        if (object(normalized) && normalized.kind === 'summary' && normalized.parent_operation === 'analyze_javascript_application'
          && object(normalized.artifact) && normalized.artifact.path === admitted.input_path
          && typeof normalized.parent_evidence_id === 'string' && /^ev_[a-f0-9]{64}$/u.test(normalized.parent_evidence_id)) this.#retainedEvidence.add(normalized.parent_evidence_id);
      }
      return { isError: raw.isError === true, ...(raw.structuredContent === undefined ? {} : { structuredContent: raw.structuredContent }),
        content: raw.content, provenance: { untrusted: true, localOnly: true, sessionId: this.sessionId, requestId } };
    } finally { this.#busy = false; }
  }
  diagnostics(): Record<string, unknown> {
    return { sessionId: this.sessionId, pid: this.#child?.pid ?? null, executablePath: this.#config.executablePath, entryPath: this.#config.entryPath,
      sessionRoot: this.#config.sessionRoot, temporaryRoot: this.#temporaryRoot, temporaryRootRetained: this.#temporaryRetained, ready: this.#ready, closed: this.#closed, exit: this.#exit, forced: this.#forced, ownedGroupEmpty: this.#groupEmpty,
      requestsStarted: this.#nextId, stdoutBytes: this.#stdoutBytes, stderrBytes: this.#stderrBytes, stderrSHA256: this.#stderrHash.copy().digest('hex'),
      failureCode: this.#failureCode, advertisedTools: this.#contracts.map((tool) => tool.name), inheritedProviderSecrets: false, homePreserved: true,
      osSandbox: false };
  }
  close(): Promise<void> { this.#closing ??= this.#close(); return this.#closing; }
  async #close(): Promise<void> {
    this.#closed = true; this.#ready = false;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(fail('sessionClosed')); } this.#pending.clear();
    const child = this.#child, pid = child?.pid;
    if (!child || pid === undefined) { this.#groupEmpty = true; return; }
    child.stdin.end();
    const alive = (): boolean => { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
    const wait = async (deadline: number): Promise<void> => { const end = Date.now() + deadline; while (alive() && Date.now() < end) await new Promise<void>((done) => setTimeout(done, 25)); };
    await wait(this.#config.shutdownTimeoutMs);
    if (alive()) { this.#forced = true; try { process.kill(-pid, 'SIGTERM'); } catch { /* Recheck exact owned group below. */ } await wait(1000); }
    if (alive()) { this.#forced = true; try { process.kill(-pid, 'SIGKILL'); } catch { /* Recheck exact owned group below. */ } await wait(1000); }
    this.#groupEmpty = !alive(); this.#retainedEvidence.clear();
    if (!this.#groupEmpty) { this.#failureCode = 'rea.cleanupUnconfirmed'; throw fail('cleanupUnconfirmed'); }
    if (!this.#forced && this.#exit?.code === 0 && this.#temporaryRoot && this.#temporaryIdentity) {
      const info = await lstat(this.#temporaryRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.#temporaryIdentity.dev || info.ino !== this.#temporaryIdentity.ino) throw fail('temporaryOwnershipChanged');
      await rm(this.#temporaryRoot, { recursive: true }); this.#temporaryRetained = false;
    }
  }
}
