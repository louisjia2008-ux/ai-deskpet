import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { PROCESS_OUTPUT_LIMIT, runProcess } from './coding-process';

export const EXECUTABLE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const GIT = '/usr/bin/git';
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];

export function childEnvironment(home: string, temp: string): NodeJS.ProcessEnv {
  return {
    PATH: EXECUTABLE_PATH, HOME: home, TMPDIR: temp, SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
  };
}

export const isCommit = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class CodingWorkspace {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly signal: AbortSignal,
  ) {}

  async #git(cwd: string, args: string[], allowDifferent = false) {
    const result = await runProcess(GIT, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', ...args,
    ], { cwd, env: this.env, signal: this.signal, timeout: 60_000 });
    if (result.code !== 0 && !(allowDifferent && result.code === 1)) {
      throw new Error(result.timedOut ? 'Git operation timed out.' : (result.stderr.trim().slice(0, 1500) || 'Git operation failed.'));
    }
    return result;
  }

  async #cleanHead(repository: string): Promise<string> {
    const top = (await this.#git(repository, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== repository) throw new Error('Select the root directory of a Git repository.');
    const filters = await this.#git(repository, ['config', '--includes', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|process)$'], true);
    if (filters.stdout || filters.truncated) throw new Error('The source repository config enables executable Git filters.');
    const status = await this.#git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
    if (status.stdout || status.truncated) throw new Error('The source repository must have a clean working tree.');
    const index = await this.#git(repository, ['ls-files', '-v', '-z']);
    if (index.truncated) throw new Error('The repository index exceeds this runner’s supported size.');
    if (index.stdout.split('\0').some(entry => /^[a-zS] /.test(entry))) {
      throw new Error('The repository has hidden index changes or sparse checkout entries.');
    }
    const commit = (await this.#git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    if (!isCommit(commit)) throw new Error('The repository must have a committed HEAD.');
    return commit;
  }

  async create(repository: string, workspace: string): Promise<string> {
    const base = await this.#cleanHead(repository);
    const bundle = path.join(path.dirname(workspace), 'snapshot.bundle');
    // A bundle transports Git objects only. The source config, reflog, hooks,
    // ignored files, remotes, and worktree metadata stay in the source repo.
    try {
      await this.#git(repository, ['bundle', 'create', bundle, 'HEAD']);
      await this.#git(path.dirname(workspace), ['clone', '--no-checkout', '--no-tags',
        '--no-local', '--no-hardlinks', '--template=', '--', bundle, workspace]);
      await this.#git(workspace, ['remote', 'remove', 'origin']);
      await this.#git(workspace, ['checkout', '--detach', base]);
      if (await this.#cleanHead(repository) !== base) throw new Error('The source repository changed during snapshot creation.');
    } finally {
      await rm(bundle, { force: true });
    }
    await this.check(workspace, base);
    return base;
  }

  async check(workspace: string, base: string): Promise<void> {
    if (!isCommit(base) || await realpath(workspace) !== workspace) throw new Error('The isolated task workspace is unavailable.');
    const dotGit = path.join(workspace, '.git');
    if (!(await lstat(dotGit)).isDirectory() || await pathExists(path.join(dotGit, 'objects', 'info', 'alternates'))) {
      throw new Error('The isolated task workspace has invalid Git metadata.');
    }
    if (await pathExists(path.join(workspace, '.codex', 'config.toml'))) {
      throw new Error('The isolated runner does not load repository Codex configuration. Choose a repository without .codex/config.toml.');
    }
    const remotes = await this.#git(workspace, ['remote']);
    if (remotes.stdout.trim() || remotes.truncated) throw new Error('The isolated task workspace must have no Git remotes.');
    await this.#git(workspace, ['cat-file', '-e', `${base}^{commit}`]);
  }

  async diff(workspace: string, base: string): Promise<{ diff: string; diffTruncated: boolean }> {
    const tracked = await this.#git(workspace, ['diff', ...DIFF_ARGS, base, '--']);
    const untracked = await this.#git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
    // With a truncated NUL stream the final entry may be partial.
    const files = untracked.stdout.split('\0').slice(0, -1);
    const maxNewFiles = 32;
    let diff = tracked.stdout;
    let diffTruncated = tracked.truncated || untracked.truncated || files.length > maxNewFiles;
    for (const file of files.slice(0, maxNewFiles)) {
      if (diff.length >= PROCESS_OUTPUT_LIMIT) { diffTruncated = true; break; }
      const target = path.join(workspace, file);
      if (!target.startsWith(workspace + path.sep) || !path.isAbsolute(target)) throw new Error('Invalid path in Git diff.');
      const stat = await lstat(target);
      if (!(stat.isFile() || stat.isSymbolicLink()) || stat.size > 4 * 1024 * 1024) {
        diffTruncated = true;
        continue;
      }
      const addition = await this.#git(workspace, ['diff', '--no-index', ...DIFF_ARGS, '--', '/dev/null', file], true);
      diffTruncated ||= addition.truncated || diff.length + addition.stdout.length > PROCESS_OUTPUT_LIMIT;
      diff += addition.stdout.slice(0, PROCESS_OUTPUT_LIMIT - diff.length);
    }
    return { diff, diffTruncated };
  }
}
