'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createNightRest } = require('../core/behaviors/nightRest');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { enclose } = require('../core/skills');

for (const canReturn of [true, false]) {
  test(`a displaced enclosure ${canReturn ? 'resumes at its old column' : 'cleans its old blocks before moving the site'}`, async () => {
    const first = new Vec3(0, 64, 0), away = first.offset(7, 0, 0);
    const bot = { entity: { position: first.offset(0.5, 0, 0.5), onGround: true },
      inventory: { items: () => [{ name: 'cobblestone', count: 10 }] },
      blockAt: position => ({ name: 'stone', boundingBox: 'block', position }) };
    const calls = [];
    let initial = true;
    const rest = createNightRest({ bot, home: () => ({ centre: null }), actions: {
      goTo(_bot, ctx, goal, options) {
        calls.push('return_to_top');
        assert.equal(ctx.dryRoute, true);
        assert.equal(options.timeoutMs, 5000);
        assert(goal.isEnd(first));
        if (canReturn) bot.entity.position = first.offset(0.5, 0, 0.5);
        return canReturn ? { ok: true } : { ok: false, reason: 'nopath' };
      },
    }, skills: {
      digIn: () => ({ ok: false, reason: 'no_bunker_spot' }),
      async enclose(_bot, ctx, shelter) {
        if (initial) {
          initial = false;
          shelter.placed.push({ position: first.offset(1, 0, 0), name: 'stone' });
          bot.entity.position = away.offset(0.5, 0, 0.5);
          return { ok: false, kind: 'interrupted', reason: 'aborted' };
        }
        if (!bot.entity.position.floored().equals(shelter.top)) return enclose(bot, ctx, shelter);
        calls.push('confirmed_current_top');
        return { ok: true };
      },
      openEnclosure(_bot, _ctx, shelter) {
        calls.push('clean_old_top');
        assert(shelter.top.equals(first));
        assert.equal(shelter.placed.length, 1);
        return { ok: true };
      },
    } });
    const ctx = { perceive: () => ({ timeOfDay: 13_000, position: bot.entity.position }), record() {} };
    await rest.run(ctx);
    await rest.run(ctx);
    assert.equal((await rest.run(ctx)).ok, true);
    assert.deepEqual(calls, canReturn ? ['return_to_top', 'confirmed_current_top']
      : ['return_to_top', 'clean_old_top', 'confirmed_current_top']);
    assert.equal(bot.companionSheltered, true);
  });
}

test('opening a hole in a held home cover retires the old wait and tries a local shelter', async t => {
  const top = new Vec3(0, 64, 0);
  const bot = { entity: { position: top.offset(0.5, 0, 0.5), onGround: true },
    blockAt: position => ({ name: 'stone', boundingBox: 'block', position }) };
  let covered = true;
  const events = [];
  const rest = createNightRest({ bot, home: () => ({ centre: top, inside: true, covered: () => covered }),
    shelterDoor: () => ({ ok: true }), skills: { digIn() {
      bot.entity.position = top.offset(0.5, -3, 0.5);
      return { ok: true, bunker: { top } };
    } } });
  const ctx = { perceive: () => ({ timeOfDay: 13_000, position: bot.entity.position }), record: (_type, data) => events.push(data.action) };
  await rest.run(ctx);
  assert.equal(bot.companionSheltered, true);
  covered = false;
  assert.equal(bot.companionSheltered, false);
  // The pre-fix wait should complete without spending real time.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let run = 0; run < 2; run += 1) {
    const attempt = rest.run(ctx);
    await Promise.resolve();
    t.mock.timers.tick(3000);
    await attempt;
  }
  assert.deepEqual(events, ['shelter_lost', 'dig_in', 'dug_in']);
  assert.equal(bot.companionSheltered, true);
});

test('an unreachable remnant gives up daytime work ownership until its ledger entry expires', async () => {
  const { createFailureLedger } = require('../core/failure-ledger');
  let now = 1000, night = true, reachable = false, cleaned = 0;
  const top = new Vec3(0, 64, 0), position = top.offset(1, 0, 0);
  const bot = { entity: { position: top.offset(0.5, 0, 0.5), onGround: true },
    companionFailureLedger: createFailureLedger({ now: () => now }), blockAt: () => null };
  const rest = createNightRest({ bot, now: () => now, home: () => ({ centre: null }),
    actions: { withinReach: () => reachable, goTo: () => ({ ok: false, reason: 'nopath' }) },
    skills: {
      digIn: () => ({ ok: false, reason: 'no_bunker_spot' }),
      enclose(_bot, _ctx, enclosure) {
        enclosure.placed.push({ position, name: 'sandstone' });
        bot.entity.position = top.offset(20, 0, 0);
        return { ok: false, kind: 'interrupted', reason: 'aborted' };
      },
      openEnclosure(_bot, _ctx, enclosure) {
        assert.deepEqual(enclosure.placed, [{ position, name: 'sandstone' }]);
        cleaned += 1;
        return { ok: true };
      },
    },
  });
  const ctx = { perceive: () => ({ timeOfDay: night ? 13_000 : 1000, position: bot.entity.position }), record() {} };
  await rest.run(ctx);
  await rest.run(ctx);
  night = false;
  assert.equal((await rest.run(ctx)).reason, 'nopath');
  assert.equal(cleaned, 0);
  assert.equal(rest.taskAllowed(ctx.perceive(), 'homestead'), true);
  assert.equal(rest.want(ctx.perceive()), 0);
  assert.equal(bot.companionFailureLedger.snapshot().length, 1);
  now += 60_001;
  reachable = true;
  assert.equal(rest.want(ctx.perceive()), 0.8);
  assert.equal((await rest.run(ctx)).ok, true);
  assert.equal(cleaned, 1);
  assert.equal(rest.want(ctx.perceive()), 0);
});

test('an inhabited closed shell uses wall and roof collision rather than building materials', () => {
  const cells = new Map();
  const key = ({ x, y, z }) => [x, y, z].join(',');
  const solid = name => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
  const bot = {
    entity: { position: new Vec3(2.5, 64, 2.5) },
    blockAt: p => cells.get(key(p)) ?? { name: 'air', boundingBox: 'empty', shapes: [] },
  };
  const goal = createHomesteadGoal({ bot, anchor: new Vec3(0, 64, 0), variant: 'compact' });
  const { house } = goal.memory;
  goal.memory.established = true;
  for (const { position, phase } of house.blocks) {
    cells.set(key(position), solid(phase === 'roof' ? 'cobblestone' : 'oak_planks'));
  }
  let open = false;
  cells.set(key(house.furniture.door.position), { name: 'oak_door', getProperties: () => ({ open }) });
  const site = goal.shelterSite();
  assert.equal(site.inside, true);
  assert.equal(site.covered(), true);

  const roof = key(house.blocks.find(block => block.phase === 'roof').position);
  cells.delete(roof);
  assert.equal(site.covered(), false);
  cells.set(roof, { ...solid('oak_slab'), shapes: [[0, 0, 0, 1, 0.5, 1]] });
  assert.equal(site.covered(), false);
  cells.set(roof, solid('sand'));
  assert.equal(site.covered(), false);
  cells.set(roof, solid('oak_planks'));
  assert.equal(site.covered(), true);
  open = true;
  assert.equal(site.covered(), false);
});
