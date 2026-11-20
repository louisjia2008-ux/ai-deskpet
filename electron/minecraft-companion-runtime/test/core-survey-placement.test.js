'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { iterators: { RaycastIterator } } = require('prismarine-world');
const Block = require('prismarine-block')('1.21.8');
const registry = require('minecraft-data')('1.21.8');
const { hitFor, stationChoices } = require('../core/survey-placement');

function scene() {
  const cells = new Map();
  function set(pos, name) {
    cells.set(pos.toString(), registry.blocksByName[name].defaultState);
  }
  function blockAt(pos) {
    const block = Block.fromStateId(cells.get(pos.toString()) ?? 0, 0);
    block.position = pos;
    return block;
  }
  const bot = {
    entity: { position: new Vec3(0.5, 1, 3.5), eyeHeight: 1.62 },
    blockAt,
    world: {
      raycast(eye, vector, distance) {
        const ray = new RaycastIterator(eye, vector, distance);
        let step;
        while ((step = ray.next())) {
          const block = blockAt(new Vec3(step.x, step.y, step.z));
          const hit = ray.intersect(block.shapes, block.position);
          if (hit) return Object.assign(block, { face: hit.face });
        }
        return null;
      },
    },
  };
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) set(new Vec3(x, 0, z), 'stone');
  }
  return { bot, set };
}

test('survey placement selects a door view from each requested direction', () => {
  const { bot } = scene();
  const pos = new Vec3(0, 1, 0);
  for (const [direction, x, z] of [['north', 0.5, 3.5], ['south', 0.5, -2.5],
    ['east', -2.5, 0.5], ['west', 3.5, 0.5]]) {
    const target = `minecraft:oak_door[facing=${direction},half=lower,hinge=left,open=false,powered=false]`;
    const step = [{ pos, target }, { pos: pos.offset(0, 1, 0), target: target.replace('lower', 'upper') }];
    const feet = new Vec3(x, 1, z);
    const first = hitFor(bot, step, feet, new Set());
    assert.equal(first?.face, 1, direction);
    assert.deepEqual(first.block.position, pos.offset(0, -1, 0));
    assert.ok(hitFor(bot, step, feet, new Set([first.key])), 'retry uses a different hit point');
    assert.equal(hitFor(bot, step, new Vec3(1 - x, 1, 1 - z), new Set()), null);
  }
});

test('survey placement uses a horizontal face for horizontal logs and rejects body overlap', () => {
  const { bot, set } = scene();
  const pos = new Vec3(0, 1, 0);
  set(pos.offset(1, 0, 0), 'stone');
  const step = [{ pos, target: 'minecraft:oak_log[axis=x]' }];
  assert.equal(hitFor(bot, step, pos.offset(0.5, 0, 0.5), new Set()), null);
  const hit = hitFor(bot, step, new Vec3(-1.5, 1, 0.5), new Set());
  assert.equal(hit?.face, 4);
  assert.ok(stationChoices(bot, step, new Set()).length > 0);
});

test('survey irrigation refuses to place a source in an uncontained cell', () => {
  const { bot, set } = scene();
  const pos = new Vec3(0, 1, 0);
  const water = [{ pos, target: 'minecraft:water[level=0]' }];
  assert.equal(hitFor(bot, water, new Vec3(0.5, 1, 2.5), new Set()), null);
  for (const [x, z] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) set(pos.offset(x, 0, z), 'dirt');
  const hit = hitFor(bot, water, new Vec3(0.5, 2, 1.5), new Set());
  assert.ok(hit?.waterBucket);
});
