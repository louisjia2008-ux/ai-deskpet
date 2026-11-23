'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createBrain, BAND } = require('../core/brain');
const { createRecovery } = require('../core/behaviors/recovery');
const { createNightRest } = require('../core/behaviors/nightRest');
const { perceive } = require('../core/perception');
const { isSurveyNight } = require('../core/survey-plan-actions');
const { createStance } = require('../core/stance');
const { prepareShelterSeal, digIn } = require('../core/skills');
const { factsOf, failure } = require('../core/action-result');
const { ledgerFor, ledgerTarget } = require('../core/failure-ledger');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('perception and survey share the day and night boundaries', () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, time: {} };
  for (const [timeOfDay, day] of [[undefined, null], [11800, true], [12541, true], [12542, false], [23460, false], [23461, true]]) {
    bot.time.timeOfDay = timeOfDay;
    assert.equal(perceive(bot).isDay, day);
    assert.equal(isSurveyNight(bot), day === false);
  }
});

test('a goal that gives up ends at once with its reason, not after the stall budget', async () => {
  const events = [];
  const brain = createBrain({ perceive: () => ({}), onEvent: (e) => events.push(e), noProgressLimit: 40 });
  let runs = 0;
  brain.setGoal({ name: 'homestead', band: BAND.GOAL, isDone: () => false, progress: () => 0,
    async run(ctx) { runs += 1; return failure('none_near_site:log within 128 of 0,64,0', { terminal: true }, ctx); } });
  await brain.tick();
  await wait(20);
  const failed = events.find((e) => e.type === 'goal_failed');
  assert.equal(runs, 1);
  assert.deepEqual(failed?.reasons, ['none_near_site:log within 128 of 0,64,0']);
  await brain.dispose?.();
});

test('a death right after respawning does not count towards the task, a third death still ends it', async () => {
  const bot = Object.assign(new EventEmitter(), { username: 'DeskPetCore', entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' } });
  const failures = [];
  const recovery = createRecovery({ bot, thresholds: { respawnDeathsAllowed: 1 } });
  recovery.attach({ failGoal: async (reason) => { failures.push(reason); } });
  recovery.observe({ type: 'goal_set' });
  bot.emit('death');
  bot.emit('messagestr', 'DeskPetCore was shot by Skeleton');
  bot.emit('spawn');
  // Blown up at the spawn point straight after respawning: the spawn's, not the task's.
  bot.emit('death');
  bot.emit('messagestr', 'DeskPetCore was blown up by Creeper');
  await wait(1700);
  assert.deepEqual(failures, []);
  bot.emit('spawn');
  bot.emit('death');
  await wait(1700);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^death_loop: was shot by Skeleton at 0,64,0; was blown up by Creeper at 0,64,0 just after respawning; died at 0,64,0 just after respawning$/);
  recovery.dispose();
});

test('with no house and no task the bot digs in where it stands at night', async () => {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(5, 70, 5) }, game: { dimension: 'overworld' } });
  const dug = [];
  const rest = createNightRest({ bot, home: () => ({ bed: null, centre: null }),
    actions: { underground: () => false },
    skills: { digIn: async () => { dug.push(true); return { ok: true, bunker: { top: { x: 5, y: 70, z: 5 } } }; } } });
  assert.equal(rest.want({ isDay: true }), 0);
  assert.equal(rest.want({ isDay: false }), 0.8);
  const result = await rest.run({ perceive: () => ({ isDay: false }), record: () => {}, signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.equal(dug.length, 1);
  assert.equal(bot.companionSheltered, true);
  rest.dispose();
});

test('autonomous night rest replenishes the seal reserve during daylight only', async () => {
  const bot = { game: { dimension: 'overworld' } };
  const state = { inventory: { sand: 7 }, isDay: true, timeOfDay: 11000, onGround: true };
  const rest = createNightRest({ bot, home: () => null, prepareSeals: () => true,
    actions: { underground: () => false },
    skills: { prepareShelterSeal: async () => {
      state.inventory.sand = 3;
      state.inventory.sandstone = 1;
      state.inventory.dirt = 1;
      return { ok: true };
    } } });
  const records = [];
  assert.equal(rest.want({ ...state, timeOfDay: 1000 }), 0);
  assert.equal(rest.want({ ...state, inWater: true }), 0);
  assert.equal(rest.want({ ...state, timeOfDay: 12200 }), 0);
  assert.ok(rest.want(state) > 0);
  assert.equal((await rest.run({ perceive: () => state, record: (type, event) => records.push({ type, ...event }) })).ok, true);
  assert.equal(rest.want(state), 0);
  assert.equal(records.at(-1).action, 'prepare_seal');
});

test('the carried sand can become a stable lid before the bunker site is selected', async () => {
  function sandyBot() {
    const items = [{ name: 'sand', count: 7 }];
    const bot = { inventory: { items: () => items, slots: [] }, registry: { itemsByName: { sandstone: { id: 1 } } },
      entity: { position: new Vec3(0, 64, 0) },
      recipesFor: () => [{}], blockAt: () => ({ name: 'water', boundingBox: 'empty' }),
      async craft() { items[0].count -= 4; items.push({ name: 'sandstone', count: 1 }); } };
    return { bot, items };
  }
  const first = sandyBot();
  const result = await prepareShelterSeal(first.bot, {}, { want: 1 });
  assert.deepEqual(result, { ok: true, progress: true });
  assert.deepEqual(factsOf(result), { gained: 1, method: 'craft_sandstone' });
  assert.equal(first.items[0].count, 3);
  const automatic = sandyBot();
  assert.equal((await digIn(automatic.bot, {}, { prepareSeal: true })).reason, 'no_bunker_spot');
  assert.equal(automatic.items[1].name, 'sandstone');
  const manual = sandyBot();
  assert.equal((await digIn(manual.bot, {})).reason, 'no_seal_block');
  assert.equal(manual.items[0].count, 7);
});

test('the finished roof does not suppress night rest; shut the shelter and open it at dawn', async () => {
  const centre = new Vec3(5, 70, 5);
  const bot = { entity: { position: centre.offset(0.5, 0, 0.5) }, game: { dimension: 'overworld' } };
  const door = [];
  let inside = false;
  let isDay = false;
  const perceive = () => ({ isDay });
  const rest = createNightRest({ bot, home: () => ({ bed: null, centre, inside }),
    actions: { underground: () => true },
    shelterDoor: async (_ctx, open) => { door.push(open); return { ok: true }; } });
  assert.equal(rest.want(perceive()), 0); // ordinary underground mining
  inside = true;
  assert.equal(rest.want(perceive()), 0.8);
  await rest.run({ perceive });
  isDay = true;
  assert.equal(rest.want(perceive()), 0.8);
  await rest.run({ perceive });
  assert.deepEqual(door, [false, true]);
  assert.equal(rest.want(perceive()), 0);
});

test('night rest reopens its door at dawn when the server processed a canceled close', async () => {
  const centre = new Vec3(5, 70, 5);
  const bot = { entity: { position: centre.offset(0.5, 0, 0.5) }, game: { dimension: 'overworld' } };
  let closed = false;
  let state = { isDay: false, timeOfDay: 13000 };
  const rest = createNightRest({ bot, home: () => ({ bed: null, centre, inside: true }),
    shelterDoor: async (_ctx, open) => {
      closed = !open;
      if (!open) throw new Error('canceled after server close');
      return { ok: true };
    } });
  const ctx = { perceive: () => state };
  await assert.rejects(rest.run(ctx), /canceled after server close/);
  assert.equal(closed, true);
  state = { isDay: true, timeOfDay: 1000 };
  assert.equal(rest.want(state), 0.8);
  assert.equal((await rest.run(ctx)).ok, true);
  assert.equal(closed, false);
  assert.equal(rest.want(state), 0);
});

test('holding ground (owner first) takes on worse odds, and leaves before one more round of hits could kill', () => {
  const s = createStance({ now: () => 0 });
  const sword = { stone_sword: 1 };
  const two = [{ name: 'zombie', distance: 2 }, { name: 'zombie', distance: 3 }];
  // Twelve health and a stone sword: backs off on its own account, stays for the owner.
  assert.equal(s.read({ health: 12, inventory: sword }, two, two[0]).stance, 'retreat');
  s.reset();
  assert.equal(s.read({ health: 12, inventory: sword }, two, two[0], { holdGround: true }).stance, 'fight');
  s.reset();
  // Bare hands against two is still no fight, owner or not.
  assert.equal(s.read({ health: 20, inventory: {} }, two, two[0], { holdGround: true }).reason, 'outmatched');
  s.reset();
  // On hard two zombies beside it take 9 a round: at 8.8 it goes (it died there holding a line at 3).
  assert.equal(s.read({ health: 8.8, inventory: sword }, two, two[0], { holdGround: true, difficulty: 'hard' }).reason, 'hurt');
  s.reset();
  // One of the two a step out counts as well: it is on the bot within the second.
  const closing = [{ name: 'zombie', distance: 1.3 }, { name: 'zombie', distance: 3.7 }];
  assert.equal(s.read({ health: 8.5, inventory: sword }, closing, closing[0], { holdGround: true, difficulty: 'hard' }).reason, 'hurt');
  s.reset();
  // The same health on normal (6 a round) still fights.
  assert.equal(s.read({ health: 8.8, inventory: { iron_sword: 1 } }, two, two[0], { holdGround: true }).stance, 'fight');
  s.reset();
  assert.equal(s.read({ health: 20, inventory: sword }, [{ name: 'creeper', distance: 3 }], null, { holdGround: true }).reason, 'creeper');
});

test('buried by sand, the bot digs its head free before anything else', async () => {
  const { createSurvivalBehaviors } = require('../core/behaviors/survival');
  const cube = (name) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const world = new Map([['0,65,0', cube('sand')], ['0,66,0', cube('sand')]]);
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' }, entities: {},
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) || air,
    canDigBlock: () => true,
  });
  const dug = [];
  // Each dig lets the next sand block fall into the cleared cell, once.
  const actions = { digBlock: async (_bot, _ctx, block) => {
    dug.push(block.name);
    world.delete('0,65,0');
    if (world.has('0,66,0')) { world.delete('0,66,0'); world.set('0,65,0', cube('sand')); }
    return { ok: true };
  } };
  const unbury = createSurvivalBehaviors({ bot, actions }).find((b) => b.name === 'unbury');
  assert.equal(unbury.want({}), 1);
  // Asleep in bed, the ceiling at eye level is no burial.
  bot.isSleeping = true;
  assert.equal(unbury.want({}), 0);
  bot.isSleeping = false;
  const result = await unbury.run({ perceive: () => ({}), record: () => {}, signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.deepEqual(dug, ['sand', 'sand']);
  assert.equal(unbury.want({}), 0);
  // Standing on a slab (feet inside a part block) is not buried.
  world.set('0,65,0', { name: 'oak_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] });
  assert.equal(unbury.want({}), 0);
});

test('hunting skips animals far above or below, and leaves an unreachable one alone for five minutes', async () => {
  const skills = require('../core/skills');
  const bot = { entity: { position: new Vec3(0, 30, 0) }, entities: {
    1: { id: 1, name: 'pig', position: new Vec3(20, 70, 0) },
    2: { id: 2, name: 'pig', position: new Vec3(40, 32, 0) },
  } };
  const recorded = [];
  const ctx = { record: (type, data) => recorded.push({ type, ...data }), signal: new AbortController().signal };
  // goNear fails: the cave-level pig is out of reach.
  const actions = require('../core/actions');
  const original = actions.goNear;
  actions.goNear = async () => ({ ok: false, reason: 'path_timeout' });
  try {
    const result = await skills.huntOne(bot, ctx, { mobs: ['pig'], dropMatch: () => true, radius: 96 });
    assert.equal(result.reason, 'path_timeout');
  } finally { actions.goNear = original; }
  // The pig on the hill forty blocks up was never picked; the one tried is set aside.
  assert.deepEqual(recorded.filter((r) => r.type === 'hunt_target').map((r) => r.distance), [40]);
  const skipped = id => ledgerFor(bot).skip(ledgerTarget(bot, 'hunt_far', bot.entities[id].position, { entity: id }));
  assert.ok(skipped(2));
  assert.equal(skipped(1), null);
});

// Regressed, this test hangs rather than fails: the starved loop starves the
// runner's own timeout too (as it starved the host's stdin).
test('a goal that settles after long synchronous work still lets I/O in between runs', { timeout: 5000 }, async () => {
  const brain = createBrain({ perceive: () => ({}), noProgressLimit: 1000, goalRetryDelayMs: 0 });
  let runs = 0;
  // A scan for a tree that is not there: busy for a while, then "skipped", over and over.
  brain.setGoal({ name: 'homestead', band: BAND.GOAL, isDone: () => false, progress: () => runs,
    async run() { runs += 1; const until = Date.now() + 10; while (Date.now() < until) { /* scan */ } return { ok: true }; } });
  await brain.tick();
  // Starved, this setImmediate (stdin, in the host) would never run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(runs >= 2);
  await brain.dispose?.();
});

test('surfacing for air three times in a minute swims the bot ashore', async () => {
  const { createSurvivalBehaviors } = require('../core/behaviors/survival');
  const water = { name: 'water', boundingBox: 'empty', shapes: [] };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 60, 0.5), isInWater: true }, game: { dimension: 'overworld' }, entities: {},
    oxygenLevel: 20, blockAt: () => water, setControlState: () => {}, lookAt: async () => {},
  });
  let ashore = 0;
  const actions = { swimAshore: async () => { ashore += 1; return true; }, digBlock: async () => ({ ok: true }) };
  const breathe = createSurvivalBehaviors({ bot, actions }).find((b) => b.name === 'breathe');
  const ctx = { perceive: () => ({}), record: () => {}, signal: new AbortController().signal };
  await breathe.run(ctx);
  await breathe.run(ctx);
  assert.equal(ashore, 0);
  await breathe.run(ctx);
  assert.equal(ashore, 1);
});

test('a bot dug in only for want of a task digs out when it is given one', async () => {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(5, 70, 5) }, game: { dimension: 'overworld' } });
  let task = null;
  const dug = { in: 0, out: 0 };
  const rest = createNightRest({ bot, home: () => (task ? null : { bed: null, centre: null }),
    actions: { underground: () => false },
    skills: { digIn: async () => { dug.in += 1; return { ok: true, bunker: { top: { x: 5, y: 70, z: 5 } } }; },
      digOut: async () => { dug.out += 1; return { ok: true }; } } });
  const ctx = { perceive: () => ({ isDay: false }), record: () => {}, signal: new AbortController().signal };
  await rest.run(ctx);
  assert.equal(dug.in, 1);
  // Still idle: it waits out the night down there.
  await rest.run(ctx);
  assert.equal(dug.out, 0);
  // The owner asks to be followed.
  task = 'follow_owner';
  assert.equal(rest.want({ isDay: false }), 0.8);
  await rest.run(ctx);
  assert.equal(dug.out, 1);
  assert.equal(rest.want({ isDay: false }), 0);
  rest.dispose();
});

test('a new task cuts short a chore that no longer wants the body, never a fight', async () => {
  let following = false;
  let aborted = null;
  const chase = { name: 'provision', band: BAND.MAINTENANCE, want: () => (following ? 0 : 0.5),
    run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => { aborted = 'provision'; resolve({ ok: false, reason: 'aborted' }); })) };
  const brain = createBrain({ perceive: () => ({}), behaviors: [chase] });
  await brain.tick();
  assert.equal(brain.status().running, 'provision');
  following = true;
  brain.setGoal({ name: 'follow_owner', band: BAND.GOAL, isDone: () => false, progress: () => 0,
    run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))) });
  await wait(20);
  assert.equal(aborted, 'provision');
  await brain.dispose?.();

  // A fight in progress is left alone.
  let fightAborted = false;
  const fight = { name: 'defend', band: BAND.DEFENSE, want: () => 0,
    run: (ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => { fightAborted = true; resolve({ ok: false }); }); setTimeout(() => resolve({ ok: true }), 50); }) };
  const fightWant = { ...fight, want: () => 1 };
  const second = createBrain({ perceive: () => ({}), behaviors: [fightWant] });
  await second.tick();
  fightWant.want = () => 0;
  second.setGoal({ name: 'follow_owner', band: BAND.GOAL, isDone: () => false, progress: () => 0, run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))) });
  await wait(20);
  assert.equal(fightAborted, false);
  await second.dispose?.();
});

test('night shelter: guarding the owner goes on, any other task stops for the night', () => {
  const { nightShelter } = require('../core/companion');
  const bot = { blockAt: () => ({ name: 'red_bed' }), inventory: { items: () => [], slots: [] } };
  const house = { furniture: { bed: { position: { x: 1, y: 64, z: 2 } } }, interiorCenter: { x: 2, y: 64, z: 3 } };
  // With a house, a guard at night went home to bed and left the owner.
  assert.equal(nightShelter(bot, { house, goal: 'follow_owner' }), null);
  assert.equal(nightShelter(bot, { house: null, goal: 'come_to_owner' }), null);
  assert.equal(nightShelter(bot, { house: null, goal: 'homestead' }), null);
  // Without one, a farm waiting on wheat stood the whole night in the open.
  assert.deepEqual(nightShelter(bot, { house: null, goal: 'farm' }), { bed: null, centre: null });
  assert.deepEqual(nightShelter(bot, { house: null, goal: null }), { bed: null, centre: null });
  assert.deepEqual(nightShelter(bot, { house, goal: 'gather_logs' }), { bed: house.furniture.bed.position, centre: house.interiorCenter });
  // A hunt for a night mob, armed and armoured, stays out.
  const armed = { ...bot, inventory: { items: () => [{ name: 'iron_sword' }], slots: { 6: { name: 'iron_chestplate' } } } };
  assert.equal(nightShelter(armed, { house: null, goal: 'gather_materials', hunt: { at: 1000 }, now: 2000 }), null);
  assert.deepEqual(nightShelter(bot, { house: null, goal: 'gather_materials', hunt: { at: 1000 }, now: 2000 }), { bed: null, centre: null });
});
