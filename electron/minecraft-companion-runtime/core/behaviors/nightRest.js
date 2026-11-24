'use strict';

const { Vec3 } = require('vec3');
const { sleep, waitUntil } = require('../confirm');

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
const HOME_SHELTER = Symbol('home_shelter');
const overworld = (dimension) => String(dimension ?? 'overworld').replace(/^minecraft:/, '') === 'overworld';
const isDaylight = time => Number.isFinite(time) ? time < DARK || time >= DAWN : null;

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

const allowedAtNight = (bot, goal, hunt, now) =>
  NIGHT_GOALS.has(goal) || Boolean(goal && hunt && now - hunt.at < NIGHT_HUNT_MS
    && bot.inventory?.items?.().some(item => item.name.endsWith('_sword')) && bot.inventory?.slots?.[6]);

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
  const { bunkerOccupied, enclosureOccupied, shelterSealCount } = require('../skills');
  const { boundedWork } = require('../work-budget');
  const { leaveMine, mineExit } = require('../mining');
  let shelter = null, enclosure = null, missedReturn = false, missedDig = false, retryShelterAt = 0;
  let returnUntil = null, bedRefusedUntil = 0;
  let lostShelter = false;
  const occupied = () => {
    if (shelter === HOME_SHELTER) {
      const site = home();
      return site?.inside === true && (site.covered?.() ?? true);
    }
    return Boolean(shelter && (shelter === enclosure ? enclosureOccupied : bunkerOccupied)(bot, shelter));
  };
  Object.defineProperty(bot, 'companionSheltered', { configurable: true,
    get: () => bot.health !== 0 && (overworld(bot.game?.dimension) ? occupied() : Boolean(bot.companionEndShelter?.())) });
  const reset = () => {
    shelter = null;
    if (!enclosure?.placed.length) enclosure = null;
    lostShelter = false;
    missedReturn = missedDig = false;
    retryShelterAt = 0;
    returnUntil = null;
    bedRefusedUntil = 0;
  };
  const verify = state => {
    if (shelter && (shelter === HOME_SHELTER ? home()?.inside !== true : !occupied()) && late(timing(state, home()))) {
      reset();
      lostShelter = true;
    }
  };
  const late = (budget, goal = activeGoal()) => (budget.dusk || budget.maxOutingDistance === 0)
    && !allowedAtNight(bot, goal, bot.companionNightHunt, now());
  const timing = (state, spot) => nightBudget({
    ...state, position: state.position ?? bot.entity?.position, dimension: bot.game?.dimension,
  }, spot?.centre);
  const needsSeal = (state, budget) => !budget.dark && budget.ticksToDark <= DARK - DUSK && budget.ticksToDark > DARK - LAST_SEAL_TICK
    && !state.sheltered && !state.inWater && state.onGround !== false && !state.hostiles?.some(e => e.distance <= 8)
    && prepareSeals() && shelterSealCount(state.inventory) < 2 && !actions.underground?.(bot);
  const wait = ({ signal }) => sleep(3_000, signal).then(() => waiting('sheltering_until_daylight'));

  async function shelterLocally(ctx, budget) {
    if (retryShelterAt) {
      if (!budget.dark || now() < retryShelterAt) return wait(ctx);
      retryShelterAt = 0;
      missedDig = false;
    }
    const shaft = !missedDig;
    if (shaft) ctx.record('night_rest', { action: 'dig_in', distance: budget.distanceHome, ticksToDark: budget.ticksToDark,
      returnTicks: Number.isFinite(budget.returnTicks) ? budget.returnTicks : null });
    else {
      const grounded = () => bot.entity.onGround !== false;
      if (!grounded() && !await waitUntil(grounded, { timeoutMs: 2000, signal: ctx.signal })) {
        return failure('shelter_not_entered', { objective: bot.entity.position.floored(), attempted: ['wait_for_landing'] }, ctx, bot);
      }
      enclosure ||= { top: bot.entity.position.floored(), placed: [] };
    }
    const result = shaft ? await skills.digIn(bot, { ...ctx, dryRoute: true }, {
      avoid: p => bot.companionHomeSite?.(p) || bot.blockAt?.(p.offset(0, -1, 0))?.name === 'farmland',
      prepareSeal: prepareSeals(),
    }) : await skills.enclose?.(bot, ctx, enclosure);
    const bunker = isComplete(result) && factsOf(result).bunker;
    const room = bunker || (!shaft && enclosure);
    if (room && isComplete(result) && (bunker ? bunkerOccupied : enclosureOccupied)(bot, room)) {
      shelter = room;
      if (bunker) enclosure = null;
      ctx.record('night_rest', bunker ? { action: 'dug_in', top: room.top, ...(room.depth && { depth: room.depth, cover: room.cover }) }
        : { action: 'enclosed', position: room.top, placed: room.placed.map(b => b.position) });
      return result;
    }
    const interrupted = ctx.signal?.aborted || result?.wait || result?.kind === 'interrupted';
    if (shaft) {
      if (!interrupted) missedDig = true;
      return room ? failure('shelter_not_entered', { objective: room.top, attempted: ['dig_in'] }, ctx, bot) : result;
    }
    if (interrupted || result?.kind === 'start' || result?.reason === 'shelter_not_entered') {
      if (!enclosure.placed.length) enclosure = null;
      return result;
    }
    retryShelterAt = now() + 10_000;
    ctx.record('night_rest', { action: 'shelter_exhausted', result, position: enclosure.top });
    return wait(ctx);
  }

  function undergroundExit(spot) {
    if (!actions.underground?.(bot)) return null;
    const position = bot.entity.position;
    const known = mineExit(bot.companionMineRoute, position);
    if (known) return { ...known, mine: bot.companionMineRoute, method: 'mine_exit' };
    const point = position.offset(0, Math.max(spot.centre.y, actions.localSurfaceY?.(bot) ?? position.y) - position.y, 0);
    return { point, ticks: travelTicks(position, point), method: 'surface' };
  }

  async function goHome(ctx, spot, budget, exit) {
    const { returnTicks, ticksToDark, dark } = budget;
    const limit = ticksToDark - SHELTER_TICKS;
    returnUntil ??= now() + Math.max(2_000, 50 * (dark || returnTicks > limit ? returnTicks + 200 : limit));
    const timeoutMs = Math.max(0, returnUntil - now());
    const limitResult = () => failure('path_timeout', {}, ctx, bot);
    const moved = await boundedWork(bot, { ...ctx, dryRoute: true }, { timeoutMs, check: () => timeoutMs > 0, limitResult }, async travel => {
      ctx.record('night_rest', { action: dark ? 'go_home' : 'dusk_home', distance: Math.round(budget.distanceHome),
        ticksToDark, returnTicks, ...(exit && { underground: true, method: exit.method }) });
      if (exit) {
        const leg = exit.mine && await leaveMine(bot, travel, exit, actions);
        return leg || (await actions.surface?.(bot, travel, { targetY: exit.point.y })) || failure('still_below_surface', {}, ctx, bot);
      }
      const crossed = await enterShelter?.(travel);
      if (isComplete(crossed) || crossed?.wait || travel.signal.aborted) return crossed;
      const destination = spot.entrance && returnTicks > NEAR_DOOR_TICKS ? spot.entrance : spot.centre;
      return actions.goNear(bot, travel, destination, 0, { exact: true, retryNoProgress: false, timeoutMs });
    });
    if (moved?.ok === false && moved.kind !== 'interrupted' && !ctx.signal?.aborted) missedReturn = true;
    return moved;
  }

  const behavior = {
    name: 'night_rest',
    band: BAND.MAINTENANCE,
    taskAllowed(state, goal) {
      verify(state);
      return !overworld(bot.game?.dimension) || (!shelter && !enclosure?.placed.length && !late(timing(state, home()), goal));
    },
    want(state) {
      verify(state);
      if (!overworld(bot.game?.dimension)) return 0;
      if (shelter || enclosure?.placed.length) return 0.8;
      const spot = home(), budget = timing(state, spot);
      if (needsSeal(state, budget)) return 0.5;
      if (spot && late(budget)) return 0.8;
      reset();
      return 0;
    },
    async run(ctx) {
      const state = ctx.perceive();
      verify(state);
      if (lostShelter) {
        ctx.record?.('night_rest', { action: 'shelter_lost' });
        lostShelter = false;
      }
      const spot = home(), budget = timing(state, spot);
      const hold = spot && late(budget), bunker = shelter === HOME_SHELTER ? null : shelter;
      if (!hold && (shelter || enclosure)) {
        const shaft = bunker && bunker !== enclosure;
        if (shaft) ctx.record('night_rest', { action: 'dig_out' });
        const result = shaft
          ? await skills.digOut(bot, { ...ctx, rescue: 'surface', adapt: ctx.adapt ?? adaptation?.scope(() => !ctx.signal?.aborted) }, bunker)
          : shelter === HOME_SHELTER ? await shelterDoor?.(ctx, true) ?? complete()
            : await skills.openEnclosure?.(bot, ctx, enclosure) ?? complete();
        if (isComplete(result)) {
          if (shaft) ctx.record('night_rest', { action: 'dug_out' });
          else if (enclosure && shelter !== HOME_SHELTER) {
            ctx.record('night_rest', { action: 'enclosure_opened' });
            enclosure = null;
          }
          reset();
        }
        return result;
      }
      if (bunker) return wait(ctx);
      if (!shelter && needsSeal(state, budget)) {
        const stock = await skills.prepareShelterSeal(bot, ctx);
        ctx.record('night_rest', { action: 'prepare_seal', ...stock });
        return stock;
      }
      if (!hold) return complete(false);
      if (!spot.inside) {
        const exit = spot.centre && undergroundExit(spot);
        if (exit) budget.returnTicks = exit.ticks + travelTicks(exit.point, spot.centre);
        const margin = budget.distanceHome <= 48 ? 200 : 0;
        const latestReturn = budget.dark ? NEAR_DOOR_TICKS : budget.ticksToDark - SHELTER_TICKS + margin;
        return spot.centre && !missedReturn && (returnUntil !== null || budget.returnTicks <= latestReturn)
          ? goHome(ctx, spot, budget, exit) : shelterLocally(ctx, budget);
      }

      if (shelterDoor && !shelter) {
        // The server may close the door just before we are preempted.
        shelter = HOME_SHELTER;
        const shut = await shelterDoor(ctx, false);
        if (!ctx.signal?.aborted && (shut != null && !isComplete(shut) || home()?.inside !== true)) shelter = null;
        if (shut != null) return shut;
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
      return wait(ctx);
    },
  };
  behavior.onDeath = behavior.dispose = () => { enclosure = null; reset(); };
  return behavior;
}

module.exports = { createNightRest, isDaylight, nightBudget, nightShelter, travelTicks };
