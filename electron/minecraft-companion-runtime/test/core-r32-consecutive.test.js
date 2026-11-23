'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { complete, createAttempt, failure, waiting } = require('../core/action-result');
const { createAdaptation } = require('../core/adaptation');
const { createBrain } = require('../core/brain');
const { createDirector } = require('../core/director');
const { createFailureLedger } = require('../core/failure-ledger');
const { createFarmGoal } = require('../core/goals/farm');

const state = { alive: true, dimension: 'overworld', inventory: { wheat_seeds: 5, stone_hoe: 1 } };
const card = (create) => ({ id: 'wheat_farm', stage: 0, risk: 'low', need: () => 100, create });

function directorFixture(create) {
  let at = 0, def, hooks;
  const events = [];
  const now = () => at;
  const record = (type, data) => events.push({ type, ...data });
  const adaptation = createAdaptation({ now, onEvent: event => events.push(event) });
  const brain = { status: () => ({ goal: def }), setGoal(goal, { autonomy }) { def = goal; hooks = autonomy; } };
  const director = createDirector({ brain, adaptation, now, perceive: () => state, idleMs: 0, cards: [card(create)] });
  director.enable();
  assert.equal(director.tick(), 'wheat_farm');
  return { director, hooks, adaptation, events, record,
    async run() {
      at += 2000;
      const ctx = createAttempt({ adapt: hooks.adapt(() => true), record, perceive: () => state });
      const result = (await hooks.before(ctx)) || await def.run(ctx);
      return { result, yielded: hooks.outcome(result, 0) };
    } };
}

function farmFixture(plots, serverTills) {
  const status = new Map(plots.map(plot => [plot, 'untilled']));
  let recovered = 0;
  const bot = { entity: { position: new Vec3(27, 77, 32) },
    blockAt(p) { return p.y <= 76 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }; } };
  const farm = createFarmGoal({ bot, mode: 'sow', center: bot.entity.position, plots: plots.length,
    actions: { async goTo() { recovered++; return complete(); } },
    farming: {
      plotState: (_bot, plot) => status.get(plot), choosePlots: () => [],
      async till(_bot, ctx, plot) {
        if (!serverTills(plot)) return failure('till_unconfirmed', {}, ctx);
        status.set(plot, 'empty');
        return complete();
      },
      async plant(_bot, _ctx, plot) {
        status.set(plot, 'growing');
        return complete();
      },
    } });
  farm.memory.plots = plots;
  return { farm, recovered: () => recovered };
}

test('three seed 1 till failures separated by successful actions stay on their individual plots', async () => {
  // R3.1 seed 1 L1467–L1567. The first two failed cells later confirm,
  // with another planted cell between them, before the third cell fails.
  const plots = [new Vec3(27, 76, 34), new Vec3(26, 75, 31), new Vec3(27, 76, 35), new Vec3(32, 75, 38)];
  const needsRetry = new Set([plots[0], plots[2], plots[3]]);
  const { farm } = farmFixture(plots, plot => !needsRetry.delete(plot));
  const f = directorFixture(() => farm);
  for (let i = 0; i < 9; i++) assert.equal((await f.run()).yielded, null);
  assert.deepEqual(f.events.filter(event => event.type === 'farm' && event.action === 'plant').map(event => event.plot),
    ['27,76,34', '26,75,31', '27,76,35']);
  assert.deepEqual(f.events.filter(e => e.type === 'target_failure').map(e => [e.target, e.failures, e.result.kind]),
    ['27,76,34', '27,76,35', '32,75,38'].map(plot => [plot, 1, 'environment']));
  assert.ok(!f.events.some(e => e.type === 'adaptation_switch' || e.type === 'target_excluded'));
  assert.equal(f.director.status().current, 'wheat_farm');
});

test('a repeatedly unconfirmed till alternates stance and cools only the failing cell', async () => {
  const plot = new Vec3(27, 76, 34), neighbor = new Vec3(26, 75, 31);
  const { farm, recovered } = farmFixture([plot, neighbor], pos => pos !== plot);
  const f = directorFixture(() => farm);
  for (let i = 0; i < 3; i++) {
    const { result, yielded } = await f.run();
    assert.equal(result.kind, 'environment');
    assert.equal(result.facts.target.failures, i + 1);
    assert.equal(yielded, null);
  }
  assert.equal(recovered(), 1);
  assert.deepEqual(f.events.filter(e => e.type === 'target_excluded').map(e => [e.key, e.until - e.failureAt]),
    [['overworld|farm|till|27,76,34', 60_000]]);
  assert.equal((await f.run()).result.ok, true);
  assert.equal(f.events.filter(e => e.type === 'farm' && e.action === 'till').at(-1).plot, '26,75,31');
  assert.deepEqual(f.adaptation.failureLedger.persisted().entries, []);
});

test('an environmental failure requires a concrete, unprotected cell to enter its ledger', () => {
  const home = new Vec3(27, 76, 34), player = new Vec3(27, 76, 35), open = new Vec3(32, 75, 38);
  const ledger = createFailureLedger({ protectedTarget: p => [home, player].some(cell => cell.equals(new Vec3(p.x, p.y, p.z))) });
  const till = position => ({ goal: 'farm', step: 'till', position });
  assert.equal(ledger.record(failure('till_unconfirmed'), till(home)), null);
  assert.equal(ledger.record(failure('till_unconfirmed'), till(player)), null);
  assert.equal(ledger.record(failure('till_unconfirmed'), { ...till(open), entity: 'animal' }), null);
  assert.equal(ledger.record(failure('till_unconfirmed'), { purpose: 'director_step', entity: 'craft/hoe' }), null);
  assert.equal(ledger.record(failure('unloaded'), till(open)), null);
  assert.equal(ledger.record(failure('till_unconfirmed'), till(open)).failures, 1);
});

test('confirmed direct and planned work resets only its card; uninterrupted failures still exhaust it', async () => {
  const f = directorFixture(() => ({ name: 'farm', run: () => failure('till_unconfirmed') }));
  const step = { kind: 'craft', key: 'stone_hoe' };
  const scoped = f.adaptation.scope(() => true);
  const plan = (target = 'wheat_farm') => scoped.plan('goal', { target });
  scoped.outcome(plan('harvest_wheat'), failure('plant_unconfirmed'));
  for (const success of [() => f.hooks.outcome(complete(), 0), () => f.hooks.stepOutcome(step, complete(), f.record)]) {
    assert.equal((await f.run()).yielded, null);
    assert.equal(plan().failures, 1);
    f.hooks.outcome(waiting('cooling'), 0);
    f.hooks.outcome(complete(false), 0);
    assert.equal(plan().failures, 1);
    success();
    assert.equal(plan().failures, 0);
    assert.equal(plan('harvest_wheat').failures, 1);
  }
  for (let i = 0; i < 3; i++) assert.equal((await f.run()).yielded, null);
  assert.equal(plan().method, 'recover');
  assert.equal((await f.run()).yielded, null);
  assert.equal(plan().method, 'other_work');
  assert.equal((await f.run()).yielded.reason, 'adaptation_exhausted');
});

test('a completed goal clears the card failure count when its last step bypasses the governor outcome', async () => {
  const f = directorFixture(() => ({ name: 'farm', run: () => failure('till_unconfirmed') }));
  await f.run();
  const plan = () => f.adaptation.plan('goal', { target: 'wheat_farm' });
  assert.equal(plan().failures, 1);
  f.director.handleEvent({ type: 'goal_done', goal: 'farm' });
  assert.equal(plan().failures, 0);
});

test('seed 2 night rest waits two seconds on a wet start without escalating', async () => {
  // R3.1 seed 2 L1505–L1563 returned no_bunker_spot 20 times in 37 ms.
  let at = 0;
  const events = [];
  const wet = { ...state, isDay: false, inWater: true };
  const brain = createBrain({ now: () => at, perceive: () => wet, onEvent: event => events.push(event),
    behaviors: [{ name: 'night_rest', band: 100, want: () => 1,
      run: ctx => failure('no_bunker_spot', { source: 'water' }, ctx, wet) }] });
  for (at of [0, 2, 37, 1999, 2000, 2037, 3999, 4000]) { await brain.tick(); await brain.idle(); }
  const failures = events.filter(e => e.type === 'behavior_finished');
  assert.deepEqual(failures.map(e => [e.at, e.result.kind]), [[0, 'start'], [2000, 'start'], [4000, 'start']]);
  assert.deepEqual(brain.status().cooldowns, [{ name: 'night_rest', until: 6000 }]);
  await brain.dispose();
});

test('a card start failure only delays the behavior and leaves its stall and card cooldown untouched', async () => {
  let at = 0;
  let director;
  const events = [];
  const wet = { ...state, inWater: true };
  const now = () => at, perceive = () => wet;
  const brain = createBrain({ now, perceive, onEvent(event) { events.push(event); director.handleEvent(event); } });
  director = createDirector({ brain, now, perceive, idleMs: 0, cards: [card(() => ({ name: 'farm',
    isDone: () => false, progress: () => 0, run: ctx => failure('path_timeout', { source: 'water' }, ctx, wet) }))] });
  director.enable();
  director.tick();
  for (at of [0, 1999, 2000, 3999, 4000]) { await brain.tick(); await brain.idle(); }
  assert.deepEqual(events.filter(e => e.type === 'behavior_finished').map(e => e.result.kind), ['start', 'start', 'start']);
  assert.equal(brain.status().goal.stalls, 0);
  assert.deepEqual(director.status().cooldowns, []);
  await brain.dispose();
});
