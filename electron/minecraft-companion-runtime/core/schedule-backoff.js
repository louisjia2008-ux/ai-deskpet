'use strict';

const { FAILURE_LIMIT, FAILURE_WINDOW_MS, isComplete, isRescueBehavior } = require('./action-reasons');

const START_RETRY_MS = 2_000;

function createScheduleBackoff(now = Date.now) {
  const entries = new Map();
  const get = key => entries.get(key) || { count: 0, until: 0, recent: [] };
  const blocked = key => {
    const { until, recent } = get(key);
    return recent.length >= FAILURE_LIMIT ? Math.max(until, recent[0] + FAILURE_WINDOW_MS) : until;
  };
  const defer = (key, until, count = get(key).count) => {
    const entry = { ...get(key), count, until };
    entries.set(key, entry);
    return entry;
  };
  const fail = (key, base, cap, stalls) => {
    const count = stalls == null ? get(key).count + 1 : stalls + 1;
    const delay = Math.min(cap, base * (stalls == null ? 2 ** Math.min(30, count - 1) : count));
    return defer(key, now() + delay, count);
  };
  function observe(name, result, { base, cap, stalls, emit = () => {}, cancelled }) {
    const key = `body:${name}`, at = now(), entry = get(key), rescue = isRescueBehavior(name);
    if (cancelled) return;
    if (result.wait) {
      if (result.wait.until > at) defer(key, result.wait.until);
      return;
    }
    if (isComplete(result)) {
      if (entry.recent.length) defer(key, 0, 0);
      else entries.delete(key);
      return;
    }
    const recent = entry.recent.filter(time => time > at - FAILURE_WINDOW_MS);
    entries.set(key, { ...entry, recent: [...recent, at].slice(-FAILURE_LIMIT) });
    if (recent.length === FAILURE_LIMIT - 1) emit('behavior_failure_backoff', { behavior: name, until: recent[0] + FAILURE_WINDOW_MS });
    if (result.kind === 'interrupted') return;
    if (result.kind !== 'start') fail(key, base, cap, stalls);
    else if (!rescue) defer(key, at + START_RETRY_MS);
  }
  const state = prefix => [...entries].flatMap(([key, entry]) => (
    key.startsWith(prefix) && blocked(key) > now() ? [{ name: key.slice(prefix.length), count: entry.count, until: blocked(key) }] : []));
  return { get, blocked, defer, fail, observe, state, clear: key => entries.delete(key) };
}

module.exports = { createScheduleBackoff };
