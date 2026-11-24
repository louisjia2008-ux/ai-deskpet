'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { createAttempt } = require('../core/action-result');
const { createAdaptation } = require('../core/adaptation');
const { createHomesteadGoal } = require('../core/goals/homestead');

test('adding site failure facts leaves home-site adaptation independent of departure state', async () => {
  for (const departure of [null, 'water', 'self_stuck']) {
    const position = new Vec3(1, 64, 1);
    const state = { position, dimension: 'overworld', inventory: {},
      inWater: departure === 'water', selfStuck: departure === 'self_stuck' };
    const bot = { entity: { position, isInWater: state.inWater }, blockAt: () => null };
    const events = [];
    const adapt = createAdaptation({ onEvent: event => events.push(event) }).scope(() => true);
    const homestead = createHomesteadGoal({ bot, autonomous: true });
    const ctx = createAttempt({ adapt, perceive: () => state, record() {}, behavior: 'homestead' }, state);
    assert.equal(ctx.departure, departure);

    const result = await homestead.run(ctx);

    assert.equal(result.reason, 'no_suitable_site');
    assert.deepEqual(result.facts.attempted, ['near_flat']);
    assert.equal(events.filter(event => event.type === 'adaptation_attempt').length, 1);
    assert.equal(adapt.plan('home_site', { position }).method, 'more_earthwork');
  }
});
