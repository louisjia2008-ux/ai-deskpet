'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createBrain, BAND } = require('../core/brain');
const { createHomeEscape } = require('../core/behaviors/homeEscape');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { createSelfStuck } = require('../core/self-stuck');
const { createDoctor } = require('../core/doctor');
const { abortError } = require('../core/confirm');
const actions = require('../core/actions');

function pocket({ shaft = false, protect = () => false } = {}) {
  // Recorded seed 1 L8469. The body is under a stone cap, with water at
  // head height and gravel backing the nearby submerged walls.
  const feet = new Vec3(34, 59, -4);
  const terrain = new Map();
  const put = (p, name) => terrain.set(p.toString(), name);
  const read = p => {
    const position = p.floored(), { x, y, z } = position;
    const name = terrain.get(position.toString()) || (x === 34 && z === -4 && y >= 59 && y <= (shaft ? 61 : 60) ? 'water'
      : (shaft ? x === 34 && z === -4 && y >= 63 : x === 36 && [59,60,61].includes(y)) ? 'air'
      : y < feet.y ? 'gravel' : 'stone');
    return { name, position, diggable: name !== 'air', boundingBox: ['water', 'air'].includes(name) ? 'empty' : 'block' };
  };
  const dug = [], placed = [];
  let look;
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 8 }];
  const bot = { entity: { position: feet.offset(0.5, 0.2, 0.5), isInWater: true, onGround: false },
    blockAt: read, companionPlayerBlock: protect, inventory: { items: () => items }, canDigBlock: () => true,
    async dig(block) {
      if (shaft) assert.equal(this.entity.onGround, true, 'stone is cut with confirmed footing');
      put(block.position, 'air');
      dug.push(block.position.toString());
    },
    async equip() {}, async lookAt(target) { look = target; },
    setControlState(key, on) {
      if (key === 'forward' && on && !shaft) {
        const p = new Vec3(Math.floor(look.x), feet.y, Math.floor(look.z));
        if (read(p).boundingBox === 'empty' && read(p.offset(0, 1, 0)).boundingBox === 'empty') {
          Object.assign(this.entity, { position: p.offset(0.5, 0, 0.5), onGround: true, isInWater: read(p).name === 'water' });
        }
      }
      if (key === 'jump' && on && shaft) this.entity.position = this.entity.position.floored().offset(0.5, 1.1, 0.5);
    },
    async placeBlock(ref, face) {
      const p = ref.position.plus(face);
      put(p, 'cobblestone');
      placed.push(p.toString());
      Object.assign(this.entity, { position: p.offset(0.5, 1, 0.5), onGround: !shaft, isInWater: read(p.offset(0, 1, 0)).name === 'water' });
      if (shaft) setTimeout(() => { this.entity.onGround = true; }, 60);
    },
  };
  return { bot, feet, dug, placed };
}

test('seed 1 water pocket can dig through gravel or rock to verified dry ground', async () => {
  const { bot, feet, dug } = pocket();
  assert.equal(await actions.digWaterExit(bot, { record() {} }), true);
  assert.deepEqual(dug, [feet.offset(1, 0, 0).toString(), feet.offset(1, 1, 0).toString()]);
  assert.ok(bot.entity.position.floored().equals(feet.offset(2, 0, 0)));
  assert.equal(bot.entity.isInWater, false);
  const protectedPocket = pocket({ protect: p => p.x === 35 });
  assert.equal(await actions.digWaterExit(protectedPocket.bot, { record() {} }), false);
  assert.deepEqual(protectedPocket.dug, []);
});

test('pillaring settles on a placed floor before cutting submerged stone', async () => {
  const { bot, feet, dug, placed } = pocket({ shaft: true });
  assert.equal(await actions.digWaterExit(bot, {}, { pillar: true }), true);
  assert.deepEqual(dug, [feet.offset(0, 3, 0).toString()]);
  assert.deepEqual(placed, [0, 1, 2, 3].map(y => feet.offset(0, y, 0).toString()));
  assert.ok(bot.entity.position.floored().equals(feet.offset(0, 4, 0)));
});

test('exhausted water rescue reports the methods that actually ran', async () => {
  const { bot } = pocket();
  const tracker = createSelfStuck(bot);
  tracker.force('route_origin_water');
  const attempted = [];
  const failMethod = method => async () => { attempted.push(method); return false; };
  const escape = createHomeEscape({ bot, tracker, home: () => null, actions: {
    stepOutOfPool: failMethod('step_out_of_pool'), swimAshore: failMethod('swim_ashore'),
    digWaterExit: (_bot, _ctx, options) => failMethod(options?.pillar ? 'pillar_up' : 'dig_exit')(),
  } });
  const outcome = await escape.run({ record() {} });
  assert.equal(outcome.reason, 'self_escape_unconfirmed');
  assert.equal(outcome.objective, 'dry_ground');
  assert.deepEqual(outcome.attempted, attempted);
  assert.equal(attempted.length, 4);
});

const turn = () => new Promise(resolve => setImmediate(resolve));

test('only critical air interrupts water rescue, then the same method resumes', async () => {
  const { bot, feet } = pocket();
  const tracker = bot.companionSelfStuck = createSelfStuck(bot);
  tracker.force('route_origin_water');
  let now = 10, oxygen = 12, digAttempts = 0;
  const trace = [];
  const record = (type, data) => trace.push({ type, ...data });
  const escape = createHomeEscape({ bot, tracker, home: () => null, now: () => now, actions: {
    stepOutOfPool: async () => false, swimAshore: async () => false,
    async digWaterExit(_bot, { signal }) {
      if (++digAttempts === 1) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }));
      Object.assign(bot.entity, { position: feet.offset(2.5, 0, 0.5), onGround: true, isInWater: false });
      return true;
    },
  } });
  const breathe = createSurvivalBehaviors({ bot }).find(b => b.name === 'breathe');
  bot.entity.isInWater = false;
  assert.equal(escape.rescue({ inWater: false }), true, 'feet are still in the flooded cell');
  bot.entity.isInWater = true;
  const perceive = () => ({ alive: true, inWater: bot.entity.isInWater, oxygen, health: 12, food: 16 });
  const brain = createBrain({ behaviors: [escape, { ...breathe, async run() { oxygen = 20; return { ok: true }; } }],
    perceive, now: () => now, onEvent: e => trace.push(e) });
  await brain.tick();
  await turn();
  assert.ok(trace.some(e => e.type === 'behavior_started' && e.behavior === 'home_escape' && e.band === BAND.ESCAPE));
  oxygen = 5;
  await brain.tick();
  assert.ok(!trace.some(e => e.type === 'preempted'));
  now += 2000;
  oxygen = 4;
  await brain.tick();
  await turn();
  await brain.tick();
  await turn();
  const dig = trace.filter(e => e.type === 'water_rescue_step' && e.method === 'dig_exit');
  assert.deepEqual(dig.map(r => [r.phase, r.elapsedMs]), [['start', 0], ['resume', 2000]]);
  assert.equal(dig[0].episode, dig[1].episode);
  assert.ok(trace.some(e => e.type === 'preempted' && e.by === 'breathe'));
  assert.equal(tracker.state(), null);
});

test('the seventh interruption advances the water rescue and emits a replayable Doctor alert', async () => {
  const { bot } = pocket();
  const tracker = bot.companionSelfStuck = createSelfStuck(bot);
  tracker.force('route_origin_water');
  let now = 0;
  const steps = [];
  const escape = createHomeEscape({ bot, tracker, home: () => null, now: () => now, actions: {
    stepOutOfPool: async (_bot, { signal }) => {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }));
    },
  } });
  for (let n = 0; n < 7; n++) {
    const stop = new AbortController();
    const run = escape.run({ signal: stop.signal, record: (type, data) => steps.push({ type, at: now, ...data }) });
    await turn();
    now += 100;
    stop.abort('preempted_by:breathe');
    await assert.rejects(run, { code: 'aborted' });
  }
  await escape.run({ record: (type, data) => steps.push({ type, at: now, ...data }) });
  const alert = steps.find(r => r.type === 'water_rescue_alert');
  assert.deepEqual([alert.count, alert.reason], [7, 'preemption_limit']);
  assert.ok(steps.some(r => r.phase === 'advance' && r.next === 'swim_ashore'));
  const doctor = createDoctor();
  const alerts = steps.flatMap(event => doctor.accept(event));
  assert.ok(alerts.some(r => r.rule === 'D12'));
});
