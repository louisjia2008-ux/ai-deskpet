// @vitest-environment node
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMigrationHelperRunner } from '../migration/native-migration';
import { boundedChildEnvironment } from './child-environment';

const roots: string[] = [];
const forbiddenNames = ['OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'HOME', 'DESKPET_FAKE_PRIVATE_ENV'];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fakeEnvironment = (): void => {
  vi.stubEnv('OPENAI_API_KEY', 'SYNTHETIC_ENV_CREDENTIAL'); vi.stubEnv('SSH_AUTH_SOCK', '/synthetic/missing-agent.sock');
  vi.stubEnv('NODE_OPTIONS', '--trace-warnings'); vi.stubEnv('HTTP_PROXY', 'http://synthetic.invalid');
  vi.stubEnv('HTTPS_PROXY', 'http://synthetic.invalid'); vi.stubEnv('ALL_PROXY', 'http://synthetic.invalid');
  vi.stubEnv('DESKPET_FAKE_PRIVATE_ENV', 'SYNTHETIC_PRIVATE_ENVIRONMENT');
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-helper-env-')); roots.push(root);
  const executable = join(root, 'owned-helper'); const marker = join(root, 'started.json');
  const body = `#!${process.execPath}\nconst fs = require('node:fs');\nconst names = ${JSON.stringify(forbiddenNames)};\nconst environment = Object.fromEntries(names.map(name => [name, Object.hasOwn(process.env, name)]));\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({started:true}));\nconst result = {version:1,sourcePath:process.argv[process.argv.indexOf('--source')+1],sourceDigest:'${'a'.repeat(64)}',categories:[],requiresKeychainConfirmation:false,warnings:[],values:{environment,cwdIsOwned:fs.realpathSync(process.cwd())===fs.realpathSync(${JSON.stringify(root)}),pathIsBounded:process.env.PATH==='/usr/bin:/bin:/usr/sbin:/sbin'}};\nprocess.stdout.write(JSON.stringify(result));\nif (process.argv.includes('--include-secrets')) fs.writeFileSync(3,JSON.stringify({version:1,secrets:{},warnings:[]}));\n`;
  await writeFile(executable, body); await chmod(executable, 0o700);
  return { root, executable, marker, runner: new ProcessMigrationHelperRunner(executable) };
};

describe('fixed-helper credential environment boundary', () => {
  it('only propagates the declared OS runtime settings and a fixed executable lookup path', () => {
    const environment = boundedChildEnvironment({ OPENAI_API_KEY: 'SYNTHETIC', SSH_AUTH_SOCK: '/synthetic/agent', NODE_OPTIONS: '--trace-warnings',
      HTTP_PROXY: 'http://synthetic.invalid', HTTPS_PROXY: 'http://synthetic.invalid', ALL_PROXY: 'http://synthetic.invalid', HOME: '/synthetic/home',
      PATH: '/synthetic/untrusted/bin', TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8', DESKPET_FAKE_PRIVATE_ENV: 'SYNTHETIC' });
    for (const name of forbiddenNames) expect(Object.hasOwn(environment, name)).toBe(false);
    expect(environment.TMPDIR).toBe('/private/tmp'); expect(environment.LANG).toBe('en_US.UTF-8');
    expect(environment.PATH).not.toContain('/synthetic/untrusted/bin');
  });
  it.skipIf(process.platform === 'win32')('actual helper subprocess receives no inherited fake credentials, agent, Node injection or proxy environment', async () => {
    fakeEnvironment(); const f = await fixture();
    const output = await f.runner.run('export', join(f.root, 'synthetic-source'), true, new AbortController().signal);
    expect(output.result.values.environment).toEqual(Object.fromEntries(forbiddenNames.map((name) => [name, false])));
    expect(output.result.values.cwdIsOwned).toBe(true); expect(output.result.values.pathIsBounded).toBe(true);
    expect(output.secrets).toEqual({ version: 1, secrets: {}, warnings: [] });
  });
  it.skipIf(process.platform === 'win32')('does not start the fixed helper when the current request was already cancelled', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.runner.run('preview', join(f.root, 'synthetic-source'), false, controller.signal)).rejects.toThrow();
    await expect(access(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
