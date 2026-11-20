'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, serverDir, VERSION, CHANNEL, Vec3, record, until, serverSettings, createRcon,
  decodeMessage, sendMessage, newBot, ready, closeBot, stabilize } = require('./common.cjs');

const ITEM = 'deskpet:survey_wand';
const WAND_NAME = /Survey Wand|标注法杖/;
const ARENA_Y = 113;
const CORE_DURATION_MS = 600_000;
const OWNER_WAYPOINTS = [13.5, 3.5, -6.5, 3.5];

function itemEvidence(item) {
  return item && { id: item.type, count: item.count, name: item.name, customName: item.customName,
    model: item.componentMap?.get('item_model')?.data ?? item.componentMap?.get('custom_model_data')?.data };
}

function isMappedWand(item) {
  const info = itemEvidence(item);
  return info && info.name !== 'unknown' && WAND_NAME.test(JSON.stringify(info.customName))
    && info.model !== undefined;
}

function requireSane(response, description) {
  assert.ok(response && !/Unknown|Failed|Unable|No player|No entity|not loaded|Invalid/i.test(response),
    `${description}: ${response}`);
}

async function placeFixture(rcon, withChest) {
  await stabilize(rcon);
  for (const [name, dest] of [['Owner', '0.5'], ['DeskPetBot', '3.5']]) {
    await rcon.command(`gamemode survival ${name}`);
    requireSane(await rcon.command(`tp ${name} ${dest} ${ARENA_Y} 0.5`), 'Load arena');
    await rcon.command(`clear ${name}`);
  }
  const floor = await rcon.command(`fill -10 ${ARENA_Y - 1} -6 18 ${ARENA_Y - 1} 6 stone`);
  assert.match(floor, /Successfully filled|No blocks were filled/, 'Build arena floor');
  await rcon.command(`fill -10 ${ARENA_Y} -6 18 ${ARENA_Y + 4} 6 air`);
  if (withChest) {
    requireSane(await rcon.command(`setblock 2 ${ARENA_Y} 2 chest`), 'Place compatibility chest');
    requireSane(await rcon.command(`item replace block 2 ${ARENA_Y} 2 container.0 with ${ITEM}`), 'Stock compatibility chest');
  }
  requireSane(await rcon.command(`tp Owner 0.5 ${ARENA_Y} 0.5`), 'Place Owner');
  requireSane(await rcon.command(`tp DeskPetBot 3.5 ${ARENA_Y} 0.5`), 'Place DeskPetBot');
}

async function openWandChest(bot) {
  const chest = await until(() => {
    const block = bot.blockAt(new Vec3(2, ARENA_Y, 2));
    return block?.name === 'chest' && block;
  }, 'chest block on DeskPetBot');
  const window = await Promise.race([
    bot.openContainer(chest),
    delay(10_000, null, { ref: false }).then(() => { throw new Error('Compatibility chest did not open'); }),
  ]);
  try { return window.containerItems()[0]; } finally { window.close(); }
}

async function compatibility(rcon, settings, control) {
  let owner;
  let robot;
  const helloMessages = [];
  const helloReplies = [];
  const equipPackets = [];
  try {
    owner = newBot(settings, 'Owner');
    robot = newBot(settings, 'DeskPetBot', {
      install(bot) {
        bot._client.registerChannel(CHANNEL, null);
        bot._client.on(CHANNEL, (bytes) => {
          try {
            const message = decodeMessage(bytes);
            record('received-plan-message', { message });
            if (message.type === 'hello') {
              helloMessages.push(message);
              assert.equal(message.protocol, 1);
              assert.match(message.worldId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
              assert.match(message.modVersion, /^\d+\.\d+\.\d+/);
              bot._client.writeChannel('minecraft:register', [CHANNEL]);
              sendMessage(bot._client, { type: 'hello_ack', protocol: 1, worldId: message.worldId });
            } else {
              helloReplies.push(message);
            }
          } catch (error) { bot.emit('error', error); }
        });
        bot._client.on('entity_equipment', (packet) => equipPackets.push(packet));
      },
    });
    await Promise.all([ready(owner), ready(robot)]);
    record('joined', { players: ['Owner', 'DeskPetBot'], version: VERSION, control });
    if (!control) {
      const hello = await until(() => helloMessages[0], 'server hello');
      record('hello-ack-sent', { worldId: hello.worldId, protocol: hello.protocol, modVersion: hello.modVersion });
      const confirmed = await until(() => helloReplies.find((message) => message.type === 'hello_ok'),
        'server confirmation of hello_ack');
      assert.equal(confirmed.worldId, hello.worldId);
      assert.equal(confirmed.protocol, hello.protocol);
      record('hello-roundtrip', { worldId: hello.worldId });
    }
    await placeFixture(rcon, true);
    const bot = robot.bot;
    const ownerEntity = await until(() => bot.players.Owner?.entity, 'Owner entity on DeskPetBot');
    const equipIndex = equipPackets.length;
    requireSane(await rcon.command(`item replace entity Owner weapon.mainhand with ${ITEM}`), 'Equip wand');
    const frame = await until(() => equipPackets.slice(equipIndex).find((packet) => packet.entityId === ownerEntity.id)
      || (control && robot.errors[0]), 'equipment update or control connection failure');
    const equipped = itemEvidence(bot.players.Owner?.entity?.heldItem);
    record('equipment', { item: equipped, packet: frame });
    if (!control) {
      assert.ok(isMappedWand(bot.players.Owner.entity.heldItem), 'Owner equipment did not carry a vanilla item with wand name and model');
      assert.deepEqual(robot.errors, []);
    }
    if (!robot.errors.length) {
      await rcon.command('kill @e[type=item,tag=deskpet_wand_fixture]');
      // The server creates the real item, then Mineflayer picks it up on the normal player path.
      const response = await rcon.command(`summon minecraft:item -2.5 ${ARENA_Y} 0.5 {Item:{id:"${ITEM}",count:1},Tags:["deskpet_wand_fixture"]}`);
      requireSane(response, 'Spawn dropped wand');
      const dropped = await until(() => Object.values(bot.entities).find((entity) => entity.name === 'item'
        && entity.position.distanceTo(new Vec3(-2.5, ARENA_Y, 0.5)) < 1 && entity.getDroppedItem?.()),
      'tracked dropped-item metadata');
      const droppedItem = dropped.getDroppedItem();
      record('ground-item', { item: itemEvidence(droppedItem) });
      if (!control) assert.ok(isMappedWand(droppedItem));
      const pickups = [];
      bot.on('playerCollect', (collector, collected) => pickups.push({ collector: collector.id, collected: collected.id }));
      const droppedId = dropped.id;
      requireSane(await rcon.command(`tp DeskPetBot -2.5 ${ARENA_Y} 0.5`), 'Move DeskPetBot to dropped wand');
      await until(() => pickups.some((pickup) => pickup.collector === bot.entity.id && pickup.collected === droppedId)
        || (control && robot.errors[0]), 'DeskPetBot pickup packet');
      const pickedUp = await until(() => bot.inventory.items().find((item) => control || isMappedWand(item))
        || (control && robot.errors[0]), 'wand in DeskPetBot inventory');
      const inventoryEvidence = await rcon.command('data get entity DeskPetBot Inventory');
      assert.match(inventoryEvidence, /deskpet:survey_wand/, 'Server must record the actual picked-up wand');
      record('pickup', { item: itemEvidence(pickedUp), pickupEvents: pickups, serverInventory: inventoryEvidence });
      requireSane(await rcon.command(`tp DeskPetBot 3.5 ${ARENA_Y} 0.5`), 'Move DeskPetBot to chest');
      const chestItem = await openWandChest(bot);
      record('chest', { item: itemEvidence(chestItem) });
      if (!control) assert.ok(isMappedWand(chestItem), 'Vanilla chest contents did not expose mapped wand');
      if (control) {
        assert.ok(!isMappedWand(chestItem) || robot.errors.length > 0,
          'Control unexpectedly provided a correctly mapped wand');
        record('control-outcome', { equipment: equipped, dropped: itemEvidence(droppedItem),
          inventory: itemEvidence(pickedUp), chest: itemEvidence(chestItem), connectionEvents: robot.errors });
      }
    } else if (control) {
      record('control-outcome', { equipment: equipped, connectionEvents: robot.errors });
    }
    if (!control) {
      assert.deepEqual(owner.errors, []);
      assert.deepEqual(robot.errors, []);
    }
  } catch (error) {
    const registryKick = robot?.errors.find((event) => event.event === 'kicked'
      && /Fabric Loader and Fabric API/.test(JSON.stringify(event.message))
      && /"deskpet"/.test(JSON.stringify(event.message)));
    if (!control || !registryKick) throw error;
    record('control-outcome', { phase: 'registry handshake before spawn', connectionEvents: robot.errors });
  } finally {
    closeBot(robot);
    closeBot(owner);
  }
}

async function coreRun(rcon, settings) {
  const { createCoreHost } = runtimeRequire('./core-host');
  const owner = newBot(settings, 'Owner');
  const connectionErrors = [];
  let host;
  try {
    await ready(owner);
    const dataDir = await fs.mkdtemp(path.join(serverDir, 'core-follow-'));
    host = createCoreHost({
      dataDir,
      emit(message) {
        if (message.type !== 'event') return;
        const event = message.event;
        if (event.type === 'connection' && event.state === 'error') connectionErrors.push(event);
        if (event.type !== 'core' || ['goal_set', 'goal_done', 'goal_failed', 'following_owner'].includes(event.payload?.type)) {
          record('core-event', { event });
        }
      },
    });
    async function coreRequest(type, fields) {
      const response = await host.handle({ version: 1, id: randomUUID(), type, ...fields });
      assert.ok(response.ok, JSON.stringify(response.error));
      return response.result;
    }
    await coreRequest('connect', {
      config: { host: settings.host, port: settings.port, auth: 'offline', version: VERSION, username: 'DeskPetBot', ownerName: 'Owner' },
    });
    await until(() => {
      assert.deepEqual(connectionErrors, []);
      return host.status().connection.state === 'ready';
    }, 'Core ready', 60_000);
    await placeFixture(rcon, false);

    const result = await coreRequest('tool', { name: 'followOwner', arguments: { stay: true } });
    const taskId = result.task.taskId;
    await until(() => host.status().task?.status === 'running', 'real followOwner goal running');
    const started = performance.now();
    let lastWaypoint = 0;
    let trips = 0;
    while (performance.now() - started < CORE_DURATION_MS) {
      const seconds = Math.floor((performance.now() - started) / 1000);
      const waypointIndex = Math.floor(seconds / 30);
      assert.deepEqual(connectionErrors, [], 'Core reported connection errors');
      assert.deepEqual(owner.errors, [], 'Owner lost connection');
      const status = host.status();
      assert.equal(status.connection.state, 'ready');
      assert.equal(status.task?.taskId, taskId);
      assert.equal(status.task?.status, 'running');
      if (waypointIndex >= lastWaypoint) {
        const x = OWNER_WAYPOINTS[waypointIndex % OWNER_WAYPOINTS.length];
        await rcon.command(`tp Owner ${x} ${ARENA_Y} 0.5`);
        const botPos = await until(async () => {
          assert.equal(host.status().task?.status, 'running');
          const observation = host.status().observation;
          if (observation && Math.abs(observation.position.x - x) <= 4) {
            const confirmed = await rcon.command('execute at Owner if entity @a[name=DeskPetBot,distance=..4] run data get entity DeskPetBot Pos');
            return confirmed.includes('following entity data') && confirmed;
          }
          return false;
        }, 'Core physically following Owner on server', 24_000);
        trips++;
        record('core-following', { seconds, taskId, trips, ownerX: x, botPos });
        lastWaypoint = waypointIndex + 1;
      }
      await delay(1000);
    }
    assert.ok(trips >= 19, `Expected distinct timed movement legs, got ${trips}`);
    assert.deepEqual(connectionErrors, []);
    record('core-duration-pass', { taskId, trips, elapsedSeconds: (performance.now() - started) / 1000 });
    const cancelled = await coreRequest('tool', { name: 'cancel', arguments: { taskId } });
    assert.equal(cancelled.task.status, 'cancelled');
  } finally {
    await host?.close();
    closeBot(owner);
  }
}

async function main() {
  const mode = process.argv[2] || 'compat';
  assert.ok(['compat', 'control', 'core'].includes(mode), 'Use compat, control, or core');
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  try {
    if (mode === 'core') {
      await coreRun(rcon, settings);
    } else {
      await compatibility(rcon, settings, mode === 'control');
    }
    record('m0-pass', { mode });
  } finally { rcon.close(); }
}

main().catch((error) => {
  record('m0-failed', { error: error.stack });
  process.exitCode = 1;
});
