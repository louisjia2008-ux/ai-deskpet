'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, serverDir, CHANNEL, VERSION, Vec3, record, until, serverSettings, createRcon,
  newBot, ready, closeBot, decodeMessage, sendMessage } = require('./common.cjs');
const { BUTTON, P, Y, coords, move, equip, setupArena, snapshot, blockClick, openMenu, click,
  describeSlot, readPlans, commandAssert } = require('./wand-session.cjs');

const SLOT = { ...BUTTON, recompare: 48, remaining: 49, regenerate: 49, history: 51,
  status: 4, back: 53 };
const IDENTITIES = { owner: 'Owner', core: 'DeskPetBot', watcher: 'Intruder' };

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).join(' ');
  if (!value || typeof value !== 'object') return '';
  if (Object.hasOwn(value, 'type') && Object.hasOwn(value, 'value')) return textValue(value.value);
  return ['text', 'translate', 'fallback', 'extra', 'with'].flatMap((key) =>
    value[key] === undefined ? [] : [textValue(value[key])]).join(' ');
}

function menuText(item) {
  const slot = describeSlot(item);
  return `${textValue(slot?.label)} ${textValue(slot?.lore)}`.trim();
}

function observe(bot, username) {
  const bars = new Map();
  const displays = new Map();
  const bossPackets = [];
  const displayPackets = [];
  const chat = [];
  const action = [];
  const commands = [];
  bot._client.on('boss_bar', ({ entityUUID: id, action, title, health }) => {
    const entry = { action, id, ...(title === undefined ? {} : { title: textValue(title) }),
      ...(health === undefined ? {} : { progress: health }) };
    bossPackets.push(entry);
    if (action === 1) bars.delete(id);
    else bars.set(id, { ...bars.get(id), ...entry });
    record('m4-boss-wire', { username, ...entry });
  });
  bot._client.on('spawn_entity', (packet) => {
    const entities = bot.registry?.entitiesByName;
    if (![entities?.block_display?.id, entities?.text_display?.id].includes(packet.type)) return;
    const { entityId: id, x, y, z } = packet;
    const entry = { id, pos: { x, y, z }, display: packet.type === entities.block_display.id ? 'block' : 'text', metadata: {} };
    displayPackets.push(entry);
    displays.set(id, entry);
    record('m4-display-spawn', { username, ...entry });
  });
  bot._client.on('entity_metadata', ({ entityId, metadata }) => {
    const display = displays.get(entityId);
    if (!display || display.display !== 'block') return;
    const keys = bot.registry.entitiesByName.block_display.metadataKeys;
    const observed = Object.fromEntries(metadata.filter(({ key }) => ['shared_flags', 'glow_color_override', 'block_state'].includes(keys[key]))
      .map(({ key, value }) => [keys[key], value]));
    Object.assign(display.metadata, observed);
    if (Object.keys(observed).length) record('m4-display-metadata', { username, entityId, metadata: observed });
  });
  bot._client.on('entity_destroy', ({ entityIds }) => {
    const removed = entityIds.filter((id) => displays.delete(id));
    if (removed.length) record('m4-display-remove', { username, removed });
  });
  bot._client.on('system_chat', ({ content, isActionBar }) => {
    const text = textValue(content);
    if (isActionBar) {
      action.push(text);
      record('m4-action-wire', { username, text });
    } else {
      commands.push(text);
      if (text.includes('【施工】')) chat.push(text);
      record('m4-chat-wire', { username, text });
    }
  });
  bot._client.on('action_bar', ({ text }) => {
    const message = textValue(text);
    action.push(message);
    record('m4-action-wire', { username, text: message });
  });
  return { bars, displays, bossPackets, displayPackets, chat, action, commands };
}

function requireButton(bot, slot, label, enabled = true) {
  const item = bot.currentWindow?.slots[slot];
  assert.ok(item, `Missing menu item ${slot} for ${label}`);
  const name = menuText(item);
  assert.match(name, label);
  assert.equal(item.name === 'barrier', !enabled, `Unexpected availability at menu slot ${slot}: ${name}`);
  return name;
}

async function dashboard(owner) {
  if (owner.currentWindow) owner.closeWindow(owner.currentWindow);
  owner.chat('/deskpet plan');
  const window = await until(() => owner.currentWindow?.inventoryStart === 54 && owner.currentWindow,
    'the actual Owner command opens the 54-slot construction menu', 7000);
  record('m4-command-menu', { title: textValue(window.title), slots: window.slots.slice(0, 54).flatMap((item, slot) =>
    item ? [{ slot, item: item.name, text: menuText(item) }] : []) });
  return window;
}

async function fixture(env, { missingDoor = false, boundaryWork = false } = {}) {
  const { rcon, owner, intruder, robot } = env;
  await setupArena(rcon, [owner]);
  await rcon.command(`kill @e[type=item,x=-8,y=${Y - 8},z=-8,dx=33,dy=24,dz=33]`);
  await rcon.command('gamemode survival DeskPetBot');
  await rcon.command('clear DeskPetBot');
  commandAssert(await rcon.command('item replace entity DeskPetBot hotbar.0 with stone_pickaxe'), 'Place the worker pickaxe');
  commandAssert(await rcon.command('item replace entity DeskPetBot hotbar.1 with stone_shovel'), 'Place the worker shovel');
  await move(rcon, robot, new Vec3(-3.5, Y, 14.5));
  await rcon.command('gamemode creative Intruder');
  await move(rcon, intruder, new Vec3(14.5, Y, 14.5));
  const materials = [
    ['oak_planks', 64], ['cobblestone', 64], ['dirt', 64], ['oak_door', 1], ['red_bed', 1],
    ['torch', 16], ['crafting_table', 1], ['furnace', 1], ['chest', 1],
  ];
  assert.match(await rcon.command(`data merge block ${coords(P.chest)} {Items:[]}`), /Modified block data|Nothing changed/);
  for (const [slot, [item, count]] of materials.entries()) {
    if (missingDoor && item === 'oak_door') continue;
    commandAssert(await rcon.command(`item replace block ${coords(P.chest)} container.${slot} with ${item} ${count}`),
      `Stock the construction chest with ${item}`);
  }
  const edge = new Vec3(P.first.x, Y, P.first.z + 6);
  if (boundaryWork) commandAssert(await rcon.command(`setblock ${coords(edge)} dirt`), 'Create the original edge cut');
  return { edge };
}

async function draft(env, { entire = false } = {}) {
  const { owner, rcon } = env;
  const known = new Set((await readPlans(rcon)).plans.map(({ id }) => id));
  if (owner.currentWindow) owner.closeWindow(owner.currentWindow);
  await equip(rcon, owner);
  await blockClick(rcon, owner, P.first, { ground: true });
  await blockClick(rcon, owner, P.second, { ground: true });
  await blockClick(rcon, owner, P.chest, { sneaking: true, ground: false });
  await openMenu(owner);
  if (entire) await click(owner, SLOT.mode);
  const entry = (await readPlans(rcon)).plans.findLast(({ id, status }) => !known.has(id) && status === 'previewed');
  assert.ok(entry, 'Owner creates a persisted real preview');
  assert.equal(entry.plan.template.id, 'starter_house');
  assert.deepEqual(entry.plan.conflicts, []);
  requireButton(owner, SLOT.confirm, /确认开工/);
  record('m4-original-preview', { id: entry.id, revision: entry.plan.revision, total: entry.plan.ops.length,
    selection: entry.plan.selection, materials: entry.plan.materials });
  return entry;
}

async function planWhere(env, accept, description, timeout = 30_000) {
  return until(async () => {
    const row = (await readPlans(env.rcon)).plans.find(({ id }) => env.id === id);
    assert.ok(row, `Mod did not export active plan ${env.id}`);
    if (accept(row)) return row;
    if (['cancelled', 'expired', 'failed', 'completed'].includes(row.status)) {
      record('m4-unexpected-terminal', { id: row.id, status: row.status, reason: row.reason,
        completed: row.completed, total: row.total, blocked: row.blocked });
      throw new Error(`Unexpected terminal ${row.status} during ${description}`);
    }
    return false;
  }, description, timeout, 225);
}

async function beforeSnapshot(env) {
  const box = env.plan.selection;
  env.bounds = { low: new Vec3(box.minX - 8, box.minY, box.minZ - 8),
    high: new Vec3(box.maxX + 8, box.maxY + 8, box.maxZ + 8) };
  return take(env, 'original_before_confirm');
}

async function take(env, phase) {
  const name = `m4_${env.scenario}_${env.runId}_${env.id.slice(0, 8)}_${phase}`;
  const hash = await snapshot(env.rcon, name, env.bounds.low, env.bounds.high);
  const file = path.join(env.settings.worldDir, 'deskpet-snapshots', `${name}.json`);
  return { hash, blocks: JSON.parse(await fs.readFile(file, 'utf8')).blocks };
}

async function startPlan(env, options = {}) {
  await fixture(env, options);
  const entry = await draft(env, { entire: options.boundaryWork });
  env.id = entry.id;
  env.plan = entry.plan;
  env.before = await beforeSnapshot(env);
  if (options.holdAccept) env.transport.hold('accept');
  if (options.holdSettlement) env.transport.hold('settled');
  await click(env.owner, SLOT.confirm);
  return planWhere(env, (row) => row.status === (options.holdAccept ? 'confirmed' : 'running'), 'server grants the Owner-confirmed plan');
}

function assertPrivate(env) {
  for (const [username, wire] of [['DeskPetBot', env.coreWire], ['Intruder', env.intruderWire]]) {
    assert.equal(wire.bossPackets.length, 0, `${username} received a Boss bar`);
    assert.equal(wire.displayPackets.length, 0, `${username} received a private marker`);
    assert.equal(wire.chat.length, 0, `${username} received construction chat`);
  }
  record('m4-private-pass', { bot: { boss: 0, marker: 0, chat: 0 }, intruder: { boss: 0, marker: 0, chat: 0 } });
}

async function settled(env, revision = env.plan.revision) {
  const row = await planWhere(env, (entry) => entry.status === 'completed', 'the server completes the real build', 180000);
  assert.equal(row.plan.revision, revision);
  assert.equal(row.violations, 0);
  assert.equal(row.completed, row.total);
  await until(() => env.coreEvents.some(({ type, payload }) => type === 'core' && payload.type === 'goal_done'
    && payload.planId === env.id && payload.revision === revision), 'Core observes authoritative completion', 9000);
  await until(() => env.ownerWire.bars.size === 0, 'owner-only Boss bar removed after terminal state', 6000);
  record('m4-plan-completed', { id: row.id, revision, completed: row.completed, total: row.total,
    violations: row.violations, misplacements: row.misplacements, siteChanges: row.siteChanges, lateAttempts: row.lateAttempts });
  return row;
}

async function runWorld(scenario, test) {
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, IDENTITIES.owner);
  const intruder = newBot(settings, IDENTITIES.watcher);
  const ownerWire = observe(owner.bot, IDENTITIES.owner);
  const intruderWire = observe(intruder.bot, IDENTITIES.watcher);
  const coreEvents = [];
  const applied = [];
  const outbound = [];
  const held = new Map();
  const withheld = new Set();
  let robot;
  let coreWire;
  let forward;
  const transport = {
    outbound,
    hold(type) { withheld.add(type); },
    async release(type) {
      const entry = await until(() => held.get(type), `real Core sent held ${type}`, 180000, 120);
      withheld.delete(type);
      held.delete(type);
      record('m4-release-production-packet', { type, grantId: entry.message.grantId });
      forward('custom_payload', entry.packet);
      return entry.message;
    },
    isHeld: (type) => held.has(type),
    breakFixture(pos) {
      // Use the original test-client writer to fault-inject one vanilla action
      // past the Core guard and verify the independent Mod failure transition.
      record('m4-vanilla-break-fixture', { pos });
      forward('block_dig', { status: 0, location: pos, face: 3, sequence: 0 });
    },
  };
  const host = runtimeRequire('./core-host').createCoreHost({
    dataDir: await fs.mkdtemp(path.join(serverDir, 'm4-core-')),
    surveyPlanMode: 'execute',
    createBot(options) {
      robot = runtimeRequire('mineflayer').createBot(options);
      coreWire = observe(robot, IDENTITIES.core);
      const client = robot._client;
      client.on('custom_payload', ({ channel, data }) => {
        if (channel !== CHANNEL) return;
        const message = decodeMessage(data);
        if (message.type !== 'applied') return;
        applied.push(message);
        record('m4-server-applied', { planId: message.planId, revision: message.revision, positions: message.positions });
      });
      forward = client.write.bind(client);
      client.write = (name, packet) => {
        if (name === 'custom_payload' && packet.channel === CHANNEL) {
          const message = decodeMessage(packet.data);
          const type = message.type === 'progress' && message.settled === true ? 'settled' : message.type;
          if (['accept', 'settled'].includes(type)) {
            outbound.push(message);
            record('m4-production-packet', { type, grantId: message.grantId, revision: message.revision });
          }
          if (withheld.has(type)) {
            held.set(type, { packet, message });
            return undefined;
          }
        }
        return forward(name, packet);
      };
      return robot;
    },
    emit(message) {
      if (message.type !== 'event') return;
      coreEvents.push(message.event);
      if (['connection', 'survey_plan', 'task', 'core'].includes(message.event.type)) record('m4-core', { event: message.event });
    },
  });
  const env = { scenario, runId: randomUUID().slice(0, 8), rcon, settings, owner: owner.bot, intruder: intruder.bot,
    ownerWire, intruderWire, coreEvents, applied, transport };
  try {
    const connect = await host.handle({ version: 1, id: randomUUID(), type: 'connect', config: { host: settings.host,
      port: settings.port, auth: 'offline', version: VERSION, username: IDENTITIES.core, ownerName: IDENTITIES.owner } });
    assert.ok(connect.ok, JSON.stringify(connect.error));
    await Promise.all([ready(owner), ready(intruder), until(() => {
      const status = host.status().connection;
      assert.notEqual(status.state, 'error', JSON.stringify(status.lastError));
      return status.state === 'ready';
    }, 'the production construction Core is connected', 60000)]);
    Object.assign(env, { robot, coreWire });
    await test(env);
    assert.deepEqual(owner.errors, []);
    assert.deepEqual(intruder.errors, []);
    assertPrivate(env);
    record('m4-pass', { scenario, id: env.id, runId: env.runId });
  } catch (failure) {
    if (env.id) {
      const state = await readPlans(rcon).then((data) => data.plans.find(({ id }) => id === env.id)).catch(() => null);
      const failed = env.bounds && await take(env, 'failure').catch(() => null);
      record('m4-failure-evidence', { scenario, id: env.id, reason: state?.reason, status: state?.status,
        blocked: state?.blocked, completed: state?.completed, lastDenial: state?.lastDenial, snapshotSha256: failed?.hash });
    }
    throw failure;
  } finally {
    await host.close();
    closeBot(intruder);
    closeBot(owner);
    rcon.close();
  }
}

function protocol(env, message) { sendMessage(env.robot._client, message); }

module.exports = { SLOT, P, Y, Vec3, until, delay, record, coords, click, menuText, requireButton, dashboard,
  fixture, draft, startPlan, planWhere, take, settled, runWorld, assertPrivate, protocol, readPlans };
