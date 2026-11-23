'use strict';

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { isSoft, canClearTerrain } = require('./site');
const { targetsFor } = require('./failure-ledger');
const { complete, createAttempt, failure, factsOf, resultFrom, waiting } = require('./action-result');

const v = (p) => new Vec3(p.x, p.y, p.z);
const dimensionOf = (bot) => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function blockTarget(bot, goal, step, position, { cells = [], tools = /_(pickaxe|shovel|axe)$/, tag = '' } = {}) {
  return { goal, step, dimension: dimensionOf(bot), position,
    witness: () => {
      const blocks = [position, ...cells].map((p) => bot.blockAt(v(p)));
      if (blocks.some((b) => !b)) return null; // unloaded is not a change
      const carried = [...new Set((bot.inventory?.items?.() || []).map(i => i.name).filter(n => tools.test(n)))].sort();
      return JSON.stringify([tag, blocks.map(b => b.stateId ?? b.name), carried]);
    } };
}

const APPROACH_FAILURE = /^(nopath|timeout|path_timeout|not_arrived|no_progress|leg_blocked|chase_stuck)$/i;
async function watchDestination(bot, ctx, spec, observe, attempt, { resolves = true,
  knownMine = null, useFailure = null } = {}) {
  ctx = createAttempt(ctx);
  const run = async () => resultFrom(await attempt(), ctx, bot);
  if (!observe || ctx.selfRescue || bot.companionPlayerBlock?.(spec.position)) return run();
  const actions = require('./actions');
  const tracker = bot.companionSelfStuck;
  const blockedOrigin = () => {
    const cause = actions.routeOrigin(bot);
    return cause && !(cause === 'underground' && knownMine
      && require('./mining').knownOpen(knownMine, bot.entity.position.floored()));
  };
  if (actions.isHomeTarget(bot, spec.position) || blockedOrigin()) return run();
  const targets = targetsFor(bot, ctx);
  if (targets.recovering(spec)) {
    return targets.run(spec, run, async (reason) => {
      const moved = await alternateStand(bot, ctx, actions, spec.position);
      if (moved.ok) return run();
      return moved.kind !== 'target' ? moved : failure(reason, {}, ctx, bot);
    });
  }
  const before = bot.entity.position.clone();
  const attempted = await (tracker ? tracker.target(run) : run());
  const result = actions.originFailure(bot, attempted, before, spec.position, ctx);
  if (ctx.signal?.aborted || result.wait || factsOf(result).target || bot.companionPlayerBlock?.(spec.position) || blockedOrigin()) return result;
  if (result.ok) {
    if (resolves) observe(spec, result);
    return result;
  }
  if (result.kind !== 'target' || (!APPROACH_FAILURE.test(result.reason) && result.reason !== useFailure)) return result;
  const undo = observe(spec, result);
  if (!undo) return result;
  const key = `${spec.position.x},${spec.position.y},${spec.position.z}`;
  return tracker?.failed(key, result.reason, before, undo)
    ? failure('self_stuck', { source: 'self_stuck' }, ctx, bot)
    : { ...result, facts: { ...result.facts, destinationObserved: true } };
}

// One alternate approach from a supported cell. Do not plan a second tunnel
// just to get there, and do not trample a crop or step on a build footprint.
async function alternateStand(bot, ctx, actions, position, { avoid = () => false, distance = 2 } = {}) {
  const from = bot.entity.position.floored(), p = v(position);
  const movements = bot.pathfinder?.movements;
  const stand = SIDES.flatMap(([dx, dz]) => [0, 1, -1].map(dy => p.offset(dx * distance, dy, dz * distance)))
    .filter((q) => !q.equals(from) && !avoid(q) && !bot.companionPlayerBlock?.(q)
      && bot.blockAt(q.offset(0, -1, 0))?.boundingBox === 'block'
      && [q, q.offset(0, 1, 0)].every(c => { const b = bot.blockAt(c); return b && isSoft(b); }))
    .sort((a, b) => a.distanceTo(from) - b.distanceTo(from))[0];
  if (!stand || !actions.goTo) return failure('no_alternate_stand', {}, ctx, bot);
  const canDig = movements?.canDig;
  if (movements) movements.canDig = false;
  try {
    return await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z),
      { timeoutMs: 6500, retryNoProgress: false });
  } finally {
    if (movements) movements.canDig = canDig;
  }
}

async function clearTerrain(bot, ctx, actions, p) {
  const pos = v(p), block = bot.blockAt(pos);
  if (!canClearTerrain((x, y, z) => bot.blockAt(new Vec3(x, y, z)), pos)
    || bot.companionPlayerBlock?.(pos) || bot.companionProtectBlock?.(block)) {
    return failure('not_safe_to_clear', {}, ctx, bot);
  }
  const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 8000, retryNoProgress: false });
  if (!reach.ok) return reach;
  const current = bot.blockAt(pos);
  if (!current) return failure('unloaded', {}, ctx, bot);
  if (current.name !== block.name || bot.companionPlayerBlock?.(pos)) return failure('changed_target', {}, ctx, bot);
  return actions.digBlock(bot, ctx, current);
}

// Machine cells that are necessary for safe operation are never marked built
// when excluded. A dry, autonomous project can start on a different footprint;
// a pinned project or a live machine leaves its fluids alone and yields.
function deviceTargets(bot, actions, goal, memory) {
  let refused = [];
  return {
    avoids(ctx, p) {
      const targets = targetsFor(bot, ctx);
      return refused.some(e => e.cells.some(q => q.x === p.x && q.y === p.y && q.z === p.z) && targets.excluded(e.spec));
    },
    async run(ctx, step, p, attempt, { cells = [], tag, recover, relocate = null } = {}) {
      ctx = createAttempt(ctx);
      const spec = blockTarget(bot, goal, step, p, { cells, tag });
      const result = await targetsFor(bot, ctx).run(spec, attempt, recover || (async (reason) => {
        const moved = await alternateStand(bot, ctx, actions, p);
        if (moved.ok) return attempt();
        return moved.kind !== 'target' ? moved : failure(reason, {}, ctx, bot);
      }));
      const target = factsOf(result).target;
      if (!target?.excluded) return result;
      if (relocate) {
        refused = [...refused.slice(-15), { spec, cells: relocate }];
        ctx.record('device_site_abandoned', { device: goal, anchor: memory.device.anchor, position: spec.position, reason: result.reason });
        memory.device = null;
        memory.guarded = false;
        return complete(false);
      }
      return waiting('device_target_excluded', target.retryAt);
    },
  };
}

module.exports = { blockTarget, watchDestination, alternateStand, clearTerrain, dimensionOf, deviceTargets };
