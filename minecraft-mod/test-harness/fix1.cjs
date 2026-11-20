'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, Vec3, record, until, serverSettings } = require('./common.cjs');
const { BUTTON, Y, coords, move, equip, snapshot, blockClick, airClick, openMenu, click, readPlans,
  assertBlock } = require('./wand-session.cjs');
const { ORIGIN, INSIDE, OUTSIDE, start, plan, waitPlan, prepareSmall, previewFixture, confirmFixture,
  accepted, manage, dig, fill } = require('./fix1-session.cjs');

const ID = `fix1_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const FIRST = ORIGIN;
const SECOND = ORIGIN.offset(1, 0, 0);

async function readPlanBytes(file) {
  const nbt = runtimeRequire('prismarine-nbt');
  const parsed = nbt.simplify((await nbt.parse(await fs.readFile(file))).parsed);
  return Buffer.from(parsed.data.plans).toString('utf8');
}

async function readSave(rcon, name) {
  assert.match(await rcon.command('save-all flush'), /Saved the game/);
  const { worldDir } = await serverSettings();
  const file = path.join(worldDir, 'deskpet-debug', `${ID}_${name}.dat`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(path.join(worldDir, 'data/deskpet_survey_plans.dat'), file);
  return { file, state: JSON.parse(await readPlanBytes(file)) };
}

async function confirmationScope(env) {
  const { rcon, owner, robot, holdAccepts, releaseAccept } = env;
  await prepareSmall(rcon);
  holdAccepts();
  const id = await previewFixture(rcon);
  await confirmFixture(rcon, id);
  const confirmed = await waitPlan(rcon, id, 'confirmed');
  await dig(rcon, robot, OUTSIDE);
  await assertBlock(rcon, OUTSIDE, 'minecraft:air');
  await dig(rcon, robot, INSIDE);
  await assertBlock(rcon, INSIDE, 'minecraft:grass_block');
  await rcon.command(`setblock ${coords(SECOND)} oak_planks`);
  await until(() => env.events.some((event) => event.type === 'accepted' && event.planId === id),
    'production Core produced a pending acceptance');
  releaseAccept(confirmed.grantId);
  const paused = await waitPlan(rcon, id, 'paused');
  assert.match(paused.reason, /protected_block_changed/);
  assert.equal(paused.lateAttempts, 1);
  assert.equal(paused.siteChanges, 1);
  assert.equal(paused.violations, 0);
  await manage(rcon, owner, BUTTON.cancel);
  await waitPlan(rcon, id, 'cancelled');
  record('fix1-f1-confirmed-and-f3-accept-recheck', { id, reason: paused.reason,
    outside: 'air', inside: 'grass_block', siteChanges: paused.siteChanges, lateAttempts: paused.lateAttempts });
}

async function revocationScope(env) {
  const { rcon, owner, robot, holdAcks, releaseAck } = env;
  holdAcks();
  for (const release of ['ack', 'deadline']) {
    await prepareSmall(rcon);
    const id = await previewFixture(rcon);
    await confirmFixture(rcon, id);
    const { grantId } = await accepted(env, id);
    const startTime = performance.now();
    await manage(rcon, owner, BUTTON.cancel);
    await waitPlan(rcon, id, 'cancelled');
    await dig(rcon, robot, OUTSIDE);
    await assertBlock(rcon, OUTSIDE, 'minecraft:air');
    await dig(rcon, robot, INSIDE);
    await assertBlock(rcon, INSIDE, 'minecraft:grass_block');
    const denied = await plan(rcon, id);
    assert.equal(denied.violations, 0);
    assert.equal(denied.siteChanges, 0);
    assert.equal(denied.lateAttempts, 1);
    const { file, state } = await readSave(rcon, `cancel_${release}`);
    assert.ok(!Object.hasOwn(state, 'revokedBots'));
    assert.ok(!Object.hasOwn(state, 'revocations'));
    const saved = state.plans.find((entry) => entry.id === id);
    assert.equal(saved.status, 'cancelled');
    assert.ok(!Object.hasOwn(saved, 'grantId'));
    assert.ok(!JSON.stringify(saved).includes(grantId), 'Revocation window must be memory-only');
    if (robot.blockAt(INSIDE)?.name !== 'grass_block') {
      // An optimistic Mineflayer dig can overwrite its cache after the denial packet.
      // Force a vanilla block update after independently verifying the denied dig above.
      await rcon.command(`setblock ${coords(INSIDE)} dirt`);
      await rcon.command(`setblock ${coords(INSIDE)} grass_block`);
      await until(() => robot.blockAt(INSIDE)?.name === 'grass_block', 'authoritative block resynchronization');
    }
    if (release === 'ack') {
      releaseAck(grantId);
      await delay(250);
    } else {
      // The menu click round trip takes one tick, plus its test client pacing delay.
      await delay(Math.max(0, 15_650 - (performance.now() - startTime)));
    }
    await dig(rcon, robot, INSIDE);
    await assertBlock(rcon, INSIDE, 'minecraft:air');
    if (release === 'ack') {
      assert.ok(performance.now() - startTime < 15_000, 'Must reopen earlier than the fallback');
    }
    assert.equal((await plan(rcon, id)).lateAttempts, 1);
    record('fix1-f1-scope-pass', { id, release, savedEvidence: file,
      elapsedMs: Math.round(performance.now() - startTime), outside: 'air', insideAfterRelease: 'air' });
  }
}

async function executeSmall(env, interrupt) {
  const { rcon, owner, robot } = env;
  await prepareSmall(rcon);
  await rcon.command('gamemode survival DeskPetBot');
  const id = await previewFixture(rcon);
  // An actual natural state transition after preview must survive revalidation and dig.
  await rcon.command(`setblock ${coords(FIRST)} grass_block`);
  await confirmFixture(rcon, id);
  await accepted(env, id);
  await dig(rcon, robot, FIRST);
  await assertBlock(rcon, FIRST, 'minecraft:air');
  const progress = await plan(rcon, id);
  assert.equal(progress.status, 'running');
  assert.deepEqual(Object.values(progress.consumed), [1]);

  if (interrupt) {
    await rcon.command(`setblock ${coords(SECOND)} oak_planks`);
    await dig(rcon, robot, SECOND, 'minecraft:diamond_axe');
    const paused = await waitPlan(rcon, id, 'paused');
    await assertBlock(rcon, SECOND, 'minecraft:oak_planks');
    assert.match(paused.reason, /^expected_block_changed/);
    assert.equal(paused.siteChanges, 1);
    assert.equal(paused.violations, 0);
    assert.deepEqual(Object.values(paused.consumed), [1]);
    await dig(rcon, robot, INSIDE);
    await assertBlock(rcon, INSIDE, 'minecraft:grass_block');
    await manage(rcon, owner, BUTTON.continue);
    const stillPaused = await plan(rcon, id);
    assert.equal(stillPaused.status, 'paused');
    assert.match(stillPaused.lastDenial, /protected_block_changed/);
    assert.equal(stillPaused.plan.revision, 1);
    await rcon.command(`setblock ${coords(SECOND)} dirt`);
    await manage(rcon, owner, BUTTON.continue);
    const resumed = await accepted(env, id, 2);
    assert.notEqual(resumed.grantId, progress.grantId);
    assert.equal(resumed.plan.ops.length, 2, 'Previously consumed dig must not be reissued');
    assert.equal(resumed.siteChanges, 1);
    assert.equal(resumed.lateAttempts, 1);
  } else {
    await dig(rcon, robot, OUTSIDE);
    await assertBlock(rcon, OUTSIDE, 'minecraft:grass_block');
    assert.equal((await plan(rcon, id)).violations, 1);
  }

  await dig(rcon, robot, SECOND);
  await assertBlock(rcon, SECOND, 'minecraft:air');
  await fill(rcon, robot);
  const terminal = await waitPlan(rcon, id, interrupt ? 'completed' : 'failed');
  assert.equal(terminal.violations, interrupt ? 0 : 1);
  assert.equal(terminal.siteChanges, interrupt ? 1 : 0);
  assert.equal(terminal.lateAttempts, interrupt ? 1 : 0);
  if (!interrupt) assert.match(terminal.reason, /outside_authorized_operations/);
  await assertBlock(rcon, FIRST, 'minecraft:air');
  record('fix1-f2-executed', { id, interrupted: interrupt, status: terminal.status, reason: terminal.reason,
    revision: terminal.plan.revision, violations: terminal.violations, siteChanges: terminal.siteChanges,
    lateAttempts: terminal.lateAttempts, consumed: terminal.consumed,
    states: ['minecraft:air', 'minecraft:air', 'minecraft:dirt'] });
}

async function counterChecks(env) {
  await executeSmall(env, true);
  if (env.owner.currentWindow) env.owner.closeWindow(env.owner.currentWindow);
  await executeSmall(env, false);
}

async function conflictChecks(env) {
  const { rcon } = env;
  const attached = FIRST.offset(-1, 0, 0);
  for (const [pos, introduced, reason, restore] of [
    [attached, 'wall_torch[facing=west]', /^outside_attachment at /, 'air'],
    [SECOND, 'oak_planks', /protected_block_changed/, 'dirt'],
  ]) {
    await prepareSmall(rcon);
    const id = await previewFixture(rcon);
    await rcon.command(`setblock ${coords(pos)} ${introduced}`);
    await assertBlock(rcon, pos, introduced);
    await confirmFixture(rcon, id);
    const denied = await plan(rcon, id);
    assert.equal(denied.status, 'previewed');
    assert.match(denied.lastDenial, reason);
    assert.ok(!env.events.some((event) => event.type === 'accepted' && event.planId === id));
    record('fix1-f3-conflict', { id, introduced, reason: denied.lastDenial });
    await rcon.command(`setblock ${coords(pos)} ${restore}`);
  }
}

async function retention(env) {
  const { rcon } = env;
  await prepareSmall(rcon);
  const ongoingId = await previewFixture(rcon);
  await confirmFixture(rcon, ongoingId);
  const ongoing = await accepted(env, ongoingId);
  const ended = [];
  for (let index = 0; index < 30; index++) {
    const id = await previewFixture(rcon);
    await rcon.command(`execute as Owner at @s run deskpet debug cancel ${id}`);
    assert.equal((await plan(rcon, id)).status, 'cancelled');
    ended.push(id);
  }
  const { file, state } = await readSave(rcon, 'retention');
  const savedOngoing = state.plans.find((entry) => entry.id === ongoingId);
  assert.equal(savedOngoing.status, 'running');
  assert.deepEqual(savedOngoing.plan, ongoing.plan, 'All ongoing operations must survive save pruning');
  const fullTerminal = state.plans.filter((entry) =>
    ['completed', 'failed', 'cancelled', 'expired'].includes(entry.status) && entry.plan);
  assert.deepEqual(fullTerminal.map((entry) => entry.id).sort(), ended.slice(-20).sort());
  record('fix1-f5-retention-pass', { file, ongoingId, terminalCreated: ended.length,
    terminalSaved: fullTerminal.length, fullRunningOperations: savedOngoing.plan.ops.length });
}

async function legacyMigration(env) {
  const { rcon } = env;
  const input = process.env.DESKPET_TEST_LEGACY_PLAN_FILE;
  assert.ok(input, 'Set DESKPET_TEST_LEGACY_PLAN_FILE to the input save copied to the dedicated world');
  const raw = await readPlanBytes(input);
  const json = raw.replace(/\u0000+$/, '');
  const original = JSON.parse(json);
  assert.ok(Object.hasOwn(original, 'revokedBots'));
  const trimBytes = Buffer.byteLength(raw) - Buffer.byteLength(json);
  assert.ok(trimBytes > 0, 'Expected input from the padded legacy encoder');
  assert.equal((await readPlans(rcon)).plans.length, original.plans.length);
  const { file, state } = await readSave(rcon, 'legacy-roundtrip');
  assert.ok(!Object.hasOwn(state, 'revokedBots'));
  assert.equal(state.plans.length, original.plans.length);
  for (const before of original.plans) {
    const restored = state.plans.find((entry) => entry.id === before.id);
    assert.deepEqual(restored.plan, before.plan);
    if (['running', 'confirmed'].includes(before.status)) {
      assert.equal(restored.status, 'paused');
      assert.equal(restored.reason, 'server_restart');
      assert.ok(!Object.hasOwn(restored, 'grantId'));
    } else if (before.status === 'previewed' && before.plan.expiresAt <= Date.now()) {
      assert.equal(restored.status, 'expired');
      assert.equal(restored.reason, 'preview_expired');
    } else {
      assert.equal(restored.status, before.status);
    }
  }
  record('fix1-legacy-plan-roundtrip-pass', { input, output: file, removedTrailingZeroBytes: trimBytes,
    restored: state.plans.map(({ id, status, reason }) => ({ id, status, reason })),
    legacyGlobalEntries: Object.keys(original.revokedBots).length });
}

function naturalSurface(bot, x, z) {
  const plants = /^(short_grass|tall_grass|fern|large_fern|dandelion|poppy|azure_bluet|cornflower|oxeye_daisy|allium|.+_tulip)$/;
  for (let y = 86; y >= 60; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) break;
    if (/^(grass_block|dirt)$/.test(block.name)) return block.position;
    if (block.name !== 'air' && !plants.test(block.name)) break;
  }
  return null;
}

function naturalSite(bot) {
  // Generated plains near this known seed-11 site. Score intact 13×13 surfaces.
  const candidates = [];
  for (let x = -457; x <= -437; x += 2) {
    for (let z = 535; z <= 555; z += 2) {
      const size = 13;
      const ground = [];
      for (let dx = 0; dx < size; dx++) {
        for (let dz = 0; dz < size; dz++) ground.push(naturalSurface(bot, x + dx, z + dz));
      }
      if (ground.some((cell) => !cell)) continue;
      const first = ground[0];
      const second = ground.at(-1);
      const approach = naturalSurface(bot, second.x, second.z + 2);
      const wheatCenter = naturalSurface(bot, second.x + 5, first.z + 5);
      if (!approach || approach.y > second.y || !wheatCenter || first.y !== ground[2].y) continue;
      const range = Math.max(...ground.map((pos) => pos.y)) - Math.min(...ground.map((pos) => pos.y));
      candidates.push({ first, second, ground, wheatCenter, range });
    }
  }
  candidates.sort((left, right) => left.range - right.range);
  return candidates[0];
}

async function naturalPreview(env) {
  const { rcon, owner } = env;
  assert.match(await rcon.command('seed'), /\[11\]/, 'Run natural fixture on a fresh seed-11 Overworld');
  await rcon.command('gamemode creative Owner');
  await move(rcon, owner, new Vec3(-447.5, 84, 544.5));
  const site = await until(() => naturalSite(owner), 'loaded, intact generated plains site', 30_000, 300);
  const { first, second, ground, wheatCenter, range } = site;
  assert.match(await rcon.command(`execute positioned ${coords(first.offset(0, 1, 0))} if biome ~ ~ ~ minecraft:plains`),
    /Test passed/);
  for (const [rule, value] of [['randomTickSpeed', 3], ['doMobSpawning', true], ['doFireTick', true],
    ['mobGriefing', true], ['doDaylightCycle', true]]) {
    await rcon.command(`gamerule ${rule} ${value}`);
    assert.ok((await rcon.command(`gamerule ${rule}`)).endsWith(String(value)));
  }
  for (const spot of ground.filter((_, index) => index >= 32 && index <= 84 && index % 7 === 0)) {
    await rcon.command(`setblock ${coords(spot.offset(0, 1, 0))} air`);
    await rcon.command(`setblock ${coords(spot)} dirt`);
  }
  const flower = ground.find((pos) => pos.x === first.x + 2 && pos.z === first.z + 3);
  await rcon.command(`setblock ${coords(flower.offset(0, 1, 0))} poppy`);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const soil = wheatCenter.offset(dx, 0, dz);
      await rcon.command(`setblock ${coords(soil.offset(0, 1, 0))} air`);
      if (dx === 0 && dz === 0) {
        await rcon.command(`setblock ${coords(soil)} water`);
      } else {
        await rcon.command(`setblock ${coords(soil)} farmland[moisture=7]`);
        await rcon.command(`setblock ${coords(soil.offset(0, 1, 0))} wheat[age=0]`);
      }
    }
  }
  await assertBlock(rcon, wheatCenter.offset(1, 1, 1), 'minecraft:wheat[age=0]');
  await assertBlock(rcon, flower.offset(0, 1, 0), 'minecraft:poppy');
  await equip(rcon, owner);
  await blockClick(rcon, owner, first, { ground: true });
  await blockClick(rcon, owner, second, { ground: true });
  await openMenu(owner);
  const preview = (await readPlans(rcon)).plans.find((entry) => entry.status === 'previewed'
    && entry.plan.selection.minX === first.x && entry.plan.selection.maxZ === second.z);
  assert.ok(preview, 'The real wand GUI must preview the generated site');
  const lowY = Math.min(...ground.map((pos) => pos.y), wheatCenter.y);
  const highY = Math.max(...ground.map((pos) => pos.y), wheatCenter.y);
  const lo = new Vec3(first.x, lowY, first.z);
  const hi = new Vec3(wheatCenter.x + 1, highY + 2, second.z);
  const initial = await snapshot(rcon, `${ID}_natural_before`, lo, hi);
  const startTime = performance.now();
  await delay(180_000);
  const elapsedMs = Math.round(performance.now() - startTime);
  const latest = await snapshot(rcon, `${ID}_natural_after`, lo, hi);
  const { worldDir } = await serverSettings();
  const states = async (phase) => JSON.parse(await fs.readFile(
    path.join(worldDir, 'deskpet-snapshots', `${ID}_natural_${phase}.json`), 'utf8')).blocks;
  const [before, after] = await Promise.all([states('before'), states('after')]);
  const naturalChanges = before.flatMap(([x, y, z, oldState], index) => {
    const newState = after[index][3];
    return oldState === newState ? [] : [{ x, y, z, oldState, newState }];
  });
  await click(owner, BUTTON.confirm);
  const live = await accepted(env, preview.id);
  record('fix1-f3-natural-pass', { id: preview.id, first, second, range, wheatCenter, elapsedMs, initial,
    latest, naturalChanges, operationCount: live.plan.ops.length });
  await click(owner, BUTTON.cancel);
  await waitPlan(rcon, preview.id, 'cancelled');
}

const check = {
  confirmed: confirmationScope, scope: revocationScope, counters: counterChecks, conflicts: conflictChecks,
  natural: naturalPreview, retention, legacy: legacyMigration,
}[process.argv[2]];
assert.ok(check, 'Use confirmed, scope, counters, conflicts, natural, retention, or legacy');
start(check, { arena: ![naturalPreview, legacyMigration].includes(check) }).catch((error) => {
  record('fix1-failed', { error: error.stack });
  process.exitCode = 1;
});
