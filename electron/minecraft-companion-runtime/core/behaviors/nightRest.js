'use strict';

const { Vec3 } = require('vec3');
const { sleep } = require('../confirm');

const DAY_TICKS = 24_000;
const DARK = 12_542;
const DAWN = 23_461;
const DUSK = 10_800;
const LAST_SEAL_TICK = 12_100;
const WALK_TICKS_PER_BLOCK = 10; // Two blocks per second leaves room for path detours.
const SHELTER_TICKS = 120; // Six seconds to pass the threshold or start a local shelter.
const NEAR_DOOR_TICKS = 60;
const NIGHT_HUNT_MS = 5 * 60_000;
const NIGHT_GOALS = new Set(['hunt_pearls', 'follow_owner', 'come_to_owner']);
const overworld = (dimension) => String(dimension ?? 'overworld').replace(/^minecraft:/, '') === 'overworld';

function isDaylight(time) {
  return Number.isFinite(time) ? time < DARK || time >= DAWN : null;
}

function travelTicks(from, to) {
  if (!from || !to) return Infinity;
  return Math.ceil(WALK_TICKS_PER_BLOCK * Math.hypot(from.x - to.x, from.z - to.z)
    + 2 * WALK_TICKS_PER_BLOCK * Math.abs(from.y - to.y));
}

function nightBudget(state, home) {
  const time = state.timeOfDay;
  const surface = overworld(state.dimension);
  const dark = surface && (isDaylight(time) ?? state.isDay) === false;
  const ticksToDark = dark ? 0 : surface && Number.isFinite(time) ? (DARK - time + DAY_TICKS) % DAY_TICKS : Infinity;
  const dusk = ticksToDark <= DARK - DUSK;
  const distanceHome = state.position && home ? Math.hypot(state.position.x - home.x, state.position.z - home.z) : 0;
  const returnTicks = travelTicks(state.position, home);
  const maxOutingDistance = dusk ? 0 : Math.max(0, (ticksToDark - SHELTER_TICKS - (home ? returnTicks : 0)) / (2 * WALK_TICKS_PER_BLOCK));
  return { dark, dusk, ticksToDark, distanceHome, returnTicks, maxOutingDistance };
}

function allowedAtNight(bot, goal, hunt, now) {
  return NIGHT_GOALS.has(goal) || Boolean(goal && hunt && now - hunt.at < NIGHT_HUNT_MS
    && bot.inventory?.items?.().some(item => item.name.endsWith('_sword')) && bot.inventory?.slots?.[6]);
}

function nightShelter(bot, { house, goal, hunt, now = Date.now() }) {
  if (allowedAtNight(bot, goal, hunt, now)) return null;
  if (!house) return { bed: null, centre: null };
  const available = (p) => {
    const block = bot.blockAt(new Vec3(p.x, p.y, p.z));
    return !block || (block.name.endsWith('_bed') && String(block.getProperties?.().occupied) !== 'true');
  };
  const bed = [house.furniture.bed, house.furniture.guestBed].find(candidate =>
    candidate && available(candidate.position) && (!candidate.head || available(candidate.head)))?.position;
  return { bed: bed ?? null, centre: house.interiorCenter };
}

function createNightRest({ bot, home, activeGoal = () => null, shelterDoor, enterShelter, prepareSeals = () => false, adaptation,
  actions = require('../actions'), skills = require('../skills'), now = Date.now, retryBedMs = 20_000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  const { complete, factsOf, failure, isComplete, waiting } = require('../action-result');
  const { BAND } = require('../brain');
  const { shelterSealCount } = require('../skills');
  let bunker = null, shutForSleep = false, missedReturn = false, bedRefusedUntil = 0;
  const reset = () => {
    bunker = null;
    shutForSleep = missedReturn = false;
    bedRefusedUntil = 0;
    bot.companionSheltered = false;
  };
  const late = (budget, goal) => (budget.dusk || budget.maxOutingDistance === 0)
    && !allowedAtNight(bot, goal, bot.companionNightHunt, now());
  const view = (state) => ({ ...state, position: state.position ?? bot.entity?.position, dimension: bot.game?.dimension });
  const timing = (state, spot) => nightBudget(view(state), spot?.centre);
  const needsSeal = (state, budget) => !budget.dark && budget.ticksToDark <= DARK - DUSK && budget.ticksToDark > DARK - LAST_SEAL_TICK
    && !state.sheltered && !state.inWater && state.onGround !== false && !state.hostiles?.some(e => e.distance <= 8)
    && prepareSeals() && shelterSealCount(state.inventory) < 2 && !actions.underground?.(bot);
  const wait = async (ctx) => {
    await sleep(3_000, ctx.signal);
    return waiting('sheltering_until_daylight');
  };

  async function digIn(ctx, budget) {
    ctx.record('night_rest', { action: 'dig_in', distance: budget.distanceHome, ticksToDark: budget.ticksToDark,
      returnTicks: Number.isFinite(budget.returnTicks) ? budget.returnTicks : null });
    const dug = await skills.digIn(bot, ctx, {
      avoid: p => bot.companionHomeSite?.(p) || bot.blockAt?.(p.offset(0, -1, 0))?.name === 'farmland',
      prepareSeal: prepareSeals(),
    });
    if (!isComplete(dug)) return dug;
    bunker = factsOf(dug).bunker;
    if (bunker) {
      bot.companionSheltered = true;
      ctx.record('night_rest', { action: 'dug_in', top: bunker.top });
    }
    return dug;
  }

  async function goHome(ctx, spot, budget) {
    const timeoutMs = Math.max(2_000, (budget.ticksToDark - SHELTER_TICKS) * 50);
    const expiry = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, expiry]) : expiry;
    const travel = { ...ctx, signal, dryRoute: true };
    let moved;
    try {
      const crossed = await enterShelter?.(travel);
      if (isComplete(crossed) || crossed?.wait || ctx.signal?.aborted) return crossed;
      ctx.record('night_rest', { action: budget.dark ? 'go_home' : 'dusk_home', distance: Math.round(budget.distanceHome),
        ticksToDark: budget.ticksToDark, returnTicks: budget.returnTicks });
      const destination = spot.entrance && budget.returnTicks > NEAR_DOOR_TICKS ? spot.entrance : spot.centre;
      moved = await actions.goNear(bot, travel, destination, 0, { exact: true, retryNoProgress: false, timeoutMs });
    } catch (error) {
      if (!expiry.aborted || ctx.signal?.aborted) throw error;
    }
    if (expiry.aborted && !ctx.signal?.aborted) {
      missedReturn = true;
      return failure('path_timeout', {}, ctx, bot);
    }
    if (moved?.ok === false && !['start', 'interrupted'].includes(moved.kind) && !ctx.signal?.aborted) missedReturn = true;
    return moved;
  }

  const behavior = {
    name: 'night_rest',
    band: BAND.MAINTENANCE,
    taskAllowed(state, goal) {
      if (!overworld(bot.game?.dimension)) return true;
      if (bunker || shutForSleep) return false;
      return !late(timing(state, home()), goal);
    },
    want(state) {
      if (!overworld(bot.game?.dimension)) return 0;
      if (bunker || shutForSleep) return 0.8;
      const spot = home(), budget = timing(state, spot);
      if (needsSeal(state, budget)) return 0.5;
      if (!spot || !late(budget, activeGoal())) {
        missedReturn = false;
        return 0;
      }
      return 0.8;
    },
    async run(ctx) {
      const state = ctx.perceive(), spot = home(), budget = timing(state, spot);
      const hold = spot && late(budget, activeGoal());
      if (bunker) {
        if (hold) return wait(ctx);
        ctx.record('night_rest', { action: 'dig_out' });
        const rescue = { ...ctx, rescue: 'surface', adapt: ctx.adapt ?? adaptation?.scope(() => !ctx.signal?.aborted) };
        const out = await skills.digOut(bot, rescue, bunker);
        if (isComplete(out)) {
          ctx.record('night_rest', { action: 'dug_out' });
          reset();
        }
        return out;
      }
      if (needsSeal(state, budget) && !shutForSleep) {
        const stock = await skills.prepareShelterSeal(bot, ctx);
        ctx.record('night_rest', { action: 'prepare_seal', ...stock });
        return stock;
      }
      if (!hold) {
        if (!shutForSleep) return complete(false);
        const opened = await shelterDoor?.(ctx, true);
        if (opened == null || isComplete(opened)) reset();
        return opened ?? complete();
      }
      if (!spot.inside && actions.underground?.(bot)) return digIn(ctx, budget);
      if (spot.inside === false && spot.centre && !missedReturn
        && (budget.returnTicks + SHELTER_TICKS <= budget.ticksToDark || budget.dark && budget.returnTicks <= NEAR_DOOR_TICKS)) {
        return goHome(ctx, spot, budget);
      }
      if (!spot.centre || spot.inside === false) return digIn(ctx, budget);

      if (shelterDoor && !shutForSleep) {
        // The server may close the door just before we are preempted.
        shutForSleep = true;
        const shut = await shelterDoor(ctx, false);
        if (shut != null && !isComplete(shut)) {
          if (!ctx.signal?.aborted) shutForSleep = false;
          return shut;
        }
        bot.companionSheltered = true;
        if (shut) return shut;
      }
      if (budget.dark && spot.bed && now() >= bedRefusedUntil) {
        ctx.record('night_rest', { action: 'sleep' });
        const slept = await skills.useBed(bot, ctx, { position: spot.bed });
        if (isComplete(slept) || slept?.wait || ctx.signal?.aborted) return slept;
        bedRefusedUntil = now() + retryBedMs;
        const other = home()?.bed;
        if (other && (other.x !== spot.bed.x || other.y !== spot.bed.y || other.z !== spot.bed.z)) {
          ctx.record('night_rest', { action: 'sleep', fallback: true });
          return skills.useBed(bot, ctx, { position: other });
        }
      }
      if (shutForSleep && budget.dark) bot.companionSheltered = true;
      return wait(ctx);
    },
  };
  bot.on?.('death', reset);
  behavior.dispose = () => bot.removeListener?.('death', reset);
  return behavior;
}

module.exports = { createNightRest, isDaylight, nightBudget, nightShelter, travelTicks };
