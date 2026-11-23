'use strict';

const { goals } = require('mineflayer-pathfinder');
const { blockTarget } = require('./target-recovery');
const { complete, resultFrom, failure, isComplete } = require('./action-result');

const OUTWARD_HEADINGS = Object.freeze([0, 1, -1, 2, -2, 3, -3, 4]);
async function outwardLeg(bot, ctx, actions, memory, away, { distance = 24, timeoutMs = 15000, bearing } = {}) {
  const from = bot.entity.position.clone();
  const base = bearing ?? Math.atan2(from.z - away.z, from.x - away.x);
  const turn = OUTWARD_HEADINGS[(memory.heading || 0) % OUTWARD_HEADINGS.length];
  const angle = base + turn * Math.PI / 4;
  const x = Math.round(from.x + Math.cos(angle) * distance);
  const z = Math.round(from.z + Math.sin(angle) * distance);
  ctx.record?.('adaptation_route', { x, z, heading: turn, bearing: angle });
  const goal = new goals.GoalNearXZ(x, z, 3);
  const result = resultFrom(await actions.goTo(bot, ctx, goal, { timeoutMs, retryNoProgress: false }), ctx, bot);
  if (result.wait || result.kind === 'start' || result.kind === 'interrupted') return result;
  const moved = Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z);
  if (!result.ok || moved < 6 || !goal.isEnd(bot.entity.position.floored())) {
    memory.heading = (memory.heading || 0) + 1;
    return result.ok ? failure('not_arrived', {}, ctx, bot) : result;
  }
  return complete(false, { moved });
}

const biome = (bot) => bot.blockAt(bot.entity.position.floored())?.biome?.name
  ?? bot.world?.getBiome?.(bot.entity.position.floored()) ?? null;

async function gatherWood({ bot, ctx, skills, actions, memory, anchor, blocks, dropMatch, exclude }) {
  const location = { position: anchor || bot.entity.position, target: 'log' };
  const spec = (p) => blockTarget(bot, 'wood', 'gather_log', p, { cells: [p.offset(0, -1, 0)] });
  const avoid = (p) => exclude?.(p) || ctx.adapt.avoids('hard_route', p) || ctx.adapt.targets.avoid(spec(p));
  return ctx.adapt.run('wood', location, async (method, _plan, observe) => {
    const gather = (radius) => skills.gatherOne(bot, ctx, { blocks, dropMatch, exclude: avoid, radius,
      destination: { spec, observe } });
    const route = (memory.woodRoute ||= { heading: 0, from: bot.entity.position.clone(), biome: biome(bot) });
    const near = method === 'near_tree';
    const far = method === 'different_biome' || method === 'move_to_fresh_area';
    if (route.method !== method) {
      route.heading = method === 'wider_heading' ? 1 : method === 'different_biome' ? 2 : method === 'move_to_fresh_area' ? 3 : 0;
      route.method = method;
      route.departed = false;
    }
    if (far && (!route.departed || (method === 'different_biome' && biome(bot) !== null && route.biome === biome(bot)
      && route.from.distanceTo(bot.entity.position) < 128))) {
      const move = await outwardLeg(bot, ctx, actions, route, route.from, { distance: 28 });
      route.departed ||= isComplete(move);
      return move;
    }
    const found = resultFrom(await gather(near ? 48 : 128), ctx, bot);
    if (found.ok || near || found.facts?.target || found.facts?.adaptation || found.kind === 'start' || found.kind === 'interrupted') return found;
    if (!['no_target_in_range', 'not_arrived', 'path_timeout', 'no_progress', 'NoPath', 'Timeout', 'choose_another_target',
      'route_region_avoided'].includes(found.reason)) return found;
    const moved = await outwardLeg(bot, ctx, actions, route, route.from, { distance: far ? 28 : 20 });
    if (!isComplete(moved)) return moved;
    return gather(128);
  });
}

module.exports = { outwardLeg, gatherWood, OUTWARD_HEADINGS };
