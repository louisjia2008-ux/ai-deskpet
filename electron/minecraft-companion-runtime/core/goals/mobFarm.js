'use strict';
// Goal: dig the underground mob farm (blueprints/mobFarm.js) and collect
// `count` mob drops that came down its shaft.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet                    -> choose solid ground near the bot
//   2. still above the shaft:
//      a stairs, room or channel cell -> dig it (never the block underfoot)
//      b a water source missing       -> pour it
//      c otherwise                    -> stand on the hole and dig the block underfoot
//   3. in the shaft                   -> dig the block underfoot, one block at a time
//   4. at the bottom                  -> dig the alcove, step into it, dig and place
//                                        the chest and the hopper
//   5. otherwise                      -> wait in the alcove, empty the chest
// Only mob drops gained after the goal started count.

const { findDeviceSite, LIQUID, isAir, isSolid, partMatches, guardDeviceCells, standingAt, goToStand, adoptDeviceSite, placeDevicePart, finishDevicePart, digFromBeside, stepBeside, TUNNEL: DIGGABLE, validDeviceLayers } = require('./device-site');
const { vec: v, posKey: key } = require('../blacklist');
const { factsOf } = require('../action-result');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createMobFarm } = require('../blueprints/mobFarm');
const { waitUntil, sleep, abortError } = require('../confirm');

const MOB_DROPS = new Set(['rotten_flesh', 'bone', 'arrow', 'gunpowder', 'string', 'spider_eye', 'ender_pearl']);
// Mobs come one every few tens of seconds; the chest is emptied about as often.
const COLLECT_WAIT_MS = 20000;


function evaluateMobFarmSite(blockAt, anchor, facing) {
  const farm = createMobFarm(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  // The ground's top at the hole and at the stairs' exit, open air above both.
  const exit = farm.stairs[0];
  for (const p of [farm.anchor, exit]) {
    if (!isSolid(at(p)) || !isAir(at({ ...p, y: p.y + 1 }))) return null;
  }
  const tunnel = [...farm.stairs, ...farm.room, ...farm.channels, ...farm.shaft, ...farm.bottom];
  return validDeviceLayers(blockAt, [tunnel, b => DIGGABLE.test(b?.name || '')], [farm.solid, isSolid]) ? farm : null;
}

/** Nearest spot with solid rock all the way down; the anchor is the ground's top block above the hole. */
function chooseMobFarmSite(blockAt, around, { radius = 6 } = {}) {
  return findDeviceSite(blockAt, around, { radius, step: 2, soft: block => isAir(block) || block.boundingBox === 'empty', evaluate: evaluateMobFarmSite });
}

function createMobFarmGoal({ bot, anchor = null, facing = 'east', count = 4,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { farm: anchor ? createMobFarm(anchor, facing) : null, baseline: null, taken: 0, lastCheck: 0, guarded: false };
  const blockAt = (p) => bot.blockAt(v(p));
  const partOk = part => partMatches(blockAt, part);
  const drops = () => actions.countItems(bot, (n) => MOB_DROPS.has(n));
  const gained = () => (memory.baseline === null ? 0 : Math.max(0, drops() - memory.baseline));
  const dug = (p) => isAir(blockAt(p)) || LIQUID.has(blockAt(p)?.name);

  const guardFarm = () => memory.farm && guardDeviceCells(bot, memory, () => {
    const { channels, solid, parts } = memory.farm;
    return { step: channels, breaks: [...solid, ...parts.map(p => p.position)] };
  }, 20);

  function inspect() {
    const f = memory.farm;
    const partAt = new Map(f.parts.map((p) => [key(p.position), p]));
    const upper = [...f.stairs, ...f.room, ...f.channels].find((p) => !dug(p)) || null;
    const water = f.water.find((p) => !skills.isFluidSource(blockAt(p), 'water')) || null;
    const shaft = f.shaft.find((p) => !dug(p)) || null;
    const bottom = f.bottom.find((p) => {
      if (dug(p)) return false;
      const part = partAt.get(key(p));
      return !part || blockAt(p)?.name !== part.block;
    }) || null;
    const nextPart = f.parts.find((p) => !partOk(p)) || null;
    const done = [...f.stairs, ...f.room, ...f.channels, ...f.shaft].filter(dug).length
      + f.water.length - f.water.filter((p) => !skills.isFluidSource(blockAt(p), 'water')).length
      + f.parts.filter(partOk).length;
    return { upper, water, shaft, bottom, nextPart, done };
  }

  const feet = () => bot.entity.position.floored();
  const below = () => bot.entity.position.y < memory.farm.levels.feet - 1.5;
  const inColumn = (p) => feet().x === p.x && feet().z === p.z;
  const inStand = () => standingAt(bot, memory.farm.cells.stand);

  function dig(ctx, p) {
    return digFromBeside(bot, ctx, actions, blockAt, p, () => stepBeside(blockAt, p, [0], async c => {
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(c.x, c.y, c.z), { timeoutMs: 8000 });
      return moved.ok && !inColumn(p);
    }));
  }

  // Standing in the shaft's column: dig the next block underfoot and drop onto the one below it.
  async function digDown(ctx) {
    const under = { ...feet(), y: feet().y - 1 };
    if (dug(under)) {
      await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
      return { ok: true };
    }
    const result = await actions.digBlock(bot, ctx, blockAt(under));
    if (result.ok) await waitUntil(() => bot.entity.onGround && feet().y === under.y, { timeoutMs: 2000, signal: ctx.signal });
    return result;
  }

  // Recover only the unfinished collector cell, without chasing animals or
  // treating a successful attack packet as a cleared placement cell.
  async function clearCollectorBat(ctx, position) {
    const target = v(position);
    const overlaps = (entity) => entity && defaultSkills.entityInside({ entities: { target: entity } }, target);
    const candidate = (entity) => entity?.name === 'bat' && entity.isValid !== false && overlaps(entity);
    if (typeof bot.attack !== 'function' || typeof bot.lookAt !== 'function'
      || typeof bot.entityAtCursor !== 'function' || typeof bot.world?.raycast !== 'function') return false;
    const eye = () => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
    const aim = (entity) => entity.position.offset(0, (entity.height || 0.9) / 2, 0);
    const near = (entity) => candidate(entity) && eye().distanceTo(aim(entity)) <= 3;
    const bat = Object.values(bot.entities).filter(near)
      .sort((a, b) => eye().distanceTo(aim(a)) - eye().distanceTo(aim(b)))[0];
    if (!bat) return false;
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    await bot.lookAt(aim(bat), true);
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    // Re-read after aiming: the bat may already have left, or another creature
    // may stand in the ray. The native cursor must still identify this bat.
    const current = bot.entities[bat.id];
    if (!near(current)) return false;
    const start = eye();
    const delta = aim(current).minus(start);
    const distance = delta.norm();
    if (distance === 0 || bot.world.raycast(start, delta.scaled(1 / distance), distance)
      || bot.entityAtCursor(3)?.id !== current.id) return false;
    bot.attack(current);
    ctx.record('mob_collector_clear', { target: key(position), entity: current.id, action: 'hit_bat' });
    // Exactly one native hit per recovery, with the ordinary sword cooldown.
    // No synthetic kill/drop/progress credit is granted, even if it vanishes.
    await sleep(625, ctx.signal);
    return !defaultSkills.entityInside(bot, target);
  }

  async function collect(ctx) {
    const f = memory.farm;
    const stood = await goToStand(bot, ctx, actions, f.cells.stand, 15000);
    if (!stood.ok) return stood;
    const before = gained();
    const wait = memory.lastCheck + COLLECT_WAIT_MS - Date.now();
    if (wait > 0) await waitUntil(() => gained() > before, { timeoutMs: wait, signal: ctx.signal });
    if (gained() > before) {
      ctx.record('mob_drops', { gained: gained() });
      return { ok: true };
    }
    memory.lastCheck = Date.now();
    const result = await skills.takeItems(bot, ctx, { position: f.cells.chest, itemMatch: (n) => MOB_DROPS.has(n) });
    if (result.ok) memory.taken += factsOf(result).taken;
    // Hostile mobs in the bot's view, to tell a farm that spawns nothing from one that drops nothing.
    const mobs = Object.values(bot.entities).filter((e) => e.type === 'hostile').length;
    ctx.record('mob_drops', { gained: gained(), taken: memory.taken, reason: result.reason, mobs });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'chest_empty' ? 'no_mobs_yet' : result.reason };
  }

  return {
    name: 'mob_farm',
    memory,
    // Mobs come at their own pace once the farm is dug.
    noProgressLimit: 40,
    isDone: () => Boolean(memory.farm) && inspect().nextPart === null && gained() >= count,
    progress: () => (memory.farm ? inspect().done + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = drops();
      if (!adoptDeviceSite(bot, ctx, memory, 'farm', chooseMobFarmSite)) return { ok: false, reason: 'no_site' };
      guardFarm();
      const f = memory.farm;
      const s = inspect();

      if (!below()) {
        if (s.upper) return dig(ctx, s.upper);
        if (s.water) return skills.pourLiquid(bot, ctx, s.water, 'water');
        const top = { ...f.cells.hole, y: f.levels.feet };
        if (!inColumn(top) || Math.abs(bot.entity.position.y - top.y) > 0.5) {
          const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(top.x, top.y, top.z), { timeoutMs: 30000 });
          if (!inColumn(top)) return moved.ok ? { ok: false, reason: 'not_on_hole' } : moved;
        }
        return digDown(ctx);
      }
      if (s.shaft && inColumn(f.cells.hole)) return digDown(ctx);
      if (s.bottom) {
        const c = f.cells;
        // The alcove is dug from the shaft's bottom; the rest from inside the alcove.
        if ((s.bottom === c.alcoveHead || s.bottom === c.stand) || inStand()) return dig(ctx, s.bottom);
        return goToStand(bot, ctx, actions, c.stand, 15000);
      }
      if (s.nextPart) {
        const part = s.nextPart;
        if (!isAir(blockAt(part.position))) return dig(ctx, part.position); // wrong block or facing
        const place = () => placeDevicePart(bot, ctx, skills, part, () => partOk(part), { sneak: Boolean(part.sneak) });
        let result = await place();
        if (part.key === 'hopper' && result.reason === 'cell_occupied_by_entity'
          && await clearCollectorBat(ctx, part.position)) result = await place();
        return finishDevicePart(ctx, blockAt, part, result);
      }
      return collect(ctx);
    },
  };
}

module.exports = { createMobFarmGoal, chooseMobFarmSite, evaluateMobFarmSite, MOB_DROPS };
