'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDoctor } = require('../core/doctor');
const { createArchiveAdapter } = require('../tools/doctor-replay-legacy');

const location = (x, z, y = 64) => ({ x, y, z });

function observe({ archive = false } = {}) {
  const doctor = createDoctor();
  const convert = archive ? createArchiveAdapter() : (event) => event;
  let line = 0;
  function send(at, event) {
    const input = convert({ ...event, at: at * 1000 }, ++line);
    return doctor.accept(input, line);
  }
  return { send, status: doctor.getStatus };
}

test('D4 detects a loop from actual relocation endpoints despite successful individual legs', () => {
  const { send, status } = observe();
  const corners = [location(0, 0), location(24, 0), location(24, 24), location(0, 24)];
  const alerts = [];
  for (let leg = 0; leg < 12; leg += 1) {
    const from = corners[leg % corners.length];
    const position = corners[(leg + 1) % corners.length];
    alerts.push(...send(leg * 10, { type: 'home_relocation_leg', from, position, result: { ok: true, progress: true } }));
  }
  const loops = alerts.filter(({ rule }) => rule === 'D4');
  assert.equal(loops.length, 1);
  assert.match(loops[0].summary, /4 local positions/);
  send(120, { type: 'site_chosen', anchor: corners[0] });
  assert.deepEqual(status().active.filter(({ rule }) => rule === 'D4'), []);
});

test('D4 treats vertical excavation and successful directed returns as progress', () => {
  const { send, status } = observe();
  const home = location(0, 0);
  for (let leg = 0; leg < 9; leg += 1) {
    const from = location(leg % 2 === 0 ? 0 : 10, 0, 80 - 4 * leg);
    send(leg * 30, { type: 'doctor_observation', position: from, engine: { running: leg % 2 === 0 ? 'unstick' : 'goal:outfit' } });
    send(leg * 30 + 1, { type: 'mine_frontier', position: from });
  }
  // A trip from the farm and back shares some coordinates with the outbound
  // path. Successful legs toward the same destination need no rescue signal.
  for (const [index, x] of [8, 18, 29, 20, 12, 1].entries()) {
    send(300 + index * 20, { type: 'home_route_leg', position: location(x, 0), destination: home, advanced: true });
  }
  assert.deepEqual(status().recent.filter(({ rule }) => rule === 'D4'), []);
});

function archiveNightCycle(send, begin, number, waits = 8) {
  const card = 'homestead';
  for (let cycle = 0; cycle < number; cycle += 1) {
    const at = begin + cycle * 55;
    const generation = cycle + 1;
    send(at, { type: 'doctor_observation', isDay: false, sheltered: true, position: location(0, 0) });
    send(at + 1, { type: 'autonomy_choice', card, goal: card });
    send(at + 1, { type: 'goal_set', goal: card, generation });
    send(at + 25, { type: 'goal_yielded', card, goal: card, generation, reason: 'sheltering_until_daylight',
      until: (at + 55) * 1000, waits, waitMs: 24_000 });
  }
}

test('D8 records exhausted night wait budgets despite physically reasonable shelter and clears after dawn', () => {
  const { send, status } = observe({ archive: true });
  archiveNightCycle(send, 0, 6);
  const cycles = status().recent.filter(({ rule }) => rule === 'D8');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].at, 245_000);
  assert.match(cycles[0].summary, /before the same night ended/);
  send(320, { type: 'doctor_observation', isDay: true, sheltered: false, position: location(0, 0) });
  assert.deepEqual(status().active.filter(({ rule }) => rule === 'D8'), []);
});

test('D8 keeps dawn boundaries and scheduled one-wait yields out of the repeated budget tally', () => {
  const { send, status } = observe({ archive: true });
  archiveNightCycle(send, 0, 3);
  send(165, { type: 'doctor_observation', isDay: true, position: location(0, 0) });
  archiveNightCycle(send, 200, 3);
  archiveNightCycle(send, 400, 6, 1);
  assert.deepEqual(status().recent.filter(({ rule }) => rule === 'D8'), []);
});
