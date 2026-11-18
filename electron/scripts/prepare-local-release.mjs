/* global process */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMacPackage } from './verify-mac-package.mjs';

if (process.platform !== 'darwin') throw new Error('Run local macOS release preparation on macOS.');
const mode = 'validation-candidate', name = 'DeskPet Electron Candidate';
const env = { ...process.env, DESKPET_PACKAGE_MODE: mode };
const packageRoot = join(process.cwd(), 'out', name + '-darwin-' + process.arch);
const app = join(packageRoot, name + '.app');
execFileSync('npm', ['run', 'package'], {env, stdio:'inherit'});
const signature = verifyMacPackage(app, mode, !!env.DESKPET_MAC_SIGN_IDENTITY && env.DESKPET_MAC_SIGN_IDENTITY !== '-');
execFileSync(process.execPath, ['scripts/audit-package.mjs', packageRoot], {env, stdio:'inherit'});
execFileSync(process.execPath, ['scripts/smoke-minecraft-package.mjs'], {env, stdio:'inherit'});
const archiveRoot = join(process.cwd(), 'out/make/zip/darwin', process.arch);
await mkdir(archiveRoot, {recursive:true});
const release = await mkdtemp(join(archiveRoot, 'validation-candidate-'));
const zip = join(release, name + '.zip');
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], {stdio:'inherit'});
execFileSync('/usr/bin/unzip', ['-tq', zip], {stdio:'inherit'});
const digest = createHash('sha256');
for await (const chunk of createReadStream(zip)) digest.update(chunk);
await writeFile(join(release,'result.json'), JSON.stringify({mode, ...signature, zip, sha256:digest.digest('hex')}, null, 2) + '\n', {flag:'wx'});
process.stdout.write('Local release candidate: ' + release + '\n');
