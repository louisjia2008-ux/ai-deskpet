// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline, registerSandboxShell } from './sandbox-shell';
import { ToolRegistry } from '../runtime/tool-registry';
import { WorkspaceAccess } from './workspace';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
it('rejects executable paths, shell expansions, redirects, external filenames and oversized pipelines', () => {
  for (const command of [
    'cat /etc/passwd',
    '/usr/bin/wc',
    'wc -l /etc/passwd',
    'sort -o output',
    'sort > file',
    'uniq; env',
    'head -n $(id)',
    'sort | uniq | head | tail | wc',
  ]) {
    expect(() => parsePipeline(command)).toThrow();
  }
});
it.skipIf(process.platform !== 'darwin')(
  'executes a real sandboxed text pipeline on the selected workspace data and respects cancellation before writes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-sandbox-shell-'));
    roots.push(root);
    await writeFile(join(root, 'data.txt'), 'pear\napple\npear\n');
    const registry = new ToolRegistry();
    registerSandboxShell(registry, new WorkspaceAccess(root));
    const run = registry.get('shell.run'),
      input = { command: 'sort | uniq', inputPath: 'data.txt', outputPath: 'result.txt' };
    const signal = new AbortController();
    expect(await run.execute(input, { runId: 'fixture', taskId: 'test', signal: signal.signal })).toMatchObject({
      stdout: 'apple\npear\n',
      written: 'result.txt',
    });
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('apple\npear\n');
    signal.abort();
    await expect(
      run.execute({ ...input, outputPath: 'cancelled.txt' }, { runId: 'fixture', taskId: 'test', signal: signal.signal }),
    ).rejects.toThrow();
    await expect(readFile(join(root, 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
