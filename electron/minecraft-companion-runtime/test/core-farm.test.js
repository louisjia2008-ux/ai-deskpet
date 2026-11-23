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
    if (p.y === 63) return sown.has(`${p.x},62,${p.z}`) ? { name: 'wheat', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' };
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

test('seed 3 dry soil (54,91,75) is skipped; water at level or one higher irrigates within four blocks', () => {
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
  assert.deepEqual(choosePlots(blockAt, center), []);
  assert.deepEqual(choosePlots(blockAt, center, { findWater: () => [water] }),
    [plots[1], plots[2]].map(p => ({ ...p, hydrated: true })));
  const driedOut = p => same(p, water) ? { name: 'air', boundingBox: 'empty' } : blockAt(p);
  assert.deepEqual(choosePlots(driedOut, center, { findWater: () => [water] }), []);
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
