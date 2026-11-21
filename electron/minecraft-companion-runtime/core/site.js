'use strict';
// Picks a building site and derives the remaining site work from the world.
// Only small terrain fixes are accepted (one-block bumps and holes); sites with
// trees, water or steep ground are skipped rather than terraformed.

const { createStarterHouse, SIZE, WALL_HEIGHT } = require('./blueprints/starterHouse');

const GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone',
  'andesite', 'diorite', 'granite', 'sand', 'red_sand', 'terracotta', 'snow_block', 'moss_block', 'mud', 'clay']);
const TREE = (name) => name.endsWith('_log') || name.endsWith('_leaves') || name.endsWith('_wood');
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name);

/** Top solid ground at (x, z), searching downward from `top`. */
function groundAt(blockAt, x, z, top, bottom) {
  for (let y = top; y >= bottom; y -= 1) {
    const block = blockAt(x, y, z);
    if (!block) return { unloaded: true }; // unknown is not air
    if (isSoft(block)) continue;
    if (LIQUID.has(block.name)) return { liquid: true };
    if (TREE(block.name)) return { tree: true };
    if (!GROUND.has(block.name)) return { other: block.name };
    return { y };
  }
  return { missing: true };
}

function evaluateSite(blockAt, corner, around, { variant = 'starter', protectedCell = () => false } = {}) {
  const size = variant === 'starter' ? SIZE : 5;
  const heights = [];
  for (let dx = -1; dx <= size; dx += 1) {
    for (let dz = -1; dz <= size; dz += 1) {
      const ground = groundAt(blockAt, corner.x + dx, corner.z + dz, around.y + 10, around.y - 12);
      const inside = dx >= 0 && dz >= 0 && dx < size && dz < size;
      if (ground.y === undefined) {
        if (inside || ground.liquid) return null; // water next to the walls floods the door
        continue;
      }
      if (inside) heights.push(ground.y);
    }
  }
  const counts = new Map();
  for (const h of heights) counts.set(h, (counts.get(h) || 0) + 1);
  const [mode] = [...counts].sort((a, b) => b[1] - a[1])[0];
  let fills = 0;
  let digs = 0;
  for (const h of heights) {
    if (h === mode - 1) fills += 1;
    else if (h === mode + 1) digs += 1;
    else if (h !== mode) return null;
  }
  const anchor = { x: corner.x, y: mode + 1, z: corner.z };
  const house = createStarterHouse(anchor, { variant });
  if ([...house.clearance, ...house.foundation, ...house.torchSupports, house.entrance].some(protectedCell)) return null;
  // Every solid block left in the shell's space is digging work too.
  digs = 0;
  for (const p of house.clearance) {
    const block = blockAt(p.x, p.y, p.z);
    if (!block) return null;
    if (TREE(block.name) || LIQUID.has(block.name)) return null;
    if (!isSoft(block)) digs += 1;
  }
  // Under a closed canopy (dark oak, pale garden) it is dark enough for
  // monsters all day: move on to open ground instead.
  let covered = 0;
  const samples = [0, Math.floor(size / 2), size - 1];
  for (const dx of samples) {
    for (const dz of samples) {
      for (let dy = WALL_HEIGHT + 2; dy <= 16; dy += 1) {
        const above = blockAt(anchor.x + dx, anchor.y + dy, anchor.z + dz);
        if (above && (above.name.endsWith('_leaves') || TREE(above.name))) { covered += 1; break; }
      }
    }
  }
  if (covered >= 5) return null;
  // Rock overhead is a cave floor, not open ground: a house begun at y22 under
  // the hills was where the creepers and skeletons came from.
  let roofed = 0;
  for (const dx of samples) {
    for (const dz of samples) {
      for (let dy = WALL_HEIGHT + 2; dy <= 40; dy += 1) {
        const above = blockAt(anchor.x + dx, anchor.y + dy, anchor.z + dz);
        if (above && isSolid(above) && !TREE(above.name)) { roofed += 1; break; }
      }
    }
  }
  if (roofed >= 3) return null;
  for (const p of [house.entrance, ...house.torchSupports.map((p) => ({ ...p, y: p.y + 1 }))]) {
    const below = blockAt(p.x, p.y - 1, p.z);
    if (isSolid(below)) continue;
    if (!isSoft(below) || !isSolid(blockAt(p.x, p.y - 2, p.z))) return null;
    fills += 1;
  }
  const distance = Math.hypot(corner.x + size / 2 - around.x, corner.z + size / 2 - around.z);
  return { anchor, fills, digs, variant, cost: digs + fills * 2 + distance * 0.1 };
}

/** Best nearby site within `radius` of `around`, or null. */
function chooseSite(blockAt, around, { radius = 32, step = 3, maxWork = 12, avoid = () => false, variant = 'starter', protectedCell } = {}) {
  let best = null;
  const center = { x: Math.floor(around.x), y: Math.floor(around.y), z: Math.floor(around.z) };
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const half = variant === 'starter' ? Math.floor(SIZE / 2) : 2;
      const corner = { x: center.x + dx - half, z: center.z + dz - half };
      const site = evaluateSite(blockAt, corner, center, { variant, protectedCell });
      if (!site || site.fills + site.digs > maxWork || avoid(site.anchor)) continue;
      if (!best || site.cost < best.cost) best = site;
    }
  }
  return best;
}

const caveRock = (b) => b && /^(stone|andesite|diorite|granite|deepslate|sandstone|dirt)$/.test(b.name);
const NEIGHBORS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
function safeCaveDig(blockAt, p) {
  return NEIGHBORS.every(([dx, dy, dz]) => {
    const b = blockAt(p.x + dx, p.y + dy, p.z + dz);
    return b && !LIQUID.has(b.name) && !/^(sand|red_sand|gravel|.*concrete_powder)$/.test(b.name);
  });
}

function chooseHillside(blockAt, around, { avoid = () => false, protectedCell = () => false } = {}) {
  const x0 = Math.floor(around.x), y0 = Math.floor(around.y), z0 = Math.floor(around.z);
  const read = (p) => blockAt(p.x, p.y, p.z);
  for (const distance of [0, 4, 8, 12, 16, 20, 24]) {
    for (let dx = -distance; dx <= distance; dx += 2) for (let dz = -distance; dz <= distance; dz += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== distance) continue;
      for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
        const anchor = { x: x0 + dx - 2, y: y0 + dy, z: z0 + dz + 1 };
        if (avoid(anchor)) continue;
        const house = createStarterHouse(anchor, { variant: 'hillside' });
        const e = house.entrance;
        if (![read(e), read({ ...e, y: e.y + 1 })].every((b) => b && isSoft(b))
          || !house.foundation.every((p) => isSolid(read(p))) || !house.torchSupports.every((p) => isSolid(read(p)))) continue;
        if (house.blocks.filter((b) => b.family === 'cave_wall').some((b) => !caveRock(read(b.position)))) continue;
        if ([...house.clearance, ...house.foundation, ...house.torchSupports, e].some(protectedCell)) continue;
        if (!house.clearance.every((p) => {
          const b = read(p);
          return b && (isSoft(b) || caveRock(b)) && safeCaveDig(blockAt, p);
        })) continue;
        return { anchor, variant: 'hillside', fills: 0, digs: house.clearance.filter((p) => caveRock(read(p))).length };
      }
    }
  }
  return null;
}

/**
 * Remaining site work, derived fresh from the world every time:
 *   digs  - non-air blocks inside the clearance that are not correct house blocks
 *   fills - foundation cells that are not solid
 */
function siteWork(blockAt, house, isCorrect) {
  const digs = [];
  for (const p of house.clearance) {
    const block = blockAt(p.x, p.y, p.z);
    // Plants are simply replaced when a block is placed into them.
    if (isSoft(block) || isCorrect(p, block)) continue;
    digs.push({ position: p, name: block.name });
  }
  const fills = [];
  for (const p of house.foundation) {
    if (!isSolid(blockAt(p.x, p.y, p.z))) fills.push({ position: p });
  }
  // Dig from the top down so nothing falls into a cleared cell.
  digs.sort((a, b) => b.position.y - a.position.y);
  return { digs, fills };
}

module.exports = { chooseSite, chooseHillside, safeCaveDig, evaluateSite, siteWork, groundAt, isAir, isSoft, isSolid, WALL_HEIGHT };
