'use strict';

const { Vec3 } = require('vec3');
const { waitUntil } = require('../confirm');
const { factsOf, isComplete } = require('../action-result');
const { goals } = require('mineflayer-pathfinder');
const { posKey } = require('../blacklist');
const { FACINGS } = require('../blueprints/cobbleGenerator');

const TERRAIN = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone',
  'andesite', 'diorite', 'granite', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'tuff', 'clay', 'mud',
  'terracotta', 'moss_block', 'netherrack']);
const TUNNEL = /^(stone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|cobblestone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|clay|calcite|.*_ore)$/;
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

function adoptDeviceSite(bot, ctx, memory, slot, choose, options) {
  if (memory[slot]) return true;
  const site = choose((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position, options);
  if (!site) return false;
  memory[slot] = site;
  const { kind, anchor, facing } = site;
  ctx.record('device_site', { kind, anchor, facing });
  return true;
}

async function digDeviceCell(bot, ctx, actions, block, beforeDig) {
  if (!block) return { ok: false, reason: 'unloaded' };
  const reach = await actions.goToDig(bot, ctx, block);
  if (!reach.ok) return reach;
  return beforeDig?.() || actions.digBlock(bot, ctx, block);
}

async function swimOutOfDevice(bot, ctx, aim, clear) {
  try {
    await bot.lookAt(aim, true);
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await waitUntil(clear, { timeoutMs: 4000, signal: ctx.signal });
  } finally {
    bot.setControlState('jump', false);
    bot.setControlState('forward', false);
  }
}

async function digFromBeside(bot, ctx, actions, blockAt, p, move) {
  const block = blockAt(p);
  if (!actions.withinReach(bot, new Vec3(p.x, p.y, p.z))) {
    const reach = await actions.goToDig(bot, ctx, block);
    if (!reach.ok) return reach;
  }
  const feet = bot.entity.position.floored();
  return p.x === feet.x && p.z === feet.z && p.y === feet.y - 1
    ? move() : actions.digBlock(bot, ctx, blockAt(p));
}

async function stepBeside(blockAt, p, heights, walk) {
  const spots = Object.values(FACINGS).flatMap(({ x, z }) => heights.map(dy => ({ x: p.x + x, y: p.y + 1 + dy, z: p.z + z })));
  const clear = spots.filter(c => isAir(blockAt(c)) && isAir(blockAt({ ...c, y: c.y + 1 })) && isSolid(blockAt({ ...c, y: c.y - 1 })));
  for (const c of clear) if (await walk(c)) return { ok: true };
  return { ok: false, reason: 'no_spot_beside' };
}

async function stepOffDevice(bot, ctx, actions, goal, trapped, detail) {
  await actions.goTo(bot, ctx, goal, { timeoutMs: detail?.from ? 10000 : 15000, arrived: () => !trapped() });
  if (!trapped()) return { ok: true };
  const result = await actions.unstick(bot, ctx);
  ctx.record('device_step_off', { ...detail, result: isComplete(result) ? factsOf(result).moved : result.wait?.reason ?? result.reason });
  return trapped() ? (result.wait ? result : { ok: false, reason: 'trapped_in_device' }) : { ok: true };
}

function placeDevicePart(bot, ctx, skills, part, verify, options) {
  const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
  const match = name => name === part.block || (options?.acceptItem && name === part.item);
  const { acceptItem: _acceptItem, ...placement } = options || {};
  return skills.placeAt(bot, ctx, part.position, match, { faces: [toward], verify, ...placement });
}

async function finishDevicePart(ctx, blockAt, part, attempt) {
  const result = await attempt;
  ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
  return result;
}

function validDeviceLayers(blockAt, ...layers) {
  return layers.every(([cells, check]) => cells.every(p => check(blockAt(p.x, p.y, p.z))));
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

module.exports = { findDeviceSite, LIQUID, isAir, isSoft, isSolid, facingOf, partAccepts, partMatches, guardDeviceCells, standingAt, goToStand, validDeviceLayers,
  adoptDeviceSite, digDeviceCell, stepOffDevice, placeDevicePart, finishDevicePart, swimOutOfDevice, digFromBeside, stepBeside, TERRAIN, TUNNEL };
