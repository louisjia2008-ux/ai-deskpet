'use strict';
// Goal: dig a small pond (blueprints/fishPond.js) and fish from its edge until
// `count` catches are in the inventory.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet              -> choose flat, solid ground near the bot
//   2. a pond cell is filled    -> dig it out (stepping off it first)
//   3. a water cell is dry      -> pour a water bucket; the other two cells
//                                  then become sources between them
//   4. otherwise                -> stand on the edge, cast and wait for a bite
// A catch counts once the reeled-in item is in the inventory.

const { layeredDeviceSite, LIQUID, isAir, isSoft, isSolid, goToStand, adoptDeviceSite, digDeviceCell } = require('./device-site');
const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createFishPond } = require('../blueprints/fishPond');
const { waitUntil, runCancellable } = require('../confirm');

// A bite comes 5 to 30 s after the bobber lands (faster with Lure).
const BITE_TIMEOUT_MS = 45000;

// Pond cells are dug out: only plain soil or stone. Soil picked up late is never a catch.
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'moss_block',
  'stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'clay', 'terracotta', 'deepslate', 'tuff']);
const v = (p) => new Vec3(p.x, p.y, p.z);

const { evaluate: evaluatePondSite, choose: choosePondSite } = layeredDeviceSite(createFishPond, pond => [
  [[...pond.floor, ...pond.rim], isSolid], [pond.pond, b => isAir(b) || b?.name === 'water' || DIGGABLE.has(b?.name)],
  [pond.clear, isSoft],
], { radius: 8 });

function createFishingGoal({ bot, anchor = null, facing = 'east', count = 5,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { pond: anchor ? createFishPond(anchor, facing) : null, catches: 0, casts: 0, caught: {} };
  const blockAt = (p) => bot.blockAt(v(p));
  const isSource = (p) => skills.isFluidSource(blockAt(p), 'water');

  const inspect = () => {
    const p = memory.pond;
    return {
      dig: p.pond.find((c) => !isAir(blockAt(c)) && !LIQUID.has(blockAt(c)?.name)) || null,
      dry: p.water.find((c) => !isSource(c)) || null,
      full: p.pond.every(isSource),
    };
  };

  const goStand = ctx => goToStand(bot, ctx, actions, memory.pond.cells.stand, 15000);

  async function cast(ctx) {
    const rod = bot.inventory.items().find((item) => item.name === 'fishing_rod');
    if (!rod) return { ok: false, reason: 'no_material', missing: [{ name: 'fishing_rod', short: 1 }] };
    const standing = await goStand(ctx);
    if (!standing.ok) return standing;
    const names = new Map(bot.inventory.items().map((item) => [item.name, item.count]));
    try {
      await bot.equip(rod, 'hand');
      await bot.lookAt(v(memory.pond.target), true);
      memory.casts += 1;
      // On timeout or preemption a second use of the rod reels the bobber in,
      // and the wait ends at once even if no bobber ever landed.
      let stop = null;
      await runCancellable(() => new Promise((resolve, reject) => { stop = reject; bot.fish().then(resolve, reject); }), {
        signal: ctx.signal, timeoutMs: BITE_TIMEOUT_MS, timeoutCode: 'no_bite',
        cancel: () => { bot.activateItem(); stop?.(new Error('reeled_in')); },
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (error.code === 'no_bite') return { ok: false, reason: 'no_bite' };
      return { ok: false, reason: 'cast_failed', message: error.message };
    }
    // Item by item: a rod that breaks on this catch leaves the inventory as the catch arrives.
    const newItems = () => bot.inventory.items()
      .filter((item) => item.name !== 'fishing_rod' && !DIGGABLE.has(item.name) && item.count > (names.get(item.name) || 0));
    const landed = await waitUntil(() => newItems().length > 0, { timeoutMs: 3000, signal: ctx.signal });
    if (!landed) return { ok: false, reason: 'catch_not_collected' };
    memory.catches += 1;
    for (const item of newItems()) {
      memory.caught[item.name] = (memory.caught[item.name] || 0) + item.count - (names.get(item.name) || 0);
    }
    ctx.record('fish_caught', { catches: memory.catches, casts: memory.casts, caught: memory.caught });
    return { ok: true };
  }

  return {
    name: 'fishing',
    memory,
    noProgressLimit: 8,
    isDone: () => memory.catches >= count,
    progress: () => {
      if (!memory.pond) return 0;
      const p = memory.pond;
      return p.pond.filter((c) => isAir(blockAt(c)) || LIQUID.has(blockAt(c)?.name)).length
        + p.pond.filter(isSource).length + memory.catches;
    },
    async run(ctx) {
      if (!adoptDeviceSite(bot, ctx, memory, 'pond', choosePondSite)) return { ok: false, reason: 'no_site' };
      const s = inspect();
      if (s.dig) {
        // Standing on a cell about to be dug drops the bot into the pond.
        const feet = bot.entity.position.floored();
        if (memory.pond.pond.some((c) => c.x === feet.x && c.y === feet.y - 1 && c.z === feet.z)) return goStand(ctx);
        return digDeviceCell(bot, ctx, actions, blockAt(s.dig));
      }
      if (s.dry) {
        // Both buckets in: the cells between the two sources fill by themselves.
        if (!bot.inventory.items().some((item) => item.name === 'water_bucket')) {
          if (await waitUntil(() => inspect().full, { timeoutMs: 3000, signal: ctx.signal })) return { ok: true };
          const spare = memory.pond.pond.find(isSource);
          if (!spare) return { ok: false, reason: 'no_material', missing: [{ name: 'water_bucket', short: 1 }] };
          return skills.scoopLiquid(bot, ctx, spare, 'water');
        }
        return skills.pourLiquid(bot, ctx, s.dry, 'water');
      }
      if (!s.full && !(await waitUntil(() => inspect().full, { timeoutMs: 3000, signal: ctx.signal }))) {
        return { ok: false, reason: 'pond_not_full' };
      }
      return cast(ctx);
    },
  };
}

module.exports = { createFishingGoal, choosePondSite, evaluatePondSite };
