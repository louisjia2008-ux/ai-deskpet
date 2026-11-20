'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, serverDir, CHANNEL, Vec3, record, until, serverSettings, createRcon,
  newBot, ready, closeBot, decodeMessage } = require('./common.cjs');
const { BUTTON, Y, coords, move, equip, setupArena, readPlans, openMenu, click,
  assertBlock } = require('./wand-session.cjs');

const ORIGIN = new Vec3(4, Y, 5);
const INSIDE = ORIGIN.offset(2, -1, 1);
const OUTSIDE = ORIGIN.offset(-8, -1, 0);

async function start(check, { arena = true } = {}) {
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, 'Owner');
  const ledgerDir = await fs.mkdtemp(path.join(serverDir, 'fix1-grants-'));
  const { installSurveyPlanReceiver } = runtimeRequire('./core/survey-plan-receiver');
  const events = [];
  const heldAcks = new Map();
  const heldAccepts = new Map();
  let holdRevokeAcks = false;
  let holdGrantAccepts = false;
  let send;
  let dispose;
  const robot = newBot(settings, 'DeskPetBot', {
    install(bot) {
      send = bot._client.write.bind(bot._client);
      bot._client.write = (name, packet) => {
        if ((holdRevokeAcks || holdGrantAccepts) && name === 'custom_payload' && packet.channel === CHANNEL) {
          const message = decodeMessage(packet.data);
          if (holdRevokeAcks && message.type === 'revoke_ack') {
            heldAcks.set(message.grantId, packet);
            record('production-ack-held', { grantId: message.grantId });
            return;
          }
          if (holdGrantAccepts && message.type === 'accept') {
            heldAccepts.set(message.grantId, packet);
            record('production-accept-held', { grantId: message.grantId });
            return;
          }
        }
        return send(name, packet);
      };
      dispose = installSurveyPlanReceiver(bot, {
        ledgerDir,
        onEvent(event) {
          events.push(event);
          record('receiver-event', { event });
        },
      });
    },
  });
  try {
    await Promise.all([ready(owner), ready(robot)]);
    await until(() => events.some((event) => event.type === 'hello'), 'production Core handshake');
    if (arena) await setupArena(rcon, [owner.bot, robot.bot]);
    await check({
      rcon,
      owner: owner.bot,
      robot: robot.bot,
      events,
      holdAcks: () => { holdRevokeAcks = true; },
      holdAccepts: () => { holdGrantAccepts = true; },
      releaseAck: (grantId) => {
        const packet = heldAcks.get(grantId);
        assert.ok(packet, 'Production Core must acknowledge the revocation');
        send('custom_payload', packet);
        record('production-ack-released', { grantId });
      },
      releaseAccept: (grantId) => {
        const packet = heldAccepts.get(grantId);
        assert.ok(packet, 'Production Core must send the acceptance');
        holdGrantAccepts = false;
        send('custom_payload', packet);
        record('production-accept-released', { grantId });
      },
    });
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(robot.errors, []);
  } finally {
    dispose?.();
    closeBot(robot);
    closeBot(owner);
    rcon.close();
  }
}

async function plan(rcon, id) {
  const entry = (await readPlans(rcon)).plans.find((candidate) => candidate.id === id);
  assert.ok(entry, `Missing server plan ${id}`);
  return entry;
}

async function waitPlan(rcon, id, status, timeout = 6_000) {
  return until(async () => {
    const entry = await plan(rcon, id);
    return entry.status === status && entry;
  }, `${id} status ${status}`, timeout, 150);
}

async function prepareSmall(rcon) {
  await rcon.command(`setblock ${coords(ORIGIN)} dirt`);
  await rcon.command(`setblock ${coords(ORIGIN.offset(1, 0, 0))} dirt`);
  await rcon.command(`setblock ${coords(ORIGIN.offset(2, 0, 0))} air`);
  await rcon.command(`setblock ${coords(INSIDE)} grass_block`);
  await rcon.command(`setblock ${coords(OUTSIDE)} grass_block`);
}

async function previewFixture(rcon, profile = 'small') {
  const response = await rcon.command(`execute as Owner at @s run deskpet debug fixture ${profile} ${coords(ORIGIN)}`);
  const id = response.match(/^fixture plan ([a-f0-9-]{36})$/)?.[1];
  assert.ok(id, response);
  assert.equal((await plan(rcon, id)).status, 'previewed');
  return id;
}

async function confirmFixture(rcon, id) {
  return rcon.command(`execute as Owner at @s run deskpet debug confirm ${id}`);
}

async function accepted(env, id, revision = 1) {
  const event = await until(() => env.events.find((entry) => entry.type === 'accepted'
    && entry.planId === id && entry.revision === revision), `production grant ${id} revision ${revision}`);
  const running = await waitPlan(env.rcon, id, 'running');
  assert.equal(running.grantId, event.grantId);
  return running;
}

async function manage(rcon, owner, button) {
  if (!owner.currentWindow) {
    await equip(rcon, owner);
    await openMenu(owner);
  }
  assert.ok([BUTTON.continue, BUTTON.cancel].includes(button));
  await click(owner, button);
}

async function dig(rcon, robot, pos, item = 'minecraft:diamond_shovel') {
  await move(rcon, robot, new Vec3(pos.x + 0.5, Y, pos.z + 2.5));
  await equip(rcon, robot, item);
  const block = await until(() => {
    const target = robot.blockAt(pos);
    return target && target.name !== 'air' && target;
  }, `dig fixture at ${coords(pos)}`);
  await robot.dig(block, true, pos.y < Y ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1)).catch((error) => {
    record('mineflayer-dig-response', { pos, error: error.message });
  });
  await delay(200);
}

async function fill(rcon, robot) {
  const pos = ORIGIN.offset(2, 0, 0);
  await move(rcon, robot, pos.offset(0.5, 0, 2.5));
  await equip(rcon, robot, 'minecraft:dirt');
  const support = await until(() => robot.blockAt(pos.offset(0, -1, 0)), 'fill support');
  await robot.placeBlock(support, new Vec3(0, 1, 0));
  await assertBlock(rcon, pos, 'minecraft:dirt');
}

module.exports = { ORIGIN, INSIDE, OUTSIDE, start, plan, waitPlan, prepareSmall, previewFixture,
  confirmFixture, accepted, manage, dig, fill };
