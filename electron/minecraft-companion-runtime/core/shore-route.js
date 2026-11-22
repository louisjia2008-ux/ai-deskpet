'use strict';

const { dryComponent, wet } = require('./dry-route');
const { safeStand, SIDES } = require('./home-topology');
const { isAir } = require('./natural-cover');
const { abortError, runCancellable, waitUntil } = require('./confirm');

const WATER = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const shoreDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const sameBlock = (entry, block) => Boolean(block && block.name === entry.name && block.stateId === entry.stateId);
const dryCell = (bot, p) => safeStand(q => bot.blockAt(q), p)
  && [-1, 0, 1].every(y => !wet(bot.blockAt(p.offset(0, y, 0))));

function steadyGround(bot) {
  return bot.entity.onGround === true && !bot.entity.isInWater && !bot.entity.isInLava
    && dryCell(bot, bot.entity.position.floored());
}

function waterContact(bot, nearBank = false) {
  const at = bot.entity.position.floored();
  if (bot.entity.isInWater || WATER.test(bot.blockAt(at)?.name || '')) return at;
  if (!nearBank) return null;
  for (const [x, z] of SIDES) {
    for (const distance of [1, 2]) {
      for (const drop of [0, 1, 2]) {
        const p = at.offset(x * distance, -drop, z * distance);
        if (WATER.test(bot.blockAt(p)?.name || '')) return p;
      }
    }
  }
  return null;
}

// The two probes compare complete paths under the same native profile. A
// partial path, different profile or timed-out probe is not a route cost.
function routeCost(bot, goal, from) {
  const pf = bot.pathfinder;
  const estimate = goal.heuristic(from.floored());
  const movements = pf?.movements;
  if (!movements || typeof pf.getPathFromTo !== 'function' || estimate > 80) return { estimate };
  const collisionIndex = movements.entityIntersections;
  try {
    const { value } = pf.getPathFromTo(movements, from, goal, {
      optimizePath: false, timeout: 8, tickTimeout: 8,
    }).next();
    if (value?.result?.status === 'success' && Number.isFinite(value.result.cost)) {
      return { estimate, native: value.result.cost };
    }
  } catch { /* full cost unavailable */ }
  finally { movements.entityIntersections = collisionIndex; }
  return { estimate };
}

function progress(before, after) {
  const native = Number.isFinite(before.native) && Number.isFinite(after.native);
  const measure = native ? 'native_cost' : 'goal_heuristic';
  const fromCost = native ? before.native : before.estimate;
  const toCost = native ? after.native : after.estimate;
  return { measure, fromCost, toCost, closer: fromCost - toCost >= 0.75 };
}

function bankDetours(bot, bank, goal) {
  const current = bot.entity.position.floored();
  const cells = [...dryComponent(p => bot.blockAt(p), current, 16).values()];
  const maxCost = goal.heuristic(current) + 2;
  // A nearby dry route can first go sideways around a curved shore. Require
  // the waypoint to actually get away from this patch before retrying home.
  return cells.filter(p => shoreDistance(p, current) >= 6 && shoreDistance(p, bank) >= 7 && goal.heuristic(p) <= maxCost)
    .sort((a, b) => goal.heuristic(a) - goal.heuristic(b) || a.distanceTo(current) - b.distanceTo(current))
    .filter((p, i, all) => !i || p.distanceTo(all[0]) >= 5)
    .slice(0, 2);
}

function bridgePlan(bot, goal, isProtected) {
  const from = bot.entity.position.floored();
  const candidates = [];
  for (const [x, z] of SIDES) {
    const cells = [];
    for (let distance = 1; distance <= 4; distance++) {
      const p = from.offset(x * distance, 0, z * distance);
      if (dryCell(bot, p)) {
        if (cells.length && goal.heuristic(p) < goal.heuristic(from)) candidates.push({ from, cells, to: p });
        break;
      }
      const floor = p.offset(0, -1, 0);
      if (distance === 4 || isProtected(floor) || isProtected(p)
        || ![floor, p, p.offset(0, 1, 0)].every(q => isAir(bot.blockAt(q)?.name))
        || ![1, 2].some(drop => WATER.test(bot.blockAt(floor.offset(0, -drop, 0))?.name || ''))) break;
      cells.push(p);
    }
  }
  return candidates.sort((a, b) => goal.heuristic(a.to) - goal.heuristic(b.to) || a.cells.length - b.cells.length)[0];
}

async function clearRouteBridge(bot, ctx, { dig, isProtected }) {
  const ledger = bot.companionTemporaryBlocks;
  if (!ledger || !steadyGround(bot)) return 0;
  let cleared = 0;
  const at = bot.entity.position;
  const entries = ledger.list().sort((a, b) => at.distanceTo(a.position) - at.distanceTo(b.position));
  for (const entry of entries) {
    const p = entry.position, block = bot.blockAt(p);
    if (!block) continue;
    if (!sameBlock(entry, block) || isProtected(p)) { ledger.forget(p); continue; }
    const under = p.y === Math.floor(at.y) - 1
      && p.x < at.x + 0.3 && p.x + 1 > at.x - 0.3
      && p.z < at.z + 0.3 && p.z + 1 > at.z - 0.3;
    if (under || at.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) continue;
    const removed = await dig(block, { timeoutMs: 5000, ownedHomeRemoval: b => sameBlock(entry, b) && !isProtected(p) });
    if (removed.ok) {
      ledger.forget(p);
      cleared += 1;
      ctx.record?.('route_bridge_removed', { position: p });
    }
  }
  return cleared;
}

async function crossRouteBridge(bot, ctx, goal, { materials, isProtected, move, dig }) {
  const ledger = bot.companionTemporaryBlocks;
  if (!ledger || !steadyGround(bot)) return false;
  const plan = bridgePlan(bot, goal, isProtected);
  if (!plan || bot.inventory.items().reduce((n, i) => n + (materials.includes(i.name) ? i.count : 0), 0) < plan.cells.length) return false;
  const before = bot.entity.position.clone();
  ctx.record?.('route_bridge_started', { from: plan.from, to: plan.to, cells: plan.cells.map(p => p.offset(0, -1, 0)) });
  let landed = false;
  try {
    for (const next of plan.cells) {
      const floor = next.offset(0, -1, 0);
      const feet = bot.entity.position.floored();
      const ref = bot.blockAt(feet.offset(0, -1, 0));
      const item = bot.inventory.items().find(i => materials.includes(i.name));
      const canPlace = () => steadyGround(bot) && bot.entity.position.floored().equals(feet) && !isProtected(floor) && !isProtected(next)
        && [floor, next, next.offset(0, 1, 0)].every(p => isAir(bot.blockAt(p)?.name));
      if (!ref || !item || feet.distanceTo(next) !== 1 || !canPlace()) return false;
      try {
        await bot.equip(item, 'hand');
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!canPlace()) return false;
        await runCancellable(() => bot.placeBlock(ref, next.minus(feet)), { signal: ctx.signal, timeoutMs: 5000 });
      } catch (error) {
        if (error?.code === 'aborted') throw error;
      } finally {
        const placed = bot.blockAt(floor);
        if (placed?.name === item.name && !isProtected(floor)) ledger.remember(placed);
      }
      if (!ledger.list().some(b => b.position.equals(floor) && sameBlock(b, bot.blockAt(floor)))) return false;
      ctx.record?.('route_bridge_placed', { position: floor, material: item.name });
      if (!(await move(next))) return false;
    }
    landed = await move(plan.to);
    return landed;
  } finally {
    if (!ctx.signal?.aborted) {
      if (!landed && !bot.entity.position.floored().equals(plan.from)) {
        // Retract from dry ground even after a partial placement. Avoid
        // digging the block which currently holds the bot.
        await move(plan.from);
      }
      await clearRouteBridge(bot, ctx, { dig, isProtected });
    }
    ctx.record?.('route_bridge_finished', { from: before, position: bot.entity.position.clone(), landed,
      pending: ledger.list().length });
  }
}

async function settleDry(bot, signal) {
  return steadyGround(bot) || (!waterContact(bot) && await waitUntil(() => steadyGround(bot), { timeoutMs: 400, signal }));
}

module.exports = { bankDetours, clearRouteBridge, crossRouteBridge, progress, routeCost, settleDry, shoreDistance, steadyGround, waterContact };
