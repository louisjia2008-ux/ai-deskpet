'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { createDoctor } = require('../core/doctor');
const { createBrain } = require('../core/brain');

function tunnel({ flee, place } = {}) {
  const mob = { id: 1, name: 'zombie', position: new Vec3(4.5, 52, 0.5) };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 52, 0.5), onGround: true },
    entities: { 1: mob }, health: 5,
    inventory: { items: () => [{ name: 'cobblestone', count: 1 }] },
    registry: {},
  });
  const records = [], solid = { name: 'stone', boundingBox: 'block' }, air = { name: 'air', boundingBox: 'empty' };
  let wall = null, fleeCount = 0;
  bot.blockAt = p => p.z || p.y < 52 || p.y > 53 || wall?.equals(p) ? solid : air;
  const behaviors = createSurvivalBehaviors({ bot,
    actions: { async nudge(_bot, _ctx, { accept }) {
      const here = bot.entity.position.floored();
      assert.equal(accept(here.offset(1, 0, 0)), false, 'a retreat cannot step towards the threat in a narrow shaft');
      assert.equal(accept(here.offset(-1, 0, 0)), true);
      fleeCount++;
      await flee?.(bot);
      return true;
    } },
    skills: { async placeAt(_bot, _ctx, p) { if (place !== false) wall = p; return { ok: place !== false }; } },
  });
  const ctx = { perceive: () => ({ alive: true, health: bot.health, inventory: {},
    position: bot.entity.position, hostiles: [{ ...mob, distance: mob.position.distanceTo(bot.entity.position) }] }),
  record(type, fields) { records.push({ type, at: Date.now(), ...fields }); } };
  const get = name => behaviors.find(behavior => behavior.name === name);
  return { bot, ctx, records, escape: get('escape'), fallback: get('escape_fallback'), fled: () => fleeCount };
}

test('seed 1 mine retreat escalates after the two unconfirmed paths observed before L8744', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { bot, ctx, records, escape, fallback, fled } = tunnel();
  for (const duration of [3793, 3144]) {
    assert.equal(escape.want(ctx.perceive()), 1);
    const result = await escape.run(ctx);
    assert.equal(result.reason, 'escape_not_clear');
    assert.equal(result.kind, 'environment');
    assert.equal(result.facts.startDistance, result.facts.endDistance);
    assert.equal(result.facts.corridorWidth, 1);
    t.mock.timers.tick(duration);
  }
  assert.equal(escape.want(ctx.perceive()), 0);
  assert.equal(fallback.want(ctx.perceive()), 1);
  assert.equal((await fallback.run(ctx)).ok, true);
  assert.equal(bot.blockAt(new Vec3(1, 52, 0)).boundingBox, 'block');
  assert.equal(records.at(-1).method, 'block_passage');
  assert.equal(fled(), 2);
  assert.equal(escape.want(ctx.perceive()), 0);
  assert.equal(fallback.want(ctx.perceive()), 0);
});

test('escape checks the current threat and rejects a recent hit even after moving away', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { bot, ctx, escape } = tunnel({ flee(bot) {
    bot.entity.position = bot.entity.position.offset(-3, 0, 0);
  } });
  bot.health = 4;
  bot.emit('health');
  assert.equal((await escape.run(ctx)).reason, 'escape_not_clear');
  t.mock.timers.tick(2000);
  assert.equal((await escape.run(ctx)).ok, true);
});

test('an unconfirmed fallback creates a doctor alert and never reopens escape for the same nearby mob', async () => {
  const { ctx, records, escape, fallback } = tunnel({ place: false });
  await escape.run(ctx);
  await escape.run(ctx);
  assert.equal((await fallback.run(ctx)).reason, 'escape_not_clear');
  assert.equal(escape.want(ctx.perceive()), 0);
  assert.equal(fallback.want(ctx.perceive()), 0);
  const doctor = createDoctor();
  assert.ok(records.flatMap(record => doctor.accept(record)).some(record => record.rule === 'D13'));
});

test('a failed narrow retreat rechecks before the throat can be occupied', async t => {
  let clock = 1000;
  const { ctx, escape, fallback, fled } = tunnel();
  const brain = createBrain({ perceive: ctx.perceive, behaviors: [escape, fallback], now: () => clock });
  t.after(() => brain.dispose());
  const tick = async () => {
    await brain.tick();
    await new Promise(resolve => setImmediate(resolve));
  };

  await tick();
  assert.equal(fled(), 1);
  assert.equal(brain.status().cooldowns.find(entry => entry.name === 'escape').until, 1100);
  clock = 1099;
  await tick();
  assert.equal(fled(), 1);
  clock = 1100;
  await tick();
  assert.equal(fled(), 2);
  assert.equal(escape.retryDelayMs({ reason: 'escape_not_clear', facts: { corridorWidth: 2 } }), undefined);
});
