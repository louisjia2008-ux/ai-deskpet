const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDoctor } = require('../core/doctor');

const home = 'goal:homestead';
const point = (x, z = 0) => ({ x, y: 64, z });
const observed = { type: 'doctor_observation', position: point(0), dimension: 'overworld', isDay: true, inventory: {} };

function exercise(rule) {
  const doctor = createDoctor();
  const events = [];
  let line = 0;
  return {
    ingest(seconds, row) {
      events.push(...doctor.accept({ ...row, at: seconds * 1000 }, ++line).filter((alert) => alert.rule === rule));
    },
    active() { return doctor.getStatus().active.some((event) => event.rule === rule); },
    events,
  };
}

function place(study, seconds, offset, ok) {
  study.ingest(seconds, { type: 'build', what: 'wall', position: point(offset), behavior: home, generation: 1 });
  study.ingest(seconds + 1, { type: 'behavior_finished', behavior: home, generation: 1,
    ok, reason: ok ? null : 'no_material' });
}

const shortagePlan = { type: 'plan_step', kind: 'gather', key: 'cobblestone', for: 'cobblestone',
  behavior: home, count: 1, generation: 1 };

test('D2 distinguishes persistent local supply failure from ordinary wall replenishment', () => {
  const study = exercise('D2');
  place(study, 0, 3, false);
  place(study, 20, 3, true);
  place(study, 90, 7, false);
  place(study, 105, 7, true);
  place(study, 170, 1, false);
  study.ingest(171, { type: 'adaptation_attempt', task: 'goal', outcome: 'failure',
    reason: 'no_material', position: point(1) });
  study.ingest(172, shortagePlan);
  study.ingest(190, { ...shortagePlan, count: 2 });
  study.ingest(211, { ...shortagePlan, count: 2 });
  assert.equal(study.events.length, 0);
  study.ingest(221, { ...shortagePlan, count: 2 });
  assert.equal(study.events.length, 1);
  assert.deepEqual(study.events[0].evidence, [2, 6, 10, 13, 15]);
  place(study, 225, 1, true);
  assert.equal(study.active(), false);
});

test('D2 separates nearby route targets and retains active route failures through an old shelter mark', () => {
  const study = exercise('D2');
  const oldRoute = { type: 'adaptation_attempt', outcome: 'failure', task: 'route', reason: 'path_timeout',
    method: 'waypoint', position: point(3), target: 'walk', dimension: 'overworld', region: '0,0,0' };
  study.ingest(0, observed);
  study.ingest(10, { ...oldRoute, key: 'first-target' });
  study.ingest(20, { ...oldRoute, key: 'second-target' });
  study.ingest(30, oldRoute);
  study.ingest(31, { ...observed, isDay: false, sheltered: true });
  study.ingest(44, oldRoute);
  assert.equal(study.events.length, 0);
  study.ingest(59, oldRoute);
  assert.deepEqual(study.events[0].evidence, [4, 6, 7]);
  study.ingest(60, { ...observed, isDay: false, paused: true });
  assert.equal(study.active(), false);
});

test('D2 counts distinct attempts even when a target-failure duplicate arrives out of order', () => {
  const study = exercise('D2');
  const failure = { type: 'target_failure', goal: 'homestead', key: 'wall-cell', reason: 'not_arrived', position: point(3) };
  study.ingest(10, { ...failure, failureAt: 10_000 });
  study.ingest(20, { ...failure, failureAt: 20_000 });
  study.ingest(30, { ...failure, failureAt: 10_000 });
  assert.equal(study.events.length, 0);
  study.ingest(40, { ...failure, failureAt: 40_000 });
  assert.deepEqual(study.events[0].evidence, [1, 2, 4]);
});

test('D3 needs correlated failures and pauses for real route progress', () => {
  const study = exercise('D3');
  const plan = { ...shortagePlan, key: 'raw_iron', for: 'iron_ingot' };
  const failure = { type: 'behavior_finished', behavior: home, generation: 1, ok: false, reason: 'path_timeout' };
  study.ingest(0, observed);
  for (let i = 0; i < 4; i++) study.ingest(i * 10 + 1, plan);
  assert.equal(study.events.length, 0);
  study.ingest(39, { ...failure, generation: 2 });
  for (let i = 0; i < 3; i++) {
    study.ingest(i * 10 + 40, plan);
    study.ingest(i * 10 + 47, failure);
  }
  study.ingest(67.5, { type: 'home_route_leg', advanced: true, behavior: home, generation: 1 });
  study.ingest(68, plan);
  assert.equal(study.events.length, 0);
});

test('D3 counts aborts only against a corroborated construction shortage', () => {
  for (const hasShortage of [false, true]) {
    const study = exercise('D3');
    study.ingest(0, observed);
    if (hasShortage) place(study, 1, 2, false);
    for (let i = 0; i < 4; i++) {
      study.ingest(i * 11 + 3, shortagePlan);
      study.ingest(i * 11 + 8, { type: 'behavior_finished', behavior: home, generation: 1,
        ok: false, reason: 'aborted' });
    }
    assert.equal(study.events.length, Number(hasShortage));
    if (hasShortage) assert.ok(study.events[0].evidence.includes(3));
    study.ingest(45, { ...observed, inventory: { cobblestone: 1 } });
    assert.equal(study.active(), false);
  }
});
