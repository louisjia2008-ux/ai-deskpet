'use strict';

// Isolate Mod packet handling and vanilla transactions from the Core executor.
// The end-to-end wand and Core runs are covered by m3.cjs.
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { CHANNEL, Vec3, record, until, serverSettings, createRcon, newBot, ready, closeBot, decodeMessage,
  sendMessage } = require('./common.cjs');
const { coords, move, equip, setupArena, snapshot, assertBlock, readPlans } = require('./wand-session.cjs');
const { ORIGIN, plan, waitPlan, prepareSmall, previewFixture, confirmFixture } = require('./fix1-session.cjs');

const FARM = ORIGIN.offset(0, -1, 0);
const DOOR = ORIGIN.offset(3, 0, 0);
const WATER = ORIGIN.offset(8, 0, 0);
const UP = new Vec3(0, 1, 0);
const position = ({ x, y, z }) => ({ x, y, z });

async function prepareExecution(rcon) {
  await rcon.command(`setblock ${coords(FARM)} dirt`);
  await rcon.command(`setblock ${coords(ORIGIN)} air`);
  await rcon.command(`setblock ${coords(DOOR.offset(0, -1, 0))} dirt`);
  await rcon.command(`setblock ${coords(DOOR)} air`);
  await rcon.command(`setblock ${coords(DOOR.offset(0, 1, 0))} air`);
  for (const [x, y, z] of [[0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]) {
    await rcon.command(`setblock ${coords(WATER.offset(x, y, z))} stone`);
  }
  await rcon.command(`setblock ${coords(WATER)} air`);
}

async function useBlock(rcon, bot, item, support, approach) {
  await move(rcon, bot, approach);
  await equip(rcon, bot, `minecraft:${item}`);
  await bot.activateBlock(bot.blockAt(support), UP, new Vec3(0.5, 1, 0.5));
  bot._client.write('tick_end', {});
}

async function execute(rcon, connection, messages) {
  const bot = connection.bot;
  const client = bot._client;
  const send = (message) => sendMessage(client, message);
  await prepareExecution(rcon);
  const id = await previewFixture(rcon, 'execution');
  await confirmFixture(rcon, id);
  const grant = await waitPlan(rcon, id, 'confirmed');
  const identity = { planId: id, grantId: grant.grantId, planHash: grant.plan.planHash, revision: grant.plan.revision };
  const local = (message) => send({ ...identity, ...message });
  const receive = (type, condition = () => true) => until(() => messages.find((message) => message.type === type
    && message.grantId === grant.grantId && condition(message)), `${id} ${type}`);
  const receivedAt = (pos) => receive('applied', ({ positions }) => positions.some(({ x, y, z }) => pos.equals(new Vec3(x, y, z))));
  const keepAlive = setInterval(() => local({ type: 'heartbeat' }), 2_000);
  try {
    local({ type: 'accept', execute: true });
    await receive('running');
    local({ type: 'progress', completed: 0, settled: true });
    local({ type: 'state', phase: 'structure', waiting: 'materials', missing: { 'minecraft:oak_door': 1 } });
    const waiting = await until(async () => {
      const row = await plan(rcon, id);
      return row.waiting === 'materials' && row;
    }, 'Mod reports materials wait');
    assert.deepEqual(waiting.missing, { 'minecraft:oak_door': 1 });
    assert.equal(waiting.status, 'running');
    local({ type: 'state', phase: 'structure', waiting: 'night' });
    await until(async () => (await plan(rcon, id)).waiting === 'night', 'Mod reports night work stoppage');
    local({ type: 'state', phase: 'structure', waiting: null });
    await until(async () => (await plan(rcon, id)).waiting === null, 'Mod clears wait');

    await useBlock(rcon, bot, 'iron_hoe', FARM, ORIGIN.offset(0.5, 0, 2.5));
    await receivedAt(FARM);
    await assertBlock(rcon, FARM, 'minecraft:farmland[moisture=0]');
    await useBlock(rcon, bot, 'wheat_seeds', FARM, ORIGIN.offset(0.5, 0, 2.5));
    await receivedAt(ORIGIN);
    await assertBlock(rcon, ORIGIN, 'minecraft:wheat[age=0]');

    const before = await snapshot(rcon, 'm3_wire_door_before', DOOR, DOOR.offset(0, 1, 0));
    await useBlock(rcon, bot, 'oak_door', DOOR.offset(0, -1, 0), DOOR.offset(2.5, 0, 0.5));
    const rejected = await receive('misplacement');
    assert.equal(rejected.misplacements, 1);
    assert.deepEqual(rejected.pos, position(DOOR));
    assert.match(rejected.expected, /facing=north/);
    assert.match(rejected.actual, /facing=west/);
    assert.match(await rcon.command('data get entity DeskPetBot SelectedItem'), /oak_door/);
    assert.equal(await snapshot(rcon, 'm3_wire_door_rejected', DOOR, DOOR.offset(0, 1, 0)), before);
    const afterReject = await plan(rcon, id);
    assert.equal(afterReject.status, 'running');
    assert.equal(afterReject.violations, 0);
    assert.equal(afterReject.completed, 2);
    record('m3-wire-misplacement-atomic', { rejected, snapshot: before, violations: afterReject.violations });

    await useBlock(rcon, bot, 'oak_door', DOOR.offset(0, -1, 0), DOOR.offset(0.5, 0, 2.5));
    const doorApplied = await receive('applied', ({ positions }) => positions.length === 2);
    assert.deepEqual(doorApplied.positions, [position(DOOR), position(DOOR.offset(0, 1, 0))]);
    for (const [dy, half] of [[0, 'lower'], [1, 'upper']]) {
      await assertBlock(rcon, DOOR.offset(0, dy, 0), `minecraft:oak_door[facing=north,half=${half},hinge=left,open=false,powered=false]`);
    }
    await move(rcon, bot, WATER.offset(1.4, 1, 0.5));
    await equip(rcon, bot, 'minecraft:water_bucket');
    await bot.lookAt(WATER.offset(0.5, -0.05, 0.5), true);
    bot.activateItem();
    bot._client.write('tick_end', {});
    await receivedAt(WATER);
    await assertBlock(rcon, WATER, 'minecraft:water[level=0]');
    assert.match(await rcon.command('data get entity DeskPetBot SelectedItem'), /minecraft:bucket/);
    const beforeSettlement = await plan(rcon, id);
    assert.equal(beforeSettlement.status, 'running');
    assert.equal(beforeSettlement.completed, 5);
    assert.equal(beforeSettlement.total, 5);
    local({ type: 'progress', completed: 5, settled: true });
    const terminal = await receive('revoke');
    assert.equal(terminal.status, 'completed');
    const finished = await waitPlan(rcon, id, 'completed');
    assert.equal(finished.misplacements, 1);
    assert.equal(finished.violations, 0);
    assert.equal(finished.lateAttempts, 0);
    record('m3-wire-settlement-completed', { terminal, completed: finished.completed, misplacements: finished.misplacements });
    send({ type: 'revoke_ack', grantId: grant.grantId });
  } finally {
    clearInterval(keepAlive);
  }
}

async function interrupt(rcon, bot, messages, cause) {
  await prepareSmall(rcon);
  const id = await previewFixture(rcon);
  await confirmFixture(rcon, id);
  const grant = await waitPlan(rcon, id, 'confirmed');
  const identity = { planId: id, grantId: grant.grantId, planHash: grant.plan.planHash, revision: grant.plan.revision };
  const send = (message) => sendMessage(bot._client, { ...identity, ...message });
  send({ type: 'accept', execute: true });
  await until(() => messages.some((message) => message.type === 'running' && message.grantId === grant.grantId), 'running');
  if (cause === 'blocked') {
    const blocked = { reason: 'no_reachable_stand', pos: position(ORIGIN), detail: 'fixture obstacle' };
    send({ type: 'blocked', ...blocked });
    const paused = await waitPlan(rcon, id, 'paused');
    assert.deepEqual(paused.blocked, blocked);
    assert.equal(paused.reason, blocked.reason);
    assert.equal(paused.violations, 0);
    await rcon.command(`execute as Owner at @s run deskpet debug cancel ${id}`);
  } else {
    const support = ORIGIN.offset(2, -1, 0);
    const target = support.offset(0, 1, 0);
    await rcon.command(`setblock ${coords(support)} stone`);
    await useBlock(rcon, bot, 'cobblestone', support, target.offset(0.5, 0, 2.5));
    const failed = await waitPlan(rcon, id, 'failed');
    assert.equal(failed.violations, 1);
    assert.equal(failed.misplacements, 0);
    assert.equal(failed.completed, 0);
    await assertBlock(rcon, target, 'minecraft:air');
    const last = (await readPlans(rcon)).rejections.at(-1);
    assert.deepEqual(last.pos, position(target));
    assert.equal(last.category, 'violation');
  }
  const terminal = await until(() => messages.find((message) => message.type === 'revoke'
    && message.grantId === grant.grantId), `${cause} revocation`);
  assert.equal(terminal.status, cause === 'blocked' ? 'paused' : 'failed');
  send({ type: 'revoke_ack' });
  record('m3-wire-interruption', { cause, terminal });
}

async function main() {
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, 'Owner');
  const messages = [];
  const robot = newBot(settings, 'DeskPetBot', {
    install(bot) {
      bot._client.on('custom_payload', ({ channel, data }) => {
        if (channel !== CHANNEL) return;
        const message = decodeMessage(data);
        messages.push(message);
        if (message.type === 'hello') {
          sendMessage(bot._client, { type: 'hello_ack', protocol: message.protocol, worldId: message.worldId });
        }
      });
    },
  });
  try {
    await Promise.all([ready(owner), ready(robot)]);
    await until(() => messages.some((message) => message.type === 'hello_ok'), 'verified test receiver handshake');
    await setupArena(rcon, [owner.bot, robot.bot]);
    await rcon.command('gamemode survival DeskPetBot');
    await execute(rcon, robot, messages);
    await delay(250);
    await interrupt(rcon, robot.bot, messages, 'blocked');
    await delay(250);
    await interrupt(rcon, robot.bot, messages, 'violation');
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(robot.errors, []);
  } finally {
    closeBot(robot);
    closeBot(owner);
    rcon.close();
  }
}

main().catch((error) => {
  record('m3-wire-failed', { error: error.stack });
  process.exitCode = 1;
});
