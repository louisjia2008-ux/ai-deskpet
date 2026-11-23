#!/usr/bin/env node
'use strict';

const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { parseArgs } = require('node:util');
const { createDoctor, groupIncidents, D1 } = require('../core/doctor');
const { createArchiveAdapter } = require('./doctor-replay-legacy');

function corePayload(row) {
  const envelope = row.event || row;
  if (envelope.type === 'core' || (row.event && envelope.type == null)) return envelope.payload;
  if (row.type === 'event' || row.experiment || row.check) return null;
  return row.type ? row : null;
}

function replayInput(row, payload) {
  if (row.experiment === 'sample') {
    return { ...row.observation, type: 'doctor_observation', doctorAt: Date.parse(row.observedAt),
      engine: row.engine, paused: row.engine?.paused, survey: row.engine?.goal?.name === 'survey_plan' };
  }
  if (row.type === 'core' || row.event?.type === 'core') {
    return { ...payload, doctorAt: payload.doctorAt ?? (row.event || row).at };
  }
  return row.type === 'event' ? null : payload;
}

async function replay(input, { stationaryOnly = false, measureRequiredMaterials = false } = {}) {
  const started = performance.now();
  const alerts = [];
  const recordedAlerts = [];
  const alertEvidenceLines = [];
  const autonomyChoices = [];
  const stationarySegments = [];
  let longestStationarySegment = null;
  let missingSamples = 0;
  const onStationarySegment = (segment) => {
    const durationMs = segment.finish - segment.at;
    if (durationMs >= D1.alertMs) stationarySegments.push(segment);
    if (durationMs > (longestStationarySegment?.durationMs ?? 0)) {
      longestStationarySegment = { ...segment, durationMs };
    }
  };
  let doctor = createDoctor({ onStationarySegment, stationaryOnly });
  let convert = createArchiveAdapter({ measureRequiredMaterials });
  let generation;
  let recordedInput = false;
  let legacySequence = 0;
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
      convert = createArchiveAdapter({ measureRequiredMaterials });
      recordedInput = false;
      legacySequence = 0;
      sequenceLines.clear();
    }
    generation = rowGeneration ?? generation;

    if (payload?.type === 'doctor_alert') {
      recordedAlerts.push(payload);
      continue;
    }
    if (!stationaryOnly && payload?.type === 'autonomy_choice') {
      const { at, card, goal, reason, reassessment, challenger, scores } = payload;
      autonomyChoices.push({ line: lines, at, card, goal, reason, reassessment, challenger, scores });
    }
    const sequenced = Number.isSafeInteger(payload?.doctorSequence);
    if (sequenced) recordedInput = true;
    // The driver also records status snapshots. Live Core logs its own doctor
    // inputs, so prefer those whenever this connection supplies them.
    if (recordedInput && !sequenced) continue;
    const sequence = sequenced ? payload.doctorSequence : ++legacySequence;
    sequenceLines.set(sequence, lines);

    const before = performance.now();
    const emissions = doctor.accept(convert(replayInput(row, payload), sequence));
    const durationMs = performance.now() - before;
    acceptMs += durationMs;
    acceptMaxMs = Math.max(acceptMaxMs, durationMs);
    accepted += 1;
    for (const alert of emissions) {
      alerts.push(alert);
      alertEvidenceLines.push(alert.evidence.map((ref) => sequenceLines.get(ref) ?? null));
    }
  }
  finish();
  const incidents = groupIncidents(alerts);
  return {
    alerts, recordedAlerts, alertEvidenceLines, incidents, autonomyChoices,
    alertCount: alerts.length, incidentCount: incidents.length,
    stationarySegments, longestStationarySegment, missingSamples,
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
      'measure-required-materials': { type: 'boolean' },
      'stationary-stdin': { type: 'boolean' },
    },
  });
  if (values['stationary-stdin']) {
    if (positionals.length) throw new Error('--stationary-stdin takes JSONL on standard input');
    const { stationarySegments, longestStationarySegment, missingSamples } = await replay(process.stdin, { stationaryOnly: true });
    console.log(JSON.stringify({ stationarySegments, longestStationarySegment, missingSamples }));
    return;
  }
  if (positionals.length !== 1) throw new Error('Usage: node tools/doctor-replay.js [--json] [--measure-required-materials] <core.jsonl | ->');
  const result = await replay(openInput(positionals[0]), {
    measureRequiredMaterials: values['measure-required-materials'],
  });
  if (values.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`${result.incidentCount} incidents, ${result.alertCount} alerts`);
  const evidenceLines = new Map(result.alerts.map((alert, index) => [alert, result.alertEvidenceLines[index]]));
  for (const incident of result.incidents) {
    console.log(`${incident.incidentId} ${incident.severity}`);
    for (const alert of incident.alerts) {
      const lines = evidenceLines.get(alert);
      const evidence = alert.evidence.map((seq, index) => `#${seq}/${lines[index] == null ? '?' : 'L' + lines[index]}`).join(', ');
      console.log(`  ${new Date(alert.at).toISOString()} ${alert.rule} ${alert.severity} ${alert.summary} [${evidence}]`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { replay, openInput };
