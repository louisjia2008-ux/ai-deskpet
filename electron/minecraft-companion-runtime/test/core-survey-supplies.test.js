'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const actions = require('../core/actions');
const { abortError } = require('../core/confirm');
const { createSurveyPlanGoal } = require('../core/goals/surveyPlan');
const { createSurveyInventory, createSurveySupplies } = require('../core/survey-supplies');

test('resumed survey returns borrowed stock after a partial withdrawal and keeps pre-plan items', async (t) => {
  const chestPos = new Vec3(1, 64, 0);
  const log = { name: 'oak_log', type: 1, count: 2, stackSize: 64, metadata: 0, nbt: null };
  const hoe = { name: 'stone_hoe', type: 2, count: 1, stackSize: 1, metadata: 0, nbt: null };
  const bot = { entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => items },
    blockAt: () => ({ name: 'chest' }), currentWindow: null, clickWindow() {} };
  let items = [log];
  const plan = { supplyChest: chestPos };
  const state = createSurveyInventory(bot);
  const deposits = [];
  const interrupted = new AbortController();
  const window = {
    inventoryStart: 4, inventoryEnd: 8,
    slots: [hoe, null, null, null, log, null, null, null],
    close() { bot.currentWindow = null; },
    containerItems() { return this.slots.slice(0, this.inventoryStart).filter(Boolean); },
    async withdraw(type, _metadata, count) {
      assert.equal(type, hoe.type);
      assert.equal(count, 1);
      assert.equal(state.borrowed.has(hoe.name), true, 'the pending withdrawal must already have an owner');
      items = [log, hoe];
      interrupted.abort('disconnect');
      throw abortError(interrupted.signal);
    },
    async deposit(type, _metadata, count) { deposits.push([type, count]); },
  };
  t.mock.method(actions, 'openSurveyChest', async () => { bot.currentWindow = window; return window; });
  const original = createSurveySupplies(bot, plan, state);
  const till = { target: 'minecraft:farmland[moisture=0]' };
  await assert.rejects(original.ensure({ signal: interrupted.signal }, [[till]]), { code: 'aborted' });
  assert.equal(bot.currentWindow, null);

  const gathered = { ...log, count: 5 };
  items = [gathered, hoe];
  window.slots = [null, null, null, null, gathered, hoe, null, null];
  const resumed = createSurveySupplies(bot, plan, state);
  assert.deepEqual(await resumed.putBack({ signal: new AbortController().signal }), { ok: true });
  assert.deepEqual(deposits, [[log.type, 3], [hoe.type, 1]]);
});

test('a recompiled goal recomputes its material wait from new operations and carried stock', async () => {
  const bot = new EventEmitter();
  bot.inventory = { items: () => [] };
  bot.time = { timeOfDay: 0 };
  bot.blockAt = () => ({ name: 'air' });
  const supplyInventory = createSurveyInventory(bot);
  // One block taken under the previous authorization remains in the bag.
  supplyInventory.borrowed.add('cobblestone');
  bot.inventory.items = () => [{ name: 'cobblestone', count: 1 }];
  const ops = [1, 2, 3].map((x, order) => ({ pos: new Vec3(x, 64, 0), expect: 'minecraft:air',
    target: 'minecraft:cobblestone', kind: 'build', phase: 'walls', order }));
  const plan = { revision: 2, ops, materials: { required: { 'minecraft:cobblestone': 3 } }, supplyChest: null };
  const revoke = new AbortController();
  let waiting;
  const goal = createSurveyPlanGoal({ bot, plan, supplyInventory, grant: {
    signal: revoke.signal,
    applied: () => null,
    blocked(reason, _pos, detail) { assert.fail(`${reason}: ${detail}`); },
    state(phase, reason, missing) {
      if (reason === 'materials') {
        waiting = { phase, missing };
        revoke.abort('test complete');
      }
    },
  } });
  await assert.rejects(goal.run({}), { code: 'aborted' });
  assert.deepEqual(waiting, { phase: 'walls', missing: { 'minecraft:cobblestone': 2 } });
});
