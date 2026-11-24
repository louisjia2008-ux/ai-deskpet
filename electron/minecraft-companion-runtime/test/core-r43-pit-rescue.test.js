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

function sandstoneShaft(top = new Vec3(101, 72, 78), rim = top.y) {
  // R4.2 seed 2 L3202–3298. The opened lid is one block below the mouth.
  const state = new Map([[top.offset(0, -1, 0).toString(), 'sandstone']]);
  const moves = [], cuts = [], durations = [];
  const nav = {
    movements: { allow1by1towers: false, scafoldingBlocks: [] },
    async goto(goal) {
      moves.push(goal instanceof goals.GoalY ? 'pathfinder' : 'stair');
      if (goal instanceof goals.GoalY) throw Object.assign(new Error('hand-built stairs required'), { name: 'NoPath' });
      const stand = new Vec3(goal.x, goal.y, goal.z);
      if (stand.distanceTo(bot.entity.position.floored()) > 1.5) {
        throw Object.assign(new Error('only native adjacent steps are reachable'), { name: 'NoPath' });
      }
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
      const name = state.get(point.toString()) || (point.y < (shaft ? top.y - 3 : rim) ? 'sandstone' : 'air');
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
  assert.ok(moves.length >= 3);
  assert.ok(!bot.entity.position.floored().equals(top));
  assert.ok(cuts[0].equals(top.offset(0, -1, 0)));
  assert.ok(cuts.length >= 4);
  assert.ok(durations.includes(4000), 'Minecraft 1.21.8 computes a four-second grounded hand cut');
  assert.ok(!logs.some(e => e.type === 'pit_rescue_alert'));
});

test('a stair reaching the exit height waits for native landing before exhaustion', async () => {
  const { bot, top } = sandstoneShaft();
  const goto = bot.pathfinder.goto;
  const logs = [];
  bot.pathfinder.goto = async goal => {
    await goto(goal);
    if (goal.y === top.y) {
      bot.entity.position.y += 0.024;
      bot.entity.onGround = false;
      setTimeout(() => { bot.entity.position.y = top.y; bot.entity.onGround = true; }, 125);
    }
  };
  const result = await actions.surface(bot, {
    record: (type, fields) => logs.push({ type, ...fields }),
  }, { targetY: top.y, bunker: true });
  assert.equal(result.ok, true);
  assert.equal(bot.entity.onGround, true);
  assert.ok(!logs.some(e => e.type === 'pit_rescue_alert'));
});

test('a blocked exit emits one diagnostic and never repeats the same pit attempt', async () => {
  const { bot, top } = sandstoneShaft();
  const logs = [];
  const ctx = {
    record: (type, fields) => logs.push({ type, at: Date.now(), ...fields }),
    adapt: { run: () => assert.fail('a trapped body may not do other work') },
  };
  bot.canDigBlock = () => false;
  bot.pathfinder.goto = async () => {
    throw Object.assign(new Error('fixed closed shaft'), { name: 'NoPath' });
  };
  const options = { targetY: top.y, bunker: true };
  const action = () => actions.surface(bot, ctx, options);
  assert.equal((await action()).wait?.reason, 'pit_rescue_exhausted');
  assert.equal((await action()).wait?.reason, 'pit_rescue_exhausted');
  const trials = logs.filter(e => e.type === 'pit_escape_attempt');
  assert.ok(trials.length > 3);
  assert.equal(new Set(trials.map(e => JSON.stringify([e.episode, e.from, e.outlet, e.method, e.end]))).size, trials.length);
  assert.equal(logs.filter(event => event.type === 'pit_rescue_alert').length, 1);
  const doctor = createDoctor();
  assert.ok(logs.flatMap(event => doctor.accept(event)).some(event => event.rule === 'D12'));
});

test('the sandstone collar at Y71 requires a real standing cell at Y72', async () => {
  const top = new Vec3(144, 71, 219);
  const { bot } = sandstoneShaft(top, 72);
  const logs = [];
  const result = await skills.digOut(bot, {
    record: (type, fields) => logs.push({ type, ...fields }),
  }, { top });
  assert.equal(result.ok, true);
  assert.equal(bot.entity.onGround, true);
  assert.equal(bot.entity.position.y, 72);
  assert.ok(bot.entity.position.x !== 144.5 || bot.entity.position.z !== 219.5);
  assert.equal(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)).name, 'sandstone');
  assert.ok(logs.filter(e => e.type === 'pit_escape_attempt').every(e => e.outlet.y === 72));
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

test('consecutive dry nudges are measured from the held episode origin', async () => {
  for (const geometry of ['surface', 'water', 'covered', 'lower_trench']) {
    const { bot } = sandstoneShaft();
    bot.entity.position = new Vec3(1.5, 270, -1.493);
    bot.companionSurfaceY = 270;
    const stone = registry.blocksByName.stone.minStateId;
    const air = registry.blocksByName.air.minStateId;
    const water = registry.blocksByName.water.minStateId;
    bot.blockAt = p => {
      const cell = p.floored();
      const ground = geometry === 'lower_trench' && cell.x >= 3 ? 269 : 270;
      const state = cell.y < ground || (geometry === 'covered' && cell.y === ground + 2) ? stone
        : geometry === 'water' && cell.x >= 3 && cell.y === 270 ? water : air;
      return Object.assign(Block.fromStateId(state, 0), { position: cell });
    };
    const tracker = createSelfStuck(bot);
    tracker.force('different_targets_same_origin');
    const offsets = [0.8380728712622094, 0.967587324062209, 1.0323448627387783];
    const method = createHomeEscape({ bot, tracker, home: () => null, actions: {
      async unstick() {
        bot.entity.position.x += offsets.shift();
        if (geometry === 'lower_trench' && bot.entity.position.x >= 3) bot.entity.position.y = 269;
        return { ok: true, moved: 'nudged' };
      },
    } });
    const trace = [];
    const ctx = { record: type => trace.push(type) };
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await method.run(ctx)).ok, false);
    assert.equal((await method.run(ctx)).ok, geometry === 'surface');
    assert.equal(trace.includes('self_stuck_escaped'), geometry === 'surface');
    assert.equal(Boolean(tracker.state()), geometry !== 'surface');
    if (geometry === 'surface') assert.ok(Math.abs(bot.entity.position.x - 1.5 - 2.838005058063197) < 1e-6);
  }
});
