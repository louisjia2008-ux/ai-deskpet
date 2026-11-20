'use strict';

const assert = require('node:assert/strict');
const { SLOT, P, Y, Vec3, until, record, coords, click, requireButton, dashboard,
  startPlan, planWhere, take, settled, runWorld, protocol, readPlans } = require('./m4-session.cjs');
const { commandAssert } = require('./wand-session.cjs');
const { verifyBlocks } = require('./m3-verification.cjs');

const counters = ['violations', 'misplacements', 'siteChanges', 'lateAttempts'];
const parameters = ['planId', 'worldId', 'dimension', 'ownerUuid', 'botUuid', 'selection',
  'template', 'groundY', 'mode', 'fillDepthLimit', 'clipTrees', 'supplyChest'];

function samePos(a, b) { return coords(a) === coords(b); }

function at(env, pos) { return env.owner.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name; }

async function set(env, pos, block) {
  const response = await env.rcon.command(`setblock ${coords(pos)} ${block}`);
  commandAssert(response, `Change test world at ${coords(pos)} to ${block}`);
  assert.match(response, /Changed the block/);
  record('m4-site-fixture', { pos, block, response });
}

async function pause(env) {
  await dashboard(env.owner);
  requireButton(env.owner, SLOT.pause, /暂停/);
  await click(env.owner, SLOT.pause);
  return planWhere(env, (row) => row.status === 'paused' && row.reason === 'owner_paused', 'real Owner pause is authoritative');
}

async function comparison(env, { regenerate = false } = {}) {
  if (!regenerate) {
    await dashboard(env.owner);
    requireButton(env.owner, SLOT.recompare, /重新比对/);
  }
  await click(env.owner, regenerate ? SLOT.regenerate : SLOT.recompare);
  const preview = await until(async () => (await readPlans(env.rcon)).recomparisons
    ?.find(({ plan }) => plan.planId === env.id), 'server exported actual recompare preview', 5000);
  const { plan, diff } = preview;
  const original = env.plan;
  assert.equal(plan.revision, original.revision + 1);
  for (const key of parameters) assert.deepEqual(plan[key], original[key], `Immutable plan field ${key}`);
  assert.notEqual(plan.planHash, original.planHash);
  const selection = plan.selection;
  for (const { pos } of plan.ops) {
    assert.ok(pos.x >= selection.minX && pos.x <= selection.maxX && pos.y >= selection.minY
      && pos.y <= selection.maxY && pos.z >= selection.minZ && pos.z <= selection.maxZ,
    `Recompare operation outside original bounds: ${coords(pos)}`);
  }
  const { added, removed, unchanged } = diff;
  assert.equal(added.length + unchanged.length, plan.ops.length);
  const counts = new RegExp(`新增 ${added.length} · 取消 ${removed.length} · 不变 ${unchanged.length}`);
  requireButton(env.owner, SLOT.status, counts);
  requireButton(env.owner, SLOT.confirm, plan.conflicts.length ? /冲突/ : /确认新版/, !plan.conflicts.length);
  record('m4-comparison', { previewId: preview.previewId, id: env.id, revision: plan.revision, selection,
    total: plan.ops.length, added, removed, unchanged: unchanged.length, materials: plan.materials, conflicts: plan.conflicts });
  return preview;
}

async function diffMarker(env, pos, color) {
  const stateId = env.owner.registry.blocksByName[color].defaultState;
  return until(() => [...env.ownerWire.displays.values()].find((entity) => entity.display === 'block'
    && samePos(entity.pos, pos) && entity.metadata.block_state === stateId),
  `Owner receives ${color} diff display at ${coords(pos)}`, 6000);
}

async function confirm(env, preview, previous) {
  assert.deepEqual(preview.plan.conflicts, []);
  await click(env.owner, SLOT.confirm);
  const running = await planWhere(env, (row) => ['confirmed', 'running'].includes(row.status)
    && row.plan.revision === preview.plan.revision, 'Owner confirms the revised grant', 12000);
  for (const key of counters) assert.ok(running[key] >= previous[key], `${key} reset across recompare`);
  assert.equal(running.completedBefore, previous.completed);
  assert.notEqual(running.grantId, env.firstGrant);
  const complete = await settled(env, preview.plan.revision);
  for (const key of counters) assert.ok(complete[key] >= previous[key], `${key} reset while executing revised plan`);
  const final = await take(env, 'complete');
  await verifyBlocks(env.plan, env.before.blocks, final.blocks);
  return complete;
}

async function cancel(env, expectedNotifications = 1) {
  await dashboard(env.owner);
  requireButton(env.owner, SLOT.cancel, /取消施工/);
  await click(env.owner, SLOT.cancel);
  const row = await planWhere(env, (plan) => plan.status === 'cancelled', 'real Owner cancels the active plan');
  await until(() => env.owner.currentWindow === null, 'successful cancellation closes the Owner menu', 5000);
  await until(() => env.ownerWire.bars.size === 0, 'Owner sees terminal Boss removal', 5000);
  record('m4-cancel-menu-closed', { id: row.id, status: row.status, reason: row.reason });
  assert.equal(env.ownerWire.chat.filter((s) => s.includes('【施工】 取消')).length, expectedNotifications);
  return row;
}

async function roofObstruction(env, block) {
  const first = await startPlan(env);
  env.firstGrant = first.grantId;
  const op = env.plan.ops.find(({ phase, target }) => phase === 'roof' && target === 'minecraft:oak_planks');
  assert.ok(op, 'Starter plan has a future roof placement');
  await planWhere(env, (plan) => plan.completed >= 10 && plan.phase === 'walls', 'live worker reached first wall course', 120000);
  assert.equal(at(env, op.pos), 'air');
  await set(env, op.pos, block);
  const paused = await planWhere(env, (plan) => plan.status === 'paused', 'the real worker pauses on the site change', 180000);
  assert.equal(paused.violations, 0);
  assert.ok(paused.completed < paused.total);
  assert.deepEqual(paused.blocked?.pos, op.pos);
  await take(env, 'blocked');
  return { paused, pos: op.pos };
}

async function added(env) {
  const { paused, pos } = await roofObstruction(env, 'dirt');
  const preview = await comparison(env);
  assert.deepEqual(preview.plan.conflicts, []);
  assert.equal(preview.diff.added.length, 1);
  const [{ order, ...operation }] = preview.diff.added;
  assert.equal(order, 0);
  assert.deepEqual(operation, { pos, expect: 'minecraft:dirt', target: 'minecraft:air', kind: 'cut', phase: 'terrain' });
  requireButton(env.owner, 10, /新增 · 1/);
  const addedMarker = await diffMarker(env, pos, 'lime_stained_glass');
  const unchangedMarker = await diffMarker(env, preview.diff.unchanged[0].pos, 'light_blue_stained_glass');
  record('m4-colored-diff', { added: addedMarker, unchanged: unchangedMarker });
  await confirm(env, preview, paused);
}

async function rebuild(env) {
  const first = await startPlan(env);
  env.firstGrant = first.grantId;
  const walls = env.plan.ops.filter(({ phase, pos, target }) =>
    phase === 'walls' && pos.y === Y + 1 && target === 'minecraft:cobblestone').slice(0, 3);
  assert.equal(walls.length, 3);
  await planWhere(env, (row) => ['scaffold', 'roof'].includes(row.phase), 'all walls are finished', 180000);
  const paused = await pause(env);
  for (const { pos } of walls) {
    assert.equal(at(env, pos), 'cobblestone');
    await set(env, pos, 'air');
  }
  const preview = await comparison(env);
  const repair = preview.diff.added.filter((op) => walls.some(({ pos }) => samePos(pos, op.pos)));
  assert.equal(repair.length, 3);
  assert.ok(repair.every(({ expect, target }) => expect === 'minecraft:air' && target === 'minecraft:cobblestone'));
  assert.equal(preview.plan.materials.required['minecraft:cobblestone'], 3);
  await confirm(env, preview, paused);
}

async function zeroRemaining(env) {
  const first = await startPlan(env, { holdSettlement: true });
  env.firstGrant = first.grantId;
  await until(() => env.transport.isHeld('settled'), 'real Core completed all work and sent settlement', 180000, 150);
  const complete = await planWhere(env, (row) => row.status === 'running' && row.completed === row.total, 'server applied all operations');
  assert.equal(complete.total, env.plan.ops.length);
  const { pos } = env.plan.ops.find(({ phase, pos: point, target }) =>
    phase === 'walls' && point.y === Y + 1 && target === 'minecraft:cobblestone');
  assert.equal(at(env, pos), 'cobblestone');
  await set(env, pos, 'air');
  await env.transport.release('settled');
  const paused = await planWhere(env, (row) => row.status === 'paused', 'the original real terminal scan sees a missing wall');
  assert.equal(paused.reason, 'server_final_state_changed');
  assert.equal(paused.total - paused.completed, 0);
  assert.deepEqual(paused.blocked.pos, pos);
  await dashboard(env.owner);
  const mismatchMarker = await diffMarker(env, pos, 'red_stained_glass');
  assert.equal(mismatchMarker.metadata.glow_color_override, 0xFF3030);
  assert.ok(mismatchMarker.metadata.shared_flags & 0x40);
  record('m4-final-mismatch-marker', { pos, marker: mismatchMarker });
  const preview = await comparison(env);
  assert.equal(preview.plan.ops.length, 1);
  assert.equal(preview.diff.added.length, 1);
  assert.deepEqual(preview.diff.added[0].pos, pos);
  assert.equal(preview.plan.materials.required['minecraft:cobblestone'], 1);
  await confirm(env, preview, paused);
}

async function protectedBlock(env) {
  const { paused, pos } = await roofObstruction(env, 'chest');
  const blocked = await comparison(env);
  assert.ok(blocked.plan.conflicts.some((conflict) => conflict.kind === 'protected' && samePos(conflict.pos, pos)));
  requireButton(env.owner, SLOT.confirm, new RegExp(`${pos.x}, ${pos.y}, ${pos.z}`), false);
  await diffMarker(env, pos, 'red_stained_glass');
  await click(env.owner, SLOT.confirm);
  const stillPaused = await planWhere(env, (row) => row.status === 'paused', 'disabled confirm keeps paused authorization');
  assert.equal(stillPaused.plan.revision, env.plan.revision);
  assert.equal(at(env, pos), 'chest');
  await set(env, pos, 'air');
  const fixed = await comparison(env, { regenerate: true });
  assert.notEqual(fixed.previewId, blocked.previewId);
  await confirm(env, fixed, paused);
}

async function scope(env) {
  await startPlan(env, { boundaryWork: true });
  const inside = new Vec3(P.first.x, Y, P.first.z + 6);
  const outside = inside.offset(-1, 0, 0);
  assert.ok(env.plan.ops.some((op) => samePos(op.pos, inside) && ['cut', 'clear'].includes(op.kind)));
  await until(() => at(env, inside) === 'air', 'builder clears originally approved selection-edge dirt', 120000, 150);
  await pause(env);
  await set(env, inside, 'dirt');
  await set(env, outside, 'wall_torch[facing=west]');
  const preview = await comparison(env);
  assert.ok(preview.plan.conflicts.some(({ kind, pos }) => kind === 'outside_attachment' && samePos(pos, outside)));
  requireButton(env.owner, SLOT.confirm, new RegExp(`${outside.x}, ${outside.y}, ${outside.z}`), false);
  await diffMarker(env, outside, 'red_stained_glass');
  await click(env.owner, SLOT.confirm);
  const stillPaused = await planWhere(env, (row) => row.status === 'paused', 'original plan stays paused with outside conflict');
  assert.equal(stillPaused.plan.revision, env.plan.revision);
  assert.equal(at(env, inside), 'dirt');
  assert.equal(at(env, outside), 'wall_torch');
  await take(env, 'boundary_conflict_intact');
  await cancel(env);
}

async function confirmFromTest(env, token, reason) {
  await env.rcon.command(`execute as Owner at @s run deskpet debug confirm ${token}`);
  const denial = await until(async () => (await readPlans(env.rcon)).protocolRejections?.findLast((event) =>
    event.action === 'confirm' && event.planId === token && event.reason === reason),
  `real confirmation callback rejects ${reason}`, 5000);
  record('m4-confirm-denied', denial);
}

async function stale(env) {
  await startPlan(env);
  const accept = env.transport.outbound.find((message) => message.type === 'accept' && message.planId === env.id);
  assert.ok(accept);
  await pause(env);
  const finishedByOwner = env.plan.ops.find(({ phase, target }) => phase === 'roof' && target === 'minecraft:oak_planks');
  await set(env, finishedByOwner.pos, finishedByOwner.target);
  const first = await comparison(env);
  assert.deepEqual(first.plan.conflicts, []);
  assert.equal(first.diff.removed.length, 1);
  assert.deepEqual(first.diff.removed[0], finishedByOwner);
  const removedMarker = await diffMarker(env, finishedByOwner.pos, 'magenta_stained_glass');
  record('m4-colored-diff', { removed: removedMarker });
  const second = await comparison(env, { regenerate: true });
  assert.notEqual(first.previewId, second.previewId);
  await confirmFromTest(env, first.previewId, 'preview_superseded');
  protocol(env, accept);
  const replay = await until(async () => (await readPlans(env.rcon)).protocolRejections?.findLast((event) =>
    event.action === 'accept' && event.planId === env.id && event.reason === 'replayed_or_inactive_grant'),
  'server refuses original live grant identity after pause', 5000);
  record('m4-original-grant-denied', replay);
  const expired = await env.rcon.command(`deskpet debug expire ${second.previewId}`);
  assert.match(expired, /deadline elapsed/);
  await confirmFromTest(env, second.previewId, 'preview_expired');
  await planWhere(env, (row) => row.status === 'paused' && row.plan.revision === env.plan.revision, 'neither attempt changes the plan');
  assert.equal((await readPlans(env.rcon)).recomparisons.length, 0);
  await cancel(env);
}

async function authorization(env) {
  await startPlan(env);
  await pause(env);
  env.intruder.chat('/deskpet plan');
  const denial = await until(() => env.intruderWire.commands.find((message) => /无权|主人|permission|authoriz/i.test(message)),
    'actual unauthorized client gets private command denial', 6000);
  assert.equal(env.intruder.currentWindow, null);
  await env.rcon.command(`execute as Intruder at @s run deskpet debug recompare ${env.id}`);
  const rejected = await until(async () => (await readPlans(env.rcon)).protocolRejections?.findLast((event) =>
    event.action === 'recompare' && event.planId === env.id && /owner|authoriz/i.test(event.reason)),
  'Intruder identity fails production recompare callback', 5000);
  assert.equal((await readPlans(env.rcon)).recomparisons.length, 0);
  record('m4-intruder-denied', { denial, rejected });
  await cancel(env);
}

const cases = { added, rebuild, settled: zeroRemaining, protected: protectedBlock, scope, stale, auth: authorization };

if (require.main === module) {
  const name = process.argv[2];
  assert.ok(cases[name], `Expected one real M4 recompare scenario: ${Object.keys(cases).join(', ')}`);
  runWorld(name, cases[name]).catch((failure) => {
    record('m4-error', { scenario: name, error: failure.stack });
    process.exitCode = 1;
  });
}

module.exports = { pause, cancel };
