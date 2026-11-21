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
  const add = (dx, dy, dz, family, phase, extra = {}) => blocks.push({ position: at(dx, dy, dz), family, phase, ...extra });

  const door = { dx: mid, dz: 0 };
  for (let dy = 0; dy < WALL_HEIGHT; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const edge = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
        if (!edge) continue;
        if (dx === door.dx && dz === door.dz && dy < 2) continue;
        add(dx, dy, dz, variant === 'hillside' && dz > 0 ? 'cave_wall' : variant === 'starter' ? 'cobblestone' : 'shelter_wall', 'walls');
      }
    }
  }
  // Roof: the ring over the walls first (supported from below), then inwards.
  const ring = (dx, dz) => Math.min(dx, dz, size - 1 - dx, size - 1 - dz);
  const roof = [];
  for (let dx = 0; dx < size; dx += 1) for (let dz = 0; dz < size; dz += 1) roof.push({ dx, dz, ring: ring(dx, dz) });
  roof.sort((a, b) => variant === 'compact' && (a.ring === mid || b.ring === mid)
    ? b.ring - a.ring : a.ring - b.ring);
  for (const cell of roof) add(cell.dx, WALL_HEIGHT, cell.dz, variant === 'hillside' ? 'cave_wall' : 'planks', 'roof');

  const furniture = {
    crafting_table: { position: at(1, 0, 5), family: 'crafting_table' },
    furnace: { position: at(2, 0, 5), family: 'furnace' },
    chest: { position: at(4, 0, 5), family: 'chest' },
    // The bed is placed by standing south of the foot and facing north.
    bed: { position: at(5, 0, 2), head: at(5, 0, 1), stand: at(5, 0, 4), family: 'bed' },
    guestBed: { position: at(4, 0, 2), head: at(4, 0, 1), stand: at(4, 0, 4), family: 'bed' },
    torches: [at(1, 0, 1), at(5, 0, 5), at(2, 0, -1), at(4, 0, -1)],
    door: { position: at(door.dx, 0, door.dz), upper: at(door.dx, 1, door.dz), family: 'door' },
  };
  if (size < SIZE) Object.assign(furniture, {
    crafting_table: { position: at(1, 0, 1), family: 'crafting_table' },
    furnace: { position: at(3, 0, 1), family: 'furnace' },
    chest: { position: at(2, 0, 3), family: 'chest' },
    // From the doorstep the southward component of the placement aim is
    // dominant for either bed. Both are accessible from the central aisle.
    bed: { position: at(3, 0, 2), head: at(3, 0, 3), stand: at(2, 0, -1), family: 'bed' },
    guestBed: { position: at(1, 0, 2), head: at(1, 0, 3), stand: at(2, 0, -1), family: 'bed' },
    torches: [at(2, 0, 1), at(2, 0, 2), at(1, 0, -1), at(3, 0, -1)],
  });

  // The first roof ring sits on the wall tops, whose upper faces are above eye
  // level from the floor. One step in the middle of the room lets the bot see
  // them from above; it exists only while the roof is laid and is then removed
  // like any other obstacle inside the shell.
  const scaffold = variant === 'hillside' ? [] : [at(mid, 0, mid), ...(variant === 'compact' ? [at(mid, 1, mid)] : [])];

  // Everything inside the shell and one block of headroom above the roof must be clear.
  const clearance = [];
  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) {
      for (let dy = 0; dy <= WALL_HEIGHT + (variant === 'hillside' ? 0 : 1); dy += 1) clearance.push(at(dx, dy, dz));
    }
  }
  const entrance = at(door.dx, 0, -1);
  const exteriorTorches = furniture.torches.filter((p) => p.z < anchor.z);
  clearance.push(entrance, at(door.dx, 1, -1), ...exteriorTorches);
  const foundation = [];
  for (let dx = 0; dx < size; dx += 1) for (let dz = 0; dz < size; dz += 1) foundation.push(at(dx, -1, dz));
  // And under the doorstep: a pit there (a creeper crater, a cave) leaves the
  // bot shut in the house with no path out.
  foundation.push(at(door.dx, -1, -1));
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
    materials() {
      const totals = {};
      for (const block of blocks) totals[block.family] = (totals[block.family] || 0) + 1;
      totals.torch = furniture.torches.length;
      return totals;
    },
  };
}

module.exports = { createStarterHouse, SIZE, WALL_HEIGHT };
