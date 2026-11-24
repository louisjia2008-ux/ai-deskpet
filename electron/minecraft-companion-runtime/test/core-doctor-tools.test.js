'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDoctor } = require('../core/doctor');
const { replay } = require('../tools/doctor-replay');

const position = { x: 4, y: 60, z: 7 };

function input(rows) {
  return Readable.from(rows.map((row) => JSON.stringify(row) + '\n'));
}

function observation(index, extras = {}) {
  return { at: index * 30_000, position, dimension: 'overworld', alive: true, isDay: true, ...extras };
}

test('doctor replay reads historical samples and reports physical line numbers', async () => {
  const rows = [];
  rows.push({ type: 'event', event: { type: 'connection', state: 'ready' } });
  rows.push({ event: { payload: { type: 'autonomy_choice', at: 0, card: 'homestead', goal: 'homestead' } } });
  for (let index = 0; index <= 10; index += 1) {
    rows.push({ experiment: 'sample', observation: observation(index) });
  }
  const result = await replay(input(rows), { stationaryOnly: true });
  assert.deepEqual(result.alerts.map((alert) => [alert.rule, alert.severity]), [['D1', 'warn'], ['D1', 'alert']]);
  assert.deepEqual(result.alerts.map(({ evidence }) => evidence), [[2, 7], [2, 12]]);
  assert.deepEqual(result.alertEvidenceLines, [[3, 8], [3, 13]]);
  assert.equal(result.alertCount, 2);
  assert.equal(result.incidentCount, 1);
  assert.deepEqual(result.incidents[0].alerts, result.alerts);
  assert.deepEqual(result.stationarySegments, [{ at: 0, finish: 300_000, position, cards: ['homestead'] }]);
  assert.equal(result.missingSamples, 0);
});

test('doctor replay measures the longest stationary segment below the alert threshold', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ type: 'doctor_observation', ...observation(index) }));
  const result = await replay(input(rows), { stationaryOnly: true });
  assert.deepEqual(result.stationarySegments, []);
  assert.equal(result.longestStationarySegment.durationMs, 120_000);
  assert.equal(result.incidentCount, 0);
});

test('doctor replay matches live emissions and ignores the harness snapshots on a sequenced connection', async () => {
  const doctor = createDoctor();
  const rows = [];
  const liveAlerts = [];
  for (let index = 0; index <= 10; index += 1) {
    const payload = { type: 'doctor_observation', doctorSequence: index + 1, ...observation(index) };
    rows.push({ type: 'event', event: { type: 'core', connectionGeneration: 1, payload } });
    for (const alert of doctor.accept(payload)) {
      rows.push({ type: 'event', event: { type: 'core', connectionGeneration: 1, payload: alert } });
      liveAlerts.push(alert);
    }
    rows.push({ experiment: 'sample', connection: { generation: 1 },
      observation: observation(index, { position: { ...position, x: 10 * index } }) });
  }
  const result = await replay(input(rows));
  assert.deepEqual(result.recordedAlerts, liveAlerts);
  assert.deepEqual(result.alerts, liveAlerts);
  assert.deepEqual(result.alertEvidenceLines, [[1, 11], [1, 22]]);
});

test('doctor skips interleaved Node warnings while preserving physical source lines', async () => {
  const row = index => JSON.stringify({ experiment: 'sample', observation: observation(index) }) + '\n';
  const result = await replay(Readable.from([row(0), '(node) MaxListenersExceededWarning\n',
    ...Array.from({ length: 10 }, (_, index) => row(index + 1))]), { stationaryOnly: true });
  assert.equal(result.stats.skippedNonJson, 1);
  assert.deepEqual(result.alertEvidenceLines, [[1, 7], [1, 12]]);
});
