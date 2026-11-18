/* global process */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, symlinkSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import configModule from './config.cjs';
import identify from './identify.cjs';
import { argumentsFor, assertSigningIdentity, performPlan, planSteps } from './run.mjs';

const roots = [];
test('daily signing accepts the exact configured trust exception and rejects other validation failures', () => {
  const identity = 'a'.repeat(40);
  const inspect = (failure = '', extra = '') => (program, args, options) => {
    assert.equal(program, '/usr/bin/security');
    assert.deepEqual(args, ['find-identity', '-p', 'codesigning']);
    assert.deepEqual(options, { capture: true });
    return [
      'Policy: Code Signing',
      '  Matching identities',
      '  1) ' + 'B'.repeat(40) + ' "Other signing certificate"',
      '  2) ' + identity.toUpperCase() + ' "Synthetic signing certificate"' + failure,
      '     2 identities found',
      '  Valid identities only',
      '  1) ' + 'B'.repeat(40) + ' "Other signing certificate"',
      '     1 valid identities found',
      extra,
    ].join('\n');
  };
  assert.doesNotThrow(() => assertSigningIdentity(identity, inspect()));
  assert.doesNotThrow(() => assertSigningIdentity(identity, inspect(' (CSSMERR_TP_NOT_TRUSTED)')));
  assert.throws(() => assertSigningIdentity('c'.repeat(40), inspect()), /signing-identity-unavailable/u);
  assert.throws(() => assertSigningIdentity('-', inspect()), /certificate-sha1-required/u);
  for (const suffix of [' (CSSMERR_TP_CERT_EXPIRED)', ' (CSSMERR_TP_CERT_REVOKED)', ' (CSSMERR_TP_NOT_TRUSTED) (CSSMERR_TP_CERT_EXPIRED)', ' (unknown failure)']) {
    assert.throws(() => assertSigningIdentity(identity, inspect(suffix)), /signing-identity-unavailable/u);
  }
  const inconsistentInventory = inspect(' (CSSMERR_TP_CERT_EXPIRED)', '  3) ' + identity.toUpperCase() + ' "Duplicate signing certificate"');
  assert.throws(() => assertSigningIdentity(identity, inconsistentInventory), /signing-identity-unavailable/u);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); delete process.env.DESKPET_INSTALL_STAGE; });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deskpet-install-test-'))); roots.push(root);
  const config = { version: 1, installedApp: join(root, 'DeskPet Electron.app'), profileRoot: join(root, 'profile'), backupRoot: join(root, 'backups'),
    stageRoot: join(root, 'stages'), signingIdentity: 'a'.repeat(40), electronZipDir: join(root, 'zip-cache'), workerDir: join(root, 'worker'),
    wechatRoot: join(root, 'wechat'), launchAgent: join(root, 'agent.plist'), launchAgentLabel: 'test.deskpet.fixture', python: join(root, 'python') };
  mkdirSync(config.stageRoot, { mode: 0o700 }); mkdirSync(join(config.installedApp, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(config.installedApp, 'Contents/Resources/app.asar'), 'fixture installed binary');
  // A plan must succeed without either personal directory existing or being opened.
  const file = join(root, 'install.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { root, config, file };
}

test('the packaged WeChat extra resource passes identify and seals the exact runtime source', () => {
  const { root } = fixture();
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = join(root, 'Candidate.app');
  const runtime = join(bundle, 'Contents/Resources/wechat-runtime');
  cpSync(join(project, 'wechat-runtime'), runtime, { recursive: true });
  const manifest = identify.verifyWeChatRuntime(bundle, project);
  assert.match(manifest['reply_policy.cjs'], /^[a-f0-9]{64}$/u);
  assert.match(manifest['deskpet_reply.cjs'], /^[a-f0-9]{64}$/u);
  writeFileSync(join(runtime, 'reply_policy.cjs'), 'different source');
  assert.throws(() => identify.verifyWeChatRuntime(bundle, project), /do not match the reviewed source files/u);
  writeFileSync(join(runtime, 'reply-policy.cjs'), 'invalid resource name');
  assert.throws(() => identify.verifyWeChatRuntime(bundle, project), /Unexpected item in the WeChat runtime resource directory/u);
});

test('strict CLI cannot smuggle install options into plan, or run without an explicit mode', () => {
  assert.deepEqual(argumentsFor(['--plan', '--config=/config.json']), { mode: '--plan', config: '/config.json', stage: undefined });
  for (const args of [[], ['--plan', '--install'], ['--plan', '--config=a', '--config=b'], ['--install', '--skip-review'], ['--plan', '--signing=-']]) assert.throws(() => argumentsFor(args));
  const approved = 'a'.repeat(64);
  assert.deepEqual(argumentsFor(['--install', '--stage=/s', `--approved-asar=${approved}`]), { mode: '--install', config: undefined, stage: '/s', approvedAsar: approved });
  for (const args of [['--plan', `--approved-asar=${approved}`], ['--install', '--approved-asar=yes'], ['--install', '--approved-asar=' + 'A'.repeat(64)],
    ['--install', `--approved-asar=${approved}`, `--approved-asar=${approved}`]]) assert.throws(() => argumentsFor(args));
});
test('external config rejects extra execution options, ad-hoc signing, overlapping roots, unsafe modes and symlinks', () => {
  const f = fixture(); assert.equal(configModule.loadConfig(f.file).installedApp, f.config.installedApp);
  for (const patch of [{ signingIdentity: '-' }, { workerDir: f.config.profileRoot }, { script: 'unsafe' }, { profileRoot: 'relative' },
    { backupRoot: '/' }, { workerDir: '/' }, { profileRoot: '/' }]) assert.throws(() => configModule.validate({ ...f.config, ...patch }));
  chmodSync(f.file, 0o644); assert.throws(() => configModule.loadConfig(f.file)); chmodSync(f.file, 0o600);
  const link = join(f.root, 'linked.json'); symlinkSync(f.file, link); assert.throws(() => configModule.loadConfig(link));
});
test('plan makes a unique protected stage, captures binary baseline, preserves all gates and never touches personal roots', async () => {
  const f = fixture(), calls = [];
  const operations = {
    build: context => { calls.push('build'); assert.equal(context.config.profileRoot, f.config.profileRoot); return { asarSHA256: 'b'.repeat(64) }; },
    validateCandidate: () => { calls.push('verify'); return { personalProfileRead: false, writesPerformed: false }; },
    acceptance: () => { calls.push('acceptance'); },
  };
  const first = await performPlan(f.file, operations), next = await performPlan(f.file, operations);
  assert.notEqual(first.stage, next.stage); assert.deepEqual(calls, ['build', 'verify', 'acceptance', 'build', 'verify', 'acceptance']);
  assert.equal(first.installed, false); assert.equal(first.listenerContacted, false); assert.equal(first.personalProfileRead, false);
  assert.equal(first.sourcePolicyApproval, 'required-separate-review');
  assert.match(readFileSync(join(first.stage, 'baseline.json'), 'utf8'), /"asarSHA256": "[a-f0-9]{64}"/u);
  assert.equal(readFileSync(join(f.config.installedApp, 'Contents/Resources/app.asar'), 'utf8'), 'fixture installed binary');
  assert(!readdirSync(f.root).includes('profile')); assert(!readdirSync(f.root).includes('worker')); assert(!readdirSync(f.root).includes('backups'));
  for (const gate of ['30-minute', '15-minute', 'SQLite', 'rollback', 'three', 'cursor', 'stopped', 'manifest', 'pause']) assert(planSteps.join(' ').includes(gate));
});
test('failed build or exact-artifact verification never advances to acceptance or produces a complete plan', async () => {
  const f = fixture();
  let called = false;
  await assert.rejects(performPlan(f.file, { build: () => { throw Error('signing-failed'); }, validateCandidate: () => { called = true; }, acceptance: () => { called = true; } }), /signing-failed/u);
  assert.equal(called, false);
  for (const directory of readdirSync(f.config.stageRoot)) assert(!readdirSync(join(f.config.stageRoot, directory)).includes('plan.json'));
});
