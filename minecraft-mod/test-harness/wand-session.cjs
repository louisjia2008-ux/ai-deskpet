'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { serverSettings, Vec3, until, record, stabilize } = require('./common.cjs');

const Y = 160;
const FIRST = new Vec3(0, Y - 1, 0);
const SECOND = new Vec3(17, Y - 1, 17);
const CHEST = new Vec3(19, Y, 9);
const LOWER = new Vec3(-8, Y - 8, -8);
const UPPER = new Vec3(25, Y + 12, 25);
const BUTTON = {
  template: 10, rotation: 11, east: 15, groundDown: 19, groundUp: 20, mode: 21,
  treeClip: 24, buildLayer: 28, clearLayer: 29, fillLayer: 30, protectedLayer: 31,
  conflictLayer: 32, confirm: 45, pause: 46, continue: 47, undo: 51, cancel: 53,
};
const WAND = 'deskpet:survey_wand';

function commandAssert(response, context) {
  assert.ok(response && !/Unknown|Failed|Unable|No player|No entity|not loaded|Invalid/i.test(response),
    `${context}: ${response}`);
}

async function move(rcon, bot, position) {
  commandAssert(await rcon.command(`tp ${bot.username} ${position.x} ${position.y} ${position.z}`), 'Position test player');
  await until(() => bot.entity?.position.distanceTo(position) < 0.35, `server position for ${bot.username}`);
}

async function equip(rcon, bot, item = WAND) {
  commandAssert(await rcon.command(`item replace entity ${bot.username} weapon.mainhand with ${item}`), 'Equip test item');
  await until(() => {
    if (item === WAND) return /Survey Wand|标注法杖/.test(JSON.stringify(bot.heldItem?.customName || ''));
    return bot.heldItem?.name === item.split(':').at(-1);
  }, `${item} in ${bot.username} main hand`);
}

async function setupArena(rcon, bots) {
  await stabilize(rcon);
  await move(rcon, bots[0], new Vec3(1.5, Y, 1.5));
  // Clear the entire fixture, including the eight-block perimeter sampled in snapshots.
  await rcon.command(`fill -8 ${Y - 7} -8 25 ${Y + 12} 25 air`);
  await rcon.command(`fill -8 ${Y - 8} -8 25 ${Y - 8} 25 stone`);
  await rcon.command(`fill -8 ${Y - 7} -8 25 ${Y - 1} 25 dirt`);
  // Keep the visible surface uniform for deterministic 'most common ground height'.
  await rcon.command(`fill -8 ${Y - 1} -8 25 ${Y - 1} 25 grass_block`);
  for (const bot of bots) {
    await rcon.command(`gamemode creative ${bot.username}`);
    await rcon.command(`clear ${bot.username}`);
    await move(rcon, bot, new Vec3(1.5, Y, 1.5));
  }
  commandAssert(await rcon.command(`setblock ${coords(CHEST)} chest`), 'Material chest fixture');
  await rcon.command(`item replace block ${coords(CHEST)} container.0 with oak_planks 64`);
  await rcon.command(`item replace block ${coords(CHEST)} container.1 with cobblestone 64`);
  await rcon.command(`item replace block ${coords(CHEST)} container.2 with oak_log 32`);
}

function coords(pos) { return `${pos.x} ${pos.y} ${pos.z}`; }

async function snapshot(rcon, name, lower = LOWER, upper = UPPER) {
  const response = await rcon.command(`deskpet debug snapshot ${coords(lower)} ${coords(upper)} ${name}`);
  const sha256 = response.match(/\b[a-f0-9]{64}\b/i)?.[0];
  assert.ok(sha256, `Expected snapshot SHA-256: ${response}`);
  const { worldDir } = await serverSettings();
  const file = path.join(worldDir, 'deskpet-snapshots', `${name}.json`);
  const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  assert.equal(actual, sha256, 'Snapshot file must hash to the value returned by the server');
  assert.equal((await fs.readFile(path.join(worldDir, 'deskpet-snapshots', `${name}.sha256`), 'utf8')).trim(), sha256);
  record('server-snapshot', { name, sha256, file });
  return sha256;
}

async function blockClick(rcon, bot, target, { sneaking = false } = {}) {
  await move(rcon, bot, target.offset(0.5, target.y === Y - 1 ? 1 : 0, 2.5));
  const expected = await until(() => {
    const block = bot.blockAt(target);
    return block && block.name !== 'air' && block;
  }, 'target block in Mineflayer chunk');
  try {
    bot.setControlState('sneak', sneaking);
    await bot.activateBlock(expected, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
    await delay(220);
  } finally { bot.setControlState('sneak', false); }
}

async function airClick(bot, sneaking = false) {
  try {
    bot.setControlState('sneak', sneaking);
    await bot.look(0, Math.PI / 2, true);
    bot.activateItem();
    await delay(220);
  } finally { bot.setControlState('sneak', false); }
}

async function openMenu(bot) {
  await airClick(bot);
  const window = await until(() => bot.currentWindow?.inventoryStart === 54 && bot.currentWindow,
    `${bot.username} opened sgui 6-row menu`);
  record('menu-open', { player: bot.username, id: window.id, title: window.title,
    buttons: Object.fromEntries(Object.entries(BUTTON).map(([key, slot]) => [key, describeSlot(window.slots[slot])])) });
  return window;
}

function describeSlot(item) {
  return item && { name: item.name, label: item.customName ?? item.componentMap?.get('item_name')?.data,
    lore: item.componentMap?.get('lore')?.data, count: item.count };
}

async function click(bot, slot) {
  const current = bot.currentWindow;
  assert.ok(current?.slots[slot], `Expected menu item at slot ${slot}`);
  const before = describeSlot(current.slots[slot]);
  await bot.clickWindow(slot, 0, 0);
  await delay(350);
  const after = describeSlot(bot.currentWindow?.slots[slot]);
  record('menu-click', { player: bot.username, slot, before, after });
  return { before, after };
}

function observeDisplays(bot) {
  const spawns = [];
  const removals = [];
  const active = new Set();
  bot._client.on('spawn_entity', (packet) => {
    if (packet.type !== bot.registry?.entitiesByName?.block_display?.id) return;
    spawns.push(packet.entityId);
    active.add(packet.entityId);
  });
  bot._client.on('entity_destroy', (packet) => {
    removals.push(...packet.entityIds.filter((id) => active.delete(id)));
  });
  return { spawns, removals, active };
}

async function stageSelection(rcon, owner, { first = FIRST, second = SECOND, supply = false } = {}) {
  if (owner.currentWindow) owner.closeWindow(owner.currentWindow);
  await equip(rcon, owner);
  await blockClick(rcon, owner, first);
  await blockClick(rcon, owner, second);
  if (supply) await blockClick(rcon, owner, CHEST, { sneaking: true });
}

async function readPlans(rcon) {
  const response = await rcon.command('deskpet debug plans');
  assert.match(response, /survey plan state exported/);
  const { worldDir } = await serverSettings();
  return JSON.parse(await fs.readFile(path.join(worldDir, 'deskpet-debug/plans.json'), 'utf8'));
}

module.exports = { BUTTON, P: { first: FIRST, second: SECOND, chest: CHEST, lower: LOWER, upper: UPPER },
  Y, coords, move, equip, setupArena, snapshot, blockClick, airClick, openMenu, click, describeSlot,
  observeDisplays, stageSelection, readPlans, commandAssert };
