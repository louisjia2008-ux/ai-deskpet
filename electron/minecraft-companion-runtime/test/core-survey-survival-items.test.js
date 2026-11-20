'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('minecraft-data')('1.21.8');
const { Vec3 } = require('vec3');
const { installSurveyActions, withSurveyStep, surveyPlace } = require('../core/survey-plan-actions');

const item = (name, components = [], removedComponents = []) => ({ name, components, removedComponents });
const potion = (potionId, customEffects = []) =>
  item('potion', [{ type: 'potion_contents', data: { potionId, customEffects } }]);

function guardedBot(ops = []) {
  const wire = [];
  const control = new AbortController();
  const bot = {
    version: '1.21.8', registry,
    inventory: { slots: [] },
    time: { timeOfDay: 18000 },
    blockAt: (pos) => ({ name: 'air', position: pos }),
    _client: { write: (...packet) => wire.push(packet) },
  };
  const restore = installSurveyActions(bot, { ops }, { signal: control.signal, applied: () => null });
  return { bot, wire, control, restore };
}

test('survey allows air use of held food, an ordinary potable potion and a worn offhand shield', () => {
  const { bot, wire, control } = guardedBot();
  bot.heldItem = item('bread');
  bot.inventory.slots[45] = item('shield', [{ type: 'damage', data: 36 }, { type: 'enchantments', data: [] }]);
  const eat = { hand: 0, sequence: 1 };
  const protect = { hand: 1, sequence: 2 };
  const drink = { hand: 0, sequence: 3 };
  bot._client.write('use_item', eat);
  bot._client.write('use_item', protect);
  bot.heldItem = potion(24); // Vanilla 1.21.8 instant health.
  bot._client.write('use_item', drink);

  control.abort('revoke');
  bot._client.write('use_item', { hand: 1, sequence: 4 });
  assert.deepEqual(wire, [['use_item', eat], ['use_item', protect], ['use_item', drink]]);
});

test('survey rejects targeted use, unsupported hands and non-whitelisted consumables', () => {
  const { bot, wire } = guardedBot();
  const location = new Vec3(0, 64, 0);
  bot.heldItem = item('bread');
  bot._client.write('block_place', { hand: 0, location, direction: 1 });
  bot._client.write('use_item', { hand: 0, location });
  bot._client.write('use_item', { hand: 2 });
  bot._client.write('use_item', {});
  bot._client.write('use_item', { hand: 1 });

  for (const unsafe of ['water_bucket', 'lava_bucket', 'bucket', 'ender_pearl', 'fire_charge', 'flint_and_steel',
    'bone_meal', 'splash_potion', 'lingering_potion', 'chorus_fruit', 'wind_charge']) {
    // Check the item in the requested hand, independent of a safe item in the other.
    bot.heldItem = item(unsafe);
    bot.inventory.slots[45] = item('shield');
    bot._client.write('use_item', { hand: 0 });
    bot.heldItem = item('bread');
    bot.inventory.slots[45] = item(unsafe);
    bot._client.write('use_item', { hand: 1 });
  }
  for (const unsafe of [
    item('bread', [{ type: 'consumable', data: { effects: [{ type: 'teleport_randomly' }] } }]),
    item('bread', [{ type: 'custom_data' }]),
    item('shield', [], [{ type: 'blocks_attacks' }]),
    potion(43), // Weaving can place cobwebs when the entity dies.
    potion(24, [{ id: 36 }]),
  ]) {
    bot.heldItem = unsafe;
    bot._client.write('use_item', { hand: 0 });
  }
  assert.deepEqual(wire, []);
});

test('only a pending irrigation operation allows water-bucket use', async () => {
  const pos = new Vec3(0, 64, 0);
  const op = { pos, order: 0, kind: 'build', phase: 'irrigate', expect: 'minecraft:air', target: 'minecraft:water[level=0]' };
  const { bot, wire } = guardedBot([op]);
  bot.time.timeOfDay = 1000;
  bot.heldItem = item('water_bucket');
  bot.inventory.slots[45] = item('water_bucket');
  bot._client.write('use_item', { hand: 0 });
  const irrigate = (ctx, hand) => surveyPlace(bot, ctx, { pos,
    run: () => bot._client.write('use_item', { hand }) });
  assert.equal((await withSurveyStep(bot, {}, [op], (ctx) => irrigate(ctx, 1))).ok, false);
  assert.equal((await withSurveyStep(bot, {}, [op], (ctx) => irrigate(ctx, 0))).ok, true);
  assert.deepEqual(wire, [['use_item', { hand: 0 }]]);
});
