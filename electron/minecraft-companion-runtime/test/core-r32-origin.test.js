'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('../core/actions');
const skills = require('../core/skills');
const { createAttempt, failure, settleRoute } = require('../core/action-result');

function routeBot(position) {
  const bot = new EventEmitter();
  bot.entity = { position, onGround: true, isInWater: false };
  bot.blockAt = () => ({ name: bot.entity.isInWater ? 'water' : 'air' });
  bot.pathfinder = { setGoal() {} };
  return bot;
}

function move(bot, position, wet) {
  Object.assign(bot.entity, { position, isInWater: wet, onGround: !wet });
  bot.emit('physicsTick');
}

const timedOut = () => { throw Object.assign(new Error('native travel deadline'), { code: 'path_timeout' }); };

test('seed 2 relocation L1936–L2195 retains the route that entered the water across wet retries', async () => {
  const dry = new Vec3(612.5, 63, 34.5), water = new Vec3(611.5, 61, 35.5);
  const bot = routeBot(dry), events = [];
  const ctx = () => createAttempt({ behavior: 'goal:homestead', record: (type, data) => events.push({ type, ...data }) });
  const shoal = new goals.GoalNearXZ(592, 55, 3), alternative = new goals.GoalBlock(610, 63, 33);
  bot.pathfinder.goto = async () => {
    move(bot, water, true);
    move(bot, water.offset(0, 0, 2), true);
    timedOut();
  };
  const first = await actions.goTo(bot, ctx(), shoal);
  assert.equal(first.kind, 'target');
  assert.equal(first.facts.enteredWater, true);
  assert.deepEqual(first.facts.waterPosition, { ...water });
  assert.deepEqual(first.facts.routeStart, dry);
  assert.equal(first.facts.target.failures, 1);
  bot.pathfinder.goto = timedOut;
  const retry = await actions.goTo(bot, ctx(), shoal);
  assert.equal(retry.kind, 'target');
  assert.equal(retry.facts.source, 'water');
  assert.match(retry.facts.routeCaused, /592,55$/);
  assert.equal(retry.facts.waterAt, first.facts.waterAt);
  assert.equal(retry.facts.target.excluded, true);
  assert.notEqual(retry.attemptId, first.attemptId);
  bot.pathfinder.goto = async goal => {
    assert.equal(goal, alternative);
    move(bot, new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5), false);
  };
  assert.equal((await actions.goTo(bot, ctx(), shoal)).reason, 'choose_another_target');
  assert.equal((await actions.goTo(bot, ctx(), alternative)).ok, true);
  assert.equal(events.filter(e => e.type === 'target_excluded').length, 1);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('seed 2 pursuit L2239 excludes the same moving animal after the second water-route failure', async (t) => {
  const dry = new Vec3(589.5, 63, -36.5), bot = routeBot(dry);
  const rabbit = { id: 12, name: 'rabbit', position: new Vec3(579.66, 63, -93.34) };
  const other = { id: 13, name: 'rabbit', position: new Vec3(625.5, 63, -96.5) };
  bot.entities = { 12: rabbit, 13: other };
  const hunts = [];
  t.mock.method(actions, 'goNear', async (robot, ctx, pos, range, options) => {
    hunts.push(options.routeEntity);
    return actions.goTo(robot, ctx, new goals.GoalNear(pos.x, pos.y, pos.z, range), options);
  });
  let journeys = 0;
  bot.pathfinder.goto = async () => {
    if (journeys++ === 0) move(bot, new Vec3(590.5, 62, -38.5), true);
    timedOut();
  };
  const hunt = () => skills.huntOne(bot, { behavior: 'provision', record() {} },
    { mobs: ['rabbit'], dropMatch: () => true, radius: 96, targetGoal: 'stock_food' });
  assert.ok((await hunt()).facts.enteredWater);
  rabbit.position = rabbit.position.offset(1, 0, -2);
  const second = await hunt();
  assert.ok(second.facts.routeCaused);
  assert.ok(second.facts.target.excluded);
  const third = await hunt();
  assert.equal(third.kind, 'start');
  assert.equal(third.facts.routeCaused, undefined);
  assert.deepEqual(hunts, [12, 12, 13]);
});

test('a wet retry beyond eight blocks needs known contiguous water to inherit the destination', async () => {
  for (const gap of [false, true]) {
    const bot = routeBot(new Vec3(-0.5, 63, 0.5));
    bot.blockAt = cell => ({ name: cell.y === 62 && cell.z === 0 && cell.x >= 0 && cell.x <= 12
      && !(gap && cell.x === 6) ? 'water' : 'air' });
    const goal = new goals.GoalBlock(30, 63, 0);
    const run = () => actions.goTo(bot, { behavior: 'goal:homestead' }, goal);
    bot.pathfinder.goto = async () => { move(bot, new Vec3(0.5, 62, 0.5), true); timedOut(); };
    assert.ok((await run()).facts.enteredWater);
    move(bot, new Vec3(12.5, 62, 0.5), true);
    bot.pathfinder.goto = timedOut;
    const result = await run();
    assert.equal(result.kind, gap ? 'start' : 'target');
    assert.equal(Boolean(result.facts.routeCaused), !gap);
  }
});

test('provision L2224–L2225 captures the next native leg after an internal dry landing', async () => {
  const from = new Vec3(600.5, 62, -33.5), shore = new Vec3(600.5, 63, -32.5);
  const bot = routeBot(from), goal = new goals.GoalBlock(579, 63, -94);
  move(bot, from, true);
  bot.pathfinder.goto = async () => { move(bot, new Vec3(596.5, 62, -43.5), true); timedOut(); };
  const ctx = createAttempt({ behavior: 'provision' });
  const result = await settleRoute(bot, ctx, new Vec3(goal.x, goal.y, goal.z), async route => {
    move(bot, shore, false);
    return actions.goTo(bot, route, goal);
  });
  assert.equal(result.kind, 'target');
  assert.equal(result.attemptId, ctx.attemptId);
  assert.deepEqual(result.facts.routeStart, shore);
  assert.equal(result.facts.enteredWater, true);
});

test('dry-clear audit preserves only continuous wet retries and new dry-to-wet legs', async () => {
  for (const scenario of ['stayed_wet', 'landed_during_same_leg', 'landed_between_routes', 'new_wet_leg_after_landing']) {
    const bot = routeBot(new Vec3(0.5, 64, 0.5)), goal = new goals.GoalBlock(12, 64, 0);
    const dry = new Vec3(4.5, 64, 0.5), water = new Vec3(4.5, 63, 0.5);
    const events = [], ctx = () => ({ behavior: 'goal:homestead', record: (type, data) => events.push({ type, ...data }) });
    const run = () => actions.goTo(bot, ctx(), goal);
    bot.pathfinder.goto = async () => { move(bot, new Vec3(3.5, 63, 0.5), true); timedOut(); };
    assert.equal((await run()).facts.enteredWater, true, scenario);
    if (scenario === 'landed_between_routes') {
      move(bot, dry, false);
      move(bot, water, true);
    }
    bot.pathfinder.goto = async () => {
      if (scenario === 'landed_during_same_leg') move(bot, dry, false);
      if (scenario === 'new_wet_leg_after_landing') move(bot, water, true);
      timedOut();
    };
    const retry = scenario === 'new_wet_leg_after_landing'
      ? await settleRoute(bot, ctx(), goal, route => {
        move(bot, dry, false);
        return actions.goTo(bot, route, goal);
      })
      : await run();
    const stayedWet = scenario === 'stayed_wet', newWetLeg = scenario === 'new_wet_leg_after_landing';
    assert.equal(retry.kind, stayedWet || newWetLeg ? 'target' : 'start', scenario);
    assert.equal(Boolean(retry.facts.routeCaused), stayedWet, scenario);
    assert.equal(Boolean(retry.facts.enteredWater), newWetLeg, scenario);
    if (newWetLeg) assert.deepEqual(retry.facts.routeStart, dry);
    assert.equal(events.filter(e => e.type === 'target_excluded').length, Number(stayedWet || newWetLeg), scenario);
    move(bot, dry, false);
    assert.equal(bot.listenerCount('physicsTick'), 0, scenario);
  }
});

test('dry confirmation and a different destination clear attribution; pre-existing water and protected cells cannot exclude work', async () => {
  const dry = new Vec3(0.5, 64, 0.5), water = new Vec3(3.5, 63, 0.5);
  const bot = routeBot(dry), events = [];
  const ctx = () => createAttempt({ behavior: 'goal:homestead', record: (type, data) => events.push({ type, ...data }) });
  const protectedCell = new goals.GoalBlock(10, 64, 0), other = new goals.GoalBlock(15, 64, 0);
  bot.companionPlayerBlock = p => p.x === protectedCell.x;
  bot.pathfinder.goto = async () => { move(bot, water, true); timedOut(); };
  const first = await actions.goTo(bot, ctx(), protectedCell);
  assert.equal(first.kind, 'target');
  assert.equal(first.facts.target, undefined);
  assert.equal((await actions.goTo(bot, ctx(), other)).kind, 'start');
  assert.equal((await actions.goTo(bot, ctx(), protectedCell)).kind, 'start');
  move(bot, dry, false);
  assert.equal((await actions.goTo(bot, ctx(), protectedCell)).facts.enteredWater, true);
  bot.pathfinder.goto = async goal => move(bot, new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5), false);
  await actions.goTo(bot, ctx(), other);
  move(bot, water, true);
  bot.pathfinder.goto = timedOut;
  assert.equal((await actions.goTo(bot, ctx(), protectedCell)).kind, 'start');
  assert.equal((await actions.goTo(bot, { ...ctx(), rescue: 'home_escape' }, protectedCell)).kind, 'target');
  assert.deepEqual(events, []);
  const attempt = createAttempt({}, { inWater: false });
  assert.equal(failure('path_timeout', {}, attempt, { inWater: true }).kind, 'target');
});
