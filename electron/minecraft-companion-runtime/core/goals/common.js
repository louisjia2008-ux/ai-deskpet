'use strict';
// Shared by the smaller goals (farm, ranch): run one planner step (gather,
// craft, place a crafting table nearby) with the same failure handling the
// homestead uses, without a house to put the table in.

const { Vec3 } = require('vec3');
const { stepRetryAt } = require('../planner');
const { familyOf } = require('../knowledge');
const { naturalCover } = require('../natural-cover');
const { createAttempt, resultFrom, waiting, factsOf } = require('../action-result');

const DOWN = [new Vec3(0, -1, 0)];
// A table this close is used rather than another one made.
const TABLE_NEAR = 16;

async function runPlanned(ctx, step, execute) {
  if (step.kind === 'blocked') return waiting('planning_sources_blocked', step.retryAt);
  const until = stepRetryAt(step, ctx.planning);
  if (until) return waiting('planning_source_blocked', until);
  ctx = createAttempt(ctx);
  const raw = await execute(ctx);
  const result = resultFrom(raw, ctx);
  const data = factsOf(raw);
  if (data.transit || (!result.ok && (data.target || data.adaptation || data.terminal))) return result;
  if (result.progress && !data.moved && !data.skipped && !data.idle) ctx.adapt?.progress();
  return ctx.stepOutcome?.(step, result) ?? result;
}

function createPlannerRunner({ bot, skills, kb, memory, purpose = 'gather', avoid = () => false }) {
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

  // `station`: a crafting table by default; a furnace goes down the same way.
  async function placeNearby(ctx, station = 'crafting_table') {
    const here = bot.entity.position.floored();
    // The whole ring at each distance, a step up or down too: in a jungle
    // farm, grass, leaf litter and wheat filled the 24 cells once tried and
    // the bread was never baked.
    for (let r = 2; r <= 4; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const p = [0, 1, -1].map((dy) => here.offset(dx, dy, dz))
            .find((q) => naturalCover(blockAt(q)) && blockAt(q.offset(0, -1, 0))?.boundingBox === 'block'
              && blockAt(q.offset(0, -1, 0))?.name !== 'farmland' && !avoid(q) && !bot.companionPlayerBlock?.(q));
          if (!p) continue;
          const placed = await skills.placeAt(bot, ctx, p, (n) => n === station, { faces: DOWN, requireAir: true });
          // An animal (or the bot) standing there: try the next spot.
          if (placed.reason === 'cell_occupied_by_entity') continue;
          return placed.ok ? { ...placed, position: { x: p.x, y: p.y, z: p.z } } : placed;
        }
      }
    }
    return { ok: false, reason: `no_${station === 'crafting_table' ? 'table' : station}_spot` };
  }

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
    ctx.record('plan_step', { kind: planned.kind, key: planned.key, for: planned.for, item: planned.item });
    switch (planned.kind) {
      case 'gather': {
        const result = await skills.gatherOne(bot, ctx, { blocks: planned.blocks, dropMatch: kb[planned.key].match, purpose, exclude: avoid });
        if (result.reason === 'no_target_in_range') return skills.explore(bot, ctx, memory);
        return result;
      }
      case 'craft': {
        const result = await skills.craft(bot, ctx, { item: planned.item, times: planned.times,
          tablePosition: planned.table ? memory.table : null });
        for (const m of factsOf(result).missing || []) {
          const family = familyOf(m.name, kb);
          if (family) memory.shortfall[family] = { extra: m.short, until: Date.now() + 120000 };
        }
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

module.exports = { createPlannerRunner, runPlanned, DOWN };
