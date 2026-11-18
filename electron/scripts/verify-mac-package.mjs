/* global process */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkMacIdentity(plist, signingDetails, mode, requireCertificate = false) {
  if (!['daily', 'validation-candidate'].includes(mode)) throw new Error('Unknown package mode.');
  const expected = mode === 'daily' ? 'com.deskpet.companion.electron' : 'com.deskpet.companion.electron.validation';
  const identifier = /^Identifier=(.+)$/m.exec(signingDetails)?.[1];
  if (plist.CFBundleIdentifier !== expected || plist.DeskPetArtifactMode !== mode || identifier !== expected) {
    throw new Error('Bundle, signing identifier or artifact mode does not match the requested build.');
  }
  const adhoc = /^Signature=adhoc$/m.test(signingDetails);
  if (requireCertificate && (adhoc || !/^Authority=.+$/m.test(signingDetails))) throw new Error('Certificate-backed signing was requested but is absent.');
  return { identifier, signing: adhoc ? 'ad-hoc' : 'certificate' };
}

export function assertSelectedSigner(selected, signingDetails, leafDer) {
  const firstAuthority = /^Authority=(.+)$/m.exec(signingDetails)?.[1];
  const match = /^[0-9a-f]{40}$/i.test(selected)
    ? leafDer && createHash('sha1').update(leafDer).digest('hex') === selected.toLowerCase()
    : firstAuthority === selected;
  if (!match) throw new Error('The sealed app does not have the explicitly selected leaf signing identity.');
}

export function verifyMacPackage(bundle, mode, requireCertificate = false) {
  const selected = process.env.DESKPET_MAC_SIGN_IDENTITY?.trim();
  if (!lstatSync(join(bundle, 'Contents/_CodeSignature/CodeResources')).isFile()) throw new Error('The app has no signature resource seal.');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {stdio:'pipe'});
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-',join(bundle,'Contents/Info.plist')], {encoding:'utf8'}));
  const details = spawnSync('/usr/bin/codesign', ['--display','--verbose=4',bundle], {encoding:'utf8'});
  if (details.status !== 0) throw new Error('Unable to inspect the signed app.');
  const checked = checkMacIdentity(plist, details.stderr, mode, requireCertificate || !!selected && selected !== '-');
  if (selected && selected !== '-') {
    if (/^[0-9a-f]{40}$/i.test(selected)) {
      const dir = mkdtempSync(join(tmpdir(),'deskpet-public-signature-'));
      try {
        const prefix = join(dir,'cert');
        // The prefix must be attached: a separate argument is read as another path to display.
        execFileSync('/usr/bin/codesign',['--display','--extract-certificates='+prefix,bundle],{stdio:'pipe'});
        assertSelectedSigner(selected,details.stderr,readFileSync(prefix+'0'));
      } finally { rmSync(dir,{recursive:true,force:true}); }
    } else assertSelectedSigner(selected,details.stderr);
  }
  return checked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyMacPackage(process.argv[2], process.argv[3], process.argv[4] === 'certificate');
  process.stdout.write('Verified macOS package: ' + result.identifier + ' (' + result.signing + ').\n');
}
