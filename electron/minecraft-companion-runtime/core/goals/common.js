'use strict';
// Shared by the smaller goals (farm, ranch): run one planner step (gather,
// craft, place a crafting table nearby) with the same failure handling the
// homestead uses, without a house to put the table in.

const { Vec3 } = require('vec3');
const { stepRetryAt } = require('../planner');
const { countKey, familyOf } = require('../knowledge');
const { naturalCover } = require('../natural-cover');
const { createAttempt, failure, isComplete, resultFrom, waiting, factsOf } = require('../action-result');

const DOWN = [new Vec3(0, -1, 0)];
// A table this close is used rather than another one made.
const TABLE_NEAR = 16;

async function runPlanned(ctx, step, execute) {
  if (step.kind === 'blocked') return waiting('planning_sources_blocked', step.retryAt);
  const until = stepRetryAt(step, ctx.planning);
  if (until) return waiting('planning_source_blocked', until);
  ctx = createAttempt(ctx);
  ctx.record?.('plan_step', { kind: step.kind, key: step.key, for: step.for, item: step.item,
    count: step.count ?? step.times, station: step.station, position: step.position });
  const raw = await execute(ctx);
  const result = resultFrom(raw, ctx);
  const data = factsOf(raw);
  if (data.transit || (!result.ok && result.kind !== 'start' && (data.target || data.adaptation || data.terminal))) return result;
  if (result.progress && !data.moved && !data.skipped && !data.idle) ctx.adapt?.progress();
  return ctx.stepOutcome?.(step, result) ?? result;
}

function* ring(radius) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === radius) yield [dx, dz];
  }
}

function rememberShortfall(memory, kb, result) {
  for (const { name, short } of factsOf(result).missing || []) {
    const family = familyOf(name, kb);
    if (family) memory.shortfall[family] = { extra: short, until: Date.now() + 120000 };
  }
}

async function surfaceFirst(bot, ctx, actions) {
  const result = await actions.surface?.(bot, ctx);
  if (result?.progress === false) return null;
  if (result) ctx.record('surface', { ok: isComplete(result), reason: result.wait?.reason ?? result.reason });
  return result;
}

async function gatherInLoadedRange(bot, ctx, skills, options) {
  const result = await skills.gatherOne(bot, ctx, options);
  return result.reason === 'no_target_in_range' ? skills.gatherOne(bot, ctx, { ...options, radius: 128 }) : result;
}

function shortfallRequirements(memory, inventory, kb) {
  const needs = [];
  for (const [key, entry] of Object.entries(memory.shortfall)) {
    if (entry.until < Date.now()) delete memory.shortfall[key];
    else needs.push({ key, count: countKey(key, inventory, kb) + entry.extra });
  }
  return needs;
}

async function recoverToward(bot, ctx, actions, memory, point) {
  memory.recovery = false;
  ctx.record('recovery', { at: bot.entity.position.floored() });
  const restored = await actions.unstick(bot, ctx);
  if (restored?.wait) { memory.recovery = true; return restored; }
  const target = point && new Vec3(point.x, point.y, point.z);
  return target && bot.entity.position.distanceTo(target) > 16
    ? actions.goNear(bot, ctx, target, 3, { timeoutMs: 120000 }) : { ok: true };
}

async function placeStation(bot, ctx, { skills, station = 'crafting_table', avoid, from = 2, to = 4, columns = ring }) {
  const here = bot.entity.position.floored();
  for (let r = from; r <= to; r++) for (const [dx, dz] of columns(r)) {
    const landings = [0, 1, -1].map(dy => here.offset(dx, dy, dz)).filter(p => {
      const floor = bot.blockAt(p.offset(0, -1, 0));
      return naturalCover(bot.blockAt(p)) && floor?.boundingBox === 'block' && floor.name !== 'farmland'
        && !avoid(p) && !bot.companionPlayerBlock?.(p);
    });
    for (const p of columns === ring ? landings.slice(0, 1) : landings) {
      const placed = await skills.placeAt(bot, ctx, p, n => n === station, { faces: DOWN, requireAir: true });
      if (placed.reason !== 'cell_occupied_by_entity') return isComplete(placed) ? { ...placed, position: { ...p } } : placed;
    }
  }
  return { ok: false, reason: `no_${station === 'crafting_table' ? 'table' : station}_spot` };
}

function createPlannerRunner({ bot, skills, kb, memory, purpose = 'gather', avoid = () => false,
  explore = ctx => skills.explore(bot, ctx, memory) }) {
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  memory.shortfall = memory.shortfall || {};

  // One already standing nearby (left by an earlier task) counts as ours.
  const tableHere = () => {
    if (memory.table && blockAt(memory.table)?.name === 'crafting_table') return true;
    const id = bot.registry?.blocksByName?.crafting_table?.id;
    const found = id !== undefined && typeof bot.findBlocks === 'function'
      ? bot.findBlocks({ matching: id, maxDistance: TABLE_NEAR, count: 8 }).find((p) => !avoid(p)) : null;
    if (found) memory.table = { x: found.x, y: found.y, z: found.z };
    return Boolean(found);
  };

  const placeNearby = (ctx, station) => placeStation(bot, ctx, { skills, station, avoid });

  async function placeTableNearby(ctx) {
    const placed = await placeNearby(ctx, 'crafting_table');
    if (placed.ok) memory.table = placed.position;
    return placed;
  }

  /** The inventory as the planner should see it: short items recently reported missing are discounted. */
  function inventoryFor(state) {
    const inventory = { ...state.inventory };
    for (const [family, s] of Object.entries(memory.shortfall)) {
      if (s.until < Date.now()) { delete memory.shortfall[family]; continue; }
      const name = Object.keys(inventory).find((n) => kb[family]?.match(n));
      if (name) inventory[name] = Math.max(0, inventory[name] - s.extra);
    }
    return inventory;
  }

  const step = (ctx, planned) => runPlanned(ctx, planned, attempt => executeStep(attempt, planned));

  async function executeStep(ctx, planned) {
    switch (planned.kind) {
      case 'gather': {
        const result = await skills.gatherOne(bot, ctx, { blocks: planned.blocks, dropMatch: kb[planned.key].match, purpose, exclude: avoid });
        if (result.reason === 'no_target_in_range') return explore(ctx, planned.key);
        return result;
      }
      case 'craft': {
        const result = await skills.craft(bot, ctx, { item: planned.item, times: planned.times,
          tablePosition: planned.table ? memory.table : null });
        rememberShortfall(memory, kb, result);
        return result;
      }
      case 'place_station':
        return planned.station === 'crafting_table' ? placeTableNearby(ctx) : { ok: false, reason: `no_station:${planned.station}` };
      default:
        return { ok: false, reason: `unplannable:${planned.key}:${planned.kind}` };
    }
  }

  return { step, inventoryFor, tableHere, placeTableNearby, placeNearby };
}

function exploreFor(ctx, why, { bot, skills, memory, anchor, searchRadius, maxSearchStreak, maxExploreStreak, siteName = '' }) {
  memory.exploreStreak++;
  if (anchor) {
    const { x, y, z } = anchor, from = bot.entity.position;
    memory.explore.around = { x, z, radius: searchRadius };
    if (Math.hypot(from.x - x, from.z - z) > searchRadius) memory.exploreStreak--;
    if (memory.exploreStreak > maxSearchStreak) {
      return failure(`none_near_site:${why} within ${searchRadius} of ${siteName}${x},${y},${z}`, { terminal: true }, ctx);
    }
  } else delete memory.explore.around;
  if (memory.exploreStreak > maxExploreStreak) return { ok: false, reason: `exhausted:${why}` };
  ctx.record('explore_for', { why, streak: memory.exploreStreak });
  return skills.explore(bot, ctx, memory.explore);
}

function furnaceStock(inventory, furnace) {
  if (furnace.item === 'raw_iron') {
    inventory.raw_iron = (inventory.raw_iron || 0) + furnace.input;
    inventory.iron_ingot = (inventory.iron_ingot || 0) + furnace.output;
  }
  return inventory;
}

module.exports = { createPlannerRunner, exploreFor, furnaceStock, gatherInLoadedRange, rememberShortfall,
  placeStation, recoverToward, runPlanned, shortfallRequirements, surfaceFirst, DOWN };
