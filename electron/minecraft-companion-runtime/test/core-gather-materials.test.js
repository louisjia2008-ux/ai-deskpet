'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');

// A flat world of stone at y 63 with a chest on it, the bot ten blocks off.
function world(placedAt) {
  const chest = { x: 0, y: 64, z: 0 };
  const blocks = new Map([[`${chest.x},${chest.y},${chest.z}`, 'chest']]);
  const blockAt = (p) => {
    const name = blocks.get(`${p.x},${p.y},${p.z}`) || (p.y <= 63 ? 'stone' : 'air');
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const bot = { entity: { position: new Vec3(10.5, 64, 0.5) }, blockAt, game: { dimension: 'overworld' },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 30 } };
  const skills = {
    storeInChest: async () => ({ ok: true, contents: { oak_log: 8 } }),
    placeAt: async (_bot, _ctx, p, match) => {
      const name = ['crafting_table', 'furnace'].find((n) => match(n));
      blocks.set(`${p.x},${p.y},${p.z}`, name);
      placedAt.push({ name, x: p.x, y: p.y, z: p.z });
      return { ok: true };
    },
  };
  return { bot, chest, skills };
}

test('materials asked for with no stations put the crafting table down beside the bot', async () => {
  const placedAt = [];
  const { bot, chest, skills } = world(placedAt);
  const goal = createGatherMaterialsGoal({ bot, chest, skills, actions: {},
    requirements: [{ key: 'log', count: 8 }, { key: 'cobblestone', count: 8 }] });
  const ctx = { signal: new AbortController().signal, record: () => {},
    perceive: () => ({ inventory: { crafting_table: 1, oak_planks: 6, stick: 4 } }) };
  assert.equal((await goal.run(ctx)).ok, true); // looks in the chest
  const placed = await goal.run(ctx);
  // It looped 200 times on "no_spot:crafting_table" in game.
  assert.equal(placed.ok, true, placed.reason);
  assert.equal(placedAt.length, 1);
  assert.equal(placedAt[0].name, 'crafting_table');
  assert.ok(Math.hypot(placedAt[0].x - 10, placedAt[0].z) <= 6, 'beside the bot');
  assert.ok(!(placedAt[0].x === chest.x && placedAt[0].z === chest.z));
});

test('with a search radius, no tree near the chest ends the task with what is missing', async () => {
  const { bot, chest, skills } = world([]);
  let legs = 0;
  Object.assign(skills, {
    storeInChest: async () => ({ ok: true, contents: {} }),
    gatherOne: async () => ({ ok: false, reason: 'no_target_in_range' }),
    explore: async (_bot, _ctx, memory) => { legs += 1; assert.deepEqual(memory.around, { x: 0, z: 0, radius: 128 }); return { ok: true, moved: 32 }; },
  });
  const goal = createGatherMaterialsGoal({ bot, chest, skills, actions: {}, searchRadius: 128,
    requirements: [{ key: 'log', count: 4 }] });
  const ctx = { signal: new AbortController().signal, record: () => {}, perceive: () => ({ inventory: {} }) };
  let result;
  for (let i = 0; i < 30 && !result?.giveUp; i += 1) result = await goal.run(ctx);
  assert.equal(result.giveUp, true);
  assert.match(result.reason, /^none_near_site:log within 128 of the chest at 0,64,0/);
  assert.equal(legs, 8);
});
