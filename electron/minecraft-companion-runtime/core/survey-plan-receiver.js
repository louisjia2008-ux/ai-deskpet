'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const CHANNEL = 'deskpet:plan';
const WIRE_LIMIT = 32 * 1024;
const CHUNK_LIMIT = 512;
const CHUNK_BYTES = 23 * 1024;
const HEARTBEAT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
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

/** Dry run. Receive and attest to a grant without making any Minecraft world changes. */
function installSurveyPlanReceiver(bot, { ledgerDir, onEvent = () => {} }) {
  if (!path.isAbsolute(ledgerDir)) throw new TypeError('An absolute survey plan ledger directory is required');
  const client = bot._client;
  if (!client || typeof client.registerChannel !== 'function') return () => {};
  client.registerChannel(CHANNEL, 'restBuffer');
  let worldId = null;
  let advertised = false;
  let transfer = null;
  const active = new Map();
  const report = (data) => { try { onEvent(data); } catch { /* observer owns delivery */ } };
  const dimension = () => {
    const name = bot.game?.dimension;
    return typeof name === 'string' ? (name.includes(':') ? name : `minecraft:${name}`) : null;
  };

  function endGrant(grantId) {
    clearInterval(active.get(grantId));
    active.delete(grantId);
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
    consumeGrant(ledgerDir, worldId, grantId);
    sendPlanMessage(client, { type: 'accept', ...identity });
    const tick = () => {
      if (plan.worldId !== worldId || plan.dimension !== dimension()) {
        endGrant(grantId);
        report({ type: 'stopped', ...identity, reason: 'world_or_dimension_changed' });
        return;
      }
      try {
        sendPlanMessage(client, { type: 'heartbeat', ...identity });
        sendPlanMessage(client, { type: 'progress', ...identity, completed: 0, total: plan.ops.length });
        report({ type: 'dry_run_progress', ...identity, completed: 0, total: plan.ops.length });
      } catch (error) {
        endGrant(grantId);
        report({ type: 'rejected', ...identity, reason: error.message });
      }
    };
    const timer = setInterval(tick, HEARTBEAT_MS);
    timer.unref?.();
    active.set(grantId, timer);
    report({ type: 'accepted', ...identity, worldId, dimension: plan.dimension });
    tick();
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

  function onMessage(raw) {
    try {
      const message = decodeMessage(raw);
      if (message.type === 'hello' && message.protocol === 1 && UUID.test(message.worldId)) {
        if (!advertised) {
          client.writeChannel('minecraft:register', [CHANNEL]);
          advertised = true;
        }
        if (worldId !== message.worldId) {
          for (const grantId of active.keys()) endGrant(grantId);
          transfer = null;
        }
        worldId = message.worldId;
        sendPlanMessage(client, { type: 'hello_ack', protocol: 1, worldId });
        report({ type: 'hello', worldId, modVersion: message.modVersion });
      } else if (message.type === 'grant_chunk') {
        onChunk(message);
      } else if (message.type === 'revoke') {
        endGrant(message.grantId);
        if (transfer?.grantId === message.grantId) transfer = null;
        report({ type: 'revoked', grantId: message.grantId, reason: message.reason });
      }
    } catch (error) {
      transfer = null;
      report({ type: 'rejected', reason: error.message });
    }
  }

  function dispose() {
    client.removeListener(CHANNEL, onMessage);
    bot.removeListener('end', dispose);
    for (const grantId of active.keys()) endGrant(grantId);
    transfer = null;
    worldId = null;
  }

  client.on(CHANNEL, onMessage);
  bot.once('end', dispose);
  return dispose;
}

module.exports = { installSurveyPlanReceiver, sendPlanMessage };
