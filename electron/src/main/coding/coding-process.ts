import { spawn } from 'node:child_process';

export const PROCESS_OUTPUT_LIMIT = 128 * 1024;

export interface CodingProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function runProcess(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
  input?: string;
  onPid?: (pid: number) => void;
  onLine?: (line: string) => void;
}): Promise<CodingProcessResult> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let oversizedLine = false;
    let exited = false;
    let truncated = false;
    let timedOut = false;
    let handlerError: unknown;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') handlerError ??= error;
      }
    };
    const stop = () => {
      if (escalation || exited) return;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), 2000);
      escalation.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
    timeout.unref();
    const processLine = (line: string) => {
      if (handlerError) return;
      try { options.onLine?.(line); } catch (error) { handlerError = error; stop(); }
    };
    const append = (prior: string, chunk: string) => {
      if (prior.length + chunk.length > PROCESS_OUTPUT_LIMIT) truncated = true;
      return prior + chunk.slice(0, PROCESS_OUTPUT_LIMIT - prior.length);
    };
    options.signal.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
      if (!options.onLine) return;
      const lines = chunk.split('\n');
      for (const [index, line] of lines.entries()) {
        if (pending.length + line.length > PROCESS_OUTPUT_LIMIT) {
          pending = '';
          oversizedLine = truncated = true;
        } else if (!oversizedLine) pending += line;
        if (index === lines.length - 1) continue;
        if (!oversizedLine) processLine(pending);
        pending = '';
        oversizedLine = false;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => { /* The child may exit before consuming all input. */ });
    child.once('error', error => { handlerError = error; });
    child.once('exit', () => {
      exited = true;
      // A command can leave descendants with an inherited pipe. Terminate its
      // process group promptly and bound how long those pipes can hold us open.
      signalGroup('SIGKILL');
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 500);
      drain.unref();
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(drain);
      options.signal.removeEventListener('abort', stop);
      if (pending && !oversizedLine) processLine(pending);
      if (handlerError) reject(handlerError);
      else if (options.signal.aborted) reject(options.signal.reason);
      else resolve({ code, signal, stdout, stderr, timedOut, truncated });
    });
    try {
      if (child.pid !== undefined) options.onPid?.(child.pid);
    } catch (error) {
      handlerError = error;
      stop();
    }
    child.stdin.end(options.input);
  });
}
