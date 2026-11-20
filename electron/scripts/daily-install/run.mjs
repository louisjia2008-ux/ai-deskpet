/* global process, console */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import configModule from './config.cjs';
import { verifyMacPackage } from '../verify-mac-package.mjs';

const here = dirname(fileURLToPath(import.meta.url)), project = resolve(here, '../..');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const check = configModule.check;
export function argumentsFor(argv) {
  check(argv.filter(value => ['--plan', '--install', '--build-only'].includes(value)).length === 1, 'choose-plan-or-install');
  check(argv.every(value => ['--plan', '--install', '--build-only'].includes(value) || /^--(?:config|stage|approved-asar)=.+$/u.test(value)), 'unknown-install-option');
  const option = name => { const values = argv.filter(value => value.startsWith(`--${name}=`)); check(values.length <= 1, 'duplicate-install-option'); return values[0]?.slice(name.length + 3); };
  const mode = argv.find(value => ['--plan', '--install', '--build-only'].includes(value)), approvedAsar = option('approved-asar');
  // An approval names one exact candidate; it is never a general "yes".
  check(approvedAsar === undefined || (mode === '--install' && /^[a-f0-9]{64}$/u.test(approvedAsar)), 'approved-asar-invalid');
  return { mode, config: option('config'), stage: option('stage'), ...(approvedAsar ? { approvedAsar } : {}) };
}
export const planSteps = Object.freeze([
  'Review exact source/main/ASAR identities in canonical install-cutover-policy.mjs; retain all predecessor gates; never auto-approve.',
  'Run release-policy tests and isolated packaged WeChat acceptance against this exact signed ASAR, with one worker and native-dialog stub.',
  'With owner present: save prior pause state, pause listener and require a fresh live paused heartbeat.',
  'Quit the daily app normally; reject writers, locks, recovery and staging markers.',
  'Back up stable listener configuration, bindings, code, LaunchAgent and SQLite; require integrity_check=ok and unchanged paused PID.',
  'Copy stopped encrypted profile inputs, compare live/copy hashes and read-only inventory; inspect through isolated exact-artifact maintenance.',
  'Apply canonical retained-automation and future-job policies; require 30-minute freshness and at least 15-minute future-job buffer.',
  'Run canonical binary-only cutover with exact old/new hashes and verified profile-root backup. No migration or new grants.',
  'Verify both signatures, resources, backup/live profile inventory and hashes before launch; retain evidence with checkpoint.',
  'Swap only manifest-listed worker resources while paused; require fresh paused launchd PID and stable protocol; rollback copied code on failure.',
  'Owner verifies existing DB owner/group binding and cursor baseline while paused. Never silently reset cursors or restore an admitted-message DB snapshot.',
  'Only after verification: retain newest three checkpoints; owner starts app normally and resumes listener only if this update originally paused it.',
]);

function command(executable, args, { env = {}, capture = false } = {}) {
  return execFileSync(executable, args, { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}
function node(name, args = [], options) { return command(process.execPath, [join(here, name), ...args], options); }
function installerArgs(context, identity) {
  return [`--app=${identity.bundle}`, `--expected-asar=${identity.asarSHA256}`, `--installed-app=${context.config.installedApp}`,
    `--data-root=${context.config.profileRoot}`, `--backup-root=${context.config.backupRoot}`, `--checkpoint=${context.checkpoint}`];
}
function build(context) {
  const { stage, config } = context;
  assertSigningIdentity(config.signingIdentity);
  const env = { DESKPET_PACKAGE_MODE: 'daily', DESKPET_MAC_SIGN_IDENTITY: config.signingIdentity, DESKPET_ELECTRON_ZIP_DIR: config.electronZipDir };
  check(!existsSync(join(stage, 'forge')), 'build-stage-already-used');
  // Same dependencies as the canonical package command, not an abbreviated build.
  for (const script of ['build:migration', 'prepare:minecraft', 'prepare:minecraft-companion', 'prepare:minecraft-shared', 'prepare:minecraft-dedicated', 'prepare:playwright-mcp']) command('npm', ['run', script], { env });
  command(process.execPath, ['-e', 'require("@electron-forge/core").api.package({dir:process.cwd(),platform:"darwin",arch:process.arch,outDir:process.argv[1]}).catch(error=>{console.error(error);process.exitCode=1})', join(stage, 'forge')], { env });
  const bundle = join(stage, 'forge', `DeskPet Electron-darwin-${process.arch}`, 'DeskPet Electron.app');
  verifyMacPackage(bundle, 'daily', config.signingIdentity);
  command(process.execPath, ['scripts/audit-package.mjs', dirname(bundle)], { env });
  node('identify.cjs', [bundle], { env });
  return read(join(stage, 'package-identity.json'));
}

/** A daily plan must fail closed, not silently fall back to development ad-hoc signing. */
export function assertSigningIdentity(identity, inspect = command) {
  check(/^[a-f0-9]{40}$/iu.test(identity), 'certificate-sha1-required');
  // Include matching identities because local self-signed certificates are not in the trusted-only list.
  const inventory = inspect('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { capture: true });
  const identityLine = /^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"(?:[^"\\]|\\.)*"(.*)$/u;
  const statuses = inventory.split(/\r?\n/u).flatMap(line => {
    const match = identityLine.exec(line);
    return match?.[1].toLowerCase() === identity.toLowerCase() ? [match[2].trim()] : [];
  });
  check(statuses.length && statuses.every(status => status === '' || status === '(CSSMERR_TP_NOT_TRUSTED)'), 'signing-identity-unavailable');
}
function acceptance(context, identity) {
  command('npm', ['run', 'test:release-policy']);
  command('npx', ['playwright', 'test', 'tests/e2e/wechat-settings-packaged.spec.ts', '--workers=1'], { env: {
    DESKPET_PACKAGED_APP: join(identity.bundle, 'Contents/MacOS/deskpet-electron'), DESKPET_EXPECTED_ASAR_SHA256: identity.asarSHA256,
  } });
  save(join(context.stage, 'packaged-acceptance.json'), { asarSHA256: identity.asarSHA256, passed: true, isolated: true, checkedAt: new Date().toISOString() });
}
function validateCandidate(context, identity) {
  check(hash(join(context.config.installedApp, 'Contents/Resources/app.asar')) === identity.previousAppASARSHA256, 'installed-baseline-changed');
  check(hash(join(identity.bundle, 'Contents/Resources/app.asar')) === identity.asarSHA256, 'candidate-changed');
  verifyMacPackage(identity.bundle, 'daily', context.config.signingIdentity);
  verifyMacPackage(context.config.installedApp, 'daily');
  const result = JSON.parse(command(process.execPath, ['scripts/install-local-macos.mjs', ...installerArgs(context, identity), '--plan-only'], { capture: true }));
  check(result.personalProfileRead === false && result.writesPerformed === false, 'unsafe-canonical-plan');
  return result;
}
async function install(context, approvedAsar) {
  const { config, stage, checkpoint } = context, identity = read(join(stage, 'package-identity.json'));
  validateCandidate(context, identity);
  const accepted = read(join(stage, 'packaged-acceptance.json'));
  check(accepted.passed && accepted.asarSHA256 === identity.asarSHA256 && accepted.isolated, 'exact-packaged-acceptance-required');
  if (approvedAsar !== undefined) {
    // The owner approved this exact build in conversation; the caller passes the hash it was shown.
    check(approvedAsar === identity.asarSHA256, 'installation-not-approved');
    console.log(`Installing owner-approved candidate ASAR ${identity.asarSHA256}.`);
  } else {
    check(process.stdin.isTTY && process.stdout.isTTY, 'owner-present-terminal-required');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { check(await prompt.question(`This will pause the listener and replace the daily app after review. Type the candidate ASAR ${identity.asarSHA256} to continue: `) === identity.asarSHA256, 'installation-not-approved'); }
    finally { prompt.close(); }
  }
  const worker = action => command(config.python, ['-B', join(here, 'update-worker.py'), action]);
  worker('pause');
  // Quit the exact configured bundle, never another app selected only by its title.
  command('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(config.installedApp)} to quit`]);
  worker('backup');
  command(config.python, ['-B', join(here, 'prepare-copy.py')]);
  node('review.cjs');
  const args = [...installerArgs(context, identity), `--compatibility-report=${join(stage, 'compatibility-reviewed.json')}`];
  if (read(join(stage, 'cron-copy-review.json')).enabledCount > 0) args.push(`--future-cron-review=${join(stage, 'cron-copy-review.json')}`);
  if (existsSync(join(stage, 'retained-automation-review.json'))) args.push(`--retained-automation-review=${join(stage, 'retained-automation-review.json')}`);
  const output = command(process.execPath, ['scripts/install-local-macos.mjs', ...args], { capture: true });
  save(join(stage, 'install-result.json'), JSON.parse(output));
  node('verify-installed.mjs');
  worker('swap');
  command(config.python, ['-B', join(here, 'prune-checkpoints.py'), checkpoint]);
  console.log(JSON.stringify({ stage, checkpoint, state: 'paused-awaiting-owner-verification', steps: planSteps.slice(-2),
    resume: `DESKPET_INSTALL_STAGE=${JSON.stringify(stage)} ${JSON.stringify(config.python)} -B ${JSON.stringify(join(here, 'update-worker.py'))} resume`,
    rollback: ['update-worker.py rollback (when applied-worker.json exists)', 'rollback-app.py'], automaticResume: false }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv); check(process.platform === 'darwin', 'macos-required');
  process.umask(0o077);
  if (args.mode === '--plan') {
    check(!args.stage, 'plan-always-creates-new-stage');
    const plan = await performPlan(args.config);
    console.log(JSON.stringify(plan, null, 2));
  } else {
    if (args.stage) process.env.DESKPET_INSTALL_STAGE = resolve(args.stage);
    check(!args.config, 'existing-stage-has-frozen-config');
    const context = configModule.context();
    if (args.mode === '--build-only') build(context); else await install(context, args.approvedAsar);
  }
}

/** Operations are injectable only by importing this module in an isolated test, never by CLI/config. */
export async function performPlan(configFile, operations = { build, validateCandidate, acceptance }) {
  const config = configModule.loadConfig(configFile);
  // Plan reads only the installed binary. It never examines the personal profile or running listener.
  const parent = lstatSync(config.stageRoot);
  check(realpathSync(config.stageRoot) === config.stageRoot && parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700, 'private-stage-root-required');
  const stage = mkdtempSync(join(config.stageRoot, 'deskpet-daily-'));
  const checkpoint = join(config.backupRoot, `install-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${basename(stage)}`);
  save(join(stage, 'install-config.json'), config); save(join(stage, 'install-context.json'), { stage, checkpoint });
  process.env.DESKPET_INSTALL_STAGE = stage;
  save(join(stage, 'baseline.json'), { asarSHA256: hash(join(config.installedApp, 'Contents/Resources/app.asar')) });
  const context = configModule.context();
  const identity = await operations.build(context), canonicalPlan = await operations.validateCandidate(context, identity);
  await operations.acceptance(context, identity);
  const plan = { stage, checkpoint, identity, canonicalPlan, steps: planSteps, installed: false, personalProfileRead: false,
    listenerContacted: false, sourcePolicyApproval: 'required-separate-review', checkedAt: new Date().toISOString() };
  save(join(stage, 'plan.json'), plan);
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
