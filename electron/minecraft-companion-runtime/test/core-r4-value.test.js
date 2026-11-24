'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { chooseNext, createDirector } = require('../core/director');
const { stepRetryAt } = require('../core/planner');
const { createDefaultCards } = require('../core/goals/registry');
const { complete, failure } = require('../core/action-result');

function fixture(cards, state, bot) {
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
  director = createDirector({ brain, bot, cards, stageOf: () => 1, now: () => at, idleMs: 0,
    perceive: () => state, onEvent: event => events.push(event) });
  director.enable();
  function yieldGoal(fields) {
    const previous = goal;
    goal = null;
    director.handleEvent({ ...fields, type: 'goal_yielded', goal: previous.name, generation: previous.generation });
  }
  return { director, events, at: next => { at = next; }, yieldGoal, step: (step, result) => governor.stepOutcome(step, result, () => {}),
    planning: () => governor.planning(), boundary: result => governor.outcome(result, 1_000),
    async run(work) {
      const ctx = { perceive: () => state };
      return await governor.before(ctx) || governor.run(ctx, work);
    } };
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


test('R4 seed 1 farm travel stops refreshing a held card', () => {
  const run = fixture([card('wheat_farm', { work: () => ({ remaining: 9, readiness: 0.3 }) })], day);
  assert.equal(run.director.tick(), 'wheat_farm');
  for (let minute = 1; minute < 14; minute++) {
    run.at(minute * 60_000);
    assert.equal(run.boundary(complete(true, { moved: 28 })), null);
  }
  run.at(840_000);
  assert.equal(run.boundary(complete(true)).reason, 'card_stalled');
  const { remaining, readiness, sinceProgressMs, scores } = run.events.at(-1);
  assert.deepEqual([remaining, readiness, sinceProgressMs, scores[0].progress], [9, 0.3, 840_000, 0]);
});

test('physical work, a readiness increase or a milestone advances the progress clock', () => {
  const work = { remaining: 49, readiness: 0.2 };
  const run = fixture([card('homestead', { work: () => ({ ...work }) })], day);
  run.director.tick();
  run.at(60_000);
  work.remaining = 48;
  run.boundary(complete(false));
  assert.equal(run.events.at(-1).sinceProgressMs, 0);
  run.at(120_000);
  work.readiness = 0.24;
  run.boundary(complete(true));
  assert.equal(run.events.at(-1).sinceProgressMs, 60_000);
  run.at(180_000);
  work.readiness = 0.25;
  run.boundary(complete(false));
  assert.equal(run.events.at(-1).sinceProgressMs, 0);
  work.remaining = 49;
  run.at(240_000);
  run.boundary(complete(true));
  run.at(300_000);
  work.remaining = 48;
  run.boundary(complete(true));
  assert.equal(run.events.at(-1).sinceProgressMs, 120_000);
  run.director.handleEvent({ type: 'site_chosen' });
  run.at(360_000);
  run.boundary(complete(false));
  assert.equal(run.events.at(-1).sinceProgressMs, 60_000);
});

test('the eighth start failure excludes its planner source for ten minutes', () => {
  const run = fixture([card('homestead')], day);
  run.director.tick();
  const station = { kind: 'place_station', station: 'crafting_table', for: 'stone_sword', position: { x: 157, y: 70, z: 62 } };
  const nextStand = { ...station, position: { ...station.position, z: 63 } };
  const start = () => failure('unsafe_build_stand');
  assert.equal(failure('furniture_blocks_exit').kind, 'target');
  for (let i = 0; i < 7; i++) assert.equal(run.step(station, start()).kind, 'start');
  run.step(station, complete(false));
  for (let i = 0; i < 7; i++) assert.equal(run.step(station, start()).kind, 'start');
  assert.equal(run.step(station, { ...start(), facts: { rescue: 'leave_fire' } }).kind, 'start');
  assert.equal(run.step(nextStand, start()).kind, 'start');
  const result = run.step(station, start());
  assert.equal(result.kind, 'target');
  assert.equal(result.facts.startAttempts, 8);
  assert.equal(result.facts.target.excluded, true);
  assert.equal(stepRetryAt(station, run.planning()), 600_000);
  assert.equal(stepRetryAt(nextStand, run.planning()), 0);
  run.at(600_000);
  assert.equal(stepRetryAt(station, run.planning()), 0);
});


test('a stalled card waits sixty seconds and resumes its existing physical work clock', () => {
  let remaining = 6;
  const run = fixture([card('iron_tools', { work: () => ({ remaining, readiness: 0.3 }) })], day);
  assert.equal(run.director.tick(), 'iron_tools');
  run.at(840_000);
  run.director.tick({ holdBody: true });
  assert.equal(run.events.at(-1).reason, 'card_stalled');
  run.at(899_999);
  assert.equal(run.director.tick(), null);
  run.at(900_000);
  assert.equal(run.director.tick(), 'iron_tools');
  assert.equal(run.events.at(-1).sinceProgressMs, 900_000);
  remaining--;
  run.at(960_000);
  assert.equal(run.boundary(complete(false)), null);
  assert.equal(run.events.at(-1).sinceProgressMs, 0);
});

test('the periodic stall check sees work that the server confirmed during a step', () => {
  let remaining = 6;
  const run = fixture([card('iron_tools', { work: () => ({ remaining, readiness: 0.3 }) })], day);
  run.director.tick();
  run.at(840_000);
  remaining--;
  run.director.tick();
  assert.equal(run.director.status().current, 'iron_tools');
  assert.equal(run.events.at(-1).sinceProgressMs, 0);
});

test('an overdue value handoff cannot immediately reselect the same stale card', () => {
  let challenger = 0;
  const run = fixture([card('iron_tools', { work: () => ({ remaining: 6, readiness: 0.3 }) }),
    card('cobble_generator', { demand: () => challenger })], day);
  assert.equal(run.director.tick(), 'iron_tools');
  run.at(666_805);
  challenger = 3;
  const change = run.boundary(complete(false));
  assert.equal(change.reason, 'card_value_changed');
  run.yieldGoal(change);
  challenger = 0;
  run.at(670_075);
  assert.equal(run.director.tick(), null);
  run.at(726_805);
  assert.equal(run.director.tick(), 'iron_tools');
  assert.equal(run.events.at(-1).sinceProgressMs, 726_805);
});

test('direct body movements in a bounded card also stop before 96 blocks from home', async () => {
  const state = { ...day, position: { x: 0, y: 64, z: 0 } };
  const bot = Object.assign(new EventEmitter(), { entity: { position: { ...state.position } } });
  const run = fixture([card('iron_tools', { bounded: true })], state, bot);
  assert.equal(run.director.tick(), 'iron_tools');
  const result = await run.run(ctx => {
    bot.entity.position.x = 95.5;
    bot.emit('physicsTick');
    assert.equal(ctx.signal.aborted, true);
    return complete(false);
  });
  assert.equal(result.kind, 'material');
  assert.equal(result.reason, 'search_area_exhausted');
  assert.equal(bot.listenerCount('physicsTick'), 0);
});
