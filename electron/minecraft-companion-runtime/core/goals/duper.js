'use strict';
// Shared goal for button-driven duplicators (carpet, rail): build the device
// from its blueprint, then press its button until `count` new items of the
// product are in the inventory.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet             -> choose flat, solid ground near the bot
//   2. a hollow cell is filled -> dig it out (slime must not touch the ground)
//   3. a part is missing/wrong -> dig the wrong block, or place the part
//                                 (facings checked on the server's block state)
//   4. items lying nearby      -> pick them up
//   5. otherwise               -> stand by the button and press it once
// Only products gained beyond the seed item (placed as a part) count.
//
// A blueprint returns { kind, anchor, facing, parts, floor, clear, hollow,
// cells: { stand, button, buttonAim?, drop }, noStep }. A floor button is aimed
// at just above its cell's floor; a wall button at `buttonAim`.

const { findDeviceSite, LIQUID, isAir, isSoft, partMatches, guardDeviceCells, goToStand, adoptDeviceSite, digDeviceCell, placeDevicePart, finishDevicePart, validDeviceLayers } = require('./device-site');
const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { sleep, waitUntil } = require('../confirm');

// A stone button stays pressed 20 ticks; the sticky piston then pulls the slime back.
const CYCLE_MS = 1600;
// Hollow cells are dug out: only plain soil or stone.
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'moss_block',
  'stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'clay', 'terracotta', 'deepslate', 'tuff']);

const isFloor = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name)
  && !/^(sand|red_sand|gravel|.*_concrete_powder)$/.test(block.name);
const { droppedItemName: droppedName } = defaultActions;
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateDeviceSite(create, blockAt, anchor, facing) {
  const device = create(anchor, facing);
  return validDeviceLayers(blockAt, [device.floor, isFloor], [device.clear, isSoft],
    [device.hollow || [], b => isAir(b) || DIGGABLE.has(b?.name)]) ? device : null;
}

/** Nearest flat spot for `create(anchor, facing)`; the anchor is a ground block. */
function chooseDeviceSite(create, blockAt, around, { radius = 8 } = {}) {
  return findDeviceSite(blockAt, around, { radius, avoidFeet: true, evaluate: evaluateDeviceSite.bind(null, create) });
}

function createDuperGoal({ bot, name, create, product, seedKey, pickup = (n) => n === product, anchor = null,
  facing = 'east', count = 8, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { device: anchor ? create(anchor, facing) : null, baseline: null, presses: 0, misses: new Map() };
  const blockAt = (p) => bot.blockAt(v(p));
  const partOk = part => partMatches(blockAt, part);
  const owned = () => actions.countItems(bot, (n) => n === product);
  // The seed item leaves the inventory when it is placed; it is not a gain.
  const gained = () => {
    if (memory.baseline === null) return 0;
    const seedPlaced = memory.device && partOk(memory.device.parts.find((p) => p.key === seedKey)) ? 1 : 0;
    return Math.max(0, owned() + seedPlaced - memory.baseline);
  };
  // Never dig a part, and keep off the cells the blueprint marks (a fan has no
  // collision but the carpet above it blocks the head, so a path there stalls).
  const guardDevice = () => memory.device && guardDeviceCells(bot, memory, () => {
    return { step: memory.device.noStep || [], breaks: memory.device.parts.map(p => p.position) };
  });

  const inspect = () => {
    const d = memory.device;
    const hollowCells = d.hollow || [];
    const hollow = hollowCells.find((p) => !isAir(blockAt(p))) || null;
    return { hollow, nextPart: d.parts.find((p) => !partOk(p)) || null,
      built: d.parts.filter(partOk).length + hollowCells.filter((p) => isAir(blockAt(p))).length };
  };
  // Drops the bot already failed to reach twice are left alone, so they never
  // hold up the next press.
  const drops = () => Object.values(bot.entities).filter((e) => e.name === 'item' && e.position
    && e.position.distanceTo(v(memory.device.cells.drop)) < 6 && pickup(droppedName(e))
    && (memory.misses.get(e.id) || 0) < 2);
  const lying = () => drops().length > 0;

  // Items land on the ground around the device (some under the slime row,
  // picked up from the next cell) and on top of it (reached over the bridge).
  async function collect(ctx) {
    const before = actions.countItems(bot, pickup);
    const deadline = Date.now() + 15000;
    const near = (e) => e.position.distanceTo(bot.entity.position);
    for (const drop of drops().sort((a, b) => near(a) - near(b))) {
      if (Date.now() >= deadline) break;
      if (!bot.entities[drop.id]) continue;
      await actions.goNear(bot, ctx, drop.position.clone(), 1, { timeoutMs: Math.min(6000, Math.max(1000, deadline - Date.now())) });
      const taken = await waitUntil(() => !bot.entities[drop.id], { timeoutMs: 800, signal: ctx.signal });
      if (!taken) memory.misses.set(drop.id, (memory.misses.get(drop.id) || 0) + 1);
    }
    const left = drops();
    if (left.length && actions.countItems(bot, pickup) <= before) {
      ctx.record(`${name}_drops_out_of_reach`, { items: left.map((e) => ({ name: droppedName(e),
        x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2), z: +e.position.z.toFixed(2) })) });
    }
    return actions.countItems(bot, pickup) > before ? { ok: true } : { ok: false, reason: 'drops_not_collected' };
  }

  async function press(ctx) {
    const d = memory.device;
    const stood = await goToStand(bot, ctx, actions, d.cells.stand, 15000);
    if (!stood.ok) return stood;
    const before = gained();
    const button = blockAt(d.cells.button);
    try {
      await bot.lookAt(v(d.cells.buttonAim || { ...d.cells.button, y: d.cells.button.y + 0.1 }).offset(0.5, 0, 0.5), true);
      await bot.activateBlock(button);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ok: false, reason: 'press_failed' };
    }
    memory.presses += 1;
    await sleep(CYCLE_MS, ctx.signal);
    await waitUntil(() => gained() > before || lying(), { timeoutMs: 1000, signal: ctx.signal });
    ctx.record(`${name}_press`, { presses: memory.presses, gained: gained() });
    // Whatever flew out is picked up next run.
    return gained() > before || lying() ? { ok: true } : { ok: false, reason: `no_${product}_this_press` };
  }

  return {
    name,
    memory,
    noProgressLimit: 12,
    isDone: () => Boolean(memory.device) && !inspect().hollow && inspect().nextPart === null && gained() >= count,
    progress: () => (memory.device ? inspect().built + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = owned();
      if (!adoptDeviceSite(bot, ctx, memory, 'device', chooseDeviceSite.bind(null, create))) return { ok: false, reason: 'no_site' };
      guardDevice();
      const s = inspect();
      if (s.hollow) {
        return digDeviceCell(bot, ctx, actions, blockAt(s.hollow));
      }
      if (s.nextPart) {
        const part = s.nextPart;
        const current = blockAt(part.position);
        if (!isAir(current)) return digDeviceCell(bot, ctx, actions, current);
        return finishDevicePart(ctx, blockAt, part, placeDevicePart(bot, ctx, skills, part, () => partOk(part),
          { acceptItem: true, stand: part.stand }));
      }
      if (lying()) {
        const result = await collect(ctx);
        if (result.ok) return result;
      }
      return press(ctx);
    },
  };
}

module.exports = { createDuperGoal, chooseDeviceSite, evaluateDeviceSite };
