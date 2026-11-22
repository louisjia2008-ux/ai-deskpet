'use strict';

const { goals } = require('mineflayer-pathfinder');

const OUTWARD_HEADINGS = Object.freeze([0, 1, -1, 2, -2, 3, -3, 4]);
async function outwardLeg(bot, ctx, actions, memory, away, { distance = 24, timeoutMs = 15000 } = {}) {
  const from = bot.entity.position.clone();
  const base = Math.atan2(from.z - away.z, from.x - away.x);
  const turn = OUTWARD_HEADINGS[(memory.heading || 0) % OUTWARD_HEADINGS.length];
  const angle = base + turn * Math.PI / 4;
  const x = Math.round(from.x + Math.cos(angle) * distance);
  const z = Math.round(from.z + Math.sin(angle) * distance);
  ctx.record?.('adaptation_route', { x, z, heading: turn });
  const goal = new goals.GoalNearXZ(x, z, 3);
  const result = await actions.goTo(bot, ctx, goal, { timeoutMs, retryNoProgress: false });
  if (ctx.signal?.aborted || result.reason === 'aborted') return result;
  const moved = Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z);
  if (!result.ok || moved < 6 || !goal.isEnd(bot.entity.position.floored())) {
    memory.heading = (memory.heading || 0) + 1;
    return result.ok ? { ok: false, reason: 'not_arrived' } : result;
  }
  return { ok: true, moved, progress: false };
}

const biome = (bot) => bot.blockAt(bot.entity.position.floored())?.biome?.name
  ?? bot.world?.getBiome?.(bot.entity.position.floored()) ?? null;

async function gatherWood({ bot, ctx, skills, actions, memory, anchor, blacklist, blocks, dropMatch, exclude }) {
  const location = { position: anchor || bot.entity.position, target: 'log' };
  const avoid = (p) => exclude?.(p) || ctx.adapt.avoids('hard_route', p);
  return ctx.adapt.run('wood', location, async (method) => {
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
      route.departed ||= move.ok;
      return move;
    }
    const found = await skills.gatherOne(bot, ctx, { blocks, dropMatch, blacklist, exclude: avoid, radius: near ? 48 : 128 });
    if (found.ok || near || found.sourceHandled || found.waited || found.reason === 'aborted') return found;
    if (!['no_target_in_range', 'not_arrived', 'path_timeout', 'no_progress', 'NoPath', 'Timeout', 'choose_another_target',
      'route_region_avoided'].includes(found.reason)) return found;
    const moved = await outwardLeg(bot, ctx, actions, route, route.from, { distance: far ? 28 : 20 });
    if (!moved.ok) return moved;
    return skills.gatherOne(bot, ctx, { blocks, dropMatch, blacklist, exclude: avoid, radius: 128 });
  });
}

module.exports = { outwardLeg, gatherWood, OUTWARD_HEADINGS };
