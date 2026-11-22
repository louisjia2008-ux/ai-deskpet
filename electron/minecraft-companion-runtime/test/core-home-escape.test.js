'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createSelfStuck } = require('../core/self-stuck');
const { createTargetMemory, targetsFor } = require('../core/target-memory');
const { topology, safeStand } = require('../core/home-topology');
const { drySiteAccess } = require('../core/dry-route');
const { posKey } = require('../core/blacklist');
const { createProgression } = require('../core/goals/progression');
const { createDefaultCards } = require('../core/goals/registry');
const { createHomeEscape } = require('../core/behaviors/homeEscape');
const { chooseNext } = require('../core/director');
const { KNOWLEDGE } = require('../core/knowledge');
const { createAdaptation } = require('../core/adaptation');
const { homeContains } = require('../core/home-topology');
const actions = require('../core/actions');

function compact() {
  const blocks = new Map();
  const house = createStarterHouse(new Vec3(31, 76, 29), { variant: 'compact' });
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name);
  for (const b of house.blocks) put(b.position.x, b.position.y, b.position.z, b.phase === 'roof' ? 'spruce_planks' : 'coarse_dirt');
  put(32, 76, 30, 'crafting_table');
  put(34, 76, 31, 'white_bed');
  put(34, 76, 32, 'white_bed');
  put(34, 78, 31, 'air');
  const read = (p) => {
    const name = blocks.get(posKey(p)) || (p.y === 75 ? 'coarse_dirt' : 'air');
    return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  return { house, put, read };
}

test('saved compact floor has three unreachable stands, reconnected by removing its pillar', () => {
  const { house, put, read } = compact();
  put(33, 76, 31, 'coarse_dirt');
  put(33, 77, 31, 'coarse_dirt');
  const cells = topology(house, read);
  assert.deepEqual([...cells.reachable], ['33,76,30', '34,76,30']);
  assert.deepEqual(cells.disconnected.map(posKey), ['32,76,31', '32,76,32', '33,76,32']);
  assert.equal(topology(house, read, { remove: house.scaffold }).connected, true);
  assert.equal(topology(house, read, { remove: house.scaffold,
    occupy: [new Vec3(33, 76, 31)] }).connected, false);
  const bot = { entity: { position: new Vec3(32.5, 76, 32.5) }, blockAt: read };
  const goal = createHomesteadGoal({ bot, autonomous: true, anchor: house.anchor, variant: 'compact', gear: [] });
  bot.isSleeping = true;
  assert.equal(goal.trapped(), null);
  bot.isSleeping = false;
  assert.equal(goal.trapped(), 'interior_cut_off');
});

test('raised bed fails the standing check; escape only releases after stepping down and restoring an owned roof tile', async () => {
  const { house, put, read } = compact();
  const bed = new Vec3(34, 76, 31), landing = bed.offset(0, 0, -1), panel = landing.offset(0, 2, 0);
  const out = new Vec3(house.entrance.x, house.entrance.y, house.entrance.z);
  const aisle = out.offset(0, 0, 2);
  // No opening except above the bed itself. An unchanged tile is required.
  const hit = []; let look;
  const bot = {
    entity: { position: bed.offset(0.5, 0.5625, 0.5), onGround: true }, blockAt: read,
    inventory: { items: () => [{ name: 'spruce_planks' }] },
    lookAt: async (p) => { look = p; },
    setControlState: (key, on) => {
      if (key === 'forward' && on && Math.floor(look.z) === landing.z) {
        const stand = Math.floor(look.x) === aisle.x ? aisle : landing;
        bot.entity.position = stand.offset(0.5, 0, 0.5);
      }
    },
  };
  const actions = {
    goTo: async () => {
      if (bot.entity.position.floored().equals(bed)) return { ok: false, reason: 'not_arrived' };
      assert.ok(bot.entity.position.floored().equals(aisle));
      bot.entity.position = out.offset(0.5, 0, 0.5);
      return { ok: true };
    },
    digBlock: async (_bot, _ctx, b, { ownedHomeRemoval }) => {
      assert.deepEqual(b.position, panel);
      assert.equal(ownedHomeRemoval(b), true);
      put(panel.x, panel.y, panel.z, 'air');
      return { ok: true };
    },
  };
  const skills = { placeAt: async (_bot, _ctx, p, predicate) => {
    assert.equal(posKey(bot.entity.position.floored()), posKey(out));
    assert.equal(predicate('spruce_planks'), true);
    put(p.x, p.y, p.z, 'spruce_planks');
    bot.entity.position = landing.offset(0.5, 0, 0.5);
    return { ok: true };
  } };
  const goal = createHomesteadGoal({ bot, autonomous: true, anchor: house.anchor, variant: 'compact', gear: [], actions, skills });
  goal.restoreConstruction({ owned: { tile: { position: panel, name: 'spruce_planks' } } });
  assert.equal(safeStand(read, bed), false);
  assert.equal(goal.trapped(), 'bed_under_low_roof');
  const escaped = await goal.escapeHome({ record: (k) => hit.push(k) });
  assert.equal(escaped.ok, true, escaped.reason);
  assert.equal(read(panel).name, 'spruce_planks');
  assert.deepEqual(hit.filter(k => k !== 'home_doorway_crossed'),
    ['home_breach_opened', 'home_breach_repaired', 'self_stuck_escaped']);
});

test('three different path failures roll back only the stationary cluster, including a premature exclusion', async () => {
  const events = [];
  let now = 0;
  const bot = { entity: { position: new Vec3(0, 10, 0) }, blockAt: () => null };
  bot.companionTargets = createTargetMemory({ now: () => now });
  bot.companionSelfStuck = createSelfStuck(bot, { now: () => now, emit: (type, fields) => events.push({ type, ...fields }) });
  const targets = targetsFor(bot, { record: (type, fields) => events.push({ type, ...fields }) });
  const site = x => ({ goal: 'homestead', step: 'roof', position: { x, y: 12, z: 5 } });
  const failure = () => ({ ok: false, reason: 'not_arrived' });
  for (const at of [0, 10]) {
    now = at;
    await targets.run(site(4), failure);
  }
  now = 61_000;
  assert.equal((await targets.run(site(4), failure, failure)).targetExcluded, true);
  await targets.run(site(5), () => ({ ok: false, reason: 'NoPath' }));
  assert.equal((await targets.run(site(6), () => ({ ok: false, reason: 'path_timeout' }))).reason, 'self_stuck');
  assert.equal(targets.excluded(site(4)), null);
  assert.equal(bot.companionTargets.snapshot()[0].failures, 2);
  assert.equal(bot.companionTargets.snapshot().length, 1);
  assert.ok(events.some(e => e.type === 'target_failure_revoked' && e.target === '4,12,5' && e.excluded));
  assert.deepEqual(events.find(e => e.type === 'self_stuck').targets, ['4,12,5', '5,12,5', '6,12,5']);
});

test('one animal with three blocked approaches sends the body out through the closed home door without exclusions', async () => {
  const { house, read } = compact();
  const position = new Vec3(33.5, 76, 30.5);
  const door = house.furniture.door;
  const porch = new Vec3(house.entrance.x, house.entrance.y, house.entrance.z);
  const pig = { id: 2, uuid: 'same-pig', name: 'pig', position: new Vec3(49.5, 76, 30.5) };
  let open = false;
  const bot = {
    entity: { position, onGround: true },
    entities: { 2: pig },
    blockAt(p) {
      if ([door.position, door.upper].some(cell => p.equals(cell))) {
        return { ...read(p), name: 'oak_door', getProperties: () => ({ open, facing: 'north' }) };
      }
      return read(p);
    },
    async activateBlock(block) {
      assert.ok(block.position.equals(door.position));
      open = !open;
    },
    pathfinder: { async goto(target) {
      if (target.constructor.name === 'GoalBlock' && open) {
        assert.ok(target.isEnd(porch));
        bot.entity.position = porch.offset(0.5, 0, 0.5);
        return;
      }
      throw Object.assign(new Error('closed door prevents native path'), { name: 'NoPath' });
    } },
  };
  const home = createHomesteadGoal({ bot, autonomous: true, anchor: house.anchor, variant: 'compact', gear: [] });
  home.memory.established = true;
  bot.companionHomestead = () => home;
  const events = [];
  const record = (type, data) => events.push({ type, ...data });
  bot.companionTargets = createTargetMemory();
  bot.companionSelfStuck = createSelfStuck(bot, { emit: record });
  const failPath = { ok: false, reason: 'NoPath' };
  assert.equal(actions.originFailure(bot, failPath, position, house.interiorCenter), failPath);
  assert.equal(actions.originFailure(bot, failPath, position.offset(3, 0, 0), pig.position), failPath);

  const food = createDefaultCards({ bot, progression: true }).cards.find(c => c.id === 'stock_food');
  const state = { alive: true, isDay: true, health: 20, food: 20, inventory: {}, position };
  const selection = chooseNext(state, { homestead: home }, [food], { stage: 0 });
  assert.equal(selection.card?.id, 'stock_food');
  const goal = selection.card.create();
  const ctx = { perceive: () => state, record };
  assert.equal(open, false);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await goal.run(ctx)).reason, 'self_stuck');
  }
  assert.deepEqual(bot.companionTargets.snapshot(), []);
  assert.equal(events.filter(e => e.type === 'hunt_target' && e.mob === 'pig').length, 3);
  assert.equal(events.filter(e => e.type === 'target_failure' || e.type === 'target_excluded').length, 0);
  assert.equal(events.find(e => e.type === 'self_stuck')?.reason, 'route_origin_home_exit_blocked');
  const escape = createHomeEscape({ bot, tracker: bot.companionSelfStuck, home: () => home });
  assert.equal(escape.want(state), 1);
  assert.equal((await escape.run(ctx)).ok, true);
  assert.equal(open, true);
  assert.ok(bot.entity.position.floored().equals(porch));
});

test('a waterfront sighting does not count as accessible wood across a river', () => {
  const house = createStarterHouse({ x: -3, y: 0, z: 0 }, { variant: 'compact' });
  const tree = new Vec3(6, 0, -1);
  const read = (p) => {
    if (p.equals(tree)) return { name: 'oak_log', boundingBox: 'block' };
    if (p.y === -1) return { name: 'grass_block', boundingBox: 'block' };
    if (p.x === 3 && p.y === 0) return { name: 'water', boundingBox: 'empty' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const access = drySiteAccess(read, house.entrance, [tree]);
  assert.equal(access(house, false), null);
  assert.equal(access(house, true).stocked, true);
  assert.equal(drySiteAccess(read, house.entrance, [new Vec3(2, 0, -1)])(house, false).tree.x, 2);
});

test('nearby reachable daylight distinguishes a canopy and a ledge from a sealed cave and open shaft', () => {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, companionSurfaceY: 85 };
  const terrain = (classify) => p => {
    const name = classify(p);
    return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const ground = (p, above) => p.y < 64 ? 'stone' : above;
  bot.blockAt = terrain(p => ground(p, p.x === 0 && p.z === 0 && p.y === 66 ? 'oak_log' : 'air'));
  assert.equal(actions.underground(bot), false);
  bot.blockAt = terrain(p => ground(p, p.x <= 0 && p.y === 66 ? 'stone' : 'air'));
  assert.equal(actions.underground(bot), false);
  bot.blockAt = terrain(p => ground(p, p.y === 66 ? 'stone' : 'air'));
  assert.equal(actions.underground(bot), true);
  bot.blockAt = terrain(p => ground(p, p.y <= 67 && (p.x !== 0 || p.z !== 0) ? 'stone' : 'air'));
  assert.equal(actions.underground(bot), true);
});

test('saved home positions are purged from route and target memory when home becomes available', async () => {
  const { house } = compact();
  const p = house.entrance;
  const far = { ...p, x: p.x + 40 };
  const spec = position => ({ goal: 'homestead', step: 'place_torch', position });
  let saved;
  let activeHome = null;
  const options = { now: () => 10, atHome: (position, dimension) => dimension === 'overworld' && homeContains(activeHome, position),
    store: { load: () => saved, save: profile => { saved = JSON.parse(JSON.stringify(profile)); } } };
  let adaptation = createAdaptation(options);
  for (const position of [p, far]) {
    adaptation.teach('hard_route', position, 'overworld', 'NoPath', 6);
    const targets = adaptation.targets.scope();
    for (let i = 0; i < 3; i += 1) await targets.run(spec(position), () => ({ ok: false, reason: 'NoPath' }));
  }
  delete saved.targets[0].position; // Legacy coordinate-keyed profile.
  adaptation = createAdaptation(options);
  activeHome = house;
  adaptation.pruneHome();
  adaptation.teach('hard_route', p, 'overworld', 'NoPath', 6);
  const targets = adaptation.targets.scope();
  assert.equal(targets.excluded(spec(p)), null);
  assert.ok(targets.excluded(spec(far)));
  assert.equal(adaptation.avoids('hard_route', p), false);
  assert.equal(adaptation.avoids('hard_route', far), true);
  assert.deepEqual(saved.lessons.map(e => e.position), [far]);
  assert.deepEqual(saved.targets.map(e => e.position), [far]);
  await targets.run(spec(p), () => ({ ok: false, reason: 'NoPath' }));
  assert.equal(saved.targets.length, 1);
});

test('route ladders distinguish starting regions while one shaft keeps its learned rung across heights', async () => {
  const adaptation = createAdaptation();
  const pos = { x: 3, y: 30, z: 7 };
  const shaft = { position: pos };
  await adaptation.scope(() => true).run('pit', shaft, () => ({ ok: false, reason: 'NoPath' }), { threshold: 1 });
  assert.equal(adaptation.plan('pit', { position: { ...pos, y: 54 } }).method, 'direct_pillar');
  assert.equal(adaptation.plan('pit', { position: { ...pos, x: pos.x + 1 } }).method, 'pathfinder');
  const routeFrom = origin => ({ position: pos, origin, target: 'walk' });
  const a = routeFrom({ x: 22, y: 70, z: 7 });
  const b = routeFrom({ x: 54, y: 70, z: 7 });
  await adaptation.scope(() => true).run('route', a, () => ({ ok: false, reason: 'NoPath' }), { threshold: 1 });
  assert.equal(adaptation.plan('route', a).method, 'waypoint');
  assert.equal(adaptation.plan('route', b).method, 'direct');
});

test('returning from underground accepts local daylight below the home height before walking home in legs', async () => {
  const { house } = compact();
  const seen = [];
  const bot = {
    entity: { position: new Vec3(122.5, 54, 28.5), onGround: true },
    companionSurfaceY: 76,
    companionHomestead: () => ({ memory: { house } }),
    registry: { itemsByName: {} },
    blockAt(p) {
      const name = p.y <= 69 && p.x >= 100 && p.y !== 54 && p.y !== 55 ? 'stone'
        : p.y < 76 && p.x < 100 ? 'grass_block' : 'air';
      return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    pathfinder: { movements: {}, async goto(goal) {
      seen.push(goal.constructor.name);
      if (goal.constructor.name === 'GoalY') bot.entity.position = bot.entity.position.offset(0, 16, 0);
      else bot.entity.position = new Vec3(goal.x + 0.5, goal.y ?? 76, goal.z + 0.5);
    } },
  };
  const events = [];
  const adaptation = createAdaptation({ onEvent: event => events.push(event) });
  const result = await actions.goNear(bot, { adapt: adaptation.scope(() => true), record: (type, fields) => events.push({ type, ...fields }) },
    new Vec3(house.entrance.x, house.entrance.y, house.entrance.z), 0, { exact: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(seen[0], 'GoalY');
  assert.ok(seen.slice(1, -1).length >= 3 && seen.slice(1, -1).every(s => s === 'GoalNearXZ'));
  assert.deepEqual(posKey(bot.entity.position), posKey(house.entrance));
  assert.equal(events.find(e => e.type === 'home_route_recovery' && e.phase === 'finish').position.y, 70);
  assert.equal(events.filter(e => e.type === 'adaptation_lesson' || e.type === 'target_excluded').length, 0);
});

test('compact roof can place a connecting panel in the same build turn as an unreachable corner', async () => {
  const { house, put, read } = compact();
  const corner = new Vec3(35, 78, 29);
  const connector = corner.offset(0, 0, 1);
  const place = (p, block) => put(p.x, p.y, p.z, block);
  for (const entry of house.blocks) place(entry.position, entry.phase === 'roof' ? 'spruce_planks' : 'dirt');
  for (const p of house.scaffold) place(p, 'coarse_dirt');
  place(corner, 'air');
  place(connector, 'air');
  const bot = { entity: { position: new Vec3(33.5, 79, 31.5) }, blockAt: read };
  const inventory = { spruce_planks: 20, crafting_table: 1, oak_door: 1 };
  const state = { inventory, position: bot.entity.position, isDay: true, timeOfDay: 1000, health: 20, food: 20 };
  const places = [];
  const noPath = () => ({ ok: false, reason: 'NoPath' });
  const goal = createHomesteadGoal({ bot, autonomous: true, anchor: house.anchor, variant: 'compact', gear: [],
    actions: { goTo: async () => noPath() },
    skills: { async placeAt(_bot, _ctx, position) {
      places.push(posKey(position));
      if (posKey(position) === posKey(corner) && read(connector).name === 'air') return noPath();
      place(position, 'spruce_planks');
      return { ok: true };
    } },
  });
  const ctx = { perceive: () => state, record() {} };
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(places, [corner, connector].map(posKey));
  assert.equal(read(corner).name, 'air');
  assert.equal(read(connector).name, 'spruce_planks');
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(read(corner).name, 'spruce_planks');
});

test('iron armor cannot run ahead of the farm or unfinished house, even with other cards on cooldown', () => {
  const bot = { game: { dimension: 'overworld' }, inventory: { items: () => [], slots: [] } };
  const { cards, stageOf } = createProgression({ bot, kb: KNOWLEDGE, homeOf: () => null });
  let finished = false;
  const memory = { homestead: { isDone: () => true, status: () => ({ finished }),
    wantsGuestBed: () => !finished, wantsLighting: () => !finished } };
  const state = { inventory: {}, isDay: true, health: 20, food: 20 };
  const pick = (cooldowns) => chooseNext(state, memory, cards, { stage: stageOf(state, memory), cooldowns }).card?.id;
  assert.equal(pick(), 'iron_tools');
  Object.assign(state.inventory, { iron_pickaxe: 1, iron_sword: 1, shield: 1 });
  assert.equal(pick(), 'wheat_farm');
  memory.wheatFarmDone = true;
  assert.equal(pick(), 'home_lighting');
  const cooldown = new Map(['home_lighting', 'guest_bed'].map(k => [k, { until: Date.now() + 30_000 }]));
  assert.equal(pick(cooldown), undefined);
  finished = true;
  assert.equal(pick(), 'iron_armor');
});
