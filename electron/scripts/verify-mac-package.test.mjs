import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { assertSelectedSigner, checkMacIdentity } from './verify-mac-package.mjs';

test('rejects a valid Electron shell signature that does not belong to the daily bundle', () => {
  const plist = { CFBundleIdentifier:'com.deskpet.companion.electron', DeskPetArtifactMode:'daily' };
  assert.throws(() => checkMacIdentity(plist,'Identifier=Electron\nSignature=adhoc','daily'));
  const adhoc = 'Identifier=com.deskpet.companion.electron\nSignature=adhoc';
  assert.equal(checkMacIdentity(plist,adhoc,'daily').signing,'ad-hoc');
  assert.throws(() => checkMacIdentity(plist,adhoc,'daily',true));
  assert.throws(() => checkMacIdentity(plist,adhoc,'validation-candidate'));
  assert.equal(checkMacIdentity(plist,'Identifier=com.deskpet.companion.electron\nAuthority=Fixture','daily',true).signing,'certificate');
});

test('requires the chosen leaf name or exact certificate fingerprint even with a valid chain', () => {
  const chain = 'Authority=Fixture Leaf\nAuthority=Fixture CA';
  assert.doesNotThrow(() => assertSelectedSigner('Fixture Leaf',chain));
  assert.throws(() => assertSelectedSigner('Fixture CA',chain));
  const bytes = Buffer.from('fixture public certificate');
  const fingerprint = createHash('sha1').update(bytes).digest('hex').toUpperCase();
  assert.doesNotThrow(() => assertSelectedSigner(fingerprint,chain,bytes));
  assert.throws(() => assertSelectedSigner(fingerprint,chain,new Uint8Array()));
});
