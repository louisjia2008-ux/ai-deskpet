import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { completeManagedUpgrade } from './upgrade-retention.mjs';

test('rotates three marked successful upgrades, preserving incomplete, custom, modified and symlinked checkpoints', async t => {
  const temp = await mkdtemp(join(tmpdir(),'deskpet-retention-test-'));
  t.after(() => rm(temp,{recursive:true,force:true}));
  const root = await realpath(temp);
  const layout = async (day, mark) => {
    const path = join(root, 'install-2026-11-' + day + 'T00-00-00.000Z-' + randomUUID());
    await mkdir(path,{mode:0o700});
    await mkdir(join(path,'previous-app.app'),{mode:0o700});
    await mkdir(join(path,'previous-profile'),{mode:0o700});
    await writeFile(join(path,'profile-manifest.json'),'{}',{mode:0o600});
    if (mark) await completeManagedUpgrade(root,path);
    return path;
  };
  const preserved = await layout('01',true);
  await writeFile(join(preserved,'user-note'),'keep');
  const incomplete = await layout('02',false);
  const custom = join(root,'custom-checkpoint'); await mkdir(custom);
  const link = join(root,'install-2026-11-03T00-00-00.000Z-' + randomUUID()); await symlink(custom,link);
  const old = await layout('04',true);
  const first = await layout('05',true), second = await layout('06',true), third = await layout('07',true);
  await assert.rejects(readdir(old), {code:'ENOENT'});
  for (const directory of [first,second,third,preserved,incomplete,custom,link]) await readdir(directory);
  assert.equal(await readFile(join(preserved,'user-note'),'utf8'),'keep');
  assert.equal((await completeManagedUpgrade(root,link)).status,'not-managed');
});
