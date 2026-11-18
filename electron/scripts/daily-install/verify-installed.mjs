/* global console */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyMacPackage } from '../verify-mac-package.mjs';
import configModule from './config.cjs';
import inspection from './inspection-common.cjs';

const { stage: root, config, checkpoint } = configModule.context();
const result = JSON.parse(await readFile(join(root, 'install-result.json'), 'utf8'));
const identity = JSON.parse(await readFile(join(root, 'package-identity.json'), 'utf8'));
const installed = config.installedApp;
const data = config.profileRoot;
const byPath = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
assert.deepEqual(inspection.inventory(data).sort(byPath), JSON.parse(await readFile(join(root, 'source-profile-inventory.json'), 'utf8')).map(entry => [entry.path, entry.bytes, entry.sha256]).sort(byPath));
assert.equal(result.checkpoint, checkpoint);
assert.equal(result.installed, installed);
assert.equal(result.data, data);
assert.equal(result.migrated, false);
if (result.automaticDecision.retainedAutomation) assert.equal(result.automaticDecision.retainedAutomation.noNewPermissionsGranted, true);
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const installedSHA = await hash(join(installed, 'Contents/Resources/app.asar'));
const previousSHA = await hash(join(checkpoint, 'previous-app.app/Contents/Resources/app.asar'));
assert.equal(installedSHA, identity.asarSHA256);
assert.equal(previousSHA, identity.previousAppASARSHA256);
const installedSignature = verifyMacPackage(installed, 'daily');
const previousSignature = verifyMacPackage(join(checkpoint, 'previous-app.app'), 'daily');
const installedRuntime = join(installed, 'Contents/Resources/wechat-runtime');
assert.deepEqual((await readdir(installedRuntime)).sort(), Object.keys(identity.wechatRuntime).sort());
for (const [name, sha] of Object.entries(identity.wechatRuntime)) {
  const resource = join(installedRuntime, name);
  assert((await lstat(resource)).isFile());
  assert.equal(await hash(resource), sha);
}
const processes = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n');
const fromBundle = processes.filter(command => command.startsWith(installed + '/Contents/'));
const temporaryRunner = fromBundle.filter(command => command.startsWith(installed + '/Contents/MacOS/deskpet-electron ')
  && /--deskpet-isolated-profile=\/private\/var\/folders\/[^\n]+\/T\/deskpet-wechat-replies-[a-zA-Z0-9]+\b/u.test(command)
  && command.includes('--use-mock-keychain'));
assert(fromBundle.every(command => temporaryRunner.includes(command)
  || (command.startsWith(installed + '/Contents/Frameworks/') && temporaryRunner.length === 1
    && /--user-data-dir=\/private\/var\/folders\/[^\n]+\/T\/deskpet-wechat-replies-[a-zA-Z0-9]+\/profile\b/u.test(command))));
const manifest = JSON.parse(await readFile(join(checkpoint, 'profile-manifest.json'), 'utf8'));
assert.equal(manifest.data, data);
const snapshot = join(checkpoint, 'previous-profile');
const files = [];
async function walk(relative = '') {
  const current = join(snapshot, relative), info = await lstat(current);
  assert(!info.isSymbolicLink());
  if (info.isDirectory()) {
    for (const name of (await readdir(current)).sort()) await walk(join(relative, name));
  } else {
    assert(info.isFile());
    files.push(relative);
  }
}
await walk();
assert.deepEqual(files.sort(), manifest.files.map(entry => entry.path).sort());
for (const entry of manifest.files) {
  assert(!isAbsolute(entry.path) && resolve(snapshot, entry.path).startsWith(snapshot + '/'));
  assert.equal(await hash(join(snapshot, entry.path)), entry.sha256);
  assert.equal(await hash(join(data, entry.path)), entry.sha256);
}
const evidence = join(checkpoint, 'installation-evidence');
await mkdir(evidence, { mode: 0o700 });
const reports = ['compatibility-reviewed.json', 'cron-copy-review.json', 'source-profile-inventory.json', 'stopped-copy.json'];
if (result.automaticDecision.retainedAutomation) reports.push('retained-automation-review.json');
for (const name of reports) await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 });
for (const name of ['install-result.json', 'package-identity.json']) {
  await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 });
}
const verification = { status: 'passed', installed, checkpoint, installedSHA, previousSHA,
  installedSignature, previousSignature, profileBackupFilesVerified: manifest.files.length,
  wechatRuntimeResourcesVerified: Object.keys(identity.wechatRuntime).length,
  liveProfileUnchangedByInstallation: true, binaryOnly: true, privateTextExported: false,
  checkedAt: new Date().toISOString() };
await writeFile(join(evidence, 'post-install-verification.json'), JSON.stringify(verification, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(verification));
