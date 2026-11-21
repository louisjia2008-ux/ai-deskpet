'use strict';

const { posKey } = require('./blacklist');

const PATH_FAILURE = /^(not_arrived|nopath|path_timeout)$/i;

function createSelfStuck(bot, { now = Date.now, emit = () => {} } = {}) {
  let cluster = [], origin = null, detected = null, depth = 0, probe = false, probeAt = 0;
  const point = () => bot.entity?.position;

  function nearby(p) {
    if (!p || typeof p.floored !== 'function') return [];
    const base = p.floored(), cells = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 2; y++) for (let z = -1; z <= 1; z++) {
      const b = bot.blockAt(base.offset(x, y, z));
      if (b && !['air', 'cave_air', 'void_air'].includes(b.name)) cells.push({ x, y, z, block: b.name });
    }
    return cells;
  }

  function force(reason) {
    if (detected || !point()) return;
    const position = point().clone();
    cluster = cluster.filter(r => now() - r.at <= 60_000 && position.distanceTo(r.position) < 2);
    detected = { position, since: cluster[0]?.at ?? now(), at: now(), reason };
    const targets = [...new Set(cluster.map(r => r.key))];
    emit('self_stuck', { position, since: detected.since, reason, targets, blocks: nearby(position) });
    // Roll back newest first, so multiple writes on one target restore the
    // failure record that preceded the stationary cluster, not a newer write.
    for (const r of [...cluster].reverse()) {
      const undone = r.undo?.();
      if (undone) emit('target_failure_revoked', { ...undone, reason: 'self_stuck' });
    }
    cluster = [];
  }

  function failed(key, reason, before, undo) {
    const p = point();
    if (detected) return true;
    if (!PATH_FAILURE.test(reason || '') || !key || !p) return false;
    if (before && p.distanceTo(before) >= 2) { cluster = []; origin = null; return false; }
    const at = now();
    if (!origin || p.distanceTo(origin) >= 2) {
      origin = p.clone();
      cluster = [];
    }
    cluster = cluster.filter(r => at - r.at <= 60_000);
    cluster.push({ at, key, undo, position: p.clone() });
    if (new Set(cluster.map(r => r.key)).size >= 3) force('different_targets_same_origin');
    return Boolean(detected);
  }

  return {
    failed, force, state: () => detected, inTarget: () => depth > 0,
    async target(run) { depth++; try { return await run(); } finally { depth--; } },
    pathFailed(destination, result, before) {
      return !depth && destination && failed(posKey(destination), result?.reason, before);
    },
    moved() {
      if (!detected && origin && point()?.distanceTo(origin) >= 2) { cluster = []; origin = null; }
    },
    release() { cluster = []; origin = null; detected = null; probe = false; },
    requestProbe() { if (now() >= probeAt) { probe = true; probeAt = now() + 60_000; } },
    probe: () => probe,
    takeProbe() { probe = false; },
  };
}

module.exports = { createSelfStuck };
