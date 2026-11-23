'use strict';

const { randomUUID } = require('node:crypto');
const { failure, isRescueBehavior, resultFrom, waiting } = require('./action-result');
const { createFailureLedger } = require('./failure-ledger');

const MINUTE = 60_000;
const LIMIT = 3;
const LADDERS = Object.freeze(Object.fromEntries(Object.entries({
  home_site: ['near_flat', 'more_earthwork', 'compact', 'hillside', 'relocate'],
  wood: ['near_tree', 'wider_heading', 'different_biome'],
  bed: ['sheep', 'spider_string', 'shelter_first'],
  route: ['direct', 'waypoint', 'alternate_target', 'avoid_region'],
  diamond: ['current_mine', 'new_entrance', 'sealed_mine', 'different_region'],
  mine_hazard: ['self_rescue', 'known_exit', 'avoid_region'],
  pit: ['pathfinder', 'direct_pillar', 'side_stairs'],
  lava_pool: ['near_source', 'different_pool'],
  goal: ['standard', 'recover', 'other_work'],
}).map(([task, methods]) => [task, Object.freeze(methods)])));
const FALLBACK = 'do_other_work';
const NEW_AREA = 'move_to_fresh_area';
// Only tasks with an executable fresh-area strategy may offer it to the model.
const MOVABLE = new Set(['home_site', 'wood', 'diamond']);
const IMMEDIATE_FAILURES = {
  home_site: new Set(['no_suitable_site', 'relocation_routes_exhausted']),
  wood: new Set(['no_target_in_range']),
  bed: new Set(['no_mob_in_range', 'bed_hunt_exhausted']),
  route: new Set(['choose_another_target', 'route_region_avoided']),
  goal: new Set(['no_recovery_available', 'goal_methods_exhausted']),
};
const TTL = 90 * MINUTE;
const MAX_ENTRIES = 128;

function position(p) {
  return p && ['x', 'y', 'z'].every((axis) => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 30_000_000)
    ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
}
const token = (value, fallback = 'none') => typeof value === 'string' && /^[a-z0-9_/-]{1,60}$/i.test(value) ? value : fallback;
const reasonCode = (value) => typeof value === 'string'
  ? (value.slice(0, 80).match(/^[a-z][a-z_0-9-]*/i)?.[0] || 'failed').toLowerCase() : 'failed';

function createAdaptation({ now = Date.now, onEvent = () => {}, store = null, stallMs = 45 * MINUTE,
  helpIntervalMs = 60 * MINUTE, helpTimeoutMs = 20_000, atHome = () => false, playerProtected = () => false } = {}) {
  let saved = {};
  try { saved = store?.load() || {}; } catch { /* start with no lessons */ }
  const states = new Map();
  const asked = new Map();
  const pending = new Map();
  const completed = new Map();
  let lastProof = now();
  let lastContext = null;
  let transferring = false;
  const emit = (type, fields) => { try { onEvent({ type, at: now(), ...fields }); } catch { /* observers do not own the body */ } };
  const failureLedger = createFailureLedger({ now, load: saved.failureLedger, legacyTargets: saved.targets, legacyLessons: saved.lessons,
    legacyStates: saved.states,
    onChange: () => { if (!transferring) persist(); }, emit,
    protectedTarget: (p, dimension) => atHome(p, dimension) || playerProtected(p, dimension) });
  const destinations = failureLedger.scope();
  for (const e of Array.isArray(saved.states) ? saved.states.slice(-MAX_ENTRIES) : []) {
    if (typeof e?.key === 'string' && e.key.length <= 150 && Object.hasOwn(LADDERS, e.task) && e.until > now()
      && Number.isInteger(e.index) && e.index >= 0 && e.index <= LADDERS[e.task].length) {
      states.set(e.key, { key: e.key, task: e.task, index: e.index, count: Math.max(0, Math.min(LIMIT, e.count | 0)),
        until: Math.min(e.until, now() + TTL), failed: reasonCode(e.failed), retryAt: Math.min(e.retryAt || 0, now() + 10 * MINUTE),
        fresh: e.fresh === true, revision: Number.isSafeInteger(e.revision) ? e.revision : 0 });
    }
  }
  for (const [key, at] of Object.entries(saved.asked || {})) {
    if (Object.hasOwn(LADDERS, key) && Number.isFinite(at) && at <= now() && at > now() - helpIntervalMs) asked.set(key, at);
  }
  function persist() {
    for (const [key, entry] of states) if (entry.until <= now()) states.delete(key);
    while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value);
    try { store?.save({ states: [...states.values()], asked: Object.fromEntries(asked), failureLedger: failureLedger.persisted() }); }
    catch { /* this connection can still use the retained lessons */ }
  }

  function context(task, input = {}) {
    if (!Object.hasOwn(LADDERS, task)) throw new TypeError('Unknown adaptation task');
    const p = position(input.position);
    const dimension = token(input.dimension, 'overworld');
    const size = task === 'pit' ? 1 : task === 'route' ? 8 : task === 'lava_pool' ? 16 : task === 'bed' ? 128 : 64;
    const region = p ? `${Math.floor(p.x / size)},${task === 'lava_pool' ? Math.floor(p.y / 8) : 0},${Math.floor(p.z / size)}` : 'unknown';
    const origin = task === 'route' ? position(input.origin) : null;
    const departure = origin ? `:${Math.floor(origin.x / 16)},${Math.floor(origin.y / 8)},${Math.floor(origin.z / 16)}` : '';
    const target = token(input.target);
    return { task, dimension, position: p, region, target, ...(origin ? { origin } : {}),
      key: `${task}:${dimension}:${region}:${target}${departure}` };
  }

  function entry(c) {
    const prior = states.get(c.key);
    if (prior?.until > now()) return prior;
    states.delete(c.key);
    return { task: c.task, key: c.key, index: 0, count: 0, until: now() + TTL, revision: 0 };
  }
  function put(e, flush = true) {
    states.delete(e.key);
    states.set(e.key, e);
    if (flush) persist();
  }
  function plan(task, input) {
    const c = context(task, input);
    const e = entry(c);
    const methods = LADDERS[task];
    const method = methods[e.index] || (e.fresh && MOVABLE.has(task) ? NEW_AREA : FALLBACK);
    return { ...c, method, index: e.index, revision: e.revision, retryAt: e.retryAt || 0, failures: e.count,
      explanation: e.failed || (e.index ? 'known_lessons' : 'initial_method') };
  }

  function ask(c, e, trigger) {
    if (now() - (asked.get(c.task) ?? -Infinity) < helpIntervalMs) return;
    const methods = LADDERS[c.task];
    const remaining = methods.slice(e.index + 1);
    const choices = [...new Set([...remaining, ...(MOVABLE.has(c.task) ? [NEW_AREA] : []), FALLBACK])];
    const id = randomUUID();
    const deadline = now() + helpTimeoutMs;
    const request = { id, context: c, revision: e.revision, choices, deadline, trigger };
    pending.set(id, request);
    asked.set(c.task, now());
    persist();
    emit('adaptation_help', { requestId: id, task: c.task, trigger, current: methods[e.index] || FALLBACK, choices,
      summary: { reason: e.failed || 'no_progress', failures: e.count, tried: methods.slice(0, Math.min(e.index + 1, methods.length)) },
      deadline });
  }

  function finishHelp(request, choice, reason) {
    pending.delete(request.id);
    const e = entry(request.context);
    let applied = false;
    if (choice && e.revision === request.revision) {
      const index = LADDERS[request.context.task].indexOf(choice);
      if (index > e.index || choice === NEW_AREA || choice === FALLBACK) {
        const old = LADDERS[e.task][e.index] || FALLBACK;
        e.index = index >= 0 ? index : LADDERS[e.task].length;
        e.fresh = choice === NEW_AREA;
        const yields = choice === FALLBACK;
        e.retryAt = yields ? now() + 5 * MINUTE : 0;
        e.until = yields ? e.retryAt : now() + TTL;
        e.revision += 1;
        e.count = 0;
        e.failed = 'model_choice';
        put(e);
        emit('adaptation_switch', { ...request.context, from: old, to: choice, reason: 'model_choice' });
        completed.set(request.context.key, { id: request.id, revision: e.revision });
        while (completed.size > MAX_ENTRIES) completed.delete(completed.keys().next().value);
        applied = true;
      }
    }
    if (!applied && request.trigger === 'no_progress' && e.revision === request.revision) {
      const task = request.context.task;
      const next = LADDERS[task][e.index + 1];
      if (next) promote(task, request.context, next, reason);
    }
    emit('adaptation_help_result', { requestId: request.id, task: request.context.task, choice: applied ? choice : null,
      reason: applied ? 'model_choice' : reason, fallback: applied ? null : plan(request.context.task, request.context).method });
    return applied;
  }
  function reply(id, choice) {
    const req = pending.get(id);
    if (!req) return false;
    if (now() >= req.deadline) return finishHelp(req, null, 'timeout');
    if (choice !== null && !req.choices.includes(choice)) return false;
    return finishHelp(req, choice, choice === null ? 'model_unavailable' : 'superseded');
  }
  function poll() {
    for (const req of pending.values()) if (req.deadline <= now()) finishHelp(req, null, 'timeout');
    if (lastContext && now() - lastProof >= stallMs) ask(lastContext, entry(lastContext), 'no_progress');
  }

  function helpEffect(p, result) {
    const choice = completed.get(p.key);
    if (choice?.revision !== p.revision) return;
    completed.delete(p.key);
    emit('adaptation_help_effect', { requestId: choice.id, task: p.task, method: p.method,
      ok: result.ok === true, reason: result.reason ? reasonCode(result.reason) : null });
  }

  function retryAt(p) {
    const req = [...pending.values()].find((r) => r.context.key === p.key);
    return req ? Math.min(p.retryAt, req.deadline) : Math.max(now() + 30_000, p.retryAt);
  }

  function exhaustion(p, method, reason) {
    return { task: p.task, method, key: p.key, reason, retryAt: retryAt(p) };
  }

  function defer(p) {
    const result = waiting('adaptation_other_work', retryAt(p));
    helpEffect(p, result);
    return result;
  }

  function finishDestinations(e) {
    transferring = true;
    try {
      failureLedger.finish(e.key, e.task);
    } finally {
      transferring = false;
      persist();
    }
  }

  function outcome(p, result, { threshold = LIMIT, valid = () => true, learn = null, observations = [] } = {}) {
    if (!result) return result;
    result = resultFrom(result);
    if (result.facts?.rescue && !isRescueBehavior(p.task)) return resultFrom(result, {});
    if (!valid() || result.wait || ['start', 'interrupted'].includes(result.kind)) return result;
    const e = entry(p);
    const owned = fields => result.ok ? result : { ...result, facts: { ...result.facts, adaptation: { task: p.task, method: p.method, ...fields } } };
    // Do not let late/cancelled outcomes change a newer decision.
    if (e.index !== p.index || e.revision !== p.revision) return owned();
    failureLedger.stage(e.key, now() + TTL, observations);
    if (result.facts?.adaptation || result.facts?.target) {
      if (observations.length) put(e);
      return result;
    }
    lastContext = p;
    helpEffect(p, result);
    if (result.ok) {
      if (result.progress !== false) {
        lastProof = now();
        if (e.count) { e.count = 0; put(e); }
        else if (observations.length) put(e);
      } else if (observations.length) {
        put(e);
      }
      return result;
    }
    if (result.kind === 'material') return result;
    const reason = reasonCode(result.reason);
    if (p.method === FALLBACK) return defer(p);
    const cap = IMMEDIATE_FAILURES[p.task]?.has(reason) ? 1 : Math.max(1, Math.min(LIMIT, threshold));
    const failures = e.count + 1;
    const fields = { task: p.task, method: p.method, key: p.key, region: p.region, dimension: p.dimension,
      target: p.target, position: p.position };
    emit('adaptation_attempt', { ...fields, outcome: 'failure', failures, reason, result });
    if (failures > LIMIT) emit('adaptation_invariant', { ...fields, failures, reason });
    e.failed = reason;
    e.until = now() + TTL;
    let adaptationExhausted;
    if (failures >= cap) {
      const lesson = typeof learn === 'function' ? learn(result, p) : learn;
      if (lesson) teach(lesson.kind, lesson.position || p.position, p.dimension, result, lesson.radius);
      e.index = Math.min(LADDERS[p.task].length, e.index + 1);
      e.revision += 1;
      e.count = 0;
      const finished = !LADDERS[p.task][e.index];
      if (finished) {
        e.fresh = false;
        e.retryAt = now() + 5 * MINUTE;
        e.until = e.retryAt;
      }
      put(e, !finished);
      emit('adaptation_switch', { ...fields, from: p.method, to: LADDERS[p.task][e.index] || FALLBACK, reason, failures });
      if (finished) {
        ask(p, e, 'ladder_exhausted');
        adaptationExhausted = exhaustion({ ...p, retryAt: e.retryAt }, p.method, reason);
        emit('adaptation_exhausted', { ...fields, ...adaptationExhausted });
        finishDestinations(e);
      }
    } else {
      e.count = failures;
      put(e);
    }
    poll();
    return owned({ switched: failures >= cap, exhausted: adaptationExhausted });
  }

  function teach(kind, p, dimension, raw, radius = 32) {
    const where = position(p);
    if (!where) return;
    const result = typeof raw !== 'string' ? raw : failure(kind === 'mine_danger'
      ? 'mine_route_hazard' : raw, kind === 'mine_danger' ? { originalReason: raw } : {});
    failureLedger.record(result, { purpose: kind, dimension, position: where, radius });
  }
  const avoids = (kind, p, dimension) => failureLedger.regionHard(p, dimension, kind);
  const pruneHome = () => failureLedger.pruneProtected();
  function promote(task, input, method, reason) {
    const p = plan(task, input);
    const e = entry(p);
    const index = LADDERS[task].indexOf(method);
    if (index <= e.index) return false;
    e.index = index;
    e.revision += 1;
    e.count = 0;
    e.failed = reasonCode(reason);
    e.retryAt = 0;
    e.until = now() + TTL;
    put(e);
    emit('adaptation_switch', { ...p, from: p.method, to: method, reason: e.failed });
    return true;
  }
  function scope(valid) {
    const ledger = failureLedger.scope(valid);
    return { plan, avoids, ledger, targets: ledger, failureLedger, pruneHome: () => { if (valid()) pruneHome(); },
      progress: () => { if (valid()) lastProof = now(); },
      teach: (...args) => valid() && teach(...args), promote: (...args) => valid() && promote(...args),
      outcome: (p, result, options) => outcome(p, result, { ...options, valid }),
      async run(task, input, execute, options) {
        const p = plan(task, input);
        if (!valid()) return failure('aborted');
        if (p.method === FALLBACK) return defer(p);
        const observations = [];
        const observeDestination = (spec, result) => {
          if (!valid()) return null;
          const item = destinations.capture(spec, resultFrom(result));
          if (!item) return null;
          observations.push(item);
          return () => failureLedger.revoke(item);
        };
        return outcome(p, await execute(p.method, p, observeDestination), { ...options, valid, observations });
      } };
  }
  return { plan, scope, promote, teach, avoids, reply, poll, defer, failureLedger, pruneHome,
    progress: () => { lastProof = now(); }, pending: () => pending.size };
}

module.exports = { createAdaptation, LADDERS, FALLBACK, NEW_AREA };
