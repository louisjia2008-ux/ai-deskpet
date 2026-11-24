'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { choosePlots } = require('../core/farming');

test('a new farm takes over the wheat already growing beside it before tilling fresh ground', () => {
  // Water at (0,62,0); dirt all round at y 62; two sown farmland cells three blocks off.
  const sown = new Set(['3,62,0', '0,62,3']);
  const blockAt = (p) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (p.y === 62) return { name: key === '0,62,0' ? 'water' : sown.has(key) ? 'farmland' : 'dirt' };
    if (p.y === 63) return { name: sown.has(`${p.x},62,${p.z}`) ? 'wheat' : 'air', boundingBox: 'empty', skyLight: 15 };
    return { name: 'stone', boundingBox: 'block' };
  };
  const plots = choosePlots(blockAt, { x: 0, y: 63, z: 0 }, { count: 4, findWater: () => [{ x: 0, y: 62, z: 0 }] });
  assert.deepEqual(plots.slice(0, 2).map((p) => `${p.x},${p.y},${p.z}`).sort(), [...sown].sort());
});

test('a station goes down on leaf litter, never on wheat, and a table left nearby is used instead', async () => {
  const { createPlannerRunner } = require('../core/goals/common');
  // Ground at y 63: wheat on every cell of the old 24, leaf litter elsewhere.
  const old = (x, z) => [2, 3, 4].includes(Math.max(Math.abs(x), Math.abs(z))) && (x === 0 || z === 0 || Math.abs(x) === Math.abs(z));
  const blocks = new Map();
  const blockAt = (p) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (blocks.has(key)) return { name: blocks.get(key), boundingBox: 'block', position: p };
    if (p.y < 64) return { name: 'dirt', boundingBox: 'block', position: p };
    if (p.y === 64) return { name: old(p.x, p.z) ? 'wheat' : 'leaf_litter', boundingBox: 'empty', position: p };
    return { name: 'air', boundingBox: 'empty', position: p };
  };
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt, registry: { blocksByName: { crafting_table: { id: 1 } } },
    findBlocks: () => [...blocks].filter(([, n]) => n === 'crafting_table').map(([k]) => new Vec3(...k.split(',').map(Number))) };
  const skills = { placeAt: async (_b, _c, p) => { blocks.set(`${p.x},${p.y},${p.z}`, 'crafting_table'); return { ok: true }; } };
  const memory = {};
  const runner = createPlannerRunner({ bot, skills, kb: {}, memory, blacklist: { has: () => false } });
  assert.equal(runner.tableHere(), false);
  const placed = await runner.placeTableNearby({});
  assert.equal(placed.ok, true, placed.reason);
  assert.equal(old(placed.position.x, placed.position.z), false, 'not on the wheat');
  // A fresh runner (the next task) finds that table rather than making another.
  const next = {};
  assert.equal(createPlannerRunner({ bot, skills, kb: {}, memory: next, blacklist: { has: () => false } }).tableHere(), true);
  assert.deepEqual(next.table, placed.position);
});

test('seed 3 dry soil (54,91,75) is used after the plots within four blocks of water', () => {
  const dry = { x: 54, y: 91, z: 75 };
  const plots = [dry, { x: 55, y: 91, z: 75 }, { x: 55, y: 90, z: 76 }, { x: 55, y: 89, z: 77 }];
  const water = { x: 59, y: 91, z: 75 };
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
  const blockAt = p => {
    if (same(p, water)) return { name: 'water' };
    if (plots.some(q => same(p, q))) return { name: same(p, dry) ? 'farmland' : 'dirt', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const center = { x: 56, y: 92, z: 75 };
  assert.deepEqual(choosePlots(blockAt, center).filter(p => p.hydrated === false).length, 4);
  assert.deepEqual(choosePlots(blockAt, center, { findWater: () => [water] }),
    [plots[1], plots[2], plots[3], dry].map((p, i) => ({ ...p, hydrated: i < 2 })));
  const driedOut = p => same(p, water) ? { name: 'air', boundingBox: 'empty' } : blockAt(p);
  assert.deepEqual(choosePlots(driedOut, center, { findWater: () => [water] }), choosePlots(blockAt, center));
});

test('seed 1 crop spaces at skylight 3–5 under a stone roof are excluded', () => {
  const near = new Vec3(0, 64, 0), plots = [1, 2, 3, 4].map(x => near.offset(x, -1, 0));
  const blockAt = p => {
    if (p.x < 1 || p.x > 4 || p.z !== 0) return null;
    if (p.y === 63) return { name: 'dirt', boundingBox: 'block' };
    if (p.y === 65 && p.x < 4) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty', skyLight: p.x + 2 };
  };
  assert.deepEqual(choosePlots(blockAt, near), [{ ...plots[3], hydrated: false }]);
});

test('seed 1 farm returns inside 48 blocks and exhausts the home-centered ground search', async () => {
  const { createFarmGoal } = require('../core/goals/farm');
  const { complete } = require('../core/action-result');
  const anchor = new Vec3(0, 64, 0), bot = { entity: { position: new Vec3(320, 64, 0) } };
  let legs = 0, checked = 0;
  const goal = createFarmGoal({ bot, home: { anchor }, mode: 'sow', plots: 1,
    actions: { async goNear(_b, _c, p) {
      assert.deepEqual(p, anchor);
      bot.entity.position = new Vec3(20, 64, 0);
      return complete();
    } },
    farming: { choosePlots: () => [], findGround(_b, from, radius, { fits }) {
      assert.equal(from, anchor);
      assert.equal(radius, 48);
      assert.equal(fits(new Vec3(49, 64, 0)), false);
      checked++;
    } },
    skills: { async explore(_b, ctx, memory) {
      assert.deepEqual(memory.around, { x: 0, z: 0, radius: 48 });
      assert.equal(ctx.pathArea(new Vec3(49, 64, 0)), false);
      bot.entity.position = new Vec3(++legs % 2 ? 30 : 20, 64, 0);
      return complete(true, { moved: 10 });
    } },
  });
  const ctx = { record() {}, perceive: () => ({ isDay: true, position: bot.entity.position, inventory: {} }) };
  assert.equal((await goal.run(ctx)).ok, true);
  for (let i = 0; i < 5; i++) assert.equal((await goal.run(ctx)).ok, true);
  const result = await goal.run(ctx);
  assert.equal(result.kind, 'material');
  assert.equal(result.reason, 'no_farmland_near_home');
  assert.equal((await goal.run(ctx)).reason, 'no_farmland_near_home');
  assert.equal(legs, 6);
  assert.equal(checked, 7);
});

test('a livable home and iron pickaxe unlock the farm while the iron tools card remains', () => {
  const { createProgression } = require('../core/goals/progression');
  const { KNOWLEDGE } = require('../core/knowledge');
  const { cards } = createProgression({ bot: { game: { dimension: 'overworld' } }, kb: KNOWLEDGE });
  const farm = cards.find(card => card.id === 'wheat_farm'), gear = cards.find(card => card.id === 'iron_tools');
  let established = false;
  const memory = { homestead: { isDone: () => established } };
  const state = { inventory: { iron_pickaxe: 1 } };
  assert.equal(Boolean(farm.requires(state, memory)), false);
  established = true;
  assert.equal(farm.requires(state, memory), true);
  assert.equal(gear.requires(state, memory), true);
  assert.equal(farm.requires({ inventory: { iron_sword: 1, shield: 1 } }, memory), false);
});

test('seed 3 farmland (56,90,73) cannot be a path landing or a construction station', () => {
  const registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry);
  const { configureMovements } = require('../core/companion');
  const { safeStand } = require('../core/home-topology');
  const soil = new Vec3(56, 90, 73), landing = soil.offset(0, 1, 0);
  for (const y of [90, 91, 93]) {
    const from = new Vec3(55, y, 73);
    from.remainingBlocks = 0;
    let material = 'stone';
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.game = { minY: -64 };
    bot.pathfinder = { setMovements(profile) { this.movements = profile; } };
    bot.blockAt = pos => {
      const name = pos.equals(soil) ? material : pos.equals(from.offset(0, -1, 0)) ? 'stone' : 'air';
      return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: pos });
    };
    const movements = configureMovements(bot);
    movements.canDig = false;
    const canLand = () => movements.getNeighbors(from).some(move => move.equals(landing));
    assert.equal(canLand(), true, `stone at start y=${y}`);
    assert.equal(safeStand(bot.blockAt, landing), true);
    material = 'farmland';
    assert.equal(canLand(), false, `farmland at start y=${y}`);
    assert.equal(safeStand(bot.blockAt, landing), false);
  }
});

test('real diagonal and drop landings respect dry routes and identify the native water move', async () => {
  const { configureMovements } = require('../core/companion');
  const { goTo } = require('../core/actions');
  const { goals } = require('mineflayer-pathfinder');
  const registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry);
  for (const [movement, y, z] of [['Diagonal', 63, 1], ['DropDown', 65, 0]]) {
    const from = new Vec3(0, y, 0), land = new Vec3(1, 62, z);
    from.remainingBlocks = 0;
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.game = { minY: -64 };
    bot.entity = { position: from.offset(0.5, 0, 0.5), onGround: true };
    bot.blockAt = p => {
      const name = p.equals(land) ? 'water' : p.equals(from.offset(0, -1, 0)) ? 'stone' : 'air';
      return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: p.clone() });
    };
    let accepted = false;
    bot.pathfinder = {
      setMovements(profile) { this.movements = profile; },
      async goto() {
        const path = [];
        this.movements[`getMove${movement}`](from, { x: 1, z }, path);
        accepted = path.some(p => p.equals(land));
        if (accepted) {
          bot.emit('path_update', { status: 'success', path });
          bot.entity.position = land.offset(0.5, 0, 0.5);
          bot.entity.onGround = false;
          bot.entity.isInWater = true;
          bot.emit('physicsTick');
        }
        throw Object.assign(new Error('fixture'), { name: 'NoPath' });
      },
    };
    configureMovements(bot).canDig = false;
    const goal = new goals.GoalBlock(land.x, land.y, land.z);
    const dry = await goTo(bot, { dryRoute: true }, goal);
    assert.equal(accepted, false, movement);
    assert.equal(dry.facts.enteredWater, undefined);
    const ordinary = await goTo(bot, {}, goal);
    assert.equal(accepted, true, movement);
    assert.equal(ordinary.facts.enteredWater, true);
    assert.equal(ordinary.facts.waterMovement, movement);
  }
});
