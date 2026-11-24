'use strict';

const CARDINAL_XZ = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const AXIS_OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Visit integer coordinates in the requested order without materializing a grid.
function* integerBox([a0, a1, da = 1], [b0, b1, db = 1], [c0, c1, dc = 1] = [0, 0]) {
  for (let a = a0; a <= a1; a += da) {
    for (let b = b0; b <= b1; b += db) {
      for (let c = c0; c <= c1; c += dc) yield [a, b, c];
    }
  }
}

module.exports = { integerBox, CARDINAL_XZ, AXIS_OFFSETS };
