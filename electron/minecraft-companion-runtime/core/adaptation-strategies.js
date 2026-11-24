'use strict';

const { goals } = require('mineflayer-pathfinder');
const { blockTarget } = require('./target-recovery');
const { complete, resultFrom, failure, factsOf, isComplete } = require('./action-result');

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

async function runSearchLeg(ctx, memory, move, { reason = 'search_leg_budget', observe } = {}) {
  const exhausted = () => memory.legs >= 6 || memory.distance >= 192;
  const failed = () => failure(reason, { legs: memory.legs, distance: memory.distance }, ctx);
  if (exhausted()) return failed();
  const from = observe?.()?.clone();
  const result = resultFrom(await move(), ctx);
  if (!isComplete(result)) return result;
  const to = observe?.();
  memory.legs = (memory.legs || 0) + 1;
  memory.distance = (memory.distance || 0) + (from && to ? from.distanceTo(to) : factsOf(result).moved || 0);
  return exhausted() ? failed() : result;
}

async function gatherWood({ bot, ctx, skills, actions, memory, anchor, blocks, dropMatch, exclude }) {
  const origin = anchor || (memory.woodOrigin ||= bot.entity.position.clone());
  const location = { position: origin, target: 'log' };
  const spec = (p) => blockTarget(bot, 'wood', 'gather_log', p, { cells: [p.offset(0, -1, 0)] });
  const avoid = (p) => exclude?.(p) || ctx.adapt.avoids('hard_route', p) || ctx.adapt.targets.avoid(spec(p));
  return ctx.adapt.run('wood', location, async (method, plan, observe) => {
    const near = method === 'near_tree';
    const found = resultFrom(await skills.gatherOne(bot, ctx, { blocks, dropMatch, exclude: avoid,
      radius: near ? 48 : 128, destination: { spec, observe } }), ctx, bot);
    const id = `${plan.key}:${plan.revision}:${method}`;
    if (found.progress) { memory.woodRoute = null; return found; }
    if (near || ['start', 'interrupted'].includes(found.kind) || found.facts?.target || found.facts?.adaptation || !['no_target_in_range', 'not_arrived',
      'path_timeout', 'no_progress', 'NoPath', 'Timeout', 'choose_another_target', 'route_region_avoided'].includes(found.reason)) return found;
    if (memory.woodRoute?.id !== id) {
      const heading = ['near_tree', 'wider_heading', 'different_biome', 'move_to_fresh_area'].indexOf(method);
      memory.woodRoute = { id, heading: Math.max(0, heading) };
    }
    return runSearchLeg(ctx, memory.woodRoute,
      () => outwardLeg(bot, ctx, actions, memory.woodRoute, origin, { distance: method === 'wider_heading' ? 20 : 28 }));
  });
}

module.exports = { outwardLeg, runSearchLeg, gatherWood, OUTWARD_HEADINGS };
