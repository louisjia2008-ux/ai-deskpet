'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('../core/actions');
const { createAdaptation } = require('../core/adaptation');
const { createBrain } = require('../core/brain');
const { classifyReason, complete, createAttempt, failure, factsOf, resultFrom, waiting } = require('../core/action-result');
const { reasons } = require('../core/action-reasons');

test('reason catalog covers literal failure producers with no duplicate codes or implicit classification', () => {
  const codes = Object.entries(reasons).flatMap(([kind, list]) => list.trim().split(/\s+/).map(reason => [reason, kind]));
  assert.equal(new Set(codes.map(([reason]) => reason)).size, codes.length);
  for (const [reason, kind] of codes) assert.equal(classifyReason(reason), kind, reason);

  const dir = path.join(__dirname, '..', 'core');
  const producers = readdirSync(dir, { recursive: true }).filter(file => file.endsWith('.js') && !file.startsWith('doctor'));
  const literalFailure = /\b(?:fail(?:ure)?\(\s*|ok:\s*false\s*,\s*(?:progress:\s*false\s*,\s*)?reason:\s*)(['"])([\w:]+)\1/g;
  const uncovered = [];
  for (const file of producers) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(literalFailure)) {
      try { classifyReason(match[2]); }
      catch { uncovered.push(`${file}:${source.slice(0, match.index).split('\n').length} ${match[2]}`); }
    }
  }
  assert.deepEqual(uncovered, []);
  assert.throws(() => classifyReason('unregistered_server_result'), { code: 'result_reason_unmapped' });
});

test('reason templates are bounded and classify the actionable cause', () => {
  const examples = {
    'none_near_site:no_wood within 15 of 1,1,1': 'target', 'exhausted:no_wool': 'target',
    'mine_blocked:cave': 'target', 'unplannable:raw_iron:no_source': 'environment',
    'needs_dimension:the_nether': 'environment', 'no_station:furnace': 'environment',
    'no_table_spot': 'target', 'no_carpet_this_press': 'target', 'topology_unknown_block': 'target',
    'topology_unloaded': 'environment', NoPath: 'target', GoalChanged: 'interrupted',
  };
  for (const [reason, kind] of Object.entries(examples)) assert.equal(classifyReason(reason), kind, reason);
  assert.throws(() => classifyReason('topology_unregistered'), { code: 'result_reason_unmapped' });
});

test('attempt identity survives planning, confirmation and fresh material evidence on retry', () => {
  const ctx = createAttempt({ behavior: 'goal:homestead' });
  assert.equal(createAttempt(ctx), ctx);
  const unconfirmed = failure('place_unconfirmed', { position: '1,1,1' }, ctx);
  const retried = failure('no_material', { need: { sandstone: 1 } }, ctx, { inventory: {} });
  assert.equal(unconfirmed.attemptId, retried.attemptId);
  assert.deepEqual(retried, { ok: false, reason: 'no_material', kind: 'material',
    facts: { need: { sandstone: 1 }, carried: {} }, attemptId: ctx.attemptId });
  assert.notEqual(createAttempt().attemptId, ctx.attemptId);
});

test('canonical completion and wait have only outcome fields', () => {
  assert.deepEqual(complete(false), { ok: true, progress: false });
  assert.deepEqual(resultFrom({ ok: true, already: true }), { ok: true, progress: false });
  const operation = resultFrom({ ok: true, ate: 'bread' });
  assert.deepEqual(operation, { ok: true, progress: true });
  assert.deepEqual(factsOf(operation), { ate: 'bread' });
  assert.deepEqual(waiting('daylight'), { ok: true, wait: { reason: 'daylight', until: null } });
});

function pathBot({ wet = false } = {}) {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: !wet, isInWater: wet };
  bot.blockAt = p => ({ name: bot.entity.isInWater && p.y === 64 ? 'water' : 'air', boundingBox: 'empty' });
  bot.pathfinder = { setGoal() {}, goto: async () => { throw Object.assign(new Error('fixture has no path'), { name: 'NoPath' }); } };
  bot.companionSelfStuck = { state: () => null, pathFailed: () => false, force() {} };
  return bot;
}

test('water failure 13 blocks from a tree goes to source recovery, then revisits the same tree', async () => {
  const bot = pathBot({ wet: true });
  const ctx = createAttempt();
  const tree = { position: new Vec3(13, 64, 0), boundingBox: 'empty' };
  const recovery = [];
  bot.companionSelfStuck.force = cause => recovery.push(cause);
  const inWater = await actions.goToDig(bot, ctx, tree);
  assert.equal(inWater.kind, 'start');
  assert.equal(inWater.facts.source, 'water');
  assert.deepEqual(recovery, ['route_origin_water']);
  bot.entity.isInWater = false;
  bot.entity.onGround = true;
  bot.pathfinder.goto = async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); };
  assert.deepEqual(await actions.goToDig(bot, ctx, tree), { ok: true, progress: true });
  assert.equal(inWater.attemptId, ctx.attemptId);
  assert.deepEqual(bot.entity.position.floored(), tree.position);
});

test('first path step failure is distinct from exhausted routes with usable starting steps', async () => {
  const goal = new goals.GoalBlock(10, 64, 0);
  const bot = pathBot();
  const ctx = createAttempt();
  bot.pathfinder.goto = async () => { bot.emit('path_update', { status: 'noPath', visitedNodes: 1 }); };
  const cannotLeave = await actions.goTo(bot, ctx, goal);
  assert.equal(cannotLeave.kind, 'start');
  assert.equal(cannotLeave.facts.source, 'path_first_step');
  bot.pathfinder.goto = async () => { bot.emit('path_update', { status: 'noPath', visitedNodes: 17 }); };
  assert.deepEqual(await actions.goTo(bot, ctx, goal), failure('not_arrived', {}, ctx));
  assert.equal(bot.listenerCount('path_update'), 0);
  assert.equal(bot.listenerCount('path_reset'), 0);
});

test('the same failed movement belongs to rescue inside and becomes start when handed to work', async () => {
  const ctx = createAttempt({ behavior: 'goal:homestead' });
  const rescue = failure('not_arrived', {}, { ...ctx, rescue: 'home_escape' }, { inWater: true });
  assert.equal(rescue.kind, 'target');
  assert.deepEqual(rescue.facts, { rescue: 'home_escape', source: 'water' });
  const work = resultFrom(rescue, ctx);
  assert.equal(work.kind, 'start');
  assert.equal(work.attemptId, rescue.attemptId);
  assert.equal(failure('block_changed', {}, {}, { selfStuck: true }).kind, 'start');
  assert.equal(failure('aborted', {}, {}, { inWater: true }).kind, 'interrupted');
  const { failureLedger, scope } = createAdaptation();
  const adapt = scope(() => true);
  const position = new Vec3(13, 64, 0);
  assert.equal(failureLedger.record(rescue, { purpose: 'gather', position }), null);
  assert.equal(failureLedger.record(work, { purpose: 'rejected_site', position }), null);
  await adapt.run('route', { position }, async () => rescue);
  assert.equal(adapt.plan('route', { position }).failures, 0);
  assert.equal(failureLedger.snapshot().length, 0);
});

test('failed pit tactics progress from path to pillar to stairs before yielding', async () => {
  const ctx = createAttempt({ rescue: 'surface' });
  const position = new Vec3(5, 60, 5);
  const events = [];
  const adapt = createAdaptation({ onEvent: event => events.push(event) }).scope(() => true);
  const methods = [];
  const run = () => adapt.run('pit', { position }, async method => {
    methods.push(method);
    return failure('still_below_surface', {}, ctx);
  }, { threshold: 1 });
  assert.equal((await run()).facts.adaptation.switched, true);
  assert.equal((await run()).facts.adaptation.switched, true);
  assert.equal((await run()).facts.adaptation.exhausted.reason, 'still_below_surface');
  assert.equal((await run()).wait.reason, 'adaptation_other_work');
  assert.deepEqual(methods, ['pathfinder', 'direct_pillar', 'side_stairs']);
  assert.equal(events.filter(event => event.type === 'adaptation_attempt').length, 3);
});

test('home escape failure retains exponential behavior cooldown on a wet start', async () => {
  let at = 0, runs = 0;
  const brain = createBrain({ now: () => at, perceive: () => ({ alive: true, inWater: true }),
    behaviors: [{ name: 'home_escape', band: 101, want: () => 1, async run() {
      runs++;
      return { ok: false, reason: 'self_escape_unconfirmed' };
    } }] });
  for (at of [0, 23, 1999, 2000, 2023]) { await brain.tick(); await brain.idle(); }
  assert.equal(runs, 2);
  assert.deepEqual(brain.status().cooldowns, [{ name: 'home_escape', until: 6000 }]);
  await brain.dispose();
});

test('a rolling minute limits mixed failure kinds across intervening successes', async () => {
  let at = 0, allow = false, runs = 0;
  const events = [];
  const brain = createBrain({ now: () => at, perceive: () => ({ alive: true }), onEvent: e => events.push(e),
    failureCooldownMs: 0, behaviors: [{ name: 'probe', band: 1, want: () => Number(allow), async run(ctx) {
      allow = false;
      runs++;
      return runs === 11 ? complete() : failure(['self_stuck', 'aborted', 'unloaded', 'no_material'][runs % 4], {}, ctx);
    } }] });
  for (let i = 0; i < 23; i++) {
    at = i * 2000;
    allow = true;
    await brain.tick();
    await brain.idle();
  }
  assert.equal(runs, 21);
  assert.equal(events.filter(e => e.type === 'behavior_finished' && !e.result.ok).length, 20);
  assert.equal(events.find(e => e.type === 'behavior_failure_backoff').until, 60_000);
  at = 60_000;
  await brain.tick();
  await brain.idle();
  assert.equal(runs, 22);
  await brain.dispose();
});

test('a cancelled public action returns its attempt outcome before touching the body', async () => {
  const ctx = createAttempt({ signal: AbortSignal.abort('preempted') });
  const bot = pathBot({ wet: true });
  bot.pathfinder.goto = () => assert.fail('starting a cancelled action touches the body');
  assert.deepEqual(await actions.goTo(bot, ctx, new goals.GoalBlock(10, 64, 0)),
    failure('aborted', { cause: 'preempted' }, ctx));
});
