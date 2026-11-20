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
  const normalRules = process.env.DESKPET_TEST_NORMAL_RULES === '1';
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
    if (normalRules) {
      await rcon.command('gamerule randomTickSpeed 3');
      await rcon.command('gamerule doMobSpawning true');
      await rcon.command('gamerule doFireTick true');
      await rcon.command('gamerule mobGriefing true');
      await rcon.command('gamerule doDaylightCycle true');
    }
    const initialHash = await snapshot(rcon, `${evidenceId}_before`);
    await equip(rcon, owner.bot);
    await blockClick(rcon, owner.bot, P.first);
    await blockClick(rcon, owner.bot, P.second);
    await airClick(owner.bot, true);
    await airClick(owner.bot);
    assert.equal(owner.bot.currentWindow, null, 'Removing the last corner must prevent opening the menu');
    await blockClick(rcon, owner.bot, P.second);
    await blockClick(rcon, owner.bot, P.chest, { sneaking: true });

    const menu = await openMenu(owner.bot);
    const initialConfirm = describeSlot(menu.slots[BUTTON.confirm]);
    assert.equal(initialConfirm.name, 'barrier');
    assert.match(JSON.stringify(initialConfirm.label), /确认开工尚未启用/);
    assert.match(JSON.stringify(describeSlot(menu.slots[4]).lore), /材料箱/);
    await until(() => preview.active.size > 0 && preview.spawns.length > 0, 'Owner-only virtual block displays');
    assert.ok(preview.labelSpawns.length > 0, 'Owner receives a virtual entrance direction label');
    assert.ok(preview.active.size <= 385, 'Preview displays must stay inside the configured rendering cap');
    assert.deepEqual(nonOwnerPreview.spawns, []);
    assert.deepEqual(nonOwnerPreview.labelSpawns, []);
    // Template, rotation, position, height, mode and layers are changed through the real GUI.
    await requireChanged(owner.bot, BUTTON.template, 'template');
    await requireChanged(owner.bot, BUTTON.rotation, 'rotation');
    const siteSummary = () => describeSlot(owner.bot.currentWindow?.slots[4]);
    const centered = siteSummary();
    await click(owner.bot, BUTTON.east);
    const moved = siteSummary();
    assert.notDeepEqual(moved, centered, 'East control should move the entrance and template in bounds');
    await click(owner.bot, BUTTON.groundDown);
    assert.notDeepEqual(siteSummary(), moved, 'Ground grade changed');
    await click(owner.bot, BUTTON.groundUp);
    assert.deepEqual(siteSummary(), moved, 'Push both ground controls to restore the original grade');
    await requireChanged(owner.bot, BUTTON.mode, 'grading mode');
    await requireChanged(owner.bot, BUTTON.buildLayer, 'building preview layer');
    await requireChanged(owner.bot, BUTTON.buildLayer, 'building preview layer');
    await click(owner.bot, BUTTON.cancel);
    await until(() => !owner.bot.currentWindow && preview.active.size === 0, 'all preview removals after cancellation');
    const changed = await snapshot(rcon, `${evidenceId}_after`);
    assert.equal(changed, initialHash, 'Server block snapshot changed during preview/cancel');
    await delay(200);
    assert.deepEqual(nonOwnerPreview.spawns, [], 'DeskPetBot received virtual block display spawn packets');
    assert.deepEqual(nonOwnerPreview.labelSpawns, [], 'DeskPetBot received virtual entrance labels');

    // The site is intentionally narrower than every supported template.
    await airClick(owner.bot, true);
    await airClick(owner.bot, true);
    await stageSelection(rcon, owner.bot, { second: new Vec3(2, Y - 1, 2) });
    const narrow = await openMenu(owner.bot);
    const confirm = describeSlot(narrow.slots[BUTTON.confirm]);
    assert.ok(confirm && ['barrier', 'red_concrete', 'red_stained_glass_pane', 'gray_dye'].includes(confirm.name),
      `Confirm remained enabled for undersized site: ${JSON.stringify(confirm)}`);
    assert.match(JSON.stringify(confirm.label), /有冲突，不能开工/);
    assert.match(JSON.stringify(confirm.lore), /选区放不下这个房型/);
    record('undersized-conflict-confirm-disabled', { confirm });
    await click(owner.bot, BUTTON.cancel);
    await until(() => !owner.bot.currentWindow && preview.active.size === 0, 'undersized preview cleanup');
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(observer.errors, []);
    assert.equal(await snapshot(rcon, `${evidenceId}_narrow`), initialHash);
    assert.equal(preview.removals.length, preview.spawns.length + preview.labelSpawns.length);
    record('m1-pass', { rules: normalRules ? 'normal' : 'stable', initialHash, ownerDisplaySpawns: preview.spawns.length,
      ownerLabelSpawns: preview.labelSpawns.length, ownerDisplayRemovals: preview.removals.length,
      observerDisplaySpawns: nonOwnerPreview.spawns.length + nonOwnerPreview.labelSpawns.length });
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
