'use strict';

const { Vec3 } = require('vec3');
const { posKey } = require('./blacklist');

const SIDES = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const isBed = (block) => Boolean(block?.name?.endsWith('_bed'));
const unsafe = (b) => /^(water|lava|bubble_column|fire|soul_fire|powder_snow|cobweb|cactus|magma_block|.*campfire)$/.test(b.name);
const clear = (b) => Boolean(b && b.boundingBox === 'empty' && !unsafe(b));
const supports = (b) => Boolean(b && b.boundingBox === 'block' && !isBed(b) && !unsafe(b));

function safeStand(read, p) {
  const v = new Vec3(p.x, p.y, p.z);
  const floor = read(v.offset(0, -1, 0));
  return supports(floor) && floor.name !== 'farmland' && clear(read(v)) && clear(read(v.offset(0, 1, 0)));
}

function homeContains(house, position) {
  if (!house || !position) return false;
  const { anchor, size } = house;
  const { x, y, z } = position;
  return x >= anchor.x - 1 && x < anchor.x + size + 1 && z >= anchor.z - 1 && z < anchor.z + size + 1
    && y >= anchor.y - 1 && y < anchor.y + 4;
}

// A house has one walking level. Only cardinal steps through full-height
// openings count; beds aren't suitable floor under a two-block-high ceiling.
// A door itself is operable, not a piece of furniture that partitions the room.
function topology(house, read, { occupy = [], remove = [] } = {}) {
  const { x, y, z } = house.anchor;
  const door = house.furniture.door.position;
  const occupied = new Set(occupy.map(posKey)), removed = new Set(remove.map(posKey));
  const get = (p) => {
    const key = posKey(p);
    if (occupied.has(key)) return { name: 'planned_furniture', boundingBox: 'block' };
    if (removed.has(key)) return { name: 'air', boundingBox: 'empty' };
    return read(p);
  };
  let known = true;
  const walkable = (p, isDoor = false) => {
    const floor = get(p.offset(0, -1, 0));
    const space = [get(p), get(p.offset(0, 1, 0))];
    known &&= Boolean(floor && space.every(Boolean));
    return supports(floor) && space.every((b) => clear(b) || (isDoor && b?.name.endsWith('_door')));
  };
  const cells = new Map();
  for (let dx = 1; dx < house.size - 1; dx++) {
    for (let dz = 1; dz < house.size - 1; dz++) {
      const p = new Vec3(x + dx, y, z + dz);
      if (walkable(p)) cells.set(posKey(p), p);
    }
  }
  const threshold = new Vec3(door.x, door.y, door.z);
  const porch = new Vec3(house.entrance.x, house.entrance.y, house.entrance.z);
  const obstruction = !walkable(porch) ? { part: 'porch', position: porch }
    : !walkable(threshold, true) ? { part: 'threshold', position: threshold } : null;
  const open = !obstruction;
  const next = new Map();
  const queue = open ? [threshold] : [];
  for (let i = 0; i < queue.length; i++) {
    for (const [dx, dz] of SIDES) {
      const p = queue[i].offset(dx, 0, dz);
      const key = posKey(p);
      if (cells.has(key) && !next.has(key)) { next.set(key, queue[i]); queue.push(p); }
    }
  }
  const disconnected = [...cells.values()].filter(p => !next.has(posKey(p)));
  return { known, open, obstruction: obstruction || { part: 'interior', position: disconnected[0] || house.interiorCenter }, cells, reachable: new Set(next.keys()), next, disconnected, connected: known && open && cells.size > 0 && !disconnected.length };
}

module.exports = { topology, safeStand, supports, clear, isBed, SIDES, homeContains };
