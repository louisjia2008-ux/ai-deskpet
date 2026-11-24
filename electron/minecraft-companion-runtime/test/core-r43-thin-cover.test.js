'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Movements } = require('mineflayer-pathfinder');
const { safeStand } = require('../core/home-topology');
const { naturalCover } = require('../core/natural-cover');
const { startProblem } = require('../core/action-result');

test('R4.2 seed 3 thin cover permits a native first step without breaking a block', () => {
  const registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry);
  let name;
  const at = new Vec3(0, 64, 0);
  const bot = { registry, entity: { position: at.offset(0.5, 0, 0.5) }, blockAt(position) {
    const cell = position.y < 64 ? 'grass_block' : position.y === 64 ? name : 'air';
    const block = Block.fromStateId(registry.blocksByName[cell].minStateId, 15);
    block.position = position;
    return block;
  } };
  const moves = new Movements(bot);
  for (const [cover, handling] of [
    ['leaf_litter', 'replace'], ['short_dry_grass', 'replace'], ['tall_dry_grass', 'replace'], ['bush', 'replace'],
    ['wildflowers', 'clear'], ['firefly_bush', 'clear'],
  ]) {
    name = cover;
    assert.equal(safeStand(bot.blockAt, at), true, cover);
    assert.equal(startProblem(bot), null, cover);
    assert.equal(naturalCover(bot.blockAt(at)), handling, cover);
    const neighbors = [];
    moves.getMoveForward({ ...at, remainingBlocks: 0 }, { x: 1, z: 0 }, neighbors);
    assert.equal(neighbors.length, 1, cover);
    assert.deepEqual(neighbors[0].toBreak, [], cover);
  }
});
