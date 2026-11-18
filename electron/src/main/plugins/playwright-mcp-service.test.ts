// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION, PlaywrightMcpService, playwrightMcpEnvironment } from './playwright-mcp-service';

class Worker extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  kill = vi.fn((signal: string) => {
    void Promise.resolve().then(() => { this.signalCode = signal; this.emit('exit', null, signal); });
    return true;
  });
  ready(endpoint = 'http://127.0.0.1:49153/mcp/' + 'a'.repeat(64)): void {
    this.stdout.write(JSON.stringify({type:'ready',endpoint,version:PLAYWRIGHT_MCP_VERSION}) + '\n');
  }
  process(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
let root: string, runtimeRoot: string;
const services: PlaywrightMcpService[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(),'deskpet-playwright-service-'));
  runtimeRoot = join(root,'runtime');
  await mkdir(join(runtimeRoot,'node_modules/@playwright/mcp'),{recursive:true});
  await writeFile(join(runtimeRoot,'node_modules/@playwright/mcp/package.json'),JSON.stringify({version:PLAYWRIGHT_MCP_VERSION}));
  await writeFile(join(runtimeRoot,'server.cjs'),'');
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await rm(root,{recursive:true,force:true});
});
const make = (workers: Worker[], patch: Partial<ConstructorParameters<typeof PlaywrightMcpService>[0]> = {}) => {
  const spawnRuntime = vi.fn<NonNullable<ConstructorParameters<typeof PlaywrightMcpService>[0]['spawnRuntime']>>(() => workers.shift()!.process());
  const service = new PlaywrightMcpService({runtimeRoot,profileRoot:join(root,'data'),spawnRuntime,...patch});
  services.push(service); return {service,spawnRuntime};
};

describe('managed Playwright MCP service', () => {
  it('starts once for concurrent callers, scopes the workspace and keeps the capability out of status', async () => {
    const worker = new Worker(), {service,spawnRuntime} = make([worker],{environment:{PATH:'/bin',HOME:'/home/fixture',OPENAI_API_KEY:'private',NODE_OPTIONS:'--unsafe',GITHUB_TOKEN:'secret'}});
    const first = service.ensureStarted(), second = service.ensureStarted();
    await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledOnce());
    worker.ready();
    expect(await first).toBe(await second);
    expect(spawnRuntime.mock.calls[0]).toMatchObject([
      process.execPath,[join(runtimeRoot,'server.cjs'),join(root,'data/workspace')],
      {cwd:join(root,'data/workspace'),env:{PATH:'/bin',HOME:'/home/fixture',ELECTRON_RUN_AS_NODE:'1'},windowsHide:true},
    ]);
    expect(service.status()).toEqual({state:'running'});
    expect(JSON.stringify(service.status())).not.toContain('a'.repeat(64));
    expect(spawnRuntime.mock.calls[0]![2].env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spawnRuntime.mock.calls[0]![2].env).not.toHaveProperty('NODE_OPTIONS');
    expect(spawnRuntime.mock.calls[0]![2].env).not.toHaveProperty('GITHUB_TOKEN');
    await service.stop(); expect(worker.kill).toHaveBeenCalledWith('SIGTERM'); expect(service.status()).toEqual({state:'stopped'});
  });
  it.each(['https://example.com/mcp/'+'a'.repeat(64),'http://127.0.0.1:49153/mcp','http://127.0.0.1:80/mcp/'+'a'.repeat(64)])('rejects an invalid worker endpoint %s', async endpoint => {
    const worker = new Worker(), {service,spawnRuntime} = make([worker]);
    const start = service.ensureStarted(); const rejected = expect(start).rejects.toThrow('extensions.playwrightUnavailable');
    await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledOnce()); worker.ready(endpoint); await rejected;
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(JSON.stringify(service.status())).not.toContain(endpoint);
  });
  it('invalidates an exited process and starts a new owned worker on demand', async () => {
    const first = new Worker(), second = new Worker(), {service,spawnRuntime} = make([first,second]);
    const started = service.ensureStarted(); await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledTimes(1)); first.ready(); await started;
    first.exitCode = 1; first.emit('exit',1,null); expect(service.status().state).toBe('failed');
    const next = service.ensureStarted(); await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledTimes(2));
    second.ready('http://127.0.0.1:49154/mcp/'+'b'.repeat(64)); expect(await next).toContain(':49154/');
    await service.dispose(); expect(second.kill).toHaveBeenCalledWith('SIGTERM'); expect(first.kill).not.toHaveBeenCalled();
  });
  it('cancels startup and stops only the owned child when disabled', async () => {
    const worker = new Worker(), {service,spawnRuntime} = make([worker]);
    const start = service.ensureStarted(), rejected = expect(start).rejects.toThrow('extensions.playwrightUnavailable');
    await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledOnce());
    await service.stop(); await rejected; worker.ready();
    expect(service.status()).toEqual({state:'stopped'}); expect(worker.kill).toHaveBeenCalledOnce();
  });
  it('joins parallel stops and waits for the owned process after forced termination', async () => {
    const worker = new Worker(), {service,spawnRuntime} = make([worker],{stopTimeoutMs:15});
    worker.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') void Promise.resolve().then(() => {worker.signalCode = signal; worker.emit('exit',null,signal);});
      return true;
    });
    const started = service.ensureStarted(); await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledOnce()); worker.ready(); await started;
    const firstStop = service.stop(), secondStop = service.stop(); expect(firstStop).toBe(secondStop);
    await firstStop; expect(worker.kill.mock.calls).toEqual([['SIGTERM'],['SIGKILL']]); expect(service.status()).toEqual({state:'stopped'});
  });
  it('requires the exact pinned runtime', async () => {
    await writeFile(join(runtimeRoot,'node_modules/@playwright/mcp/package.json'),JSON.stringify({version:'999.0.0'}));
    const invalid = make([]); await expect(invalid.service.ensureStarted()).rejects.toThrow('extensions.playwrightUnavailable'); expect(invalid.spawnRuntime).not.toHaveBeenCalled();
  });
  it('reports a missing bundled browser and keeps that reason after the worker exits', async () => {
    const worker = new Worker(), {service,spawnRuntime} = make([worker]);
    const start = service.ensureStarted(), rejected = expect(start).rejects.toThrow('extensions.playwrightBrowserMissing');
    await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledOnce());
    worker.stdout.write(JSON.stringify({type:'browserMissing'}) + '\n'); await rejected;
    await vi.waitFor(() => expect(worker.kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.waitFor(() => expect(worker.signalCode).toBe('SIGTERM'));
    expect(service.status()).toEqual({state:'failed',reasonCode:'extensions.playwrightBrowserMissing'});
  });
  it('fails bounded startup without exposing worker output', async () => {
    const worker = new Worker(), {service} = make([worker],{startupTimeoutMs:20});
    const start = service.ensureStarted(); worker.stderr.write('a private URL or cookie');
    await expect(start).rejects.toThrow('extensions.playwrightUnavailable');
    expect(JSON.stringify(service.status())).not.toContain('private'); expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
it('does not inherit proxy credentials, debugging hooks, or MCP environment settings', () => {
  expect(playwrightMcpEnvironment({PATH:'x',HOME:'y',HTTP_PROXY:'secret',PLAYWRIGHT_MCP_CDP_ENDPOINT:'private',NODE_OPTIONS:'hook'})).toEqual({PATH:'x',HOME:'y',ELECTRON_RUN_AS_NODE:'1'});
});
