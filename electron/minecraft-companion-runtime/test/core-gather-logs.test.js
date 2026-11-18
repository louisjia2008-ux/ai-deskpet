'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createGatherBlocksGoal, createGatherLogsGoal } = require('../core/goals/gatherBlocks');

const flatGround = position => position.y < 64
  ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position }
  : { name: 'air', boundingBox: 'empty', shapes: [], stateId: 0, position };

function fixture() {
  const moves = { canDig: true, maxDropDown: 4, exclusionAreasStep: [] };
  const position = new Vec3(0, 64, 0);
  const events = [];
  const inventory = { oak_log: 0 };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position },
    pathfinder: { movements: moves },
    inventory: { items: () => [{ name: 'oak_log', count: inventory.oak_log }] },
    blockAt: flatGround,
  });
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    record: (type) => events.push(type),
    perceive: () => ({ position: bot.entity.position, inventory }),
  };
  return { bot, controller, ctx, events, inventory, moves };
}

test('log task walks out, rechecks nearby targets and counts only collected logs', async () => {
  const { bot, ctx, events, inventory, moves } = fixture();
  inventory.oak_log = 2;
  const logs = [52, 53, 54].map((x) => ({ name: 'oak_log', position: new Vec3(x, 64, 0) }));
  let walked = 0;
  const goal = createGatherLogsGoal({ bot, count: 3,
    findTargets: () => walked ? logs.slice(0, 1) : [],
    walk: async () => {
      assert.equal(moves.canDig, false);
      assert.equal(moves.maxDropDown, 2);
      walked++;
      bot.entity.position = new Vec3(32, 64, 0);
      assert.equal(goal.progress(ctx.perceive()), 2);
    },
    actions: {
      goToDig: async () => {
        assert.equal(moves.canDig, false);
        assert.equal(moves.maxDropDown, 2);
        return { ok: true };
      },
      digBlock: async (_bot, _ctx, block) => {
        assert.equal(moves.canDig, true);
        assert.equal(moves.maxDropDown, 4);
        assert.equal(block, logs.shift());
        return { ok: true };
      },
      collectDrops: async () => { inventory.oak_log++; return { ok: true }; },
    },
  });

  for (let i = 0; i < 3; i++) assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.equal(walked, 1);
  assert.deepEqual(events, ['searching_for_logs', 'target_selected', 'target_selected', 'target_selected']);
  assert.equal(goal.progress(ctx.perceive()), 5);
  assert.equal(goal.isDone(ctx.perceive()), true);
});

test('cancel while exploring restores movement options before any log can be dug', async () => {
  const { bot, controller, ctx, moves } = fixture();
  let walked = 0;
  const goal = createGatherLogsGoal({ bot, count: 3,
    findTargets: () => [],
    walk: async () => {
      assert.equal(moves.canDig, false);
      assert.equal(moves.maxDropDown, 2);
      walked++;
      controller.abort('cancelled');
    },
  });
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.equal(walked, 1);
  assert.equal(moves.canDig, true);
  assert.equal(moves.maxDropDown, 4);
});

test('underground logs do not stop the search and repeated runs share its bound', async () => {
  const { bot, ctx } = fixture();
  const underground = [
    { name: 'oak_log', position: new Vec3(1, 30, 0) },
    { name: 'oak_log', position: new Vec3(2, 30, 0), skyLight: 15 },
  ];
  bot.game = { dimension: 'minecraft:overworld', minY: -64, height: 384 };
  bot.registry = { blocksByName: { oak_log: { name: 'oak_log', id: 1 } } };
  bot.findBlocks = ({ useExtraInfo }) => underground.filter(useExtraInfo).map((log) => log.position);
  bot.blockAt = (position) => {
    if (position.y >= 38 && position.y < 70) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position };
    return { name: 'air', boundingBox: 'empty', shapes: [], stateId: 0, position };
  };
  let walked = 0;
  // The fixture's stone is a stand-in for terrain, not a pit around the bot.
  const goal = createGatherLogsGoal({ bot, count: 3, actions: { underground: () => false }, walk: async (_bot, _ctx, memory, { distance }) => {
    walked++;
    bot.entity.position = bot.entity.position.offset(Math.cos(memory.heading) * distance, 0, Math.sin(memory.heading) * distance);
  } });
  const expected = { ok: false, reason: 'log_search_exhausted' };
  assert.deepEqual(await goal.run(ctx), expected);
  assert.equal(walked, 30);
  assert.deepEqual(await goal.run(ctx), expected);
  assert.equal(walked, 30);
});

test('a trapped bot tries distinct shorter waypoints and stops after the last untried cell', async () => {
  const { bot, ctx } = fixture();
  bot.entity.position = new Vec3(340.45, 57, -138.56);
  const attempts = new Set();
  const distances = new Set();
  const goal = createGatherLogsGoal({ bot, count: 3, findTargets: () => [], actions: { underground: () => false },
    walk: async (_bot, _ctx, { heading }, { distance }) => {
      const x = Math.round(bot.entity.position.x + Math.cos(heading) * distance);
      const z = Math.round(bot.entity.position.z + Math.sin(heading) * distance);
      const waypoint = `${x},${z}`;
      assert.equal(attempts.has(waypoint), false);
      attempts.add(waypoint);
      distances.add(distance);
    },
  });
  const expected = { ok: false, reason: 'log_search_exhausted' };
  assert.deepEqual(await goal.run(ctx), expected);
  assert.ok(attempts.size >= 8 && attempts.size <= 16);
  assert.deepEqual(distances, new Set([32, 16]));
  assert.deepEqual(await goal.run(ctx), expected);
});

test('a bot at the bottom of a pit climbs out before scouting, and reports a failed climb as trapped', async () => {
  const { bot, ctx, events } = fixture();
  const climbs = [];
  let walked = 0;
  const pit = (surface) => ({
    underground: () => bot.entity.position.y < 64,
    localSurfaceY: () => 64,
    surface: async (_bot, _ctx, { targetY }) => {
      climbs.push(targetY);
      if (!surface) return { ok: false, reason: 'still_below_surface' };
      bot.entity.position = new Vec3(0, 64, 0);
      return { ok: true, surfaced: true };
    },
  });
  bot.entity.position = new Vec3(0, 57, 0);
  const climbed = createGatherLogsGoal({ bot, count: 1,
    actions: { ...pit(true), goToDig: async () => ({ ok: true }), digBlock: async () => ({ ok: true }), collectDrops: async () => ({ ok: true }) },
    findTargets: () => walked ? [{ name: 'oak_log', position: new Vec3(20, 64, 0) }] : [],
    walk: async () => { assert.equal(bot.entity.position.y, 64); walked++; return { ok: true }; },
  });
  assert.deepEqual(await climbed.run(ctx), { ok: true });
  assert.deepEqual(climbs, [64]);
  assert.equal(walked, 1);
  assert.ok(events.indexOf('leaving_pit') < events.indexOf('searching_for_logs'));

  bot.entity.position = new Vec3(0, 57, 0);
  climbs.length = 0; walked = 0;
  const stuck = createGatherLogsGoal({ bot, count: 1, actions: pit(false), findTargets: () => [],
    walk: async () => { walked++; return { ok: false }; } });
  assert.deepEqual(await stuck.run(ctx), { ok: false, reason: 'log_scout_trapped' });
  assert.deepEqual(climbs, [64]);
  assert.equal(walked, 0);
});

test('log scouting skips submerged endpoints and pauses for recovery if the path enters deep water', async () => {
  const { bot, ctx, moves } = fixture();
  const shore = bot.entity.position;
  const water = new Vec3(5, 62, 0);
  bot.blockAt = position => position.x > 10 && Math.abs(position.z) < 4 && position.y <= 66
    || position.x === water.x && position.z === water.z && position.y <= 64
    ? { name: 'water', boundingBox: 'empty', position }
    : flatGround(position);
  const log = { name: 'oak_log', position: new Vec3(3, 64, 0) };
  let recovered = false;
  const goal = createGatherLogsGoal({ bot, count: 1,
    findTargets: () => recovered ? [log] : [],
    walk: async (_bot, step, _memory, { surface }) => {
      assert.ok(surface.every(point => !(point.x > 10 && Math.abs(point.z) < 4)));
      assert.equal(moves.exclusionAreasStep[0](bot.blockAt(water)), 100);
      bot.entity.position = water;
      bot.entity.isInWater = true;
      bot.emit('physicsTick');
      assert.equal(step.signal.aborted, true);
    },
    recover: async () => {
      assert.deepEqual(moves.exclusionAreasStep, []);
      assert.equal(moves.canDig, true);
      bot.entity.position = shore;
      bot.entity.isInWater = false;
      recovered = true;
      return { ok: true };
    },
    actions: { goToDig: async () => ({ ok: true }), digBlock: async () => ({ ok: true }),
      collectDrops: async () => ({ ok: true }) },
  });
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.equal(recovered, true);
  assert.equal(bot.listenerCount('physicsTick'), 0);
  assert.deepEqual(moves.exclusionAreasStep, []);
});

test('a detour beyond a river explores new ground instead of a parallel, already scanned corridor', async () => {
  const { bot, controller, ctx } = fixture();
  const headings = [];
  bot.blockAt = position => {
    if (headings.length >= 3 && position.x > 110 && position.y >= 62 && position.y <= 66) {
      return { name: 'water', boundingBox: 'empty', position };
    }
    const block = flatGround(position);
    if (headings.length >= 3 && position.x <= 65 && position.z === 24) block.biome = { name: 'desert' };
    return block;
  };
  const positions = [new Vec3(32, 64, 0), new Vec3(64, 64, 0), new Vec3(96, 64, 24)];
  const goal = createGatherLogsGoal({ bot, count: 1, findTargets: () => [],
    walk: async (_bot, _step, { heading }) => {
      headings.push(heading);
      if (headings.length === 4) controller.abort('observed frontier choice');
      else bot.entity.position = positions[headings.length - 1];
      return { ok: headings.length < 3 };
    },
  });
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.deepEqual(headings, [0, 0, 0, Math.PI / 2]);
});

test('a farther observed canopy guides a short dry leg while a farther placed log is ignored', async () => {
  const { bot, controller, ctx } = fixture();
  const trunk = { name: 'oak_log', position: new Vec3(-84, 64, 0) };
  const placed = { name: 'oak_log', position: new Vec3(72, 64, 0) };
  bot.registry = { blocksByName: { oak_log: { name: 'oak_log', id: 1 } } };
  bot.blockAt = position => {
    if (position.equals(trunk.position)) return trunk;
    if (position.equals(placed.position)) return placed;
    if (position.equals(trunk.position.offset(-1, 0, 0))) {
      return { name: 'oak_leaves', getProperties: () => ({ persistent: false }) };
    }
    return flatGround(position);
  };
  bot.findBlocks = ({ matching, maxDistance, count, useExtraInfo }) => {
    assert.deepEqual(matching, [1]);
    assert.equal(maxDistance, 112);
    assert.equal(count, 1);
    const accepted = [placed, trunk].filter(useExtraInfo);
    assert.deepEqual(accepted, [trunk]);
    return accepted.map(block => block.position);
  };
  const goal = createGatherLogsGoal({ bot, count: 1, findTargets: () => [],
    walk: async (_bot, _step, { heading }, { surface }) => {
      assert.equal(heading, Math.PI);
      assert.ok(surface.every(point => point.x >= -34 && point.x <= -30 && point.y === 64));
      controller.abort('observed canopy direction');
    },
  });
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
});

test('natural canopies and verified open columns qualify logs without skylight data', async () => {
  const { bot, ctx } = fixture();
  const natural = { name: 'oak_log', position: new Vec3(3, 64, 0) };
  const placed = { name: 'oak_log', position: new Vec3(7, 64, 0) };
  const unknown = { name: 'oak_log', position: new Vec3(11, 64, 0), skyLight: 15 };
  const leaves = { name: 'oak_leaves', getProperties: () => ({ persistent: false }) };
  bot.game = { minY: -64, height: 384 };
  bot.registry = { blocksByName: { oak_log: { name: 'oak_log', id: 1 } } };
  bot.findBlocks = ({ useExtraInfo }) => {
    const surface = [unknown, placed, natural].filter(useExtraInfo);
    assert.deepEqual(surface, [placed, natural]);
    return surface.map((log) => log.position);
  };
  bot.blockAt = (position) => {
    if (position.equals(natural.position) || position.equals(natural.position.offset(0, 1, 0))) return natural;
    if (position.equals(natural.position.offset(1, 1, 0))) return leaves;
    if (position.equals(placed.position)) return placed;
    if (position.x >= 6 && position.x <= 8) return { name: 'air', boundingBox: 'empty' };
    return null;
  };
  const goal = createGatherLogsGoal({ bot, count: 1, walk: async () => assert.fail('already in range'),
    actions: {
      goToDig: async (_bot, _ctx, block) => { assert.equal(block, natural); return { ok: true }; },
      digBlock: async () => ({ ok: true }),
      collectDrops: async () => ({ ok: true }),
    },
  });
  assert.deepEqual(await goal.run(ctx), { ok: true });
});

test('generic block collection retains its in-range behavior', async () => {
  const { bot, ctx } = fixture();
  const goal = createGatherBlocksGoal({ bot, count: 1, itemMatch: () => true, findTargets: () => [] });
  assert.deepEqual(await goal.run(ctx), { ok: false, reason: 'no_target_in_range' });
});
