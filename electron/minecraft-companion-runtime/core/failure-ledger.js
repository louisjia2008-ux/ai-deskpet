'use strict';

const { Vec3 } = require('vec3');
const { classifyReason, failure, rescueOf, resultFrom } = require('./action-result');
const { homeContains } = require('./home-topology');

const MINUTE = 60_000;
const MAX = 1024;
const REGION_MAX = 128;
const STAGED_MAX = 32;
const policies = {
  // Persistent targets and lessons retain the original target-memory and adaptation limits.
  target: [30 * MINUTE, 3, true], chase: [10 * MINUTE, 3, true],
  hard_route: [30 * MINUTE, 1, true], mine_danger: [24 * 60 * MINUTE, 1, true],
  rejected_site: [6 * 60 * MINUTE, 1, true], no_sheep: [45 * MINUTE, 1, true], lava_pool: [10 * MINUTE, 1, true],
  // Concrete candidates retain the old goal-local blacklist and director timings.
  gather: [2 * MINUTE, 1], farm_gather: [MINUTE, 1], grass: [MINUTE, 1],
  ore: [2 * MINUTE, 1], liquid: [2 * MINUTE, 1], gather_blocks: [2 * MINUTE, 1],
  hunt: [MINUTE, 1], hunt_far: [5 * MINUTE, 1], berry: [MINUTE, 1],
  guard_hunt: [30_000, 1],
  berry_materials: [2 * MINUTE, 1], ranch_fence: [15_000, 1], ranch_lure: [20_000, 1],
  director_step: [10 * MINUTE, 3], mine_entrance: [10 * MINUTE, 1],
  lava_pool_candidate: [10 * MINUTE, 3, false, 30 * MINUTE],
  // R6 callers retain their existing per-purpose duration while using the same ledger.
  legacy_30000: [30_000, 1], legacy_60000: [MINUTE, 1], legacy_120000: [2 * MINUTE, 1],
  legacy_180000: [3 * MINUTE, 1], legacy_240000: [4 * MINUTE, 1], legacy_300000: [5 * MINUTE, 1],
  legacy_3600000: [60 * MINUTE, 1],
};
const regionPurposes = new Set(['hard_route', 'mine_danger', 'rejected_site', 'no_sheep', 'lava_pool', 'mine_entrance', 'lava_pool_candidate']);
const token = value => typeof value === 'string' && /^[a-z0-9_:/,-]{1,110}$/i.test(value) ? value : null;
const cell = p => p && [p.x, p.y, p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 30_000_000)
  ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
const cellKey = p => p ? [p.x, p.y, p.z].join(',') : null;
const asCell = value => /^-?\d+,-?\d+,-?\d+$/.test(value || '')
  ? cell(Object.fromEntries(value.split(',').map((n, i) => [['x', 'y', 'z'][i], Number(n)]))) : null;
const radiusOf = value => Math.min(500, Math.max(1, Number(value) || 1));

function context(spec) {
  const dimension = token(spec.dimension)?.replace(/^minecraft:/, '') || 'overworld';
  const position = cell(spec.position);
  const goal = token(spec.goal), step = token(spec.step);
  const purpose = token(spec.purpose) || (step === 'chase' ? step : goal && step ? 'target' : null);
  if (!purpose || (!position && purpose !== 'director_step')) return null;
  const target = spec.entity == null ? cellKey(position) : token(String(spec.entity));
  if (!target) return null;
  const key = goal && step ? [dimension, goal, step, target].join('|') : [dimension, purpose, target].join('|');
  return { key, purpose, dimension, position, target, ...(goal && step ? { goal, step } : {}),
    ...(regionPurposes.has(purpose) ? { radius: radiusOf(spec.radius) } : {}) };
}

const observed = spec => {
  const value = spec.witness?.();
  return typeof value === 'string' ? value.slice(0, 1600) : null;
};
const covers = (entry, p, radius = entry.radius) => {
  const distance = Math.hypot(entry.position.x - p.x, entry.position.z - p.z);
  return (entry.purpose === 'mine_entrance' ? distance < radius : distance <= radius)
    && (!entry.purpose.startsWith('lava_pool') || Math.abs(entry.position.y - p.y) <= 4);
};

function createFailureLedger({ now = Date.now, load, legacyTargets = [], legacyLessons = [], legacyStates = [], protectedTarget = () => false,
  onChange = () => {}, emit = () => {} } = {}) {
  const entries = new Map();
  const staged = new Map(), transfers = new WeakMap();
  const protectedCell = fields => fields.position && protectedTarget(fields.position, fields.dimension);
  const policy = fields => policies[fields.purpose];
  const active = entry => entry.until > now() && !protectedCell(entry);

  function save(key, value) {
    const previous = entries.get(key);
    entries.delete(key);
    if (value) entries.set(key, value);
    if (entries.size > MAX) entries.delete([...entries.values()].find(e => !active(e))?.key ?? entries.keys().next().value);
    if (policies[previous?.purpose]?.[2] || policies[value?.purpose]?.[2]) onChange();
  }

  function restore(fields, entry, legacy = false) {
    const rule = fields && policy(fields);
    if (!rule?.[2] || !Number.isFinite(entry.until) || entry.until <= now() || protectedCell(fields)) return;
    const [ttl, limit] = rule;
    if (!Number.isInteger(entry.failures) || entry.failures < 1 || entry.failures > limit || !entry.reason) return;
    const storedReason = migrationReason(entry.reason, fields.purpose);
    if (!storedReason) return;
    const witness = typeof entry.witness === 'string' ? entry.witness.slice(0, 1600) : null;
    entries.set(fields.key, { ...fields, reason: storedReason, witness, failures: entry.failures,
      until: Math.min(entry.until, now() + ttl), sameReasonFailures: Math.max(1, Math.min(limit, entry.sameReasonFailures | 0)),
      ...(entry.ladder || (legacy && entry.handedOff === true) ? { ladder: entry.ladder || true } : {}) });
  }
  const last = items => Array.isArray(items) ? items.slice(-MAX) : [];
  for (const entry of last(load?.entries)) {
    if (!entry || typeof entry.target !== 'string') continue;
    const fields = context({ ...entry, entity: entry.target });
    if (fields?.key === entry.key) restore(fields, entry);
  }
  for (const entry of load ? [] : last(legacyTargets)) {
    if (typeof entry?.key !== 'string') continue;
    const [dimension, goal, step, target] = entry.key.split('|');
    const fields = context({ dimension, goal, step, entity: target, position: entry.position || asCell(target) });
    if (fields?.key === entry.key) restore(fields, entry, true);
  }
  for (const entry of load ? [] : last(legacyLessons).slice(-REGION_MAX)) {
    if (!regionPurposes.has(entry?.kind)) continue;
    const fields = context({ ...entry, purpose: entry.kind });
    restore(fields, { ...entry, failures: 1 });
  }

  function pruneProtected() {
    let changed = false;
    for (const [key, entry] of entries) if (protectedCell(entry)) changed = entries.delete(key) || changed;
    if (changed) onChange();
    return changed;
  }

  function stage(key, until, observations) {
    if (!observations.length) return;
    const previous = staged.get(key);
    const items = previous?.until > now() ? previous.items.filter(item => !item.revoked) : [];
    for (const item of observations) {
      if (item.result.ok) {
        for (let index = items.length - 1; index >= 0; index--) if (items[index].key === item.key) items.splice(index, 1);
      } else if (!item.revoked) items.push(item);
    }
    staged.delete(key);
    if (items.length) staged.set(key, { key, until, items: items.slice(-STAGED_MAX) });
    if (staged.size > REGION_MAX) staged.delete(staged.keys().next().value);
  }
  for (const batch of last(load?.staged || legacyStates).slice(-REGION_MAX)) {
    const raw = batch?.items || batch?.destinations;
    if (typeof batch?.key !== 'string' || batch.until <= now() || !Array.isArray(raw)) continue;
    const items = raw.slice(-STAGED_MAX).flatMap(item => {
      if (!item || item.revoked) return [];
      const fields = context({ ...item, entity: item.target });
      const reason = migrationReason(item.result?.reason || item.reason, fields?.purpose);
      if (fields?.key !== item.key || !reason || protectedCell(fields)) return [];
      return [{ ...fields, result: failure(reason), witness: typeof item.witness === 'string' ? item.witness.slice(0, 1600) : null }];
    });
    stage(batch.key, batch.until, items);
  }

  function finish(key, ladder) {
    const batch = staged.get(key);
    if (!batch) return;
    staged.delete(key);
    const candidates = new Map(batch.items.filter(e => !e.revoked).map(e => [e.key, e]));
    for (const item of candidates.values()) transfers.set(item, scope().handoff(item, ladder));
  }
  function revoke(item) {
    item.revoked = true;
    if (transfers.get(item)) return transfers.get(item)();
    onChange();
  }

  function scope(valid = () => true, recordEvent = emit, reviewFailure = null) {
    if (typeof recordEvent !== 'function') recordEvent = emit;
    function read(fields, spec) {
      if (!fields || protectedCell(fields)) return null;
      const found = entries.get(fields.key);
      if (!found) return null;
      const reachedLimit = found.failures >= policy(fields)[1] || found.ladder;
      const witness = reachedLimit && observed(spec);
      const reason = found.until <= now() ? 'expired'
        : witness && found.witness !== null && witness !== found.witness ? 'environment_changed' : null;
      if (!reason) return found;
      if (reachedLimit) recordEvent('target_retry', { ...fields, reason });
      save(fields.key, null);
      return null;
    }

    function skip(spec) {
      const fields = context(spec);
      const found = read(fields, spec);
      return found && found.failures >= policy(fields)[1] ? found : null;
    }

    function clearOnSuccess(spec) {
      const fields = context(spec);
      if (valid() && fields && entries.has(fields.key)) save(fields.key, null);
    }

    function record(result, spec, { ladder, extending = false, review = reviewFailure } = {}) {
      if (!valid() || result?.ok !== false || result.kind !== 'target' || result.facts?.rescue) return null;
      let fields = context(spec);
      const rule = fields && policy(fields);
      if (!rule || protectedCell(fields)) return null;
      const [ttl, limit, , window] = rule;
      if (window) {
        const pool = [...entries.values()].find(e => e.purpose === fields.purpose && e.dimension === fields.dimension
          && active(e) && covers(e, fields.position));
        if (pool) fields = context({ ...fields, position: pool.position });
      }
      const found = read(fields, spec);
      if (found?.attemptId && found.attemptId === result.attemptId) return null;
      const region = regionPurposes.has(fields.purpose);
      if (found?.failures >= limit && (!region || window)) return null;
      const recoveryPending = Boolean(ladder && found?.failures === limit - 1);
      const failureAt = now();
      const recent = window && [...(found?.recent || []).filter(at => at > failureAt - window), failureAt];
      const failures = recent ? recent.length : region ? 1 : (found?.failures || 0) + (recoveryPending ? 0 : 1);
      const sameReasonFailures = found?.reason === result.reason ? Math.min(limit, found.sameReasonFailures + (recoveryPending ? 0 : 1)) : 1;
      const until = failureAt + (window && failures < limit ? window : ttl);
      const state = { ...fields, reason: result.reason, attemptId: result.attemptId, failures, sameReasonFailures,
        witness: observed(spec), until, ...(ladder ? { ladder } : {}), ...(recent ? { recent } : {}) };
      const undo = () => {
        if (entries.get(fields.key) !== state) return undefined;
        save(fields.key, found);
        return { ...fields, originalReason: result.reason, excluded: failures === limit, failureAt };
      };
      if (review?.(fields, result, undo)) return null;
      if (region) {
        for (const [key, entry] of entries) {
          if (entry.purpose === fields.purpose && entry.dimension === fields.dimension
            && covers(entry, fields.position, Math.min(entry.radius, fields.radius) / 2)) entries.delete(key);
        }
        const regions = [...entries.values()].filter(e => regionPurposes.has(e.purpose));
        if (regions.length >= REGION_MAX) entries.delete(regions[0].key);
      }
      save(fields.key, state);
      const evidence = { ...fields, result, reason: result.reason, failures, sameReasonFailures, failureAt, until,
        ...(ladder ? { ladder, recoveryPending } : {}) };
      if (region) recordEvent('adaptation_lesson', { ...evidence, kind: fields.purpose });
      else recordEvent('target_failure', { ...evidence, recovery: extending });
      if (failures === limit) recordEvent('target_excluded', evidence);
      return { undo, key: fields.key, failures, retryAt: until, excluded: failures === limit };
    }

    function regionHard(position, dimension = 'overworld', purpose = 'hard_route') {
      if (!cell(position) || protectedTarget(position, dimension)) return false;
      return [...entries.values()].some(e => e.purpose === purpose && e.dimension === dimension && e.failures >= policy(e)[1]
        && active(e) && covers(e, position));
    }
    function clearWhere(predicate) {
      if (!valid()) return;
      for (const entry of entries.values()) if (predicate(entry, policy(entry)[1])) save(entry.key, null);
    }
    function avoid(spec) {
      const fields = context(spec);
      const found = valid() && read(fields, spec);
      return Boolean(found && (found.failures >= policy(fields)[1] || (found.ladder && found.failures < 2)));
    }
    function recovering(spec) {
      const found = valid() && read(context(spec), spec);
      return Boolean(found?.ladder && found.failures === 2);
    }
    function capture(spec, result) {
      const fields = context(spec);
      if (!valid() || !fields || protectedCell(fields) || result?.facts?.rescue || (result?.ok !== false && !result?.progress)
        || (result?.ok === false && result.kind !== 'target')) return null;
      return { ...fields, result, witness: observed(spec) };
    }
    function handoff(observation, ladder) {
      const { result, target, witness, ...fields } = observation;
      return record(result, { ...fields, entity: target, witness: () => witness }, { ladder })?.undo;
    }
    async function run(spec, attempt, recover, ctx, bot) {
      if (!valid()) return failure('aborted', {}, ctx, bot);
      const fields = context(spec);
      const found = read(fields, spec);
      if (found && found.failures === policy(fields)[1]) return failure('target_excluded',
        { target: { key: fields.key, failures: found.failures, excluded: true, retryAt: found.until } }, ctx, bot);
      const extending = found && found.failures === policy(fields)[1] - 1 && Boolean(recover);
      if (extending) recordEvent('target_recovery', { ...fields, reason: found.reason, failures: found.failures });
      let result = resultFrom(await (extending ? recover(found.reason) : attempt()), ctx, bot);
      if (!valid() || result.wait) return result;
      if (fields && protectedCell(fields) && result.kind === 'target' && recover) {
        result = resultFrom(await recover(result.reason), ctx, bot);
      }
      if (result.ok) {
        if (found && !result.wait) {
          clearOnSuccess(spec);
          recordEvent('target_reached', { ...fields, afterRecovery: extending });
        }
        return result;
      }
      const saved = record(result, spec, { extending });
      if (!saved) return bot?.companionSelfStuck?.state() ? failure('self_stuck', {}, ctx, bot) : result;
      const { undo: _undo, ...target } = saved;
      return { ...result, facts: { ...result.facts, target } };
    }
    return { record, skip, clearOnSuccess, regionHard, clearWhere, run, avoid, recovering, capture, handoff, excluded: skip };
  }
  const snapshot = persistent => [...entries.values()].filter(e => active(e) && (!persistent || policy(e)[2]));
  const persisted = () => ({ entries: snapshot(true), staged: [...staged.values()].filter(e => e.until > now())
    .slice(-REGION_MAX).map(e => ({ ...e, items: e.items.filter(item => !item.revoked && !protectedCell(item)) })) });
  return { ...scope(), scope, snapshot, persisted, pruneProtected, stage, finish, revoke };
}

function migrationReason(raw, purpose) {
  try {
    const reason = typeof raw === 'string' ? raw.toLowerCase() : null;
    if (classifyReason(reason) === 'target') return reason;
  } catch { /* Old snapshots also stored native diagnostic text and state markers. */ }
  if (purpose === 'mine_danger') return 'mine_route_hazard';
  if (purpose === 'rejected_site') return 'site_rejected';
  return null;
}

const connections = new WeakMap();
function ledgerFor(bot, ctx = {}) {
  const scoped = ctx.adapt?.ledger;
  let ledger = bot.companionFailureLedger || connections.get(bot);
  if (!ledger && !scoped) {
    ledger = createFailureLedger({ protectedTarget: (p, dimension) => {
      const position = new Vec3(p.x, p.y, p.z);
      return dimension === dimensionOf(bot) && (bot.companionPlayerBlock?.(position) || bot.companionHomeTarget?.(position, dimension)
        || (dimension === 'overworld' && homeContains(bot.companionHomestead?.()?.memory?.house, position)));
    } });
    connections.set(bot, ledger);
  }
  const scope = scoped || ledger.scope(() => !ctx.signal?.aborted, ctx.record);
  const tracker = bot.companionSelfStuck;
  return !tracker || rescueOf(ctx) ? scope : { ...scope, record(result, spec, options) {
    return scope.record(result, spec, { ...options, review: (fields, error, undo) => fields.position
      && tracker.failed(fields.target, error.reason, null, undo) });
  } };
}

function targetsFor(bot, ctx = {}) {
  const ledger = bot.companionFailureLedger || ctx.adapt?.failureLedger;
  const origin = () => bot.entity?.position?.clone();
  const tracker = bot.companionSelfStuck;
  const scope = ledgerFor(bot, ctx);
  return { ...scope, run(spec, attempt, recover) {
    if (!tracker || rescueOf(ctx) || !ledger) return scope.run(spec, attempt, recover, ctx, bot);
    const before = origin();
    const reviewed = ledger.scope(() => !ctx.signal?.aborted, ctx.record,
      (fields, result, undo) => tracker.failed(fields.target, result.reason, before, undo));
    return tracker.target(() => reviewed.run(spec, attempt, recover, ctx, bot));
  } };
}

const dimensionOf = bot => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');
const ledgerTarget = (bot, purpose, position, extra) => ({ purpose, position, dimension: dimensionOf(bot), ...extra });
function recordTarget(bot, ctx, result, target, { leaf = true } = {}) {
  const classified = resultFrom(result, ctx, bot);
  const ledger = ledgerFor(bot, ctx);
  if (classified.ok && !classified.wait) ledger.clearOnSuccess(target);
  const saved = ledger.record(classified, target);
  if (!saved) return resultFrom(classified, ctx, bot);
  if (!leaf) return classified;
  const { undo: _undo, ...evidence } = saved;
  return { ...classified, facts: { ...classified.facts, target: evidence } };
}

module.exports = { createFailureLedger, ledgerFor, ledgerTarget, recordTarget, targetsFor };
