/* global process, console */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { project, config, stage } = require('./config.cjs').context();
const { check, digest, inventory, writeJSON, maintenance, stopped } = require('./inspection-common.cjs');

async function main() {
  const identity = JSON.parse(fs.readFileSync(path.join(stage, 'package-identity.json'), 'utf8'));
  if (process.argv[2]) identity.bundle = fs.realpathSync(process.argv[2]);
  const profile = path.join(stage, 'stopped-profile');
  const data = config.profileRoot;
  const before = inventory(profile);
  const evidence = fs.mkdtempSync(path.join(stage, 'inspection-'));
  const { bootstrap, result: review } = await maintenance({
    bundle: identity.bundle, profile, runtime: path.join(evidence, 'runtime'), evidence, identity,
    inspect: require('./profile-review.cjs'), args: { profile },
  });
  review.runtimeIdentity = bootstrap.runtimeIdentity;
  const policy = await import(pathToFileURL(path.join(project, 'scripts/install-cutover-policy.mjs')).href);
  if (review.diaryEnabled && policy.reviewedDiary(identity)) {
    review.blocked = review.blocked.filter(code => code !== 'diaryEnabledNeedsSeparateReview');
    if (review.blocked.length === 0) review.status = 'passed';
  }
  console.log(JSON.stringify({ status: review.status, blocked: review.blocked, enabledSchedules: review.enabledCount,
    diaryEnabled: review.diaryEnabled, privateTextExported: false }));
  check(review.status === 'passed', 'profile-work-needs-review');
  check(review.profileSHA256 === bootstrap.files.profile.sha256 && review.sourceUnchanged, 'copy-inspection-mismatch');
  check(JSON.stringify(before) === JSON.stringify(inventory(profile)), 'copy-changed-during-inspection');
  const compatibility = { ...bootstrap, automaticPaths: { ...bootstrap.automaticPaths,
    nightlyMemoryEnabled: review.nightlyMemoryEnabled, researchQueued: review.workCounts.researchQueued,
    researchRunning: review.workCounts.researchRunning, qqInboundQueued: review.channelChecks.qqInboundQueued,
    qqInboundRunning: review.channelChecks.qqInboundRunning, qqInboundPaused: review.channelChecks.qqInboundPaused },
    supplementalInspection: { operation: review.operation, profileSHA256: review.profileSHA256, checkedAt: review.checkedAt,
      privateTextExported: false, nightlyFieldPresent: review.nightlyFieldPresent,
      nightlyDefaultFromExactArtifact: !review.nightlyFieldPresent, workCounts: review.workCounts, channelChecks: review.channelChecks } };
  const retained = { operation: 'read-only-retained-automation-review', readOnly: true, preserveExistingOnly: true,
    providerSecretValuesRead: false, instructionTextExported: false, privateTextExported: false,
    previousAppASARSHA256: identity.previousAppASARSHA256, appASARSHA256: identity.asarSHA256,
    profilePath: profile, profileSHA256: review.profileSHA256, settingsSHA256: bootstrap.files.settings.sha256,
    wrappedKeySHA256: bootstrap.files.wrappedKey.sha256, checkedAt: review.checkedAt, sourceUnchanged: true,
    nightlyMemoryEnabled: review.nightlyMemoryEnabled, runtimeIdentity: bootstrap.runtimeIdentity,
    channelChecks: review.channelChecks, workCounts: review.workCounts, ...review.retained };
  stopped(data);
  const byPath = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  const original = JSON.parse(fs.readFileSync(path.join(stage, 'source-profile-inventory.json'), 'utf8')).map(row => [row.path, row.bytes, row.sha256]);
  check(JSON.stringify(inventory(data).sort(byPath)) === JSON.stringify(original.sort(byPath)), 'live-profile-changed-after-copy');
  const files = { previousAppASARSHA256: digest(path.join(config.installedApp, 'Contents/Resources/app.asar')),
    profileSHA256: digest(path.join(data, 'profile.enc.json')), wrappedKeySHA256: digest(path.join(data, 'vault/vault-key.safe')),
    settingsSHA256: digest(path.join(data, 'settings.json')), qqStateSHA256: digest(path.join(data, 'qq-channel-state.enc.json')),
    qqWrappedKeySHA256: digest(path.join(data, 'qq-channel-vault/vault-key.safe')),
    telegramStatePresent: fs.existsSync(path.join(data, 'telegram-channel-state.enc.json')) };
  if (files.telegramStatePresent) Object.assign(files, { telegramStateSHA256: digest(path.join(data, 'telegram-channel-state.enc.json')),
    telegramWrappedKeySHA256: digest(path.join(data, 'telegram-channel-vault/vault-key.safe')) });
  if (retained.eventProactiveEnabled) policy.assertReviewedRetainedAutomation(compatibility, identity, retained, files);
  const withoutRetainedEvent = { ...compatibility, automaticPaths: { ...compatibility.automaticPaths, eventProactiveEnabled: false } };
  if (review.enabledCount > 0) policy.assertReviewedFutureCron(withoutRetainedEvent, identity, review);
  else policy.assertNoAutomaticWork(withoutRetainedEvent.automaticPaths, identity);
  writeJSON(path.join(stage, 'compatibility-reviewed.json'), compatibility);
  writeJSON(path.join(stage, 'cron-copy-review.json'), review);
  if (retained.eventProactiveEnabled) writeJSON(path.join(stage, 'retained-automation-review.json'), retained);
  console.log(JSON.stringify({ compatibility: 'passed', retainsExistingAutomation: retained.eventProactiveEnabled }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
