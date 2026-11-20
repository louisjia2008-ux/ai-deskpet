'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TOOLS, validateTool } = require('../core-tools');
const { createCoreHost } = require('../core-host');
const { installSurveyPlanReceiver, sendPlanMessage } = require('../core/survey-plan-receiver');

const botUuid = '3a3be214-bb2d-4769-b150-89cfc1e519db';
const worldId = '29e4ac0c-d45f-4c85-b4c8-70f20f8123ed';
const ownerUuid = '415e7130-8cc4-4071-a263-879b528934f2';

function ledger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBot(t, ledgerDir, dimension = 'overworld') {
  const result = { messages: [], events: [], advertisements: [] };
  const bot = new EventEmitter();
  bot.game = { dimension };
  bot._client = new EventEmitter();
  bot._client.uuid = botUuid.replaceAll('-', '');
  bot._client.registerChannel = (channel, parser) => assert.deepEqual([channel, parser], ['deskpet:plan', 'restBuffer']);
  bot._client.writeChannel = (...args) => result.advertisements.push(args);
  bot._client.write = (type, { channel, data }) => {
    assert.equal(type, 'custom_payload');
    assert.equal(channel, 'deskpet:plan');
    let offset = 0;
    while (data[offset++] & 128) { /* read varint */ }
    result.messages.push(JSON.parse(data.subarray(offset)));
  };
  const close = installSurveyPlanReceiver(bot, { ledgerDir, onEvent: (event) => result.events.push(event) });
  t.after(close);
  result.feed = (object) => sendPlanMessage({ write: (_, { channel, data }) => bot._client.emit(channel, data) }, object);
  result.bot = bot;
  result.close = close;
  return result;
}

function makeGrant(data = {}) {
  // Keep every object's keys sorted to fixture the server's canonical format.
  const plan = {
    botUuid,
    dimension: 'minecraft:overworld',
    expiresAt: 1_900_000_000_000,
    ops: [{
      expect: 'minecraft:air',
      kind: 'build',
      order: 0,
      phase: 'walls',
      pos: { x: 1, y: 65, z: 2 },
      target: 'minecraft:oak_planks',
    }],
    ownerUuid,
    planId: randomUUID(),
    revision: 1,
    worldId,
    ...data,
  };
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return {
    planId: plan.planId,
    revision: plan.revision,
    planHash,
    grantId: randomUUID(),
    plan: {
      ...plan,
      planHash,
      opPalette: ['minecraft:oak_planks', 'minecraft:air'],
      ops: [[1, 65, 2, 1, 0, 'build', 'walls', 0]],
    },
  };
}

function deliver(bot, grant) {
  const bytes = Buffer.from(JSON.stringify(grant));
  const offset = Math.floor(bytes.length / 2);
  for (const [index, data] of [bytes.subarray(0, offset), bytes.subarray(offset)].entries()) {
    bot.feed({ type: 'grant_chunk', grantId: grant.grantId, count: 2, index, data: data.toString('base64') });
  }
}

test('survey receiver accepts a valid fragmented plan and never mutates the world', (t) => {
  const client = fakeBot(t, ledger(t));
  const grant = makeGrant();
  assert.equal(client.bot.dig, undefined);
  assert.equal(client.bot.placeBlock, undefined);
  client.feed({ type: 'hello', protocol: 1, modVersion: '0.1.0', worldId });
  deliver(client, grant);
  assert.deepEqual(client.advertisements, [['minecraft:register', ['deskpet:plan']]]);
  assert.deepEqual(client.messages.map((m) => m.type), ['hello_ack', 'accept', 'heartbeat', 'progress']);
  assert.deepEqual(client.events.map((e) => e.type), ['hello', 'accepted', 'dry_run_progress']);
  assert.equal(client.messages.at(-1).completed, 0);
  client.feed({ type: 'revoke', grantId: grant.grantId, reason: 'owner_cancelled' });
  assert.equal(client.events.at(-1).type, 'revoked');
});

test('survey receiver rejects wrong plan hash, world, dimension, identity and old grants after reconnect', (t) => {
  const dir = ledger(t);
  const client = fakeBot(t, dir);
  const accepted = makeGrant();
  client.feed({ type: 'hello', protocol: 1, worldId });
  deliver(client, accepted);
  client.close();

  const reconnected = fakeBot(t, dir);
  reconnected.feed({ type: 'hello', protocol: 1, worldId });
  assert.deepEqual(reconnected.messages.map((m) => m.type), ['hello_ack']);
  deliver(reconnected, accepted);
  assert.match(reconnected.events.at(-1).reason, /already used/);
  const modified = makeGrant();
  modified.plan.ops[0][0]++;
  deliver(reconnected, modified);
  assert.match(reconnected.events.at(-1).reason, /hash verification failed/);
  for (const data of [
    { worldId: randomUUID() }, { dimension: 'minecraft:the_nether' }, { botUuid: randomUUID() },
  ]) {
    deliver(reconnected, makeGrant(data));
    assert.match(reconnected.events.at(-1).reason, /another world, dimension or bot/);
  }
  assert.deepEqual(reconnected.messages.map((m) => m.type), ['hello_ack']);
});

test('model tools and Core IPC cannot inject or authorize survey construction', async (t) => {
  const host = createCoreHost({ dataDir: ledger(t) });
  t.after(() => host.close());
  assert.equal(TOOLS.some((tool) => /plan|grant|survey|approv|confirm/i.test(tool.name)), false);
  for (const name of ['createSurveyPlan', 'confirmSurveyPlan', 'acceptGrant', 'cancelSurveyPlan']) {
    assert.throws(() => validateTool(name, {}), /Unsupported core tool/);
    const reply = await host.handle({ version: 1, id: name, type: 'tool', name, arguments: {} });
    assert.equal(reply.ok, false);
  }
  assert.throws(() => validateTool('resume', { taskId: 'one', grantId: randomUUID() }), /unsupported/);
  assert.throws(() => validateTool('homestead', { planHash: 'forged', nearOwner: true }), /unsupported/);
  const response = await host.handle({ version: 1, id: 'approval', type: 'grant', plan: makeGrant() });
  assert.equal(response.ok, false);
});
