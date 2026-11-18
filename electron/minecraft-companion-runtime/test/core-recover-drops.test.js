'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

function setup({ sky }) {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(10, 21, 10) },
    game: { dimension: 'overworld' },
    inventory: { items: () => [], slots: [] },
    blockAt: () => null,
  });
  bot.entities = { 0: bot.entity, 7: { id: 7, name: 'skeleton', type: 'hostile', position: new Vec3(13, 21, 10) } };
  const actions = { underground: () => false, openSky: () => sky };
  const recover = createSurvivalBehaviors({ bot, actions }).find((b) => b.name === 'recover_drops');
  bot.emit('death');
  bot.entity.position = new Vec3(0, 70, 0);
  bot.emit('spawn');
  const state = { health: 20, food: 20, position: bot.entity.position, hostiles: [], inventory: {}, sheltered: false };
  return recover.want(state);
}

test('drops left by mobs in a cave are let go; under the open sky they are fetched', () => {
  assert.equal(setup({ sky: false }), 0);
  assert.equal(setup({ sky: true }), 0.8);
});
