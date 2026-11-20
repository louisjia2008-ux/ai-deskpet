'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDirector } = require('../core/director');

function fixture() {
  let now = 1000;
  let goal = null;
  const events = [];
  let director;
  const brain = {
    setGoal(next) { goal = next; },
    status: () => ({ goal }),
    async clearGoal(reason) {
      const previous = goal;
      goal = null;
      director.handleEvent({ type: 'goal_cleared', goal: previous?.name, reason });
    },
  };
  const card = (id, stage, options) => ({
    id, stage, risk: 'low', need: () => 90, create: () => ({ name: id }), ...options,
  });
  director = createDirector({
    brain, perceive: () => ({ alive: true }), now: () => now, idleMs: 0, stageOf: () => 4,
    scope: (memory) => (memory.range === 'overworld' ? 3 : 6),
    cards: [card('fortress', 4, { expedition: true, budgetStage: 4 }), card('prepare', 2, { maintenance: true })],
    onEvent: (event) => events.push(event),
  });
  director.enable();
  return { director, brain, events, advance: (ms) => { now += ms; } };
}

test('lowering the range releases an active expedition and keeps eligible preparation available', async () => {
  const { director, brain } = fixture();
  assert.equal(director.tick(), 'fortress');
  await director.setRange('overworld');
  assert.equal(brain.status().goal, null);
  assert.equal(director.memory.homePending, true);
  assert.equal(director.tick(), 'prepare');
});

test('two deaths in one stage pause its expedition, while maintenance remains eligible', async () => {
  const { director, brain, advance } = fixture();
  assert.equal(director.tick(), 'fortress');
  assert.equal(director.noteDeath('lava'), false);
  advance(1500);
  assert.equal(director.noteDeath('blaze'), true);
  assert.deepEqual(director.status().stagePauses, [{ stage: 4, until: 7_202_500 }]);
  await brain.clearGoal('death');
  assert.equal(director.tick(), 'prepare');
  await brain.clearGoal('idle');
  advance(7_200_001);
  assert.equal(director.tick(), 'fortress');
});

test('owner work delays resuming the route after its goal settles', async () => {
  const { director, brain, advance } = fixture();
  assert.equal(director.tick(), 'fortress');
  await brain.clearGoal('replaced');
  director.notePlayerGoal();
  brain.setGoal({ name: 'come_to_owner' });
  assert.equal(director.tick(), null);
  await brain.clearGoal('arrived');
  advance(29_999);
  assert.equal(director.tick(), null);
  advance(1);
  assert.equal(director.tick(), 'fortress');
});
