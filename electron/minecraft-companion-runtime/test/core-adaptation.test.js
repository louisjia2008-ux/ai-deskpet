'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAdaptation, LADDERS, FALLBACK, NEW_AREA } = require('../core/adaptation');
const { createDirector } = require('../core/director');
const { createBrain } = require('../core/brain');
const { runPlanned } = require('../core/goals/common');

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

test('the inner route owns its failures through exhaustion and the subsequent wait', async () => {
  const { restart, events } = fixture();
  const adaptation = restart();
  const use = adaptation.scope(() => true);
  const run = () => use.run('wood', location, () => use.run('route', location, () => failure, { threshold: 1 }));
  let result;
  for (const _ of LADDERS.route) result = await run();
  assert.equal(result.adaptationExhausted?.task, 'route');
  assert.ok(events.filter(e => e.type === 'adaptation_attempt').every(e => e.task === 'route'));
  assert.equal(adaptation.plan('wood', location).failures, 0);
  const deferred = await run();
  assert.equal(deferred.waited, true);
  assert.equal(deferred.adaptationExhausted, undefined);
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
    assert.equal((await use.run('home_site', location, () => assert.fail('exhausted method executed'))).waited, true);
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
