// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerVmShell, VmSandbox, vmTemplate } from './vm-sandbox';
import type { VmExec } from './vm-sandbox';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A stand-in for limactl that tracks one instance. */
const lima = (initial: 'absent' | 'Stopped' | 'Running' | 'Broken' = 'absent', shell: (script: string, guest: string) => { code: number | null; output?: string } = () => ({ code: 0, output: 'ok\n' })) => {
  const calls: string[][] = [];
  const machine = { state: initial as string };
  const exec: VmExec = async (args, options) => {
    calls.push([...args]);
    const result = (code: number | null, output = '') => ({ code, output: Buffer.from(output), truncated: false });
    if (args[0] === 'list') return machine.state === 'absent' ? result(1) : result(0, `${machine.state}\n`);
    if (args[0] === 'create') { machine.state = 'Stopped'; return result(0); }
    if (args[0] === 'start') { machine.state = 'Running'; return result(0); }
    if (args[0] === 'stop') { machine.state = 'Stopped'; return result(0); }
    if (args[0] === 'delete') { machine.state = 'absent'; return result(0); }
    if (args[0] === 'shell' && args.includes('systemctl')) return result(0);
    const ran = shell(options?.input ?? '', args.at(-1)!);
    return result(ran.code, ran.output);
  };
  return { exec, calls, machine };
};
const sandbox = async (fake: ReturnType<typeof lima>) => {
  const userHome = await mkdtemp(join(tmpdir(), 'deskpet-vm-test-')); roots.push(userHome);
  const changes: string[] = [];
  const vm = new VmSandbox({ userHome, exec: fake.exec, onChange: status => changes.push(`${status.state}:${status.busy ?? '-'}`) });
  return { vm, userHome, changes };
};

describe('sandbox machine template', () => {
  const template = vmTemplate('/Users/someone/DeskPet Sandbox');
  it('shares one folder and nothing else from the Mac', () => {
    expect(template.match(/location:/gu)).toHaveLength(1);
    expect(template).toContain('- location: "/Users/someone/DeskPet Sandbox"\n  mountPoint: /work');
    expect(template).toContain('propagateProxyEnv: false');
    expect(template).toContain('forwardAgent: false');
    expect(template.match(/ignore: true/gu)).toHaveLength(2);
  });
  it('keeps the command user off the Mac and local networks, and marks the guest ready only after that', () => {
    for (const net of ['10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']) expect(template).toContain(net);
    expect(template).toContain('ip6tables -w -A AGENT_OUT -j REJECT');
    expect(template.indexOf('touch /run/deskpet-ready')).toBeGreaterThan(template.indexOf('iptables -w -A AGENT_OUT -j ACCEPT'));
    expect(template.indexOf('rm -f /run/deskpet-ready')).toBeLessThan(template.indexOf('useradd'));
    expect(template).not.toMatch(/sudoers|NOPASSWD/u);
  });
});

describe('sandbox machine', () => {
  it('is unavailable without Lima and never offered before the owner sets it up', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'deskpet-vm-test-')); roots.push(userHome);
    const missing = new VmSandbox({ userHome, exec: null });
    expect((await missing.status()).state).toBe('unavailable');
    expect(missing.created).toBe(false);
    await expect(missing.setup()).rejects.toThrow('vm.unavailable');
    const { vm } = await sandbox(lima());
    expect((await vm.status()).state).toBe('absent');
    expect(vm.created).toBe(false);
    expect(() => vm.run('id', 5, new AbortController().signal)).toThrow();
  });

  it('creates from the template in its own Lima home, starts, stops and removes', async () => {
    const fake = lima();
    const { vm, userHome, changes } = await sandbox(fake);
    expect((await vm.setup()).state).toBe('running');
    expect(await readFile(join(userHome, '.deskpet-vm', 'deskpet.yaml'), 'utf8')).toBe(vmTemplate(join(userHome, 'DeskPet Sandbox')));
    expect(fake.calls.filter(call => call[0] === 'create')).toEqual([['create', '--name=deskpet', '--tty=false', join(userHome, '.deskpet-vm', 'deskpet.yaml')]]);
    expect(changes).toContain('absent:setup');
    expect(vm.created).toBe(true);
    await vm.stop();
    expect((await vm.status()).state).toBe('stopped');
    expect(vm.created).toBe(true);
    await vm.remove();
    expect((await vm.status())).toMatchObject({ state: 'absent', busy: null, failed: false });
    vm.dispose();
  });

  it('reports a failed setup and a damaged machine without offering the tool', async () => {
    const fake = lima();
    const failing: VmExec = (args, options) => args[0] === 'create' ? Promise.resolve({ code: 1, output: Buffer.alloc(0), truncated: false }) : fake.exec(args, options);
    const userHome = await mkdtemp(join(tmpdir(), 'deskpet-vm-test-')); roots.push(userHome);
    const vm = new VmSandbox({ userHome, exec: failing });
    await expect(vm.setup()).rejects.toThrow('vm.createFailed');
    expect(await vm.status()).toMatchObject({ state: 'absent', failed: true, busy: null });
    const broken = await sandbox(lima('Broken'));
    expect((await broken.vm.status()).state).toBe('broken');
    expect(broken.vm.created).toBe(false);
  });

  it('starts a stopped machine for a command and runs it as the unprivileged user inside a time-limited unit', async () => {
    const seen: { script: string; guest: string }[] = [];
    const fake = lima('Stopped', (script, guest) => { seen.push({ script, guest }); return { code: 3, output: 'out\nerr\n' }; });
    const { vm } = await sandbox(fake);
    await vm.status();
    const result = await vm.run('echo out; exit 3', 45, new AbortController().signal);
    expect(result).toEqual({ exitCode: 3, output: 'out\nerr\n', truncated: false, timedOut: false });
    expect(fake.calls.some(call => call[0] === 'start')).toBe(true);
    expect(seen[0]!.script).toBe('echo out; exit 3');
    const guest = seen[0]!.guest;
    expect(guest.startsWith('test -e /run/deskpet-ready || exit 97; exec systemd-run ')).toBe(true);
    for (const part of ['--uid=agent', 'RuntimeMaxSec=45', 'KillMode=control-group', 'TasksMax=512', 'MemoryMax=3G', '--working-directory=/work', 'bash -l -s']) expect(guest).toContain(part);
    // The script travels on stdin only: nothing the model wrote is part of a command line.
    expect(fake.calls.flat().join(' ')).not.toContain('echo out');
    vm.dispose();
  });

  it('refuses to run before the guest firewall is in place and stops the unit when cancelled', async () => {
    const notReady = await sandbox(lima('Running', () => ({ code: 97 })));
    await notReady.vm.status();
    await expect(notReady.vm.run('id', 5, new AbortController().signal)).rejects.toMatchObject({ code: 'tool.executionFailed' });
    notReady.vm.dispose();
    const controller = new AbortController();
    const fake = lima('Running', () => { controller.abort(); return { code: null }; });
    const cancelled = await sandbox(fake);
    await cancelled.vm.status();
    await expect(cancelled.vm.run('sleep 100', 5, controller.signal)).rejects.toThrow();
    expect(fake.calls.some(call => call.includes('systemctl') && call.includes('stop') && /^deskpet-run-\d+-1$/u.test(call.at(-1)!))).toBe(true);
    cancelled.vm.dispose();
  });

  it('runs one command at a time', async () => {
    let active = 0, most = 0;
    const base = lima('Running');
    const slow: VmExec = async (args, options) => {
      if (args[0] !== 'shell') return base.exec(args, options);
      active += 1; most = Math.max(most, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
      return { code: 0, output: Buffer.from('x'), truncated: false };
    };
    const userHome = await mkdtemp(join(tmpdir(), 'deskpet-vm-test-')); roots.push(userHome);
    const vm = new VmSandbox({ userHome, exec: slow });
    await vm.status();
    const signal = new AbortController().signal;
    await Promise.all([vm.run('a', 5, signal), vm.run('b', 5, signal), vm.run('c', 5, signal)]);
    expect(most).toBe(1);
    vm.dispose();
  });
});

describe('vm.shell tool', () => {
  it('returns the exit code and output, shortens long output from the middle and checks the lease first', async () => {
    const long = `${'a'.repeat(5000)}${'b'.repeat(20_000)}${'c'.repeat(9000)}`;
    const fake = lima('Running', script => script === 'long' ? { code: 0, output: long } : { code: 2, output: 'no such file\n' });
    const { vm } = await sandbox(fake);
    await vm.status();
    const registry = new ToolRegistry();
    registerVmShell(registry, vm);
    const tool = registry.get('vm.shell');
    expect(tool).toMatchObject({ capabilityId: 'vm.shell', risk: 'high', sideEffect: true });
    const context = { runId: 'r', taskId: 't', signal: new AbortController().signal };
    expect(await tool.execute({ command: 'ls nothing' }, context)).toEqual({ exitCode: 2, output: 'no such file\n', truncated: false });
    const result = await tool.execute({ command: 'long' }, context) as { output: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith('a'.repeat(4000))).toBe(true);
    expect(result.output.endsWith('c'.repeat(8000))).toBe(true);
    expect(result.output).toContain('[... 22000 characters left out ...]');
    await expect(tool.execute({ command: 'id', timeoutSeconds: 601 }, context)).rejects.toThrow();
    await expect(tool.execute({ command: 'id', cwd: '/' }, context)).rejects.toThrow();
    const before = fake.calls.length;
    await expect(tool.execute({ command: 'id' }, { ...context, assertAuthorized: () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
    expect(fake.calls.length).toBe(before);
    vm.dispose();
  });
});
