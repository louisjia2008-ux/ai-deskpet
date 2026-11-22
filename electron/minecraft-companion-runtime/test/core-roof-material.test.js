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
const { KNOWLEDGE } = require('../core/knowledge');

const anchor = { x: 0, y: 64, z: 0 };
const above = (p) => new Vec3(p.x, p.y + 1, p.z);

function site({ materials = {}, panels = {}, variant = 'starter', onRoof = false } = {}) {
  const blueprint = createStarterHouse(anchor, { variant });
  const roof = blueprint.blocks.filter(b => b.phase === 'roof').map(b => b.position);
  const blocks = new Map();
  const events = [], worked = [];
  const inventory = { crafting_table: 1, stone_pickaxe: 1, dirt: 2, ...materials };
  let afterChange = () => {};
  const setBlock = (p, n) => { blocks.set(posKey(p), n); afterChange(p, n); };
  for (const b of blueprint.blocks.filter(b => b.phase === 'walls')) setBlock(b.position, 'cobblestone');
  for (const [key, n] of Object.entries(panels)) blocks.set(key, n);
  const f = blueprint.furniture;
  for (const key of ['crafting_table', 'furnace', 'chest']) setBlock(f[key].position, key);
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
      return { ok: true };
    },
    async digBlock(_bot, _ctx, block, { ownedHomeRemoval } = {}) {
      assert.equal(ownedHomeRemoval?.(block), true);
      worked.push({ kind: 'dig', position: posKey(block.position), item: block.name });
      setBlock(block.position, 'air');
      return { ok: true };
    },
  };
  const skills = {
    async gatherOne(_bot, _ctx, { blocks: accepts, dropMatch }) {
      if (accepts('oak_log')) return { ok: false, reason: 'no_target_in_range' };
      const resource = [['stone', 'cobblestone'], ['grass_block', 'dirt'], ['sand', 'sand']]
        .find(([b, item]) => accepts(b) && dropMatch(item));
      assert.ok(resource, 'uses the existing gather skill and correct drop family');
      const [block, item] = resource;
      inventory[item] = (inventory[item] || 0) + 1;
      worked.push({ kind: 'gather', item, block });
      return { ok: true, gained: 1 };
    },
    async craft(_bot, _ctx, { item, times, tablePosition }) {
      assert.equal(item, 'sandstone');
      assert.equal(tablePosition, null);
      assert.ok(inventory.sand >= 4 * times);
      inventory.sand -= 4 * times;
      inventory.sandstone = (inventory.sandstone || 0) + times;
      worked.push({ kind: 'craft', item, times });
      return { ok: true };
    },
    async placeAt(_bot, _ctx, p, match) {
      assert.equal(bot.blockAt(p).name, 'air');
      const item = Object.keys(inventory).find(n => inventory[n] > 0 && match(n));
      assert.ok(item, `uses carried material at ${posKey(p)}`);
      inventory[item] -= 1;
      worked.push({ kind: 'place', position: posKey(p), item });
      setBlock(p, item);
      return { ok: true };
    },
  };
  const state = { inventory, position, isDay: true, timeOfDay: 4000, health: 20, food: 20 };
  const adapt = createAdaptation({ onEvent: e => events.push(e) }).scope(() => true);
  const ctx = { perceive: () => state, record: (type, data) => events.push({ type, ...data }), adapt };
  const newHome = () => createHomesteadGoal({ bot, anchor, variant, autonomous: true, gear: [], actions, skills });
  return { roof, setBlock, setWatcher: fn => { afterChange = fn; }, bot, state, ctx, newHome, events, worked };
}

async function finish(home, fixture) {
  for (let n = 0; n < 95 && !home.isDone(fixture.state); n++) await home.run(fixture.ctx);
  assert.equal(home.status(fixture.state).usable, true);
}

for (const [material, stock] of [['cobblestone', { cobblestone: 44 }], ['sandstone', { sand: 192 }]]) {
  test(`wood-ladder exhaustion builds a complete 49-cell ${material} roof through the native planner`, async () => {
    const fixture = site({ materials: stock });
    const home = fixture.newHome();
    await finish(home, fixture);
    const triggers = fixture.events.filter(e => e.type === 'home_roof_fallback');
    assert.deepEqual(triggers.map(e => [e.material, e.needed, e.furniture, e.wood]), [[material, 49, 0, 0]]);
    const exhausted = fixture.events.find(e => e.type === 'adaptation_exhausted' && e.task === 'wood');
    assert.ok(exhausted && fixture.events.indexOf(exhausted) < fixture.events.indexOf(triggers[0]));
    assert.deepEqual(new Set(fixture.roof.map(p => fixture.bot.blockAt(p).name)), new Set([material]));
    assert.equal(home.needsCleanup(), false);
    if (material === 'cobblestone') assert.equal(fixture.worked.filter(e => e.kind === 'gather' && e.block === 'stone').length, 5);
    else {
      assert.equal(fixture.worked.filter(e => e.kind === 'gather' && e.block === 'sand').length, 4);
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
  assert.equal(cave.memory.roofMaterial, undefined);
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
  const saved = JSON.parse(JSON.stringify({ roofMaterial: home.memory.roofMaterial,
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
  assert.equal(home.memory.roofMaterial, null);
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
  assert.equal(roof.need(state, memory), 0, 'iron boots are still missing');
  inventory.iron_boots = 1;
  assert.equal(roof.need(state, memory), 5);
  assert.equal(roof.need(state, { ...memory, homePending: true }), 0);
});
