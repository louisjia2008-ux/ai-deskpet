import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodingTask } from '../../shared/coding-tasks';
import { CodingTaskService, codexTaskArgs, verificationArgs } from './coding-task-service';

const SESSION = '64c4bf28-64aa-4ea7-817b-576c9c0b82f2';
const OTHER = '831746b2-fb45-415b-8b66-d448e1375dfd';

const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'sandbox') {
  const [program, ...argv] = args.slice(args.indexOf('--') + 1);
  if (program === '/bin/sh') process.exit(0);
  const result = cp.spawnSync(program, argv, { stdio: 'inherit' });
  process.exit(result.status ?? 99);
}
const input = fs.readFileSync(0, 'utf8');
const emit = event => console.log(JSON.stringify(event));
const resumed = args[1] === 'resume';
const session = resumed && input.includes('wrong identity') ? '${OTHER}' : '${SESSION}';
emit({type:'thread.started', thread_id:session});
emit({type:'turn.started'});
if (input.includes('pause first') && !resumed) {
  fs.writeFileSync('progress.txt', 'interrupted progress');
  setInterval(() => {}, 1000);
} else {
  if (resumed && (args.at(-2) !== '${SESSION}' || !fs.existsSync('progress.txt'))) process.exit(3);
  fs.writeFileSync('answer.txt', 'updated');
  fs.writeFileSync('addition.txt', 'created');
  emit({type:'item.completed', item:{type:'agent_message', text:'Fixture reply.'}});
  if (!input.includes('missing completion')) emit({type:'turn.completed'});
}
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
}

describe('isolated Codex tasks', () => {
  let root: string;
  let source: string;
  let storage: string;
  let binary: string;
  let service: CodingTaskService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(tmpdir()), 'deskpet-coding-'));
    source = path.join(root, 'source');
    storage = path.join(root, 'tasks');
    binary = path.join(root, 'fixture-codex');
    await mkdir(source);
    git(source, 'init', '--quiet');
    await writeFile(path.join(source, 'answer.txt'), 'original');
    await writeFile(path.join(source, '.gitignore'), 'private.txt\n');
    await writeFile(path.join(source, 'private.txt'), 'ignored');
    await writeFile(path.join(source, 'pass.cjs'), "require('node:assert').equal(require('node:fs').readFileSync('answer.txt', 'utf8'), 'updated');");
    await writeFile(path.join(source, 'fail.cjs'), "console.log('verification ran'); process.exit(7);");
    git(source, 'add', '.');
    git(source, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'fixture');
    git(source, 'remote', 'add', 'source-only', 'https://example.test/no-access');
    await writeFile(path.join(source, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    await writeFile(binary, fakeCodex, { mode: 0o700 });
    service = new CodingTaskService(storage, async () => binary);
  });

  afterEach(async () => {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  async function waitFor(id: string, ready: (task: CodingTask) => boolean) {
    let result: CodingTask | undefined;
    await expect.poll(async () => {
      result = (await service.list()).find(task => task.id === id);
      return !!result && ready(result);
    }, { timeout: 8_000, interval: 25 }).toBe(true);
    if (!result) throw new Error('Task is missing.');
    return result;
  }

  const terminal = (task: CodingTask) => !['preparing', 'running'].includes(task.status);

  it('clones Git objects without source configuration or ignored files, then collects real test exit and new-file diff', async () => {
    const task = await service.start({ repository: source, instruction: 'Update the fixture', verificationCommand: 'node pass.cjs' });
    const completed = await waitFor(task.id, terminal);
    expect(completed).toMatchObject({ status: 'completed', sessionId: SESSION, verification: { exitCode: 0 } });
    expect(completed.diff).toContain('answer.txt');
    expect(completed.diff).toContain('addition.txt');
    expect(await readFile(path.join(source, 'answer.txt'), 'utf8')).toBe('original');
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(git(task.workspace, 'remote')).toBe('');
    expect((await stat(path.join(task.workspace, '.git'))).isDirectory()).toBe(true);
    expect(await stat(path.join(task.workspace, '.git', 'objects', 'info', 'alternates')).catch(() => null)).toBeNull();
    expect(await stat(path.join(task.workspace, '.git', 'hooks', 'post-checkout')).catch(() => null)).toBeNull();
    expect(await stat(path.join(task.workspace, 'private.txt')).catch(() => null)).toBeNull();
    expect(() => git(task.workspace, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it('does not report completion if the independent verification exits nonzero', async () => {
    const task = await service.start({ repository: source, instruction: 'Update fixture', verificationCommand: 'node fail.cjs' });
    const failed = await waitFor(task.id, terminal);
    expect(failed).toMatchObject({ status: 'failed', verification: { exitCode: 7, output: expect.stringContaining('verification ran') } });
    expect(failed.diff).toContain('addition.txt');
  });

  it('does not verify or succeed on a final-looking message without a complete turn', async () => {
    const task = await service.start({ repository: source, instruction: 'missing completion', verificationCommand: 'node pass.cjs' });
    const failed = await waitFor(task.id, terminal);
    expect(failed).toMatchObject({ status: 'failed', sessionId: SESSION, verification: null });
  });

  it('pins the session before shutdown and resumes it from a new service', async () => {
    const task = await service.start({ repository: source, instruction: 'pause first', verificationCommand: 'node pass.cjs' });
    await waitFor(task.id, current => current.sessionId === SESSION);
    await service.shutdown();
    service = new CodingTaskService(storage, async () => binary);
    expect((await service.list())[0]).toMatchObject({ status: 'interrupted', sessionId: SESSION });
    await service.resume(task.id);
    expect(await waitFor(task.id, terminal)).toMatchObject({ status: 'completed', sessionId: SESSION });
  });

  it('refuses a resumed turn that reports a different session ID', async () => {
    const task = await service.start({ repository: source, instruction: 'pause first, wrong identity', verificationCommand: 'node pass.cjs' });
    await waitFor(task.id, current => current.sessionId === SESSION);
    await service.interrupt(task.id);
    await service.resume(task.id);
    const failed = await waitFor(task.id, terminal);
    expect(failed).toMatchObject({ status: 'failed', sessionId: SESSION, verification: null, error: expect.stringContaining('different session') });
  });

  it('rejects shell strings and never substitutes another session in resume arguments', () => {
    expect(() => verificationArgs('npm test && touch other')).toThrow();
    expect(() => verificationArgs('sh -c ls')).toThrow();
    expect(codexTaskArgs('/private/tmp/task-runtime', SESSION)).toEqual(expect.arrayContaining([
      'resume', SESSION, 'approval_policy="never"', 'permissions.deskpet-task.network.enabled=false',
      '--ignore-user-config', '--ignore-rules',
    ]));
    expect(codexTaskArgs('/private/tmp/task-runtime', SESSION)).not.toContain('--last');
  });
});
