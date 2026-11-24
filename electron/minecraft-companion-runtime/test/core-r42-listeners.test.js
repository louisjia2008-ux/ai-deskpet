'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createDeviceProjectGoal } = require('../core/goals/deviceProject');

test('two hundred device invocations release their death listener', async () => {
  const bot = new EventEmitter();
  const centre = new Vec3(0, 64, 0);
  const existing = () => {};
  bot.on('death', existing);
  const state = { inventory: {} };
  const create = () => createDeviceProjectGoal({ bot, name: 'outfit', home: { centre, chest: centre },
    device: { name: 'kit', needs: () => [], progress: () => 0, memory: { device: {} }, run: () => ({ ok: true }) } });
  for (let i = 0; i < 200; i++) {
    const goal = create();
    assert.deepEqual(bot.listeners('death'), [existing], 'constructing or scoring a card does not attach a listener');
    await goal.run({ perceive: () => state });
    assert.equal(bot.listenerCount('death'), 2);
    await goal.dispose();
    assert.deepEqual(bot.listeners('death'), [existing]);
  }
});
