'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');
const { createOutfitGoal } = require('../core/goals/outfit');
const { complete, failure } = require('../core/action-result');
const { exposed } = require('../core/mining');

function setup() {
  const chest = new Vec3(44, 69, 100), ore = new Vec3(46, 66, 102);
  const bot = { game: { dimension: 'overworld' }, entity: { position: chest.clone() },
    inventory: { items: () => [], slots: [] }, registry: { blocksByName: {} },
    blockAt: p => ({ position: p, name: p.equals(chest) ? 'chest' : p.equals(ore) ? 'iron_ore' : 'stone', boundingBox: 'block' }) };
  const state = { inventory: { stone_pickaxe: 5 }, isDay: true };
  const events = [], ctx = { perceive: () => state, record: (type, data) => events.push({ type, ...data }) };
  return { bot, ctx, chest, ore, state, events };
}

test('generic equipment iron scan can take the encased seed 3 ore at (46,66,102)', async () => {
  const { bot, ctx, chest, ore, state } = setup();
  const scans = [];
  const goal = createGatherMaterialsGoal({ bot, chest, requirements: [{ key: 'raw_iron', count: 1 }], skills: {
    async gatherOne(_bot, _ctx, { blocks, dropMatch, radius = 48, exclude }) {
      scans.push(radius);
      assert.equal(blocks(bot.blockAt(ore).name), true);
      assert.equal(exposed(bot, ore), false);
      assert.equal(exclude?.(ore) ?? false, false);
      assert.equal(dropMatch('raw_iron'), true);
      state.inventory.raw_iron = 1;
      return complete();
    },
  } });
  goal.memory.chest = {};
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(scans, [48]);
  assert.equal(goal.memory.mine, null);
  assert.equal(state.inventory.raw_iron, 1);
});

test('64 barren tunnel cells force retreat and rescan before choosing another mine direction', async () => {
  const { bot, ctx, chest, events } = setup();
  const entrance = new Vec3(72, 69, 100), underground = new Vec3(74, 61, 100), calls = [];
  const goal = createGatherMaterialsGoal({ bot, chest, requirements: [{ key: 'raw_iron', count: 1 }], skills: {
    async gatherOne(_b, _c, { radius = 48 }) {
      calls.push(['scan', radius, bot.entity.position.y]);
      return radius === 48 ? failure('no_target_in_range') : complete();
    },
  }, actions: {
    underground: () => true,
    async surface(_bot, _ctx, { targetY }) {
      calls.push(['surface', targetY]);
      bot.entity.position = entrance.clone();
      return complete();
    },
  } });
  bot.entity.position = underground;
  const mine = { entrance, front: underground, y: 16, surfaceY: 69, dir: 0, steps: 64, cells: { [entrance]: null } };
  Object.assign(goal.memory, { chest: {}, mine });
  assert.equal((await goal.run(ctx)).progress, false);
  assert.equal(mine.retiring, true);
  assert.equal(events.find(e => e.type === 'mine_search_limit').limit, 64);
  for (let i = 0; i < 3; i++) assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(goal.memory.mine, null);
  assert.equal(goal.memory.mineDir, 1);
  assert.deepEqual(calls, [['surface', 69], ['scan', 48, 69], ['scan', 128, 69]]);
});

test('outfit work credits raw iron and keeps the credit through smelting', () => {
  const { bot, chest, state } = setup();
  const goal = createOutfitGoal({ bot, home: { chest, centre: chest }, items: [{ key: 'iron_pickaxe', count: 1 }] });
  const remaining = () => goal.work(state).remaining;
  assert.equal(remaining(), 4);
  state.inventory.raw_iron = 2;
  assert.equal(remaining(), 2);
  state.inventory.raw_iron = 0;
  goal.memory.gather = { memory: { furnace: { item: 'raw_iron', input: 1, output: 1 } } };
  assert.equal(remaining(), 2);
  goal.memory.gather.memory.furnace = {};
  state.inventory.iron_ingot = 3;
  assert.equal(remaining(), 1);
  state.inventory.iron_ingot = 0;
  state.inventory.iron_pickaxe = 1;
  assert.equal(remaining(), 0);
});
