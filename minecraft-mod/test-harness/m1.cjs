'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { record, until, Vec3, serverSettings, createRcon, newBot, ready, closeBot } = require('./common.cjs');
const { BUTTON, P, Y, equip, setupArena, snapshot, blockClick, airClick, openMenu, click,
  describeSlot, observeDisplays, stageSelection } = require('./wand-session.cjs');

async function requireChanged(bot, slot, label) {
  const { before, after } = await click(bot, slot);
  assert.ok(after, `No ${label} button after click`);
  assert.notDeepEqual(after, before, `Expected ${label} button to change`);
}

async function main() {
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, 'Owner');
  const observer = newBot(settings, 'DeskPetBot');
  const preview = observeDisplays(owner.bot);
  const nonOwnerPreview = observeDisplays(observer.bot);
  const evidenceId = `m1_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  try {
    await Promise.all([ready(owner), ready(observer)]);
    await setupArena(rcon, [owner.bot, observer.bot]);
    const initialHash = await snapshot(rcon, `${evidenceId}_before`);
    await equip(rcon, owner.bot);
    await blockClick(rcon, owner.bot, P.first);
    await blockClick(rcon, owner.bot, P.second);
    await airClick(owner.bot, true);
    await airClick(owner.bot);
    assert.equal(owner.bot.currentWindow, null, 'Removing the last corner must prevent opening the menu');
    await blockClick(rcon, owner.bot, P.second);
    await blockClick(rcon, owner.bot, P.chest, { sneaking: true });

    await openMenu(owner.bot);
    await until(() => preview.active.size > 0, 'Owner-only virtual block displays');
    assert.deepEqual(nonOwnerPreview.spawns, []);
    // Template, rotation, position, height, mode and layers are changed through the real GUI.
    await requireChanged(owner.bot, BUTTON.template, 'template');
    await requireChanged(owner.bot, BUTTON.rotation, 'rotation');
    await click(owner.bot, BUTTON.east);
    await click(owner.bot, BUTTON.groundDown);
    await click(owner.bot, BUTTON.groundUp);
    await requireChanged(owner.bot, BUTTON.mode, 'grading mode');
    await requireChanged(owner.bot, BUTTON.buildLayer, 'building preview layer');
    await requireChanged(owner.bot, BUTTON.buildLayer, 'building preview layer');
    await click(owner.bot, BUTTON.cancel);
    await until(() => !owner.bot.currentWindow && preview.active.size === 0, 'all preview removals after cancellation');
    const changed = await snapshot(rcon, `${evidenceId}_after`);
    assert.equal(changed, initialHash, 'Server block snapshot changed during preview/cancel');
    await delay(200);
    assert.deepEqual(nonOwnerPreview.spawns, [], 'DeskPetBot intercepted virtual display spawn packets');

    // The site is intentionally narrower than every supported template.
    await airClick(owner.bot, true);
    await airClick(owner.bot, true);
    await stageSelection(rcon, owner.bot, { second: new Vec3(2, Y - 1, 2) });
    const narrow = await openMenu(owner.bot);
    const confirm = describeSlot(narrow.slots[BUTTON.confirm]);
    assert.ok(confirm && ['barrier', 'red_concrete', 'red_stained_glass_pane', 'gray_dye'].includes(confirm.name),
      `Confirm remained enabled for undersized site: ${JSON.stringify(confirm)}`);
    record('undersized-conflict-confirm-disabled', { confirm });
    await click(owner.bot, BUTTON.cancel);
    await until(() => !owner.bot.currentWindow && preview.active.size === 0, 'undersized preview cleanup');
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(observer.errors, []);
    assert.equal(await snapshot(rcon, `${evidenceId}_narrow`), initialHash);
    record('m1-pass', { initialHash, ownerDisplaySpawns: preview.spawns.length,
      ownerDisplayRemovals: preview.removals.length, observerDisplaySpawns: nonOwnerPreview.spawns.length });
  } finally {
    closeBot(owner);
    closeBot(observer);
    rcon.close();
  }
}

main().catch((error) => {
  record('m1-failed', { error: error.stack });
  process.exitCode = 1;
});
