'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createDirector } = require('../core/director');
const { createBrain } = require('../core/brain');
const { planNext } = require('../core/planner');
const { createFarmGoal } = require('../core/goals/farm');
const { runPlanned } = require('../core/goals/common');
const { mineStep, entranceCooling } = require('../core/mining');
const { createBlacklist } = require('../core/blacklist');
const { smelt } = require('../core/skills');
const { createEndJourneyGoal } = require('../core/goals/endJourney');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createNetherExpeditionGoal } = require('../core/goals/netherExpedition');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { nightShelter } = require('../core/companion');

function fixture(options = {}) {
  let now = 1000;
  let goal = null;
  let governor;
  const events = [];
  let director;
  const brain = {
    setGoal(next, metadata) { goal = next; governor = metadata?.autonomy; },
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
    ...options,
  });
  director.enable();
  return { director, brain, events, governor: () => governor, advance: (ms) => { now += ms; } };
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

test('legacy Overworld pauses and repeat homestead deaths cannot stop an eligible card', () => {
  const adjustments = [];
  const { director, advance, events } = fixture({
    stageOf: () => 0,
    cards: [{ id: 'homestead', stage: 0, risk: 'low', need: () => 100, create: () => ({ name: 'homestead' }) }],
    memory: { stagePauses: { 0: 86_400_000 }, routeDeaths: [{ at: 500, stage: 0, card: 'homestead' }] },
    onOverworldDeath: (death) => adjustments.push(death),
  });
  assert.equal(director.tick(), 'homestead');
  assert.equal(director.noteDeath('husk', { dimension: 'overworld' }), false);
  advance(30_000);
  assert.equal(director.noteDeath('husk', { dimension: 'overworld' }), false);
  assert.equal(adjustments.length, 2);
  assert.ok(!events.some((e) => e.type === 'autonomy_stage_paused'));
});

test('autonomous waits yield via the brain and select another card', async () => {
  const events = [];
  let director;
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => {
    events.push(event);
    director.handleEvent(event);
  } });
  const card = (id, score) => ({
    id, stage: 0, risk: 'low', need: () => score,
    create: () => ({ name: id, isDone: () => false, progress: () => 0,
      run: async () => ({ ok: true, waited: true, reason: 'cooling' }) }),
  });
  director = createDirector({ brain, perceive: () => ({ alive: true }), idleMs: 0, waitLimit: 2,
    cards: [card('waiting', 100), card('other_work', 80)] });
  director.enable();
  assert.equal(director.tick(), 'waiting');
  for (let i = 0; i < 2; i++) {
    await brain.tick();
    await brain.idle();
  }
  assert.equal(events.find((e) => e.type === 'goal_yielded')?.reason, 'cooling');
  assert.equal(director.tick(), 'other_work');
  await brain.dispose();
});

test('three failed planning attempts block the source and the planner moves on', async () => {
  const { director, advance, governor, events } = fixture();
  director.tick();
  const hooks = governor();
  const ctx = { stepBlocked: hooks.stepBlocked, stepOutcome: (s, r) => hooks.stepOutcome(s, r, (type, data) => events.push({ type, ...data })) };
  const step = { kind: 'smelt', key: 'charcoal' };
  for (let i = 0; i < 3; i++) await runPlanned(ctx, step, async () => ({ ok: false, reason: 'no_fuel' }));
  assert.equal(events.at(-1).step, 'smelt/charcoal');
  assert.equal(events.at(-1).until, 601_000);
  const args = { inventory: { oak_log: 2, stick: 1 }, stations: { furnace: true }, stepBlocked: hooks.stepBlocked };
  assert.equal(planNext({ ...args, requirements: [{ key: 'charcoal', count: 1 }] }).kind, 'blocked');
  assert.equal(planNext({ ...args, requirements: [{ key: 'charcoal', count: 1 }, { key: 'dirt', count: 1 }] }).key, 'dirt');
  assert.equal((await runPlanned(ctx, step, () => assert.fail('blocked action ran'))).waited, true);
  advance(600_000);
  assert.equal(ctx.stepBlocked('smelt', 'charcoal'), 0);
});

test('a repeated goal failure is cooled before an eleventh repeat within 30 minutes', () => {
  const { director, governor, events, advance } = fixture();
  director.tick();
  for (let i = 0; i < 9; i++) {
    assert.equal(governor().outcome({ ok: false, reason: 'same_failure' }, 200), null);
    advance(100);
  }
  const result = governor().outcome({ ok: false, reason: 'same_failure' }, 200);
  assert.equal(result.reason, 'repeated_failure');
  assert.equal(events.at(-1).type, 'autonomy_loop_blocked');
  assert.equal(result.until, 1_801_000);
});

test('charcoal planning reserves its log before choosing fuel', () => {
  const plan = (inventory, count = 1) => planNext({ requirements: [{ key: 'charcoal', count }], inventory, stations: { furnace: true } });
  assert.equal(plan({ oak_log: 1 }).kind, 'gather');
  assert.equal(plan({ oak_log: 2 }).input, 'oak_log');
  assert.equal(plan({ pale_oak_log: 1, oak_planks: 1 }).input, 'pale_oak_log');
  assert.equal(plan({ oak_log: 1, birch_log: 1 }, 2).count, 1);
  assert.equal(planNext({ requirements: [{ key: 'bed', count: 1 }], inventory: { string: 4 } }).item, 'white_wool');
});

test('furnace never spends the stale inventory copy of the only input log', async () => {
  const pos = new Vec3(0, 64, 0);
  const log = { name: 'oak_log', count: 1 };
  let fuelAttempts = 0;
  const furnace = {
    inventoryStart: 3, inventoryEnd: 4, slots: [null, null, null, log], fuel: 0,
    outputItem: () => furnace.slots[2], inputItem: () => furnace.slots[0], fuelItem: () => furnace.slots[1],
    async putInput() { furnace.slots[0] = log; furnace.slots[3] = null; },
    async putFuel() { fuelAttempts += 1; },
    close() {},
  };
  const bot = { entity: { position: pos }, blockAt: () => ({ name: 'furnace' }),
    registry: { itemsByName: { oak_log: { id: 1 } } },
    inventory: { items: () => [log] }, openFurnace: async () => furnace };
  const memory = {};
  const result = await smelt(bot, { record() {} }, { input: 'oak_log', count: 1, furnacePosition: pos, memory });
  assert.equal(result.reason, 'no_fuel');
  assert.equal(fuelAttempts, 0);
  assert.deepEqual(memory, { item: 'oak_log', input: 1, output: 0 });
});

test('sow finishes with no bread, and harvest only requests a ripe batch', () => {
  const plots = Array.from({ length: 9 }, (_, x) => ({ x, y: 64, z: 0 }));
  const states = plots.map(() => 'growing');
  const options = { bot: {}, plots: 9, farming: { plotState: (_bot, p) => states[p.x] } };
  const sow = createFarmGoal({ ...options, mode: 'sow' });
  sow.memory.plots = plots;
  const harvest = createFarmGoal({ ...options, mode: 'harvest', sharedMemory: sow.memory });
  assert.equal(sow.isDone({ inventory: {} }), true);
  assert.equal(harvest.harvestNeeded(), false);
  states.fill('ripe', 0, 3);
  assert.equal(harvest.harvestNeeded(), true);
  assert.equal(harvest.isDone({ inventory: {} }), false);
});

test('an exhausted entrance is cooled across different mine memory objects', async () => {
  const position = new Vec3(8, 64, 0);
  const bot = { entity: { position }, inventory: { items: () => [] }, registry: { blocksByName: {} } };
  const memory = { mine: { entrance: position, dir: 0, surfaceY: 64, exhausted: true } };
  const options = { blocks: () => false, dropMatch: () => false, y: -58, blacklist: createBlacklist() };
  assert.equal((await mineStep(bot, { record() {} }, memory, options)).reason, 'mine_exhausted');
  assert.equal(entranceCooling(bot, position.offset(2, 0, 0)), true);
  assert.equal((await mineStep(bot, { record() {} }, {}, options)).reason, 'mine_entrance_cooling');
  assert.equal(entranceCooling(bot, position.offset(16, 0, 0)), false);
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
