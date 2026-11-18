import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { codingTaskIdSchema, codingTaskStartSchema, type CodingTask, type CodingTaskInput } from '../../shared/coding-tasks';
import { groupAlive, PROCESS_OUTPUT_LIMIT, runProcess } from './coding-process';
import { childEnvironment, CodingWorkspace, EXECUTABLE_PATH, isCommit } from './coding-workspace';

const CODEX_PATHS = [
  '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];
const PROFILE = 'deskpet-task';
const SHARED_TEMP_ROOTS = ['/private/tmp', '/private/var/tmp'];
const CODEX_LIMIT = 15 * 60_000;
const VERIFY_LIMIT = 2 * 60_000;
const VERIFIERS = new Set(['node', 'npm', 'python3', 'git']);
type StoredTask = CodingTask & { baseCommit: string | null; processGroup: number | null };
type StopMode = 'interrupted' | 'cancelled';
type ActiveTask = {
  id: string;
  controller: AbortController;
  stopMode: StopMode | null;
  done: Promise<void>;
};

async function findCodex(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Coding tasks currently require macOS.');
  for (const candidate of CODEX_PATHS) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next trusted installation path. */ }
  }
  throw new Error('A supported local Codex CLI installation is required.');
}

export function verificationArgs(command: string): [string, ...string[]] {
  const [program, ...args] = command.split(/ +/);
  if (!program || !VERIFIERS.has(program) || !args.length || args.length > 24 ||
    args.some(arg => !/^[a-zA-Z0-9._/@+%:=,-]+$/.test(arg))) {
    throw new Error('Enter a verification executable and plain arguments, such as node --test, npm test, or python3 -m unittest.');
  }
  return [program, ...args];
}

function profileArguments(temp: string, protectedPaths: string[]): string[] {
  const filesystem = [
    '":minimal"="read"',
    '":workspace_roots"={"."="write",".git"="read",".codex"="read",".agents"="read",".aws"="read"}',
    '"/opt/homebrew"="read"', '"/usr/local/bin"="read"', '"/usr/local/lib"="read"',
    `${JSON.stringify(temp)}="write"`,
    ...[...new Set([...SHARED_TEMP_ROOTS, ...protectedPaths])].map(file => `${JSON.stringify(file)}="deny"`),
  ];
  return [
    '-c', `default_permissions="${PROFILE}"`,
    '-c', `permissions.${PROFILE}.filesystem={${filesystem.join(',')}}`,
    '-c', `permissions.${PROFILE}.network.enabled=false`,
  ];
}

export function codexTaskArgs(temp: string, sessionId: string | null, protectedPaths: string[] = []): string[] {
  const config = [
    ...profileArguments(temp, protectedPaths),
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="openai"',
    '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'allow_login_shell=false',
    '-c', 'features.hooks=false',
    '-c', 'features.plugins=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'features.memories=false',
    '-c', 'features.skip_host_skill_discovery=true',
    '-c', 'features.skill_mcp_dependency_install=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', `shell_environment_policy.set={PATH=${JSON.stringify(EXECUTABLE_PATH)},HOME=${JSON.stringify(temp)},TMPDIR=${JSON.stringify(temp)},GIT_CONFIG_NOSYSTEM="1",GIT_CONFIG_GLOBAL="/dev/null",GIT_TERMINAL_PROMPT="0"}`,
    '--strict-config', '--ignore-user-config', '--ignore-rules', '--json',
  ];
  return sessionId ? ['exec', 'resume', ...config, codingTaskIdSchema.parse(sessionId), '-'] : ['exec', ...config, '-'];
}

function publicTask(task: StoredTask): CodingTask {
  const result: CodingTask & Partial<StoredTask> = { ...task };
  delete result.baseCommit;
  delete result.processGroup;
  return result;
}

const isActive = (status: CodingTask['status']) => status === 'preparing' || status === 'running';
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1600);

export class CodingTaskService {
  readonly #tasks = new Map<string, StoredTask>();
  readonly #ready: Promise<void>;
  #active: ActiveTask | null = null;
  #closing = false;

  constructor(private readonly directory: string, private readonly resolveCodex: () => Promise<string> = findCodex) {
    this.#ready = this.#load();
    void this.#ready.catch(() => { /* Public calls surface storage initialization errors. */ });
  }

  async #load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory) throw new Error('Coding task storage is not a canonical path.');
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !codingTaskIdSchema.safeParse(entry.name).success) continue;
      const directory = path.join(this.directory, entry.name);
      const record = path.join(directory, 'task.json');
      let task: StoredTask;
      try {
        const stat = await lstat(record);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        task = JSON.parse(await readFile(record, 'utf8')) as StoredTask;
        codingTaskStartSchema.parse({
          repository: task.repository, instruction: task.instruction, verificationCommand: task.verificationCommand,
        });
        if (task.id !== entry.name || task.workspace !== path.join(directory, 'workspace') ||
          (task.sessionId !== null && !codingTaskIdSchema.safeParse(task.sessionId).success) ||
          (task.processGroup !== null && (!Number.isSafeInteger(task.processGroup) || task.processGroup < 2)) ||
          (task.baseCommit !== null && !isCommit(task.baseCommit))) continue;
      } catch {
        continue;
      }
      if (isActive(task.status)) {
        task.status = 'interrupted';
        task.error = 'DeskPet closed before this task finished. Resume uses only the recorded session.';
        this.#save(task);
      }
      this.#tasks.set(task.id, task);
    }
  }

  #save(task: StoredTask): void {
    task.updatedAt = new Date().toISOString();
    const directory = path.join(this.directory, task.id);
    const temporary = path.join(directory, `task.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(task), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path.join(directory, 'task.json'));
  }

  async list(): Promise<CodingTask[]> {
    await this.#ready;
    return [...this.#tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicTask);
  }

  async start(input: CodingTaskInput): Promise<CodingTask> {
    await this.#ready;
    const spec = codingTaskStartSchema.parse(input);
    verificationArgs(spec.verificationCommand);
    if (!path.isAbsolute(spec.repository)) throw new Error('Select a local Git repository by its absolute path.');
    const repository = await realpath(spec.repository);
    if (!(await lstat(repository)).isDirectory()) throw new Error('Select a local Git repository directory.');
    if (repository === this.directory || repository.startsWith(this.directory + path.sep) ||
      this.directory.startsWith(repository + path.sep)) {
      throw new Error('Task storage and the source repository must be separate.');
    }
    this.#assertAvailable();
    const id = randomUUID();
    const directory = path.join(this.directory, id);
    const now = new Date().toISOString();
    const task: StoredTask = {
      ...spec, repository, id, workspace: path.join(directory, 'workspace'), baseCommit: null,
      processGroup: null, status: 'preparing', sessionId: null, summary: '', output: '', diff: '',
      diffTruncated: false, error: null, verification: null, createdAt: now, updatedAt: now,
    };
    this.#schedule(task, true);
    return publicTask(task);
  }

  async resume(id: string): Promise<CodingTask> {
    await this.#ready;
    const task = this.#get(id);
    this.#assertAvailable();
    if ((task.status !== 'interrupted' && task.status !== 'failed') || !task.sessionId || !task.baseCommit) {
      throw new Error('There is no pinned session to resume for this task.');
    }
    if (task.processGroup !== null && groupAlive(task.processGroup)) {
      throw new Error('The previous process group is still present. Resume is blocked to avoid overlapping runs.');
    }
    task.processGroup = null;
    task.status = 'preparing';
    task.error = null;
    this.#schedule(task, false);
    return publicTask(task);
  }

  async cancel(id: string): Promise<CodingTask> { return this.#stop(id, 'cancelled'); }
  async interrupt(id: string): Promise<CodingTask> { return this.#stop(id, 'interrupted'); }

  async shutdown(): Promise<void> {
    this.#closing = true;
    const active = this.#active;
    if (active) {
      active.stopMode ??= 'interrupted';
      active.controller.abort(new Error('DeskPet is closing.'));
      await active.done;
    }
  }

  #get(id: string): StoredTask {
    const task = this.#tasks.get(codingTaskIdSchema.parse(id));
    if (!task) throw new Error('Coding task was not found.');
    return task;
  }

  #assertAvailable(): void {
    if (this.#closing || this.#active) throw new Error('Only one coding task can run at a time.');
  }

  async #stop(id: string, mode: StopMode): Promise<CodingTask> {
    await this.#ready;
    const task = this.#get(id);
    const active = this.#active;
    if (!active || active.id !== id) return publicTask(task);
    active.stopMode ??= mode;
    active.controller.abort(new Error(mode === 'cancelled' ? 'Coding task cancelled.' : 'Coding task interrupted.'));
    await active.done;
    return publicTask(task);
  }

  #schedule(task: StoredTask, create: boolean): void {
    const active: ActiveTask = { id: task.id, controller: new AbortController(), stopMode: null, done: Promise.resolve() };
    this.#active = active;
    this.#tasks.set(task.id, task);
    active.done = this.#run(task, active, create).catch(error => {
      task.status = active.stopMode ?? 'failed';
      task.error = errorMessage(error);
      try { this.#save(task); } catch { /* In-memory failure still blocks any success report. */ }
    }).finally(() => { if (this.#active === active) this.#active = null; });
  }

  #log(task: StoredTask, line: string): void {
    task.output = (task.output + line.slice(0, 5000) + '\n').slice(-PROCESS_OUTPUT_LIMIT);
  }

  async #run(task: StoredTask, active: ActiveTask, create: boolean): Promise<void> {
    const directory = path.dirname(task.workspace);
    const temp = path.join(directory, 'runtime');
    const signal = active.controller.signal;
    const verifierEnvironment = childEnvironment(temp, temp);
    const git = new CodingWorkspace(verifierEnvironment, signal);
    if (create) {
      await mkdir(directory, { mode: 0o700 });
      this.#save(task);
      await mkdir(temp, { mode: 0o700 });
    } else {
      this.#save(task);
    }
    const binary = await this.resolveCodex();
    if (create) {
      task.baseCommit = await git.create(task.repository, task.workspace);
      this.#save(task);
    }
    if (!task.baseCommit || await realpath(temp) !== temp) throw new Error('The isolated task directory is unavailable.');
    await git.check(task.workspace, task.baseCommit);
    const host = homedir();
    const codexHome = path.join(host, '.codex');
    const canonicalCodexHome = await realpath(codexHome).catch(() => codexHome);
    const protectedPaths = [task.repository, codexHome, canonicalCodexHome];
    const sandboxArgs = ['sandbox', ...profileArguments(temp, protectedPaths), '--permission-profile', PROFILE, '-C', task.workspace, '--'];
    const outside = path.join(directory, 'scope-check');
    const originalGit = path.join(task.repository, '.git');
    const originalProbe = (await lstat(originalGit)).isDirectory() ? path.join(originalGit, 'HEAD') : originalGit;
    await writeFile(outside, 'Scope check for DeskPet coding task.\n', { mode: 0o600 });
    await chmod(outside, 0o600);
    const external = {
      ...verifierEnvironment,
      // The verifier loads no user Codex configuration or credentials.
      CODEX_HOME: temp,
    };
    const runOptions = {
      cwd: task.workspace, signal,
      onPid: (pid: number) => { task.processGroup = pid; this.#save(task); },
    };
    try {
      const preflight = await runProcess(binary, [...sandboxArgs, '/bin/sh', '-c',
        'if /bin/cat "$1" >/dev/null 2>&1 || /bin/cat "$2" >/dev/null 2>&1 || /usr/bin/touch .git/deskpet-scope-test 2>/dev/null; then exit 71; fi; /bin/ls .git >/dev/null && /usr/bin/touch "$3"',
        'deskpet-scope-check', outside, originalProbe, path.join(temp, 'scope-write-check'),
      ], { ...runOptions, env: external, timeout: 15_000 });
      if (preflight.code !== 0 || preflight.timedOut) {
        throw new Error('Codex workspace isolation could not be verified. ' + preflight.stderr.trim().slice(0, 700));
      }
      task.status = 'running';
      task.summary = '';
      task.verification = null;
      this.#save(task);
      const previousSession = task.sessionId;
      let observedSession = false;
      let turnStarted = false;
      let turnCompleted = false;
      let turnFailed = false;
      const input = [
        'Work only in this isolated local checkout. Keep your changes in the working tree for human review.',
        'Do not push, change Git configuration, use external services, or copy data out of this workspace.',
        previousSession ? 'Continue the previous interrupted task from the current files and earlier progress.' : 'Start the user’s task.',
        task.instruction,
        'DeskPet will separately run this verification command after your turn: ' + task.verificationCommand,
      ].join('\n\n');
      const result = await runProcess(binary, codexTaskArgs(temp, previousSession, protectedPaths), {
        ...runOptions, env: { ...childEnvironment(host, temp), CODEX_HOME: codexHome },
        input, timeout: CODEX_LIMIT,
        onLine: (line) => {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (event?.type === 'thread.started') {
            const session = codingTaskIdSchema.parse(event.thread_id);
            if (task.sessionId && task.sessionId !== session) throw new Error('Codex returned a different session ID.');
            task.sessionId = session;
            observedSession = true;
            this.#save(task);
          }
          if (!observedSession) return;
          if (event.type === 'turn.started') turnStarted = true;
          if (event.type === 'turn.completed') turnCompleted = true;
          if (event.type === 'turn.failed') {
            turnFailed = true;
            if (typeof event.error?.message === 'string') this.#log(task, event.error.message);
          }
          if (event.type !== 'item.completed') return;
          const item = event.item;
          if (item?.type === 'agent_message' && typeof item.text === 'string') task.summary = item.text.slice(0, 12_000);
          if (item?.type === 'command_execution' && typeof item.command === 'string') {
            this.#log(task, `[Codex shell, exit ${String(item.exit_code ?? '?')}] ${item.command}`);
          }
        },
      });
      this.#log(task, `[Codex exit] ${result.code ?? result.signal ?? 'unknown'}`);
      if (result.stderr.trim()) this.#log(task, result.stderr.trim());
      if (!observedSession || !turnStarted || !turnCompleted || turnFailed || result.code !== 0 || !task.summary.trim() || result.timedOut) {
        throw new Error(result.timedOut ? 'Codex reached its task time limit.' : 'Codex did not finish a valid turn.');
      }
      await git.check(task.workspace, task.baseCommit);
      const before = await git.diff(task.workspace, task.baseCommit);
      Object.assign(task, before);
      this.#save(task);
      const verification = await runProcess(binary, [...sandboxArgs, ...verificationArgs(task.verificationCommand)], {
        ...runOptions, env: external, timeout: VERIFY_LIMIT,
      });
      task.verification = {
        command: task.verificationCommand, exitCode: verification.code,
        output: [verification.stdout, verification.stderr].filter(Boolean).join('\n').slice(0, PROCESS_OUTPUT_LIMIT),
        timedOut: verification.timedOut, truncated: verification.truncated ||
          verification.stdout.length + verification.stderr.length > PROCESS_OUTPUT_LIMIT,
      };
      const after = await git.diff(task.workspace, task.baseCommit);
      Object.assign(task, after);
      if (verification.code !== 0 || verification.timedOut) throw new Error('The independent verification command did not pass.');
      if (before.diffTruncated || after.diffTruncated) {
        throw new Error('The working diff exceeds this runner’s verification limit. Review the recorded changes.');
      }
      if (before.diff !== after.diff) {
        throw new Error('The verification command changed the working diff. Review the recorded changes.');
      }
      task.status = 'completed';
    } finally {
      if (task.processGroup !== null && !groupAlive(task.processGroup)) task.processGroup = null;
      this.#save(task);
    }
  }
}
