const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDoctor } = require('../core/doctor');

const cooldown = { type: 'autonomy_cooldown', card: 'homestead', until: 300_000 };
const cooling = { id: 'homestead', skipped: 'cooldown', score: 0 };
const legacyIdle = { type: 'autonomy_idle', scores: [cooling, { id: 'stock_food', skipped: 'stage', score: 0 }] };
const daytime = { type: 'doctor_observation', dimension: 'overworld', isDay: true, position: { x: 0, y: 64, z: 0 } };

function replay(rows) {
  const doctor = createDoctor();
  const idle = [];
  for (const [index, [seconds, row]] of rows.entries()) {
    idle.push(...doctor.accept({ ...row, at: seconds * 1000 }, index + 1).filter(({ rule }) => rule === 'D7'));
  }
  return { idle, active: doctor.getStatus().active.some(({ rule }) => rule === 'D7') };
}

test('D7 corroborates old reasonless idle with a matching, unexpired card cooldown', () => {
  const { idle, active } = replay([[0, cooldown], [5, legacyIdle], [35, daytime], [65, daytime],
    [95, daytime], [124, daytime], [125, daytime], [130, { type: 'autonomy_choice', card: 'homestead' }]]);
  assert.equal(idle.length, 1);
  assert.equal(idle[0].since, 5000);
  assert.equal(idle[0].at, 125_000);
  assert.deepEqual(idle[0].evidence, [1, 2, 7]);
  assert.equal(active, false);
});

test('D7 requires retry evidence, ignores eligible or unneeded work, and expires stale cooldowns', () => {
  const controls = [
    [[0, { ...cooldown, card: 'unrelated' }], [5, legacyIdle]],
    [[0, cooldown], [5, { ...legacyIdle, scores: [cooling, { id: 'return_home', score: 100 }] }]],
    [[0, cooldown], [5, { ...legacyIdle, reason: 'no_current_demand_or_prerequisites' }]],
    [[0, { ...cooldown, until: 100_000 }], [5, legacyIdle]],
    [[0, cooldown], [2, { type: 'autonomy_disabled' }], [5, legacyIdle]],
  ];
  for (const control of controls) {
    assert.deepEqual(replay([...control, [35, daytime], [65, daytime], [95, daytime], [125, daytime]]).idle, []);
  }
});
