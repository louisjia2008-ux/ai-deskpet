'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const actions = require('../core/actions');
const { mineStep } = require('../core/mining');
const { digIn, shelterSealCount } = require('../core/skills');
const { KNOWLEDGE, countKey } = require('../core/knowledge');
const { filler, seal } = require('../core/materials');
const { createCobbleGeneratorGoal } = require('../core/goals/cobbleGenerator');
const { createVillageIronFarmGoal } = require('../core/goals/villageIronFarm');

const ctx = { record() {} };
const v = (p) => new Vec3(p.x, p.y, p.z);
const down = new Vec3(0, -1, 0);
const east = new Vec3(1, 0, 0);

function fixture(names, y = 64) {
  const cells = new Map();
  const items = names.map(name => ({ name, count: 4 }));
  const edits = [];
  let hit;
  const put = (p, name) => cells.set(v(p).toString(), name);
  const blockAt = (p) => {
    const name = cells.get(p.toString()) || (p.y < y ? 'stone' : 'air');
    const solid = !['air', 'water', 'rail'].includes(name);
    return { name, position: p, diggable: solid, boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const bot = {
    entity: { position: new Vec3(-0.5, y, 0.5), onGround: true }, entities: {}, registry: { blocksByName: {} },
    inventory: { items: () => items }, blockAt, world: { getBlock: blockAt, raycast: () => hit },
    async lookAt() {},
    async equip(item) { this.heldItem = item; },
    async placeBlock(ref, face) {
      const target = ref.position.plus(face);
      put(target, this.heldItem.name);
      edits.push([target, this.heldItem.name]);
    },
  };
  return { bot, put, edits, aim(cell, toward, face) { hit = { position: v(cell).plus(toward), face }; } };
}

test('filler and seal retain the former callers’ materials and reject unsafe choices', () => {
  for (const name of ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'coarse_dirt', 'netherrack']) {
    assert.equal(filler(name), true, name);
    assert.equal(seal(name), true, name);
  }
  for (const name of ['sandstone', 'red_sandstone']) {
    assert.equal(filler(name), false, name);
    assert.equal(seal(name), true, name);
  }
  for (const name of ['sand', 'gravel', 'red_concrete_powder', 'iron_ore', 'oak_log', 'furnace']) {
    assert.equal(filler(name), false, name);
    assert.equal(seal(name), false, name);
  }
});

test('pocket drainage plugs the inflow with eligible inventory and observes dry air', async () => {
  const { bot, put, edits } = fixture(['sand', 'coarse_dirt']);
  bot.entity.isInWater = true;
  const feet = bot.entity.position.floored();
  const head = feet.offset(0, 1, 0);
  const inflow = head.plus(east);
  put(head, 'water');
  put(inflow, 'water');
  put(feet.offset(0, 2, 0), 'stone');
  put(inflow.plus(down), 'stone');
  const placeBlock = bot.placeBlock.bind(bot);
  bot.placeBlock = async (ref, face) => { await placeBlock(ref, face); put(head, 'air'); };
  assert.equal(await actions.drainPocket(bot, ctx), true);
  assert.deepEqual(edits, [[inflow, 'coarse_dirt']]);
});

test('a mining route can harvest an ore underfoot and repair it with carried stone', async () => {
  const { bot, put, edits, aim } = fixture(['sand', 'stone', 'stone_pickaxe']);
  const ore = new Vec3(0, 63, 0);
  const floorKey = `${ore.x},${ore.y},${ore.z}`;
  const mine = { cells: { '0,64,0': null }, open: {} };
  put(ore, 'iron_ore');
  aim(ore, down, 1);
  bot.registry.blocksByName.iron_ore = { id: 1, name: 'iron_ore' };
  bot.findBlocks = () => [ore];
  const result = await mineStep(bot, ctx, { mine }, {
    blocks: n => n === 'iron_ore', dropMatch: n => n === 'raw_iron', blacklist: new Set(),
    actions: { goToDig: async () => ({ ok: true }), digBlock: async () => { put(ore, 'air'); return { ok: true }; },
      collectDrops: async () => ({ ok: true }) },
  });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(edits, [[ore, 'stone']]);
  assert.equal(mine.floorRepair, null);
  assert.equal(mine.open[floorKey], undefined);
});

test('closed mining seals a reachable side opening with an available filler', async () => {
  const { bot, put, edits, aim } = fixture(['gravel', 'coarse_dirt']);
  const front = new Vec3(0, 60, 0), opening = front.offset(1, 1, 0);
  bot.entity.position = front.offset(0.5, 0, 0.5);
  put(front, 'air');
  put(front.offset(0, 1, 0), 'air');
  put(opening, 'air');
  aim(opening, down, 1);
  const mine = { front, surfaceY: 65, y: 60, dir: 0, phase: 'main', cells: {}, open: {} };
  const result = await mineStep(bot, ctx, { mine }, { blocks: () => false, y: 60, closed: true, actions: { withinReach: () => true } });
  assert.equal(result.sealed, true, result.reason);
  assert.deepEqual(edits, [[opening, 'coarse_dirt']]);
});

test('the cobblestone generator counts alternate seal supplies and places them', async () => {
  const { bot, put, aim, edits } = fixture(['stone', 'oak_log']);
  const goal = createCobbleGeneratorGoal({ bot, anchor: { x: 0, y: 63, z: 0 } });
  const target = v(goal.memory.device.seal[0]);
  for (const p of goal.memory.device.seal) put(p, 'stone');
  put(target, 'air');
  put(target.plus(down), 'stone');
  bot.entity.position = target.offset(0.5, 1, -1.5);
  aim(target, down, 1);
  const demand = goal.needs().find(r => r.key === 'filler');
  assert.deepEqual(demand, { key: 'filler', count: 1 });
  assert.ok(countKey(demand.key, { stone: 4 }, KNOWLEDGE) >= demand.count);
  const result = await goal.run(ctx);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(edits, [[target, 'stone']]);
  assert.equal(goal.needs().some(r => r.key === 'filler'), false);
});

test('a village cart route uses an available filler to support its next rail', async () => {
  const { bot, put, aim, edits } = fixture(['rail', 'gravel', 'netherrack']);
  const end = new Vec3(-1, 64, 0), ground = new Vec3(0, 63, 0);
  const next = ground.offset(0, 1, 0);
  put(end, 'rail');
  put(ground, 'air');
  bot.entities = { cart: { id: 'cart', name: 'minecart', position: next.offset(1.5, 0, 0.5) } };
  bot.entities.villager = { name: 'villager', position: bot.entities.cart.position, vehicle: bot.entities.cart };
  const placeBlock = bot.placeBlock.bind(bot);
  bot.placeBlock = async (ref, face) => { await placeBlock(ref, face); aim(next, down, 1); };
  aim(ground, down, 1);
  const goal = createVillageIronFarmGoal({ bot });
  Object.assign(goal.memory, { village: end, stocked: true, line: [end],
    farmGoal: { villagers: () => 0, memory: { awaiting: true, farm: { cells: {}, rails: [{ position: end }] } } } });
  const result = await goal.run(ctx);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(edits, [[ground, 'netherrack'], [next, 'rail']]);
});

test('digging in uses a stable carried red sandstone lid and counts it as reserve', async (t) => {
  const { bot, put, aim, edits } = fixture(['red_sand', 'red_sandstone']);
  const top = bot.entity.position.floored(), lid = top.plus(down);
  aim(lid, east, 4);
  t.mock.method(actions, 'digBlock', async (_bot, _ctx, block) => {
    put(block.position, 'air');
    bot.entity.position.y = block.position.y;
    return { ok: true };
  });
  assert.equal(shelterSealCount({ red_sandstone: 4, red_sand: 4 }), 4);
  assert.equal((await digIn(bot, ctx)).ok, true);
  assert.deepEqual(edits, [[lid, 'red_sandstone']]);
});
