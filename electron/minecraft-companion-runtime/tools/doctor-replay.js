#!/usr/bin/env node
'use strict';

const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { parseArgs } = require('node:util');
const { createDoctor } = require('../core/doctor');

function corePayload(row) {
  const envelope = row.event || row;
  if (envelope.type === 'core' || (row.event && envelope.type == null)) return envelope.payload;
  if (row.type === 'event' || row.experiment || row.check) return null;
  return row.type ? row : null;
}

async function replay(input, { stationaryOnly = false } = {}) {
  const started = performance.now();
  const alerts = [];
  const recordedAlerts = [];
  const alertEvidenceLines = [];
  const stationarySegments = [];
  let missingSamples = 0;
  const onStationarySegment = (segment) => stationarySegments.push(segment);
  let doctor = createDoctor({ onStationarySegment, stationaryOnly });
  let generation;
  let recordedInput = false;
  const sequenceLines = new Map();
  let lines = 0;
  let accepted = 0;
  let acceptMs = 0;
  let acceptMaxMs = 0;

  function finish() {
    doctor.finish();
    missingSamples += doctor.missingStationarySamples();
  }

  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    lines += 1;
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on line ${lines}`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Expected a JSON object on line ${lines}`);
    }
    const payload = corePayload(row);
    const isSample = row.experiment === 'sample';
    if (!payload && !isSample) continue;

    const rowGeneration = (row.event || row).connectionGeneration ?? row.connection?.generation;
    if (generation != null && rowGeneration != null && generation !== rowGeneration) {
      finish();
      doctor = createDoctor({ onStationarySegment, stationaryOnly });
      recordedInput = false;
      sequenceLines.clear();
    }
    generation = rowGeneration ?? generation;

    if (payload?.type === 'doctor_alert') {
      recordedAlerts.push(payload);
      continue;
    }
    if (Number.isSafeInteger(payload?.doctorSequence)) {
      recordedInput = true;
      sequenceLines.set(payload.doctorSequence, lines);
    }
    // The driver also records status snapshots. Live Core logs its own doctor
    // inputs, so prefer those whenever this connection supplies them.
    if (recordedInput && !Number.isSafeInteger(payload?.doctorSequence)) continue;

    const before = performance.now();
    const inputRow = row.type === 'core' ? { type: 'event', event: row } : row;
    const emissions = doctor.accept(inputRow, lines);
    const durationMs = performance.now() - before;
    acceptMs += durationMs;
    acceptMaxMs = Math.max(acceptMaxMs, durationMs);
    accepted += 1;
    for (const alert of emissions) {
      alerts.push(alert);
      alertEvidenceLines.push(alert.evidence.map((ref) => recordedInput ? sequenceLines.get(ref) ?? null : ref));
    }
  }
  finish();
  return {
    alerts, recordedAlerts, alertEvidenceLines, stationarySegments, missingSamples,
    stats: { lines, accepted, acceptMs, acceptMaxMs, elapsedMs: performance.now() - started },
  };
}

function openInput(path) {
  return path === '-' ? process.stdin : createReadStream(path, { encoding: 'utf8' });
}

async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'stationary-stdin': { type: 'boolean' },
    },
  });
  if (values['stationary-stdin']) {
    if (positionals.length) throw new Error('--stationary-stdin takes JSONL on standard input');
    const { stationarySegments, missingSamples } = await replay(process.stdin, { stationaryOnly: true });
    console.log(JSON.stringify({ stationarySegments, missingSamples }));
    return;
  }
  if (positionals.length !== 1) throw new Error('Usage: node tools/doctor-replay.js [--json] <core.jsonl | ->');
  const result = await replay(openInput(positionals[0]));
  if (values.json) {
    console.log(JSON.stringify(result));
    return;
  }
  for (const [index, alert] of result.alerts.entries()) {
    const evidence = result.alertEvidenceLines[index].map((line) => line == null ? '?' : `L${line}`).join(', ');
    console.log(`${new Date(alert.at).toISOString()} ${alert.rule} ${alert.severity} ${alert.summary} [${evidence}]`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { replay, openInput };
