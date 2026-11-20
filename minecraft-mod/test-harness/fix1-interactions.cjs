'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Vec3, record, until } = require('./common.cjs');
const { Y, coords, move, equip, snapshot, readPlans, assertBlock } = require('./wand-session.cjs');
const { ORIGIN, start, plan, waitPlan, previewFixture, confirmFixture, accepted } = require('./fix1-session.cjs');

const FACING_UP = new Vec3(0, 1, 0);
const FARM = ORIGIN.offset(0, -1, 0);
const DOOR = ORIGIN.offset(3, 0, 0);
const WATER = ORIGIN.offset(8, 0, 0);
const OUTSIDE_DOOR = new Vec3(-1, Y, 4);
const DOOR_STATE = 'minecraft:oak_door[facing=north,hinge=left,open=false,powered=false';
const PROBES = [
  { name: 'water_bucket', z: 1, bucket: true, initial: 'air', target: 'water[level=0]' },
  { name: 'lava_bucket', z: 4, bucket: true, initial: 'air', target: 'lava[level=0]' },
  { name: 'empty_bucket', item: 'bucket', z: 7, bucket: true, initial: 'water[level=0]', target: 'air' },
  { name: 'hoe', item: 'iron_hoe', z: 10, y: -1, initial: 'dirt', target: 'farmland[moisture=0]' },
  { name: 'axe', item: 'iron_axe', z: 13, initial: 'oak_log[axis=y]', target: 'stripped_oak_log[axis=y]' },
  { name: 'shovel', item: 'iron_shovel', z: 16, y: -1, initial: 'grass_block[snowy=false]', target: 'dirt_path' },
  { name: 'flint_and_steel', z: 19, support: 'netherrack', initial: 'air', target: 'fire' },
  { name: 'bone_meal', z: 22, support: 'farmland[moisture=7]', initial: 'wheat[age=0]', count: 3 },
  { name: 'honeycomb', z: 24, initial: 'copper_block', target: 'waxed_copper_block' },
  { name: 'fire_charge', z: -3, support: 'netherrack', initial: 'air', target: 'fire' },
];

const positionOf = (probe) => new Vec3(-5, Y + (probe.y ?? 0), probe.z);
const namespaced = (state) => `minecraft:${state}`;

async function setBlock(rcon, pos, block) {
  await rcon.command(`setblock ${coords(pos)} ${block}`);
  await assertBlock(rcon, pos, namespaced(block));
}

async function well(rcon, pos, contents) {
  await setBlock(rcon, pos.offset(0, -1, 0), 'stone');
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    await setBlock(rcon, pos.offset(x, 0, z), 'stone');
  }
  await setBlock(rcon, pos, contents);
}

async function selectItem(rcon, bot, name, count = 1) {
  await equip(rcon, bot, namespaced(name));
  if (count > 1) {
    await rcon.command(`item replace entity ${bot.username} weapon.mainhand with ${name} ${count}`);
    await until(() => bot.heldItem?.count === count, `${count} ${name} in selected slot`);
  }
}

async function selectedItem(rcon) {
  const data = await rcon.command('data get entity DeskPetBot SelectedItem');
  assert.match(data, /DeskPetBot has the following entity data:/);
  return data;
}

async function blockAction(rcon, robot, pos, cursor = new Vec3(0.5, 1, 0.5)) {
  const approachZ = pos.z > 22 ? pos.z - 1.5 : pos.z + 2.5;
  await move(rcon, robot, new Vec3(pos.x + 0.5, Math.max(Y, pos.y), approachZ));
  const block = await until(() => {
    const current = robot.blockAt(pos);
    return current && current.name !== 'air' && current;
  }, `block interaction target ${coords(pos)}`);
  await robot.activateBlock(block, FACING_UP, cursor);
  robot._client.write('tick_end', {});
  await delay(230);
}

async function bucketAction(rcon, robot, pos, collect = false) {
  await move(rcon, robot, pos.offset(1.4, 1, 0.5));
  // Aiming into the stone well exercises the vanilla server-side bucket raycast.
  await robot.lookAt(pos.offset(0.5, collect ? 0.65 : -0.05, 0.5), true);
  robot.activateItem();
  robot._client.write('tick_end', {});
  await delay(230);
}

async function prepareProbe(rcon, probe) {
  const pos = positionOf(probe);
  if (probe.bucket) {
    await well(rcon, pos, probe.initial);
  } else {
    if (probe.support) await setBlock(rcon, pos.offset(0, -1, 0), probe.support);
    await setBlock(rcon, pos, probe.initial);
  }
  return pos;
}

async function runProbe(rcon, robot, probe, activePlan) {
  const pos = await prepareProbe(rcon, probe);
  await selectItem(rcon, robot, probe.item ?? probe.name, probe.count);
  const itemBefore = await selectedItem(rcon);
  const prefix = `fix1_f4_${activePlan ? 'denied' : 'allowed'}_${probe.name}`;
  const snapshotBefore = await snapshot(rcon, `${prefix}_before`, pos, pos);
  const rejectionsBefore = (await readPlans(rcon)).rejections.length;
  const planBefore = activePlan ? await plan(rcon, activePlan) : null;

  if (probe.bucket) {
    await bucketAction(rcon, robot, pos, probe.name === 'empty_bucket');
  } else {
    const hit = probe.support && probe.initial === 'air' ? pos.offset(0, -1, 0) : pos;
    await blockAction(rcon, robot, hit);
  }

  const snapshotAfter = await snapshot(rcon, `${prefix}_after`, pos, pos);
  const entries = (await readPlans(rcon)).rejections.slice(rejectionsBefore);
  if (activePlan) {
    assert.equal(snapshotAfter, snapshotBefore, `${probe.name} changed a denied state`);
    assert.equal(await selectedItem(rcon), itemBefore, `${probe.name} changed item count, contents, or damage`);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    const [entry] = entries;
    assert.equal(entry.planId, activePlan);
    assert.equal(entry.action, probe.bucket ? 'interact_item' : 'interact_block');
    assert.equal(entry.reason, 'outside_authorized_operations');
    assert.equal(entry.category, 'violation');
    assert.deepEqual(entry.pos, { x: pos.x, y: pos.y, z: pos.z });
    const after = await plan(rcon, activePlan);
    assert.equal(after.violations, planBefore.violations + 1);
    assert.equal(after.siteChanges, 0);
    assert.equal(after.lateAttempts, 0);
    assert.equal(after.status, 'running');
    record('fix1-f4-denied', { item: probe.name, snapshot: snapshotAfter, selectedItem: itemBefore, rejection: entry });
  } else {
    assert.notEqual(snapshotAfter, snapshotBefore, `${probe.name} fixture failed without authorization`);
    if (probe.target) await assertBlock(rcon, pos, namespaced(probe.target));
    assert.deepEqual(entries, [], 'An unassigned robot should not be blocked');
    record('fix1-f4-unassigned-control', { item: probe.name, before: snapshotBefore, after: snapshotAfter });
  }
  await prepareProbe(rcon, probe);
}

async function assertDoor(rcon, pos, open) {
  const state = DOOR_STATE.replace('open=false', `open=${open}`);
  await assertBlock(rcon, pos, `${state},half=lower]`);
  await assertBlock(rcon, pos.offset(0, 1, 0), `${state},half=upper]`);
}

async function preparePlan(rcon) {
  await setBlock(rcon, FARM, 'dirt');
  await setBlock(rcon, DOOR.offset(0, -1, 0), 'dirt');
  await setBlock(rcon, DOOR, 'air');
  await setBlock(rcon, DOOR.offset(0, 1, 0), 'air');
  await well(rcon, WATER, 'air');
  await rcon.command(`setblock ${coords(OUTSIDE_DOOR)} ${DOOR_STATE},half=lower]`);
  await rcon.command(`setblock ${coords(OUTSIDE_DOOR.offset(0, 1, 0))} ${DOOR_STATE},half=upper]`);
  await assertDoor(rcon, OUTSIDE_DOOR, false);
}

async function grant(env) {
  await preparePlan(env.rcon);
  const id = await previewFixture(env.rcon, 'interactions');
  await confirmFixture(env.rcon, id);
  await accepted(env, id);
  return id;
}

async function testInteractions(env) {
  const { rcon, robot } = env;
  await rcon.command('gamemode survival DeskPetBot');
  for (const probe of PROBES) await runProbe(rcon, robot, probe);

  const denyPlan = await grant(env);
  for (const probe of PROBES) await runProbe(rcon, robot, probe, denyPlan);
  assert.equal((await plan(rcon, denyPlan)).violations, PROBES.length);
  await rcon.command(`execute as Owner at @s run deskpet debug cancel ${denyPlan}`);
  await waitPlan(rcon, denyPlan, 'cancelled');
  await delay(300); // Allow the production receiver to process and acknowledge revocation.

  const finishPlan = await grant(env);
  await selectItem(rcon, robot, 'iron_hoe');
  const hoeBefore = await selectedItem(rcon);
  await blockAction(rcon, robot, FARM);
  await assertBlock(rcon, FARM, 'minecraft:farmland[moisture=0]');
  assert.notEqual(await selectedItem(rcon), hoeBefore, 'Authorized hoe use should incur its vanilla wear');

  await selectItem(rcon, robot, 'oak_door');
  await blockAction(rcon, robot, DOOR.offset(0, -1, 0));
  await assertDoor(rcon, DOOR, false);
  await blockAction(rcon, robot, OUTSIDE_DOOR, new Vec3(0.5, 0.5, 0.5));
  await assertDoor(rcon, OUTSIDE_DOOR, true);
  await blockAction(rcon, robot, DOOR, new Vec3(0.5, 0.5, 0.5));
  await assertDoor(rcon, DOOR, true);
  assert.equal((await plan(rcon, finishPlan)).violations, 0);

  await selectItem(rcon, robot, 'water_bucket');
  await bucketAction(rcon, robot, WATER);
  await assertBlock(rcon, WATER, 'minecraft:water[level=0]');
  assert.match(await selectedItem(rcon), /minecraft:bucket/);
  const complete = await waitPlan(rcon, finishPlan, 'completed');
  assert.equal(complete.violations, 0);
  assert.equal(complete.siteChanges, 0);
  assert.equal(complete.lateAttempts, 0);
  await assertDoor(rcon, DOOR, true);
  record('fix1-f4-pass', { denied: PROBES.map((probe) => probe.name), plan: finishPlan, status: complete.status,
    permitted: ['hoe', 'place_door', 'open_outside_door', 'open_planned_door', 'water_bucket'] });
}

async function testRollback(env) {
  const { rcon, robot } = env;
  const id = await grant(env);
  const lava = WATER.offset(-1, 0, 0);
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1]]) {
    await setBlock(rcon, lava.offset(x, 0, z), 'stone');
  }
  await selectItem(rcon, robot, 'water_bucket');
  const itemBefore = await selectedItem(rcon);
  const rejectionsBefore = (await readPlans(rcon)).rejections.length;
  // Introduce lava after authorization. Pouring the authorized source would
  // synchronously turn the adjacent, unlisted lava cell into obsidian.
  await setBlock(rcon, lava, 'lava[level=0]');
  const before = await snapshot(rcon, 'fix1_f4_rollback_before', lava, WATER);
  await bucketAction(rcon, robot, WATER);
  const after = await snapshot(rcon, 'fix1_f4_rollback_after', lava, WATER);
  assert.equal(after, before, 'Rejecting the second write must undo the first');
  await assertBlock(rcon, WATER, 'minecraft:air');
  await assertBlock(rcon, lava, 'minecraft:lava[level=0]');
  assert.equal(await selectedItem(rcon), itemBefore);
  const entries = (await readPlans(rcon)).rejections.slice(rejectionsBefore);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].planId, id);
  assert.equal(entries[0].reason, 'outside_authorized_operations');
  assert.deepEqual(entries[0].pos, { x: lava.x, y: lava.y, z: lava.z });
  const active = await plan(rcon, id);
  assert.equal(active.status, 'running');
  assert.equal(active.violations, 1);
  await setBlock(rcon, lava, 'stone');
  await rcon.command(`execute as Owner at @s run deskpet debug cancel ${id}`);
  await waitPlan(rcon, id, 'cancelled');
  record('fix1-f4-rollback-pass', { plan: id, snapshot: after, selectedItem: itemBefore, rejection: entries[0] });
}

start(async (env) => {
  await testInteractions(env);
  await testRollback(env);
}).catch((error) => {
  record('fix1-f4-failed', { error: error.stack });
  process.exitCode = 1;
});
