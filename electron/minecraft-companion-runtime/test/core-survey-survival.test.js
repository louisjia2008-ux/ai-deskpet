'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { Vec3 } = require('vec3');
const { createBrain, BAND } = require('../core/brain');
const { createCompanion } = require('../core/companion');
const { createSurvivalBehaviors, enabledDuringSurvey } = require('../core/behaviors/survival');
const { sleep } = require('../core/confirm');
const { factsOf } = require('../core/action-result');

const site = { x: 0.5, z: 0.5 };
const origin = new Vec3(0.5, 64, 0.5);
const context = (state) => ({ signal: new AbortController().signal, perceive: () => state, record() {} });

function setup(items = []) {
  return Object.assign(new EventEmitter(), {
    entity: { position: origin.clone() },
    entities: {},
    inventory: { items: () => items, slots: [] },
    blockAt: () => null,
    game: { difficulty: 'normal' },
    registry: { foodsByName: { bread: { foodPoints: 5 }, chorus_fruit: { foodPoints: 20 } } },
  });
}

test('survey only schedules non-mutating reflexes and joins one action before restarting construction', async () => {
  assert.deepEqual(['escape', 'defend', 'eat', 'heal', 'recover', 'quench', 'block', 'survey_archer',
    'night_rest', 'danger_bunker', 'unstick', 'unbury', 'recover_drops', 'provision', 'home_maintenance']
    .filter((name) => enabledDuringSurvey({ name })), ['escape', 'defend', 'eat', 'heal', 'recover', 'quench', 'block', 'survey_archer']);
  const runs = [];
  let threatened = false;
  const brain = createBrain({
    perceive: () => ({ alive: true, threatened }),
    permanentEnabled: enabledDuringSurvey,
    behaviors: [
      { name: 'danger_bunker', band: BAND.ESCAPE, want: () => 1, run: () => { throw Error('digging fallback ran'); } },
      { name: 'defend', band: BAND.DEFENSE, want: (state) => Number(state.threatened),
        run: () => { runs.push('defense'); threatened = false; } },
    ],
  });
  try {
    brain.setGoal({ name: 'survey', isDone: () => false, progress: () => 0, async run(ctx) {
      runs.push('construction');
      try {
        await sleep(15000, ctx.signal);
      } finally {
        runs.push(ctx.signal.reason);
      }
    } });
    await brain.tick();
    threatened = true;
    await brain.tick();
    await nextTurn();
    assert.deepEqual(runs, ['construction', 'preempted_by:defend', 'defense', 'construction']);
    assert.equal(brain.status().goal.stalls, 0);
  } finally {
    await brain.dispose();
  }
});

test('survey defense and escape filter path detours and restore the original movement function', async () => {
  const bot = setup();
  const inner = { x: 14, y: 64, z: 0 };
  const outer = { x: 16, y: 64, z: 0 };
  const farther = { x: 18, y: 64, z: 0 };
  const original = function () { assert.equal(this, bot.pathfinder.movements); return [inner, outer, farther]; };
  bot.pathfinder = { movements: { companionWalkOnly: true, getNeighbors: original } };
  const target = { id: 10, name: 'spider', distance: 2, position: origin.offset(0, 0, 2) };
  const state = { alive: true, health: 4, food: 20, position: origin, hostiles: [target], inventory: {} };
  const calls = [];
  const checkRoute = () => {
    assert.deepEqual(bot.pathfinder.movements.getNeighbors({ x: 15, y: 64, z: 0 }), [inner]);
    assert.deepEqual(bot.pathfinder.movements.getNeighbors({ x: 17, y: 64, z: 0 }), [inner, outer]);
  };
  const behaviors = createSurvivalBehaviors({ bot, surveyArea: () => site,
    actions: {
      async attack(_bot, _ctx, id, { canPursue }) {
        assert.equal(id, target.id);
        assert.equal(canPursue(inner), true);
        assert.equal(canPursue(outer), false);
        checkRoute();
        calls.push('defend');
        return { ok: true, died: true };
      },
      async goTo(_bot, _ctx, goal, options) {
        checkRoute();
        assert.equal(goal.isEnd({ x: 17, y: 64, z: 0 }), false);
        assert.equal(goal.isEnd({ x: -10, y: 64, z: 0 }), true);
        assert.equal(options.retryNoProgress, false);
        calls.push('escape');
        return { ok: true };
      },
      collectDrops() { assert.fail('defense left the site to retrieve drops'); },
    },
  });
  const named = (name) => behaviors.find((behavior) => behavior.name === name);
  assert.equal(named('escape').want(state), 1);
  assert.equal((await named('escape').run(context(state))).ok, true);
  assert.equal(bot.pathfinder.movements.getNeighbors, original);
  assert.equal((await named('defend').run(context(state))).ok, true);
  assert.equal(bot.pathfinder.movements.getNeighbors, original);
  assert.deepEqual(calls, ['escape', 'defend']);
});

test('survey hunger uses a safe owned food item and waits for server-visible food and inventory', async () => {
  const fruit = { name: 'chorus_fruit', count: 1 };
  const bread = { name: 'bread', count: 2 };
  const bot = setup([fruit, bread]);
  let released = false;
  bot.food = 6;
  bot.health = 20;
  bot.equip = async (item) => { assert.equal(item, bread); };
  bot.activateItem = () => { bread.count -= 1; bot.food = 11; };
  bot.deactivateItem = () => { released = true; };
  bot.consume = () => { assert.fail('survey use must release on preemption immediately'); };
  const state = { alive: true, health: 20, food: 6, position: origin, hostiles: [], inventory: { bread: 2, chorus_fruit: 1 } };
  const eat = createSurvivalBehaviors({ bot, surveyArea: () => site }).find(({ name }) => name === 'eat');
  assert.equal(eat.want(state), 1);
  const result = await eat.run(context(state));
  assert.deepEqual(result, { ok: true, progress: true });
  assert.equal(factsOf(result).ate, 'bread');
  assert.equal(released, true);
  assert.equal(fruit.count, 1);
  assert.equal(bread.count, 1);
});

test('survey responds to the real archer at low health and shields against a shooter outside the leash', async () => {
  const bot = setup();
  const nearbySpider = { id: 1, name: 'spider', distance: 3, position: origin.offset(0, 0, 3) };
  const shooter = { id: 2, name: 'skeleton', position: origin.offset(12, 0, 0) };
  bot.entities = { [nearbySpider.id]: nearbySpider, [shooter.id]: shooter };
  bot.pathfinder = { movements: { companionWalkOnly: true, getNeighbors: () => [] } };
  const state = { alive: true, health: 4, food: 20, position: origin, hostiles: [nearbySpider], inventory: { iron_sword: 1 } };
  let area = site;
  const calls = [];
  const behaviors = createSurvivalBehaviors({ bot, surveyArea: () => area, actions: {
    async attack(_bot, _ctx, id, { canPursue }) {
      assert.equal(id, shooter.id);
      assert.equal(canPursue(shooter.position), true);
      calls.push('attack');
      return { ok: true };
    },
  } });
  const archer = behaviors.find(({ name }) => name === 'survey_archer');
  assert.equal(archer.want(state), 0);
  bot.emit('entityHurt', bot.entity, shooter);
  assert.ok(archer.band > behaviors.find(({ name }) => name === 'escape').band);
  assert.equal(archer.want(state), 1);
  await archer.run(context(state));

  shooter.position = origin.offset(18, 0, 0);
  bot.inventory.slots[45] = { name: 'shield' };
  const controller = new AbortController();
  bot.lookAt = async (point) => { assert.equal(point.x, shooter.position.x); };
  bot.activateItem = (offhand) => {
    assert.equal(offhand, true);
    calls.push('shield');
    controller.abort('test_stop');
  };
  bot.deactivateItem = () => calls.push('release');
  await assert.rejects(archer.run({ ...context(state), signal: controller.signal }), { code: 'aborted' });
  assert.deepEqual(calls, ['attack', 'shield', 'release']);
  area = null;
  assert.equal(archer.want(state), 0);
});

for (const deathFirst of [true, false]) {
  test(`survey death suppresses drop recovery when ${deathFirst ? 'Minecraft death' : 'Mod revocation'} arrives first`, async () => {
    const bot = Object.assign(setup(), {
      health: 20,
      food: 20,
      time: { timeOfDay: 1000 },
      registry: require('prismarine-registry')('1.21.8'),
      _client: { write() {} },
      pathfinder: { setMovements(movements) { this.movements = movements; }, setGoal() {} },
    });
    const originalWrite = bot._client.write;
    const events = [];
    const companion = createCompanion({ bot, tickMs: 60000, onEvent: (event) => events.push(event) });
    const grant = new AbortController();
    const death = () => { bot.health = 0; bot.emit('death'); };
    try {
      await companion.prepareSurveyPlan({ selection: { minX: 0, maxX: 6, minZ: 0, maxZ: 6 }, ops: [] }, grant);
      if (deathFirst) death();
      grant.abort('bot_died');
      await companion.stopSurveyPlan(grant, 'bot_died');
      assert.equal(bot._client.write, originalWrite);
      if (!deathFirst) death();
      bot.health = 20;
      bot.emit('spawn');
      await companion.brain.tick();
      assert.equal(events.some((event) => event.behavior === 'recover_drops'), false);

      death();
      bot.health = 20;
      bot.emit('spawn');
      await companion.brain.tick();
      assert.equal(events.some((event) => event.type === 'behavior_started' && event.behavior === 'recover_drops'), true);
    } finally {
      await companion.dispose();
    }
  });
}
