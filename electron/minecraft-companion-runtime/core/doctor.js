'use strict';
// Diagnostic state only. Inputs and outputs are plain records from the Core log.

const { createStationaryRule, D1, point, insideHome } = require('./doctor-stationary');
const { createDoctorRules, DOCTOR_RULE_THRESHOLDS, isDoctorFailureEvent } = require('./doctor-rules');

const RECENT_LIMIT = 24;
const MAX_TEXT = 300;
const TERMINAL = new Set(['goal_done', 'goal_cleared', 'goal_failed', 'goal_yielded', 'stopped']);
const WAIT_REASONS = new Set(['sheltering_until_daylight', 'waiting_for_daylight', 'waiting_for_wheat']);

function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : null;
}

function stepOf(event) {
  return { kind: text(event.kind), key: text(event.key), for: text(event.for), item: text(event.item),
    count: Number.isFinite(event.count) ? event.count : null };
}

function homeOf(home) {
  const anchor = point(home?.anchor);
  return anchor ? { anchor, size: Number.isFinite(home.size) ? home.size : 5 } : null;
}

function recordDoctorInput(event, doctorSequence, botPosition) {
  const input = { ...event, doctorSequence };
  if (isDoctorFailureEvent(event)) input.doctorPosition = point(botPosition);
  return input;
}

function groupIncidents(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const { incidentId, since, at, severity, goalGeneration } = alert;
    const incident = groups.get(incidentId) || {
      incidentId, since, at, severity, goalGeneration, alerts: [],
    };
    incident.since = Math.min(incident.since, since);
    incident.at = Math.max(incident.at, at);
    if (severity === 'alert') incident.severity = severity;
    incident.alerts.push(alert);
    groups.set(incidentId, incident);
  }
  return [...groups.values()];
}

function unwrap(entry) {
  if (entry.experiment === 'sample') {
    const observation = entry.observation || {};
    return { ...observation, type: 'doctor_observation', recordedAt: Date.parse(entry.observedAt),
      engine: entry.engine, paused: entry.engine?.paused, survey: entry.engine?.goal?.name === 'survey_plan' };
  }
  if (entry.type === 'event') {
    if (entry.event?.type === 'core' && entry.event.payload) {
      return { ...entry.event.payload, recordedAt: entry.event.at };
    }
    return null;
  }
  if (entry.event?.payload) return entry.event.payload;
  return entry;
}

function createDoctor({ onStationarySegment, stationaryOnly = false } = {}) {
  const stationary = createStationaryRule(onStationarySegment);
  const rules = stationaryOnly ? null : createDoctorRules();
  const active = new Map();
  const recent = [];
  const latestIncident = new Map();
  let incidentCount = 0;
  let sequence = 0;
  let now = null;
  let context = emptyContext();
  let goalGeneration = null;
  let behavior = null;
  let lastWaitAt = null;
  let nightSheltered = false;
  let observation = null;

  function emptyContext() {
    return { card: null, goal: null, step: null, position: null, home: null, timeOfDay: null };
  }

  function reset() {
    stationary.reset();
    rules?.reset();
    active.clear();
    recent.length = 0;
    latestIncident.clear();
    incidentCount = sequence = 0;
    context = emptyContext();
    goalGeneration = lastWaitAt = now = null;
    behavior = null;
    nightSheltered = false;
    observation = null;
  }

  function updateContext(event) {
    if (event.type === 'autonomy_choice') {
      context = { ...context, card: text(event.card), goal: text(event.goal), step: null };
    } else if (event.type === 'goal_set') {
      goalGeneration = event.generation ?? null;
      context = { ...context, goal: text(event.goal), step: null };
    } else if (TERMINAL.has(event.type) && (goalGeneration === null || event.generation == null
      || event.generation === goalGeneration)) {
      goalGeneration = null;
      context = { ...context, card: null, goal: null, step: null };
    } else if (event.type === 'plan_step') {
      context = { ...context, step: stepOf(event) };
    } else if (event.type === 'doctor_observation') {
      context = { ...context, position: point(event.position), home: homeOf(event.home),
        timeOfDay: Number.isFinite(event.timeOfDay) ? event.timeOfDay : null };
    } else if (event.type === 'site_chosen') {
      context = { ...context, home: homeOf(event) || context.home };
    }
    if (event.type === 'behavior_finished' && WAIT_REASONS.has(event.reason)) lastWaitAt = now;
    if (event.type === 'behavior_started') behavior = text(event.behavior);
    if (['behavior_finished', 'behavior_abandoned'].includes(event.type) && event.behavior === behavior) behavior = null;
    if (event.type === 'doctor_observation' && Object.hasOwn(event.engine || {}, 'running')) behavior = text(event.engine.running);
    if (['night', 'night_rest'].includes(event.type) && ['dug_in', 'dug_out'].includes(event.action)) {
      nightSheltered = event.action === 'dug_in';
    }
  }

  function incidentFor(card, goal, generation, since, evidence) {
    // A manually assigned goal also has a generation, but can have no card.
    const owner = JSON.stringify([card, goal, generation]);
    const prior = latestIncident.get(owner);
    if (prior && since - prior.at < DOCTOR_RULE_THRESHOLDS.incident.gapMs) {
      prior.at = now;
      return prior.id;
    }
    incidentCount += 1;
    const id = `incident-${now}-${evidence}-${incidentCount}`;
    latestIncident.delete(owner);
    latestIncident.set(owner, { id, at: now });
    if (latestIncident.size > RECENT_LIMIT) latestIncident.delete(latestIncident.keys().next().value);
    return id;
  }

  function accept(entry, legacySequence) {
    if (!entry || typeof entry !== 'object') return [];
    let event = unwrap(entry);
    if (!event || typeof event.type !== 'string' || event.type === 'doctor_alert') return [];
    const observationEvent = event.type === 'doctor_observation';
    const timestamp = Number.isFinite(event.at) ? event.at : (event.doctorAt ?? event.recordedAt);
    if (!Number.isFinite(event.at) && !observationEvent) {
      event = { ...event, at: timestamp, position: event.position ?? point(event.at) };
    }
    if (!Number.isFinite(timestamp) && !observationEvent) return [];
    // Emission order is causal. A nested observer can emit an event stamped
    // a few milliseconds earlier than the previous log entry.
    now = Math.max(now ?? -Infinity, Number.isFinite(timestamp) ? timestamp : now ?? 0);
    if (event.type === 'autonomy_death' || (event.type === 'interrupted' && event.reason === 'death')) {
      stationary.reset();
      rules?.reset();
      active.clear();
      latestIncident.clear();
      nightSheltered = false;
      observation = null;
      lastWaitAt = null;
      behavior = null;
    }
    const ending = TERMINAL.has(event.type) && (goalGeneration === null || event.generation == null
      || event.generation === goalGeneration);
    const previous = context;
    const previousGeneration = goalGeneration;
    updateContext(event);
    if (observationEvent) {
      const owner = point(event.ownerPosition);
      const nearby = owner && context.position && Math.hypot(owner.x - context.position.x,
        owner.y - context.position.y, owner.z - context.position.z) <= 3;
      const ownerStill = owner && observation?.owner && Math.hypot(owner.x - observation.owner.x,
        owner.y - observation.owner.y, owner.z - observation.owner.z) < 1;
      observation = {
        at: now, owner, dimension: text(event.dimension), isDay: event.isDay, alive: event.alive !== false,
        paused: event.paused === true, survey: event.survey === true,
        following: Boolean(nearby && ownerStill && context.goal === 'follow_owner'),
        rested: event.sheltered ?? nightSheltered,
        sleepingAtHome: event.sleeping === true && insideHome(context.home, context.position),
      };
    }
    const fresh = observation && now - observation.at <= D1.maxGapMs ? observation : null;
    const inactive = context.goal === 'survey_plan' || Boolean(fresh && (!fresh.alive || fresh.paused || fresh.survey
      || (context.goal === 'follow_owner' && fresh.following)));
    const sleepingAtHome = fresh?.isDay === false && fresh.sleepingAtHome;
    const waiting = inactive || Boolean(fresh?.isDay === false && (fresh.rested || sleepingAtHome || nightSheltered
      || (lastWaitAt !== null && now - lastWaitAt < D1.maxGapMs)));
    const recordedSequence = event.doctorSequence ?? legacySequence;
    const evidence = Number.isSafeInteger(recordedSequence) ? recordedSequence : sequence + 1;
    sequence = Math.max(sequence, evidence);
    const frame = { at: now, evidence, context, goalGeneration, behavior, inactive, sleepingAtHome,
      waiting, isDay: fresh?.isDay, dimension: fresh?.dimension };
    const results = rules?.ingest(event, frame) || {};
    const stationaryResult = stationary.ingest(event, frame);
    const emitted = [];
    for (const [rule, result] of Object.entries({ D1: stationaryResult, ...results })) {
      if (result === undefined) continue;
      if (result === null) {
        active.delete(rule);
        continue;
      }
      const prior = active.get(rule);
      const key = result.key ?? result.since;
      if (prior?.key === key && prior.alert.severity === result.severity) continue;
      const reportContext = { ...context, ...result.context };
      const owner = ending ? previous : reportContext;
      const generation = ending ? previousGeneration : goalGeneration;
      const incidentId = incidentFor(owner.card, owner.goal, generation, result.since, evidence);
      const alert = { type: 'doctor_alert', rule, severity: result.severity, since: result.since, at: now,
        summary: result.summary, evidence: [...new Set(result.evidence)], context: structuredClone(reportContext),
        incidentId, goalGeneration: generation };
      active.set(rule, { key, alert });
      recent.push(alert);
      if (recent.length > RECENT_LIMIT) recent.shift();
      emitted.push(structuredClone(alert));
    }
    return emitted;
  }

  return {
    accept,
    reset,
    finish: stationary.finish,
    missingStationarySamples: stationary.missing,
    getStatus() {
      const activeAlerts = [...active.values()].map(({ alert }) => alert);
      return structuredClone({
        recent, active: activeAlerts, incidentCount,
        recentIncidents: groupIncidents(recent), activeIncidents: groupIncidents(activeAlerts),
      });
    },
    size: () => ({ recent: recent.length, active: active.size, stationary: stationary.size(), rules: rules?.size() }),
  };
}

module.exports = { createDoctor, recordDoctorInput, groupIncidents, D1, RECENT_LIMIT };
