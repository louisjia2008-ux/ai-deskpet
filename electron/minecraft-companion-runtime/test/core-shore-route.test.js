'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('../core/actions');
const shore = require('../core/shore-route');
const { installPlacedMemory } = require('../core/placed');
const { posKey } = require('../core/blacklist');

function terrain({ start, target, blockName }) {
  const changes = new Map();
  const context = { events: [], record(type, fields) { this.events.push({ type, ...fields }); } };
  const bot = {
    entity: { position: start, onGround: true, isInWater: false },
    companionHomeTarget: p => p.x === target.x && p.z === target.z,
    blockAt(p) {
      const name = changes.get(posKey(p)) || blockName(p);
      return { name, position: p, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block',
        stateId: { air: 0, water: 1, stone: 2, dirt: 3 }[name], diggable: true };
    },
    pathfinder: { movements: { exclusionAreasStep: [] }, setGoal() {} },
    inventory: { items: () => [{ name: 'dirt', count: 3 }] },
    canDigBlock: () => true,
    async equip() {},
    async placeBlock(reference, face) { changes.set(posKey(reference.position.plus(face)), 'dirt'); },
    async dig(block) { changes.set(posKey(block.position), 'air'); },
  };
  return { bot, context, changes };
}

for (const first of ['wet', 'path_timeout', 'not_arrived', 'costlier', 'shorter']) {
  test(`home route checks both the landing and remaining route cost after ${first}`, async () => {
    const home = new Vec3(42, 2, 0);
    const water = p => p.x === 16 && p.z === 0 && p.y === 1 && first === 'wet';
    const { bot, context } = terrain({ start: new Vec3(0.5, 2, 0.5), target: home,
      blockName: p => water(p) ? 'water' : (p.y < 2 ? 'stone' : 'air') });
    let leg = 0;
    bot.pathfinder.goto = async goal => {
      const intermediate = goal.constructor.name === 'GoalNearXZ';
      if (intermediate && leg++ === 0) {
        if (first === 'wet') {
          bot.entity.position = new Vec3(16.5, 1, 0.5);
          bot.entity.isInWater = true;
          bot.entity.onGround = false;
          return;
        }
        bot.entity.position = new Vec3(first === 'not_arrived' ? 7.5 : 16.5, 2, 0.5);
        if (first === 'path_timeout') throw Object.assign(new Error('timeout'), { code: 'path_timeout' });
        return;
      }
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y ?? 2, goal.z + 0.5);
    };
    bot.lookAt = async () => {};
    bot.setControlState = (name, value) => {
      if (name === 'forward' && value && bot.entity.isInWater) {
        bot.entity.position = new Vec3(15.5, 2, 0.5);
        bot.entity.isInWater = false;
        bot.entity.onGround = true;
      }
    };
    const collisionIndex = { '0,2,0': 2 };
    bot.pathfinder.movements.entityIntersections = collisionIndex;
    bot.pathfinder.getPathFromTo = function * (profile, from) {
      profile.entityIntersections = {};
      const cost = first === 'costlier' && from.x === 16.5 ? 100 : Math.max(0, 42 - Math.floor(from.x));
      yield { result: { status: 'success', cost } };
    };
    const result = await actions.goNear(bot, context, home, 0, { exact: true });
    const recorded = context.events.find(e => e.type === 'home_route_leg');
    assert.equal(result.ok, true);
    assert.equal(recorded.dry, first !== 'wet');
    assert.equal(recorded.advanced, first === 'shorter');
    assert.equal(bot.pathfinder.movements.entityIntersections, collisionIndex);
    if (first === 'costlier' || first === 'shorter') assert.equal(recorded.measure, 'native_cost');
    if (first === 'path_timeout' || first === 'not_arrived') assert.equal(recorded.reason, first);
    if (first === 'wet') assert.equal(recorded.arrived, true);
  });
}

function narrowChannel({ protect = false } = {}) {
  const home = new Vec3(12, 3, 0);
  const wetStrip = p => p.x === 1 || p.x === 2;
  const result = terrain({ start: new Vec3(0.5, 3, 0.5), target: home,
    blockName: p => wetStrip(p) ? (p.y === 1 ? 'water' : p.y < 1 ? 'stone' : 'air')
      : p.y < 3 ? 'stone' : 'air' });
  const { bot, context } = result;
  const dispose = installPlacedMemory(bot);
  bot.pathfinder.goto = async goal => {
    const place = new Vec3(goal.x, goal.y, goal.z);
    if (goal.constructor.name === 'GoalNear' && bot.entity.position.x < 3) {
      throw Object.assign(new Error('no dry path until bridge'), { code: 'NoPath' });
    }
    assert.equal(bot.blockAt(place.offset(0, -1, 0)).boundingBox, 'block');
    bot.entity.position = place.offset(0.5, 0, 0.5);
  };
  if (protect) context.protectedCell = p => p.x === 1 && p.y === 2 && p.z === 0;
  return { ...result, home, dispose };
}

test('two returns to the same bank prefer a dry path and clean a bounded temporary bridge', async (t) => {
  const { bot, context, home, dispose } = narrowChannel();
  t.after(dispose);
  const result = await actions.goNear(bot, context, home, 0, { exact: true });
  assert.equal(result.ok, true);
  assert.equal(posKey(bot.entity.position), posKey(home));
  assert.deepEqual(context.events.filter(e => e.type === 'home_route_shore').map(e => e.phase), ['alternate']);
  assert.deepEqual(context.events.filter(e => e.type === 'route_bridge_placed').map(e => posKey(e.position)), ['1,2,0', '2,2,0']);
  assert.deepEqual(context.events.filter(e => e.type === 'route_bridge_removed').map(e => posKey(e.position)), ['2,2,0', '1,2,0']);
  assert.deepEqual(bot.companionTemporaryBlocks.list(), []);
  assert.deepEqual([1, 2].map(x => bot.blockAt(new Vec3(x, 1, 0)).name), ['water', 'water']);
});

test('a protected shore cell gets no temporary bridge and the repeated approach ends', async (t) => {
  const { bot, context, home, changes, dispose } = narrowChannel({ protect: true });
  t.after(dispose);
  const result = await actions.goNear(bot, context, home, 0, { exact: true });
  assert.equal(result.ok, false);
  assert.equal(result.shoreHandled, true);
  assert.equal(result.destinationUnconfirmed, true);
  assert.deepEqual(context.events.filter(e => e.type === 'home_route_shore').map(e => e.phase), ['alternate', 'exhausted']);
  assert.equal(changes.size, 0);
});

test('a confirmed dry detour reaches the porch without placing a bridge', async (t) => {
  const { bot, context, home, changes, dispose } = narrowChannel();
  t.after(dispose);
  const simulatedMove = bot.pathfinder.goto;
  bot.pathfinder.goto = async goal => {
    if (bot.pathfinder.movements.exclusionAreasStep.length) {
      bot.entity.position = home.offset(0.5, 0, 0.5);
      return;
    }
    return simulatedMove(goal);
  };
  const result = await actions.goNear(bot, context, home, 0, { exact: true });
  assert.equal(result.ok, true);
  assert.deepEqual(context.events.filter(e => e.type === 'home_route_shore').map(e => e.phase), ['alternate']);
  assert.equal(context.events.some(e => e.type === 'route_bridge_started'), false);
  assert.equal(changes.size, 0);
});

test('an aborted crossing keeps its confirmed temporary placement for safe cleanup', async (t) => {
  const { bot, context, home, dispose } = narrowChannel();
  t.after(dispose);
  const interrupted = new AbortController();
  const goal = new goals.GoalBlock(home.x, home.y, home.z);
  const protectedCell = () => false;
  const initial = bot.entity.position;
  const operations = {
    materials: ['dirt'],
    isProtected: protectedCell,
    move: async p => {
      bot.entity.position = p.offset(0.5, 0, 0.5);
      interrupted.abort('pause');
      return true;
    },
    dig: async block => { await bot.dig(block); return { ok: true }; },
  };
  await assert.rejects(shore.crossRouteBridge(bot, { ...context, signal: interrupted.signal }, goal, operations), { code: 'aborted' });
  assert.deepEqual(bot.companionTemporaryBlocks.list().map(b => posKey(b.position)), ['1,2,0']);
  assert.equal(await shore.clearRouteBridge(bot, context, operations), 0, 'do not dig support under the body');
  bot.entity.position = initial;
  assert.equal(await shore.clearRouteBridge(bot, context, operations), 1);
  assert.equal(bot.blockAt(new Vec3(1, 2, 0)).name, 'air');
});
