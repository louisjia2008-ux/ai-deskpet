'use strict';
// Goal: build a cobblestone generator (blueprints/cobbleGenerator.js) and prove
// it works by mining `harvest` cobblestone that it regenerated.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet           -> choose flat, solid ground near the bot
//   2. a seal cell is open   -> fill it with a stable, non-flammable block
//   3. an open cell is solid -> dig it out
//   4. no water source       -> pour the water bucket
//   5. no lava source        -> pour the lava bucket (only once the pit holds water)
//   6. device works          -> stand in S, mine C, see it come back
// The only memory kept across runs is the site and the harvest count, which
// counts only cobblestone seen regenerating in C and arriving in the inventory.

const { findDeviceSite, LIQUID, isAir, isSoft, partMatches, guardDeviceCells, adoptDeviceSite, digDeviceCell, stepOffDevice, placeDevicePart, finishDevicePart, TERRAIN: DIGGABLE, swimOutOfDevice, validDeviceLayers } = require('./device-site');
const { posKey: key } = require('../blacklist');
const { factsOf, isComplete } = require('../action-result');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createCobbleGenerator } = require('../blueprints/cobbleGenerator');
const { sleep, waitUntil } = require('../confirm');
const { deviceTargets, clearTerrain } = require('../target-recovery');
const { stableSolid } = require('../materials');

const REGENERATE_MS = 5000;

// Lava burns flammable neighbours away (with fire ticks on), opening the seal.
const FLAMMABLE = /(_log|_wood|_stem|_hyphae|_leaves|_planks|_wool|_carpet|_slab|_stairs|_fence|bookshelf|hay_block|scaffolding|tnt|bamboo|dried_kelp_block|target|beehive|bee_nest|moss_block|coal_block)$/;
const isSeal = (block) => stableSolid(block) && !FLAMMABLE.test(block.name);

/**
 * Scores a generator at `anchor` facing `facing`; null when it cannot be built
 * without terraforming. `blockAt(x, y, z)` returns null for unloaded chunks.
 */
function evaluateGeneratorSite(blockAt, anchor, facing, options = {}) {
  const device = createCobbleGenerator(anchor, facing, options);
  const at = (p) => blockAt(p.x, p.y, p.z);
  let fixes = 0;
  if (!validDeviceLayers(blockAt, [[...device.open, ...device.parts.map(part => part.position)], b => b && DIGGABLE.has(b.name)])) return null;
  for (const p of device.seal) {
    const block = at(p);
    if (!block || LIQUID.has(block.name)) return null;
    if (isSeal(block)) continue;
    if (!isSoft(block)) return null;
    fixes += 1;
  }
  if (!validDeviceLayers(blockAt, [device.clearAbove, b => b && isSoft(b)])) return null;
  return { device, fixes };
}

/** Nearest buildable spot around `around`; `avoid(p)` rules out cells that belong to something else (the house). */
function chooseGeneratorSite(blockAt, around, { radius = 10, collector = false, avoid = null } = {}) {
  const site = findDeviceSite(blockAt, around, { radius, avoidFeet: true, cost: value => value.fixes * 4,
    evaluate: (read, anchor, facing) => evaluateGeneratorSite(read, anchor, facing, { collector }),
    accept: avoid && (value => !footprint(value.device).some(avoid)),
  });
  return site?.device ?? null;
}

// Every cell the device digs, seals or keeps clear.
const footprint = (device) => [...device.open, ...device.seal, ...device.clearAbove, ...device.parts.map((part) => part.position)];

// GoalXZ resolves as soon as the horizontal coordinate matches, including
// while falling into the work pit. Wait for a standable, settled body before
// interpreting that early completion as a failed arrival.
async function enterStand(bot, ctx, stand, actions = defaultActions) {
  const inColumn = () => Math.floor(bot.entity.position.x) === stand.x && Math.floor(bot.entity.position.z) === stand.z;
  const inStand = () => inColumn() && Math.abs(bot.entity.position.y - stand.y) < 0.5 && bot.entity.onGround !== false;
  if (inStand()) return { ok: true };
  const moved = await actions.goTo(bot, ctx, new goals.GoalXZ(stand.x, stand.z), { timeoutMs: 30000, arrived: inStand });
  if (inStand()) return { ok: true };
  if (inColumn() && (moved.ok || moved.reason === 'not_arrived')) {
    if (await waitUntil(inStand, { timeoutMs: 1500, signal: ctx.signal })) return { ok: true };
  }
  return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
}

function createCobbleGeneratorGoal({ bot, anchor = null, facing = 'east', harvest = 8, collector = false, avoid = null,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(harvest) || harvest < 1) throw new TypeError('harvest must be a positive integer');
  const memory = {
    device: anchor ? createCobbleGenerator(anchor, facing, { collector }) : null,
    harvested: 0,
    regenerated: 0,
    guarded: false,
  };
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const targets = deviceTargets(bot, actions, 'cobble_generator', memory);

  // The pathfinder must never walk into the liquid cells or C (lava flows in
  // behind a mined cobblestone), nor break the seal while routing.
  const guardDevice = () => memory.device && guardDeviceCells(bot, memory, () => {
    const { seal, cells, parts } = memory.device;
    const withAbove = p => [p, { ...p, y: p.y + 1 }];
    const collector = new Set(parts.flatMap(part => withAbove(part.position)).map(key));
    return { step: liquidCells().flatMap(withAbove), breaks: [...seal, cells.cobble],
      extra: position => collector.has(key(position)) && parts.some(part => !partOk(part)) };
  });

  const liquidCells = () => {
    const c = memory.device.cells;
    return [c.lava, c.cobble, c.pitTop, c.pitBottom, c.water];
  };

  const partOk = part => partMatches(blockAt, part);

  // In one of L, C, P or W, or standing on one (and about to dig it out), or
  // above a collector part still to be dug out or placed.
  function trappedCell() {
    const feet = bot.entity.position.floored();
    const pending = memory.device.parts.filter((part) => !partOk(part)).map((part) => part.position);
    return [...liquidCells(), ...pending].find((p) => feet.x === p.x && feet.z === p.z && feet.y >= p.y && feet.y <= p.y + 1) || null;
  }

  // Out of the pit or off a cell: swim up through the pit's water, otherwise
  // walk off, otherwise the generic unstick (which may pillar out of a dry pit).
  async function stepOff(ctx) {
    const cell = trappedCell();
    if (!cell) return { ok: true };
    const surfaceY = memory.device.anchor.y + 1;
    if (bot.entity.position.y < surfaceY - 0.5 && bot.entity.isInWater) {
      const exit = memory.device.cells.stand;
      await swimOutOfDevice(bot, ctx, new Vec3(exit.x + 0.5, surfaceY + 1.6, exit.z + 0.5), () => !trappedCell());
      if (!trappedCell()) return { ok: true };
    }
    const away = new goals.GoalInvert(new goals.GoalNear(cell.x, surfaceY, cell.z, 1));
    return stepOffDevice(bot, ctx, actions, away, trappedCell, { from: key(cell) });
  }

  function inspect() {
    const d = memory.device;
    if (!d) return null;
    const c = d.cells;
    const lava = skills.isFluidSource(blockAt(c.lava), 'lava');
    const water = skills.isFluidSource(blockAt(c.water), 'water');
    const openSeal = d.seal.filter((p) => !isSeal(blockAt(p)));
    const accepts = (p, name) => {
      if (isAir({ name })) return true;
      if (p === c.lava) return name === 'lava';
      if (p === c.water || p === c.pitTop || p === c.pitBottom) return name === 'water';
      if (p === c.cobble) return (lava && name === 'cobblestone') || name === 'lava';
      return false; // the standing cell stays empty
    };
    const toDig = d.open.filter((p) => { const b = blockAt(p); return b && !accepts(p, b.name); });
    const headBlocked = !isSoft(blockAt(c.head));
    const pitWater = blockAt(c.pitBottom)?.name === 'water';
    const nextPart = d.parts.find((part) => !partOk(part)) || null;
    const working = lava && water && pitWater && openSeal.length === 0 && toDig.length === 0 && !nextPart;
    return { lava, water, pitWater, openSeal, toDig, headBlocked, nextPart, working };
  }

  function progressOf() {
    const s = inspect();
    if (!s) return 0;
    const d = memory.device;
    const built = (d.seal.length - s.openSeal.length) + (d.open.length - s.toDig.length)
      + d.parts.filter(partOk).length + (s.water ? 1 : 0) + (s.lava ? 1 : 0);
    return built + memory.regenerated + memory.harvested;
  }

  // Exactly into S: from the surface next to it the drop is out of pickup range.
  async function goToStand(ctx) {
    const c = memory.device.cells;
    const stand = new Vec3(c.stand.x, c.stand.y, c.stand.z);
    // Standing on the collector chest (0.875 high) puts the feet just below S.
    const moved = await enterStand(bot, ctx, stand, actions);
    if (moved.ok) return moved;
    ctx.record('stand_unreached', { reason: moved.reason, at: bot.entity.position.toString(),
      stand: stand.toString(), cells: Object.fromEntries(Object.entries(c).map(([k, p]) => [k, blockAt(p)?.name])) });
    return moved;
  }

  async function harvestOnce(ctx) {
    const c = memory.device.cells;
    const moved = await goToStand(ctx);
    if (!moved.ok) return moved;
    let block = blockAt(c.cobble);
    if (block?.name !== 'cobblestone') {
      // Just mined (by us or someone else): lava needs about 1.5 s to flow back.
      const back = await waitUntil(() => blockAt(c.cobble)?.name === 'cobblestone', { timeoutMs: REGENERATE_MS, signal: ctx.signal });
      if (!back) return { ok: false, reason: 'no_regeneration' };
      block = blockAt(c.cobble);
    }
    if (memory.device.collector && (memory.regenerated >= memory.harvested + 4 || memory.regenerated >= harvest)) {
      // Empty the collector chest under S now and then; the hopper fills it.
      const taken = await skills.takeItems(bot, ctx, { position: c.collectorChest, itemMatch: (n) => n === 'cobblestone' });
      if (taken.ok) memory.harvested += factsOf(taken).taken;
      ctx.record('generator_collect', { ok: taken.ok, reason: taken.reason, harvested: memory.harvested });
      if (taken.ok || memory.harvested >= harvest) return taken;
    }
    const before = actions.countItems(bot, (n) => n === 'cobblestone');
    const dug = await actions.digBlock(bot, ctx, block);
    if (!dug.ok) return dug;
    // The drop lands at the bot's feet; it is picked up without moving (10-tick delay).
    const back = await waitUntil(() => blockAt(c.cobble)?.name === 'cobblestone', { timeoutMs: REGENERATE_MS, signal: ctx.signal });
    if (back) memory.regenerated += 1;
    if (memory.device.collector) {
      ctx.record('generator_harvest', { regenerated: back, count: memory.regenerated });
      return back ? { ok: true } : { ok: false, reason: 'no_regeneration' };
    }
    const got = actions.countItems(bot, (n) => n === 'cobblestone') > before
      || await waitUntil(() => actions.countItems(bot, (n) => n === 'cobblestone') > before, { timeoutMs: 1000, signal: ctx.signal });
    if (got && back) memory.harvested += actions.countItems(bot, (n) => n === 'cobblestone') - before;
    ctx.record('generator_harvest', { picked: got, regenerated: back, harvested: memory.harvested,
      at: bot.entity.position.floored().toString() });
    if (!back) return { ok: false, reason: 'no_regeneration' };
    return got ? { ok: true } : { ok: false, reason: 'drop_not_collected' };
  }

  // Items still to be brought for the parts not yet in the world, as
  // knowledge keys; before a site is chosen, everything a site may take.
  function needs() {
    const s = inspect();
    if (!s) {
      const probe = createCobbleGenerator({ x: 0, y: 0, z: 0 }, 'east', { collector });
      return [{ key: 'water_bucket', count: 1 }, { key: 'lava_bucket', count: 1 }, { key: 'filler', count: Math.min(probe.seal.length, 12) },
        ...probe.parts.map((part) => ({ key: part.block, count: 1 })), { key: 'pickaxe', count: 1 }];
    }
    // Mined by hand, cobblestone drops nothing: after a death the harvest
    // would regenerate forever with an empty collector chest.
    const list = memory.harvested < harvest ? [{ key: 'pickaxe', count: 1 }] : [];
    if (!s.water) list.push({ key: 'water_bucket', count: 1 });
    if (!s.lava) list.push({ key: 'lava_bucket', count: 1 });
    if (s.openSeal.length) list.push({ key: 'filler', count: s.openSeal.length });
    for (const part of memory.device.parts) if (!partOk(part)) list.push({ key: part.block, count: 1 });
    return list;
  }

  return {
    name: 'cobble_generator',
    memory,
    needs,
    noProgressLimit: 8,
    isDone: () => Boolean(inspect()?.working) && memory.harvested >= harvest,
    progress: progressOf,
    async run(ctx) {
      if (!adoptDeviceSite(bot, ctx, memory, 'device', chooseGeneratorSite,
        { collector, avoid: q => avoid?.(q) || bot.companionPlayerBlock?.(q) || targets.avoids(ctx, q) })) return { ok: false, reason: 'no_site' };
      guardDevice();
      const s = inspect();
      const d = memory.device;
      const dry = !anchor && liquidCells().every(p => {
        const b = blockAt(p);
        return b && !['lava', 'water'].includes(b.name);
      });
      const relocation = dry ? footprint(d) : null;
      const trapped = trappedCell();
      if (trapped) return targets.run(ctx, 'step_off', trapped, () => stepOff(ctx), { relocate: relocation });

      if (s.openSeal.length) {
        const p = s.openSeal[0];
        const place = () => skills.placeAt(bot, ctx, p, 'filler');
        return targets.run(ctx, 'seal', p, place, { relocate: relocation });
      }
      if (s.toDig.length || s.headBlocked) {
        const target = s.toDig[0] || d.cells.head;
        return targets.run(ctx, 'dig', target,
          () => digDeviceCell(bot, ctx, actions, blockAt(target)), { relocate: relocation });
      }
      if (s.nextPart) {
        const part = s.nextPart;
        return finishDevicePart(ctx, blockAt, part, targets.run(ctx, 'part', part.position, () => {
          if (!isAir(blockAt(part.position))) return digDeviceCell(bot, ctx, actions, blockAt(part.position));
          return placeDevicePart(bot, ctx, skills, part, () => partOk(part), { sneak: Boolean(part.sneak) });
        }, { cells: [part.against], tag: `${part.block}:${d.facing}`, relocate: relocation }));
      }
      if (!s.water) return targets.run(ctx, 'pour_water', d.cells.water, () => skills.pourLiquid(bot, ctx, d.cells.water, 'water'),
        { cells: d.seal, relocate: relocation });
      if (!s.pitWater) {
        // Flowing water takes a few ticks to fill the pit.
        return targets.run(ctx, 'pit_water', d.cells.pitBottom, async () => {
          const filled = await waitUntil(() => blockAt(d.cells.pitBottom)?.name === 'water', { timeoutMs: 3000, signal: ctx.signal });
          return filled ? { ok: true } : { ok: false, reason: 'pit_not_filled' };
        }, { cells: [d.cells.water, d.cells.pitTop], recover: async (reason) => {
          const repair = await clearTerrain(bot, ctx, actions, d.cells.pitTop);
          return repair.ok ? repair : { ok: false, reason };
        } });
      }
      if (!s.lava) {
        const result = await targets.run(ctx, 'pour_lava', d.cells.lava, () => skills.pourLiquid(bot, ctx, d.cells.lava, 'lava'), { cells: d.seal });
        if (isComplete(result)) await sleep(500, ctx.signal);
        return result;
      }
      return targets.run(ctx, 'stand_harvest', d.cells.stand, () => harvestOnce(ctx), { cells: [d.cells.cobble] });
    },
  };
}

module.exports = { createCobbleGeneratorGoal, chooseGeneratorSite, evaluateGeneratorSite, enterStand };
