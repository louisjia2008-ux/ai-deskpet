'use strict';

const { Vec3 } = require('vec3');
const { posKey } = require('./blacklist');
const { clear, safeStand, SIDES } = require('./home-topology');

const wet = (b) => Boolean(b && (/^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name)
  || b.getProperties?.().waterlogged === true));

// Evidence for site selection, not a speculative pathfinder route: every
// edge is walkable in both directions with no digging, bridging or swimming.
function dryComponent(read, from, limit = 52) {
  const start = new Vec3(Math.floor(from.x), Math.floor(from.y), Math.floor(from.z));
  const cells = new Map(), queue = [];
  const dry = p => safeStand(read, p) && [p, p.offset(0, 1, 0), p.offset(0, -1, 0)].every(q => !wet(read(q)));
  const add = (p) => {
    cells.set(posKey(p), p);
    queue.push(p);
  };
  if (dry(start)) add(start);
  for (let i = 0; i < queue.length && queue.length < 8500; i++) {
    const p = queue[i];
    for (const [dx, dz] of SIDES) {
      for (const dy of [0, 1, -1]) {
        const q = p.offset(dx, dy, dz);
        if (Math.abs(q.x - start.x) > limit || Math.abs(q.z - start.z) > limit || Math.abs(q.y - start.y) > 18
          || cells.has(posKey(q)) || !dry(q)) continue;
        if (dy) {
          const low = dy > 0 ? p : q;
          const jumpSpace = read(low.offset(0, 2, 0));
          if (!clear(jumpSpace) || wet(jumpSpace)) continue;
        }
        add(q);
      }
    }
  }
  return cells;
}

function drySiteAccess(read, from, logs) {
  const cells = dryComponent(read, from);
  const standableLogs = logs.filter(log => SIDES.some(([dx, dz]) => [0, 1, 2, 3].some(dy =>
    cells.has(posKey(new Vec3(log.x + dx, log.y - dy, log.z + dz))))));
  return (house, stocked) => {
    const e = house.entrance;
    // Hillside earthwork may cut a blocked entrance from a dry cell one
    // block farther north (already checked for flooding by chooseHillside).
    const porch = cells.get(posKey(e)) || (house.variant === 'hillside' && cells.get(posKey({ ...e, z: e.z - 1 })));
    if (!porch) return null;
    const tree = standableLogs.find(p => Math.hypot(p.x - e.x, p.z - e.z) <= 32
      && (p.x < house.anchor.x || p.x >= house.anchor.x + house.size
        || p.z < house.anchor.z || p.z >= house.anchor.z + house.size));
    return tree ? { porch, tree } : stocked ? { porch, stocked: true } : null;
  };
}

module.exports = { dryComponent, drySiteAccess, wet };
