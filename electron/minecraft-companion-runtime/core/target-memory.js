'use strict';

// A target survives the goal invocation that found it. Method ladders can
// yield a card; they must not wipe out the exclusion of one particular cell.
const MAX = 1024;
const TTL = 30 * 60_000;
const HUNT_TTL = 10 * 60_000;
const IGNORED = new Set(['aborted', 'no_material', 'no_hoe', 'no_seeds', 'no_bucket', 'unloaded', 'mob_gone', 'chest_empty']);
const name = (s) => typeof s === 'string' && /^[a-z0-9_:-]{1,75}$/i.test(s) ? s : null;
const reasonOf = (s) => typeof s === 'string' ? (s.match(/^[a-z0-9_-]{1,64}/i)?.[0] || 'failed').toLowerCase() : 'failed';
const cell = (p) => p && [p.x, p.y, p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 30_000_000)
  ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;

function createTargetMemory({ now = Date.now, load = [], onChange = () => {}, emit = () => {} } = {}) {
  const entries = new Map();
  for (const e of Array.isArray(load) ? load.slice(-MAX) : []) {
    if (typeof e?.key === 'string' && e.key.length < 220 && Number.isFinite(e.until)
      && Number.isInteger(e.failures) && e.failures >= 1 && e.failures <= 3
      && (e.witness === null || (typeof e.witness === 'string' && e.witness.length <= 1600))) {
      entries.set(e.key, { key: e.key, failures: e.failures, sameReasonFailures: Math.min(3, Math.max(1, e.sameReasonFailures | 0)),
        reason: reasonOf(e.reason), until: Math.min(e.until, now() + TTL), witness: e.witness });
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
    if (entry.failures === 3 && witness !== null && entry.witness !== null && entry.witness !== witness) return 'environment_changed';
    return null;
  }

  function scope(valid = () => true, record = emit) {
    return {
      excluded(spec) {
        const found = entries.get(context(spec).key);
        if (!found || found.failures !== 3) return null;
        return retry(found, observe(spec)) ? null : { reason: found.reason, until: found.until };
      },
      async run(spec, attempt, recover = null) {
        if (!valid()) return { ok: false, reason: 'aborted' };
        const fields = context(spec);
        let found = entries.get(fields.key);
        if (found) {
          const reopens = retry(found, observe(spec));
          if (reopens) {
            if (found.failures === 3) record('target_retry', { ...fields, reason: reopens });
            save(fields.key, null);
            found = null;
          } else if (found.failures === 3) {
            return { ok: false, reason: 'target_excluded', targetExcluded: true, retryAt: found.until, sourceHandled: true };
          }
        }
        const extending = found?.failures === 2;
        if (extending) record('target_recovery', { ...fields, reason: found.reason, failures: found.failures });
        const result = extending
          ? await (recover ? recover(found.reason) : Promise.resolve({ ok: false, reason: found.reason }))
          : await attempt();
        if (!valid() || !result || result.waited || IGNORED.has(reasonOf(result.reason))) return result;
        if (result.ok) {
          if (found) {
            save(fields.key, null);
            record('target_reached', { ...fields, afterRecovery: extending });
          }
          return result;
        }
        const failures = (found?.failures || 0) + 1;
        const reason = reasonOf(result.reason);
        const sameReasonFailures = found?.reason === reason ? found.sameReasonFailures + 1 : 1;
        const until = now() + (fields.step === 'chase' ? HUNT_TTL : TTL);
        const state = { key: fields.key, failures, sameReasonFailures, reason, until, witness: observe(spec) };
        save(fields.key, state);
        record('target_failure', { ...fields, reason, failures, sameReasonFailures, recovery: extending });
        if (sameReasonFailures > 3) record('target_invariant', { ...fields, reason, failures, sameReasonFailures });
        if (failures === 3) record('target_excluded', { ...fields, reason, failures, until });
        return { ...result, sourceHandled: true, ...(failures === 3 ? { targetExcluded: true, retryAt: until } : {}) };
      },
    };
  }
  return { scope, snapshot };
}

const fallback = new WeakMap();
function targetsFor(bot, ctx = {}) {
  if (ctx.adapt?.targets) return ctx.adapt.targets;
  const memory = bot.companionTargets || fallback.get(bot) || createTargetMemory();
  if (!bot.companionTargets) fallback.set(bot, memory);
  return memory.scope(() => !ctx.signal?.aborted, ctx.record);
}

module.exports = { createTargetMemory, targetsFor };
