import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';


const MAX_FILE_BYTES = 1024 * 1024;
const WRITABLE_EXTENSIONS = new Set(['.csv', '.json', '.md', '.txt']);
const SEARCH_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.swift', '.rs', '.go', '.java', '.c', '.h', '.cpp']);
const SEARCH_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);
const MAX_SEARCH_ENTRIES = 2_000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;

export interface WorkspaceSearchOptions { path?: string; query: string; caseSensitive?: boolean; maxResults?: number }

export class WorkspaceOutputExists extends Error {
  constructor() { super('Workspace output already exists.'); }
}

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export class WorkspaceAccess {
  readonly #rootInput: string;
  #root: string | null = null;
  #rootIdentity: { dev: number; ino: number } | null = null;

  constructor(root: string, private readonly expectedIdentity?: {dev: number; ino: number}, private readonly denyPath?: (path:string) => boolean) {
    this.#rootInput = resolve(root);
  }

  async #getRoot(): Promise<string> {
    if (this.#root === null) {
      const root = await realpath(this.#rootInput);
      const info = lstatSync(this.#rootInput);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace root must not be a symbolic link.');
      if (this.expectedIdentity && (info.dev !== this.expectedIdentity.dev || info.ino !== this.expectedIdentity.ino)) throw new Error('Workspace root identity changed.');
      this.#rootIdentity = { dev: info.dev, ino: info.ino }; this.#root = root;
    }
    this.#assertRoot(); return this.#root;
  }

  #assertRoot(): void {
    const info = lstatSync(this.#rootInput);
    if (!this.#root || info.isSymbolicLink() || !info.isDirectory() || info.dev !== this.#rootIdentity?.dev || info.ino !== this.#rootIdentity.ino
      || realpathSync(this.#rootInput) !== this.#root) throw new Error('Workspace root identity changed.');
  }

  #assertPath(path: string, allowMissingLeaf = false): Stats | undefined {
    this.#assertRoot(); const root = this.#root!;
    if (this.denyPath?.(relative(root,path))) throw new Error('tool.channelBlocked');
    if (!isContained(root, path)) throw new Error('Workspace path escapes the granted root.');
    const parts = relative(root, path).split(sep).filter(Boolean); let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!); let info: Stats;
      try { info = lstatSync(current); }
      catch (error) { if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (info.isSymbolicLink()) throw new Error('Workspace path escapes through a symbolic link.');
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Workspace parent is not a directory.');
      if (index === parts.length - 1) return info;
    }
    return lstatSync(root);
  }

  async #readPath(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Workspace path must be relative.');
    const root = await this.#getRoot(); const lexical = resolve(root, relativePath);
    this.#assertPath(lexical);
    const candidate = await realpath(lexical);
    if (!isContained(root, candidate)) throw new Error('Workspace path escapes the granted root.');
    this.#assertPath(lexical); return lexical;
  }

  async read(relativePath: string, signal?: AbortSignal, authorize: () => void = () => undefined): Promise<string> {
    return (await this.readBytes(relativePath, MAX_FILE_BYTES, signal, authorize)).toString('utf8');
  }

  /** Bounded binary reads for verified local previews; the same inode and path checks apply. */
  async readBytes(relativePath: string, maxBytes = MAX_FILE_BYTES, signal?: AbortSignal, authorize: () => void = () => undefined): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * MAX_FILE_BYTES) throw new Error('Workspace read limit is invalid.');
    signal?.throwIfAborted(); authorize();
    const path = await this.#readPath(relativePath);
    const expected = await stat(path);
    if (!expected.isFile() || expected.size > maxBytes || expected.nlink !== 1) throw new Error('Workspace file is not a supported regular file.');
    signal?.throwIfAborted(); authorize(); this.#assertPath(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      signal?.throwIfAborted(); authorize();
      const current = this.#assertPath(path); const info = fstatSync(handle.fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || info.dev !== expected.dev || info.ino !== expected.ino
        || info.dev !== current?.dev || info.ino !== current.ino) throw new Error('Workspace file identity is not a supported regular file.');
      // A descriptor binds the input inode. The bounded final read has no await
      // at which another model/renderer action can replace its checked path.
      const buffer = Buffer.alloc(info.size + 1); let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted(); authorize();
        const count = readSync(handle.fd, buffer, length, buffer.length - length, length); if (count === 0) break; length += count;
      }
      if (length !== info.size) throw new Error('Workspace file changed during the read.');
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }

  async list(relativePath = '.', limit = 100, signal?: AbortSignal, authorize: () => void = () => undefined) {
    signal?.throwIfAborted();
    const path = await this.#readPath(relativePath);
    const entries: Array<{ name: string; path: string; type: 'directory' | 'file' | 'symlink' | 'other' }> = [];
    let truncated = false;
    signal?.throwIfAborted(); authorize(); this.#assertPath(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (this.denyPath?.(join(relativePath,entry.name))) continue;
      if (entries.length >= limit) { truncated = true; break; }
      entries.push({ name: entry.name, path: join(relativePath, entry.name).split('\\').join('/'), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: relativePath, entries, truncated };
  }

  async search(options: WorkspaceSearchOptions, signal?: AbortSignal, authorize: () => void = () => undefined) {
    const start = options.path ?? '.'; const maxResults = options.maxResults ?? 20;
    const query = options.caseSensitive ? options.query : options.query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string; lineTruncated: boolean }> = [];
    const directories = [start]; let visited = 0; let scannedFiles = 0; let skippedFiles = 0; let bytes = 0; let truncated = false;
    signal?.throwIfAborted();
    // Resolve the requested root before scanning so a bad path is an error,
    // rather than an apparently successful empty search.
    if (!(await stat(await this.#readPath(start))).isDirectory()) throw new Error('Search path must be a directory.');
    scan: while (directories.length > 0) {
      signal?.throwIfAborted();
      const directory = directories.pop()!;
      // Revalidate each directory/file, including descendants, against the
      // granted root. Child symlinks are never traversed.
      const directoryPath = await this.#readPath(directory);
      signal?.throwIfAborted(); authorize(); this.#assertPath(directoryPath);
      for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (++visited > MAX_SEARCH_ENTRIES) { truncated = true; break scan; }
        if (this.denyPath?.(join(directory,entry.name)) || entry.name.startsWith('.') || entry.isSymbolicLink()) { skippedFiles++; continue; }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (!SEARCH_SKIP_DIRECTORIES.has(entry.name)) directories.push(path); continue; }
        if (!entry.isFile() || !SEARCH_EXTENSIONS.has(extname(entry.name).toLowerCase())) { skippedFiles++; continue; }
        let content: string;
        try {
          const info = this.#assertPath(await this.#readPath(path));
          if (!info?.isFile() || info.size > MAX_FILE_BYTES || info.nlink !== 1) { skippedFiles++; continue; }
          if (bytes + info.size > MAX_SEARCH_BYTES) { truncated = true; break scan; }
          content = await this.read(path, signal, authorize);
          const size = Buffer.byteLength(content, 'utf8');
          if (bytes + size > MAX_SEARCH_BYTES) { truncated = true; break scan; }
          bytes += size;
        } catch { signal?.throwIfAborted(); skippedFiles++; continue; }
        scannedFiles++;
        if (content.includes('\0')) { skippedFiles++; continue; }
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!; const offset = (options.caseSensitive ? line : line.toLowerCase()).indexOf(query);
          if (offset < 0) continue;
          if (matches.length >= maxResults) { truncated = true; break scan; }
          const from = Math.max(0, offset - 120);
          matches.push({ path: path.split('\\').join('/'), line: index + 1, text: line.slice(from, from + 600), lineTruncated: from > 0 || line.length > 600 });
        }
      }
    }
    return { query: options.query, path: start, matches, scannedFiles, skippedFiles, truncated,
      scope: 'Common UTF-8 text and source files only. Hidden entries, symlinks, dependencies/build output, binary and files over 1 MiB are skipped. At most 2,000 entries and 8 MiB are scanned.' };
  }

  async write(relativePath: string, content: string, signal?: AbortSignal, authorize: () => void = () => undefined): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Workspace write exceeds the size limit.');
    if (!WRITABLE_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error('Workspace file extension is not writable.');
    return this.#writeBytes(relativePath, Buffer.from(content, 'utf8'), true, signal, authorize);
  }

  /** Host-only PDF publication. Not registered as a model tool; never overwrites a file. */
  async writeHostPdf(relativePath: string, bytes: Buffer, authorize: () => void = () => undefined): Promise<void> {
    if (extname(relativePath).toLowerCase() !== '.pdf' || bytes.length > 16 * MAX_FILE_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('chat.artifactInvalid');
    return this.#writeBytes(relativePath, bytes, false, undefined, authorize);
  }

  /** Host-only publication of a new Markdown note, without replacing an existing file. */
  async writeHostMarkdown(relativePath: string, content: string, authorize: () => void): Promise<void> {
    const bytes = Buffer.from(content, 'utf8');
    if (extname(relativePath) !== '.md' || bytes.length > MAX_FILE_BYTES) throw new Error('knowledge.noteInvalid');
    return this.#writeBytes(relativePath, bytes, false, undefined, authorize);
  }

  async #writeBytes(relativePath: string, output: Buffer, overwrite: boolean, signal?: AbortSignal, authorize: () => void = () => undefined): Promise<void> {
    if (this.denyPath?.(relativePath)) throw new Error('tool.channelBlocked');
    if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Workspace path must be relative.');
    signal?.throwIfAborted(); authorize(); const root = await this.#getRoot(); const target = resolve(root, relativePath);
    if (!isContained(root, target)) throw new Error('Workspace path escapes the granted root.');
    const parent = dirname(target); let ancestor = parent;
    while (ancestor !== root) { try { lstatSync(ancestor); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor); } }
    this.#assertPath(ancestor); await realpath(ancestor);
    // Validate every existing ancestor before ANY mkdir. Publication remains a
    // bounded synchronous host operation with no renderer/model interleaving.
    signal?.throwIfAborted(); authorize(); this.#assertPath(ancestor);
    let directory = root;
    for (const part of relative(root, parent).split(sep).filter(Boolean)) {
      directory = join(directory, part); this.#assertPath(dirname(directory));
      if (!this.#assertPath(directory, true)) { signal?.throwIfAborted(); authorize(); mkdirSync(directory, { mode: 0o700 }); }
      if (!this.#assertPath(directory)?.isDirectory()) throw new Error('Workspace parent is not a directory.');
    }
    const parentInfo = this.#assertPath(parent)!; const previous = this.#assertPath(target, true);
    if (previous && !overwrite) throw new WorkspaceOutputExists();
    if (previous && (!previous.isFile() || previous.nlink !== 1)) throw new Error('Workspace target must be an unlinked regular file.');
    signal?.throwIfAborted(); authorize();
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`); let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const opened = fstatSync(descriptor); const located = this.#assertPath(temporary)!;
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== located.dev || opened.ino !== located.ino) throw new Error('Workspace output identity changed.');
      signal?.throwIfAborted(); authorize();
      let written = 0;
      while (written < output.length) { const count = writeSync(descriptor, output, written, output.length - written, written); if (count === 0) throw new Error('Workspace output write stalled.'); written += count; }
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      const currentParent = this.#assertPath(parent)!;
      if (currentParent.dev !== parentInfo.dev || currentParent.ino !== parentInfo.ino) throw new Error('Workspace parent identity changed.');
      const current = this.#assertPath(target, true);
      if (current && (!current.isFile() || current.nlink !== 1 || (previous && (current.dev !== previous.dev || current.ino !== previous.ino)))) throw new Error('Workspace target identity changed.');
      signal?.throwIfAborted(); authorize();
      if (overwrite) renameSync(temporary, target);
      else { linkSync(temporary, target); unlinkSync(temporary); }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      // Remove only our still-contained temporary output, never follow a moved parent.
      try { this.#assertPath(parent); const info = this.#assertPath(temporary, true); if (info?.isFile() && info.nlink === 1) unlinkSync(temporary); } catch { /* Retain uncertain output rather than touching an outside path. */ }
    }
  }
}
