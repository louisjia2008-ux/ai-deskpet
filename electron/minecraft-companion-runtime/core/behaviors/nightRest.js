'use strict';
// Nights once the house is finished. The homestead goal handles its own
// nights while it builds; after that every other goal (a mining trip, a
// machine) would just carry on in the dark. This behavior outranks goals at
// night: walk home and sleep in the bed (which skips the night), or wait in
// the house if monsters are too close to sleep; caught far from home, dig in
// where the bot stands. Underground work (a branch mine) is left alone.
// With no house and nothing to do (a task just ended), it digs in where it is.

const { waiting, factsOf, isComplete } = require('../action-result');
const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep } = require('../confirm');

const dimensionOf = (bot) => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');

// Within this the bed is used straight away (useBed walks to it).
const NEAR_BED = 16;
const SEAL_PREPARE_START = 10800;
const SEAL_PREPARE_END = 12100;

/**
 * `home()` returns { bed, centre, inside? } once the house is finished (bed
 * null if it is gone), { bed: null, centre: null } to dig in in place, or null.
 */
function createNightRest({ bot, home, shelterDoor = null, enterShelter = null, prepareSeals = () => false,
  actions = defaultActions, skills = defaultSkills, now = Date.now,
  farDistance = 64, retryBedMs = 20000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  let bunker = null;
  let bedRefusedUntil = 0;
  let shutForSleep = false;

  const where = () => {
    try { return home(); } catch { return null; }
  };
  const needsSeal = state => state.isDay === true && state.timeOfDay >= SEAL_PREPARE_START && state.timeOfDay < SEAL_PREPARE_END
    && !state.sheltered && !state.inWater && state.onGround !== false && !state.hostiles?.some(e => e.distance <= 8)
    && prepareSeals() && defaultSkills.shelterSealCount(state.inventory) < 2 && !actions.underground?.(bot);

  const behavior = {
    name: 'night_rest',
    band: BAND.MAINTENANCE,
    want(state) {
      if (dimensionOf(bot) !== 'overworld') return 0;
      if (bunker) return 0.8;
      if (shutForSleep && state.isDay === true) return 0.8;
      if (needsSeal(state)) return 0.5;
      if (state.isDay !== false || state.sheltered) return 0;
      const spot = where();
      if (!spot) return 0;
      // The house roof also looks like "underground" to terrain detection.
      if (!spot.inside && typeof actions.underground === 'function' && actions.underground(bot)) return 0;
      return 0.8;
    },
    async run(ctx) {
      const state = ctx.perceive();
      if (shutForSleep && state.isDay === true) {
        const opened = await shelterDoor?.(ctx, true);
        if (opened?.ok !== false) shutForSleep = false;
        return opened || { ok: true };
      }
      if (bunker) {
        // Dug in only for want of anything to do: a task given meanwhile (the
        // owner asking to be followed) digs it out. It had sat sealed in while
        // the owner it was told to guard was killed twenty blocks away.
        if (state.isDay === false && where()) {
          await sleep(3000, ctx.signal);
          return waiting('sheltering_until_daylight');
        }
        ctx.record('night_rest', { action: 'dig_out' });
        const out = await skills.digOut(bot, ctx, bunker);
        if (isComplete(out)) {
          ctx.record('night_rest', { action: 'dug_out' });
          bunker = null;
          bot.companionSheltered = false;
        }
        return out;
      }
      if (needsSeal(state)) {
        const stock = await skills.prepareShelterSeal(bot, ctx);
        ctx.record('night_rest', { action: 'prepare_seal', ...stock });
        return stock;
      }
      const spot = where();
      if (!spot) return { ok: true };
      // No bed left (broken, not yet replaced): the house itself is the shelter.
      const anchor = spot.bed || spot.centre;
      const bed = anchor ? new Vec3(anchor.x + 0.5, anchor.y, anchor.z + 0.5) : null;
      const distance = bed ? bot.entity.position.distanceTo(bed) : Infinity;
      if (distance > farDistance) {
        ctx.record('night_rest', { action: 'dig_in', distance: Math.round(distance) });
        const dug = await skills.digIn(bot, ctx, { prepareSeal: prepareSeals() });
        if (!dug.ok) return dug;
        ctx.record('night_rest', { action: 'dug_in' });
        bunker = factsOf(dug).bunker;
        bot.companionSheltered = true;
        return { ok: true };
      }
      if (spot.inside === false && enterShelter) {
        const crossed = await enterShelter(ctx);
        if (crossed?.ok) return crossed;
      }
      if (spot.bed && now() >= bedRefusedUntil) {
        // Close by, the bed is walked to by using it: a walk to "near the bed"
        // could end outside the wall beside it, and the next night_rest found
        // it still too far and walked again, all night long.
        if (distance > NEAR_BED) {
          ctx.record('night_rest', { action: 'go_home', distance: Math.round(distance) });
          return actions.goNear(bot, ctx, bed, 2, { timeoutMs: 90000 });
        }
        ctx.record('night_rest', { action: 'sleep' });
        const slept = await skills.useBed(bot, ctx, { position: spot.bed });
        if (slept.ok) return slept;
        // The owner may have occupied the preferred bed while we approached.
        const otherBed = where()?.bed;
        if (otherBed && !bed.equals(new Vec3(otherBed.x + 0.5, otherBed.y, otherBed.z + 0.5))) {
          ctx.record('night_rest', { action: 'sleep', fallback: true });
          const other = await skills.useBed(bot, ctx, { position: otherBed });
          if (other.ok) return other;
        }
        // Monsters nearby: wait indoors for a while, then try the bed again.
        bedRefusedUntil = now() + retryBedMs;
      }
      const centre = new Vec3(spot.centre.x + 0.5, spot.centre.y, spot.centre.z + 0.5);
      if (spot.inside === false) {
        ctx.record('night_rest', { action: 'shelter' });
        return actions.goNear(bot, ctx, centre, 0, { timeoutMs: 40000, exact: true });
      }
      if (bot.entity.position.distanceTo(centre) > 2) {
        ctx.record('night_rest', { action: 'shelter' });
        return actions.goNear(bot, ctx, centre, 1, { timeoutMs: 40000 });
      }
      if (shelterDoor && !shutForSleep) {
        // A cancelled close may already have reached the server. Take
        // ownership before awaiting it so dawn can still reopen the door.
        shutForSleep = true;
        const shut = await shelterDoor(ctx, false);
        if (!shut?.ok && !ctx.signal?.aborted) shutForSleep = false;
        if (shut) return shut;
      }
      await sleep(3000, ctx.signal);
      return waiting('sheltering_until_daylight');
    },
  };
  const onDeath = () => { bunker = null; shutForSleep = false; };
  bot.on?.('death', onDeath);
  behavior.dispose = () => bot.removeListener?.('death', onDeath);
  return behavior;
}

module.exports = { createNightRest };
