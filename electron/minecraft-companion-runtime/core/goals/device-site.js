'use strict';

const { goals } = require('mineflayer-pathfinder');
const { posKey } = require('../blacklist');
const { FACINGS } = require('../blueprints/cobbleGenerator');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const isAir = block => !block || ['air', 'cave_air', 'void_air'].includes(block.name);
const isSoft = block => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isSolid = block => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const facingOf = block => block?.getProperties?.()?.facing;
const partAccepts = (part, name) => name === part.block || Boolean(part.accept?.includes(name));
const partMatches = (blockAt, part) => {
  const block = blockAt(part.position);
  return partAccepts(part, block?.name) && (!part.facing || facingOf(block) === part.facing);
};

function guardDeviceCells(bot, memory, describe, cost = 1000) {
  const movements = bot.pathfinder?.movements;
  if (memory.guarded || !movements) return;
  const { step, breaks, extra } = describe();
  const noStep = new Set(step.map(posKey));
  const noBreak = new Set(breaks.map(posKey));
  movements.exclusionAreasStep.push(block => block?.position && (noStep.has(posKey(block.position)) || extra?.(block.position)) ? cost : 0);
  movements.exclusionAreasBreak.push(block => block?.position && noBreak.has(posKey(block.position)) ? 100 : 0);
  memory.guarded = true;
}

function standingAt(bot, p, tolerance = 0.5) {
  const { x, y, z } = bot.entity.position;
  return Math.floor(x) === p.x && Math.floor(z) === p.z && Math.abs(y - p.y) < tolerance;
}

async function goToStand(bot, ctx, actions, p, timeoutMs, tolerance) {
  const arrived = () => standingAt(bot, p, tolerance);
  if (arrived()) return { ok: true };
  const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs, arrived });
  if (arrived()) return { ok: true };
  return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
}

// Inspect each column's highest usable layer and break score ties in scan order.
function findDeviceSite(blockAt, around, { radius, step = 1, soft = isSoft, avoidFeet = false, evaluate, cost = () => 0 }) {
  const x = Math.floor(around.x), y = Math.floor(around.y), z = Math.floor(around.z);
  let best = null, bestScore = Infinity;
  for (let dx = -radius; dx <= radius; dx += step) for (let dz = -radius; dz <= radius; dz += step) {
    for (let top = y + 3; top >= y - 4; top--) {
      const block = blockAt(x + dx, top, z + dz);
      if (!block) break;
      if (soft(block)) continue;
      const anchor = { x: x + dx, y: top, z: z + dz };
      const dist = Math.hypot(dx, dz);
      const approach = dist + Math.abs(top + 1 - y) * 2 + (avoidFeet && dist < 3 ? 6 : 0);
      for (const facing of Object.keys(FACINGS)) {
        const site = evaluate(blockAt, anchor, facing);
        if (!site) continue;
        const score = cost(site) + approach;
        if (score < bestScore) { best = site; bestScore = score; }
      }
      break;
    }
  }
  return best;
}

module.exports = { findDeviceSite, LIQUID, isAir, isSoft, isSolid, facingOf, partAccepts, partMatches, guardDeviceCells, standingAt, goToStand };
