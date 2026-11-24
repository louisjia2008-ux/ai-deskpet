'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createAdaptation, LADDERS, FALLBACK, NEW_AREA } = require('../core/adaptation');
const { createDirector } = require('../core/director');
const { createBrain } = require('../core/brain');
const { failure: actionFailure } = require('../core/action-result');
const { runPlanned } = require('../core/goals/common');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { gatherWood, outwardLeg, runSearchLeg, OUTWARD_HEADINGS } = require('../core/adaptation-strategies');
const { posKey } = require('../core/blacklist');
const { createSelfStuck } = require('../core/self-stuck');
const { blockTarget, watchDestination } = require('../core/target-recovery');
const actions = require('../core/actions');
const skills = require('../core/skills');

const location = { position: { x: 33, y: 65, z: -10 }, target: 'log' };
const failure = { ok: false, reason: 'not_arrived' };
const minute = 60_000;
function fixture(options = {}) {
  let at = 1000;
  let saved;
  const events = [];
  const store = { load: () => structuredClone(saved), save: (value) => { saved = structuredClone(value); } };
  const restart = () => createAdaptation({ now: () => at, store, onEvent: (event) => events.push(event), ...options });
  return { restart, events, now: () => at, advance: (ms) => { at += ms; } };
}

test('three consecutive failures advance the real execution choice, scoped by area and target', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const use = adaptation.scope(() => true);
  const methods = [];
  for (let i = 0; i < 7; i += 1) await use.run('wood', location, (method) => {
    methods.push(method);
    return failure;
  });
  assert.deepEqual(methods, ['near_tree', 'near_tree', 'near_tree', 'wider_heading', 'wider_heading', 'wider_heading', 'different_biome']);
  assert.equal(adaptation.plan('wood', { ...location, target: 'other' }).method, 'near_tree');
  assert.equal(adaptation.plan('wood', { ...location, position: { x: 500, y: 70, z: -10 } }).method, 'near_tree');
  assert.equal(adaptation.plan('wood', { ...location, dimension: 'the_nether' }).method, 'near_tree');
  assert.equal(events.filter((e) => e.type === 'adaptation_switch').length, 2);
  assert.equal(events.filter((e) => e.type === 'adaptation_invariant').length, 0);
});

test('deterministic checks advance immediately on the same unchanged world', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const use = adaptation.scope(() => true);
  for (const method of LADDERS.home_site.slice(0, -1)) {
    await use.run('home_site', location, (actual) => {
      assert.equal(actual, method);
      return { ok: false, reason: 'no_suitable_site' };
    });
  }
  assert.deepEqual(events.filter(e => e.type === 'adaptation_attempt').map(e => e.failures), [1, 1, 1, 1]);
  assert.equal(adaptation.plan('home_site', location).method, 'relocate');
});

test('relocation turns after individual timeouts and checks new dry ground reached before the leg ends', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: p => ({ name: p.y < 64 ? 'dirt' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
  };
  const wanted = [];
  const goal = createHomesteadGoal({ bot, autonomous: true, actions: {
    async goTo(_bot, _ctx, end) {
      wanted.push([end.x, end.z]);
      if (wanted.length === 4) {
        const start = bot.entity.position;
        bot.entity.position = new Vec3((end.x - start.x) * 0.7 + start.x, start.y, (end.z - start.z) * 0.7 + start.z);
      }
      return { ok: false, reason: 'Timeout' };
    },
  } });
  const location = { position: bot.entity.position };
  adaptation.promote('home_site', location, 'relocate', 'fixture');
  const ctx = { adapt: adaptation.scope(() => true), record: (type, e) => events.push({ type, ...e }),
    perceive: () => ({ position: bot.entity.position, inventory: { oak_planks: 400 }, isDay: true, inWater: false }) };

  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(new Set(wanted.map(String)).size, 4);
  assert.equal(events.filter(e => e.type === 'home_relocation_leg').at(-1).reason, 'Timeout');
  assert.equal(events.some(e => e.type === 'adaptation_attempt'), false);
  assert.ok(events.some(e => e.type === 'site_chosen' && e.method === 'relocate' && e.route?.porch));
});

test('relocation reports one exhausted method only after every outward direction is blocked', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const position = new Vec3(0.5, 64, 0.5);
  const wanted = [];
  const bot = { entity: { position }, blockAt: () => null };
  const goal = createHomesteadGoal({ bot, autonomous: true, actions: {
    async goTo(_bot, _ctx, end) {
      wanted.push([end.x, end.z]);
      return { ok: false, reason: 'Timeout' };
    },
  } });
  adaptation.promote('home_site', { position }, 'relocate', 'fixture');
  const ctx = { adapt: adaptation.scope(() => true), record: (type, e) => events.push({ type, ...e }),
    perceive: () => ({ position, inventory: {}, isDay: true }) };

  const result = await goal.run(ctx);
  assert.equal(new Set(wanted.map(String)).size, OUTWARD_HEADINGS.length);
  assert.equal(result.facts?.adaptation?.exhausted?.reason, 'relocation_routes_exhausted');
  assert.equal(events.filter(e => e.type === 'adaptation_attempt').length, 1);
});

test('turning away from water keeps a fixed axis instead of the former four-point circuit', async () => {
  const origin = new Vec3(427.5, 64, 30.5);
  const turnAt = new Vec3(437.5, 64, 15.5);
  const bot = { entity: { position: turnAt.clone() }, blockAt: () => null };
  // The native GoalNearXZ completes just inside a three-block radius.
  const advance = async (_bot, _ctx, target) => {
    const p = bot.entity.position;
    const dx = target.x - p.x, dz = target.z - p.z;
    const step = 1 - 1.5 / Math.hypot(dx, dz);
    bot.entity.position = p.offset(dx * step, 0, dz * step);
    return { ok: true };
  };
  const old = { heading: OUTWARD_HEADINGS.indexOf(3) };
  for (let i = 0; i < 4; i++) await outwardLeg(bot, {}, { goTo: advance }, old, origin, { distance: 28 });
  assert.ok(bot.entity.position.distanceTo(turnAt) < 6, 'the old relative bearing returns after four legs');

  bot.entity.position = turnAt.clone();
  let legs = 0;
  const { restart, events } = fixture();
  const adaptation = restart();
  const goal = createHomesteadGoal({ bot, autonomous: true, actions: {
    goTo(_bot, ctx, target) {
      if (++legs === 1) return { ok: false, reason: 'Timeout' };
      return advance(_bot, ctx, target);
    },
  } });
  goal.memory.searchOrigin = origin;
  goal.memory.homesteadRoute = { method: 'relocate', heading: OUTWARD_HEADINGS.indexOf(-2), bearing: 0 };
  adaptation.promote('home_site', { position: origin }, 'relocate', 'fixture');
  const ctx = { adapt: adaptation.scope(() => true), record: (type, e) => events.push({ type, ...e }),
    perceive: () => ({ position: bot.entity.position, inventory: {}, isDay: true, inWater: legs === 1 }) };
  let farthest = 0;
  for (let i = 0; i < 7; i++) {
    assert.equal((await goal.run(ctx)).ok, true);
    const distance = bot.entity.position.distanceTo(turnAt);
    assert.ok(distance > farthest + 20);
    farthest = distance;
  }
  assert.deepEqual([...new Set(events.filter(e => e.type === 'adaptation_route').map(e => e.heading))], [-2, 3]);
  assert.ok(farthest > 150);
});

test('a spaced dry scout stores one candidate for homestead to revalidate and use', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: p => ({ name: p.y < 64 ? 'dirt' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) };
  const goal = createHomesteadGoal({ bot, autonomous: true, actions: {} });
  let inventory = {};
  const state = () => ({ position: bot.entity.position, inventory, isDay: true, onGround: true });
  const record = (type, e) => events.push({ type, ...e });
  const scout = () => goal.scoutSite(state(), adaptation, record);
  scout();
  bot.entity.position = new Vec3(10.5, 64, 0.5);
  scout();
  assert.equal(events.filter(e => e.type === 'home_site_scout').length, 1);
  assert.equal(goal.memory.relocation, undefined);
  bot.entity.position = new Vec3(25.5, 64, 0.5);
  inventory = { oak_planks: 400 };
  scout();
  const saved = goal.memory.relocation.candidate.site;
  assert.equal(goal.memory.house, null);
  assert.ok(saved.route.porch);
  assert.equal((await goal.run({ adapt: adaptation.scope(() => true), perceive: state, record })).ok, true);
  assert.deepEqual(goal.memory.house.anchor, saved.anchor);
  assert.equal(events.find(e => e.type === 'site_chosen')?.method, 'scouted');
  assert.equal(goal.memory.relocation, null);
});

test('the inner route owns its failures through exhaustion and the subsequent wait', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const use = adaptation.scope(() => true);
  const run = () => use.run('wood', location, () => use.run('route', location, () => failure, { threshold: 1 }));
  let result;
  for (const _ of LADDERS.route) result = await run();
  assert.equal(result.facts?.adaptation?.exhausted?.task, 'route');
  assert.ok(events.filter(e => e.type === 'adaptation_attempt').every(e => e.task === 'route'));
  assert.equal(adaptation.plan('wood', location).failures, 0);
  const deferred = await run();
  assert.equal(deferred.wait?.reason, 'adaptation_other_work');
  assert.equal(deferred.facts?.adaptation?.exhausted, undefined);
});

test('homestead yields after the wood ladder and its next card skips both timed-out seed 2 logs', async (t) => {
  const { restart, now, advance, events } = fixture();
  const adaptation = restart();
  const logs = [new Vec3(236, 72, -60), new Vec3(232, 71, -60)];
  const other = new Vec3(240, 72, -55);
  let loaded = logs;
  const bot = {
    entity: { position: new Vec3(234.5, 72, -46.5) }, inventory: { items: () => [] },
    registry: { blocksByName: { oak_log: { name: 'oak_log', id: 1 } } }, game: { dimension: 'overworld', minY: 60, height: 32 },
    findBlocks: () => loaded,
    blockAt(p) {
      const log = loaded.some(q => q.equals(p));
      return { name: log ? 'oak_log' : p.y < 71 ? 'dirt' : 'air', position: p,
        boundingBox: log || p.y < 71 ? 'block' : 'empty' };
    },
  };
  const attempts = [];
  t.mock.method(actions, 'goToDig', async (_bot, _ctx, block) => {
    attempts.push(posKey(block.position));
    return { ok: false, reason: 'path_timeout' };
  });
  let director;
  const perceive = () => ({ alive: true, position: bot.entity.position });
  const brain = createBrain({ perceive, now, goalRetryDelayMs: 0, noProgressLimit: 1, onEvent(event) {
    events.push(event);
    director.handleEvent(event);
  } });
  const card = { id: 'homestead', stage: 0, risk: 'low', need: () => 100, create() {
    const memory = {};
    return { name: 'homestead', isDone: () => false, progress: () => 0, run: ctx => runPlanned(ctx,
      { kind: 'gather', key: 'log' }, () => gatherWood({ bot, ctx, skills, memory, anchor: new Vec3(232, 72, -41),
        actions: { goTo: async () => ({ ok: false, reason: 'path_timeout' }) }, blocks: n => n === 'oak_log', dropMatch: () => true })) };
  } };
  director = createDirector({ brain, perceive, now, idleMs: 0, adaptation, cards: [card] });
  director.enable();
  assert.equal(director.tick(), 'homestead');
  for (let i = 0; i < 20 && brain.status().goal; i += 1) {
    await brain.tick();
    await brain.idle();
    if (i % 2 === 1) advance(120001);
  }
  const yielded = events.find(e => e.type === 'goal_yielded');
  assert.equal(yielded?.task, 'wood');
  assert.equal(yielded?.method, 'different_biome');
  assert.ok(logs.every(p => attempts.filter(key => key === posKey(p)).length >= 2),
    JSON.stringify({ attempts, reasons: events.filter(e => e.type === 'adaptation_attempt').map(e => e.reason) }));
  const failures = events.filter(e => e.type === 'target_failure' && e.ladder === 'wood');
  assert.deepEqual(failures.map(e => e.target).sort(), logs.map(posKey).sort());
  assert.ok(failures.every(e => e.failures === 1 && e.reason === 'path_timeout'));
  assert.ok(failures.every(e => events.indexOf(e) < events.indexOf(yielded)));
  assert.equal(adaptation.failureLedger.snapshot(true).length, 2);
  assert.equal(restart().failureLedger.snapshot(true).length, 2);

  advance(Math.max(yielded.until, yielded.at + 5 * minute) - now() + 1);
  const before = attempts.length;
  loaded = [...logs, other];
  assert.equal(director.tick(), 'homestead');
  await brain.tick();
  await brain.idle();
  assert.deepEqual(attempts.slice(before), [posKey(other)]);
  await brain.dispose();
});

test('destination handoff ignores known wet, trapped, home, player, or self-rescue attempts and revokes a dry source cluster', async () => {
  const home = p => p.x === 10;
  const player = p => p.x === 11;
  const { restart, events, now } = fixture({ atHome: home, playerProtected: player });
  const bot = {
    entity: { position: new Vec3(0.5, 72, 0.5), isInWater: false }, companionHomeTarget: home, companionPlayerBlock: player,
    game: { dimension: 'overworld' }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
  };
  bot.companionSelfStuck = createSelfStuck(bot, { now, emit: (type, fields) => events.push({ type, ...fields }) });
  let adaptation = restart();
  let use = adaptation.scope(() => true);
  const attempt = (x, flags = {}) => (method, _plan, observe) => watchDestination(bot, { adapt: use, ...flags },
    blockTarget(bot, 'wood', 'gather_log', new Vec3(x, 72, 0)), observe, async () => ({ ok: false, reason: 'path_timeout' }));

  bot.entity.isInWater = true;
  await use.run('wood', location, attempt(8), { threshold: 1 });
  bot.entity.isInWater = false;
  await use.run('wood', location, attempt(10), { threshold: 1 });
  await use.run('wood', location, attempt(11), { threshold: 1 });
  assert.equal(adaptation.failureLedger.snapshot(true).length, 0);

  const elsewhere = { ...location, target: 'independent_wood' };
  await use.run('wood', elsewhere, attempt(17), { threshold: 1 });
  await use.run('wood', elsewhere, attempt(18), { threshold: 1 });
  const trapped = await use.run('wood', elsewhere, attempt(19), { threshold: 1 });
  assert.equal(trapped.reason, 'self_stuck');
  assert.equal(events.filter(e => e.type === 'self_stuck').length, 1);
  await use.run('wood', { ...elsewhere, target: 'still_trapped' }, attempt(20), { threshold: 1 });
  assert.equal(adaptation.failureLedger.snapshot(true).length, 0);
  bot.companionSelfStuck.release();
  adaptation = restart();
  use = adaptation.scope(() => true);
  const reloaded = await use.run('wood', elsewhere, attempt(21, { rescue: 'surface' }), { threshold: 1 });
  assert.equal(reloaded.kind, 'start');
  assert.equal(adaptation.plan('wood', elsewhere).method, 'different_biome');
  assert.equal(adaptation.failureLedger.snapshot(true).length, 0);
  assert.equal(events.filter(e => e.type === 'target_failure').length, 0);
});

test('handed-off targets reopen on change or expiry and still need a real target recovery to exclude', async () => {
  const { restart, advance, events } = fixture();
  const adaptation = restart();
  const targets = adaptation.scope(() => true).targets;
  let witness = 'oak_log';
  const spec = { goal: 'wood', step: 'gather_log', position: { x: 14, y: 71, z: 5 }, witness: () => witness };
  const remember = () => targets.handoff(targets.capture(spec, actionFailure('path_timeout')), 'wood');
  remember();
  assert.equal(targets.avoid(spec), true);
  witness = 'spruce_log';
  assert.equal(targets.avoid(spec), false);
  remember();
  advance(31 * minute);
  assert.equal(targets.avoid(spec), false);
  assert.deepEqual(events.filter(e => e.type === 'target_retry').map(e => e.reason), ['environment_changed', 'expired']);

  await targets.run(spec, () => failure);
  await targets.run(spec, () => failure);
  remember();
  assert.equal(events.filter(e => e.type === 'target_failure').at(-1).recoveryPending, true);
  assert.equal(targets.recovering(spec), true);
  assert.equal(targets.avoid(spec), false);
  assert.equal(targets.excluded(spec), null);
  await targets.run(spec, () => assert.fail('the body must try an alternate approach'), () => failure);
  assert.ok(targets.excluded(spec));
  assert.equal(events.filter(e => e.type === 'target_recovery').length, 1);
});

test('route exhaustion transfers the concrete failed walk and never a different cell selected on its synthetic rungs', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const ctx = { adapt: adaptation.scope(() => true) };
  const bot = {
    entity: { position: new Vec3(0.5, 72, 0.5) }, game: { dimension: 'overworld' },
    blockAt: p => ({ name: p.y < 72 ? 'stone' : 'air', boundingBox: p.y < 72 ? 'block' : 'empty' }),
    pathfinder: { movements: { companionWalkOnly: true }, async goto() { throw Object.assign(new Error(), { code: 'path_timeout' }); } },
  };
  const actual = new Vec3(12, 72, 2);
  const untried = new Vec3(13, 72, 2);
  for (let i = 0; i < 6; i += 1) await actions.goNear(bot, ctx, actual, 1);
  assert.equal(adaptation.failureLedger.snapshot(true).length, 0);
  assert.equal((await actions.goNear(bot, ctx, untried, 1)).reason, 'choose_another_target');
  const final = await actions.goNear(bot, ctx, untried, 1);
  assert.equal(final.facts?.adaptation?.exhausted?.task, 'route');
  const failures = events.filter(e => e.type === 'target_failure');
  assert.deepEqual(failures.map(e => [e.ladder, e.target, e.failures]), [['route', posKey(actual), 1]]);
});

test('a long walk to a log preserves the wood observer without incurring an inner route ladder', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const ctx = { adapt: adaptation.scope(() => true) };
  const pos = new Vec3(35, 72, 0);
  const bot = {
    entity: { position: new Vec3(0.5, 72, 0.5) }, game: { dimension: 'overworld' },
    blockAt: p => ({ name: p.y < 72 ? 'stone' : 'air', boundingBox: p.y < 72 ? 'block' : 'empty' }),
    pathfinder: { movements: { companionWalkOnly: true }, async goto() { throw Object.assign(new Error(), { code: 'path_timeout' }); } },
  };
  const spec = blockTarget(bot, 'wood', 'gather_log', pos);
  for (const _ of LADDERS.wood) {
    await ctx.adapt.run('wood', location, (_method, _plan, observe) => actions.goNear(bot, ctx, pos.offset(0.5, 0, 0.5), 6,
      { destination: { spec, observe, resolves: false } }), { threshold: 1 });
  }
  assert.deepEqual(events.filter(e => e.type === 'adaptation_attempt').map(e => e.task), ['wood', 'wood', 'wood']);
  assert.deepEqual(events.filter(e => e.type === 'target_failure').map(e => [e.ladder, e.target]), [['wood', posKey(pos)]]);
});

for (const [task, rungs] of Object.entries(LADDERS)) {
  test(`${task} executes its final rung before the director can yield for a repeated failure`, async () => {
    const { restart, now, events } = fixture();
    const adaptation = restart();
    const called = [];
    let director;
    const perceive = () => ({ alive: true, position: location.position });
    const brain = createBrain({ perceive, now, goalRetryDelayMs: 0, noProgressLimit: 1, onEvent: (event) => {
      events.push(event);
      director.handleEvent(event);
    } });
    const card = { id: `test_${task}`, stage: 0, risk: 'low', need: () => 100, create: () => ({
      name: task, isDone: () => false, progress: () => 0,
      run: (ctx) => runPlanned(ctx, { kind: 'gather', key: 'log' }, () => ctx.adapt.run(task, location, (method) => {
        called.push(method);
        return failure;
      })),
    }) };
    director = createDirector({ brain, perceive, now, idleMs: 0, waitLimit: 1, adaptation, cards: [card] });
    director.enable();
    assert.equal(director.tick(), card.id);
    try {
      for (let i = 0; i < rungs.length * 3 + 3 && brain.status().goal; i++) {
        await brain.tick();
        await brain.idle();
      }
      assert.deepEqual([...new Set(called)], rungs);
      const terminal = events.filter(e => e.type === 'adaptation_exhausted');
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].method, rungs.at(-1));
      const yielded = events.find(e => e.type === 'goal_yielded');
      assert.equal(yielded?.reason, 'adaptation_exhausted');
      assert.equal(yielded.key, terminal[0].key);
      assert.equal(yielded.method, rungs.at(-1));
      assert.ok(events.indexOf(terminal[0]) < events.indexOf(yielded));
      assert.ok(!events.some(e => ['goal_failed', 'step_blocked'].includes(e.type)));
    } finally {
      await brain.dispose();
    }
  });
}

test('the exhausted method yields, rejects unlisted/replayed IDs and executes a fixed model choice', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const use = adaptation.scope(() => true);
  for (const _ of LADDERS.wood) await use.run('wood', location, () => failure, { threshold: 1 });
  const ask = events.find((e) => e.type === 'adaptation_help');
  assert.equal(ask.trigger, 'ladder_exhausted');
  assert.deepEqual(ask.choices, [NEW_AREA, FALLBACK]);
  assert.equal(adaptation.reply(ask.requestId, 'arbitrary_command'), false);
  assert.equal(adaptation.reply(ask.requestId, NEW_AREA), true);
  assert.equal(adaptation.reply(ask.requestId, FALLBACK), false);
  await use.run('wood', location, (method) => { assert.equal(method, NEW_AREA); return { ok: true }; });
  assert.ok(events.some((e) => e.type === 'adaptation_help_effect' && e.requestId === ask.requestId && e.ok));
});

test('offline or timed-out help chooses a rule without reviving an exhausted method', async () => {
  for (const mode of ['unavailable', 'timeout']) {
    const { restart, events, advance } = fixture({ stallMs: 1000, helpTimeoutMs: 200 });
    const adaptation = restart();
    const use = adaptation.scope(() => true);
    await use.run('home_site', location, () => failure);
    advance(1000);
    adaptation.poll();
    const ask = events.find((e) => e.type === 'adaptation_help');
    if (mode === 'unavailable') adaptation.reply(ask.requestId, null);
    else { advance(200); adaptation.poll(); assert.equal(adaptation.reply(ask.requestId, 'compact'), false); }
    assert.equal(adaptation.plan('home_site', location).method, 'more_earthwork');
    for (let i = 0; i < 4; i += 1) await use.run('home_site', location, () => failure, { threshold: 1 });
    assert.equal((await use.run('home_site', location, () => assert.fail('exhausted method executed'))).wait?.reason, 'adaptation_other_work');
    assert.equal(events.filter((e) => e.type === 'adaptation_help').length, 1);
    advance(5 * minute + 1);
    assert.equal(adaptation.plan('home_site', location).method, 'near_flat');
  }
});

test('persisted lessons and the hourly quota survive restart; late responses and canceled actions do not', async () => {
  const { restart, events, advance } = fixture();
  const first = restart();
  first.teach('lava_pool', location.position, 'overworld', 'NoPath', 10);
  first.teach('no_sheep', location.position, 'overworld', 'no_mob_in_range', 128);
  const use = first.scope(() => true);
  for (const _ of LADDERS.wood) await use.run('wood', location, () => failure, { threshold: 1 });
  const request = events.find((e) => e.type === 'adaptation_help');
  const second = restart();
  assert.equal(second.reply(request.requestId, NEW_AREA), false);
  assert.ok(second.avoids('lava_pool', { ...location.position, x: 36 }));
  assert.equal(second.avoids('lava_pool', { ...location.position, y: 100 }), false);
  assert.equal(second.avoids('lava_pool', location.position, 'the_nether'), false);
  assert.ok(second.avoids('no_sheep', { ...location.position, x: 150 }));
  let valid = true;
  await second.scope(() => valid).run('route', location, () => { valid = false; return failure; });
  assert.equal(second.plan('route', location).failures, 0);
  advance(10 * minute + 1);
  assert.equal(second.avoids('lava_pool', location.position), false);
  for (const _ of LADDERS.wood) await second.scope(() => true).run('wood', location, () => failure, { threshold: 1 });
  assert.equal(events.filter((e) => e.type === 'adaptation_help').length, 1);
  advance(35 * minute);
  assert.equal(second.avoids('no_sheep', location.position), false);
});

test('a card without a recovery implementation executes other work after the three standard failures', async () => {
  const { restart, now, events } = fixture();
  const adaptation = restart();
  const calls = [];
  let director;
  const perceive = () => ({ alive: true, position: location.position });
  const brain = createBrain({ perceive, now, goalRetryDelayMs: 0, onEvent: (event) => {
    events.push(event);
    director.handleEvent(event);
  } });
  const card = (id, score) => ({
    id, stage: 0, risk: 'low', need: () => score, create: () => ({ name: id, isDone: () => false, progress: () => 0,
      run() { calls.push(id); return failure; } }),
  });
  director = createDirector({ brain, perceive, now, idleMs: 0, adaptation, cards: [card('blocked', 100), card('food', 80)] });
  director.enable();
  assert.equal(director.tick(), 'blocked');
  for (let i = 0; i < 5; i += 1) { await brain.tick(); await brain.idle(); }
  assert.equal(calls.filter((id) => id === 'blocked').length, 3);
  assert.ok(events.some(e => e.type === 'adaptation_attempt' && e.method === 'recover' && e.reason === 'no_recovery_available'));
  assert.ok(events.some(e => e.type === 'goal_yielded' && e.method === 'other_work'));
  assert.equal(director.tick(), 'food');
  await brain.dispose();
});


test('R4 seed 2 wood search stops at the sixth successful empty leg', async () => {
  const memory = {};
  let walked = 0;
  const leg = () => { walked++; return { ok: true, progress: false, moved: 28 }; };
  for (let i = 0; i < 5; i++) assert.equal((await runSearchLeg({}, memory, leg)).ok, true);
  const stopped = await runSearchLeg({}, memory, leg);
  assert.equal(stopped.reason, 'search_leg_budget');
  assert.deepEqual(stopped.facts, { legs: 6, distance: 168 });
  assert.equal((await runSearchLeg({}, memory, leg)).reason, 'search_leg_budget');
  assert.equal(walked, 6);
  assert.equal((await runSearchLeg({}, { legs: 4, distance: 164 }, leg)).facts.distance, 192);
});


test('seed 2 relocation exhausts its 200-block radial and 600-block total budgets', async () => {
  const adaptation = createAdaptation();
  const origin = new Vec3(24.5, 63, 10.5), position = origin.clone(), events = [];
  const bot = { entity: { position }, blockAt: () => null };
  const goal = createHomesteadGoal({ bot, origin, autonomous: true, actions: {
    async goTo(_bot, ctx, target) {
      assert.ok(ctx.pathArea(new Vec3(target.x, position.y, target.z)));
      position.set(target.x, position.y, target.z);
      return { ok: true };
    },
  } });
  adaptation.promote('home_site', { position: origin }, 'relocate', 'fixture');
  const ctx = { adapt: adaptation.scope(() => true), record: (type, data) => events.push({ type, ...data }),
    perceive: () => ({ position: position.clone(), inventory: {}, isDay: true }) };
  let stopped;
  for (let i = 0; i < 64 && !stopped; i++) {
    stopped = (await goal.run(ctx)).facts?.adaptation?.exhausted;
  }
  assert.ok(stopped);
  const legs = events.filter(event => event.type === 'home_relocation_leg');
  assert.ok(legs.length > 8);
  assert.ok(legs.every(leg => leg.legs <= 8 && leg.total <= 600.01 && Math.hypot(leg.position.x - origin.x, leg.position.z - origin.z) <= 200));
  assert.ok(events.some(event => event.type === 'home_relocation_budget'));
});
