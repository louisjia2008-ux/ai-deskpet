'use strict';

// A target survives the goal invocation that found it. Method ladders can
// yield a card; they must not wipe out the exclusion of one particular cell.
const MAX = 1024;
const TTL = 30 * 60_000;
const HUNT_TTL = 10 * 60_000;
const IGNORED = new Set(['aborted', 'no_material', 'no_hoe', 'no_seeds', 'no_bucket', 'unloaded', 'mob_gone', 'chest_empty']);
const { homeContains } = require('./home-topology');
const name = (s) => typeof s === 'string' && /^[a-z0-9_:-]{1,75}$/i.test(s) ? s : null;
const reasonOf = (s) => typeof s === 'string' ? (s.match(/^[a-z0-9_-]{1,64}/i)?.[0] || 'failed').toLowerCase() : 'failed';
const cell = (p) => p && [p.x, p.y, p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 30_000_000)
  ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;

async function tryHomeTarget(attempt, recover) {
  const result = await attempt();
  return result?.ok === false && !result.sourceHandled && !result.destinationUnconfirmed && recover && !IGNORED.has(reasonOf(result.reason))
    ? recover(result.reason) : result;
}

function createTargetMemory({ now = Date.now, load = [], onChange = () => {}, emit = () => {}, protectedTarget = () => false } = {}) {
  const entries = new Map();
  for (const e of Array.isArray(load) ? load.slice(-MAX) : []) {
    if (typeof e?.key === 'string' && e.key.length < 220 && Number.isFinite(e.until)
      && Number.isInteger(e.failures) && e.failures >= 1 && e.failures <= 3
      && (e.witness === null || (typeof e.witness === 'string' && e.witness.length <= 1600))) {
      entries.set(e.key, { key: e.key, failures: e.failures, sameReasonFailures: Math.min(3, Math.max(1, e.sameReasonFailures | 0)),
        reason: reasonOf(e.reason), until: Math.min(e.until, now() + TTL), witness: e.witness, position: cell(e.position),
        ...(e.handedOff === true ? { handedOff: true } : {}) });
    }
  }
  const snapshot = () => [...entries.values()];
  function save(key, value) {
    entries.delete(key);
    if (value) entries.set(key, value);
    while (entries.size > MAX) {
      const expired = [...entries.values()].find(e => e.until <= now());
      entries.delete(expired?.key ?? entries.keys().next().value);
    }
    onChange();
  }
  function context(spec) {
    const position = cell(spec.position);
    const goal = name(spec.goal), step = name(spec.step), dimension = name(spec.dimension) || 'overworld';
    if (!goal || !step || !position) throw new TypeError('invalid adaptation target');
    const target = name(spec.entity) || `${position.x},${position.y},${position.z}`;
    return { goal, step, dimension, target, position, key: `${dimension}|${goal}|${step}|${target}` };
  }
  function observe(spec) {
    const value = spec.witness?.() ?? null;
    return typeof value === 'string' ? value.slice(0, 1600) : null;
  }
  function retry(entry, witness) {
    if (entry.until <= now()) return 'expired';
    if ((entry.failures === 3 || entry.handedOff) && witness !== null && entry.witness !== null && entry.witness !== witness) {
      return 'environment_changed';
    }
    return null;
  }

  function pruneProtected() {
    let changed = false;
    for (const [key, stored] of entries) {
      const [dimension, , , target] = key.split('|');
      const match = target?.match(/^(-?\d+),(-?\d+),(-?\d+)$/);
      const position = stored.position || (match && { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) });
      if (position && protectedTarget(position, dimension)) changed = entries.delete(key) || changed;
    }
    if (changed) onChange();
    return changed;
  }

  function scope(valid = () => true, record = emit) {
    function read(fields, witness) {
      const found = entries.get(fields.key);
      if (!found) return null;
      const reopens = retry(found, witness);
      if (!reopens) return found;
      if (found.failures === 3 || found.handedOff) record('target_retry', { ...fields, reason: reopens });
      save(fields.key, null);
      return null;
    }

    function remember(fields, reason, witness, found, { extending = false, ladder = null, reviewFailure } = {}) {
      // The third failure may exclude only after a genuine alternate approach.
      const recoveryPending = Boolean(ladder && found?.failures === 2);
      const failures = recoveryPending ? 2 : (found?.failures || 0) + 1;
      const sameReasonFailures = found?.reason === reason ? found.sameReasonFailures + (recoveryPending ? 0 : 1) : 1;
      const failureAt = now();
      const until = failureAt + (fields.step === 'chase' ? HUNT_TTL : TTL);
      const state = { key: fields.key, position: fields.position, failures, sameReasonFailures, reason, until, witness,
        ...(ladder ? { handedOff: true } : {}) };
      const undo = () => {
        if (entries.get(fields.key) !== state) return;
        save(fields.key, found || null);
        return { ...fields, originalReason: reason, excluded: failures === 3, failureAt };
      };
      if (reviewFailure?.(fields, reason, undo)) return null;
      save(fields.key, state);
      record('target_failure', { ...fields, reason, failures, sameReasonFailures, recovery: extending, failureAt,
        ...(ladder ? { ladder, recoveryPending } : {}) });
      if (sameReasonFailures > 3) record('target_invariant', { ...fields, reason, failures, sameReasonFailures });
      if (failures === 3) record('target_excluded', { ...fields, reason, failures, until });
      return { undo, failures, until };
    }

    return {
      excluded(spec) {
        const fields = context(spec);
        if (protectedTarget(fields.position, fields.dimension)) return null;
        const found = entries.get(fields.key);
        if (!found || found.failures !== 3) return null;
        return retry(found, observe(spec)) ? null : { reason: found.reason, until: found.until };
      },
      // A completed ladder has already spent its search budget here. Prefer
      // fresh candidates until the existing target expiry or a changed block.
      avoid(spec) {
        if (!valid()) return false;
        const fields = context(spec);
        if (protectedTarget(fields.position, fields.dimension)) return false;
        const found = entries.get(fields.key);
        return Boolean(found && ((found.handedOff && found.failures < 2) || found.failures === 3) && read(fields, observe(spec)));
      },
      recovering(spec) {
        if (!valid()) return false;
        const fields = context(spec);
        if (protectedTarget(fields.position, fields.dimension)) return false;
        const found = entries.get(fields.key);
        return Boolean(found?.handedOff && found.failures === 2 && read(fields, observe(spec)));
      },
      capture(spec, reason) {
        if (!valid()) return null;
        const fields = context(spec);
        if (!protectedTarget(fields.position, fields.dimension)) return { ...fields, reason: reasonOf(reason), witness: observe(spec) };
        return null;
      },
      handoff(observation, ladder) {
        if (!valid()) return null;
        const { reason, witness, ...fields } = observation;
        if (protectedTarget(fields.position, fields.dimension)) return null;
        const found = read(fields, witness);
        if (found?.failures === 3) return null;
        return remember(fields, reason, witness, found, { ladder })?.undo;
      },
      async run(spec, attempt, recover = null, reviewFailure = null) {
        if (!valid()) return { ok: false, reason: 'aborted' };
        const fields = context(spec);
        if (protectedTarget(fields.position, fields.dimension)) return tryHomeTarget(attempt, recover);
        const found = entries.has(fields.key) ? read(fields, observe(spec)) : null;
        if (found?.failures === 3) return { ok: false, reason: 'target_excluded', targetExcluded: true, retryAt: found.until, sourceHandled: true };
        const extending = found?.failures === 2;
        if (extending) record('target_recovery', { ...fields, reason: found.reason, failures: found.failures });
        const result = extending
          ? await (recover ? recover(found.reason) : Promise.resolve({ ok: false, reason: found.reason }))
          : await attempt();
        if (!valid() || !result || result.waited || result.destinationUnconfirmed || (!result.ok && result.sourceHandled)
          || IGNORED.has(reasonOf(result.reason))) return result;
        if (result.ok) {
          if (found) {
            save(fields.key, null);
            record('target_reached', { ...fields, afterRecovery: extending });
          }
          return result;
        }
        const reason = reasonOf(result.reason);
        const saved = remember(fields, reason, observe(spec), found, { extending, reviewFailure });
        if (!saved) return { ok: false, reason: 'self_stuck', sourceHandled: true, sourceFailure: 'self_stuck' };
        const { failures, until } = saved;
        return { ...result, sourceHandled: true, ...(failures === 3 ? { targetExcluded: true, retryAt: until } : {}) };
      },
    };
  }
  return { scope, snapshot, pruneProtected };
}

const fallback = new WeakMap();
function targetsFor(bot, ctx = {}) {
  let scope = ctx.adapt?.targets;
  if (!scope) {
    const memory = bot.companionTargets || fallback.get(bot) || createTargetMemory({
      protectedTarget: (p, dimension) => dimension === 'overworld'
        && (bot.companionHomeTarget?.(p, dimension) || homeContains(bot.companionHomestead?.()?.memory?.house, p)),
    });
    if (!bot.companionTargets) fallback.set(bot, memory);
    scope = memory.scope(() => !ctx.signal?.aborted, ctx.record);
  }
  const tracker = bot.companionSelfStuck;
  if (!tracker || ctx.selfRescue) return scope;
  return {
    excluded: scope.excluded, avoid: scope.avoid, recovering: scope.recovering,
    run(spec, attempt, recover) {
      const origin = bot.entity?.position?.clone();
      return tracker.target(() => scope.run(spec, attempt, recover,
        (fields, reason, undo) => require('./actions').originFailure(bot, { ok: false, reason }, origin, fields.position).sourceFailure
          || tracker.failed(posTarget(fields), reason, origin, undo)));
    },
  };
}

const posTarget = ({ position, step, target }) => step === 'chase' ? target : `${position.x},${position.y},${position.z}`;

module.exports = { createTargetMemory, targetsFor };
