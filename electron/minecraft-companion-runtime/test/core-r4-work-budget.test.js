'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createForaging, localOpportunity, opportunityAllowed } = require('../core/work-budget');
const { createScheduleBackoff } = require('../core/schedule-backoff');

const point = x => new Vec3(x, 65, 0);
const botAt = x => Object.assign(new EventEmitter(), { entity: { position: point(x), isInWater: false },
  blockAt: () => ({ name: 'air' }) });
const seen = bot => ({ position: bot.entity.position, timeOfDay: 3_000, dimension: 'overworld', food: 8, health: 20 });

test('an opportunistic action must fit its route radius, daylight and work allowance', async () => {
  const bot = botAt(0);
  const state = seen(bot);
  assert.equal(opportunityAllowed(bot, state, point(7)), true);
  assert.equal(opportunityAllowed(bot, state, point(9)), false);
  assert.equal(opportunityAllowed(bot, state, point(7), 401), false);
  assert.equal(opportunityAllowed(bot, { ...state, timeOfDay: 11_700 }, point(7)), false);
  assert.equal(opportunityAllowed(bot, { ...state, inWater: true }, point(7)), false);
  bot.blockAt = () => ({ name: 'water' });
  assert.equal(opportunityAllowed(bot, state, point(7)), false);
  const result = await localOpportunity(bot, { perceive: () => state }, 'hunt', point(9), () => assert.fail('ran out-of-budget work'));
  assert.equal(result.wait.reason, 'work_budget');
});

test('R3.2 seed 2, L199–L340: provisioning binds targets and movement before home selection', async () => {
  const bot = botAt(0);
  const calls = [];
  const forage = createForaging({ bot, mobs: ['pig'], dropMatch: () => true, skills: {
    async huntOne(_bot, ctx) {
      calls.push([ctx.workArea(point(80)), ctx.workArea(point(101)), ctx.workArea(point(600))]);
      if (bot.entity.position.x === 0) return { ok: true };
      bot.entity.position = point(98);
      bot.emit('physicsTick');
      assert.equal(ctx.signal.aborted, true);
      return { ok: false, reason: 'aborted' };
    },
  } });
  const ctx = { perceive: () => seen(bot) };
  assert.equal((await forage(ctx)).ok, true);
  bot.entity.position = point(88);
  assert.equal((await forage(ctx)).wait.reason, 'work_budget');
  assert.deepEqual(calls, [[true, false, false], [true, false, false]]);
});

test('card and action timing use one backoff, and interrupted work does not spend it', () => {
  let at = 1_000;
  const backoff = createScheduleBackoff(() => at);
  const { until } = backoff.fail('card:farm', 2_000, 10_000);
  assert.equal(until, 3_000);
  backoff.observe('provision', { ok: false, kind: 'interrupted' }, { base: 2_000, cap: 10_000 });
  assert.equal(backoff.blocked('body:provision'), 0);
  backoff.observe('provision', { ok: false, kind: 'start' }, { base: 2_000, cap: 10_000 });
  assert.equal(backoff.blocked('body:provision'), 3_000);
  assert.equal(backoff.get('body:provision').count, 0);
  at += 2_000;
  assert.deepEqual(backoff.state('card:'), []);
});
