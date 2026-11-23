'use strict';
// A small, fully self-gatherable starter house: 7x7 outside, 5x5 inside,
// cobblestone walls two high (exactly a door, and the bot is 1.8 tall), a flat
// plank roof, four torches, and two beds, a chest, crafting table and furnace inside.
// No glass or stairs, so no smelting of sand and no orientation-sensitive
// blocks besides bed and door.
//
// Two-high walls keep every block buildable: each wall block rests on a face
// below eye level, and the roof only needs one step to stand on.
//
// Layout (looking down, z grows south, door on the north wall at x=3):
//
//   z=0  W W W D W W W
//   z=1  W t . . . B W      t torch, B bed (head z=1, foot z=2)
//   z=2  W . . . . B W
//   z=3  W . . S . . W      S one dirt step, only while the roof is laid
//   z=4  W . . . . . W
//   z=5  W C F . H t W      C crafting table, F furnace, H chest
//   z=6  W W W W W W W

const SIZE = 7;
const WALL_HEIGHT = 2;

function createStarterHouse(anchor, { variant = 'starter' } = {}) {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (floor level, north-west corner)');
  }
  const at = (dx, dy, dz) => ({ x: anchor.x + dx, y: anchor.y + dy, z: anchor.z + dz });
  const size = variant === 'starter' ? SIZE : 5;
  const mid = Math.floor(size / 2);
  const blocks = [];
  const add = (dx, dy, dz, purpose, phase) => blocks.push({ position: at(dx, dy, dz), purpose, phase });

  const door = { dx: mid, dz: 0 };
  for (let dy = 0; dy < WALL_HEIGHT; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const edge = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
        if (!edge) continue;
        if (dx === door.dx && dz === door.dz && dy < 2) continue;
        add(dx, dy, dz, variant === 'hillside' && dz > 0 ? 'cave_wall' : 'wall', 'walls');
      }
    }
  }
  // Roof: the ring over the walls first (supported from below), then inwards.
  const ring = (dx, dz) => Math.min(dx, dz, size - 1 - dx, size - 1 - dz);
  const roof = [];
  for (let dx = 0; dx < size; dx += 1) for (let dz = 0; dz < size; dz += 1) roof.push({ dx, dz, ring: ring(dx, dz) });
  roof.sort((a, b) => variant === 'compact' && (a.ring === mid || b.ring === mid)
    ? b.ring - a.ring : a.ring - b.ring);
  for (const cell of roof) add(cell.dx, WALL_HEIGHT, cell.dz, variant === 'hillside' ? 'cave_wall' : 'roof', 'roof');

  const compact = size < SIZE;
  const cell = (family, dx, dz) => ({ family, position: at(dx, 0, dz) });
  // Stand south of the beds in the starter house, north of them in a compact house.
  const bed = (x) => ({ ...cell('bed', x, 2), head: at(x, 0, compact ? 3 : 1),
    stand: at(compact ? mid : x, 0, compact ? -1 : 4) });
  const furniture = {
    crafting_table: cell('crafting_table', 1, compact ? 1 : 5),
    furnace: cell('furnace', compact ? 3 : 2, compact ? 1 : 5),
    chest: cell('chest', compact ? 2 : 4, compact ? 3 : 5),
    bed: bed(compact ? 3 : 5), guestBed: bed(compact ? 1 : 4),
    torches: (compact ? [[2, 1], [2, 2], [1, -1], [3, -1]]
      : [[1, 1], [5, 5], [2, -1], [4, -1]]).map(([x, z]) => at(x, 0, z)),
    door: { ...cell('door', door.dx, door.dz), upper: at(door.dx, 1, door.dz) },
  };

  // The first roof ring sits on the wall tops, whose upper faces are above eye
  // level from the floor. One step in the middle of the room lets the bot see
  // them from above; it exists only while the roof is laid and is then removed
  // like any other obstacle inside the shell.
  const scaffold = variant === 'hillside' ? [] : [at(mid, 0, mid), ...(variant === 'compact' ? [at(mid, 1, mid)] : [])];

  // Everything inside the shell and one block of headroom above the roof must be clear.
  const clearance = [], foundation = [];
  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) {
      foundation.push(at(dx, -1, dz));
      for (let dy = 0; dy <= WALL_HEIGHT + (variant === 'hillside' ? 0 : 1); dy += 1) clearance.push(at(dx, dy, dz));
    }
  }
  const entrance = at(door.dx, 0, -1);
  const exteriorTorches = furniture.torches.filter((p) => p.z < anchor.z);
  clearance.push(entrance, at(door.dx, 1, -1), ...exteriorTorches);
  foundation.push(at(door.dx, -1, -1)); // A doorstep pit blocks the only exit.
  const torchSupports = exteriorTorches.map((p) => ({ ...p, y: p.y - 1 }));

  return {
    anchor: { ...anchor },
    size,
    variant,
    blocks,
    furniture,
    scaffold,
    clearance,
    foundation,
    torchSupports,
    // Doorstep outside the door; the bot must be able to reach it.
    entrance,
    interiorCenter: at(mid, 0, mid),
  };
}

module.exports = { createStarterHouse, SIZE, WALL_HEIGHT };
