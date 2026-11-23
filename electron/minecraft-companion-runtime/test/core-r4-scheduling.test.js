'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBrain, BAND } = require('../core/brain');
const { maintenanceUrgency, schedulingInputs } = require('../core/scheduling');

const runUntilPreempted = ({ signal }) => new Promise((resolve) => {
  signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }), { once: true });
});
const goal = (name) => ({ name, isDone: () => false, progress: () => 0, run: runUntilPreempted });
const chore = (name, want = () => 1) => ({ name, band: BAND.MAINTENANCE, want, run: runUntilPreempted });

test('R2 seed 2, L1363 and L1377: provisioning yields to a return already in progress', async () => {
  let state = { food: 18, health: 13, isDay: true, timeOfDay: 10_400, position: { x: -25, y: 63, z: -4 } };
  const brain = createBrain({ perceive: () => state, behaviors: [chore('provision', s => s.food <= 12)],
    schedule: (s, details) => schedulingInputs(s, { ...details, home: { x: 0, y: 72, z: 0 } }) });
  brain.setGoal(goal('return_and_store'));
  await brain.tick();
  assert.equal(brain.status().running, 'goal:return_and_store');
  state = { ...state, food: 11, timeOfDay: 11_500 };
  await brain.tick();
  assert.equal(brain.status().running, 'goal:return_and_store');
  await brain.dispose();
});

test('R2 seed 1, L2563: dusk shelter can take over a guest-bed hunt even when provisioning wants the body', async () => {
  let state = { food: 18, health: 20, isDay: true, timeOfDay: 10_400, position: { x: 22, y: 76, z: 0 } };
  const brain = createBrain({ perceive: () => state, behaviors: [
    chore('provision', s => s.food <= 12), chore('night_rest', s => s.timeOfDay >= 10_800 ? 0.8 : 0),
  ] });
  brain.setGoal(goal('guest_bed'));
  await brain.tick();
  assert.equal(brain.status().running, 'goal:guest_bed');
  state = { ...state, timeOfDay: 11_700, food: 10 };
  await brain.tick();
  assert.equal(brain.status().running, 'night_rest');
  assert.equal(brain.status().goal.name, 'guest_bed');
  await brain.dispose();
});

test('one ready step can hold off moderate hunger and the survival tier still interrupts', async () => {
  let state = { food: 15, health: 20 };
  const brain = createBrain({ perceive: () => state, behaviors: [chore('eat')] });
  brain.setGoal({ ...goal('build'), work: () => ({ remaining: 1, ready: true }) });
  await brain.tick();
  assert.equal(brain.status().running, 'goal:build');
  state = { ...state, food: 6 };
  await brain.tick();
  assert.equal(brain.status().running, 'eat');
  await brain.dispose();
});

test('provision scores are reduced when the return cost rises', () => {
  const home = { x: 0, y: 65, z: 0 };
  const pressure = x => maintenanceUrgency('provision', 0.5, schedulingInputs({
    food: 10, health: 20, isDay: true, timeOfDay: 3_000, position: { x, y: 65, z: 0 },
  }, { home }));
  assert.ok(pressure(90) < pressure(15));
});
