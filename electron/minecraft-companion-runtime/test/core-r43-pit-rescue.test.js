'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const actions = require('../core/actions');
const skills = require('../core/skills');
const { factsOf } = require('../core/action-result');
const { createDoctor } = require('../core/doctor');
const { createHomeEscape } = require('../core/behaviors/homeEscape');
const { createSelfStuck } = require('../core/self-stuck');

function sandstoneShaft() {
  // R4.2 seed 2 L3202–3298. The opened lid is one block below the mouth.
  const top = new Vec3(101, 72, 78);
  const state = new Map([[top.offset(0, -1, 0).toString(), 'sandstone']]);
  const moves = [], cuts = [], durations = [];
  const nav = {
    movements: { allow1by1towers: false, scafoldingBlocks: [] },
    async goto(goal) {
      moves.push(goal instanceof goals.GoalY ? 'pathfinder' : 'stair');
      if (goal instanceof goals.GoalY) throw Object.assign(new Error('hand-built stairs required'), { name: 'NoPath' });
      const stand = new Vec3(goal.x, goal.y, goal.z);
      assert.equal(bot.blockAt(stand.offset(0, -1, 0)).name, 'sandstone');
      assert.equal(bot.blockAt(stand).name, 'air');
      assert.equal(bot.blockAt(stand.offset(0, 1, 0)).name, 'air');
      bot.entity.position = stand.offset(0.5, 0, 0.5);
    },
  };
  const bot = {
    game: { dimension: 'overworld' }, entity: { position: top.offset(0.5, -3, 0.5), onGround: true },
    registry, pathfinder: nav, companionSurfaceY: top.y,
    inventory: { items: () => [] },
    blockAt(p) {
      const point = p.floored();
      const shaft = point.x === top.x && point.z === top.z;
      const name = state.get(point.toString()) || (point.y < top.y - (shaft ? 3 : 0) ? 'sandstone' : 'air');
      const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0);
      block.position = point;
      return block;
    },
    canDigBlock: block => block.diggable,
    digTime(block) {
      const ms = block.digTime(null, false, false, !bot.entity.onGround, [], {});
      durations.push(ms);
      return ms;
    },
    async dig(block) {
      cuts.push(block.position.clone());
      state.set(block.position.toString(), 'air');
    },
    async equip() { assert.fail('the fixture has no tool to equip'); },
    stopDigging() {},
  };
  return { bot, top, moves, cuts, durations };
}

test('empty hands clear three sandstone steps after the bunker lid opens', async () => {
  const { bot, top, moves, cuts, durations } = sandstoneShaft();
  const logs = [];
  const result = await skills.digOut(bot, {
    record: (type, fields) => logs.push({ type, ...fields }),
    adapt: { run: () => assert.fail('physical rescue may not defer to the card ladder') },
  }, { top });
  assert.equal(result.ok, true);
  assert.equal(factsOf(result).surfaced, true);
  assert.equal(bot.entity.position.y, top.y);
  assert.deepEqual(moves, ['pathfinder', 'stair', 'stair', 'stair']);
  assert.ok(cuts[0].equals(top.offset(0, -1, 0)));
  assert.ok(cuts.length >= 4);
  assert.ok(durations.includes(4000), 'Minecraft 1.21.8 computes a four-second grounded hand cut');
  assert.ok(!logs.some(e => e.type === 'pit_rescue_alert'));
});

test('a blocked pit issues D12 and restarts at the pathfinder after its own delay', async t => {
  const { bot, top, moves } = sandstoneShaft();
  let clock = 10;
  t.mock.method(Date, 'now', () => clock);
  const logs = [];
  const ctx = {
    record: (type, fields) => logs.push({ type, at: clock, ...fields }),
    adapt: { run: () => assert.fail('a trapped body may not do other work') },
  };
  bot.companionPlayerBlock = () => true;
  const result = await actions.surface(bot, ctx, { targetY: top.y, bunker: true });
  assert.equal(result.reason, 'still_below_surface');
  assert.deepEqual(factsOf(result).tried, ['pathfinder', 'direct_pillar', 'side_stairs']);
  const doctor = createDoctor();
  assert.ok(logs.flatMap(event => doctor.accept(event)).some(event => event.rule === 'D12'));

  const stop = new AbortController();
  const retry = actions.surface(bot, { ...ctx, signal: stop.signal }, { targetY: top.y, bunker: true });
  stop.abort('fixture_stop');
  assert.equal((await retry).kind, 'interrupted');
  assert.deepEqual(moves, ['pathfinder'], 'the same pit waits before retrying');

  clock += 3000;
  bot.companionPlayerBlock = () => false;
  assert.equal((await actions.surface(bot, ctx, { targetY: top.y, bunker: true })).ok, true);
  assert.deepEqual(moves, ['pathfinder', 'pathfinder', 'stair', 'stair', 'stair']);
  assert.ok(logs.some(e => e.type === 'pit_rescue_escaped'));
});

test('two inward steps below the opening do not release a still-trapped tracker', async () => {
  const { bot, top } = sandstoneShaft();
  const tracker = createSelfStuck(bot);
  tracker.force('route_origin_path_first_step');
  const escape = createHomeEscape({ bot, home: () => null, tracker, actions: {
    async unstick() {
      bot.entity.position = top.offset(1.5, -1, 0.5);
      return { ok: false, reason: 'still_below_surface' };
    },
    async surface() { return { ok: false, reason: 'still_below_surface' }; },
  } });
  const outcome = await escape.run({ record: type => assert.notEqual(type, 'self_stuck_escaped') });
  assert.equal(outcome.reason, 'still_below_surface');
  assert.ok(tracker.state());
});
