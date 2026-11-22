#!/usr/bin/env node
'use strict';

const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { replay, openInput } = require('./doctor-replay');

const HOUR_MS = 60 * 60 * 1000;

function inInterval(alert, interval) {
  return alert.at >= interval.startAt && alert.at <= interval.endAt;
}

function matchesRule(emission, interval, rule, { anchors, context, startAt }) {
  const { alert, lines } = emission;
  return alert.rule === rule && alert.at >= (startAt ?? interval.startAt) && alert.at <= interval.endAt
    && Object.entries(context ?? {}).every(([key, value]) => alert.context[key] === value)
    && lines.some((line) => anchors.some(([start, end]) => line >= start && line <= end));
}

function firstDetection(emissions, intervalStartAt, severity) {
  const emission = emissions.find(({ alert }) => severity == null || alert.severity === severity);
  if (!emission) return null;
  const { alert, lines } = emission;
  return { at: alert.at, delayMs: alert.at - intervalStartAt, severity: alert.severity, summary: alert.summary, lines };
}

async function evaluate(archive, labels, { calibration = false } = {}) {
  const started = performance.now();
  const selected = calibration ? labels.cases.filter((sample) => sample.split === 'calibration') : labels.cases;
  const runIds = calibration ? new Set(selected.map((sample) => sample.run)) : new Set(labels.runs.map((run) => run.id));
  const runs = new Map();
  for (const run of labels.runs) {
    if (!runIds.has(run.id)) continue;
    const result = await replay(openInput(resolve(archive, run.input)));
    const emissions = result.alerts.map((alert, index) => ({
      id: `${run.id}#${index + 1}`,
      alert,
      lines: result.alertEvidenceLines[index],
      elapsedMs: alert.at - run.startAt,
    }));
    runs.set(run.id, { stats: result.stats, emissions });
  }

  const linked = new Set();
  const cases = selected.map(({ id, run, split, intervals }) => {
    const emissions = runs.get(run).emissions;
    const results = intervals.map((interval) => {
      const rules = Object.entries(interval.rules).map(([rule, criteria]) => {
        const matched = emissions.filter((emission) => matchesRule(emission, interval, rule, criteria));
        const onsetAt = criteria.startAt ?? interval.startAt;
        matched.forEach((emission) => linked.add(emission.id));
        return {
          rule,
          first: firstDetection(matched, onsetAt),
          firstAlert: firstDetection(matched, onsetAt, 'alert'),
          matched: matched.map((emission) => emission.id),
        };
      });
      return { startAt: interval.startAt, endAt: interval.endAt, rules };
    });
    const detected = results.flatMap(({ rules }) => rules).filter(({ first }) => first).length;
    const expected = results.flatMap(({ rules }) => rules).length;
    return { id, run, split, detected, expected, hit: detected === expected, intervals: results };
  });
  if (calibration) return { cases };

  const normalIds = new Set();
  const normal = labels.normal.map(({ run, intervals }) => {
    const hours = intervals.reduce((sum, { startAt, endAt }) => sum + endAt - startAt, 0) / HOUR_MS;
    const matches = runs.get(run).emissions.filter(({ alert }) => intervals.some((interval) => inInterval(alert, interval)));
    matches.forEach(({ id }) => normalIds.add(id));
    const alerts = matches.filter(({ alert }) => alert.severity === 'alert').length;
    const warns = matches.filter(({ alert }) => alert.severity === 'warn').length;
    return { run, hours, alerts, warns, alertsPerHour: alerts / hours, warnsPerHour: warns / hours, matches };
  });
  const otherAlerts = [...runs.values()].flatMap(({ emissions }) => emissions)
    .filter(({ id }) => !linked.has(id))
    .map((emission) => ({ ...emission, inNormalWindow: normalIds.has(emission.id) }));
  return {
    cases,
    normal,
    otherAlerts,
    elapsedMs: performance.now() - started,
    replays: [...runs].map(([run, { stats, emissions }]) => ({ run, ...stats, alerts: emissions.length })),
  };
}

async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { calibration: { type: 'boolean' } },
  });
  if (positionals.length !== 2) {
    throw new Error('Usage: node tools/doctor-evaluate.js [--calibration] <archive-directory> <labels.json>');
  }
  const [archive, labelPath] = positionals;
  const labels = JSON.parse(await readFile(labelPath, 'utf8'));
  if (labels.version !== 1) throw new Error('Unsupported doctor label format');
  console.log(JSON.stringify(await evaluate(archive, labels, values), null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { evaluate };
