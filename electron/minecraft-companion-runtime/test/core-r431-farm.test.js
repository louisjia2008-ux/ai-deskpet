'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const actions = require('../core/actions');
const { gatherSeeds } = require('../core/farming');

test('a single invocation collects nine seeds or stops after breaking twenty-four grass blocks', async t => {
  for (const gaveSeed of [true, false]) await t.test(gaveSeed ? 'bag is full enough' : 'physical work limit', async t => {
    const field = new Map(Array.from({ length: 32 }, (_, i) => [i + 1, new Vec3(i + 1, 64, 5)]));
    let seeds = 0;
    const bot = {
      entity: { position: new Vec3(0, 64, 5) },
      inventory: { items: () => seeds ? [{ name: 'wheat_seeds', count: seeds }] : [] },
      registry: { blocksByName: { short_grass: { id: 1 } } },
      blockAt: p => field.has(p.x) ? { name: 'short_grass', position: p } : { name: 'air', position: p },
      findBlocks: options => {
        assert.equal(options.maxDistance, 32);
        return [...field.values()];
      },
    };
    t.mock.method(actions, 'goToDig', async () => ({ ok: true }));
    t.mock.method(actions, 'digBlock', async (_bot, _ctx, block) => {
      assert.ok(field.delete(block.position.x));
      return { ok: true };
    });
    t.mock.method(actions, 'collectDrops', async () => {
      seeds += Number(gaveSeed);
      return { ok: gaveSeed };
    });
    const reports = [];
    const result = await gatherSeeds(bot, { record: (name, body) => reports.push({ name, body }) }, { required: 9 });
    assert.equal(result.ok, true);
    assert.equal(result.pulled, gaveSeed ? 9 : 24);
    assert.equal(result.pulled, 32 - field.size);
    assert.equal(result.gained, seeds);
    assert.equal(result.missing, 9 - seeds);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].name, 'farm_seed_batch');
    assert.equal(reports[0].body.gained, seeds);
  });
});
