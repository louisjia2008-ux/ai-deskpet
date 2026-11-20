'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, serverDir, CHANNEL, Vec3, record, until, serverSettings, createRcon, newBot, ready,
  closeBot, decodeMessage } = require('./common.cjs');
const { BUTTON, Y, P, coords, move, equip, setupArena, snapshot, airClick, openMenu, click,
  stageSelection, readPlans, commandAssert } = require('./wand-session.cjs');

const INTRUDER = 'Intruder';
const NO_AUTH = new Vec3(-6, Y - 1, 4);
const BREAK = new Vec3(-4, Y - 1, 4);
const PLACE_AGAINST = new Vec3(-4, Y - 1, 7);
const PLACE = PLACE_AGAINST.offset(0, 1, 0);
const CANCEL_BREAK = new Vec3(-4, Y - 1, 10);
const CHANGED = new Vec3(0, Y, 0);
const ID = `m2_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

function offlineUUID(username) {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function writeConfig() {
  const marker = await fs.readFile(path.join(serverDir, '.deskpet-test-server'), 'utf8');
  assert.equal(marker.trim(), 'polymer', 'Prepare a dedicated Polymer test server before enabling the fixture');
  const dir = path.join(serverDir, 'config');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'deskpet-plan.json');
  const config = { enabled: true, ownerUuid: offlineUUID('Owner'), botName: 'DeskPetBot' };
  try {
    await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    const disabledExample = { enabled: false, ownerUuid: '', botUuid: '', botName: 'DeskPetBot' };
    if (JSON.stringify(previous) === JSON.stringify(disabledExample)) {
      await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
    } else {
      assert.deepEqual(previous, config, 'Use a dedicated server directory with a new config file for M2');
    }
  }
  record('m2-fixture-config', { config, file });
}

function currentPlan(data, id) { return data.plans.find((entry) => entry.id === id); }
async function planWhere(rcon, id, predicate, description, timeoutMs = 8_000) {
  return until(async () => {
    const entry = currentPlan(await readPlans(rcon), id);
    return entry && predicate(entry) && entry;
  }, description, timeoutMs, 250);
}

async function preview(rcon, bot, options) {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  await airClick(bot, true);
  await airClick(bot, true);
  const before = new Set((await readPlans(rcon)).plans.map((plan) => plan.id));
  await stageSelection(rcon, bot, options);
  await openMenu(bot);
  const plan = await until(async () => {
    const entries = (await readPlans(rcon)).plans;
    return entries.find((entry) => !before.has(entry.id) && entry.status === 'previewed'
      && entry.plan?.ownerUuid === offlineUUID(bot.username));
  }, `persisted preview from ${bot.username}`);
  record('plan-previewed', { id: plan.id, selection: plan.plan.selection, planHash: plan.plan.planHash });
  return plan;
}

async function expectDenial(rcon, id, expectedReason, description) {
  const plan = await planWhere(rcon, id, (entry) => entry.lastDenial === expectedReason, description);
  assert.ok(['previewed', 'expired'].includes(plan.status), `Forbidden transition to ${plan.status}`);
  record('confirmation-denied', { id, description, status: plan.status, reason: plan.lastDenial });
}

function protocolCount(data) {
  return typeof data.protocolRejections === 'number' ? data.protocolRejections : data.protocolRejections?.length ?? 0;
}

async function expectProtocolRejection(rcon, previousCount, description) {
  const after = await until(async () => {
    const data = await readPlans(rcon);
    return protocolCount(data) > previousCount && data.protocolRejections;
  }, description);
  record('protocol-rejected', { description, evidence: after });
}

function attemptDig(bot, block) {
  assert.ok(block?.name === 'grass_block', `Expected exposed grass test block, got ${block?.name}`);
  return bot.dig(block, true, new Vec3(0, 1, 0)).catch((error) => {
    record('client-dig-result', { pos: block.position, error: error.message });
  });
}

function attemptPlace(bot, block) {
  assert.ok(block?.name === 'grass_block', `Expected exposed ground to place against, got ${block?.name}`);
  return bot.placeBlock(block, new Vec3(0, 1, 0)).catch((error) => {
    record('client-place-result', { pos: block.position.offset(0, 1, 0), error: error.message });
  });
}

function atPosition(entry, position) {
  const pos = entry.pos;
  return pos?.x === position.x && pos?.y === position.y && pos?.z === position.z;
}

async function newRejections(rcon, count, expected) {
  let entries;
  await until(async () => {
    entries = (await readPlans(rcon)).rejections.slice(count);
    return entries.length >= expected.length;
  }, 'server rejection audit log');
  assert.equal(entries.length, expected.length, `Unexpected rejection records: ${JSON.stringify(entries)}`);
  for (const [action, pos] of expected) {
    assert.ok(entries.some((entry) => entry.action === action && atPosition(entry, pos)),
      `Missing ${action} denial at ${coords(pos)}`);
  }
  record('server-block-rejections', { entries });
}

async function suite({ preparingRestart = false } = {}) {
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, 'Owner');
  const intruder = newBot(settings, INTRUDER);
  const { installSurveyPlanReceiver, sendPlanMessage } = runtimeRequire('./core/survey-plan-receiver');
  const ledgerDir = await fs.mkdtemp(path.join(serverDir, 'm2-grants-'));
  const events = [];
  const fragmentLengths = [];
  let robot;
  let stopReceiver;
  function connectRobot() {
    return newBot(settings, 'DeskPetBot', {
      install(bot) {
        stopReceiver = installSurveyPlanReceiver(bot, {
          ledgerDir,
          onEvent(event) {
            events.push(event);
            record('receiver-event', { event });
          },
        });
        bot._client.on(CHANNEL, (bytes) => {
          const packet = decodeMessage(bytes);
          if (packet.type === 'grant_chunk') {
            fragmentLengths.push(bytes.length);
            record('grant-fragment', { grantId: packet.grantId, index: packet.index, count: packet.count,
              bytes: bytes.length });
          }
        });
      },
    });
  }

  async function reopenPlanMenu() {
    if (owner.bot.currentWindow) owner.bot.closeWindow(owner.bot.currentWindow);
    // The most recent geometric selection could be an overlapping draft. Clear
    // its two corners so right-clicking air opens the separately persisted active plan.
    await airClick(owner.bot, true);
    await airClick(owner.bot, true);
    await openMenu(owner.bot);
  }

  async function accepted(id, revision) {
    const event = await until(() => events.find((entry) => entry.type === 'accepted'
      && entry.planId === id && (revision === undefined || entry.revision === revision)), 'dry-run receiver accepted grant');
    await planWhere(rcon, id, (entry) => entry.status === 'running' && entry.grantId === event.grantId,
      'server accepted exact grant and entered running');
    const { planId, revision: actualRevision, planHash, grantId } = event;
    return { planId, revision: actualRevision, planHash, grantId };
  }

  try {
    robot = connectRobot();
    await Promise.all([ready(owner), ready(intruder), ready(robot)]);
    await until(() => events.some((event) => event.type === 'hello'), 'production plan receiver hello');
    await setupArena(rcon, [owner.bot, robot.bot, intruder.bot]);

    if (preparingRestart) {
      const planned = await preview(rcon, owner.bot);
      await click(owner.bot, BUTTON.confirm);
      const activeGrant = await accepted(planned.id);
      const recordPath = path.join(serverDir, 'm2-before-restart.json');
      await fs.writeFile(recordPath, JSON.stringify(activeGrant, null, 2) + '\n', { mode: 0o600 });
      const saved = await rcon.command('save-all flush');
      assert.match(saved, /Saved the game/);
      record('restart-running-saved', { id: planned.id, recordPath, activeGrant });
      // Keep the receiver connected until the explicit server shutdown.
      // RCON may close before transmitting the stop response.
      await rcon.command('stop').catch((error) => {
        if (!/RCON connection closed/.test(error.message)) throw error;
      });
      await until(() => robot.errors.some((event) => ['kicked', 'end'].includes(event.event)),
        'isolated Fabric stopped while the granted robot was connected', 30_000);
      return;
    }
    await equip(rcon, robot.bot, 'minecraft:diamond_shovel');
    await move(rcon, robot.bot, NO_AUTH.offset(0.5, 1, 2.5));
    const ordinaryBefore = await snapshot(rcon, `${ID}_ungranted_before`, NO_AUTH, NO_AUTH);
    await attemptDig(robot.bot, robot.bot.blockAt(NO_AUTH));
    await delay(250);
    const ordinaryAfter = await snapshot(rcon, `${ID}_ungranted_after`, NO_AUTH, NO_AUTH);
    assert.notEqual(ordinaryAfter, ordinaryBefore, 'Unassigned robot must be able to do normal work');
    await rcon.command(`setblock ${coords(NO_AUTH)} grass_block`);

    // Both GUI and backend must reject an unauthorized player. Creating a preview grants nothing.
    const unauthorized = await preview(rcon, intruder.bot);
    await click(intruder.bot, BUTTON.confirm);
    const outsiderState = currentPlan(await readPlans(rcon), unauthorized.id);
    if (!outsiderState.lastDenial) {
      await rcon.command(`execute as ${INTRUDER} at @s run deskpet debug confirm ${unauthorized.id}`);
    }
    await expectDenial(rcon, unauthorized.id, 'wrong_owner', 'Intruder confirmation');
    assert.equal(events.filter((event) => event.type === 'accepted').length, 0);
    if (intruder.bot.currentWindow) intruder.bot.closeWindow(intruder.bot.currentWindow);

    const crossDimension = await preview(rcon, owner.bot);
    owner.bot.closeWindow(owner.bot.currentWindow);
    commandAssert(await rcon.command('execute in minecraft:the_nether run tp Owner 0.5 128 0.5'),
      'Move Owner into Nether');
    await until(() => owner.bot.game?.dimension?.endsWith('the_nether'), 'Owner entered Nether');
    await rcon.command(`execute as Owner at @s run deskpet debug confirm ${crossDimension.id}`);
    await expectDenial(rcon, crossDimension.id, 'wrong_dimension', 'Overworld plan confirmed in Nether');
    commandAssert(await rcon.command(`execute in minecraft:overworld run tp Owner 2.5 ${Y} 2.5`),
      'Move Owner back into Overworld');
    await until(() => owner.bot.game?.dimension?.endsWith('overworld'), 'Owner returned to Overworld');

    const stale = await preview(rcon, owner.bot);
    await rcon.command(`deskpet debug expire ${stale.id}`);
    await rcon.command(`execute as Owner at @s run deskpet debug confirm ${stale.id}`);
    await planWhere(rcon, stale.id, (entry) => entry.status === 'expired', 'preview expires and cannot authorize');
    record('expired-plan-denied', { id: stale.id });

    const changed = await preview(rcon, owner.bot);
    await rcon.command(`setblock ${coords(CHANGED)} oak_planks`);
    await click(owner.bot, BUTTON.confirm);
    await expectDenial(rcon, changed.id, 'snapshot_changed', 'Changed block since preview');
    await rcon.command(`setblock ${coords(CHANGED)} air`);

    const active = await preview(rcon, owner.bot, { supply: true });
    const activeBefore = await snapshot(rcon, `${ID}_grant_before`);
    await click(owner.bot, BUTTON.confirm);
    const firstGrant = await accepted(active.id);
    assert.ok(fragmentLengths.length > 0 && fragmentLengths.every((length) => length <= 32 * 1024));
    const beforeDuplicate = protocolCount(await readPlans(rcon));
    sendPlanMessage(robot.bot._client, { type: 'accept', ...firstGrant });
    await expectProtocolRejection(rcon, beforeDuplicate, 'Second accept for same grantId');
    assert.equal(currentPlan(await readPlans(rcon), active.id).status, 'running');

    // The second plan comes from the same actual configured Owner; failure must be the overlap check.
    const overlap = await preview(rcon, owner.bot, { first: P.first.offset(1, 0, 1), second: P.second });
    await click(owner.bot, BUTTON.confirm);
    await expectDenial(rcon, overlap.id, 'overlapping_plan', 'Overlapping plan confirmation');

    await move(rcon, robot.bot, BREAK.offset(0.5, 1, 2.5));
    const originals = (await readPlans(rcon)).rejections.length;
    await attemptDig(robot.bot, robot.bot.blockAt(BREAK));
    await move(rcon, robot.bot, PLACE_AGAINST.offset(0.5, 1, 2.5));
    await equip(rcon, robot.bot, 'minecraft:cobblestone');
    await attemptPlace(robot.bot, robot.bot.blockAt(PLACE_AGAINST));
    await newRejections(rcon, originals, [['break', BREAK], ['place', PLACE]]);
    assert.equal(await snapshot(rcon, `${ID}_grant_after`), activeBefore);

    // A disconnected receiver cannot continue the previous session by sending the old identity.
    closeBot(robot);
    await planWhere(rcon, active.id, (entry) => entry.status === 'paused', 'paused after robot disconnected');
    robot = connectRobot();
    await ready(robot);
    await until(() => events.filter((event) => event.type === 'hello').length >= 2, 'receiver handshakes again');
    const beforeReconnectReplay = protocolCount(await readPlans(rcon));
    sendPlanMessage(robot.bot._client, { type: 'accept', ...firstGrant });
    await expectProtocolRejection(rcon, beforeReconnectReplay, 'Old grant replay after reconnect');
    const orphaned = currentPlan(await readPlans(rcon), active.id);
    assert.equal(orphaned.status, 'paused');
    assert.equal(events.filter((event) => event.type === 'accepted').length, 1);

    await reopenPlanMenu();
    await click(owner.bot, BUTTON.continue);
    const resumed = await accepted(active.id, firstGrant.revision + 1);
    assert.notEqual(resumed.grantId, firstGrant.grantId);
    // Remain connected, but stop the receiver. The server must reclaim the grant on heartbeat timeout.
    stopReceiver();
    const timedOut = await planWhere(rcon, active.id, (entry) => entry.status === 'paused',
      'server withdrew authorization after missing heartbeat', 13_000);
    assert.equal(timedOut.reason, 'disconnected');
    record('heartbeat-timeout', { id: active.id, reason: timedOut.reason });
    // A new connection obtains the world ID from the server before continuing.
    closeBot(robot);
    await delay(250);
    robot = connectRobot();
    await ready(robot);
    await until(() => events.filter((event) => event.type === 'hello').length >= 3, 'receiver restored after heartbeat test');
    await reopenPlanMenu();
    await click(owner.bot, BUTTON.continue);
    await accepted(active.id, resumed.revision + 1);

    await equip(rcon, robot.bot, 'minecraft:diamond_shovel');
    await move(rcon, robot.bot, CANCEL_BREAK.offset(0.5, 1, 2.5));
    const cancelledSnapshot = await snapshot(rcon, `${ID}_cancel_before`);
    const beforeCancelCount = (await readPlans(rcon)).rejections.length;
    await reopenPlanMenu();
    const pressed = performance.now();
    await click(owner.bot, BUTTON.cancel);
    const worldPos = robot.bot.blockAt(CANCEL_BREAK);
    const attemptStarted = performance.now() - pressed;
    assert.ok(attemptStarted <= 1000, `Cancel block attempt reached harness after ${attemptStarted}ms`);
    await attemptDig(robot.bot, worldPos);
    await planWhere(rcon, active.id, (entry) => entry.status === 'cancelled', 'Owner cancelled active plan');
    await newRejections(rcon, beforeCancelCount, [['break', CANCEL_BREAK]]);
    assert.equal(await snapshot(rcon, `${ID}_cancel_after`), cancelledSnapshot);
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(intruder.errors, []);
    assert.deepEqual(robot.errors, []);
    record('m2-pass', { id: active.id, firstGrant, resumed, attemptStarted, fragmentLengths });
  } finally {
    stopReceiver?.();
    closeBot(robot);
    closeBot(intruder);
    closeBot(owner);
    rcon.close();
  }
}

async function verifyRestart() {
  const previous = JSON.parse(await fs.readFile(path.join(serverDir, 'm2-before-restart.json'), 'utf8'));
  const rcon = await createRcon(await serverSettings());
  try {
    const entry = currentPlan(await readPlans(rcon), previous.planId);
    assert.ok(entry, 'Running plan was lost from the world save');
    assert.equal(entry.status, 'paused');
    assert.equal(entry.reason, 'server_restart');
    assert.equal(entry.grantId ?? null, null, 'A restart must revoke the previous authorization');
    assert.equal(entry.plan.revision, previous.revision);
    assert.equal(entry.plan.planHash, previous.planHash);
    record('m2-restart-pass', { id: previous.planId, status: entry.status, reason: entry.reason,
      revision: previous.revision, planHash: previous.planHash });
  } finally { rcon.close(); }
}

const action = process.argv[2] ?? 'verify';
Promise.resolve().then(() => {
  if (action === 'configure') return writeConfig();
  if (action === 'restart-prepare') return suite({ preparingRestart: true });
  if (action === 'restart-verify') return verifyRestart();
  assert.equal(action, 'verify', 'Use configure, verify, restart-prepare, or restart-verify');
  return suite();
}).catch((error) => {
  record('m2-failed', { error: error.stack });
  process.exitCode = 1;
});
