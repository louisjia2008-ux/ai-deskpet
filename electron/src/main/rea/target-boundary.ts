import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ReaTargetBinding {
  token: string; identitySHA256: string; sourcePath: string; snapshotPath: string;
  kind: 'directory' | 'asar'; files: number; bytes: number; sourcePaths: string[]; excluded: string[];
}
export interface ReaTargetLimits { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number; maxDepth?: number; forbiddenRoots?: string[] }
export type ReaInspectionView = 'summary' | 'modules' | 'boundaries';
interface SnapshotFile { path: string; bytes: number; sha256: string }
interface Bound { binding: ReaTargetBinding; manifest: SnapshotFile[] }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);
const fail = (code: string): never => { throw new Error(`rea.${code}`); };
const allowedExtension = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.html', '.css', '.map', '.node', '.asar']);
const excludedDirectory = new Set(['.git', '.svn', 'node_modules']);
const hasControl = (path: string): boolean => [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const safeRelative = (path: string): boolean => !!path && !isAbsolute(path) && !path.includes('\\')
  && !hasControl(path) && !path.split('/').some((part) => !part || part === '.' || part === '..');

/** Only frozen selected source is handed to REA. This is an application boundary, not an OS sandbox. */
export class ReaTargetBoundary {
  readonly #root: string;
  readonly #limits: Required<Omit<ReaTargetLimits, 'forbiddenRoots'>>;
  readonly #forbidden: string[];
  readonly #bindings = new Map<string, Bound>();
  readonly #analyses = new Map<string, { targetToken: string; evidenceId: string }>();
  #closed = false;

  constructor(sessionRoot: string, limits: ReaTargetLimits = {}) {
    if (!isAbsolute(sessionRoot) || !lstatSync(sessionRoot).isDirectory() || lstatSync(sessionRoot).isSymbolicLink()
      || realpathSync(sessionRoot) !== resolve(sessionRoot)) fail('sessionRootInvalid');
    if ((lstatSync(sessionRoot).mode & 0o077) !== 0) fail('sessionRootNotPrivate');
    this.#root = resolve(sessionRoot);
    this.#limits = { maxFiles: limits.maxFiles ?? 512, maxTotalBytes: limits.maxTotalBytes ?? 64 * 1024 * 1024,
      maxFileBytes: limits.maxFileBytes ?? 32 * 1024 * 1024, maxDepth: limits.maxDepth ?? 16 };
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value < 1)) fail('invalidLimits');
    this.#forbidden = (limits.forbiddenRoots ?? []).map((path) => {
      if (!isAbsolute(path)) return fail('invalidLimits');
      return resolve(path);
    });
  }

  async #readRegular(path: string): Promise<Buffer> {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) return fail('linkedOrSpecialTarget');
    if (before.size > this.#limits.maxFileBytes) return fail('targetTooLarge');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return fail('targetChanged');
      const buffer = Buffer.alloc(opened.size + 1); let bytes = 0;
      while (bytes < buffer.length) { const result = await file.read(buffer, bytes, buffer.length - bytes, bytes); if (!result.bytesRead) break; bytes += result.bytesRead; }
      const after = await file.stat(), current = await lstat(path);
      if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) return fail('targetChanged');
      return buffer.subarray(0, bytes);
    } finally { await file.close(); }
  }
  #asarPaths(bytes: Buffer): string[] {
    // Electron ASAR pickle layout: size pickle(8), header pickle(8 + JSON), payload.
    if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) return fail('invalidAsar');
    const headerSize = bytes.readUInt32LE(4), jsonBytes = bytes.readUInt32LE(12);
    if (headerSize > 4 * 1024 * 1024 || headerSize < 8 || headerSize + 8 > bytes.length || jsonBytes > headerSize - 8) return fail('invalidAsar');
    let header: unknown;
    try { header = JSON.parse(bytes.subarray(16, 16 + jsonBytes).toString('utf8')); } catch { return fail('invalidAsar'); }
    const paths: string[] = [];
    const visit = (entry: unknown, prefix: string, depth: number): void => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || depth > this.#limits.maxDepth) return fail('invalidAsar');
      const item = entry as Record<string, unknown>;
      if (Object.hasOwn(item, 'link') || item.unpacked === true) return fail('asarExternalEntry');
      if (Object.hasOwn(item, 'files')) {
        if (!item.files || typeof item.files !== 'object' || Array.isArray(item.files)) return fail('invalidAsar');
        for (const [name, child] of Object.entries(item.files)) {
          if (!safeRelative(name) || name.includes('/')) return fail('invalidAsarPath');
          visit(child, prefix ? `${prefix}/${name}` : name, depth + 1);
        }
      } else {
        if (!safeRelative(prefix) || !Number.isSafeInteger(item.size) || (item.size as number) < 0
          || (item.size as number) > this.#limits.maxFileBytes || typeof item.offset !== 'string' || !/^\d+$/u.test(item.offset)) return fail('invalidAsar');
        const offset = Number(item.offset), size = item.size as number;
        if (!Number.isSafeInteger(offset) || offset + size > bytes.length - headerSize - 8) return fail('invalidAsar');
        paths.push(prefix); if (paths.length > this.#limits.maxFiles) return fail('targetTooManyFiles');
      }
    };
    visit(header, '', 0); return paths;
  }
  async #collect(root: string, kind: 'directory' | 'asar'): Promise<{ manifest: SnapshotFile[]; sourcePaths: string[]; excluded: string[]; values: Map<string, Buffer> }> {
    const manifest: SnapshotFile[] = [], values = new Map<string, Buffer>(), excluded: string[] = [], sourcePaths: string[] = [];
    let total = 0, logicalFiles = 0;
    const add = async (path: string, name: string): Promise<void> => {
      const value = await this.#readRegular(path); total += value.length; logicalFiles++;
      if (total > this.#limits.maxTotalBytes || logicalFiles > this.#limits.maxFiles) return fail('targetTooLarge');
      if (extname(name).toLowerCase() === '.asar') {
        const entries = this.#asarPaths(value); logicalFiles += entries.length - 1;
        if (logicalFiles > this.#limits.maxFiles) return fail('targetTooManyFiles');
        if (kind === 'asar') sourcePaths.push(...entries);
      } else if (kind === 'directory') sourcePaths.push(name);
      values.set(name, value); manifest.push({ path: name, bytes: value.length, sha256: sha(value) });
    };
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.#limits.maxDepth) return fail('targetTooDeep');
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name), name = relative(root, path).split(sep).join('/');
        if (!safeRelative(name) || name.length > 1024) return fail('invalidTargetPath');
        const info = await lstat(path);
        if (info.isSymbolicLink()) return fail('linkedOrSpecialTarget');
        if (info.isDirectory()) {
          if (excludedDirectory.has(entry.name)) excluded.push(`${name}/`); else await walk(path, depth + 1);
        } else if (info.isFile()) {
          if (entry.name === 'package.json' || allowedExtension.has(extname(entry.name).toLowerCase())) await add(path, name);
          else excluded.push(name);
        } else return fail('linkedOrSpecialTarget');
      }
    };
    if (kind === 'asar') await add(root, 'app.asar'); else await walk(root, 0);
    if (manifest.length === 0) return fail('targetEmptyScope');
    manifest.sort((a, b) => a.path.localeCompare(b.path)); sourcePaths.sort(); excluded.sort();
    return { manifest, sourcePaths, excluded, values };
  }

  async bind(selectedPath: string): Promise<ReaTargetBinding> {
    if (this.#closed) return fail('sessionClosed');
    if (!isAbsolute(selectedPath) || hasControl(selectedPath)) return fail('invalidTargetPath');
    const source = resolve(selectedPath);
    if (within(source, this.#root) || within(this.#root, source) || this.#forbidden.some((root) => within(root, source) || within(source, root))) return fail('targetOutOfScope');
    const info = await lstat(source);
    if (info.isSymbolicLink() || realpathSync(source) !== source || (!info.isDirectory() && !info.isFile())) return fail('linkedOrSpecialTarget');
    const kind = info.isDirectory() ? 'directory' : extname(source).toLowerCase() === '.asar' ? 'asar' : fail('unsupportedTarget');
    const before = await this.#collect(source, kind), token = randomUUID(), targetRoot = join(this.#root, `target-${token}`);
    await mkdir(targetRoot, { mode: 0o700 });
    const snapshotPath = kind === 'asar' ? join(targetRoot, 'app.asar') : join(targetRoot, 'snapshot');
    if (kind === 'directory') await mkdir(snapshotPath, { mode: 0o700 });
    for (const entry of before.manifest) {
      const path = kind === 'asar' ? snapshotPath : join(snapshotPath, entry.path);
      if (kind === 'directory') await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, before.values.get(entry.path)!, { flag: 'wx', mode: 0o400 });
      await chmod(path, 0o400);
    }
    const after = await this.#collect(source, kind);
    if (JSON.stringify(before.manifest) !== JSON.stringify(after.manifest) || JSON.stringify(before.excluded) !== JSON.stringify(after.excluded)) return fail('targetChanged');
    const identitySHA256 = sha(JSON.stringify({ scope: 'selected-javascript-artifact-files/v1', kind, files: before.manifest, excluded: before.excluded }));
    const binding: ReaTargetBinding = { token, identitySHA256, sourcePath: source, snapshotPath, kind,
      files: before.manifest.length, bytes: before.manifest.reduce((sum, file) => sum + file.bytes, 0), sourcePaths: before.sourcePaths, excluded: before.excluded };
    await writeFile(join(targetRoot, 'manifest.json'), `${JSON.stringify({ binding, manifest: before.manifest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    this.#bindings.set(token, { binding, manifest: before.manifest });
    await this.verify(token); return structuredClone(binding);
  }
  resolve(token: string): ReaTargetBinding {
    if (this.#closed || !this.#bindings.has(token)) return fail('targetTokenInvalid');
    return structuredClone(this.#bindings.get(token)!.binding);
  }
  async verify(token: string): Promise<ReaTargetBinding> {
    const binding = this.resolve(token), expected = this.#bindings.get(token)!;
    const actual = await this.#collect(binding.snapshotPath, binding.kind);
    if (JSON.stringify(actual.manifest) !== JSON.stringify(expected.manifest) || actual.excluded.length !== 0) return fail('snapshotChanged');
    return binding;
  }
  async analyzeArguments(token: string): Promise<Record<string, unknown>> {
    const binding = await this.verify(token);
    return { input_path: binding.snapshotPath, format: binding.kind, integrity_policy: 'fail', detail: 'summary',
      source_paths: binding.sourcePaths, max_heap_mb: 256, max_semantic_nodes: 10000, max_semantic_nodes_per_file: 2000,
      max_semantic_unknowns: 2000, max_semantic_unknowns_per_file: 500, analysis_timeout_ms: 10000 };
  }
  retainAnalysis(targetToken: string, evidenceId: string): string {
    this.resolve(targetToken);
    if (!/^ev_[a-f0-9]{64}$/u.test(evidenceId)) return fail('analysisEvidenceInvalid');
    const token = randomUUID(); this.#analyses.set(token, { targetToken, evidenceId }); return token;
  }
  resolveAnalysis(targetToken: string, analysisToken: string): { binding: ReaTargetBinding; evidenceId: string } {
    const binding = this.resolve(targetToken), record = this.#analyses.get(analysisToken);
    if (!record || record.targetToken !== targetToken) return fail('analysisTokenInvalid');
    return { binding, evidenceId: record.evidenceId };
  }
  inspectArguments(targetToken: string, analysisToken: string, view: ReaInspectionView = 'summary', page: { offset?: number; limit?: number } = {}): Record<string, unknown> {
    const { evidenceId } = this.resolveAnalysis(targetToken, analysisToken);
    const offset = page.offset ?? 0, limit = page.limit ?? 32;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return fail('viewOutOfScope');
    const selected = view === 'summary' ? { kind: 'summary' }
      : view === 'modules' ? { kind: 'javascript', collection: 'modules', projection: 'references', offset, limit }
        : view === 'boundaries' ? { kind: 'javascript-facts', where: { kinds: ['electron-main', 'electron-preload', 'electron-renderer', 'electron-utility', 'browser-window', 'context-bridge-api', 'ipc-channel', 'ipc-handler', 'worker', 'endpoint', 'native-addon'] },
          property_keys: ['path', 'channel', 'source_path', 'declared_path', 'resolved_path', 'resolution_status', 'mechanism', 'preload_path', 'web_preferences', 'api_key', 'members', 'world', 'module_path', 'module_expression', 'service_name', 'endpoint_kind', 'value', 'operation', 'mode', 'side', 'command', 'executable', 'arguments', 'argv', 'cwd', 'stdio'], include_available_property_keys: true, offset, limit } : fail('viewOutOfScope');
    return { source: { kind: 'retained-evidence', evidence_id: evidenceId }, view: selected };
  }
  dispose(): void { this.#closed = true; this.#bindings.clear(); this.#analyses.clear(); }
}
