const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { createDoctor } = require('../core/doctor');

const position = (x, z = 0) => ({ x, y: 64, z });
const observation = { type: 'doctor_observation', position: position(0), dimension: 'overworld', isDay: true };

function replay(rows) {
  const doctor = createDoctor();
  const alerts = rows.flatMap(([seconds, event], index) => doctor.accept({ ...event, at: seconds * 1000 }, index + 1));
  return { alerts, active: doctor.getStatus().active };
}
function ofRule(rows, rule) { return replay(rows).alerts.filter((event) => event.rule === rule); }

test('D2 reports repeated failures in the same area and clears after arrival', () => {
  const failedLeg = { type: 'home_route_leg', from: position(2), position: position(3),
    advanced: false, reason: 'path_timeout' };
  const result = replay([[0, failedLeg], [12, failedLeg], [24, failedLeg], [25, { type: 'home_route_arrived' }]]);
  const alert = result.alerts.find((event) => event.rule === 'D2');
  assert.equal(alert.at, 24_000);
  assert.equal(alert.since, 0);
  assert.deepEqual(alert.evidence, [1, 2, 3]);
  assert.equal(result.active.some((alert) => alert.rule === 'D2'), false);
});

test('D2 ignores normal shelter and isolated failures at different targets', () => {
  const targetFailure = { type: 'target_failure', reason: 'path_timeout', goal: 'homestead' };
  const rows = [[0, { ...observation, isDay: false, sleeping: true, sheltered: true }]];
  for (let i = 0; i < 3; i++) rows.push([i * 10 + 1, { ...targetFailure, position: position(3) }]);
  rows.push([31, observation]);
  for (let i = 0; i < 3; i++) rows.push([i * 10 + 32, { ...targetFailure, position: position(i * 18) }]);
  assert.deepEqual(ofRule(rows, 'D2'), []);
});

test('D3 detects repeated unchanged inventory work and repeated blocked placement', () => {
  const plan = { type: 'plan_step', kind: 'gather', key: 'log', for: 'planks', count: 2, behavior: 'goal:homestead' };
  const failed = { type: 'behavior_finished', behavior: plan.behavior, ok: false, reason: 'path_timeout' };
  const unchanged = [[0, { ...observation, inventory: { oak_planks: 2 } }],
    [1, plan], [8, failed], [11, plan], [18, failed], [21, plan], [28, failed], [31, plan]];
  assert.equal(ofRule(unchanged, 'D3')[0].since, 1000);
  assert.deepEqual(ofRule(unchanged, 'D3')[0].evidence, [2, 3, 4, 5, 6, 7, 8]);

  const blocked = [];
  for (let i = 0; i < 4; i++) {
    blocked.push([i * 10, { type: 'build', what: 'wall', position: '1,64,2', behavior: 'goal:homestead' }],
      [i * 10 + 1, { type: 'behavior_finished', behavior: 'goal:homestead', ok: false, reason: 'no_material' }]);
  }
  assert.match(ofRule(blocked, 'D3')[0].summary, /wall build at \(1, 64, 2\)/);
});

test('D3 recognizes decreasing demand and a paused owner task', () => {
  const plan = { type: 'plan_step', kind: 'gather', key: 'cobblestone', for: 'cobblestone', behavior: 'goal:homestead' };
  const rows = [[0, observation]];
  for (let i = 0; i < 5; i++) rows.push([i * 10 + 1, { ...plan, count: 5 - i }]);
  rows.push([52, { ...observation, paused: true }]);
  for (let i = 0; i < 5; i++) rows.push([i * 8 + 53, { ...plan, count: 2 }]);
  assert.deepEqual(ofRule(rows, 'D3'), []);
});

test('D4 recognizes an out-and-back loop and repeated bank returns', () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push([i * 16, { ...observation, position: position(i % 2 ? 12 : 0),
    engine: { running: i % 2 ? 'home_escape' : 'goal:homestead' } }]);
  assert.match(ofRule(rows, 'D4')[0].summary, /2 local positions/);
  const bankEvent = { type: 'home_route_shore', phase: 'alternate', returns: 2 };
  assert.match(ofRule([[0, { ...bankEvent, bank: position(0) }],
    [40, { ...bankEvent, bank: position(10) }], [80, { ...bankEvent, bank: position(0) }]], 'D4')[0].summary, /banks/);
});

test('D4 does not confuse survey work or one ordinary reroute with a loop', () => {
  const rows = [[0, { type: 'goal_set', goal: 'survey_plan' }]];
  for (let i = 0; i < 8; i++) rows.push([i * 16, { ...observation, position: position(i % 2 ? 12 : 0),
    engine: { running: i % 2 ? 'survey' : 'observe' } }]);
  rows.push([120, { type: 'goal_cleared', goal: 'survey_plan' }]);
  for (const [i, x] of [0, 12, 0, 22, 35].entries()) rows.push([130 + i * 20, { type: 'home_route_leg', position: position(x) }]);
  assert.deepEqual(ofRule(rows, 'D4'), []);
});

test('D5 detects sustained work in daylight with no milestone', () => {
  const rows = [[0, { type: 'goal_set', goal: 'homestead' }],
    [0, { type: 'behavior_started', behavior: 'goal:homestead' }]];
  for (let i = 0; i <= 10; i++) rows.push([i * 30, observation]);
  assert.equal(ofRule(rows, 'D5')[0].at, 300_000);
});

test('D5 starts a new clock after a milestone or a night sheltered in place', () => {
  const rows = [[0, { type: 'goal_set', goal: 'homestead' }],
    [0, { type: 'behavior_started', behavior: 'goal:homestead' }]];
  for (let i = 0; i <= 22; i++) {
    if (i === 8) rows.push([i * 30, { type: 'autonomy_milestone', milestone: 'home_usable' }],
      [i * 30, { type: 'behavior_started', behavior: 'goal:homestead' }]);
    rows.push([i * 30, i === 15 ? { ...observation, isDay: false, sheltered: true } : observation]);
  }
  assert.deepEqual(ofRule(rows, 'D5'), []);
});

test('D6 detects moving away at dusk and remaining far away after dark', () => {
  const home = { anchor: position(0) };
  const atDusk = [[0, { ...observation, position: position(50), home, timeOfDay: 10_800 }],
    [30, { ...observation, position: position(63), home, timeOfDay: 11_400 }],
    [60, { ...observation, position: position(80), home, timeOfDay: 12_000 }]];
  assert.match(ofRule(atDusk, 'D6')[0].summary, /30 blocks farther/);
  const afterDark = [0, 30, 60, 90].map((at) =>
    [at, { ...observation, position: position(101), home, timeOfDay: 12_600 + at * 20, isDay: false }]);
  assert.deepEqual(ofRule(afterDark.slice(0, 3), 'D6'), []);
  assert.match(ofRule(afterDark, 'D6')[0].summary, /101 blocks from home after dark/);
});

test('D6 does not flag moving home before dark or sleeping under cover', () => {
  const home = { anchor: position(0) };
  const rows = [[0, { ...observation, position: position(115), home, timeOfDay: 10_800 }],
    [55, { ...observation, position: position(61), home, timeOfDay: 11_900 }],
    [90, { ...observation, position: position(4), home, timeOfDay: 12_600, sheltered: true, sleeping: true, isDay: false }]];
  assert.deepEqual(ofRule(rows, 'D6'), []);
});

test('D6 verifies loss of ground after two home returns are interrupted by provisioning', () => {
  const home = { anchor: position(0), size: 5 };
  const returning = { type: 'night', action: 'dusk_home', behavior: 'goal:homestead' };
  const preempted = { type: 'preempted', behavior: returning.behavior, by: 'provision' };
  const leg = { type: 'home_route_leg', destination: position(2), advanced: true };
  const rows = [[0, { ...observation, home, position: position(85), timeOfDay: 11_400 }],
    [5, returning], [10, { ...leg, from: position(85), position: position(72) }], [12, preempted],
    [30, { ...observation, home, position: position(81), timeOfDay: 12_000 }],
    [34, returning], [39, { ...leg, from: position(81), position: position(63) }], [41, preempted],
    [60, { ...observation, home, position: position(80), timeOfDay: 12_600, isDay: false }]];
  const alerts = ofRule(rows, 'D6');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].summary, /two return or shelter attempts were interrupted/);
  assert.deepEqual(alerts[0].evidence, [2, 4, 6, 8, 7, 9]);
  assert.deepEqual(ofRule([...rows.slice(0, -1), [60, { ...rows.at(-1)[1], position: position(52) }]], 'D6'), []);
});

test('D6 uses the prior body sample when a legacy return and shelter are interrupted', () => {
  const home = { anchor: position(0), size: 5 };
  const behavior = 'goal:homestead';
  const preempted = { type: 'preempted', behavior, by: 'provision' };
  const rows = [[0, { ...observation, home, position: position(38), timeOfDay: 10_900 }],
    [14, { type: 'night', action: 'dusk_home', behavior }], [19, preempted],
    [30, { ...observation, home, position: position(95), timeOfDay: 11_500 }],
    [60, { ...observation, home, position: position(74), timeOfDay: 12_100 }],
    [89, { type: 'night', action: 'dig_in', behavior }],
    [90, { ...observation, home, position: position(77), timeOfDay: 12_700, isDay: false }],
    [93, preempted], [112, { type: 'night', action: 'dig_in', behavior }],
    [120, { ...observation, home, position: position(106), timeOfDay: 13_300, isDay: false }]];
  assert.equal(ofRule(rows, 'D6')[0].at, 120_000);
  assert.deepEqual(ofRule(rows.slice(0, -3).concat([rows.at(-1)]), 'D6'), []);
});

test('D6 gives a confirmed underground advance or local shelter time to succeed', () => {
  const home = { anchor: position(0), size: 5 };
  const rows = [0, 30, 60, 90].map((at) => [at, { ...observation, home, isDay: false,
    timeOfDay: 12_600 + at * 20, position: { x: 90 + at / 2, y: 37, z: 0 }, mining: 'stone' }]);
  assert.deepEqual(ofRule(rows, 'D6'), []);
  rows.splice(1, 0, [1, { type: 'night_rest', action: 'dig_in' }]);
  for (const [, sample] of rows.filter(([, event]) => event.type === 'doctor_observation').slice(1)) {
    sample.mining = null;
    sample.sheltered = true;
  }
  assert.deepEqual(ofRule(rows, 'D6'), []);
});

test('D6 detects a new far target pursued after a successful dusk return', () => {
  const home = { anchor: position(0), size: 5 };
  const behavior = 'goal:homestead';
  const rows = [[0, { ...observation, home, position: position(90), timeOfDay: 11_639 }],
    [1, { type: 'night', action: 'dusk_home', behavior }],
    [20, { type: 'behavior_finished', behavior, ok: true }],
    [28, { type: 'target_selected', behavior, position: '135,64,0' }],
    [30, { ...observation, home, position: position(52), timeOfDay: 12_239 }],
    [60, { ...observation, home, position: position(133), timeOfDay: 12_839, isDay: false }]];
  assert.deepEqual(ofRule(rows, 'D6')[0].evidence, [2, 3, 4, 5, 6]);
  assert.deepEqual(ofRule(rows.slice(0, -1).concat([[60, { ...rows.at(-1)[1], position: position(28) }]]), 'D6'), []);
});

test('D5 treats farm edits, inventory gain and successful mining as steps and clears on task turnover', () => {
  const farm = { type: 'goal_set', goal: 'farm', generation: 1 };
  const start = { type: 'behavior_started', behavior: 'goal:farm', generation: 1 };
  const rows = [[0, farm], [0, start], [0, { ...observation, inventory: {} }]];
  for (let i = 1; i <= 14; i++) {
    if (i === 8) rows.push([235, { type: 'farm', action: 'plant', plot: '1,64,2', behavior: start.behavior }],
      [237, { type: 'behavior_finished', behavior: start.behavior, ok: true }]);
    rows.push([i * 30, { ...observation, inventory: i > 1 ? { wheat_seeds: 1 } : {} }]);
  }
  rows.push([421, { type: 'goal_set', goal: 'outfit', generation: 2 }],
    [422, { type: 'behavior_started', behavior: 'goal:outfit' }]);
  for (let i = 15; i <= 26; i++) {
    if (i === 22) rows.push([651, { type: 'mine_ore', position: '2,22,4', behavior: 'goal:outfit' }],
      [653, { type: 'behavior_finished', behavior: 'goal:outfit', ok: true }]);
    rows.push([i * 30, observation]);
  }
  assert.deepEqual(ofRule(rows, 'D5'), []);
});

test('D5 treats confirmed grass breaking as work even when no seed drops', () => {
  const behavior = 'goal:farm';
  const rows = [[0, { type: 'goal_set', goal: 'farm' }], [0, { type: 'behavior_started', behavior }]];
  for (let i = 0; i <= 12; i++) {
    rows.push([i * 30, { ...observation, inventory: {} }]);
    if (i === 7) rows.push([i * 30 + 1, { type: 'farm', action: 'seeds', behavior }],
      [i * 30 + 5, { type: 'behavior_finished', ok: true, behavior }]);
  }
  assert.deepEqual(ofRule(rows, 'D5'), []);
  rows.splice(rows.findIndex(([at]) => at === 215), 0, [214, { type: 'explore', behavior, x: 10, z: 20 }]);
  assert.equal(ofRule(rows, 'D5')[0].at, 300_000);
});

test('D7 detects two minutes idling for a retry and clears when a goal starts', () => {
  const rows = [[0, { type: 'autonomy_idle', reason: 'no_eligible_card_until_retry', until: 200_000 }],
    [119, observation], [120, observation], [121, { type: 'goal_set', goal: 'homestead' }]];
  const result = replay(rows);
  assert.equal(result.alerts.find((alert) => alert.rule === 'D7').at, 120_000);
  assert.equal(result.active.some((alert) => alert.rule === 'D7'), false);
});

test('D7 does not count time waiting under shelter or idle with no demand', () => {
  const rows = [[0, { type: 'autonomy_idle', reason: 'no_current_demand_or_prerequisites' }], [120, observation],
    [125, { type: 'autonomy_idle', reason: 'no_eligible_card_until_retry', until: 400_000 }]];
  for (let i = 5; i < 13; i++) rows.push([i * 30, { ...observation, isDay: false, sheltered: true }]);
  assert.deepEqual(ofRule(rows, 'D7'), []);
});

function switching(reason) {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push([i * 54, { type: 'autonomy_choice', card: 'homestead', goal: 'homestead' }],
      [i * 54 + 2, { type: 'goal_yielded', card: 'homestead', goal: 'homestead', reason, until: (i * 54 + 52) * 1000 }]);
  }
  return rows;
}

test('D8 pairs each selection with a yield and reports sustained switching once', () => {
  const alerts = ofRule(switching('adaptation_exhausted'), 'D8');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].at, 218_000);
  assert.deepEqual(alerts[0].evidence, [1, 3, 5, 7, 9, 2, 4, 6, 8, 10]);
});

test('D8 exempts intentional waits and ignores a yield without a preceding selection', () => {
  const rows = switching('waiting_for_daylight');
  rows.push([330, { type: 'goal_yielded', card: 'homestead', reason: 'adaptation_exhausted' }]);
  assert.deepEqual(ofRule(rows, 'D8'), []);
});

test('D2 through D8 bound their retained evidence under bursts of distinct tasks and positions', () => {
  const doctor = createDoctor();
  let line = 0;
  const apply = (event) => doctor.accept({ ...event, at: 1000 + line }, ++line);
  for (let i = 0; i < 1500; i++) {
    const card = 'card_' + i;
    const behavior = 'goal:' + card;
    apply({ type: 'autonomy_choice', card, goal: card });
    apply({ type: 'plan_step', kind: 'gather', key: card, count: 1, behavior });
    apply({ type: 'target_failure', goal: card, position: position(i * 16), reason: 'path_timeout' });
    apply({ type: 'home_route_shore', phase: 'alternate', bank: position(i * 10), returns: 2 });
    apply({ type: 'build', what: 'wall', behavior, position: '1,64,2' });
    apply({ type: 'goal_yielded', card, goal: card, reason: 'adaptation_exhausted' });
  }
  assert.ok(doctor.size().rules <= 48 * 13 + 32 * 8 + 257 + 48 * 4 + 256 + 32 * 2 + 13 + 24 * 5 + 32);
  doctor.reset();
  assert.equal(doctor.size().rules, 0);
});
