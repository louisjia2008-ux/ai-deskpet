'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chooseNext, createDirector } = require('../core/director');
const { createDefaultCards } = require('../core/goals/registry');
const { complete } = require('../core/action-result');

function fixture(cards, state) {
  let at = 0, goal, governor, generation = 0, director;
  const events = [];
  const brain = {
    status: () => ({ goal, running: goal && `goal:${goal.name}` }),
    setGoal(def, metadata) {
      goal = { name: def.name, generation: ++generation };
      governor = metadata.autonomy;
      return generation;
    },
    async clearGoal(reason) {
      const previous = goal;
      goal = null;
      director.handleEvent({ type: 'goal_cleared', goal: previous.name, generation: previous.generation, reason });
    },
  };
  director = createDirector({ brain, cards, stageOf: () => 1, now: () => at, idleMs: 0,
    perceive: () => state, onEvent: event => events.push(event) });
  director.enable();
  function yieldGoal(fields) {
    const previous = goal;
    goal = null;
    director.handleEvent({ ...fields, type: 'goal_yielded', goal: previous.name, generation: previous.generation });
  }
  return { director, events, at: next => { at = next; }, yieldGoal, boundary: result => governor.outcome(result, 1_000) };
}

const card = (id, options = {}) => ({
  id, stage: 1, risk: 'low', create: () => ({ name: id }), ...options,
});
const day = { alive: true, isDay: true, dimension: 'overworld', timeOfDay: 8000, health: 20, food: 17 };

test('the farm cooldown can end during a cobble-generator step', () => {
  // R3.1 seed 1 L1580–L1586: farm yields for 30s, the generator takes over.
  const state = { ...day, timeOfDay: 10459, inventory: { wheat_seeds: 1, stone_hoe: 1,
    iron_pickaxe: 1, iron_sword: 1, shield: 1, cobblestone: 69 } };
  const run = fixture([card('wheat_farm'), card('cobble_generator')], state);
  assert.equal(run.director.tick(), 'wheat_farm');
  run.yieldGoal({ reason: 'adaptation_exhausted', until: 30_000 });
  assert.equal(run.director.tick(), 'cobble_generator');
  run.at(29_999);
  assert.equal(run.boundary(complete(false)), null);
  run.at(30_000);
  const change = run.boundary(complete(true));
  assert.equal(change.reason, 'card_value_changed');
  assert.equal(run.events.at(-1).challenger, 'wheat_farm');
  run.yieldGoal(change);
  assert.equal(run.director.tick(), 'wheat_farm');
});

test('R3.2 seed 3 inventory leaves the iron and farm milestones ahead of stocking extra food', () => {
  // L311 selected stock_food over iron_tools while the food bar still had 17 points.
  const bot = { game: { dimension: 'overworld' } };
  const { cards } = createDefaultCards({ bot, progression: true });
  const memory = { homestead: { isDone: () => true } };
  const inventory = { stone_pickaxe: 1, oak_planks: 3, craft_table: 1, stone_sword: 1, stick: 3, dirt: 18 };
  const state = { ...day, timeOfDay: 7859, inventory };
  const select = () => chooseNext(state, memory, cards, { stage: 1 });
  assert.equal(select().card.id, 'iron_tools');
  Object.assign(inventory, { iron_pickaxe: 1, iron_sword: 1, shield: 1, bread: 4 });
  const choice = select();
  assert.equal(choice.card.id, 'wheat_farm');
  assert.ok(choice.scores.find(e => e.id === 'wheat_farm').score > choice.scores.find(e => e.id === 'stock_food').score);
});

test('small score fluctuations preserve the active card', () => {
  let demand = 0.99;
  const run = fixture([card('steady'), card('challenge', { demand: () => demand })], day);
  assert.equal(run.director.tick(), 'steady');
  for (const factor of [1.04, 0.99, 1.12]) {
    demand = factor;
    assert.equal(run.boundary(complete(false)), null);
  }
  run.at(60_000);
  run.director.tick();
  assert.equal(run.events.at(-1).reason, 'switch_margin');
  assert.equal(run.events.at(-1).retained, true);
});

test('no-progress value decays at ten minutes and card ownership expires at fourteen', () => {
  const run = fixture([card('steady')], day);
  assert.equal(run.director.tick(), 'steady');
  run.at(10 * 60_000);
  run.director.tick();
  assert.equal(run.events.at(-1).scores[0].stale, -16);
  run.at(12 * 60_000);
  run.director.tick();
  assert.ok(run.events.at(-1).scores[0].stale < -16);
  run.at(14 * 60_000);
  run.director.tick();
  assert.equal(run.events.at(-1).reason, 'card_stalled');
  assert.equal(run.director.status().current, null);
  assert.equal(run.director.tick(), null);
});
