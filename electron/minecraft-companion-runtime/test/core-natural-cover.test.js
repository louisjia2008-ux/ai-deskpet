'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const actions = require('../core/actions');
const { placeAt } = require('../core/skills');
const { naturalCover } = require('../core/natural-cover');
const { matchesExpectState, replaceable } = require('../core/survey-plan-rules');
const farming = require('../core/farming');

const foot = new Vec3(0, 64, 0);
const head = foot.offset(0, 0, 1);
const stand = foot.offset(0, 0, -2);
const down = new Vec3(0, -1, 0);
const type = (name, props = {}) => ({ name, getProperties: () => props });

function world() {
  const cells = new Map();
  const edits = [];
  const key = p => `${p.x},${p.y},${p.z}`;
  const put = (p, name, props) => cells.set(key(p), type(name, props));
  const air = p => put(p, 'air');
  const at = p => {
    const block = cells.get(key(p)) || type(p.y < 64 ? 'dirt' : 'air');
    return { ...block, position: p, boundingBox: p.y < 64 ? 'block' : 'empty' };
  };
  const cover = (p, species) => {
    const paired = species === 'large_fern' || species === 'sunflower';
    put(p, species, paired ? { half: 'lower' } : {});
    if (paired) put(p.offset(0, 1, 0), species, { half: 'upper' });
  };
  const breakCover = (p) => {
    const half = at(p).getProperties().half;
    if (half) air(p.offset(0, half === 'lower' ? 1 : -1, 0));
    air(p);
  };
  const bot = {
    entity: { position: stand.offset(0.5, 0, 0.5), onGround: true },
    entities: {},
    inventory: { items: () => [{ name: 'torch' }, { name: 'white_bed' }, { name: 'wheat_seeds' }, { name: 'stone_hoe' }] },
    blockAt: at,
    async equip(item) { this.heldItem = item; },
    async lookAt() {},
    async placeBlock(ref, face) {
      const target = ref.position.plus(face);
      const bed = this.heldItem.name === 'white_bed';
      const footprint = bed ? [target, head] : [target];
      for (const p of footprint) assert.ok(['air', 'replace'].includes(naturalCover(at(p))), 'vanilla can replace every footprint cell');
      for (const p of footprint) breakCover(p);
      put(target, this.heldItem.name, bed ? { part: 'foot' } : {});
      if (bed) put(head, 'white_bed', { part: 'head' });
      edits.push(['place', key(target)]);
    },
    async activateBlock(soil) {
      const above = soil.position.offset(0, 1, 0);
      if (this.heldItem.name.endsWith('_hoe')) {
        assert.equal(at(above).name, 'air');
        put(soil.position, 'farmland');
      } else {
        assert.ok(['air', 'replace'].includes(naturalCover(at(above))));
        breakCover(above);
        put(above, 'wheat', { age: 0 });
      }
    },
  };
  return { bot, cover, at, put, breakCover, edits, key };
}

async function withPlacementActions(fixture, run) {
  const saved = { goNear: actions.goNear, goToDig: actions.goToDig, digBlock: actions.digBlock };
  try {
    actions.goNear = async () => ({ ok: true });
    actions.goToDig = async () => ({ ok: true });
    actions.digBlock = async (_bot, _ctx, block) => {
      fixture.edits.push(['dig', fixture.key(block.position)]);
      fixture.breakCover(block.position);
      return { ok: true };
    };
    return await run();
  } finally {
    Object.assign(actions, saved);
  }
}

test('1.21.8 placement and survey retain separate permissions in the shared cover classification', () => {
  for (const name of ['short_grass', 'fern', 'tall_grass', 'large_fern', 'dead_bush', 'bush', 'short_dry_grass', 'tall_dry_grass',
    'leaf_litter']) assert.equal(naturalCover(type(name)), 'replace', name);
  for (const name of ['poppy', 'firefly_bush', 'sunflower', 'oak_sapling', 'wildflowers']) {
    assert.equal(naturalCover(type(name)), 'clear', name);
    assert.equal(replaceable(`minecraft:${name}`), false, name);
  }
  assert.equal(naturalCover(type('snow', { layers: 1 })), 'replace');
  assert.equal(naturalCover(type('snow', { layers: 2 })), 'clear');
  assert.equal(naturalCover(type('oak_sapling', { waterlogged: true })), null);
  assert.equal(naturalCover(type('wheat')), null);
  assert.equal(replaceable('minecraft:snow[layers=8]'), true);
  assert.equal(replaceable('minecraft:fern[waterlogged=true]'), false);
  assert.equal(matchesExpectState({ kind: 'clear' }, 'minecraft:poppy'), true);
  assert.equal(matchesExpectState({ kind: 'clear' }, 'minecraft:oak_sapling'), false);
  assert.equal(matchesExpectState({ kind: 'furnish', expect: 'minecraft:air' }, 'minecraft:large_fern[half=upper]'), true);
});

test('torches and both bed cells replace grasses and both fern halves, or first clear flowers', async () => {
  for (const species of ['short_grass', 'fern', 'large_fern', 'poppy', 'sunflower']) {
    for (const item of ['torch', 'white_bed']) {
      const fixture = world();
      const bed = item === 'white_bed';
      fixture.cover(foot, species);
      if (bed) fixture.cover(head, species);
      await withPlacementActions(fixture, async () => {
        const result = await placeAt(fixture.bot, { record() {} }, foot, name => name === item, {
          faces: [down], stand, requireAir: true, alsoClear: bed ? [head] : [],
          verify: bed ? () => fixture.at(head).getProperties().part === 'head' : undefined,
        });
        assert.equal(result.ok, true, `${species}/${item}: ${result.reason}`);
        const wanted = ['poppy', 'sunflower'].includes(species)
          ? [['dig', '0,64,0'], ...(bed ? [['dig', '0,64,1']] : [])] : [];
        assert.deepEqual(fixture.edits, [...wanted, ['place', '0,64,0']]);
        assert.equal(fixture.at(foot.offset(0, 1, 0)).name, 'air');
        if (bed) {
          assert.equal(fixture.at(foot).getProperties().part, 'foot');
          assert.equal(fixture.at(head).getProperties().part, 'head');
          assert.equal(fixture.at(head.offset(0, 1, 0)).name, 'air');
        }
      });
    }
  }
});

test('player protection applies to the complete footprint and to a plant partner', async () => {
  for (const [species, protectedAt] of [['fern', foot], ['poppy', head], ['large_fern', head.offset(0, 1, 0)],
    ['sunflower', head.offset(0, 1, 0)]]) {
    const fixture = world();
    fixture.cover(foot, species);
    fixture.cover(head, species);
    await withPlacementActions(fixture, async () => {
      const result = await placeAt(fixture.bot, { record() {} }, foot, (n) => n === 'white_bed', {
        faces: [down], stand, requireAir: true, alsoClear: [head], protectedCell: p => p.equals(protectedAt),
      });
      assert.equal(result.reason, 'protected_player_block');
      assert.deepEqual(fixture.edits, []);
      assert.equal(fixture.at(foot).name, species);
      assert.equal(fixture.at(head).name, species);
    });
  }
});

test('farming reads the same natural cover while keeping crops and protected plants', async () => {
  const fixture = world();
  const plot = foot.plus(down);
  fixture.cover(foot, 'large_fern');
  await withPlacementActions(fixture, async () => {
    const ctx = { record() {} };
    assert.equal(farming.plotState(fixture.bot, plot), 'untilled');
    assert.equal((await farming.till(fixture.bot, ctx, plot)).ok, true);
    fixture.cover(foot, 'poppy');
    assert.equal(farming.plotState(fixture.bot, plot), 'empty');
    fixture.bot.companionPlayerBlock = p => p.equals(foot);
    assert.equal((await farming.plant(fixture.bot, ctx, plot)).reason, 'protected_player_block');
    assert.equal(fixture.at(foot).name, 'poppy');
    fixture.bot.companionPlayerBlock = () => false;
    assert.equal((await farming.plant(fixture.bot, ctx, plot)).ok, true);
    assert.equal(farming.plotState(fixture.bot, plot), 'growing');
    assert.deepEqual(fixture.edits, [['dig', '0,64,0'], ['dig', '0,64,0']]);
  });
});
