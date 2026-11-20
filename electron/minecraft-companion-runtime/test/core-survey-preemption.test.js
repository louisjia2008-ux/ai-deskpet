'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Vec3 } = require('vec3');
const actions = require('../core/actions');
const placement = require('../core/survey-placement');

test('survey resumes after survival preemption even when a placement acknowledgment arrives late', async (t) => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(2, 64, 2) };
  bot.inventory = { items: () => [{ name: 'dirt', count: 2 }] };
  bot.time = { timeOfDay: 1000 };
  const blocks = new Map();
  const posKey = ({ x, y, z }) => `${x},${y},${z}`;
  bot.blockAt = (pos) => ({ name: blocks.get(posKey(pos)) || 'air' });

  const ops = [0, 1].map((x, order) => ({
    pos: { x, y: 64, z: 0 }, target: 'minecraft:dirt', expect: 'minecraft:air', kind: 'fill', phase: 'terrain', order,
  }));
  const seen = new Map();
  const sent = [];
  const progress = [];
  const grantAbort = new AbortController();
  const interrupted = new AbortController();
  let result = null;
  let settlements = 0;
  const grant = {
    signal: grantAbort.signal,
    get result() { return result; },
    applied: (pos) => seen.get(posKey(pos)),
    misplacement: () => null,
    state: () => {},
    progress: (completed) => progress.push(completed),
    blocked: (reason) => assert.fail(reason),
    settled() {
      settlements++;
      result = { status: 'completed' };
      grantAbort.abort('completed');
    },
  };
  function apply(pos, current = 'dirt') {
    seen.set(posKey(pos), { positions: [pos] });
    blocks.set(posKey(pos), current);
  }

  t.mock.method(actions, 'withSurveyStep', (_bot, ctx, _step, run) => run(ctx));
  t.mock.method(placement, 'hitFor', (_bot, step) => ({ key: posKey(step[0].pos) }));
  t.mock.method(placement, 'aimAndPlace', async (_bot, _ctx, target) => {
    sent.push(posKey(target));
    if (target.x === 0) setImmediate(() => interrupted.abort('preempted_by:defend'));
    else apply(target);
    return { ok: true };
  });

  const { createSurveyPlanGoal } = require('../core/goals/surveyPlan');
  const goal = createSurveyPlanGoal({ bot, plan: { ops, groundY: 65, template: {}, supplyChest: null }, grant });
  await assert.rejects(goal.run({ signal: interrupted.signal }), { code: 'aborted' });
  assert.deepEqual(progress, []);
  const late = setTimeout(() => apply(ops[0].pos, 'grass_block'), 70);
  try {
    await assert.rejects(goal.run({ signal: new AbortController().signal }), { code: 'aborted' });
  } finally {
    clearTimeout(late);
  }
  assert.deepEqual(sent, ['0,64,0', '1,64,0']);
  assert.deepEqual(progress, [1, 2]);
  assert.equal(settlements, 1);
  assert.equal(goal.isDone(), true);
});
