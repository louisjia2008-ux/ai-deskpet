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
const actions = require('../core/actions');

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

test('a shallow sandstone pit uses a direct pillar when the walking plan does not move', async () => {
  const before = new Vec3(0.5, 61, 0.5);
  let height = 60;
  let placed = 0;
  const bot = {
    game: { dimension: 'overworld' }, entity: { position: before.clone(), onGround: true },
    inventory: { items: () => [{ name: 'sandstone', count: 20 - placed }] },
    registry: { itemsByName: { sandstone: { id: 1 } } },
    pathfinder: { movements: { allow1by1towers: false, scafoldingBlocks: [] }, async goto() {} },
    blockAt(p) {
      const top = p.x === 0 && p.z === 0 ? height : 63;
      return { name: p.y <= top ? 'sandstone' : 'air', boundingBox: p.y <= top ? 'block' : 'empty', position: p };
    },
    async equip() {},
    async look() {},
    setControlState(key, value) { if (key === 'jump' && value) bot.entity.position.y = height + 2.1; },
    async placeBlock(ref) {
      assert.equal(ref.position.y, height);
      height += 1;
      placed += 1;
      bot.entity.position.y = height + 1;
    },
  };
  const records = [];
  const result = await actions.surface(bot, { record: (type, data) => records.push({ type, ...data }) });
  assert.equal(result.surfaced, true);
  assert.equal(placed, 3);
  assert.equal(bot.entity.position.y, 64);
  assert.equal(records.find((entry) => entry.type === 'recovery_switch').to, 'direct_pillar');
  assert.equal(records.find((entry) => entry.type === 'pit_pillar_result').ok, true);
  assert.equal(bot.pathfinder.movements.allow1by1towers, false);
});

test('after abandoning a home, failed outward routes rotate and a verified move reopens site search', async () => {
  const tried = [];
  const bot = {
    entity: { position: new Vec3(66.5, 64, 0.5) }, companionDanger: [{ x: 0, y: 64, z: 0 }],
    blockAt(p) {
      if (bot.entity.position.x < 80) return null;
      return { name: p.y <= 63 ? 'stone' : 'air', boundingBox: p.y <= 63 ? 'block' : 'empty' };
    },
  };
  const goal = createHomesteadGoal({ bot, anchor: { x: 0, y: 64, z: 0 }, actions: {
    goTo: async (_bot, _ctx, next) => {
      tried.push(`${next.x},${next.z}`);
      if (tried.length === 1) return { ok: false, reason: 'not_arrived' };
      if (tried.length === 3) bot.entity.position = new Vec3(next.x, 64, next.z);
      return { ok: true };
    },
  } });
  goal.memory.pinned = false;
  const records = [];
  const ctx = { perceive: () => ({ isDay: true, position: bot.entity.position }), record: (type, data) => records.push({ type, ...data }) };
  assert.equal((await goal.run(ctx)).abandoned, true);
  assert.equal((await goal.run(ctx)).ok, false);
  assert.equal((await goal.run(ctx)).reason, 'relocation_not_arrived');
  assert.ok((await goal.run(ctx)).moved >= 6);
  assert.equal(new Set(tried).size, 3);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.ok(records.some((entry) => entry.type === 'site_chosen' && Math.hypot(entry.anchor.x, entry.anchor.z) >= 80));
});

test('three failures to regain a mining face retain the old route until the bot has come back up', async () => {
  const entrance = new Vec3(0, 64, 0);
  const front = new Vec3(6, 61, 0);
  const from = new Vec3(3, 61, 0);
  const bot = { entity: { position: from.clone() }, registry: { blocksByName: {} }, inventory: { items: () => [] } };
  const memory = { mine: { entrance, dir: 0, surfaceY: 64, y: 60, front,
    cells: { '0,64,0': null, '3,61,0': '0,64,0', '6,61,0': '3,61,0' } } };
  let walks = 0;
  const events = [];
  const ctx = { record: (type, data) => events.push({ type, ...data }) };
  const options = { blocks: () => false, dropMatch: () => false, y: 60, blacklist: createBlacklist(), actions: {
    async goTo(_bot, _ctx, goal) {
      if (++walks <= 3) return { ok: false, reason: 'not_arrived' };
      bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      return { ok: true };
    },
  } };
  for (let i = 0; i < 3; i += 1) assert.equal((await mineStep(bot, ctx, memory, options)).reason, 'not_arrived');
  assert.equal(memory.mine.retiring, true);
  assert.equal(entranceCooling(bot, entrance), true);
  assert.equal((await mineStep(bot, ctx, memory, options)).ok, true);
  assert.equal(bot.entity.position.y, entrance.y);
  assert.equal((await mineStep(bot, ctx, memory, options)).reason, 'mine_exhausted');
  assert.equal(memory.mine, null);
  assert.ok(events.some((e) => e.type === 'recovery_switch' && e.to === 'retire_entrance'));
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
