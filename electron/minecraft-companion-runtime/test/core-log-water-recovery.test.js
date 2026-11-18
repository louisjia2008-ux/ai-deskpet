'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { isLogScoutInWater, recoverFromLogWater } = require('../core/logWaterRecovery');

const air = { name: 'air', boundingBox: 'empty', stateId: 0, shapes: [] };
const water = { name: 'water', boundingBox: 'empty' };
const ground = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };

function simulatedBot(t, { current = false, move = true } = {}) {
  const position = new Vec3(0.5, 51, 0.5);
  const entity = { position, eyeHeight: 1.62, isInWater: true, onGround: false };
  const controls = { forward: false, jump: false };
  const readings = [];
  const waterCells = new Set(['0,0', '1,0', '1,1', '1,2', '0,2']);
  const loaded = new Set([...waterCells, '0,1', '0,3']);
  let target;
  const bot = {
    entity, health: 20, pathfinder: { setGoal(goal) { assert.equal(goal, null); } },
    blockAt(raw) {
      const point = raw.floored();
      const cell = `${point.x},${point.z}`;
      if (!loaded.has(cell)) return null;
      // The direct route to the closer dry tile is blocked by a rock wall.
      if (cell === '0,1') return point.y < 60 ? ground : air;
      if (point.y >= 56) return air;
      return waterCells.has(cell) && point.y >= 49 ? water : ground;
    },
    async lookAt(point, force) {
      assert.equal(force, true);
      target = point;
      readings.push({ point, eye: position.y + entity.eyeHeight });
    },
    setControlState(name, enabled) {
      assert.ok(Object.hasOwn(controls, name));
      controls[name] = enabled;
    },
  };
  if (move) {
    const timer = setInterval(() => {
      if (controls.jump && entity.isInWater) position.y = Math.min(55.5, position.y + 1);
      if (!controls.forward || !target) return;
      if (current) return;
      assert.ok(position.y + entity.eyeHeight >= 56, 'the bot must reach air before swimming horizontally');
      const delta = new Vec3(target.x - position.x, 0, target.z - position.z);
      const step = Math.min(0.3, delta.norm());
      if (step > 0) position.add(delta.normalize().scaled(step));
      const under = bot.blockAt(position.offset(0, -0.5, 0));
      if (under === ground && Math.floor(position.z) === 3) {
        position.y = 56;
        entity.isInWater = false;
        entity.onGround = true;
      }
    }, 12);
    t.after(() => clearInterval(timer));
  }
  return { bot, controls, readings };
}

test('a submerged scout rises four blocks and follows connected surface cells to a dry bank', async (t) => {
  const { bot, controls, readings } = simulatedBot(t);
  const events = [];
  const result = await recoverFromLogWater(bot, { record(name, detail) { events.push([name, detail]); } });

  assert.deepEqual(result, { ok: true, moved: 'swam_ashore' });
  assert.deepEqual(events.map(([name]) => name), [
    'log_water_recovery_started', 'log_water_shore_selected', 'log_water_recovered',
  ]);
  assert.equal(events[0][1].position.y, 51);
  assert.deepEqual(events[1][1].shore, new Vec3(0, 56, 3));
  assert.equal(events[1][1].waterSteps, 5);
  assert.ok(readings.every(({ point, eye }) => point.y >= eye));
  assert.equal(isLogScoutInWater(bot), false);
  assert.deepEqual(controls, { forward: false, jump: false });
});

test('cancel while submerged releases flotation and never reports arrival', async (t) => {
  const { bot, controls } = simulatedBot(t, { move: false });
  const abort = new AbortController();
  const events = [];
  const pending = recoverFromLogWater(bot, { signal: abort.signal, record(name) { events.push(name); } });
  assert.equal(controls.jump, true);
  abort.abort('pause');

  await assert.rejects(pending, { code: 'aborted', message: 'pause' });
  assert.deepEqual(events, ['log_water_recovery_started']);
  assert.deepEqual(controls, { forward: false, jump: false });
});

test('a water route with no horizontal progress times out and releases controls', async (t) => {
  const { bot, controls } = simulatedBot(t, { current: true });
  const result = await recoverFromLogWater(bot, {}, { timeoutMs: 150 });

  assert.deepEqual(result, { ok: false, reason: 'log_water_recovery_timeout' });
  assert.equal(isLogScoutInWater(bot), true);
  assert.deepEqual(controls, { forward: false, jump: false });
});
