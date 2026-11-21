/* global process */
import { createHash, randomUUID } from 'node:crypto';
import { completeManagedUpgrade } from './upgrade-retention.mjs';
import { verifyMacPackage } from './verify-mac-package.mjs';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { assertNoAutomaticWork, assertReviewedFutureCron, assertReviewedRetainedAutomation, assertStoppedEntries } from './install-cutover-policy.mjs';

if (process.platform !== 'darwin') throw new Error('This installer is for local macOS use.');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const matches = process.argv.slice(2).filter((value) => value === name || value.startsWith(`${name}=`));
  if (!matches.length) return undefined;
  if (matches.length !== 1 || !matches[0].startsWith(`${name}=`) || matches[0].length === name.length + 1) throw new Error('Conflicting installer arguments.');
  return matches[0].slice(name.length + 1);
};
const appArgument = option('--app');
const expectedASAR = option('--expected-asar');
const checkpointArgument = option('--checkpoint');
const compatibilityArgument = option('--compatibility-report');
const futureCronArgument = option('--future-cron-review');
const retainedAutomationArgument = option('--retained-automation-review');
const planOnly = process.argv.includes('--plan-only');
if (futureCronArgument !== undefined && (!isAbsolute(futureCronArgument) || appArgument === undefined
  || compatibilityArgument === undefined || !isAbsolute(compatibilityArgument))) throw new Error('--future-cron-review requires absolute review/compatibility paths and an explicit --app.');
if (retainedAutomationArgument !== undefined && (!isAbsolute(retainedAutomationArgument) || appArgument === undefined
  || compatibilityArgument === undefined || !isAbsolute(compatibilityArgument))) throw new Error('--retained-automation-review requires absolute review/compatibility paths and an explicit --app.');
if (appArgument !== undefined && (!isAbsolute(appArgument) || !/^[a-f0-9]{64}$/.test(expectedASAR ?? ''))) throw new Error('An explicit candidate App requires an absolute path and --expected-asar SHA-256.');
if (checkpointArgument !== undefined && !isAbsolute(checkpointArgument)) throw new Error('The checkpoint must be absolute.');
const built = appArgument ?? join(project, 'out', `DeskPet Electron-darwin-${process.arch}`, 'DeskPet Electron.app');
const installed = option('--installed-app') ?? join(homedir(), 'Applications', 'DeskPet Electron.app');
const applications = dirname(installed);
const data = option('--data-root') ?? join(homedir(), 'Library/Application Support/DeskPet Electron');
const backupRoot = option('--backup-root') ?? join(homedir(), 'Library/Application Support/DeskPet Backups');
if (![installed, data, backupRoot].every(value => isAbsolute(value) && resolve(value) === value) || basename(installed) !== 'DeskPet Electron.app') throw new Error('Installation roots must be absolute canonical paths.');
const checkpoint = checkpointArgument ?? join(backupRoot, `install-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
const source = option('--source-profile');
if (appArgument !== undefined && source !== undefined) throw new Error('Reviewed daily cutover is binary-only; --source-profile migration is a separate operation.');
const migrationRoots = ['profile.enc.json', 'settings.json', 'managed', 'vault', 'events', 'workspace', 'migration'];
// Rollback on this machine also needs the local channel bindings, outboxes,
// knowledge index and capability vaults. These grants are not portable.
// The retired Minecraft profile subtree is retained in rollback checkpoints
// for earlier binaries. The current app uses the independent Core subtree.
const roots = source === undefined ? [
  ...migrationRoots, 'qq-channel-state.enc.json', 'qq-channel-vault',
  'telegram-channel-state.enc.json', 'telegram-channel-vault', 'knowledge', 'knowledge-vault', 'stdio-bridge-vault', 'mcp-auth-vault',
  'persona.enc.json', 'character.enc.json', 'diary.enc.json', 'voice-settings.json', 'speech-input.json', 'minecraft', 'minecraft-companion', 'rea-analysis', 'playwright-mcp',
] : migrationRoots;
const exists = async (path) => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
if (!(await exists(join(built, 'Contents/Resources/app.asar')))) throw new Error('Build the arm64 app with Electron Forge first.');
const asarPath = join(built, 'Contents/Resources/app.asar');
const asarSHA256 = createHash('sha256').update(await readFile(asarPath)).digest('hex');
if (expectedASAR !== undefined && expectedASAR !== asarSHA256) throw new Error('The explicitly reviewed App ASAR hash changed.');
const packageMetadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
if (packageMetadata.deskpetBuild?.version !== 1 || packageMetadata.deskpetBuild.mode !== 'daily') throw new Error('Only an explicitly identified daily-mode package may replace the daily App.');
const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(built, 'Contents/Info.plist')], { encoding: 'utf8' }));
if (plist.CFBundleIdentifier !== 'com.deskpet.companion.electron' || plist.DeskPetArtifactMode !== 'daily') throw new Error('The daily App bundle identity does not match.');
verifyMacPackage(built, 'daily');
if (planOnly) {
  // Exit before even checking personal profile paths or creating a checkpoint.
  process.stdout.write(`${JSON.stringify({ planOnly: true, app: built, asarSHA256, mode: 'daily', installed, data, checkpoint,
    previousApp: join(checkpoint, 'previous-app.app'), previousProfile: join(checkpoint, 'previous-profile'), roots,
    personalProfileRead: false, writesPerformed: false, compatibilityReportRequired: appArgument !== undefined,
    futureCronReviewRequested: futureCronArgument ?? null, futureCronReviewValidated: false,
    retainedAutomationReviewRequested: retainedAutomationArgument ?? null, retainedAutomationReviewValidated: false,
    condition: 'Explicit authorization, stopped writers, no pending recovery, verified backup and compatible personal-data copy required before installation.' }, null, 2)}\n`);
  process.exit(0);
}
if (source !== undefined && (!isAbsolute(source) || resolve(source) === data)) throw new Error('Choose an absolute, distinct source profile.');
if (resolve(checkpoint) === resolve(data) || resolve(data).startsWith(`${resolve(checkpoint)}/`) || resolve(checkpoint).startsWith(`${resolve(data)}/`)) throw new Error('The checkpoint must be separate from the profile.');
const canonicalDestination = async (path) => {
  const tail = [];
  let ancestor = resolve(path);
  while (!(await exists(ancestor))) { tail.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return join(await realpath(ancestor), ...tail);
};
const checkpointCanonical = await canonicalDestination(checkpoint);
for (const path of [built, installed, data, ...(source === undefined ? [] : [source])]) {
  const other = await canonicalDestination(path);
  if (checkpointCanonical === other || checkpointCanonical.startsWith(`${other}/`) || other.startsWith(`${checkpointCanonical}/`)) throw new Error('The checkpoint overlaps an application or profile; no changes performed.');
}
if (await exists(checkpoint)) throw new Error('The exact checkpoint already exists; do not overwrite a previous backup.');
const assertStopped = async (directory) => {
  if (!(await exists(directory))) return;
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Profile must be an unlinked directory.');
  assertStoppedEntries(await readdir(directory));
};
await assertStopped(data);
if (source !== undefined) await assertStopped(source);
if (source !== undefined && !(await exists(join(source, 'profile.enc.json')))) throw new Error('The source profile has no encrypted chat database.');
let automaticDecision = null;
let recheckFutureCron = null;
if (appArgument !== undefined) {
  if (compatibilityArgument === undefined || !isAbsolute(compatibilityArgument)) throw new Error('An explicit reviewed App requires --compatibility-report from its daily-identity read-only copy check.');
  const compatibility = JSON.parse(await readFile(compatibilityArgument, 'utf8'));
  if (compatibility.verdict !== 'PASS' || compatibility.operation !== 'read-only-profile-inspection' || compatibility.readOnly !== true
    || compatibility.artifactMode !== 'daily' || compatibility.runtimeName !== 'DeskPet Electron' || compatibility.appASARSHA256 !== asarSHA256
    || compatibility.compatibleWithCurrentSchema !== true || compatibility.sourceUnchangedDuringRead !== true
    || compatibility.projectionOnly?.pendingRestorePresent !== false || compatibility.projectionOnly?.noProjectionCommitted !== true
    || compatibility.providerSecretValuesRead !== false || resolve(compatibility.profilePath ?? data) === resolve(data)) throw new Error('The copy compatibility report does not authorize this exact daily artifact and stopped copy.');
  const runtime = {
    sourceSHA256: compatibility.runtimeIdentity?.build?.sourceSHA256,
    mainSHA256: createHash('sha256').update(extractFile(asarPath, '.webpack/main/index.js')).digest('hex'),
    asarSHA256,
  };
  // Load a review once. The final check reuses these exact reviewed bytes.
  const futureCronReview = futureCronArgument === undefined ? null : JSON.parse(await readFile(futureCronArgument, 'utf8'));
  const retainedReview = retainedAutomationArgument === undefined ? null : JSON.parse(await readFile(retainedAutomationArgument, 'utf8'));
  const automaticReview = async () => {
    let retained = null;
    if (retainedReview !== null) {
      const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
      const telegramPath = join(data, 'telegram-channel-state.enc.json');
      const telegramStatePresent = await exists(telegramPath);
      retained = assertReviewedRetainedAutomation(compatibility, runtime, retainedReview, {
        previousAppASARSHA256: await hash(join(installed, 'Contents/Resources/app.asar')),
        profileSHA256: await hash(join(data, 'profile.enc.json')), wrappedKeySHA256: await hash(join(data, 'vault/vault-key.safe')),
        settingsSHA256: await hash(join(data, 'settings.json')), qqStateSHA256: await hash(join(data, 'qq-channel-state.enc.json')),
        qqWrappedKeySHA256: await hash(join(data, 'qq-channel-vault/vault-key.safe')),
        telegramStatePresent,
        ...(telegramStatePresent && retainedReview.channelChecks?.telegramStatePresent === true ? {
          telegramStateSHA256: await hash(telegramPath),
          telegramWrappedKeySHA256: await hash(join(data, 'telegram-channel-vault/vault-key.safe')),
        } : {}),
      });
    }
    // Only a verified unchanged policy is removed from the gate's copy. Keep
    // the original inspection report and every pending-work counter intact.
    const reviewed = retained ? { ...compatibility, automaticPaths: { ...compatibility.automaticPaths, eventProactiveEnabled: false } } : compatibility;
    const decision = futureCronArgument === undefined ? assertNoAutomaticWork(reviewed.automaticPaths, runtime)
      : assertReviewedFutureCron(reviewed, runtime, futureCronReview);
    return retained ? { ...decision, retainedEventProactiveEnabled: true, retainedAutomation: retained } : decision;
  };
  automaticDecision = await automaticReview();
  const currentHash = createHash('sha256').update(await readFile(join(data, 'profile.enc.json'))).digest('hex');
  if (compatibility.files?.profile?.sha256 !== currentHash) throw new Error('The stopped personal profile differs from the reviewed copy; no installation performed.');
  const wrappedKeyHash = createHash('sha256').update(await readFile(join(data, 'vault/vault-key.safe'))).digest('hex');
  const currentSettingsHash = await exists(join(data, 'settings.json')) ? createHash('sha256').update(await readFile(join(data, 'settings.json'))).digest('hex') : null;
  if (compatibility.files?.wrappedKey?.sha256 !== wrappedKeyHash || compatibility.files?.settings?.sha256 !== currentSettingsHash) throw new Error('The stopped vault or settings differs from the reviewed copy; no installation performed.');
  if (futureCronArgument !== undefined || retainedAutomationArgument !== undefined) recheckFutureCron = async (stagedApp) => {
    const stagedASAR = join(stagedApp, 'Contents/Resources/app.asar');
    if (createHash('sha256').update(await readFile(stagedASAR)).digest('hex') !== asarSHA256
      || createHash('sha256').update(extractFile(stagedASAR, '.webpack/main/index.js')).digest('hex') !== runtime.mainSHA256)
      throw new Error('The staged artifact differs from the future-cron review; no installation performed.');
    const profileHash = createHash('sha256').update(await readFile(join(data, 'profile.enc.json'))).digest('hex');
    const keyHash = createHash('sha256').update(await readFile(join(data, 'vault/vault-key.safe'))).digest('hex');
    const settingsHash = await exists(join(data, 'settings.json')) ? createHash('sha256').update(await readFile(join(data, 'settings.json'))).digest('hex') : null;
    if (profileHash !== compatibility.files?.profile?.sha256 || (futureCronReview !== null && profileHash !== futureCronReview.profileSHA256)
      || keyHash !== compatibility.files?.wrappedKey?.sha256 || settingsHash !== compatibility.files?.settings?.sha256)
      throw new Error('The stopped profile changed after the future-cron review; no installation performed.');
    return automaticReview();
  };
}

const inventory = async (root) => {
  const files = [];
  const walk = async (relative) => {
    const path = join(root, relative); if (!(await exists(path))) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Linked files cannot be migrated.');
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name === '.staging') throw new Error('Unresolved profile staging cannot be omitted from an upgrade checkpoint.');
        await walk(`${relative}/${name}`);
      }
    } else if (info.isFile()) files.push({ path: relative, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    else throw new Error('Unsupported profile entry.');
  };
  for (const name of roots) await walk(name);
  return files;
};

await mkdir(checkpoint, { recursive: true, mode: 0o700 });
await mkdir(applications, { recursive: true, mode: 0o700 });
const stage = join(applications, `.DeskPet Electron.install-${randomUUID()}.app`);
const oldApp = join(checkpoint, 'previous-app.app');
let verifiedCurrentInventory = null;
const verifyBundle = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const local = relative(stage, resolve(dirname(path), target));
      if (isAbsolute(target) || local === '..' || local.startsWith('../')) throw new Error('Installed bundle contains an external framework link.');
    } else if (entry.isDirectory()) await verifyBundle(path);
  }
};
try {
  await cp(built, stage, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  await verifyBundle(stage);
  verifyMacPackage(stage, 'daily');
  if (source !== undefined) {
    const before = await inventory(source);
    const stagedData = join(dirname(data), `.DeskPet Electron.install-${randomUUID()}`);
    await mkdir(stagedData, { mode: 0o700 });
    try {
      for (const name of roots) {
        const path = join(source, name);
        if (await exists(path)) await cp(path, join(stagedData, name), { recursive: true, force: false, errorOnExist: true });
      }
      const after = await inventory(stagedData);
      await assertStopped(source); await assertStopped(data);
      if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(await inventory(source))) throw new Error('Profile changed during migration; no cutover performed.');
      await cp(stagedData, join(checkpoint, 'source-profile'), { recursive: true, force: false, errorOnExist: true });
      await writeFile(join(checkpoint, 'migration-manifest.json'), JSON.stringify({ source, data, files: before }, null, 2), { mode: 0o600 });
      if (await exists(data)) await rename(data, join(checkpoint, 'previous-profile'));
      try { await rename(stagedData, data); }
      catch (error) { if (await exists(join(checkpoint, 'previous-profile'))) await rename(join(checkpoint, 'previous-profile'), data); throw error; }
    } finally { await rm(stagedData, { recursive: true, force: true }); }
  } else if (await exists(join(data, 'profile.enc.json'))) {
    // Keep a fresh, verified recovery point on every local upgrade, not only
    // the initial migration. All credentials remain platform-encrypted.
    const before = await inventory(data);
    const snapshot = join(checkpoint, 'previous-profile');
    await mkdir(snapshot, { mode: 0o700 });
    for (const name of roots) {
      const path = join(data, name);
      if (await exists(path)) await cp(path, join(snapshot, name), { recursive: true, force: false, errorOnExist: true });
    }
    await assertStopped(data);
    if (JSON.stringify(before) !== JSON.stringify(await inventory(snapshot)) || JSON.stringify(before) !== JSON.stringify(await inventory(data))) throw new Error('Profile changed during the recovery checkpoint; app update cancelled.');
    verifiedCurrentInventory = before;
    await writeFile(join(checkpoint, 'profile-manifest.json'), JSON.stringify({ data, files: before }, null, 2), { mode: 0o600 });
  }
  await assertStopped(data);
  if (verifiedCurrentInventory && JSON.stringify(verifiedCurrentInventory) !== JSON.stringify(await inventory(data))) throw new Error('Profile changed before binary replacement; app update cancelled.');
  if (recheckFutureCron) automaticDecision = await recheckFutureCron(stage);
  if (await exists(installed)) await rename(installed, oldApp);
  try { await rename(stage, installed); }
  catch (error) { if (await exists(oldApp)) await rename(oldApp, installed); throw error; }
  let retention = {status:'not-managed', removed:0};
  if (checkpointArgument === undefined && source === undefined && verifiedCurrentInventory && await exists(oldApp)) {
    try {
      verifyMacPackage(installed, 'daily');
      retention = await completeManagedUpgrade(backupRoot, checkpoint);
    } catch { retention = {status:'review-required', removed:null}; }
  }
  process.stdout.write(`${JSON.stringify({ installed, data, checkpoint, retention, migrated: source !== undefined, automaticDecision })}\n`);
} finally { await rm(stage, { recursive: true, force: true }); }
