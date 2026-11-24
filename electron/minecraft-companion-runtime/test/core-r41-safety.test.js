'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { BAND } = require('../core/brain');
const actions = require('../core/actions');
const { isRescueBehavior } = require('../core/action-reasons');
const { createNightRest } = require('../core/behaviors/nightRest');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { deathAtHome } = require('../core/companion');
const { createDirector } = require('../core/director');
const { createDoctor } = require('../core/doctor');
const { createFailureLedger } = require('../core/failure-ledger');
const { posKey } = require('../core/blacklist');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { digIn } = require('../core/skills');

for (const top of [new Vec3(236, 68, -16), new Vec3(247, 68, -2), new Vec3(-1, 16, 121)]) {
  test(`recorded R4 shaft at ${top} never claims a shelter after a missed drop`, async (t) => {
    // Seed 2 L2522–2523, L3411–3412; seed 3 L1637–1638.
    const opened = [], worldEdits = [], recentered = [];
    const bot = {
      entity: { position: top.offset(0.8, 0, 0.5), onGround: true },
      blockAt: p => ({ position: p, name: p.y < top.y ? 'dirt' : 'air',
        boundingBox: p.y < top.y ? 'block' : 'empty', diggable: true }),
      inventory: { items: () => [{ name: 'cobblestone', count: 2 }] },
      placeBlock: () => worldEdits.push('lid'),
    };
    t.mock.method(actions, 'recentre', async (_bot, _ctx, options) => {
      recentered.push(options.overEdge);
      bot.entity.position = top.offset(0.5, 0, 0.5);
    });
    t.mock.method(actions, 'digBlock', async (_bot, _ctx, block) => {
      assert.equal(bot.entity.position.x, top.x + 0.5);
      opened.push(block.position);
      return { ok: true };
    });
    let ms = 0;
    t.mock.method(Date, 'now', () => (ms += 2_000));
    const result = await digIn(bot, {});
    assert.equal(result.kind, 'start');
    assert.equal(result.reason, 'shelter_not_entered');
    assert.deepEqual(recentered, [false, true]);
    assert.deepEqual(opened, [top.offset(0, -1, 0)]);
    assert.deepEqual(worldEdits, []);
  });
}

test('night verifies a bunker and an interior at the next ten-second check and seeks cover again', async () => {
  const top = new Vec3(247, 68, -2);
  const bot = { entity: { position: top.offset(0.5, -3, 0.5) } };
  let ms = 0, inside = false, entries = 0, digs = 0;
  const actions = [], ctx = {
    perceive: () => ({ timeOfDay: 13_000 }),
    record: (_type, event) => actions.push(event.action),
  };
  const rest = createNightRest({
    bot, now: () => ms, home: () => ({ centre: inside ? top : null, inside }),
    shelterDoor: async () => { entries++; return { ok: true }; },
    skills: { digIn: async () => (++digs === 1 ? { ok: true, bunker: { top } } : { ok: false, reason: 'no_bunker_spot' }) },
  });
  await rest.run(ctx);
  bot.entity.position.y = top.y;
  ms += 9_999;
  assert.equal(rest.want(ctx.perceive()), 0.8);
  assert.equal(bot.companionSheltered, true);
  ms++;
  assert.equal(rest.want(ctx.perceive()), 0.8);
  assert.equal(bot.companionSheltered, false);
  inside = true;
  await rest.run(ctx);
  assert.equal(entries, 1);
  assert.equal(bot.companionSheltered, true);
  inside = false;
  ms += 10_000;
  assert.equal((await rest.run(ctx)).reason, 'no_bunker_spot');
  assert.equal(bot.companionSheltered, false);
  assert.deepEqual(actions, ['dig_in', 'dug_in', 'shelter_lost', 'shelter_lost', 'dig_in']);
});

test('seed 2 cactus contact captures its source and recentres without a new route', async () => {
  // L3031 body sample and L3033 death; cactus touches the body across the south edge.
  const source = new Vec3(249, 68, -2);
  const position = new Vec3(249.87673125209713, 68, -2.2375);
  const seen = [], decisions = [];
  let ms = 100;
  const ledger = createFailureLedger({ now: () => ms, emit: (type, fields) => seen.push({ type, ...fields }) });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position, onGround: true }, health: 4, entities: {},
    blockAt: p => p.equals(source) ? { name: 'cactus', boundingBox: 'block' }
      : p.y < position.y ? { name: 'sand', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    companionFailureLedger: ledger,
  });
  const behaviors = createSurvivalBehaviors({ bot, actions: {
    recentre: async () => { bot.entity.position = position.floored().offset(0.5, 0, 0.5); },
    goTo: () => assert.fail('the nearest safe stand is already reachable by centering'),
  } });
  const leave = behaviors.find(b => b.name === 'leave_contact');
  assert.equal(leave.band, BAND.ESCAPE);
  assert.equal(isRescueBehavior(leave.name), true);
  assert.equal(leave.want({ hostiles: [] }), 0);
  bot.health -= 1;
  bot.emit('health');
  assert.equal(leave.want({ hostiles: [{ name: 'zombie', distance: 4 }] }), 0);
  assert.equal(leave.want({ hostiles: [] }), 1);
  assert.equal((await leave.run({ record: (type, fields) => decisions.push({ type, ...fields }) })).ok, true);
  assert.deepEqual(decisions[0].position, source);
  assert.deepEqual(seen.filter(e => e.type === 'target_excluded').map(e => e.position), [{ ...source }]);
  assert.equal(ledger.contactMargin(position.floored(), 'overworld'), true);
  assert.equal(ledger.contactMargin(position.floored().offset(0, 4, 0), 'overworld'), false);
  ms += 600_000;
  assert.equal(ledger.contactMargin(position.floored(), 'overworld'), false);
  for (const b of behaviors) b.dispose?.();
});

test('the site ignores both seed 2 cactus deaths even if the cause packet arrives late', () => {
  const house = { anchor: { x: 249, y: 69, z: -31 }, size: 7 };
  const causes = [];
  const director = createDirector({ brain: {}, perceive: () => ({}), onOverworldDeath(death, deaths) {
    if (deathAtHome(house, death)) causes.push(deaths.filter(d => deathAtHome(house, d)).length);
  } });
  const first = { at: 1795456983233, dimension: 'overworld', position: { x: 249, y: 68, z: -3 }, night: true };
  director.noteDeath('was pricked to death', first); // L3033
  director.noteDeath(null, { ...first, at: 1795458146814 }); // L3931
  director.noteDeath('was pricked to death', { at: 1795458146814 });
  assert.deepEqual(causes, []);
  const site = { ...first, position: house.anchor, at: first.at + 1_300_000 };
  director.noteDeath('was shot by Skeleton', site);
  director.noteDeath(null, { ...site, at: site.at + 1000 });
  director.noteDeath('hit the ground too hard', { at: site.at + 1000 });
  assert.deepEqual(causes, [1, 2]);
  assert.equal(deathAtHome(house, { ...site, cause: 'was slain by Zombie', night: false }), false);
  assert.equal(deathAtHome(house, { ...site, cause: 'was slain by Player', night: true }), false);
  assert.equal(deathAtHome(house, { ...first, cause: 'drowned' }), false);
  assert.equal(deathAtHome(house, { ...site, cause: 'tried to swim in lava' }), true);
  assert.equal(deathAtHome(house, { ...first, cause: 'hit the ground too hard' }), false);
});

test('doctor emits a replayable warning before clearing a site with half its wall cells in place', async () => {
  const position = new Vec3(0, 64, 0), world = new Set(), seen = [];
  const bot = { entity: { position }, blockAt: p => world.has(posKey(p)) ? { name: 'cobblestone', boundingBox: 'block' } : null };
  const goal = createHomesteadGoal({ bot, anchor: position });
  goal.memory.pinned = false;
  goal.memory.relocate = true;
  const walls = goal.memory.house.blocks.filter(b => b.phase === 'walls');
  for (const b of walls.slice(0, Math.ceil(walls.length / 2))) world.add(posKey(b.position));
  const doctor = createDoctor();
  const input = [];
  const result = await goal.run({ perceive: () => ({}), record(type, fields) {
    const event = { type, at: 100, doctorSequence: input.length + 1, ...fields };
    input.push(event);
    seen.push(event, ...doctor.accept(event));
  } });
  assert.equal(result.abandoned, true);
  assert.deepEqual(seen.map(e => e.type), ['home_site_abandon_pending', 'doctor_alert', 'site_abandoned']);
  assert.equal(seen[1].rule, 'D10');
  const replay = createDoctor();
  assert.deepEqual(input.flatMap(e => replay.accept(e)), [seen[1]]);
});
