'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createNightRest, nightBudget } = require('../core/behaviors/nightRest');
const { createBrain } = require('../core/brain');

test('at the same dusk tick a 20-block return fits but a 120-block return does not', async () => {
  const centre = new Vec3(0, 70, 0);
  const bed = new Vec3(1, 70, 0);
  const bot = { entity: { position: centre.offset(20, 0, 0) }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  let tick = 11_900;
  const actions = [], events = [];
  const ctx = { perceive: () => ({ timeOfDay: tick, position: bot.entity.position }),
    record: (_type, fields) => events.push(fields) };
  const near = createNightRest({
    bot, home: () => ({ bed, centre, inside: bot.entity.position.equals(centre) }),
    shelterDoor: async (_ctx, open) => { actions.push(open ? 'open' : 'close'); return { ok: true }; },
    actions: {
      underground: () => false,
      goNear: async (_bot, travel, to, radius, { timeoutMs }) => {
        assert.ok(travel.signal);
        assert.equal(travel.dryRoute, true);
        assert.equal(timeoutMs, (12_542 - tick - 120) * 50);
        assert.equal(radius, 0);
        actions.push('return');
        bot.entity.position = to;
        return { ok: true };
      },
    },
    skills: { useBed: async (_bot, _ctx, { position }) => {
      assert.equal(position, bed);
      actions.push('sleep');
      tick = 100;
      return { ok: true };
    } },
  });
  assert.equal(near.want(ctx.perceive()), 0.8);
  assert.equal(near.taskAllowed(ctx.perceive(), 'guest_bed'), false);
  await near.run(ctx);
  await near.run(ctx);
  tick = 13_000;
  await near.run(ctx);
  await near.run(ctx);
  assert.deepEqual(actions, ['return', 'close', 'sleep', 'open']);
  assert.equal(events[0].action, 'dusk_home');
  assert.equal(events[0].returnTicks, 200);
  assert.equal(bot.companionSheltered, false);

  bot.entity.position = centre.offset(120, 0, 0);
  tick = 11_900;
  const far = createNightRest({
    bot, home: () => ({ bed, centre, inside: false }),
    actions: { underground: () => false, goNear: () => assert.fail('far return would miss dark') },
    skills: { digIn: async () => {
      const top = bot.entity.position.floored();
      bot.entity.position = top.offset(0.5, -3, 0.5);
      return { ok: true, bunker: { top } };
    } },
  });
  assert.equal(far.want(ctx.perceive()), 0.8);
  await far.run(ctx);
  assert.deepEqual(events.at(-2), { action: 'dig_in', distance: 120, ticksToDark: 642, returnTicks: 1200 });
  assert.equal(events.at(-1).action, 'dug_in');
  assert.equal(bot.companionSheltered, true);
});

test('covered cave waits overnight in a local bunker and resumes the same task after the dawn exit', async (t) => {
  const centre = new Vec3(0, 70, 0);
  const top = centre.offset(120, -3, 0);
  const bot = { entity: { position: top }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  let state = { timeOfDay: 11_900, position: top };
  const records = [], shaft = { top };
  const rest = createNightRest({
    bot, home: () => ({ centre, inside: false }),
    actions: { underground: () => true, goNear: () => assert.fail('dusk cave escape is a new exposed route') },
    skills: {
      digIn: async () => {
        bot.entity.position = top.offset(0.5, -3, 0.5);
        return { ok: true, bunker: shaft };
      },
      digOut: async (_bot, _ctx, remembered) => {
        assert.equal(remembered, shaft);
        return { ok: true };
      },
    },
  });
  const ctx = { perceive: () => state, record: (_type, fields) => records.push(fields.action) };
  const brain = createBrain({ perceive: ctx.perceive, taskAllowed: (perceived, def) => rest.taskAllowed(perceived, def.name) });
  const generation = brain.setGoal({ name: 'farm', run: () => new Promise(() => {}), isDone: () => false, progress: () => 0 });
  await brain.tick();
  assert.equal(brain.status().running, null);
  assert.equal(rest.want(state), 0.8);
  await rest.run(ctx);
  state = { ...state, timeOfDay: 13_000 };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const holding = rest.run(ctx);
  t.mock.timers.tick(3_000);
  assert.equal((await holding).wait.reason, 'sheltering_until_daylight');
  assert.equal(rest.taskAllowed(state, 'farm'), false);
  state = { ...state, timeOfDay: 100 };
  await rest.run(ctx);
  assert.equal(rest.taskAllowed(state, 'farm'), true);
  assert.equal(brain.status().goal.generation, generation);
  assert.equal(bot.companionSheltered, false);
  assert.deepEqual(records, ['dig_in', 'dug_in', 'dig_out', 'dug_out']);
  await brain.dispose();
});

test('an expired dusk return cancels traveling and the next attempt digs in locally', async (t) => {
  const centre = new Vec3(0, 70, 0);
  const bot = { entity: { position: centre.offset(20, 0, 0) }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  const events = [];
  const ctx = { perceive: () => ({ position: bot.entity.position, timeOfDay: 11_900 }),
    record: (_type, event) => events.push(event.action) };
  const rest = createNightRest({
    bot, home: () => ({ centre, inside: false }),
    actions: { goNear: (_bot, travel) => new Promise(resolve => {
      travel.signal.addEventListener('abort', () => resolve({ ok: false, kind: 'interrupted', reason: 'aborted' }));
    }) },
    skills: { digIn: async () => {
      const top = bot.entity.position.floored();
      bot.entity.position = top.offset(0.5, -3, 0.5);
      return { ok: true, bunker: { top } };
    } },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const returning = rest.run(ctx);
  await Promise.resolve();
  t.mock.timers.tick((12_542 - 11_900 - 120) * 50);
  assert.equal((await returning).reason, 'path_timeout');
  await rest.run(ctx);
  assert.deepEqual(events, ['dusk_home', 'dig_in', 'dug_in']);
});

test('the shared outing budget reserves both the departure and return legs and only applies in the overworld', () => {
  const home = new Vec3(0, 70, 0);
  const state = { position: home.offset(25, 2, 0), timeOfDay: 10_500 };
  const budget = nightBudget(state, home);
  assert.equal(budget.returnTicks, 290);
  assert.equal(budget.ticksToDark, 2042);
  assert.equal(budget.maxOutingDistance, (2042 - 290 - 120) / 20);
  assert.equal(nightBudget({ ...state, timeOfDay: 11_500 }, home).maxOutingDistance, 0);
  assert.equal(nightBudget({ ...state, dimension: 'minecraft:the_nether', timeOfDay: 13_000 }, home).maxOutingDistance, Infinity);
});


test('late underground return estimates surface plus travel and tolerates a near twilight overrun', async () => {
  const centre = new Vec3(0, 92, 0), at = new Vec3(26.7, 61, 0);
  const bot = { entity: { position: at }, game: { dimension: 'overworld' } };
  const evidence = [];
  let tick = 10_819, underground = true;
  const rest = createNightRest({ bot, home: () => ({ centre, inside: false }),
    actions: {
      underground: () => underground,
      async surface(_bot, ctx, { targetY }) {
        assert.equal(ctx.dryRoute, true);
        assert.equal(targetY, 92);
        bot.entity.position = at.offset(0, 31, 0);
        underground = false;
        tick = 12_543;
        return { ok: true };
      },
      async goNear(_bot, ctx, p) {
        assert.equal(ctx.dryRoute, true);
        assert.equal(p, centre);
        return { ok: true };
      },
    },
    skills: { digIn: () => assert.fail('return is still in flight') },
  });
  const ctx = { perceive: () => ({ position: bot.entity.position, timeOfDay: tick }),
    record: (_type, data) => evidence.push(data) };
  await rest.run(ctx);
  assert.equal(evidence[0].returnTicks, 887);
  assert.equal(evidence[0].method, 'surface');
  await rest.run(ctx);
  assert.equal(evidence[1].action, 'go_home');

  bot.entity.position = new Vec3(34, 74.65, 0);
  tick = 11_859;
  const margin = createNightRest({ bot, home: () => ({ centre, inside: false }),
    actions: { goNear: async () => ({ ok: true }) }, skills: { digIn: () => assert.fail('near return has a margin') } });
  await margin.run(ctx);
  assert.equal(evidence.at(-1).returnTicks, 687);
});

test('a failed shaft gets one enclosure, confirmed from the body and world, then opens after dawn', async () => {
  const top = new Vec3(120, 66, 0);
  const bot = { entity: { position: top.offset(0.5, 0, 0.5) }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  const events = [];
  let tick = 11_000, attempts = 0, opened = 0;
  const rest = createNightRest({ bot, home: () => ({ centre: new Vec3(0, 70, 0) }),
    skills: {
      async digIn(_bot, ctx) { assert.equal(ctx.dryRoute, true); attempts++; return { ok: false, reason: 'no_bunker_spot' }; },
      async enclose(_bot, _ctx, shelter) {
        assert.deepEqual(shelter.top, top);
        shelter.placed.push({ position: top.offset(1, 0, 0), name: 'cobblestone' });
        return { ok: true };
      },
      async openEnclosure(_bot, _ctx, shelter) {
        assert.equal(shelter.placed.length, 1);
        opened++;
        return { ok: true };
      },
    },
  });
  const ctx = { perceive: () => ({ timeOfDay: tick, position: bot.entity.position }),
    record: (_type, data) => events.push(data.action) };
  assert.equal((await rest.run(ctx)).reason, 'no_bunker_spot');
  await rest.run(ctx);
  assert.equal(bot.companionSheltered, true);
  tick = 100;
  await rest.run(ctx);
  assert.equal(bot.companionSheltered, false);
  assert.deepEqual([attempts, opened], [1, 1]);
  assert.deepEqual(events, ['dig_in', 'enclosed', 'enclosure_opened']);
});


test('R4.2 far mine waits out a jump before committing the enclosure position', async () => {
  const top = new Vec3(120, 262, 0);
  const bot = { entity: { position: top.offset(0.5, 0, 0.5), onGround: true },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  const events = [];
  const ctx = { perceive: () => ({ timeOfDay: 13000, position: bot.entity.position }),
    record: (_type, event) => events.push(event.action) };
  const rest = createNightRest({ bot, home: () => ({ centre: null }), skills: {
    digIn: async () => ({ ok: false, reason: 'no_bunker_spot' }),
    async enclose(_bot, _ctx, enclosure) {
      assert.equal(bot.entity.onGround, true);
      assert.deepEqual(enclosure.top, top);
      return { ok: true };
    },
  } });
  await rest.run(ctx);
  bot.entity.position.y += 0.736;
  bot.entity.onGround = false;
  const enclosing = rest.run(ctx);
  bot.entity.position.y = top.y;
  bot.entity.onGround = true;
  assert.equal((await enclosing).ok, true);
  assert.equal(bot.companionSheltered, true);
  assert.deepEqual(events, ['dig_in', 'enclosed']);
});
