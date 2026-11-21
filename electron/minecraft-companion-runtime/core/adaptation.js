'use strict';

const { randomUUID } = require('node:crypto');
const { createTargetMemory } = require('./target-memory');

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
const LEARN_TTL = { mine_danger: 24 * 60 * MINUTE, rejected_site: 6 * 60 * MINUTE,
  no_sheep: 45 * MINUTE, hard_route: 30 * MINUTE, lava_pool: 10 * MINUTE };
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
  helpIntervalMs = 60 * MINUTE, helpTimeoutMs = 20_000 } = {}) {
  let saved = {};
  try { saved = store?.load() || {}; } catch { /* start with no lessons */ }
  const states = new Map();
  const asked = new Map();
  let lessons = [];
  const pending = new Map();
  const completed = new Map();
  let lastProof = now();
  let lastContext = null;
  const emit = (type, fields) => { try { onEvent({ type, at: now(), ...fields }); } catch { /* observers do not own the body */ } };
  const targets = createTargetMemory({ now, load: saved.targets, onChange: persist, emit });
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
  for (const e of Array.isArray(saved.lessons) ? saved.lessons.slice(-MAX_ENTRIES) : []) {
    if (Object.hasOwn(LEARN_TTL, e?.kind) && position(e.position) && e.until > now()) {
      lessons.push({ kind: e.kind, dimension: token(e.dimension), position: position(e.position), reason: reasonCode(e.reason),
        radius: Math.min(500, Math.max(1, Number(e.radius) || 1)), until: Math.min(e.until, now() + LEARN_TTL[e.kind]) });
    }
  }

  function persist() {
    for (const [key, entry] of states) if (entry.until <= now()) states.delete(key);
    while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value);
    lessons = lessons.filter((e) => e.until > now()).slice(-MAX_ENTRIES);
    try { store?.save({ states: [...states.values()], lessons, asked: Object.fromEntries(asked), targets: targets.snapshot() }); }
    catch { /* this connection can still use the retained lessons */ }
  }

  function context(task, input = {}) {
    if (!Object.hasOwn(LADDERS, task)) throw new TypeError('Unknown adaptation task');
    const p = position(input.position);
    const dimension = token(input.dimension, 'overworld');
    const size = task === 'route' ? 8 : task === 'lava_pool' ? 16 : task === 'bed' ? 128 : 64;
    const region = p ? `${Math.floor(p.x / size)},${task === 'pit' || task === 'lava_pool' ? Math.floor(p.y / 8) : 0},${Math.floor(p.z / size)}` : 'unknown';
    const target = token(input.target);
    return { task, dimension, position: p, region, target, key: `${task}:${dimension}:${region}:${target}` };
  }

  function entry(c) {
    const prior = states.get(c.key);
    if (prior?.until > now()) return prior;
    states.delete(c.key);
    return { task: c.task, key: c.key, index: 0, count: 0, until: now() + TTL, revision: 0 };
  }
  function put(e) {
    states.delete(e.key);
    states.set(e.key, e);
    persist();
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
        const yields = choice === FALLBACK || choice === 'other_work' || choice === 'shelter_first';
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

  function defer(p) {
    const req = [...pending.values()].find((r) => r.context.key === p.key);
    const result = { ok: true, waited: true, reason: 'adaptation_other_work',
      retryAt: req ? Math.min(p.retryAt, req.deadline) : Math.max(now() + 30_000, p.retryAt) };
    helpEffect(p, result);
    return result;
  }

  function outcome(p, result, { threshold = LIMIT, valid = () => true, learn = null } = {}) {
    if (!valid() || !result || result.waited || ['aborted', 'self_stuck'].includes(result.reason)) return result;
    const e = entry(p);
    // Do not let late/cancelled outcomes change a newer decision.
    if (e.index !== p.index || e.revision !== p.revision) return { ...result, sourceHandled: true };
    lastContext = p;
    helpEffect(p, result);
    if (result.ok && !result.adaptFailure) {
      if (result.progress !== false) {
        lastProof = now();
        if (e.count) { e.count = 0; put(e); }
      }
      return { ...result, sourceHandled: true };
    }
    const reason = reasonCode(result.adaptFailure || result.reason);
    const cap = Math.max(1, Math.min(LIMIT, threshold));
    const failures = e.count + 1;
    const fields = { task: p.task, method: p.method, region: p.region, dimension: p.dimension, target: p.target, position: p.position };
    emit('adaptation_attempt', { ...fields, outcome: 'failure', failures, reason });
    if (failures > LIMIT) emit('adaptation_invariant', { ...fields, failures, reason });
    e.failed = reason;
    e.until = now() + TTL;
    if (failures >= cap) {
      if (learn) teach(learn.kind, learn.position || p.position, p.dimension, reason, learn.radius);
      e.index = Math.min(LADDERS[p.task].length, e.index + 1);
      e.revision += 1;
      e.count = 0;
      if (!LADDERS[p.task][e.index]) {
        e.fresh = false;
        e.retryAt = now() + 5 * MINUTE;
        e.until = e.retryAt;
      } else if (LADDERS[p.task][e.index] === 'other_work' || LADDERS[p.task][e.index] === 'shelter_first') {
        e.until = now() + (p.task === 'bed' ? LEARN_TTL.no_sheep : 5 * MINUTE);
        e.retryAt = e.until;
      }
      put(e);
      emit('adaptation_switch', { ...fields, from: p.method, to: LADDERS[p.task][e.index] || FALLBACK, reason, failures });
      if (!LADDERS[p.task][e.index]) ask(p, e, 'ladder_exhausted');
    } else {
      e.count = failures;
      put(e);
    }
    poll();
    return { ...result, sourceHandled: true, ...(failures >= cap ? { adaptationSwitched: true } : {}) };
  }

  function teach(kind, p, dimension, reason, radius = 32) {
    const where = position(p);
    if (!where || !Object.hasOwn(LEARN_TTL, kind)) return;
    const lesson = { kind, dimension: token(dimension, 'overworld'), position: where,
      reason: reasonCode(reason), radius: Math.min(500, Math.max(1, radius)), until: now() + LEARN_TTL[kind] };
    lessons = lessons.filter((e) => e.kind !== kind || e.dimension !== lesson.dimension
      || Math.hypot(e.position.x - where.x, e.position.z - where.z) > Math.min(e.radius, lesson.radius) / 2
      || (kind === 'lava_pool' && Math.abs(e.position.y - where.y) > 4));
    lessons.push(lesson);
    persist();
    emit('adaptation_lesson', lesson);
  }
  function avoids(kind, p, dimension = 'overworld') {
    return position(p) !== null && lessons.some((e) => e.kind === kind && e.dimension === dimension && e.until > now()
      && Math.hypot(e.position.x - p.x, e.position.z - p.z) <= e.radius
      && (kind !== 'lava_pool' || Math.abs(e.position.y - p.y) <= 4));
  }
  function promote(task, input, method, reason) {
    const p = plan(task, input);
    const e = entry(p);
    const index = LADDERS[task].indexOf(method);
    if (index <= e.index) return false;
    e.index = index;
    e.revision += 1;
    e.count = 0;
    e.failed = reasonCode(reason);
    e.until = method === 'other_work' ? (e.retryAt = now() + 5 * MINUTE) : now() + TTL;
    put(e);
    emit('adaptation_switch', { ...p, from: p.method, to: method, reason: e.failed });
    return true;
  }
  function scope(valid) {
    return { plan, avoids, targets: targets.scope(valid), progress: () => { if (valid()) lastProof = now(); },
      teach: (...args) => valid() && teach(...args), promote: (...args) => valid() && promote(...args),
      outcome: (p, result, options) => outcome(p, result, { ...options, valid }),
      async run(task, input, execute, options) {
        const p = plan(task, input);
        if (!valid()) return { ok: false, reason: 'aborted' };
        if (p.method === FALLBACK) return defer(p);
        return outcome(p, await execute(p.method, p), { ...options, valid });
      } };
  }
  return { plan, scope, promote, teach, avoids, reply, poll, defer, targets, progress: () => { lastProof = now(); }, pending: () => pending.size };
}

module.exports = { createAdaptation, LADDERS, FALLBACK, NEW_AREA };
