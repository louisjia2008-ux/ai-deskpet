'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Vec3 } = require('vec3');
const { createCoreHost } = require('../core-host');
const { createAdaptation } = require('../core/adaptation');
const { sendPlanMessage } = require('../core/survey-plan-receiver');

// One connection on a fresh host (an app restart): the home store the companion is given.
async function connect(dataDir, { port, spawn, managed = false, worldId = null }) {
  let home;
  let adaptationStore;
  const bot = Object.assign(new EventEmitter(), { username: 'DeskPetCore', chat: () => {}, waitForChunksToLoad: async () => {},
    spawnPoint: spawn && new Vec3(...spawn) });
  if (worldId) bot._client = Object.assign(new EventEmitter(), { registerChannel() {}, writeChannel() {}, write() {} });
  const host = createCoreHost({ dataDir, createBot: () => bot, managedWorldAutonomy: managed,
    createCompanion: (options) => {
      home = options.home;
      adaptationStore = options.adaptationStore;
      return { status: () => ({}), dispose: async () => {} };
    } });
  await host.handle({ version: 1, id: 'connect', type: 'connect', config: { host: '127.0.0.1', port, username: 'DeskPetCore', auth: 'offline' } });
  if (worldId) sendPlanMessage({ write: (_, { channel, data }) => bot._client.emit(channel, data) },
    { type: 'hello', protocol: 2, worldId });
  bot.emit('spawn');
  while (host.status().connection.state !== 'ready') await new Promise((resolve) => setImmediate(resolve));
  await host.close();
  return managed ? adaptationStore : home;
}

test('the house is remembered by its world across restarts, whatever LAN port it is opened on', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-home-'));
  const first = await connect(dataDir, { port: 62722, spawn: [64, 80, -59] });
  assert.equal(first.load(), null);
  const house = { anchor: { x: -75, y: 68, z: 532 }, established: true, pinned: false, verified: { bed: true } };
  first.save(house);
  // Reopened to LAN on another port: the same world.
  assert.deepEqual((await connect(dataDir, { port: 50111, spawn: [64, 80, -59] })).load(), house);
  // Another world on the same machine has no house yet.
  assert.equal((await connect(dataDir, { port: 50111, spawn: [10, 70, 10] })).load(), null);
  // A server that never sends its spawn: nothing to tell worlds apart by, nothing kept.
  assert.equal(await connect(dataDir, { port: 25565, spawn: null }), null);
  assert.equal(await connect(dataDir, { port: 25565, spawn: [0, 0, 0] }), null);
  assert.equal(fs.statSync(path.join(dataDir, 'homes.json')).mode & 0o777, 0o600);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const [kind, elapsed] of [['no_sheep', 45], ['mine_danger', 1440]]) {
  test(`${kind} survives a managed Core restart only for that world, then expires`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-adaptation-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { port: 28000, spawn: [64, 80, -59], worldId: randomUUID(), managed: true };
    let at = 10_000;
    const position = { x: 96, y: 65, z: 55 };
    const reopen = async (args) => createAdaptation({ now: () => at, store: await connect(dataDir, args) });
    const first = await reopen(config);
    first.teach(kind, position, 'overworld', 'NoPath', 40);
    assert.equal(fs.statSync(path.join(dataDir, 'adaptation.json')).mode & 0o777, 0o600);
    const restarted = await reopen({ ...config, port: 28002, spawn: [40, 70, 40] });
    assert.equal(restarted.avoids(kind, position), true);
    assert.equal((await reopen({ ...config, worldId: randomUUID() })).avoids(kind, position), false);
    at += elapsed * 60_000 + 1;
    assert.equal((await reopen(config)).avoids(kind, position), false);
  });
}
