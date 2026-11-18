import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolRegistry } from '../runtime';
import { ToolFailure } from '../runtime/tool-failure';
import type { WorkspaceAccess } from './workspace';

const programs = {
  wc: '/usr/bin/wc',
  sort: '/usr/bin/sort',
  uniq: '/usr/bin/uniq',
  head: '/usr/bin/head',
  tail: '/usr/bin/tail',
} as const;
const schema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(200)
      .describe('A pipeline of wc, sort, uniq, head or tail. No shell expansion or filenames.'),
    inputPath: z.string().min(1).max(1024).describe('Workspace text file to pass on stdin.'),
    outputPath: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Optional workspace destination to create or overwrite after desktop approval.'),
  })
  .strict();

export function parsePipeline(source: string): { binary: string; args: string[] }[] {
  const stages = source.split('|');
  if (stages.length > 4) throw new ToolFailure('tool.invalidArguments');
  return stages.map((stage) => {
    const [name, ...args] = stage.trim().split(/\s+/u);
    if (!name || !Object.hasOwn(programs, name)) throw new ToolFailure('tool.invalidArguments');
    const valid =
      args.length === 0 ||
      (name === 'wc' && args.length === 1 && /^-[lcw]{1,3}$/u.test(args[0]!)) ||
      (name === 'sort' && args.length === 1 && /^-[nru]{1,3}$/u.test(args[0]!)) ||
      (name === 'uniq' && args.length === 1 && args[0] === '-c') ||
      ((name === 'head' || name === 'tail') &&
        args.length === 2 &&
        args[0] === '-n' &&
        /^(?:[1-9]\d{0,2}|1000)$/u.test(args[1]!));
    if (!valid) throw new ToolFailure('tool.invalidArguments');
    return { binary: programs[name as keyof typeof programs], args };
  });
}

// No mutable paths, executables or environment values can enter the policy.
// The child sees bytes on stdin; the host alone resolves workspace files.
function stage(binary: string, args: string[], input: Buffer, signal: AbortSignal): Promise<Buffer> {
  if (process.platform !== 'darwin') throw new ToolFailure('tool.notRequested');
  signal.throwIfAborted();
  const profile =
    '(version 1)(deny default)(import "system.sb")(deny network*)(deny file-write*)(deny mach-lookup)' +
    '(allow process-exec (literal "' +
    binary +
    '"))(allow file-read* file-map-executable (literal "' +
    binary +
    '"))(allow sysctl-read)';
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, binary, ...args], {
      cwd: '/',
      env: { LANG: 'C', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0,
      capped = false;
    const kill = () => {
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    const timer = setTimeout(kill, 3000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
    };
    child.stderr.resume(); // never return raw subprocess diagnostics
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 256 * 1024) {
        capped = true;
        kill();
      } else chunks.push(data);
    });
    child.once('error', () => {
      cleanup();
      reject(new ToolFailure('tool.executionFailed'));
    });
    child.once('close', (code) => {
      cleanup();
      if (code !== 0 || capped || signal.aborted) reject(new ToolFailure('tool.executionFailed'));
      else resolve(Buffer.concat(chunks));
    });
    // A short head pipeline may exit before it consumes the entire input.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export function registerSandboxShell(registry: ToolRegistry, workspace: WorkspaceAccess): void {
  if (process.platform !== 'darwin') return;
  registry.register({
    id: 'shell.run',
    title: 'Run a restricted workspace text pipeline',
    capabilityId: 'shell.run',
    risk: 'high',
    sideEffect: true,
    inputSchema: schema,
    description:
      'Desktop local-model only. Inspect or transform workspace text with wc, sort, uniq, head or tail. Each call needs fresh approval.',
    async execute(raw, context) {
      const input = schema.parse(raw),
        pipeline = parsePipeline(input.command);
      const text = await workspace.read(input.inputPath, context.signal, context.assertAuthorized);
      let data: Buffer = Buffer.from(text);
      if (data.length > 256 * 1024) throw new ToolFailure('tool.invalidArguments');
      for (const command of pipeline) {
        context.assertAuthorized?.();
        data = await stage(command.binary, command.args, data, context.signal);
      }
      context.assertAuthorized?.();
      context.signal.throwIfAborted();
      const output = data.toString('utf8');
      if (input.outputPath) await workspace.write(input.outputPath, output, context.signal, context.assertAuthorized);
      return {
        stdout: output.slice(0, 8000),
        truncated: output.length > 8000,
        outputCharacters: output.length,
        ...(input.outputPath ? { written: input.outputPath } : {}),
      };
    },
  });
}
