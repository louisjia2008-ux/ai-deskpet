'use strict';

// Translate archive records before they reach the live detector. The original
// event sequence is preserved so evidence still points at the same log lines.
const { D1, point, insideHome } = require('../core/doctor-stationary');

const EXPECTED = new Set(['self_stuck', 'reserve_work_ended', 'waiting', 'adaptation_other_work',
  'sheltering_until_daylight', 'deferred', 'awaiting_daylight', 'night_shelter', 'night_restricted']);
const WORK_WAITS = new Set(['crops_growing', 'no_available_plot', 'waiting_for_wheat', 'sheltering_until_daylight']);
const ACTIVITY_WAITS = new Set(['sheltering_until_daylight', 'waiting_for_daylight', 'waiting_for_wheat']);
const IDLE_REASON = 'no_eligible_card_until_retry';

const nightWait = (reason) => /(?:shelter|wait|await|defer).*(?:night|daylight|dawn)|night_(?:shelter|restricted)/
  .test(reason || '');

function executionResult(result) {
  return result?.ok === true ? typeof result.progress === 'boolean' || Boolean(result.wait)
    : result?.ok === false && typeof result.kind === 'string' && result.attemptId != null;
}

function outcome(event, at) {
  const { type, behavior } = event;
  const reason = typeof event.reason === 'string' ? event.reason.toLowerCase() : null;
  const attemptId = 'archive:' + (Number.isFinite(event.failureAt) ? event.failureAt : at);
  const complete = { ok: true, progress: true };
  const wait = { ok: true, wait: { reason, until: at } };
  if (type === 'goal_yielded') {
    if (nightWait(reason) || reason === 'waiting' || Number.isFinite(event.waits)) return wait;
    return { ok: false, kind: 'target', reason, facts: {}, attemptId };
  }
  if (type === 'adaptation_attempt' && event.outcome === 'success') return complete;
  if ((type === 'behavior_finished' || type === 'home_relocation_leg') && event.ok === true) {
    return WORK_WAITS.has(reason) ? wait : complete;
  }
  if (type !== 'target_failure' && !(type === 'behavior_finished' && event.ok === false)
    && !(type === 'adaptation_attempt' && event.outcome === 'failure')
    && !(type === 'home_route_leg' && event.advanced === false)) return null;
  if (!reason || EXPECTED.has(reason) || nightWait(reason)) return null;
  const kind = reason === 'aborted' ? 'interrupted' : reason === 'no_material' ? 'material'
    : type === 'behavior_finished' && behavior === 'home_escape' ? 'start' : 'target';
  return { ok: false, kind, reason, facts: {}, attemptId };
}

function createArchiveAdapter({ measureRequiredMaterials = false } = {}) {
  const cooldowns = new Map();
  let latest = null;
  let burrowing = null;
  let shelter = null;
  let sheltered = false;
  let nightRest = null;
  let activityWait = null;
  let workWait = false;
  let previousSample = null;
  let modern = false;

  function retryEvidence(event, at) {
    if (event.type === 'autonomy_disabled') cooldowns.clear();
    if (event.type === 'autonomy_cooldown' && typeof event.card === 'string' && event.until > at) {
      const card = event.card.slice(0, 256);
      cooldowns.delete(card);
      cooldowns.set(card, { until: event.until, cooldownSequence: event.doctorSequence });
      if (cooldowns.size > 32) cooldowns.delete(cooldowns.keys().next().value);
    }
    if (event.type !== 'autonomy_idle' || event.reason != null || !Array.isArray(event.scores)) return null;
    let retry = null;
    for (const score of event.scores) {
      if (!score || typeof score !== 'object') continue;
      if (!score.skipped && score.score > 0) return null;
      const cooldown = score.skipped === 'cooldown' && cooldowns.get(score.id?.slice?.(0, 256));
      if (cooldown?.until > at && (!retry || cooldown.until < retry.until)) retry = cooldown;
    }
    return retry && { reason: IDLE_REASON, ...retry };
  }

  function restEvidence(event, at) {
    if (event.type === 'night' || event.type === 'night_rest') {
      if (event.action === 'dig_in' && typeof event.behavior === 'string') {
        burrowing = { at, behavior: event.behavior.slice(0, 256), generation: event.generation };
      }
      if (event.action === 'dug_in') sheltered = true;
      if (event.action === 'dug_out') {
        sheltered = false;
        burrowing = shelter = null;
      }
    }
    if (burrowing && event.behavior === burrowing.behavior && event.generation === burrowing.generation) {
      if (event.type === 'behavior_finished' && event.ok === true && at - burrowing.at <= D1.maxGapMs) {
        shelter = { at, position: null, dimension: null };
      }
      if (['behavior_finished', 'behavior_started', 'behavior_abandoned', 'preempted'].includes(event.type)) burrowing = null;
    }
    if (event.type === 'behavior_finished' && event.behavior === 'night_rest') {
      nightRest = event.reason === 'sheltering_until_daylight' ? at : null;
    }
    if (event.type !== 'doctor_observation') return null;
    const position = point(event.position);
    if (!position || !Number.isFinite(event.at)) {
      previousSample = shelter = null;
      return null;
    }
    const gap = previousSample !== null && (event.at <= previousSample || event.at - previousSample > D1.maxGapMs);
    previousSample = event.at;
    if (shelter) {
      const { position: origin, dimension, at: confirmed } = shelter;
      if (event.isDay !== false || event.sheltered != null || event.alive === false || gap
        || (!origin && event.at - confirmed > D1.maxGapMs)
        || (origin && (event.dimension !== dimension
          || Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z) >= D1.movementBlocks))) {
        shelter = null;
      } else if (!origin) {
        shelter = { ...shelter, position, dimension: event.dimension };
      }
    }
    const nightRestAtHome = nightRest !== null && 0 <= event.at - nightRest && event.at - nightRest < D1.maxGapMs
      && insideHome(event.home, position);
    return { stationarySheltered: (event.sheltered ?? (sheltered || shelter !== null)) || nightRestAtHome };
  }

  return function convert(event, sequence) {
    if (!event) return null;
    if (executionResult(event.result)) modern = true;
    const timestamp = Number.isFinite(event.at) ? event.at : event.doctorAt;
    const at = latest = Math.max(latest ?? -Infinity, Number.isFinite(timestamp) ? timestamp : latest ?? 0);
    const input = { ...event, doctorSequence: event.doctorSequence ?? sequence };
    if (modern) return input;
    if (measureRequiredMaterials && input.type === 'plan_step' && ['gather', 'hunt', 'craft', 'smelt'].includes(input.kind)) {
      input.requiredItem = input.key || input.item;
    }
    if (input.type === 'autonomy_death' || (input.type === 'interrupted' && input.reason === 'death')) {
      cooldowns.clear();
      burrowing = shelter = nightRest = activityWait = previousSample = null;
      sheltered = workWait = false;
    }
    const result = outcome(input, at);
    if (result) input.result = result;
    const retry = retryEvidence(input, at);
    if (retry) Object.assign(input, retry);
    const rest = restEvidence(input, at);
    if (rest) Object.assign(input, rest);
    if (input.type === 'behavior_finished' && ACTIVITY_WAITS.has(input.reason)) activityWait = at;
    if (input.type === 'goal_yielded' && nightWait(input.reason) && input.waits >= 2 && input.waitMs > 0) {
      input.waitBudgetExhausted = true;
    }
    if (input.type === 'goal_set' || ['goal_done', 'goal_cleared', 'goal_failed', 'goal_yielded', 'stopped',
      'plan_step', 'build', 'farm', 'site_dig', 'site_fill', 'home_relocation_leg', 'explore_for'].includes(input.type)) {
      workWait = false;
    }
    if (input.type === 'behavior_finished' && input.behavior?.startsWith('goal:') && WORK_WAITS.has(input.reason)) workWait = true;
    if (activityWait !== null) input.activityWaitUntil = activityWait + D1.maxGapMs;
    if (input.type === 'doctor_observation' && workWait) input.workWaiting = true;
    return input;
  };
}

module.exports = { createArchiveAdapter };
