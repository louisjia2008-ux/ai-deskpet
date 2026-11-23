'use strict';
// Compatibility for Nether and End goals until R6. Their packed targets
// resolve to a concrete position before the shared ledger accepts a failure.
function createBlacklist({ bot, namespace, ttlMs, durations = [] }) {
  const { ledgerFor, ledgerTarget } = require('./failure-ledger');
  const { failure } = require('./action-result');
  const statuses = new Map();
  const spec = (key, ttl) => {
    const coords = String(key).match(/(-?\d+),(-?\d+),(-?\d+)$/);
    const id = String(key).match(/(?:^|:)(\d+)$/)?.[1];
    const sector = /^city:(-?\d+),(-?\d+)$/.exec(key);
    const p = coords ? { x: Number(coords[1]), y: Number(coords[2]), z: Number(coords[3]) }
      : sector ? { x: 48 * Number(sector[1]), y: bot.entity?.position.y || 64, z: 48 * Number(sector[2]) }
        : bot.entities?.[id]?.position;
    return ledgerTarget(bot, 'legacy_' + ttl, p, { entity: namespace + ':' + key });
  };
  return {
    add(key, reason, ttl = ttlMs) {
      if (['tried', 'ignored_gold', 'stared'].includes(reason)) { statuses.set(key, Date.now() + ttl); return; }
      ledgerFor(bot).record(failure(reason, {}, undefined, bot), spec(key, ttl));
    },
    has(key) {
      if (statuses.get(key) > Date.now()) return true;
      statuses.delete(key);
      return [ttlMs, ...durations].some(ttl => ledgerFor(bot).skip(spec(key, ttl)));
    },
    clear() {
      statuses.clear();
      ledgerFor(bot).clearWhere(e => e.purpose.startsWith('legacy_') && e.target.startsWith(namespace + ':'));
    },
  };
}

const posKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

module.exports = { createBlacklist, posKey };
