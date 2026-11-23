'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const skills = require('../core/skills');

const solid = (name, position) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position });
const air = (position) => ({ name: 'air', boundingBox: 'empty', shapes: [], position });

test('planner wood gathering leaves logs in a cave and takes the tree under the sky', async () => {
  const cave = new Vec3(4, 30, 0), tree = new Vec3(30, 64, 0);
  const blockAt = (p) => p.equals(cave) || p.equals(tree) ? solid('oak_log', p) : p.y < 64 ? solid('stone', p) : air(p);
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld', minY: -64, height: 384 },
    registry: { blocksByName: { oak_log: { id: 1, name: 'oak_log' }, stone: { id: 2, name: 'stone' } } },
    findBlocks: () => [cave, tree],
    blockAt,
  };
  let offered;
  const result = await skills.gatherOne(bot, { signal: new AbortController().signal, record: () => {} }, {
    blocks: (name) => name === 'oak_log', dropMatch: (name) => name === 'oak_log',
    selectTarget: (candidates) => { offered = candidates.map((b) => b.position.toString()); return { ok: false, reason: 'no_target_selected' }; },
  });
  assert.equal(result.reason, 'no_target_selected');
  assert.deepEqual(offered, [tree.toString()]);
});
