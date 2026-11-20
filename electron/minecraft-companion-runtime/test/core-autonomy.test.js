'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createDirector } = require('../core/director');
const { createEndJourneyGoal } = require('../core/goals/endJourney');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createNetherExpeditionGoal } = require('../core/goals/netherExpedition');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { nightShelter } = require('../core/companion');

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

test('night rest uses the guest bed if the primary bed is missing or occupied', () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const { bed, guestBed } = house.furniture;
  const at = (p, q) => p.x === q.x && p.y === q.y && p.z === q.z;
  for (const missing of [true, false]) {
    const bot = { blockAt(p) {
      if (at(p, bed.position) && missing) return { name: 'air' };
      return { name: 'red_bed', getProperties: () => ({ occupied: at(p, bed.head) }) };
    } };
    assert.deepEqual(nightShelter(bot, { house, goal: null }).bed, guestBed.position);
  }
});

test('unfinished house can abandon its dangerous or distant site without throwing', async () => {
  const bot = { entity: { position: new Vec3(200, 64, 0) }, blockAt: () => null };
  const goal = createHomesteadGoal({ bot, anchor: { x: 0, y: 64, z: 0 } });
  goal.memory.pinned = false;
  const events = [];
  const result = await goal.run({ perceive: () => ({}), record: (type) => events.push(type) });
  assert.equal(result.abandoned, true);
  assert.equal(goal.memory.house, null);
  assert.deepEqual(events, ['site_abandoned']);
});

test('autonomous Nether expedition stops after an overworld respawn without enough rods', async () => {
  const bot = Object.assign(new EventEmitter(), { game: { dimension: 'the_nether' } });
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 7, witherSkulls: 0, trades: 0, returnOnRespawn: true });
  const state = { inventory: {} };
  try {
    bot.emit('death');
    assert.equal(goal.isDone(state), false);
    bot.game.dimension = 'overworld';
    assert.equal(goal.isDone(state), true);
  } finally { goal.dispose(); }
});

test('autonomous End fight cannot re-enter after the bot returns or respawns', async () => {
  const bot = Object.assign(new EventEmitter(), { game: { dimension: 'the_end' }, blockAt: () => null });
  const goal = createEndJourneyGoal({ bot, withCity: false, home: true, alreadyInside: true });
  try {
    assert.equal(goal.isDone({}), false);
    bot.game.dimension = 'overworld';
    assert.equal(goal.isDone({}), true);
    assert.deepEqual(await goal.run({ perceive: () => ({}) }), { ok: true });
  } finally { goal.dispose(); }
});
