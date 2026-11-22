'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDirector } = require('../core/director');
const { createDefaultCards } = require('../core/goals/registry');

function setup({ isDay = true, retryAt = 12_000 } = {}) {
  let now = 0;
  let goal;
  const events = [];
  const card = (id, stage, score) => ({ id, stage, risk: 'low', need: () => score, create: () => ({ name: id }) });
  const homestead = card('homestead', 0, 100);
  const food = card('stock_food', 0, 40);
  const logs = card('stock_wood', 0, 65);
  const brain = {
    status: () => ({ goal }),
    setGoal: (next) => { goal = next; },
    async clearGoal(reason) {
      const previous = goal;
      goal = null;
      director.handleEvent({ type: 'goal_cleared', goal: previous.name, reason });
    },
  };
  const director = createDirector({ brain, perceive: () => ({ isDay, alive: true }), now: () => now,
    idleMs: 0, cards: [homestead, card('iron_tools', 1, 90), food], reserveCards: [food, logs],
    onEvent: (event) => events.push(event) });
  director.enable();
  assert.equal(director.tick(), 'homestead');
  goal = null;
  director.handleEvent({ type: 'goal_yielded', goal: 'homestead', until: retryAt });
  return { director, brain, events, setTime: (at) => { now = at; } };
}

test('at stage zero, materials can use the cooling period and release the main card at its deadline', () => {
  const { director, brain, events, setTime } = setup();
  assert.equal(director.tick(), 'stock_wood');
  const selected = events.at(-1);
  assert.equal(selected.reserveUntil, 12_000);
  assert.equal(selected.scores.find((score) => score.id === 'iron_tools').skipped, 'stage');
  setTime(11_999);
  director.tick();
  assert.equal(brain.status().goal.name, 'stock_wood');
  setTime(12_000);
  director.tick();
  assert.equal(brain.status().goal, null);
  assert.equal(director.tick(), 'homestead');
  assert.deepEqual(director.status().cooldowns, []);
});

test('reserve work is time bounded even when the main card has a long cooldown', () => {
  const { director, brain, events, setTime } = setup({ retryAt: 180_000 });
  assert.equal(director.tick(), 'stock_wood');
  assert.equal(events.at(-1).reserveUntil, 45_000);
  setTime(45_000);
  director.tick();
  assert.equal(brain.status().goal, null);
  assert.equal(director.tick(), 'stock_wood');
});

test('cooldown reserve cards leave the night to shelter behavior', () => {
  const { director, events } = setup({ isDay: false });
  assert.equal(director.tick(), null);
  assert.equal(events.at(-1).reason, 'no_eligible_card_until_retry');
});

test('food, logs and cobblestone are all available to the reserve scheduler before establishing a home', () => {
  const { reserveCards } = createDefaultCards({ bot: { game: { dimension: 'overworld' } }, progression: true });
  const state = { inventory: { wooden_pickaxe: 1 }, freeSlots: 10 };
  assert.deepEqual(reserveCards.map((card) => card.id), ['stock_food', 'stock_wood', 'stock_cobblestone']);
  for (const card of reserveCards) {
    assert.equal(card.stage, 0);
    assert.equal(card.requires(state, {}), true);
    assert.ok(card.need(state, {}) > 0);
  }
});
