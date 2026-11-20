'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');

const runtimeDir = path.resolve(__dirname, '../../electron/minecraft-companion-runtime');
const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'));
const { createBot } = runtimeRequire('mineflayer');
const { Vec3 } = runtimeRequire('vec3');
const { withMinecraftProtocolCompatibility } = runtimeRequire('./protocolCompatibility');
const { acknowledgePlayerLoaded } = runtimeRequire('./runtime');
const serverDir = path.resolve(process.env.DESKPET_TEST_SERVER_DIR || path.join(__dirname, '../run-server'));
const CHANNEL = 'deskpet:plan';
const VERSION = '1.21.8';

function record(check, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), check, ...details }));
}

async function until(fn, description, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    const result = await fn();
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function serverSettings() {
  const marker = await fs.readFile(path.join(serverDir, '.deskpet-test-server'), 'utf8');
  assert.ok(['polymer', 'raw'].includes(marker.trim()), 'Harness only accepts its dedicated test server');
  const properties = new Map((await fs.readFile(path.join(serverDir, 'server.properties'), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => /^[a-z][a-z.-]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(properties.get('server-ip'), '127.0.0.1', 'Harness requires loopback binding');
  assert.equal(properties.get('online-mode'), 'false', 'Harness requires isolated offline test accounts');
  assert.equal(properties.get('enable-rcon'), 'true', 'Harness requires RCON');
  const host = '127.0.0.1';
  const port = Number(properties.get('server-port'));
  const rconPort = Number(properties.get('rcon.port'));
  assert.ok([port, rconPort].every((value) => Number.isInteger(value) && value > 0 && value < 65536));
  const password = properties.get('rcon.password');
  assert.ok(password && Buffer.byteLength(password) >= 16, 'A random test RCON password is required');
  const levelName = properties.get('level-name') || 'world';
  assert.match(levelName, /^[A-Za-z0-9_-]+$/, 'Expected a dedicated world basename');
  return { host, port, rconPort, password, worldDir: path.join(serverDir, levelName) };
}

function rconPacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const frame = Buffer.alloc(14 + payload.length);
  frame.writeInt32LE(frame.length - 4, 0);
  frame.writeInt32LE(id, 4);
  frame.writeInt32LE(type, 8);
  payload.copy(frame, 12);
  return frame;
}

async function createRcon(settings) {
  const socket = net.createConnection({ host: settings.host, port: settings.rconPort });
  let buffer = Buffer.alloc(0);
  let pending;
  let nextId = 1;
  let failure;

  const reject = (error) => {
    failure = error;
    if (!pending) return;
    const { fail, timer } = pending;
    pending = undefined;
    clearTimeout(timer);
    fail(error);
  };

  socket.on('error', reject);
  socket.on('close', () => reject(new Error('RCON connection closed')));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readInt32LE(0);
      if (length < 10 || length > 16_384) {
        reject(new Error(`Invalid RCON frame size ${length}`));
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + length) return;
      const id = buffer.readInt32LE(4);
      const type = buffer.readInt32LE(8);
      const body = buffer.toString('utf8', 12, length + 2);
      buffer = buffer.subarray(4 + length);
      if (!pending) continue;
      if (id === -1) {
        reject(new Error('RCON authentication rejected'));
      } else if (id === pending.id && type === pending.replyType) {
        const { resolve, timer } = pending;
        pending = undefined;
        clearTimeout(timer);
        resolve(body);
      }
    }
  });

  function request(type, replyType, body) {
    assert.ifError(failure);
    assert.equal(pending, undefined, 'Only one RCON request may be outstanding');
    return new Promise((resolve, fail) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        reject(new Error('RCON request timed out'));
        socket.destroy();
      }, 30_000);
      pending = { id, replyType, resolve, fail, timer };
      socket.write(rconPacket(id, type, body));
    });
  }

  try {
    await request(3, 2, settings.password);
  } catch (error) {
    socket.destroy();
    throw error;
  }

  return {
    async command(command) {
      assert.ok(/^[^\n\r\0]+$/.test(command), 'Expected one RCON command');
      const response = await request(2, 0, command);
      record('rcon', { command, response });
      return response;
    },
    close() { socket.destroy(); },
  };
}

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  assert.ok(body.length <= 32_000, 'Message is too large for the plan channel');
  const prefix = [];
  let size = body.length;
  do {
    const piece = size & 0x7f;
    size >>>= 7;
    prefix.push(piece | (size > 0 ? 0x80 : 0));
  } while (size > 0);
  return Buffer.concat([Buffer.from(prefix), body]);
}

function decodeMessage(raw) {
  assert.ok(Buffer.isBuffer(raw), 'Expected raw custom payload bytes');
  let size = 0;
  let offset = 0;
  for (; offset < raw.length && offset < 3; offset++) {
    size |= (raw[offset] & 0x7f) << (7 * offset);
    if ((raw[offset] & 0x80) !== 0) continue;
    assert.equal(raw.length, offset + 1 + size, 'Invalid UTF-8 frame length');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(offset + 1)));
  }
  throw new Error('No valid VarInt length prefix');
}

function sendMessage(client, message) {
  client.write('custom_payload', { channel: CHANNEL, data: encodeMessage(message) });
}

function newBot(settings, username, { compatible = true, install } = {}) {
  const errors = [];
  const options = { host: settings.host, port: settings.port, username, version: VERSION,
    auth: 'offline', hideErrors: true };
  const bot = createBot(compatible ? withMinecraftProtocolCompatibility(options) : options);
  const states = [];
  for (const event of ['error', 'kicked', 'end']) {
    bot.on(event, (detail) => {
      const message = detail instanceof Error ? detail.stack : detail;
      errors.push({ event, message });
      record('client-event', { username, event, message });
    });
  }
  bot.on('spawn', () => states.push('spawn'));
  if (install) install(bot);
  return { bot, errors, states, username };
}

async function ready(client) {
  const { bot, errors, states, username } = client;
  await until(() => {
    assert.deepEqual(errors, [], `Failed to connect ${username}`);
    return states.includes('spawn');
  }, `${username} spawn`, 60_000);
  await Promise.race([
    acknowledgePlayerLoaded(bot),
    delay(30_000, null, { ref: false }).then(() => {
      throw new Error(`Chunks never became ready for ${bot.username}`);
    }),
  ]);
}

function closeBot(client) {
  if (!client) return;
  client.bot.quit('harness_end');
  client.bot._client.socket?.destroy();
}

async function stabilize(rcon) {
  await rcon.command('gamerule randomTickSpeed 0');
  await rcon.command('gamerule doMobSpawning false');
  await rcon.command('gamerule doFireTick false');
  await rcon.command('gamerule mobGriefing false');
  await rcon.command('gamerule doDaylightCycle false');
  await rcon.command('time set day');
  await rcon.command('weather clear');
}

module.exports = { runtimeRequire, serverDir, VERSION, CHANNEL, Vec3, record, until, serverSettings,
  createRcon, decodeMessage, sendMessage, newBot, ready, closeBot, stabilize };
