'use strict';
// Wheat farming skills: pick plots by water, till, plant, harvest, gather
// seeds. Each function does one thing and confirms it against the world
// (the block that is there afterwards), like every other skill.

const { integerBox } = require('./geometry');
const { equipMatching } = require('./inventory');
const { Vec3 } = require('vec3');
const { fail, isComplete } = require('./action-result');
const actions = require('./actions');
const { clearCoverAt, pourLiquid } = require('./skills');
const { naturalCover, isWaterlogged } = require('./natural-cover');
const { SIDES, supports } = require('./home-topology');
const { ignoreUnlessAborted, waitUntil } = require('./confirm');
const { vec: v, posKey } = require('./blacklist');
const { ledgerFor, ledgerTarget, recordTarget } = require('./failure-ledger');

const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);
const RIPE = 7;

const irrigates = (b) => b && (/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name)
  || isWaterlogged(b));
const farmLevel = (waterY, centerY) => waterY >= centerY - 6 && waterY <= centerY + 2;
const horizontal = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);

function litPlot(read, p, crop = read({ ...p, y: p.y + 1 })) {
  if (!crop) return false;
  if (crop.skyLight >= 9) return true;
  for (let y = p.y + 2; y < 320; y++) {
    if (read({ ...p, y })?.boundingBox === 'block') return false;
  }
  return true;
}

/**
 * Up to `count` ground cells to farm near `center`. Vanilla keeps farmland
 * moist with water within 4 blocks on each horizontal axis, at its own level
 * or one above.
 */
function choosePlots(blockAt, center, { count = 16, radius = 24, exclude = () => false, findWater } = {}) {
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
  const usable = (p) => {
    if (distance(p) > radius) return false;
    const ground = blockAt(p);
    if (!ground || (!TILLABLE.has(ground.name) && ground.name !== 'farmland') || exclude(p)) return false;
    const above = blockAt({ ...p, y: p.y + 1 });
    return (naturalCover(above) || (ground.name === 'farmland' && above?.name === 'wheat')) && litPlot(blockAt, p, above);
  };
  const waters = (findWater?.(c, radius) ?? []).filter(w => farmLevel(w.y, c.y) && irrigates(blockAt(w)));
  const plots = new Map();
  const distance = (p) => horizontal(p, c);
  // Wheat already growing there (a farm left on an earlier task).
  const sown = (p) => blockAt(p)?.name === 'farmland' && blockAt({ ...p, y: p.y + 1 })?.name === 'wheat';
  for (const w of waters.sort((a, b) => distance(a) - distance(b))) {
    for (const [dx, dz] of integerBox([-4, 4], [-4, 4])) {
      for (const y of [w.y, w.y - 1]) {
        const p = { x: w.x + dx, y, z: w.z + dz };
        if (!plots.has(posKey(p)) && usable(p)) plots.set(posKey(p), { ...p, hydrated: true });
      }
    }
    if (plots.size >= count) break;
  }
  if (plots.size < count) {
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let y = c.y - 6; y <= c.y + 1; y++) {
      const p = { x: c.x + dx, y, z: c.z + dz };
      if (!plots.has(posKey(p)) && usable(p)) plots.set(posKey(p), { ...p, hydrated: false });
    }
  }
  const nearestWater = p => Math.min(...waters.map(w => horizontal(p, w)));
  return [...plots.values()]
    .sort((a, b) => (b.hydrated - a.hydrated) || (sown(b) - sown(a))
      || (!a.hydrated && nearestWater(a) - nearestWater(b)) || distance(a) - distance(b))
    .slice(0, count);
}

function findWater(bot, center, radius, localLevel = true) {
  return bot.findBlocks({ matching: irrigates, point: v(center), maxDistance: radius, count: localLevel ? 64 : 1,
    useExtraInfo: block => !localLevel || farmLevel(block.position.y, center.y) });
}

/**
 * The nearest open soil to `center` within `radius`, away from where raiders
 * were seen: the standing cell above it, a centre for choosePlots. A house
 * built on desert sand had none in reach of its centre, and the farm
 * explored back and forth by a pillager outpost for two hours.
 */
function findGround(bot, center, radius = 64, { fits = () => true } = {}) {
  const ids = [...TILLABLE, 'farmland'].map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  if (!ids.length || typeof bot.findBlocks !== 'function') return null;
  const danger = bot.companionDanger || [];
  const c = v(center);
  return bot.findBlocks({ matching: ids, point: c, maxDistance: radius, count: 256, useExtraInfo(block) {
    const p = block.position, read = q => bot.blockAt(v(q)), above = read(p.offset(0, 1, 0));
    return (naturalCover(above) || (above?.name === 'wheat' && block.name === 'farmland'))
      && naturalCover(read(p.offset(0, 2, 0))) && litPlot(read, p, above) && !danger.some(d => horizontal(d, p) < 32);
  } })
    .map(p => p.offset(0, 1, 0))
    // A lone patch of grass in the sand holds no farm: the nearest that fits one.
    .find(fits) || null;
}

/** What a plot needs next, read from the world. */
function plotState(bot, plot) {
  const ground = bot.blockAt(v(plot));
  const above = bot.blockAt(v(plot).offset(0, 1, 0));
  if (!ground || !above) return 'unknown';
  if (ground.name === 'farmland') {
    if (above.name === 'wheat') return Number(above.getProperties?.().age ?? 0) >= RIPE ? 'ripe' : 'growing';
    return naturalCover(above) ? 'empty' : 'blocked';
  }
  if (TILLABLE.has(ground.name)) return naturalCover(above) ? 'untilled' : 'blocked';
  return 'lost';
}

async function equip(bot, match) {
  if (!await equipMatching(bot, match)) return false;
  return bot.heldItem && match(bot.heldItem.name);
}

async function reach(bot, ctx, p) {
  if (actions.withinReach(bot, v(p).offset(0.5, 0.5, 0.5), 4)) return { ok: true };
  // Stand beside the plot, not on it: jumping onto farmland tramples it.
  const moved = await actions.goNear(bot, ctx, v(p).offset(0.5, 1, 0.5), 2, { timeoutMs: 30000 });
  return actions.withinReach(bot, v(p).offset(0.5, 0.5, 0.5), 4.5) ? { ok: true } : (moved.ok ? fail('out_of_reach') : moved);
}

/** Walks back towards the farm until its plots are in loaded chunks again. */
async function returnTo(bot, ctx, p) {
  const moved = await actions.goNear(bot, ctx, v(p).offset(0.5, 1, 0.5), 4, { timeoutMs: 60000 });
  return plotState(bot, p) === 'unknown' ? (moved.ok ? fail('farm_out_of_sight') : moved) : { ok: true };
}

async function irrigate(bot, ctx, plots) {
  const edge = plots.find(p => !p.hydrated && plotState(bot, p) === 'untilled' && !bot.companionPlayerBlock?.(p)
    && supports(bot.blockAt(v(p).offset(0, -1, 0))) && SIDES.every(([dx, dz]) => supports(bot.blockAt(v(p).offset(dx, 0, dz)))));
  if (!edge) return null;
  const approached = await reach(bot, ctx, edge);
  if (!approached.ok) return approached;
  const dug = await actions.digBlock(bot, ctx, bot.blockAt(v(edge)));
  return dug.ok ? pourLiquid(bot, ctx, edge, 'water') : dug;
}

async function tend(bot, ctx, plot, seed) {
  const ground = v(plot), crop = ground.offset(0, 1, 0);
  const match = seed ? n => n === seed : n => n.endsWith('_hoe');
  const missing = seed ? 'no_seeds' : 'no_hoe';
  if (bot.companionPlayerBlock?.(ground)) return fail('protected_player_block');
  const moved = await reach(bot, ctx, plot);
  if (!moved.ok) return moved;
  if (seed && !await equip(bot, match)) return fail(missing);
  const cleared = await clearCoverAt(bot, ctx, crop, { clearReplaceable: !seed });
  if (!cleared.ok) return cleared;
  if ((!bot.heldItem || !match(bot.heldItem.name)) && !await equip(bot, match)) return fail(missing);
  if (bot.companionPlayerBlock?.(ground)) return fail('protected_player_block');
  await ignoreUnlessAborted(async () => {
    await bot.lookAt(ground.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
  });
  const done = await waitUntil(() => bot.blockAt(seed ? crop : ground)?.name === (seed ? 'wheat' : 'farmland'),
    { timeoutMs: 1500, signal: ctx.signal });
  return done ? { ok: true } : fail(seed ? 'plant_unconfirmed' : 'till_unconfirmed');
}

const till = (bot, ctx, plot) => tend(bot, ctx, plot);
const plant = (bot, ctx, plot, seed = 'wheat_seeds') => tend(bot, ctx, plot, seed);

async function harvest(bot, ctx, plot) {
  const moved = await reach(bot, ctx, plot);
  if (!moved.ok) return moved;
  const crop = bot.blockAt(v(plot).offset(0, 1, 0));
  if (crop?.name !== 'wheat') return fail('no_crop');
  const before = actions.countItems(bot, (n) => n === 'wheat');
  const dug = await actions.digBlock(bot, ctx, crop);
  if (!dug.ok) return dug;
  await actions.collectDrops(bot, ctx, crop.position.offset(0.5, 0.5, 0.5), (n) => n === 'wheat' || n === 'wheat_seeds',
    { radius: 4, timeoutMs: 3000 });
  return { ok: true, gained: actions.countItems(bot, (n) => n === 'wheat') - before };
}

/** Breaks the nearest grass for a chance (1 in 8) at seeds. */
async function gatherSeeds(bot, ctx, { radius = 32, exclude = () => false } = {}) {
  const ids = ['short_grass', 'tall_grass'].map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
  const here = bot.entity.position;
  const ledger = ledgerFor(bot, ctx), target = p => ledgerTarget(bot, 'grass', p);
  const grass = bot.findBlocks({ matching: ids, maxDistance: radius, count: 32 })
    .filter(p => !ledger.skip(target(p)) && !exclude(p) && !bot.companionPlayerBlock?.(p))
    .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
    .map((p) => bot.blockAt(p)).filter(Boolean)[0];
  if (!grass) return fail('no_grass');
  const moved = await actions.goToDig(bot, ctx, grass, { timeoutMs: 30000 });
  if (!isComplete(moved)) return recordTarget(bot, ctx, moved, target(grass.position));
  const before = actions.countItems(bot, (n) => n === 'wheat_seeds');
  const dug = await actions.digBlock(bot, ctx, grass);
  if (!dug.ok) return recordTarget(bot, ctx, dug, target(grass.position));
  ledger.clearOnSuccess(target(grass.position));
  await actions.collectDrops(bot, ctx, grass.position.offset(0.5, 0.5, 0.5), (n) => n === 'wheat_seeds', { radius: 3, timeoutMs: 1500 });
  // No seed this time is still a block of work done, not a failure.
  return { ok: true, seeds: actions.countItems(bot, (n) => n === 'wheat_seeds') - before };
}

module.exports = { findGround, choosePlots, findWater, litPlot, plotState, till, plant, harvest, gatherSeeds, returnTo, irrigate, TILLABLE, RIPE };
