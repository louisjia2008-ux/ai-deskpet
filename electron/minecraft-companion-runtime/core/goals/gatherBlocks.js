'use strict';
// Goal: hold at least N items obtained by breaking matching blocks (e.g. logs).
//
// Each run() handles one block: reach it, break it, pick up the drop. A log
// goal can search for new terrain first, using the same cancellable body.

const defaultActions = require('../actions');
const { goals } = require('mineflayer-pathfinder');
const { abortError } = require('../confirm');
const { countMatching } = require('../perception');
const { posKey } = require('../blacklist');
const { ledgerFor, ledgerTarget, recordTarget } = require('../failure-ledger');
const { loadedSurfaceFeet, naturalWalkingFoot } = require('../../vendor/server/minecraft/houseSurfaceGraph');
const { recoverFromLogWater, isLogScoutInWater } = require('../logWaterRecovery');

const isLog = (name) => name.endsWith('_log') && !name.startsWith('stripped_');
const SEARCH_LEG = 32;
const SEARCH_LEGS = 30;
const SEARCH_TIME_MS = 6 * 60 * 1000;
const PIT_CLIMBS = 2;
const LOG_SCAN_RADIUS = 48;
const CANOPY_SCAN_RADIUS = 112;
const CANOPY_SCAN_INTERVAL = 3;
const HEADINGS = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
const TREE_BIOME = /forest|taiga|jungle|savanna|swamp|grove|wooded|cherry/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WATER = /^(?:water|bubble_column|kelp(?:_plant)?|(?:tall_)?seagrass)$/;

const wet = block => WATER.test(block?.name) || [true, 'true'].includes(block?.getProperties?.().waterlogged);
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function isDeepWater(bot, block) {
  return wet(block) && [1, -1].some(dy => wet(bot.blockAt(block.position.offset(0, dy, 0), false)));
}

function bodyInDeepWater(bot) {
  if (!isLogScoutInWater(bot)) return false;
  const feet = bot.entity.position.floored();
  return wet(bot.blockAt(feet.offset(0, 1, 0), false))
    || (wet(bot.blockAt(feet, false)) && wet(bot.blockAt(feet.offset(0, -1, 0), false)));
}

function selectHeading(bot, memory, distance) {
  const here = bot.entity.position;
  const canopy = memory.canopy;
  const canopyDirection = canopy && Math.atan2(canopy.z - here.z, canopy.x - here.x);
  let best;
  for (const heading of HEADINGS) {
    const x = Math.round(here.x + Math.cos(heading) * distance);
    const z = Math.round(here.z + Math.sin(heading) * distance);
    const key = `${x >> 4},${z >> 4}`;
    if (memory.visited.has(key)) continue;
    const surface = [[0, 0], ...SIDES.map(([dx, dz]) => [dx * 2, dz * 2])]
      .map(([dx, dz]) => loadedSurfaceFeet(bot, x + dx, z + dz, here.y, { up: 32, down: 20 })[0])
      .filter(p => p && !memory.visited.has(`${p.x >> 4},${p.z >> 4}`));
    if (surface.length === 0) continue;
    let score = heading === memory.heading && !memory.blocked ? 5 : 0;
    // Look past the waypoint: a new block within a previously scanned corridor
    // is less useful than a leg that reveals more terrain. Keep it available
    // when following a bank or when every more direct route is blocked.
    const frontier = here.offset(Math.cos(heading) * (distance + 24), 0, Math.sin(heading) * (distance + 24));
    const nearestScan = Math.min(LOG_SCAN_RADIUS, ...memory.scanned.map(point => horizontalDistance(point, frontier)));
    score += nearestScan / 2;
    if (canopy) score += 56 * Math.cos(heading - canopyDirection);
    for (const sample of [SEARCH_LEG, 2 * SEARCH_LEG, 3 * SEARCH_LEG]) {
      const point = here.offset(Math.cos(heading) * sample, 0, Math.sin(heading) * sample).floored();
      const biome = bot.blockAt(point, false)?.biome?.name;
      if (biome?.includes('ocean')) score -= 12;
      else if (biome && TREE_BIOME.test(biome)) score += 14;
      else if (biome) score += 2;
    }
    if (!best || score > best.score) best = { heading, key, score, distance, surface };
  }
  return best;
}

function hasNaturalCanopy(bot, log) {
  const leafName = log.name.replace(/_log$/, '_leaves');
  const isCanopy = (block) => {
    const sameFamily = block?.name === leafName || (log.name === 'oak_log' && /^(flowering_)?azalea_leaves$/.test(block?.name));
    return sameFamily && block.getProperties?.().persistent === false;
  };
  // Follow the contiguous trunk upward. An unrelated leaf beside a distant
  // opening is not evidence for a log buried underneath it.
  for (let y = 0; y < 18; y++) {
    const trunk = log.position.offset(0, y, 0);
    if (SIDES.some(([x, z]) => isCanopy(bot.blockAt(trunk.offset(x, 0, z), false)))) return true;
    const above = bot.blockAt(trunk.offset(0, 1, 0), false);
    if (isCanopy(above)) return true;
    if (above?.name !== log.name) return false;
  }
  return false;
}

function hasOpenColumn(bot, position, topY) {
  for (let y = position.y + 1; y <= topY; y++) {
    const above = bot.blockAt(position.offset(0, y - position.y, 0), false);
    if (!above?.name) return false;
    if (isLog(above.name) || above.name.endsWith('_leaves')) continue;
    if (above.boundingBox !== 'empty' || above.name === 'water' || above.name === 'lava') return false;
  }
  return true;
}

function isSurfaceLog(bot, block) {
  const dimension = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  if (dimension === 'the_nether' || dimension === 'the_end') return true;
  if (hasNaturalCanopy(bot, block)) return true;

  // Skylight can be absent or misleading at chunk/lighting boundaries. For a
  // log without a canopy, require a loaded, unobstructed column above it or
  // beside it. This still accepts surface logs placed by the player.
  const topY = bot.game?.minY + bot.game?.height - 1;
  return Number.isInteger(topY) && topY >= block.position.y
    && [[0, 0], ...SIDES].some(([x, z]) => hasOpenColumn(bot, block.position.offset(x, 0, z), topY));
}

async function withLogRouteMovements(bot, action) {
  const movements = bot.pathfinder?.movements;
  if (!movements) return action();
  const { canDig, maxDropDown } = movements;
  try {
    movements.canDig = false;
    // Mineflayer measures from the current feet to the landing support block.
    // A limit of two allows one block of actual descent, which we can climb back.
    if (Number.isFinite(maxDropDown)) movements.maxDropDown = Math.min(maxDropDown, 2);
    return await action();
  } finally {
    movements.canDig = canDig;
    if (Number.isFinite(maxDropDown)) movements.maxDropDown = maxDropDown;
  }
}

/** Block submerged steps while scouting and retire the path if the body falls into water. */
async function dryRoute(bot, ctx, action) {
  const movements = bot.pathfinder?.movements;
  const exclusions = movements?.exclusionAreasStep;
  const rejectDeepWater = block => {
    if (!block?.position) return 0;
    if (isDeepWater(bot, block)) return 100;
    if (block.boundingBox !== 'empty' || wet(block)) return 0;
    const below = bot.blockAt(block.position.offset(0, -1, 0), false);
    return isDeepWater(bot, below) ? 100 : 0;
  };
  const water = new AbortController();
  const onPhysics = () => { if (bodyInDeepWater(bot)) water.abort('log_scout_water_entered'); };
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, water.signal]) : water.signal;
  exclusions?.push(rejectDeepWater);
  bot.on?.('physicsTick', onPhysics);
  try {
    onPhysics();
    if (!water.signal.aborted) return await withLogRouteMovements(bot, () => action({ ...ctx, signal }));
  } catch (error) {
    if (!water.signal.aborted || ctx.signal?.aborted) throw error;
  } finally {
    bot.removeListener?.('physicsTick', onPhysics);
    const index = exclusions?.indexOf(rejectDeepWater) ?? -1;
    if (index >= 0) exclusions.splice(index, 1);
  }
  return { ok: false, reason: 'log_scout_water_entered' };
}

async function walkToSurface(bot, ctx, _memory, { surface, timeoutMs }) {
  const target = surface[0];
  ctx.record('explore', { x: target.x, y: target.y, z: target.z });
  const goal = new goals.GoalCompositeAny(surface.map(({ x, y, z }) => new goals.GoalBlock(x, y, z)));
  return defaultActions.goTo(bot, ctx, goal, {
    timeoutMs, retryNoProgress: false,
    arrived: at => goal.isEnd(at.floored()) && naturalWalkingFoot(bot, at.floored()),
  });
}

function createGatherBlocksGoal({
  bot,
  name = 'gather_blocks',
  count,
  itemMatch,
  blockMatch = itemMatch,
  baseline,
  searchRadius = 48,
  maxCandidates = 32,
  actions = defaultActions,
  findTargets,
  findBeyondRange,
  acceptTarget,
} = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  if (typeof itemMatch !== 'function') throw new TypeError('itemMatch is required');
  const startCount = Number.isFinite(baseline)
    ? baseline
    : countMatching(Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count])), itemMatch);
  const target = startCount + count;

  const locate = findTargets || (() => defaultFindTargets(bot, blockMatch, searchRadius, maxCandidates, acceptTarget));

  return {
    name,
    target,
    isDone: (state) => countMatching(state.inventory, itemMatch) >= target,
    progress: (state) => countMatching(state.inventory, itemMatch),
    async run(ctx) {
      const ledger = ledgerFor(bot, ctx), spec = p => ledgerTarget(bot, 'gather_blocks', p);
      const availableTargets = () => locate().filter(block => !ledger.skip(spec(block.position)));
      let candidates = availableTargets();
      if (candidates.length === 0 && findBeyondRange) candidates = await findBeyondRange(ctx, availableTargets);
      if (candidates.length === 0) {
        return { ok: false, reason: candidates.reason || (findBeyondRange ? 'log_search_exhausted' : 'no_target_in_range') };
      }
      const here = ctx.perceive().position;
      candidates.sort((a, b) => targetCost(here, a.position) - targetCost(here, b.position));
      const block = candidates[0];
      const key = posKey(block.position);
      ctx.record('target_selected', { block: block.name, position: key, options: candidates.length });

      const reach = await actions.goToDig(bot, ctx, block);
      if (!reach.ok || reach.wait) return recordTarget(bot, ctx, reach, spec(block.position));
      const dig = await actions.digBlock(bot, ctx, block);
      if (!dig.ok) return recordTarget(bot, ctx, dig, spec(block.position));
      ledger.clearOnSuccess(spec(block.position));
      const pickup = await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), itemMatch);
      return pickup.ok ? { ok: true } : pickup;
    },
  };
}

// Prefer near and low blocks: a trunk is cleared bottom-up from the ground.
function targetCost(from, to) {
  const dx = to.x + 0.5 - from.x;
  const dz = to.z + 0.5 - from.z;
  const dy = to.y - from.y;
  return Math.hypot(dx, dz) + Math.max(0, dy) * 3 + Math.max(0, -dy) * 1.5;
}

function defaultFindTargets(bot, blockMatch, maxDistance, count, acceptTarget) {
  const ids = Object.values(bot.registry.blocksByName)
    .filter((block) => blockMatch(block.name))
    .map((block) => block.id);
  if (ids.length === 0) return [];
  return bot.findBlocks({ matching: ids, maxDistance, count, useExtraInfo: acceptTarget })
    .map((position) => bot.blockAt(position))
    .filter(Boolean);
}

function createGatherLogsGoal({ bot, count, walk = walkToSurface, recover = recoverFromLogWater, actions = defaultActions, ...rest }) {
  const memory = { visited: new Set(), scanned: [], climbs: 0 };
  let legs = 0;
  let deadline;

  // Scouting never digs, so a bot at the bottom of a pit or shaft would fail
  // every leg at once. Climb out first (tower or dig stairs); the climb does
  // not count against the search time.
  async function leavePit(ctx) {
    if (memory.climbs >= PIT_CLIMBS || typeof actions.underground !== 'function'
      || typeof actions.surface !== 'function' || !actions.underground(bot)) return true;
    memory.climbs++;
    const started = Date.now();
    const targetY = actions.localSurfaceY?.(bot, { radius: 3, above: 24 });
    ctx.record('leaving_pit', { fromY: Math.floor(bot.entity.position.y), targetY });
    const result = await actions.surface(bot, ctx, { targetY }).catch(error => {
      if (ctx.signal?.aborted) throw error;
      return { ok: false };
    });
    if (deadline) deadline += Date.now() - started;
    return result?.ok !== false;
  }

  async function findBeyondRange(ctx, availableTargets) {
    if (!await leavePit(ctx)) return Object.assign([], { reason: 'log_scout_trapped' });
    deadline ??= Date.now() + SEARCH_TIME_MS;
    while (legs < SEARCH_LEGS && Date.now() < deadline) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (bodyInDeepWater(bot)) {
        const shore = await recover(bot, ctx, { timeoutMs: Math.max(1, Math.min(20000, deadline - Date.now())) });
        if (!shore.ok) break;
        memory.blocked = true;
        const candidates = availableTargets();
        if (candidates.length > 0) return candidates;
      }
      const here = bot.entity.position;
      if (!memory.scanned.some(point => horizontalDistance(point, here) < 8)) memory.scanned.push(here.clone());
      if (legs % CANOPY_SCAN_INTERVAL === 0 && memory.lastCanopyScan !== legs) {
        memory.lastCanopyScan = legs;
        memory.canopy = bot.findBlocks && bot.registry?.blocksByName
          ? defaultFindTargets(bot, isLog, CANOPY_SCAN_RADIUS, 1,
            block => horizontalDistance(block.position, here) > LOG_SCAN_RADIUS && hasNaturalCanopy(bot, block))[0]?.position
          : undefined;
      }
      const next = selectHeading(bot, memory, SEARCH_LEG) ?? selectHeading(bot, memory, SEARCH_LEG / 2);
      if (!next) break;
      const { heading, key, distance, surface } = next;
      memory.heading = heading;
      memory.blocked = false;
      memory.visited.add(key);
      ctx.record('searching_for_logs', { leg: ++legs, maxLegs: SEARCH_LEGS });
      const result = await dryRoute(bot, ctx, step => walk(bot, step, memory, {
        surface, distance, timeoutMs: Math.max(1, Math.min(20000, deadline - Date.now())),
      }));
      if (!result?.ok) memory.blocked = true;
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (bodyInDeepWater(bot)) continue;
      if (!result?.ok && !await leavePit(ctx)) return Object.assign([], { reason: 'log_scout_trapped' });
      const candidates = availableTargets();
      if (candidates.length > 0) return candidates;
    }
    return [];
  }

  return createGatherBlocksGoal({ bot, count, name: 'gather_logs', itemMatch: isLog, searchRadius: LOG_SCAN_RADIUS,
    acceptTarget: (block) => isSurfaceLog(bot, block), findBeyondRange, ...rest,
    actions: { ...actions, goToDig: async (bot, ctx, block) => {
      if (bodyInDeepWater(bot)) {
        const shore = await recover(bot, ctx);
        if (!shore.ok) return shore;
      }
      return dryRoute(bot, ctx, step => actions.goToDig(bot, step, block));
    } },
  });
}

module.exports = { createGatherBlocksGoal, createGatherLogsGoal, isLog, isSurfaceLog, targetCost };
