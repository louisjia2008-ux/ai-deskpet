'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
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
  const { Vec3 } = require('vec3');
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
