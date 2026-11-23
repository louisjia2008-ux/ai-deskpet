'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createAttempt, failure, waiting } = require('../core/action-result');
const { createAdaptation } = require('../core/adaptation');
const { gatherWood } = require('../core/adaptation-strategies');
const { createFailureLedger, ledgerFor, ledgerTarget } = require('../core/failure-ledger');
const { gatherSeeds } = require('../core/farming');
const actions = require('../core/actions');

const MINUTE = 60_000;
const p = (x) => new Vec3(x, 64, 0);

test('the ledger never writes a non-target result or excludes home or an owner block', () => {
  const events = [];
  const ledger = createFailureLedger({ protectedTarget: q => [1, 2].includes(q.x), emit: (type, data) => events.push({ type, ...data }) });
  const target = x => ({ purpose: 'grass', position: p(x) });
  for (const reason of ['self_stuck', 'aborted', 'no_tool', 'unloaded']) {
    assert.equal(ledger.record(failure(reason), target(3)), null);
  }
  assert.equal(ledger.record(waiting('sheltering_until_daylight'), target(3)), null);
  for (const x of [1, 2]) {
    assert.equal(ledger.record(failure('block_changed'), target(x)), null);
    assert.equal(ledger.skip(target(x)), null);
  }
  assert.equal(events.length, 0);
  assert.equal(ledger.record(failure('block_changed'), target(3)).excluded, true);
  assert.equal(ledger.skip(target(3)).reason, 'block_changed');
  ledger.clearOnSuccess(target(3));
  assert.equal(ledger.skip(target(3)), null);
});

test('a duplicate attempt does not use another target strike', () => {
  const ledger = createFailureLedger();
  const target = { goal: 'wood', step: 'gather_log', position: p(13) };
  const attempt = createAttempt();
  assert.equal(ledger.record(failure('NoPath', {}, attempt), target).failures, 1);
  assert.equal(ledger.record(failure('NoPath', {}, attempt), target), null);
  assert.equal(ledger.record(failure('NoPath'), target).failures, 2);
  assert.equal(ledger.skip(target), null);
  assert.equal(ledger.record(failure('NoPath'), target).excluded, true);
});

test('legacy coordinate-keyed targets migrate with their expiry, witness and threshold', () => {
  const spec = { goal: 'wood', step: 'gather_log', position: p(13), witness: () => 'oak_log' };
  let clock = 5;
  const store = { targets: [{ key: 'overworld|wood|gather_log|13,64,0', until: 10,
    failures: 3, witness: 'oak_log', reason: 'nopath' }] };
  const ledger = createAdaptation({ now: () => clock, store: { load: () => store } }).failureLedger;
  assert.equal(ledger.skip(spec).until, 10);
  assert.equal(ledger.skip({ ...spec, witness: () => 'air' }), null);
  clock = 10;
  assert.equal(ledger.skip(spec), null);
});

test('legacy adaptation lessons migrate to regional exclusions with the old radius, dimension and expiry', () => {
  let clock = 10;
  const store = { lessons: [{ kind: 'hard_route', position: p(13), dimension: 'overworld',
    reason: 'nopath', radius: 6, until: 10 + 30 * MINUTE }] };
  const ledger = createAdaptation({ now: () => clock, store: { load: () => store } }).failureLedger;
  assert.equal(ledger.regionHard(p(19)), true);
  assert.equal(ledger.regionHard(p(20)), false);
  assert.equal(ledger.regionHard(p(19), 'the_nether'), false);
  clock += 30 * MINUTE;
  assert.equal(ledger.regionHard(p(19)), false);
});

test('wood work from the shoreline leaves the tree and the ladder untouched', async () => {
  const tree = p(13);
  const bot = { entity: { position: p(0), isInWater: true }, blockAt: () => ({ name: 'air' }) };
  const events = [], attempts = [];
  const adaptation = createAdaptation({ onEvent: event => events.push(event) });
  const ctx = { adapt: adaptation.scope(() => true) };
  const skills = { gatherOne(_bot, _ctx, { exclude, destination }) {
    assert.equal(exclude(tree), false);
    attempts.push(tree);
    const result = bot.entity.isInWater ? failure('NoPath', {}, ctx, bot) : { ok: true, progress: true };
    destination.observe(destination.spec(tree), result);
    return result;
  } };
  const run = () => gatherWood({ bot, ctx, skills, actions, memory: {}, anchor: p(0),
    blocks: () => true, dropMatch: () => true });
  assert.equal((await run()).kind, 'start');
  assert.equal(adaptation.plan('wood', { position: p(0), target: 'log' }).method, 'near_tree');
  assert.equal(events.some(e => e.type === 'adaptation_attempt' || e.type === 'adaptation_switch'), false);
  assert.deepEqual(adaptation.failureLedger.snapshot(), []);
  bot.entity.isInWater = false;
  assert.equal((await run()).ok, true);
  assert.deepEqual(attempts, [tree, tree]);
});

test('a changed grass block excludes only that candidate and the next sowing step can continue', async t => {
  const first = p(4), second = p(6);
  const bot = { entity: { position: p(0) }, registry: { blocksByName: { short_grass: { id: 1 } } },
    findBlocks: () => [first, second], blockAt: position => ({ name: 'short_grass', position }),
    inventory: { items: () => [] } };
  const ctx = { record() {} };
  const dug = [];
  t.mock.method(actions, 'goToDig', async () => ({ ok: true }));
  t.mock.method(actions, 'digBlock', async (_bot, _ctx, block) => {
    dug.push(block.position);
    return block.position.equals(first) ? { ok: false, reason: 'block_changed' } : { ok: true };
  });
  t.mock.method(actions, 'collectDrops', async () => ({ ok: true }));
  const failed = await gatherSeeds(bot, ctx);
  assert.equal(failed.kind, 'target');
  assert.equal(failed.facts.target.excluded, true);
  const ledger = ledgerFor(bot, ctx);
  assert.ok(ledger.skip(ledgerTarget(bot, 'grass', first)));
  assert.equal(ledger.skip(ledgerTarget(bot, 'grass', second)), null);
  assert.equal((await gatherSeeds(bot, ctx)).ok, true);
  assert.deepEqual(dug, [first, second]);
});
