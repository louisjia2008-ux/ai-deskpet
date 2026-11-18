'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStance } = require('../core/stance');
const { evaluateSite } = require('../core/site');

const mob = (name, distance) => ({ name, distance });
const state = (health, inventory = {}) => ({ health, inventory });

test('the stance weighs the hostiles against weapon, armour and health', () => {
  const s = createStance({ now: () => 0 });
  // Bare hands take one zombie on at full health, not two, and not when hurt.
  assert.equal(s.read(state(20), [mob('zombie', 3)], mob('zombie', 3)).stance, 'fight');
  assert.equal(s.read(state(20), [mob('zombie', 3), mob('zombie', 5)], mob('zombie', 3)).stance, 'retreat');
  s.reset();
  assert.equal(s.read(state(12), [mob('zombie', 3)], mob('zombie', 3)).stance, 'retreat');
  s.reset();
  // An iron sword at full health takes two husks on.
  const armed = { iron_sword: 1 };
  assert.equal(s.read(state(20, armed), [mob('husk', 3), mob('husk', 4)], mob('husk', 3)).stance, 'fight');
  // The same fight at eight health is lost.
  assert.equal(s.read(state(8, armed), [mob('husk', 3), mob('husk', 4)], mob('husk', 3)).stance, 'retreat');
  s.reset();
  // A creeper about to blow is always left.
  assert.equal(s.read(state(20, { diamond_sword: 1 }), [mob('creeper', 3)], null).reason, 'creeper');
  s.reset();
  // A skeleton twelve blocks off is no fight yet, but no time to go hunting either.
  assert.equal(s.read(state(20, armed), [mob('skeleton', 12)], null).stance, 'alert');
  assert.equal(s.read(state(20, armed), [], null).stance, 'calm');
});

test('a retreat holds until the bot is clear or recovered, not the next tick', () => {
  let time = 0;
  const s = createStance({ now: () => time });
  const armed = { iron_sword: 1 };
  assert.equal(s.read(state(5, armed), [mob('zombie', 3)], mob('zombie', 3)).stance, 'retreat');
  // The zombie steps back to seven blocks and health is unchanged: still retreating.
  time = 1000;
  assert.equal(s.read(state(5, armed), [mob('zombie', 7)], null).stance, 'retreat');
  // Past the minimum and well clear of it: over.
  time = 5000;
  assert.equal(s.read(state(5, armed), [mob('zombie', 14)], null).stance, 'alert');
});

test('risk set by the model moves the line between fighting and backing off', () => {
  const s = createStance({ now: () => 0 });
  const odds = [state(12, { stone_sword: 1 }), [mob('zombie', 3), mob('zombie', 4)], mob('zombie', 3)];
  assert.equal(s.read(...odds).stance, 'retreat');
  s.reset();
  s.setRisk('bold');
  assert.equal(s.read(...odds).stance, 'fight');
  assert.throws(() => s.setRisk('reckless'), /risk/);
});

test('a house site under a rock ceiling is rejected, the same ground under the sky is not', () => {
  const ground = (ceiling) => (x, y, z) => {
    const solid = y <= 20 || (ceiling && y >= 40 && y <= 44);
    return solid ? { name: 'stone', boundingBox: 'block' } : { name: 'cave_air', boundingBox: 'empty' };
  };
  const around = { x: 4, y: 21, z: 4 };
  assert.equal(evaluateSite(ground(true), { x: 0, z: 0 }, around), null);
  assert.ok(evaluateSite(ground(false), { x: 0, z: 0 }, around));
});
