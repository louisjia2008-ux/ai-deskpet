/* global process */
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const receiptName = 'deskpet-upgrade-complete.json';
const managedName = /^install-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/;
const allowedEntries = new Set([receiptName, 'profile-manifest.json', 'previous-app.app', 'previous-profile']);

async function owned(path, directory) {
  const info = await lstat(path);
  return (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
    info.uid === process.getuid() && (info.mode & 0o022) === 0 ? info : null;
}

async function candidate(root, name) {
  if (!managedName.test(name)) return null;
  const path = join(root, name);
  try {
    const dir = await owned(path, true);
    if (!dir || await realpath(path) !== path) return null;
    const entries = await readdir(path);
    if (entries.length !== allowedEntries.size || entries.some(entry => !allowedEntries.has(entry))) return null;
    if (!await owned(join(path,'previous-app.app'), true) || !await owned(join(path,'previous-profile'), true) ||
      !await owned(join(path,'profile-manifest.json'), false)) return null;
    const marker = join(path,receiptName), info = await owned(marker, false);
    if (!info || info.size > 1024) return null;
    const data = JSON.parse(await readFile(marker,'utf8'));
    if (data.version !== 1 || data.kind !== 'verified-daily-upgrade' || data.name !== name ||
      !Number.isSafeInteger(data.completedAt) || data.completedAt < 0) return null;
    return {name, completedAt:data.completedAt, ino:dir.ino, dev:dir.dev};
  } catch { return null; }
}

/** Called after binary cutover, verified profile checkpoint and installed signature.
 * Custom checkpoints, migrations, old unmarked directories and incomplete upgrades do not participate. */
export async function completeManagedUpgrade(root, checkpoint) {
  const name = basename(checkpoint);
  if (root !== resolve(root) || root !== await realpath(root) || !await owned(root, true) || dirname(checkpoint) !== root ||
    !managedName.test(name) || await realpath(checkpoint) !== checkpoint || !await owned(checkpoint,true)) return {status:'not-managed', removed:0};
  await writeFile(join(checkpoint,receiptName), JSON.stringify({
    version:1, kind:'verified-daily-upgrade', name, completedAt:Date.now(),
  }) + '\n', {mode:0o600, flag:'wx'});
  if (!await candidate(root,name)) return {status:'not-managed', removed:0};
  const earlier = [];
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name === name) continue;
    const item = await candidate(root,entry.name);
    if (item) earlier.push(item);
  }
  earlier.sort((a,b) => b.completedAt - a.completedAt || b.name.localeCompare(a.name));
  let removed = 0;
  for (const item of earlier.slice(2)) {
    const current = await candidate(root,item.name);
    if (!current || current.dev !== item.dev || current.ino !== item.ino || await realpath(root) !== root) continue;
    const retired = join(root, '.retiring-' + randomUUID());
    await rename(join(root,item.name),retired);
    const moved = await lstat(retired);
    if (!moved.isDirectory() || moved.dev !== current.dev || moved.ino !== current.ino) throw new Error('Backup changed during retention.');
    await rm(retired, {recursive:true}); removed++;
  }
  return {status:'complete', removed};
}
