'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createAdaptation } = require('../core/adaptation');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { chooseSite, evaluateSite, chooseHillside, siteWork } = require('../core/site');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createHomeMaintenance } = require('../core/behaviors/homeMaintenance');
const { createFarmGoal } = require('../core/goals/farm');
const { createStockFoodGoal } = require('../core/goals/stockFood');
const { createAutoSmelterGoal } = require('../core/goals/autoSmelter');
const { createCobbleGeneratorGoal } = require('../core/goals/cobbleGenerator');
const actions = require('../core/actions');
const { posKey } = require('../core/blacklist');

const anchor = { x: 0, y: 64, z: 0 };
const fail = (reason = 'occupied') => ({ ok: false, reason });
const v = (p) => new Vec3(p.x, p.y, p.z);
const above = (p) => ({ ...p, y: p.y + 1 });
const makeBlock = (name, p) => ({ name, position: v(p), boundingBox: ['air', 'torch'].includes(name) ? 'empty' : 'block',
  getProperties: () => ({ open: true }) });

test('target attempts survive a recreated scope and world reload; recovery, expiry and changed cells are distinct', async () => {
  let now = 100, saved, environment = 'podzol';
  const events = [];
  const store = { load: () => saved, save: state => { saved = JSON.parse(JSON.stringify(state)); } };
  const create = () => createAdaptation({ now: () => now, store, onEvent: e => events.push(e) });
  let adaptation = create();
  const target = { goal: 'homestead', step: 'place_torch', position: { x: 31, y: 76, z: 27 }, witness: () => environment };
  const other = { ...target, position: { ...target.position, x: 33 } };
  const run = (spec, attempt, recover) => adaptation.scope(() => true).targets.run(spec, attempt, recover);
  const recovering = async (reason) => { assert.equal(reason, 'occupied'); return fail(); };
  const never = () => assert.fail('the excluded cell must not be tried again');
  await run(target, fail);
  await run(other, fail);
  await run(target, fail);
  adaptation = create();
  assert.equal((await run(target, never, recovering)).targetExcluded, true);
  adaptation = create();
  assert.equal((await run(target, never, never)).reason, 'target_excluded');
  assert.equal((await run(other, fail, never)).targetExcluded, undefined);
  assert.equal((await run(other, never, recovering)).targetExcluded, true);
  environment = null; // unloading a chunk is not evidence that the cell changed
  assert.equal((await run(target, never, never)).reason, 'target_excluded');
  environment = 'air';
  assert.equal((await run(target, () => ({ ok: true }), never)).ok, true);
  environment = 'podzol';
  now += 30 * 60_000 + 1;
  assert.equal((await run(other, () => ({ ok: true }), never)).ok, true);
  assert.deepEqual(events.filter(e => e.type === 'target_retry').map(e => e.reason), ['environment_changed', 'expired']);
  assert.equal(events.filter(e => e.type === 'target_recovery').length, 2);
  assert.equal(events.filter(e => e.type === 'target_invariant').length, 0);
});

for (const variant of ['starter', 'compact', 'hillside']) {
  test(`${variant}: raised north row is excavation work, not missing support; player cells are rejected`, () => {
    const house = createStarterHouse(anchor, { variant });
    const exterior = house.furniture.torches.filter(p => p.z === -1);
    const raised = [...exterior, house.entrance, above(house.entrance)];
    const world = new Map(raised.map(p => [posKey(p), 'podzol']));
    if (variant === 'hillside') {
      for (const b of house.blocks.filter(b => b.purpose === 'cave_wall')) world.set(posKey(b.position), 'stone');
    }
    const read = (x, y, z) => makeBlock(world.get(posKey({ x, y, z })) || (y < 64 ? 'dirt' : 'air'), { x, y, z });
    const center = { x: Math.floor(house.size / 2), y: 64, z: variant === 'hillside' ? -1 : Math.floor(house.size / 2) };
    const select = (protectedCell) => variant === 'hillside'
      ? chooseHillside(read, center, { avoid: a => posKey(a) !== posKey(anchor), protectedCell })
      : chooseSite(read, center, { radius: 0, variant, maxWork: raised.length, protectedCell });
    const result = select();
    assert.deepEqual(result.anchor, anchor);
    assert.equal(result.digs, raised.length + (variant === 'hillside' ? house.blocks.filter(b => b.purpose === 'cave_wall').length : 0));
    if (variant !== 'hillside') assert.equal(evaluateSite(read, anchor, center, { variant }).fills, 0);
    assert.equal(select(p => posKey(p) === posKey(exterior[0])), null);
    const work = siteWork(read, house, (p, b) => b.name === 'stone');
    assert.deepEqual(new Set(work.digs.map(d => posKey(d.position))), new Set(raised.map(posKey)));
    assert.deepEqual(work.digs[0].position, above(house.entrance));
  });
}

function finishedShell({ allTorches = false } = {}) {
  const h = createStarterHouse(anchor);
  const blocks = new Map();
  const install = (p, name) => blocks.set(posKey(p), name);
  for (const b of h.blocks) install(b.position, b.family === 'planks' ? 'oak_planks' : 'cobblestone');
  for (const id of ['crafting_table', 'furnace', 'chest']) install(h.furniture[id].position, id);
  for (const p of [h.furniture.door.position, h.furniture.door.upper]) install(p, 'oak_door');
  if (allTorches) for (const p of h.furniture.torches) install(p, 'torch');
  const bot = {
    entity: { position: new Vec3(3.5, 64, 1.5) },
    blockAt(p) { return makeBlock(blocks.get(posKey(p)) || (p.y < 64 ? 'dirt' : 'air'), p); },
    inventory: { items: () => [{ name: 'torch', count: 4 }] },
  };
  const state = { inventory: { torch: 4 }, position: bot.entity.position, isDay: true, timeOfDay: 1000, health: 20, food: 20 };
  const ctx = { perceive: () => state, record() {} };
  return { h, install, bot, state, ctx };
}

test('maintenance on an established autonomous home leaves its door open before night rest', async () => {
  const { bot, state, ctx } = finishedShell();
  const plan = [];
  const door = [];
  bot.activateBlock = async () => { door.push('activated'); };
  state.inventory = { crafting_table: 1 };
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true, gear: [],
    actions: { withinReach: () => true },
    skills: { useChest: async () => { plan.push('use_chest'); return { ok: true }; } } });
  assert.equal(goal.isDone(state), true);
  const maintenance = createHomeMaintenance({ bot, home: () => goal, activeGoal: () => 'stock_food' });
  state.timeOfDay = 12019;
  assert.ok(maintenance.want(state) > 0);
  const result = await maintenance.run({ ...ctx, behavior: maintenance.name });
  assert.equal(result.ok, true);
  assert.deepEqual(plan, ['use_chest']);
  assert.deepEqual(door, []);
  assert.equal(bot.companionSheltered, false);
});

test('earthwork actually removes doorway and podzol torch obstructions, then lighting can place the torch', async () => {
  const { bot, h, install, state, ctx } = finishedShell({ allTorches: true });
  const torch = h.furniture.torches.find(p => p.z < 0);
  install(torch, 'podzol');
  install(h.entrance, 'podzol');
  install(above(h.entrance), 'podzol');
  const dug = [];
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true, gear: [],
    actions: { goToDig: async () => ({ ok: true }), collectDrops: async () => ({ ok: true }),
      async digBlock(_b, _c, block) { dug.push(posKey(block.position)); install(block.position, 'air'); return { ok: true }; } },
    skills: { async placeAt(_b, _c, p) { install(p, 'torch'); return { ok: true }; } },
  });
  assert.equal(goal.isDone(state), false);
  for (let i = 0; i < 3; i++) assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(new Set(dug), new Set([torch, h.entrance, above(h.entrance)].map(posKey)));
  assert.equal(goal.isDone(state), true);
  assert.equal(goal.status(state).usable, true);
  assert.equal(goal.status(state).finished, false, 'the guest bed is still missing');
  assert.equal((await goal.lightingGoal().run(ctx)).ok, true);
  assert.equal(bot.blockAt(torch).name, 'torch');
});

test('a standalone home processes lighting at its floor and still surfaces from below the foundation', async () => {
  const { bot, state, ctx } = finishedShell();
  state.inventory = { oak_log: 3, oak_planks: 12 };
  const surfaceFailure = { ok: false, reason: 'still_below_surface' };
  let ascents = 0, smelts = 0;
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true,
    actions: { async surface() { ascents++; return surfaceFailure; } },
    skills: { async smelt(_bot, _ctx, step) {
      assert.equal(step.input, 'oak_log');
      smelts++;
      return { ok: true };
    } },
  });
  assert.equal(goal.isDone(state), true);
  assert.equal((await goal.lightingGoal().run(ctx)).ok, true);
  assert.equal(smelts, 1);
  assert.equal(ascents, 0);

  bot.entity.position = bot.entity.position.offset(0, -3, 0);
  const below = await goal.lightingGoal().run(ctx);
  assert.equal(below.reason, 'still_below_surface');
  assert.equal(smelts, 1);
  assert.equal(ascents, 1);
});

test('blocked optional lighting cannot gate completion and a protected obstacle is never dug', async () => {
  const { bot, h, install, state, ctx } = finishedShell({ allTorches: true });
  const torch = h.furniture.torches.find(p => p.z < 0);
  install(torch, 'podzol');
  // Door is to the right; the only adjacent outside alternative is also blocked.
  const alternate = { ...torch, x: torch.x - 1 };
  install(alternate, 'podzol');
  bot.companionPlayerBlock = p => [torch, alternate].some(q => posKey(p) === posKey(q));
  const records = [];
  ctx.record = (type, data) => records.push({ type, ...data });
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true, actions: { digBlock: () => assert.fail('player block dug') },
    skills: { placeAt: () => assert.fail('player cell received a placement') } });
  assert.equal(goal.isDone(state), true);
  for (let i = 0; i < 3; i++) await goal.lightingGoal().run(ctx);
  assert.equal(records.filter(e => e.type === 'target_failure' || e.type === 'target_excluded').length, 0);
  assert.equal(goal.maintenance(state).blocked.find(e => posKey(e.position) === posKey(torch)).reason, 'protected_player_block');
  assert.equal(goal.isDone(state), true);
  assert.equal(bot.blockAt(torch).name, 'podzol');
});

test('usable and decorated are distinct; only seeing every upgrade counts as finished', () => {
  const { h, install, bot, state } = finishedShell({ allTorches: true });
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true });
  assert.equal(goal.isDone(state), true, 'autonomy does not wait for a primary bed');
  assert.equal(goal.status(state).finished, false);
  install(h.furniture.guestBed.position, 'white_bed');
  assert.equal(goal.status(state).finished, false, 'one half is not a bed');
  install(h.furniture.guestBed.head, 'white_bed');
  assert.equal(goal.status(state).finished, true);
});

test('an established home protects its guest bed rather than plants in the planned bed cells', () => {
  const { h, install, bot, state } = finishedShell({ allTorches: true });
  const goal = createHomesteadGoal({ bot, anchor, autonomous: true });
  assert.equal(goal.isDone(state), true);
  const { position, head } = h.furniture.guestBed;
  for (const p of [position, head]) {
    install(p, 'poppy');
    assert.equal(goal.protects(p), false);
    install(p, 'white_bed');
    assert.equal(goal.protects(p), true);
  }
});

for (const [id, create] of [['cobble_generator', createCobbleGeneratorGoal], ['auto_smelter', createAutoSmelterGoal]]) {
  test(`${id}: an excluded required cell is not completed or retried by a fresh pinned goal`, async () => {
    const events = [];
    const bot = { entity: { position: new Vec3(12, 64, 12) }, inventory: { items: () => [] },
      blockAt(p) { return makeBlock(p.y < 64 ? 'stone' : 'air', p); } };
    const ctx = { record: (type, data) => events.push({ type, ...data }) };
    const make = () => create({ bot, anchor: { ...anchor, y: 63 },
      actions: { goToDig: async () => fail('NoPath'), goTo: async () => fail('NoPath') },
      skills: { isFluidSource: () => false, placeAt: async () => fail('NoPath') },
    });
    let machine = make();
    for (let i = 0; i < 3; i++) await machine.run(ctx);
    machine = make();
    assert.equal((await machine.run(ctx)).reason, 'device_target_excluded');
    assert.equal(machine.isDone(), false);
    const failures = events.filter(e => e.type === 'target_failure');
    assert.equal(failures.length, 3);
    assert(failures.every(e => e.goal === id && e.key === failures[0].key));
  });
}

test('farm replaces an excluded plot rather than lowering its sowing target', async () => {
  const { bot, state, ctx } = finishedShell();
  const first = { x: 8, y: 63, z: 8 }, second = { x: 9, y: 63, z: 8 };
  state.inventory.wheat_seeds = 2;
  const attempts = [];
  const farm = createFarmGoal({ bot, center: anchor, plots: 1, mode: 'sow',
    actions: { goTo: async () => ({ ok: true }) },
    farming: { plotState: () => 'empty', choosePlots: (_r, _p, opts) => [first, second].filter(p => !opts.exclude(p)).slice(0, opts.count),
      plant: async (_b, _c, p) => { attempts.push(posKey(p)); return posKey(p) === posKey(first) ? fail('plant_unconfirmed') : { ok: true }; } },
  });
  for (let i = 0; i < 4; i++) await farm.run(ctx);
  assert.deepEqual(attempts, [first, first, first, second].map(posKey));
  assert.equal(farm.isDone(state), false, 'a failed plot never counts as a planted crop');
});

test('a new stock-food card does not chase a previously excluded animal', async () => {
  const { bot, ctx } = finishedShell();
  bot.entities = { 1: { id: 1, uuid: 'animal-a', name: 'pig', position: new Vec3(5, 64, 1) },
    2: { id: 2, uuid: 'animal-b', name: 'cow', position: new Vec3(7, 64, 1) } };
  const tried = [];
  const originals = { attack: actions.attack, goTo: actions.goTo, collectDrops: actions.collectDrops, countItems: actions.countItems };
  try {
    actions.attack = async (_b, _c, id) => { tried.push(id); return id === 1 ? fail('chase_stuck') : { ok: true }; };
    actions.goTo = async () => ({ ok: true });
    actions.collectDrops = async () => ({ ok: true });
    actions.countItems = () => 0;
    for (let i = 0; i < 4; i++) await createStockFoodGoal({ bot }).run(ctx);
  } finally {
    Object.assign(actions, originals);
  }
  assert.deepEqual(tried, [1, 1, 1, 2]);
});
