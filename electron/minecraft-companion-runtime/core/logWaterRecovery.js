'use strict';

const { abortError, sleep } = require('./confirm');
const { naturalWalkingFoot } = require('../vendor/server/minecraft/houseSurfaceGraph');

const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SHORE_RADIUS = 32;
const MAX_ASCENT = 24;
const MAX_ASCENT_MS = 8_000;

const wet = block => WATER.has(block?.name);
const air = block => AIR.has(block?.name);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function isLogScoutInWater(bot) {
  const entity = bot.entity;
  if (!entity?.position || entity.isInLava) return false;
  const feet = entity.position.floored();
  return entity.isInWater === true || wet(bot.blockAt(feet, false))
    || (!entity.onGround && wet(bot.blockAt(feet.offset(0, -1, 0), false)));
}

// Read the top of a connected water column even if the bot is on its bottom.
// A missing block or low ceiling cannot establish a breathable exit.
function surfaceColumn(bot, feet) {
  const first = wet(bot.blockAt(feet, false)) ? feet : feet.offset(0, -1, 0);
  if (!wet(bot.blockAt(first, false))) return null;
  for (let dy = 1; dy <= MAX_ASCENT; dy++) {
    const above = first.offset(0, dy, 0);
    const block = bot.blockAt(above, false);
    if (wet(block)) continue;
    return air(block) && air(bot.blockAt(above.offset(0, 1, 0), false)) ? above : null;
  }
  return null;
}

function openWater(bot, surface) {
  return wet(bot.blockAt(surface.offset(0, -1, 0), false))
    && air(bot.blockAt(surface, false)) && air(bot.blockAt(surface.offset(0, 1, 0), false));
}

// Find a connected route on the observed water surface. Straight-line nearest
// dry blocks can be behind a wall or above an underwater drop.
function shoreRoute(bot, origin, check) {
  const queue = [{ at: origin, previous: null }];
  const key = point => `${point.x},${point.z}`;
  const visited = new Set([key(origin)]);
  for (let i = 0; i < queue.length; i++) {
    if (!check()) return null;
    const current = queue[i];
    for (const [dx, dz] of CARDINAL) {
      const next = current.at.offset(dx, 0, dz);
      if (distance(origin, next) > SHORE_RADIUS || visited.has(key(next))) continue;
      visited.add(key(next));
      if (naturalWalkingFoot(bot, next)) {
        const route = [next];
        for (let node = current; node; node = node.previous) route.push(node.at);
        return route.reverse();
      }
      if (openWater(bot, next)) queue.push({ at: next, previous: current });
    }
  }
  return null;
}

async function recoverFromLogWater(bot, ctx, { timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    return Date.now() < deadline && bot.entity?.position && !bot.entity.isInLava && bot.health !== 0;
  };
  const exhausted = { ok: false, reason: 'log_water_recovery_timeout' };
  const noShore = { ok: false, reason: 'log_water_no_shore' };
  if (!check()) return exhausted;
  if (!isLogScoutInWater(bot)) return { ok: false, reason: 'not_in_water' };

  const grounded = () => bot.entity.onGround && !isLogScoutInWater(bot)
    && naturalWalkingFoot(bot, bot.entity.position.floored());
  const eyeHeight = () => bot.entity.eyeHeight || 1.62;
  const aim = target => {
    const height = Math.max(target.y, bot.entity.position.y) + eyeHeight();
    return bot.lookAt(target.offset(0, height - target.y, 0), true);
  };
  const tick = () => sleep(Math.max(1, Math.min(50, deadline - Date.now())), ctx.signal);

  bot.pathfinder?.setGoal?.(null);
  try {
    ctx.record?.('log_water_recovery_started', { position: bot.entity.position.clone() });
    const feet = bot.entity.position.floored();
    const adjacent = CARDINAL.map(([dx, dz]) => feet.offset(dx, 0, dz));
    const surface = surfaceColumn(bot, feet) || adjacent.map(point => surfaceColumn(bot, point)).find(Boolean);
    if (!surface) return noShore;
    const ascentDeadline = Math.min(deadline, Date.now() + MAX_ASCENT_MS);
    const surfaceCenter = surface.offset(0.5, 0, 0.5);
    bot.setControlState('jump', true);
    while (check() && Date.now() < ascentDeadline) {
      const here = bot.entity.position;
      const centered = distance(here, surfaceCenter) < 0.4;
      const eye = here.offset(0, eyeHeight(), 0).floored();
      if (grounded() || (centered && air(bot.blockAt(eye, false)) && eye.y >= surface.y)) break;
      if (!centered) await aim(surfaceCenter);
      if (!check()) return exhausted;
      bot.setControlState('forward', !centered);
      await tick();
    }
    if (!check() || Date.now() >= ascentDeadline) return exhausted;
    bot.setControlState('forward', false);

    if (!grounded()) {
      const route = shoreRoute(bot, surface, check);
      if (!route) return check() ? noShore : exhausted;
      const shore = route.at(-1);
      ctx.record?.('log_water_shore_selected', { shore, waterSteps: route.length - 1 });
      for (const [index, point] of route.entries()) {
        const target = point.offset(0.5, 0, 0.5);
        const last = index === route.length - 1;
        while (check() && (last ? !grounded() : distance(bot.entity.position, target) > 0.32)) {
          if (last ? !naturalWalkingFoot(bot, point) : !openWater(bot, point)) return noShore;
          await aim(target);
          if (!check()) return exhausted;
          // Release jump once clear of the water so the landing can settle.
          const close = distance(bot.entity.position, target) < 0.35;
          const floating = isLogScoutInWater(bot);
          bot.setControlState('jump', floating || !last);
          bot.setControlState('forward', !close || floating);
          await tick();
        }
        if (!check()) return exhausted;
        if (grounded()) break;
      }
    }
    if (!grounded()) return exhausted;
    ctx.record?.('log_water_recovered', { position: bot.entity.position.clone() });
    return { ok: true, moved: 'swam_ashore' };
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
}

module.exports = { isLogScoutInWater, recoverFromLogWater };
