'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { positionKey } = require('./survey-plan-rules');

const CHANNEL = 'deskpet:plan';
const PROTOCOL = 2;
const WIRE_LIMIT = 32 * 1024;
const CHUNK_LIMIT = 512;
const CHUNK_BYTES = 23 * 1024;
const HEARTBEAT_MS = 5000;
const REVOKE_STATUS = new Set(['completed', 'failed', 'paused', 'cancelled', 'expired']);
const PLAN_STATUS = new Set(['previewed', 'confirmed', 'running', ...REVOKE_STATUS]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+(?:\[[a-z0-9_,=.-]+\])?$/;
const KINDS = new Set(['clear', 'cut', 'fill', 'build', 'furnish', 'scaffold']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sendPlanMessage(client, object) {
  const body = Buffer.from(JSON.stringify(object));
  if (body.length > WIRE_LIMIT - 3) throw new RangeError('Survey plan message exceeds its wire limit');
  const prefix = [];
  let length = body.length;
  do {
    prefix.push((length & 127) | (length >= 128 ? 128 : 0));
    length >>>= 7;
  } while (length);
  client.write('custom_payload', { channel: CHANNEL, data: Buffer.concat([Buffer.from(prefix), body]) });
}

function decodeMessage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > WIRE_LIMIT) throw new Error('Invalid survey plan message size');
  let length = 0;
  for (let i = 0; i < Math.min(3, raw.length); i++) {
    length |= (raw[i] & 127) << (i * 7);
    if ((raw[i] & 128) === 0) {
      if (length !== raw.length - i - 1) throw new Error('Invalid survey plan message length');
      return JSON.parse(utf8.decode(raw.subarray(i + 1)));
    }
  }
  throw new Error('Invalid survey plan length prefix');
}

function decodePlan(encoded) {
  if (!Array.isArray(encoded.opPalette) || !encoded.opPalette.every((state) => typeof state === 'string')
      || !Array.isArray(encoded.ops)) throw new Error('Invalid survey plan operations');
  const { opPalette, ops, planHash, ...plan } = encoded;
  plan.ops = ops.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 8) throw new Error('Invalid survey plan operation');
    const [x, y, z, expectIndex, targetIndex, kind, phase, order] = entry;
    const expect = opPalette[expectIndex];
    const target = opPalette[targetIndex];
    if (![x, y, z, expectIndex, targetIndex, order].every(Number.isSafeInteger)
        || typeof expect !== 'string' || typeof target !== 'string' || !KINDS.has(kind)
        || (typeof phase !== 'string' && !Number.isSafeInteger(phase))) throw new Error('Invalid survey plan operation');
    return { pos: { x, y, z }, expect, target, kind, phase, order };
  });
  return plan;
}

function normalizedUUID(value) {
  const hex = typeof value === 'string' ? value.toLowerCase().replaceAll('-', '') : '';
  return hex.replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/, '$1-$2-$3-$4-$5');
}

function consumeGrant(ledgerDir, worldId, grantId) {
  const worldDir = path.join(ledgerDir, worldId);
  fs.mkdirSync(worldDir, { recursive: true, mode: 0o700 });
  // An exclusive file prevents two concurrent receivers from accepting the same grant.
  try {
    fs.closeSync(fs.openSync(path.join(worldDir, grantId), 'wx', 0o600));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Survey plan grant was already used');
    throw error;
  }
}

const position = (pos) => pos && [pos.x, pos.y, pos.z].every(Number.isSafeInteger);

function decodeStatus(plan) {
  if (plan === null) return null;
  const boundedText = (value, max) => typeof value === 'string' && value.length <= max;
  const {
    planId, revision, template, status, reason, phase, waiting, blocked, completed, total,
    violations, misplacements, siteChanges, lateAttempts, started, finishedAt,
  } = plan;
  if (!UUID.test(planId) || !Number.isSafeInteger(revision) || revision < 1
      || !boundedText(template, 64) || !PLAN_STATUS.has(status) || typeof started !== 'boolean'
      || ![completed, total, violations, misplacements, siteChanges, lateAttempts]
        .every((count) => Number.isSafeInteger(count) && count >= 0)
      || completed > total || finishedAt !== undefined && (!Number.isSafeInteger(finishedAt) || finishedAt < 0)
      || reason !== undefined && !boundedText(reason, 1024)
      || phase !== undefined && !boundedText(phase, 48)
      || waiting !== undefined && !boundedText(waiting, 48)) throw new Error('Invalid survey plan status');

  const snapshot = {
    planId, revision, template, status, reason, phase, waiting, completed, total,
    violations, misplacements, siteChanges, lateAttempts, started, finishedAt,
  };
  if (blocked !== undefined) {
    const { reason: blockedReason, pos, detail, dimension } = blocked;
    if (!boundedText(blockedReason, 96) || pos !== undefined && !position(pos)
        || detail !== undefined && !boundedText(detail, 300)
        || dimension !== undefined && !boundedText(dimension, 96)) throw new Error('Invalid survey blockage');
    snapshot.blocked = { reason: blockedReason, pos: pos && { x: pos.x, y: pos.y, z: pos.z }, detail, dimension };
  }
  return snapshot;
}

function validateExecutionDocument(plan) {
  const bounds = plan.selection;
  if (!bounds || !['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].every((key) => Number.isSafeInteger(bounds[key]))
      || !UUID.test(plan.ownerUuid) || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now()
      || !Array.isArray(plan.protected) || !plan.protected.every(position)
      || !Array.isArray(plan.conflicts) || plan.conflicts.length || (plan.supplyChest !== null && !position(plan.supplyChest))) {
    throw new Error('Invalid survey execution document');
  }
  const protectedPositions = new Set(plan.protected.map(positionKey));
  const orders = new Set();
  for (const op of plan.ops) {
    const { x, y, z } = op.pos;
    if (!STATE.test(op.expect) || !STATE.test(op.target) || (typeof op.phase !== 'string' || !/^[a-z0-9_]{1,48}$/.test(op.phase))
      || op.order < 0 || orders.has(op.order) || protectedPositions.has(positionKey(op.pos))
      || x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY || z < bounds.minZ || z > bounds.maxZ) {
      throw new Error('Operation is outside the executable survey document');
    }
    orders.add(op.order);
  }
}

function freezeDocument(node) {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) freezeDocument(value);
    Object.freeze(node);
  }
  return node;
}

/** Never dispatch executable work before the current Mod confirms RUNNING. */
function installSurveyPlanReceiver(bot, { ledgerDir, mode = 'dry_run', observe = false, onEvent = () => {}, onPrepare, onRun, onStop }) {
  if (!path.isAbsolute(ledgerDir)) throw new TypeError('An absolute survey plan ledger directory is required');
  if (!['off', 'dry_run', 'execute'].includes(mode) || mode === 'execute' && ![onPrepare, onRun, onStop].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Invalid survey plan receiver mode or executor');
  }
  const client = bot._client;
  if (!client || typeof client.registerChannel !== 'function') return () => {};
  client.registerChannel(CHANNEL, 'restBuffer');
  let worldId = null;
  let observing = false;
  let advertised = false;
  let transfer = null;
  let deferred = null;
  let disposed = false;
  const active = new Map();
  const report = (data) => { try { onEvent(data); } catch { /* observer owns delivery */ } };
  const dimension = () => {
    const name = bot.game?.dimension;
    return typeof name === 'string' ? (name.includes(':') ? name : `minecraft:${name}`) : null;
  };

  function sameContext(plan) { return plan.worldId === worldId && plan.dimension === dimension(); }
  function sameIdentity(message, identity) {
    return Object.keys(identity).every((key) => message[key] === identity[key]);
  }

  function startDeferred() {
    const queued = deferred;
    deferred = null;
    if (!queued || disposed) return;
    if (!sameContext(queued.plan) || queued.plan.expiresAt <= Date.now()) {
      report({ type: 'rejected', ...queued.identity, reason: 'Deferred survey authorization lost its connection context or expired' });
      return;
    }
    startGrant(queued.plan, queued.identity);
  }

  function endGrant(grantId, result, ack = false) {
    const record = active.get(grantId);
    const reply = (shouldAck) => {
      if (shouldAck && !disposed) sendPlanMessage(client, { type: 'revoke_ack', grantId });
    };
    if (!record) { reply(ack); return; }
    record.ack ||= ack;
    if (record.stopping) return;
    clearInterval(record.timer);
    clearTimeout(record.startDeadline);
    clearTimeout(record.deathFallback);
    record.result = Object.freeze(result);
    if (mode === 'dry_run') {
      active.delete(grantId);
      reply(record.ack);
      return;
    }
    record.stopping = true;
    record.controller.abort(result.reason || result.status);
    void Promise.resolve().then(() => onStop(record.capability, result)).then(() => {
      active.delete(grantId);
      reply(record.ack);
      startDeferred();
    }).catch((error) => report({ type: 'stop_failed', ...record.identity, reason: String(error?.message || error) }));
  }

  function heartbeat(record) {
    if (!sameContext(record.plan)) {
      endGrant(record.identity.grantId, { status: 'paused', reason: 'world_or_dimension_changed' });
      report({ type: 'stopped', ...record.identity, reason: 'world_or_dimension_changed' });
      return;
    }
    if (record.blocked) return;
    try {
      sendPlanMessage(client, { type: 'heartbeat', ...record.identity });
      if (mode === 'dry_run') {
        sendPlanMessage(client, { type: 'progress', ...record.identity, completed: 0, total: record.plan.ops.length });
        report({ type: 'dry_run_progress', ...record.identity, completed: 0, total: record.plan.ops.length });
      }
    } catch (error) {
      endGrant(record.identity.grantId, { status: 'paused', reason: 'heartbeat_failed' });
      report({ type: 'rejected', ...record.identity, reason: error.message });
    }
  }

  function newExecution(plan, identity) {
    const record = { plan: freezeDocument(plan), identity, controller: new AbortController(), result: null,
      accepted: false, running: false, stopping: false, blocked: false, settled: false, completed: 0,
      misplacements: new Map(), applied: new Map(), authorized: new Set(plan.ops.map((op) => positionKey(op.pos))) };
    const sendIfRunning = (type, body) => {
      if (!record.running || record.stopping || record.blocked || !sameContext(plan)) return false;
      sendPlanMessage(client, { type, ...identity, ...body });
      return true;
    };
    record.capability = Object.freeze({
      signal: record.controller.signal,
      get result() { return record.result; },
      applied: (pos) => record.applied.get(positionKey(pos)) ?? null,
      misplacement: (pos) => record.misplacements.get(positionKey(pos)) ?? null,
      progress(completed) {
        if (!Number.isSafeInteger(completed) || completed < record.completed || completed > plan.ops.length || record.settled) return false;
        if (!sendIfRunning('progress', { completed })) return false;
        record.completed = completed;
        return true;
      },
      settled() {
        if (record.settled || record.completed !== plan.ops.length) return false;
        record.settled = sendIfRunning('progress', { completed: record.completed, settled: true });
        return record.settled;
      },
      state(phase, waiting = null, missing) { return sendIfRunning('state', { phase, waiting, missing }); },
      blocked(reason, pos, detail) {
        record.blocked = sendIfRunning('blocked', { reason, pos, detail }) || record.blocked;
        return record.blocked;
      },
    });
    return record;
  }

  function accept(encoded, expectedGrantId) {
    const { grantId, planId, revision, planHash } = encoded;
    const identity = { grantId, planId, revision, planHash };
    if (grantId !== expectedGrantId || !UUID.test(planId) || !HASH.test(planHash)
        || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid survey plan grant identity');
    const plan = decodePlan(encoded.plan);
    if (plan.planId !== planId || plan.revision !== revision || encoded.plan.planHash !== planHash
        || createHash('sha256').update(canonical(plan), 'utf8').digest('hex') !== planHash) {
      throw new Error('Survey plan hash verification failed');
    }
    if (!worldId || plan.worldId !== worldId || plan.dimension !== dimension()
        || normalizedUUID(client.uuid || bot.player?.uuid) !== plan.botUuid) {
      throw new Error('Survey plan is for another world, dimension or bot');
    }
    if (mode === 'execute') {
      validateExecutionDocument(plan);
      if (active.size) {
        const [previous] = active.values();
        if (!previous.stopping || deferred || identity.planId !== previous.identity.planId
          || identity.revision <= previous.identity.revision) {
          throw new Error('Another survey authorization still owns this connection');
        }
        consumeGrant(ledgerDir, worldId, grantId);
        deferred = { plan, identity };
        return;
      }
    }
    consumeGrant(ledgerDir, worldId, grantId);
    startGrant(plan, identity);
  }

  function startGrant(plan, identity) {
    const { grantId } = identity;
    const accepted = () => report({ type: 'accepted', ...identity, worldId, dimension: plan.dimension });
    if (mode === 'dry_run') {
      sendPlanMessage(client, { type: 'accept', ...identity });
      const record = { plan, identity };
      active.set(grantId, record);
      record.timer = setInterval(() => heartbeat(record), HEARTBEAT_MS);
      record.timer.unref?.();
      accepted();
      heartbeat(record);
      return;
    }
    const record = newExecution(plan, identity);
    active.set(grantId, record);
    const preparationFailed = (error) => {
      if (record.stopping) return;
      report({ type: 'rejected', ...identity, reason: String(error?.message || error) });
      endGrant(grantId, { status: 'paused', reason: 'survey_preparation_failed' });
    };
    record.startDeadline = setTimeout(() => preparationFailed(new Error('Survey authorization did not reach RUNNING')), 10000);
    record.startDeadline.unref?.();
    try {
      void Promise.resolve(onPrepare(record.plan, record.capability)).then(() => {
        if (record.stopping) return;
        if (!sameContext(plan)) throw new Error('Survey world or dimension changed before acceptance');
        record.accepted = true;
        sendPlanMessage(client, { type: 'accept', ...identity, execute: true });
        accepted();
      }).catch(preparationFailed);
    } catch (error) { preparationFailed(error); }
  }

  function onChunk(message) {
    const { grantId, index, count, data } = message;
    if (!worldId || !UUID.test(grantId) || !Number.isInteger(index) || !Number.isInteger(count)
        || index < 0 || index >= count || count > CHUNK_LIMIT || typeof data !== 'string'
        || data.length > Math.ceil(CHUNK_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error('Invalid survey plan grant fragment');
    }
    if (index === 0) transfer = { grantId, count, parts: [] };
    if (!transfer || transfer.grantId !== grantId || transfer.count !== count || transfer.parts.length !== index) {
      throw new Error('Out-of-order survey plan grant fragments');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > CHUNK_BYTES) throw new Error('Survey plan fragment exceeds size limit');
    transfer.parts.push(bytes);
    if (transfer.parts.length === count) {
      const encoded = JSON.parse(utf8.decode(Buffer.concat(transfer.parts)));
      transfer = null;
      accept(encoded, grantId);
    }
  }

  const playerBlocks = new Map();
  let protectedDimension = null;
  let protectionOverflow = false;
  bot.companionPlayerBlock = (p) => {
    if (!p || protectedDimension !== dimension()) return false;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    return protectionOverflow || playerBlocks.get(`${x >> 4},${z >> 4}`)?.has(
      Math.floor(p.y) * 256 + (z & 15) * 16 + (x & 15)) === true;
  };
  const distance = Number(process.env.DESKPET_PLAYER_BUILD_DISTANCE ?? 16);
  const clearance = Number.isFinite(distance) && distance >= 0 && distance <= 32 ? distance : 16;
  bot.companionNearPlayerBuild = (p) => {
    if (!p || protectedDimension !== dimension()) return false;
    if (protectionOverflow) return true;
    for (let x = Math.floor((p.x - clearance) / 16); x <= Math.floor((p.x + clearance) / 16); x += 1) {
      for (let z = Math.floor((p.z - clearance) / 16); z <= Math.floor((p.z + clearance) / 16); z += 1) {
        for (const cell of playerBlocks.get(`${x},${z}`) || []) {
          if (Math.hypot(x * 16 + (cell & 15) - p.x, z * 16 + ((cell >> 4) & 15) - p.z) <= clearance) return true;
        }
      }
    }
    return false;
  };

  function onMessage(raw) {
    try {
      const message = decodeMessage(raw);
      if (message.type === 'hello' && message.protocol === PROTOCOL && UUID.test(message.worldId)) {
        if (!advertised) {
          client.writeChannel('minecraft:register', [CHANNEL]);
          advertised = true;
        }
        if (worldId !== message.worldId) {
          playerBlocks.clear();
          protectedDimension = null;
          observing = false;
          deferred = null;
          for (const grantId of active.keys()) endGrant(grantId, { status: 'paused', reason: 'world_changed' });
          transfer = null;
        }
        worldId = message.worldId;
        sendPlanMessage(client, { type: 'hello_ack', protocol: PROTOCOL, worldId, ...(mode === 'off' ? { observeOnly: true } : {}) });
        report({ type: 'hello', worldId, modVersion: message.modVersion });
      } else if (message.type === 'player_blocks_reset' && worldId && typeof message.dimension === 'string') {
        playerBlocks.clear();
        protectedDimension = message.dimension;
        protectionOverflow = message.overflow === true;
      } else if (message.type === 'player_blocks_chunk' && worldId && message.dimension === protectedDimension
          && Number.isSafeInteger(message.x) && Number.isSafeInteger(message.z) && Array.isArray(message.cells)
          && message.cells.length <= 2048 && message.cells.every(Number.isSafeInteger) && playerBlocks.size < 49) {
        playerBlocks.set(`${message.x},${message.z}`, new Set(message.cells));
      } else if (message.type === 'hello_ok' && observe && !observing && worldId
          && message.protocol === PROTOCOL && message.worldId === worldId) {
        sendPlanMessage(client, { type: 'status_query' });
        observing = true;
      } else if (message.type === 'plan_status' && observing && worldId === message.worldId) {
        if (typeof message.initial !== 'boolean' || message.current !== undefined
            && (message.current !== false || message.initial || message.plan === null)) throw new Error('Invalid survey status message');
        report({ type: 'status', worldId, initial: message.initial, current: message.current, plan: decodeStatus(message.plan) });
      } else if (message.type === 'grant_chunk' && mode !== 'off') {
        onChunk(message);
      } else if (message.type === 'revoke' && mode !== 'off' && worldId && UUID.test(message.grantId)) {
        if (transfer?.grantId === message.grantId) transfer = null;
        if (deferred?.identity.grantId === message.grantId) deferred = null;
        let status = REVOKE_STATUS.has(message.status) ? message.status : 'paused';
        if (mode === 'execute' && status === 'completed' && !active.get(message.grantId)?.settled) status = 'paused';
        const reason = typeof message.reason === 'string' ? message.reason : 'revoked';
        report({ type: 'revoked', grantId: message.grantId, status, reason });
        endGrant(message.grantId, { status, reason }, true);
      } else if (mode === 'execute') {
        const record = active.get(message.grantId);
        if (!record || record.stopping || !record.accepted || !sameIdentity(message, record.identity) || !sameContext(record.plan)) return;
        if (message.type === 'running' && !record.running) {
          clearTimeout(record.startDeadline);
          record.running = true;
          record.timer = setInterval(() => heartbeat(record), HEARTBEAT_MS);
          record.timer.unref?.();
          heartbeat(record);
          void Promise.resolve().then(() => {
            if (!record.stopping) return onRun(record.plan, record.capability, record.identity);
          }).catch((error) => {
            report({ type: 'execution_error', ...record.identity, reason: String(error?.message || error) });
            try { record.capability.blocked('survey_execution_error', undefined, String(error?.message || error).slice(0, 240)); } catch { /* heartbeat fails closed */ }
          });
        } else if (record.running && message.type === 'misplacement' && position(message.pos)
            && record.authorized.has(positionKey(message.pos))) {
          record.misplacements.set(positionKey(message.pos), freezeDocument(message));
        } else if (record.running && message.type === 'applied' && Array.isArray(message.positions) && message.positions.every(position)) {
          freezeDocument(message);
          for (const pos of message.positions) {
            const key = positionKey(pos);
            if (record.authorized.has(key)) record.applied.set(key, message);
          }
        }
      }
    } catch (error) {
      transfer = null;
      report({ type: 'rejected', reason: error.message });
    }
  }

  function dispose() {
    disposed = true;
    client.removeListener(CHANNEL, onMessage);
    bot.removeListener('end', dispose);
    bot.removeListener('game', onGame);
    bot.removeListener('death', onDeath);
    for (const grantId of active.keys()) endGrant(grantId, { status: 'paused', reason: 'disconnected' });
    transfer = null;
    deferred = null;
    worldId = null;
  }

  function onGame() {
    if (deferred && !sameContext(deferred.plan)) deferred = null;
    for (const [grantId, record] of active) {
      if (!sameContext(record.plan)) endGrant(grantId, { status: 'paused', reason: 'world_or_dimension_changed' });
    }
  }

  function onDeath() {
    for (const record of active.values()) {
      if (!record.capability || record.stopping || record.controller.signal.aborted) continue;
      record.controller.abort('bot_died');
      // The current Mod records server-side death coordinates and revokes first.
      // Older servers still receive the Core's existing blocked notification.
      record.deathFallback = setTimeout(() => {
        try { if (!record.stopping) record.capability.blocked('bot_died'); } catch { /* connection may be ending */ }
      }, 1000);
      record.deathFallback.unref?.();
    }
  }

  client.on(CHANNEL, onMessage);
  bot.once('end', dispose);
  bot.on('game', onGame);
  bot.on('death', onDeath);
  return dispose;
}

module.exports = { installSurveyPlanReceiver, sendPlanMessage };
