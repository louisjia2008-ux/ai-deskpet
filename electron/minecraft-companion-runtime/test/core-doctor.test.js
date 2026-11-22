'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDoctor, D1, RECENT_LIMIT } = require('../core/doctor');

const initial = { x: 4, y: 60, z: 7 };
const home = { anchor: { x: 3, y: 60, z: 6 }, size: 5 };

function observe(doctor, at, extras = {}) {
  return doctor.accept({ type: 'doctor_observation', at, dimension: 'overworld', position: initial,
    alive: true, isDay: true, inventory: {}, ...extras }, at / D1.sampleIntervalMs + 1);
}

function d1(alerts) {
  return alerts.filter(a => a.rule === 'D1');
}

test('D1 warns after 150 s, escalates after 300 s, and closes when the bot moves', () => {
  const spans = [];
  const doctor = createDoctor({ onStationarySegment: span => spans.push(span) });
  doctor.accept({ type: 'goal_set', at: 0, goal: 'homestead' });
  doctor.accept({ type: 'plan_step', at: 0, kind: 'gather', key: 'cobblestone' });
  const alerts = [];
  for (let i = 0; i <= 10; i += 1) alerts.push(...observe(doctor, i * 30_000, { home, timeOfDay: 8000 }));
  const stationary = d1(alerts);
  assert.deepEqual(stationary.map(a => [a.severity, a.since, a.at]), [['warn', 0, 150_000], ['alert', 0, 300_000]]);
  assert.deepEqual(stationary[1].evidence, [1, 11]);
  assert.equal(stationary[1].context.goal, 'homestead');
  assert.equal(stationary[1].context.step.key, 'cobblestone');
  assert.deepEqual(stationary[1].context.home, home);
  assert.equal(stationary[1].context.timeOfDay, 8000);
  assert.equal(d1(doctor.getStatus().active)[0].severity, 'alert');

  observe(doctor, 330_000, { position: { ...initial, y: 62 } });
  assert.deepEqual(d1(doctor.getStatus().active), []);
  assert.equal(d1(doctor.getStatus().recent).length, 2);
  assert.deepEqual(spans, [{ at: 0, finish: 300_000, position: initial, cards: ['无卡片'] }]);
  doctor.finish();
  assert.equal(spans.length, 1);
});

test('D1 exempts documented waiting and breaks continuity across missing samples', () => {
  for (const [goal, extras] of [
    ['homestead', { isDay: false, sleeping: true, home }],
    ['homestead', { isDay: false, sheltered: true }],
    ['follow_owner', { ownerPosition: initial }],
    ['survey_plan', {}],
    ['homestead', { paused: true }],
  ]) {
    const doctor = createDoctor();
    doctor.accept({ type: 'goal_set', at: 0, goal });
    for (let i = 0; i <= 11; i += 1) assert.deepEqual(d1(observe(doctor, i * 30_000, extras)), []);
  }
  const doctor = createDoctor();
  for (let i = 0; i < 10; i += 1) {
    if (i !== 4) assert.deepEqual(d1(observe(doctor, i * 30_000)), []);
  }
  assert.equal(doctor.missingStationarySamples(), 1);
});

test('D1 requires an inventory change for mining and treats outdoor sleeping as suspect', () => {
  const doctor = createDoctor();
  for (let i = 0; i <= 11; i += 1) {
    assert.deepEqual(d1(observe(doctor, i * 30_000, { inventory: { cobblestone: i }, mining: 'stone' })), []);
  }
  doctor.reset();
  for (let i = 0; i < 10; i += 1) observe(doctor, i * 30_000, { isDay: false, sleeping: true, mining: 'stone' });
  assert.equal(d1(observe(doctor, 300_000, { isDay: false, sleeping: true, mining: 'stone' }))[0].severity, 'alert');
});

test('doctor retains bounded history and its public reports are detached from input and internal state', () => {
  const doctor = createDoctor();
  for (let n = 0; n < RECENT_LIMIT * 2; n += 1) {
    for (let i = 0; i <= 10; i += 1) observe(doctor, (n * 11 + i) * 30_000,
      { position: { x: 10 * n, y: 60, z: 0 } });
  }
  assert.equal(doctor.size().recent, RECENT_LIMIT);
  assert.ok(doctor.size().active <= 8);
  assert.ok(doctor.size().stationary <= 2);
  const snapshot = doctor.getStatus();
  snapshot.active[0].context.position.x = -123;
  snapshot.recent.pop();
  assert.notEqual(doctor.getStatus().active[0].context.position.x, -123);
  assert.equal(doctor.getStatus().recent.length, RECENT_LIMIT);
});

test('doctor depends only on its diagnostic modules and accepts frozen data', () => {
  const directory = path.dirname(require.resolve('../core/doctor'));
  for (const file of ['doctor.js', 'doctor-stationary.js', 'doctor-rules.js']) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const dependency of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)) {
      assert.ok(['./doctor-stationary', './doctor-rules'].includes(dependency[1]), `${file}: ${dependency[1]}`);
    }
    assert.doesNotMatch(source, /\bimport\b|\b(eval|Function)\s*\(/);
  }
  const doctor = createDoctor();
  const payload = Object.freeze({ type: 'doctor_observation', at: 0, position: Object.freeze(initial), isDay: true,
    inventory: Object.freeze({ cobblestone: 1 }) });
  assert.doesNotThrow(() => doctor.accept(payload, 1));
});
