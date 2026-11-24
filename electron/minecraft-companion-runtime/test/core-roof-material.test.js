'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createAdaptation } = require('../core/adaptation');
const { posKey } = require('../core/blacklist');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { chooseNext } = require('../core/director');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createProgression } = require('../core/goals/progression');
const { accepts, budget, supply } = require('../core/materials');
const { KNOWLEDGE } = require('../core/knowledge');
const { gatherOne } = require('../core/skills');

const anchor = { x: 0, y: 64, z: 0 };
const above = (p) => new Vec3(p.x, p.y + 1, p.z);

function site({ materials = {}, panels = {}, variant = 'starter', onRoof = false, widerStone = false,
  unconfirmed = () => false, afterWalk = () => {}, portable = false } = {}) {
  const blueprint = createStarterHouse(anchor, { variant });
  const roof = blueprint.blocks.filter(b => b.phase === 'roof').map(b => b.position);
  const walls = blueprint.blocks.filter(b => b.phase === 'walls').map(b => b.position);
  const blocks = new Map();
  const events = [], worked = [];
  const inventory = { crafting_table: 1, stone_pickaxe: 1, dirt: 2, ...materials };
  let afterChange = () => {};
  const setBlock = (p, n) => { blocks.set(posKey(p), n); afterChange(p, n); };
  for (const p of walls) setBlock(p, 'cobblestone');
  for (const [key, n] of Object.entries(panels)) blocks.set(key, n);
  const f = blueprint.furniture;
  for (const key of ['crafting_table', 'furnace', 'chest']) if (!portable || key !== 'crafting_table') setBlock(f[key].position, key);
  for (const p of [f.door.position, f.door.upper]) setBlock(p, 'oak_door');
  for (const p of [f.bed.position, f.bed.head, f.guestBed.position, f.guestBed.head]) setBlock(p, 'white_bed');
  for (const p of f.torches) setBlock(p, 'torch');
  const position = new Vec3(3.5, onRoof ? 67 : 64, 2.5);
  const bot = {
    game: { dimension: 'overworld' }, entity: { position },
    blockAt(p) {
      const n = blocks.get(posKey(p)) || (p.y < anchor.y ? 'dirt' : 'air');
      return { name: n, stateId: n, position: new Vec3(p.x, p.y, p.z), boundingBox: ['air', 'torch', 'oak_door'].includes(n) ? 'empty' : 'block',
        getProperties: () => ({ open: true }) };
    },
    inventory: { items: () => Object.entries(inventory).filter(([, count]) => count).map(([name, count]) => ({ name, count })) },
  };
  const actions = {
    withinReach: () => true,
    goTo: async (_bot, _ctx, goal) => {
      if (goal.y === undefined) return { ok: false, reason: 'path_timeout' }; // Attempts to look beyond the local wood supply.
      position.set(goal.x + 0.5, goal.y, goal.z + 0.5);
      afterWalk(setBlock);
      return { ok: true };
    },
    async collectDrops(_bot, _ctx, _p, match) {
      assert.ok(portable && match('crafting_table'));
      inventory.crafting_table += 1;
      return { ok: true };
    },
    async digBlock(_bot, _ctx, block, { ownedHomeRemoval } = {}) {
      assert.ok(ownedHomeRemoval?.(block) || (portable && block.name === 'crafting_table'));
      worked.push({ kind: 'dig', position: posKey(block.position), item: block.name });
      setBlock(block.position, 'air');
      return { ok: true };
    },
  };
  const skills = {
    async gatherOne(_bot, _ctx, { blocks: accepts, dropMatch, radius = 48, exclude, eligibleFirst }) {
      if (accepts('oak_log')) return { ok: false, reason: 'no_target_in_range' };
      const resource = [['stone', 'cobblestone'], ['grass_block', 'dirt'], ['sand', 'sand']]
        .find(([b, item]) => accepts(b) && dropMatch(item));
      assert.ok(resource, 'uses the existing gather skill and correct drop family');
      const [block, item] = resource;
      if (block === 'stone' && widerStone) {
        assert.equal(eligibleFirst, true);
        assert.equal(exclude(new Vec3(0, anchor.y, 0)), true);
        assert.equal(exclude(new Vec3(18, anchor.y, 5)), false);
        worked.push({ kind: 'search', radius, block });
        if (radius === 48) return { ok: false, reason: 'no_target_in_range' };
      }
      inventory[item] = (inventory[item] || 0) + 1;
      worked.push({ kind: 'gather', item, block });
      return { ok: true, gained: 1 };
    },
    async craft(_bot, _ctx, { item, times, tablePosition }) {
      if (portable) {
        assert.equal(item, 'stone_sword');
        assert.equal(bot.blockAt(tablePosition).name, 'crafting_table');
        inventory[item] = 1;
        return { ok: true, usedTable: true };
      }
      assert.equal(item, 'sandstone');
      assert.equal(tablePosition, null);
      assert.ok(inventory.sand >= 4 * times);
      inventory.sand -= 4 * times;
      inventory.sandstone = (inventory.sandstone || 0) + times;
      worked.push({ kind: 'craft', item, times });
      return { ok: true };
    },
    async placeAt(_bot, ctx, p, match) {
      assert.equal(bot.blockAt(p).name, 'air');
      const item = Object.keys(inventory).find(n => inventory[n] > 0 && match(n));
      assert.ok(item, `uses carried material at ${posKey(p)}`);
      inventory[item] -= 1;
      if (unconfirmed(p, item)) {
        ctx.record('place_failed', { attemptId: ctx.attemptId, target: posKey(p), item });
        return { ok: false, reason: 'place_unconfirmed' };
      }
      worked.push({ kind: 'place', position: posKey(p), item });
      setBlock(p, item);
      return { ok: true };
    },
  };
  const state = { inventory, position, isDay: true, timeOfDay: 4000, health: 20, food: 20 };
  const adapt = createAdaptation({ onEvent: e => events.push(e) }).scope(() => true);
  const ctx = { perceive: () => state, record: (type, data) => events.push({ type, ...data }), adapt };
  const newHome = () => createHomesteadGoal({ bot, anchor, variant, autonomous: true, gear: portable ? ['stone_sword'] : [], actions, skills });
  return { roof, walls, setBlock, setWatcher: fn => { afterChange = fn; }, bot, state, ctx, newHome, events, worked };
}

test('roof stone gathers apply protection before the native candidate cap', async () => {
  const blocks = new Map();
  const rock = (x, z) => {
    const position = new Vec3(x, anchor.y, z);
    blocks.set(posKey(position), { name: 'stone', position });
    return position;
  };
  for (let i = 0; i < 161; i++) rock(i % 14, Math.floor(i / 14));
  const player = rock(16, 0), protectedBlock = rock(17, 0), recent = rock(18, 0), stock = rock(19, 0);
  const bot = {
    entity: { position: new Vec3(0, anchor.y, 0) },
    registry: { blocksByName: { stone: { id: 1, name: 'stone' } } },
    blockAt: p => blocks.get(posKey(p)),
    findBlocks: ({ matching, count, useExtraInfo }) => {
      assert.deepEqual(matching, [1]);
      return [...blocks.values()].filter(b => !useExtraInfo || useExtraInfo(b)).slice(0, count).map(b => b.position);
    },
    companionPlayerBlock: p => p.equals(player),
    companionProtectBlock: b => b.position.equals(protectedBlock),
    companionPlacedRecently: p => p.equals(recent),
  };
  const ctx = { adapt: {}, record() {} };
  const options = { blocks: n => n === 'stone', blacklist: new Map(), exclude: p => p.x < 14, radius: 128,
    selectTarget: candidates => {
      assert.deepEqual(candidates.map(b => b.position), [stock]);
      return { ok: false, reason: 'no_target_selected' };
    } };
  assert.equal((await gatherOne(bot, ctx, options)).reason, 'no_target_in_range');
  assert.equal((await gatherOne(bot, ctx, { ...options, eligibleFirst: true })).reason, 'no_target_selected');
});

async function finish(home, fixture) {
  for (let n = 0; n < 95 && !home.isDone(fixture.state); n++) await home.run(fixture.ctx);
  assert.equal(home.status(fixture.state).usable, true);
}

for (const [material, stock] of [['cobblestone', { cobblestone: 45, dirt: 0 }], ['sandstone', { sand: 196, dirt: 0 }]]) {
  test(`carried stock and conversion build a complete 49-cell ${material} roof through the native planner`, async () => {
    const fixture = site({ materials: stock, widerStone: material === 'cobblestone' });
    const home = fixture.newHome();
    await finish(home, fixture);
    const firstRoof = fixture.events.findIndex(e => e.type === 'build' && e.what === 'roof');
    const firstWoodSearch = fixture.events.findIndex(e => e.type === 'adaptation_use' && e.task === 'wood');
    assert.ok(firstRoof >= 0 && (firstWoodSearch < 0 || firstRoof < firstWoodSearch));
    assert.deepEqual(new Set(fixture.roof.map(p => fixture.bot.blockAt(p).name)), new Set([material]));
    assert.equal(home.needsCleanup(), false);
    if (material === 'cobblestone') {
      assert.deepEqual(fixture.worked.filter(e => e.kind === 'search').map(e => e.radius),
        [48, 128, 48, 128, 48, 128, 48, 128, 48, 128]);
      assert.equal(fixture.worked.filter(e => e.kind === 'gather' && e.block === 'stone').length, 5);
      assert.ok(!fixture.events.some(e => e.type === 'home_roof_material_changed'));
    } else {
      assert.ok(!fixture.worked.some(e => e.kind === 'gather'));
      assert.equal(fixture.worked.reduce((n, e) => n + (e.kind === 'craft' ? e.times : 0), 0), 49);
      assert.equal(fixture.state.inventory.sand, 0);
    }
  });
}

test('a plentiful wood supply keeps the regular plank roof when nonwood stock is also available', async () => {
  const fixture = site({ materials: { oak_planks: 64, cobblestone: 64, sand: 256 } });
  const home = fixture.newHome();
  await finish(home, fixture);
  assert.deepEqual(new Set(fixture.roof.map(p => fixture.bot.blockAt(p).name)), new Set(['oak_planks']));
  assert.ok(!fixture.events.some(e => e.type === 'home_roof_fallback'));
});

function ownedRoof(fixture, selected, material = 'roof_cobblestone') {
  return {
    roofMaterial: material,
    owned: Object.fromEntries(selected.map(p => {
      const b = fixture.bot.blockAt(p);
      return [posKey(p), { position: p, name: b.name, stateId: b.stateId }];
    })),
  };
}

test('a restored mixed roof is usable only with allowed full blocks in every panel', () => {
  const fixture = site();
  const allowed = ['oak_planks', 'sandstone', 'dirt', 'cobbled_deepslate', 'granite', 'cobblestone'];
  fixture.roof.forEach((p, i) => fixture.setBlock(p, allowed[i % allowed.length]));
  const home = fixture.newHome();
  home.restoreConstruction(ownedRoof(fixture, fixture.roof));
  assert.equal(home.status(fixture.state).usable, true);
  assert.equal(home.protects(fixture.roof[2]), true);
  for (const bad of ['sand', 'gravel', 'diamond_ore', 'gold_block', 'air']) {
    fixture.setBlock(fixture.roof[2], bad);
    assert.equal(home.status(fixture.state).usable, false, bad);
  }
  const hillside = site({ variant: 'hillside' });
  hillside.roof.forEach(p => hillside.setBlock(p, 'stone'));
  const cave = hillside.newHome();
  cave.restoreConstruction({ roofMaterial: 'dirt' });
  assert.equal(cave.status(hillside.state).usable, true);
  assert.deepEqual(cave.memory.materialFallbacks, {});
  assert.deepEqual(home.memory.materialFallbacks, { roof: { reason: 'legacy_roof_material' } });
});

test('wood maintenance closes one panel at a time and keeps a persisted cap on interruption', async () => {
  const fixture = site({ materials: { oak_planks: 20 }, onRoof: true });
  const stone = fixture.roof.filter(p => p.x === 2 && [2, 3].includes(p.z));
  fixture.roof.forEach(p => fixture.setBlock(p, stone.includes(p) ? 'cobblestone' : 'oak_planks'));
  let home = fixture.newHome();
  home.restoreConstruction(ownedRoof(fixture, stone));
  assert.equal(home.status(fixture.state).finished, true);
  const controller = new AbortController();
  const alwaysCovered = () => {
    const gaps = fixture.roof.filter(p => fixture.bot.blockAt(p).name === 'air');
    assert.equal(gaps.length <= 1, true);
    for (const p of gaps) assert.equal(fixture.bot.blockAt(above(p)).name, 'oak_planks');
  };
  let touched;
  fixture.setWatcher((p, item) => {
    alwaysCovered();
    if (p.y === 66 && item === 'air') { touched = p; controller.abort(); }
  });
  fixture.state.isDay = false;
  assert.equal(home.wantsRoofWood(fixture.state), false);
  fixture.state.isDay = true;
  fixture.state.inventory.oak_planks = 2;
  assert.equal(home.wantsRoofWood(fixture.state), false);
  fixture.state.inventory.oak_planks = 20;
  assert.equal((await home.roofWoodGoal().run({ ...fixture.ctx, signal: controller.signal })).ok, false);
  assert.equal(fixture.bot.blockAt(touched).name, 'air');
  assert.equal(fixture.bot.blockAt(above(touched)).name, 'oak_planks');
  assert.equal(home.protects(above(touched)), true);
  assert.equal(home.status(fixture.state).finished, true);
  const saved = JSON.parse(JSON.stringify({ materialFallbacks: home.memory.materialFallbacks,
    owned: home.memory.owned, temporary: home.memory.temporary }));
  home = fixture.newHome();
  home.memory.established = true;
  home.restoreConstruction(saved);
  fixture.setWatcher(alwaysCovered);
  const first = home.roofWoodGoal();
  assert.equal((await first.run(fixture.ctx)).ok, true);
  assert.equal(first.isDone(fixture.state), true);
  assert.equal(fixture.bot.blockAt(above(touched)).name, 'air');
  assert.equal(fixture.bot.blockAt(touched).name, 'oak_planks');
  assert.equal(stone.filter(p => fixture.bot.blockAt(p).name === 'cobblestone').length, 1);
  assert.equal((await home.roofWoodGoal().run(fixture.ctx)).ok, true);
  assert.deepEqual(home.memory.materialFallbacks, {});
  assert.equal(Object.keys(home.memory.temporary).length, 0);
  assert.equal(fixture.events.filter(e => e.type === 'home_roof_wood_replaced').length, 2);
});

test('wood maintenance leaves a player-claimed roof panel alone', async () => {
  const fixture = site({ materials: { oak_planks: 20 }, onRoof: true });
  const claimed = fixture.roof.find(p => p.x === 2 && p.z === 2);
  fixture.roof.forEach(p => fixture.setBlock(p, p === claimed ? 'cobblestone' : 'oak_planks'));
  const home = fixture.newHome();
  home.restoreConstruction(ownedRoof(fixture, [claimed]));
  fixture.bot.companionPlayerBlock = (p) => posKey(p) === posKey(claimed);
  assert.equal(home.status(fixture.state).finished, true);
  assert.equal(home.wantsRoofWood(fixture.state), false);
  assert.equal((await home.roofWoodGoal().run(fixture.ctx)).skipped, 'roof_wood_unavailable');
  assert.deepEqual(fixture.worked, []);
});

test('roof wood is ineligible until both iron and diamond cards can finish', () => {
  const { bot } = site();
  const { cards } = createProgression({ bot, kb: KNOWLEDGE });
  const roof = cards.find(c => c.id === 'home_roof_wood');
  const diamond = cards.find(c => c.id === 'diamond_tools');
  const memory = { homestead: { wantsRoofWood: () => true }, wheatFarmDone: true };
  const inventory = { iron_pickaxe: 1, iron_sword: 1, shield: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1 };
  const state = { inventory, health: 20, food: 20, isDay: true };
  assert.equal(chooseNext(state, memory, [roof, diamond], { stage: 3 }).card, diamond);
  Object.assign(inventory, { diamond_pickaxe: 1, diamond_sword: 1 });
  assert.equal(roof.requires(state, memory), false, 'iron boots are still missing');
  inventory.iron_boots = 1;
  assert.equal(roof.requires(state, memory), true);
  assert.equal(roof.requires(state, { ...memory, homePending: true }), false);
});

test('seed 2 places a sandstone wall corner from the 56 blocks already carried', async () => {
  const fixture = site({ materials: { cobblestone: 0, sandstone: 56, oak_planks: 49 } });
  const corner = fixture.walls[0];
  fixture.setBlock(corner, 'air');
  const home = fixture.newHome();
  await home.run(fixture.ctx);
  assert.equal(fixture.bot.blockAt(corner).name, 'sandstone');
  assert.deepEqual(fixture.worked, [{ kind: 'place', position: posKey(corner), item: 'sandstone' }]);
  assert.equal(fixture.events.some(e => e.type === 'home_material_acquisition'), false);
});

test('a wall retry reads the cell and inventory after the last sandstone is consumed', async () => {
  const fixture = site({ materials: { sandstone: 1, oak_planks: 49 }, unconfirmed: () => true });
  const corner = fixture.walls[0];
  fixture.setBlock(corner, 'air');
  const result = await fixture.newHome().run(fixture.ctx);
  const [planned, unconfirmed, retry] = fixture.events.filter(e => ['build', 'place_failed'].includes(e.type));
  assert.equal(planned.material, 'sandstone');
  assert.equal(retry.retry, true);
  assert.equal(retry.material, undefined);
  assert.equal(fixture.bot.blockAt(corner).name, 'air');
  assert.equal(fixture.state.inventory.sandstone, 0);
  assert.equal(result.kind, 'material');
  assert.deepEqual(result.facts.need, { wall: 1 });
  assert.equal(result.facts.carried.sandstone, 0);
  assert.deepEqual([planned.attemptId, unconfirmed.attemptId, retry.attemptId], Array(3).fill(result.attemptId));
  assert.equal(fixture.worked.length, 0);
});

test('the same wall retry recognizes a late server confirmation with an empty stack', async () => {
  let placement;
  const fixture = site({ materials: { sandstone: 1, oak_planks: 49 },
    unconfirmed(position, item) { placement = [position, item]; return true; },
    afterWalk(setBlock) { if (placement) setBlock(...placement); } });
  const corner = fixture.walls[0];
  fixture.setBlock(corner, 'air');
  const result = await fixture.newHome().run(fixture.ctx);
  assert.deepEqual(result, { ok: true, progress: false });
  assert.equal(fixture.bot.blockAt(corner).name, 'sandstone');
  assert.equal(fixture.state.inventory.sandstone, 0);
  const attempts = fixture.events.filter(e => e.type === 'build');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].attemptId, attempts[1].attemptId);
  assert.equal(fixture.worked.length, 0);
});

test('wall mixes carried preferred materials with on-site sandstone conversion and protects finished panels', async () => {
  const fixture = site({ materials: { cobblestone: 1, sand: 4, sandstone: 1, dirt: 64, oak_planks: 49 } });
  const [first, second, third, oldDirt, oldSandstone] = fixture.walls;
  for (const cell of [first, second, third]) fixture.setBlock(cell, 'air');
  fixture.setBlock(oldDirt, 'dirt');
  fixture.setBlock(oldSandstone, 'sandstone');
  const home = fixture.newHome();
  for (let n = 0; n < 4; n++) await home.run(fixture.ctx);
  assert.deepEqual([first, second, third, oldDirt, oldSandstone].map(p => fixture.bot.blockAt(p).name),
    ['cobblestone', 'sandstone', 'sandstone', 'dirt', 'sandstone']);
  assert.equal(fixture.worked.filter(e => e.kind === 'craft').length, 1);
  assert.ok(!fixture.worked.some(e => e.kind === 'gather' || e.kind === 'dig'));
});

test('wall tries preferred acquisition before entering the dirt fallback if it has no pickaxe', async () => {
  const fixture = site({ materials: { stone_pickaxe: 0, oak_planks: 49 } });
  const corner = fixture.walls[0];
  fixture.setBlock(corner, 'air');
  const home = fixture.newHome();
  await home.run(fixture.ctx);
  assert.equal(fixture.bot.blockAt(corner).name, 'air');
  assert.equal(fixture.events.find(e => e.type === 'home_material_acquisition').reason, 'no_tool');
  await home.run(fixture.ctx);
  assert.equal(fixture.bot.blockAt(corner).name, 'dirt');
  assert.deepEqual(home.memory.materialFallbacks, { wall: { reason: 'no_tool' } });
});

test('every placement purpose excludes gravity blocks, ores, logs and workstations', () => {
  for (const purpose of ['wall', 'roof', 'cave_wall', 'filler', 'seal']) {
    for (const name of ['sand', 'red_sand', 'gravel', 'white_concrete_powder', 'iron_ore', 'deepslate_coal_ore',
      'oak_log', 'stripped_spruce_log', 'crafting_table', 'furnace']) {
      assert.equal(accepts(purpose, name), false, purpose + ' ' + name);
    }
  }
});

test('local material promises subtract stone tool, furnace and furniture costs', () => {
  const stock = budget({ cobblestone: 8, cobbled_deepslate: 2, sandstone: 5, birch_planks: 4, oak_log: 2 }, { stone: 10, wood: 9 });
  assert.equal(supply('wall', stock, {}).primary, 5);
  assert.equal(supply('roof', stock, {}).primary, 3);
});

test('inventory-grid supply combines stripped and regular wood without counting loose bamboo', () => {
  const stock = budget({ oak_log: 1, stripped_oak_wood: 2, crimson_stem: 1, bamboo_block: 1, bamboo: 8 });
  assert.deepEqual(stock.craftable, {
    oak_planks: { count: 12, yields: 4 }, crimson_planks: { count: 4, yields: 4 }, bamboo_planks: { count: 2, yields: 2 },
  });
  assert.equal(supply('roof', stock, {}).primary, 18);
});

test('ample cobblestone and planks preserve the north-facing 7×7 shell materials', async () => {
  const fixture = site({ materials: { cobblestone: 64, sandstone: 56, oak_planks: 64 } });
  for (const p of fixture.walls) fixture.setBlock(p, 'air');
  const home = fixture.newHome();
  for (let n = 0; n < 110 && !home.isDone(fixture.state); n++) await home.run(fixture.ctx);
  assert.equal(home.status(fixture.state).usable, true);
  assert.ok(fixture.walls.every(p => fixture.bot.blockAt(p).name === 'cobblestone'));
  assert.ok(fixture.roof.every(p => fixture.bot.blockAt(p).name === 'oak_planks'));
  assert.equal(fixture.events.some(e => e.type === 'home_material_acquisition'), false);
});


test('the compact site crafts a stone sword outside and picks up the temporary table', async () => {
  const fixture = site({ variant: 'compact', materials: { cobblestone: 2, stick: 1 }, portable: true });
  const home = fixture.newHome();
  const threshold = home.memory.house.furniture.door.position;
  fixture.setBlock(new Vec3(threshold.x, threshold.y - 1, threshold.z), 'air');
  for (let i = 0; i < 3 && !fixture.state.inventory.stone_sword; i++) assert.equal((await home.run(fixture.ctx)).ok, true);
  assert.equal(fixture.state.inventory.stone_sword, 1);
  assert.equal(fixture.state.inventory.crafting_table, 1);
  assert.deepEqual(fixture.events.filter(e => e.type === 'portable_table').map(e => e.action), ['place', 'pick_up']);
});


test('R4.1 seed 2 uses its first carried sandstone roof block before gathering wood', async () => {
  const fixture = site({ materials: { sandstone: 72, dirt: 1 } });
  const home = fixture.newHome();
  for (let i = 0; i < 7 && !fixture.events.some(e => e.type === 'build' && e.what === 'roof'); i++) {
    await home.run(fixture.ctx);
  }
  assert.equal(fixture.events.find(e => e.type === 'build' && e.what === 'roof')?.material, 'sandstone');
  assert.ok(fixture.roof.some(p => fixture.bot.blockAt(p).name === 'sandstone'));
  assert.ok(!fixture.events.some(e => e.type === 'home_material_acquisition' && e.purpose === 'roof' && e.key === 'log'));
});
