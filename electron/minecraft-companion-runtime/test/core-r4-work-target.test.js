'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createFailureLedger } = require('../core/failure-ledger');
const { hazardTarget, interruptedWork, withWorkTarget } = require('../core/work-target');

test('repeated breath interruptions during one submerged ore step exclude only that target', async () => {
  // R3.2 seed 1, the same coal target at lines 3093, 3102 and 3111.
  const times = [0, 15_536, 31_080];
  const ore = new Vec3(3, 54, 4);
  const otherOre = ore.offset(1, 0, 1);
  const events = [];
  let at = 0;
  const bot = { companionFailureLedger: createFailureLedger({ now: () => at }) };
  const ctx = () => ({ behavior: 'goal:outfit', attemptId: String(at),
    signal: new AbortController().signal, record: (type, data) => events.push({ type, ...data }) });
  for (const reason of ['night_rest', 'provision', 'player', 'defend']) {
    const attempt = ctx();
    await withWorkTarget(bot, attempt, ore, () => interruptedWork(attempt.signal, reason));
  }
  for (at of times) {
    const attempt = ctx();
    await withWorkTarget(bot, attempt, ore, () => {
      interruptedWork(attempt.signal, 'breathe');
      interruptedWork(attempt.signal, 'breathe');
    });
  }

  const failures = events.filter(event => event.type === 'target_failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'target_needs_breath');
  assert.equal(failures[0].result.kind, 'target');
  assert.equal(failures[0].result.facts.interruptions.length, 3);
  assert.equal(bot.companionFailureLedger.skip(hazardTarget(bot, otherOre)), null);
  const blocked = await withWorkTarget(bot, ctx(), ore, () => assert.fail('excluded ore was retried'));
  assert.equal(blocked.reason, 'target_excluded');
  at += 600_001;
  await withWorkTarget(bot, ctx(), ore, () => 'retried');
  assert.equal(bot.companionFailureLedger.skip(hazardTarget(bot, ore)), null);
});
