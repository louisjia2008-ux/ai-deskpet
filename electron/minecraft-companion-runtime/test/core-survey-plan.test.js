'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { TOOLS, validateTool } = require('../core-tools');
const { createCoreHost } = require('../core-host');
const { installSurveyPlanReceiver, sendPlanMessage } = require('../core/survey-plan-receiver');
const { matchesExpectState, matchesExpect, removalConflict } = require('../core/survey-plan-rules');
const { installSurveyActions } = require('../core/survey-plan-actions');
const surveyActions = require('../core/actions');
const { createBrain, BAND } = require('../core/brain');
const { applyWalkOnlyMovements } = require('../core/nether');
const cases = require('../../../minecraft-mod/src/test/resources/survey-expect-cases.json');

const botUuid = '3a3be214-bb2d-4769-b150-89cfc1e519db';
const worldId = '29e4ac0c-d45f-4c85-b4c8-70f20f8123ed';
const ownerUuid = '415e7130-8cc4-4071-a263-879b528934f2';

function ledger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBot(t, ledgerDir, dimension = 'overworld', receiverOptions = {}) {
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
  const close = ledgerDir ? installSurveyPlanReceiver(bot, { ledgerDir, ...receiverOptions, onEvent: (event) => result.events.push(event) }) : () => {};
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
  const sorted = (value) => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const planHash = createHash('sha256').update(JSON.stringify(sorted(plan))).digest('hex');
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

const executionFields = {
  selection: { minX: 0, maxX: 4, minY: 60, maxY: 70, minZ: 0, maxZ: 4 },
  protected: [], conflicts: [], supplyChest: null,
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const identityOf = ({ plan, ...identity }) => identity;

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
  client.feed({ type: 'hello', protocol: 2, modVersion: '0.1.0', worldId });
  deliver(client, grant);
  assert.deepEqual(client.advertisements, [['minecraft:register', ['deskpet:plan']]]);
  assert.deepEqual(client.messages.map((m) => m.type), ['hello_ack', 'accept', 'heartbeat', 'progress']);
  assert.deepEqual(client.events.map((e) => e.type), ['hello', 'accepted', 'dry_run_progress']);
  assert.equal(client.messages.at(-1).completed, 0);
  client.feed({ type: 'revoke', grantId: grant.grantId, reason: 'owner_cancelled' });
  assert.equal(client.events.at(-1).type, 'revoked');
  assert.deepEqual(client.messages.at(-1), { type: 'revoke_ack', grantId: grant.grantId });
});

test('survey receiver rejects wrong plan hash, world, dimension, identity and old grants after reconnect', (t) => {
  const dir = ledger(t);
  const client = fakeBot(t, dir);
  const accepted = makeGrant();
  client.feed({ type: 'hello', protocol: 2, worldId });
  deliver(client, accepted);
  client.close();

  const reconnected = fakeBot(t, dir);
  reconnected.feed({ type: 'hello', protocol: 2, worldId });
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
  const host = createCoreHost({ dataDir: ledger(t), surveyPlanMode: 'execute' });
  t.after(() => host.close());
  assert.equal(TOOLS.some((tool) => /plan|grant|survey|approv|confirm/i.test(tool.name)), false);
  for (const name of ['survey_plan', 'surveyPlan', 'createSurveyPlan', 'confirmSurveyPlan', 'acceptGrant', 'cancelSurveyPlan']) {
    assert.throws(() => validateTool(name, {}), /Unsupported core tool/);
    const reply = await host.handle({ version: 1, id: name, type: 'tool', name, arguments: {} });
    assert.equal(reply.ok, false);
  }
  assert.throws(() => validateTool('resume', { taskId: 'one', grantId: randomUUID() }), /unsupported/);
  assert.throws(() => validateTool('homestead', { planHash: 'forged', nearOwner: true }), /unsupported/);
  const response = await host.handle({ version: 1, id: 'approval', type: 'grant', plan: makeGrant() });
  assert.equal(response.ok, false);
});

test('execute receiver requires Mod running, correlates placement feedback and joins stop before ACK', async (t) => {
  let permitPrepare, permitStop, capability;
  let dispatches = 0;
  const client = fakeBot(t, ledger(t), 'overworld', {
    mode: 'execute',
    onPrepare(plan, grant) {
      capability = grant;
      assert.ok(Object.isFrozen(plan.ops[0].pos));
      return new Promise((resolve) => { permitPrepare = resolve; });
    },
    onRun() { dispatches++; },
    onStop(grant) {
      assert.equal(grant.signal.aborted, true);
      return new Promise((resolve) => { permitStop = resolve; });
    },
  });
  const grant = makeGrant(executionFields);
  const identity = identityOf(grant);
  const pos = { x: 1, y: 65, z: 2 };
  client.feed({ type: 'hello', protocol: 2, worldId });
  deliver(client, grant);
  client.feed({ type: 'running', ...identity });
  assert.deepEqual(client.messages.map((m) => m.type), ['hello_ack']);
  assert.equal(dispatches, 0);
  permitPrepare();
  await turn();
  assert.deepEqual(client.messages.at(-1), { type: 'accept', execute: true, ...identity });
  client.feed({ type: 'running', ...identity, revision: 2 });
  await turn();
  assert.equal(dispatches, 0);
  client.feed({ type: 'running', ...identity });
  client.feed({ type: 'running', ...identity });
  await turn();
  assert.equal(dispatches, 1);
  assert.equal(client.messages.at(-1).type, 'heartbeat');
  client.feed({ type: 'misplacement', ...identity, pos, misplacements: 1 });
  assert.equal(capability.misplacement(pos).misplacements, 1);
  client.feed({ type: 'applied', ...identity, revision: 2, positions: [pos] });
  assert.equal(capability.applied(pos), null);
  client.feed({ type: 'applied', ...identity, positions: [pos] });
  assert.deepEqual(capability.applied(pos).positions, [pos]);
  assert.equal(capability.settled(), false);
  assert.equal(capability.progress(1), true);
  assert.equal(capability.settled(), true);
  assert.deepEqual(client.messages.at(-1), { type: 'progress', ...identity, completed: 1, settled: true });
  client.feed({ type: 'revoke', grantId: grant.grantId, status: 'completed', reason: '' });
  assert.equal(capability.signal.aborted, true);
  assert.equal(capability.result.status, 'completed');
  assert.equal(capability.progress(1), false);
  await turn();
  assert.equal(client.messages.some((m) => m.type === 'revoke_ack'), false);
  permitStop();
  await turn();
  assert.deepEqual(client.messages.at(-1), { type: 'revoke_ack', grantId: grant.grantId });
});

test('execute host replaces the old task and emits completion only from the Mod revoke', async (t) => {
  const client = fakeBot(t, null);
  const events = [];
  let goalSet;
  const host = createCoreHost({ dataDir: ledger(t), createBot: () => client.bot, surveyPlanMode: 'execute',
    emit: (message) => { if (message.type === 'event') events.push(message.event); },
    createCompanion: ({ onEvent }) => ({
      status: () => ({}), dispose: async () => {},
      async submitTask(name, _, { taskId }) { onEvent({ type: 'goal_set', goal: name, taskId }); },
      async prepareSurveyPlan() {},
      async startSurveyPlan(grant, goal, { taskId }) {
        goalSet = { goal, grant, taskId, onEvent };
        onEvent({ type: 'goal_set', goal: goal.name, taskId });
      },
      async stopSurveyPlan() {},
    }),
  });
  t.after(() => host.close());
  client.bot.waitForChunksToLoad = async () => {};
  client.bot.inventory = { items: () => [] };
  const ask = (message) => host.handle({ version: 1, ...message });
  await ask({ id: 'connect', type: 'connect', config: { host: '127.0.0.1', port: 25565, username: 'DeskPetCore', auth: 'offline' } });
  client.bot.emit('spawn');
  await turn();
  assert.equal(host.status().connection.state, 'ready');
  const previous = await ask({ id: 'follow', type: 'tool', name: 'followOwner', arguments: {} });
  assert.equal(previous.result.task.status, 'running');
  client.feed({ type: 'hello', protocol: 2, worldId });
  const grant = makeGrant(executionFields);
  deliver(client, grant);
  await turn();
  assert.equal(host.status().task, null);
  client.feed({ type: 'running', ...identityOf(grant) });
  await turn();
  assert.equal(host.status().task.status, 'running');
  assert.equal(host.status().task.name, 'survey_plan');
  const replaced = await ask({ id: 'replace', type: 'tool', name: 'followOwner', arguments: {}, replaceCurrent: true });
  assert.equal(replaced.error.code, 'survey_owns_body');
  const cancelled = await ask({ id: 'cancel', type: 'tool', name: 'cancel', arguments: { taskId: goalSet.taskId } });
  assert.equal(cancelled.error.code, 'survey_owns_body');
  assert.equal(events.some((e) => e.taskId === previous.result.task.taskId && e.task?.status === 'cancelled'), true);
  assert.equal(goalSet.goal.isDone(), false);
  goalSet.grant.progress(1);
  goalSet.grant.settled();
  assert.equal(events.some((e) => e.payload?.type === 'goal_done'), false);
  client.feed({ type: 'revoke', grantId: grant.grantId, status: 'completed', reason: '' });
  await turn();
  assert.equal(events.filter((event) => event.payload?.type === 'goal_done').length, 1);
  assert.equal(events.find((event) => event.payload?.type === 'goal_done').payload.modStatus, 'completed');
});

test('Core expected-state rules agree with the Mod fixture', () => {
  for (const { kind, expect, actual, naturalLog, matches } of cases) {
    assert.equal(matchesExpectState(kind, expect, actual, () => naturalLog), matches, `${kind}: ${expect} vs ${actual}`);
  }
  const blocks = new Map([['(0, 0, 0)', { name: 'oak_log', getProperties: () => ({ axis: 'x' }) }],
    ['(1, 1, 0)', { name: 'oak_log' }], ['(2, 2, 0)', { name: 'oak_leaves', getProperties: () => ({ persistent: false }) }]]);
  const bot = { blockAt: (pos) => blocks.get(pos.toString()) ?? { name: 'air' } };
  const changedLog = { pos: { x: 0, y: 0, z: 0 }, kind: 'clear', expect: 'minecraft:oak_log[axis=y]' };
  assert.equal(matchesExpect(bot, changedLog), true);
  blocks.set('(2, 2, 0)', { name: 'oak_leaves', getProperties: () => ({ persistent: true }) });
  assert.equal(matchesExpect(bot, changedLog), false);
});

test('scope blocks digging, raw placement, wrong steps and night before the server sees a packet', async () => {
  const wire = [];
  const reference = new Vec3(0, 63, 0);
  const pos = reference.offset(0, 1, 0);
  const wrong = reference.offset(1, 1, 0);
  const states = new Map([[reference.toString(), 'stone']]);
  const ack = new Map();
  const bot = { time: { timeOfDay: 1000 }, heldItem: { name: 'oak_planks' }, _client: { write: (...args) => wire.push(args) },
    blockAt: (at) => ({ position: at, name: states.get(at.toString()) ?? 'air' }) };
  const stop = new AbortController();
  const op = { pos, expect: 'minecraft:air', target: 'minecraft:oak_planks', kind: 'build', phase: 'roof', order: 0 };
  const later = { ...op, pos: wrong, phase: 'furnish', order: 1 };
  const restore = installSurveyActions(bot, { ops: [op, later] }, { signal: stop.signal, applied: (at) => ack.get(at.toString()) });
  const ctx = {};
  const place = (stepCtx, p = pos, direction = 1) => surveyActions.surveyPlace(bot, stepCtx, { pos: p, reference,
    run: () => bot._client.write('block_place', { location: reference, direction, hand: 0 }) });
  bot._client.write('block_dig', { status: 0, location: pos });
  bot._client.write('block_dig', { status: 2, location: pos });
  bot._client.write('block_place', { location: reference, direction: 1 });
  bot._client.write('use_item', { hand: 0 });
  assert.equal((await surveyActions.digBlock(bot, ctx, bot.blockAt(pos))).reason, 'survey_unauthorized');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [later], place)).reason, 'survey_wrong_operation');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [{ ...op }], place)).reason, 'survey_wrong_operation');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], (step) => place(step, wrong))).reason, 'survey_wrong_operation');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], (step) => place(step, pos, 2))).reason, 'survey_place_unsent');
  bot.heldItem = { name: 'dirt' };
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).reason, 'survey_place_unsent');
  bot.heldItem = { name: 'oak_planks', components: [{ type: 'block_state' }] };
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).reason, 'survey_custom_item_data');
  bot.heldItem = { name: 'oak_planks', components: [{ type: 'damage' }] };
  states.set(pos.toString(), 'obsidian');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).reason, 'survey_site_changed');
  states.delete(pos.toString());
  bot.time.timeOfDay = 13000;
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).reason, 'survey_night');
  assert.equal(wire.length, 0);
  bot.time.timeOfDay = 0;
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).ok, true);
  assert.equal(wire.length, 1);
  ack.set(pos.toString(), {});
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [op], place)).reason, 'survey_wrong_operation');
  stop.abort('revoke');
  assert.equal((await surveyActions.withSurveyStep(bot, ctx, [later], place)).reason, 'survey_unauthorized');
  restore();
  bot._client.write('block_place', { location: reference, direction: 1 });
  assert.equal(wire.length, 2);
});

test('removal guard blocks attached blocks, outside trees, liquids and falling columns before digging', () => {
  const pos = new Vec3(0, 0, 0);
  const up = pos.offset(0, 1, 0);
  const plan = { selection: { minX: 0, maxX: 12, minZ: 0, maxZ: 12 } };
  const states = new Map([[pos.toString(), { name: 'dirt' }]]);
  const bot = { blockAt: (at) => states.get(at.toString()) ?? { name: 'air' } };
  const set = (at, name, props = {}) => states.set(at.toString(), { name, getProperties: () => props });
  const ops = [{ pos }];
  assert.equal(removalConflict(bot, plan, ops), null);

  set(up, 'wheat');
  assert.equal(removalConflict(bot, plan, ops), 'survey_outside_attachment');
  set(up, 'tall_grass', { half: 'upper' });
  assert.equal(removalConflict(bot, plan, [{ pos }, { pos: up }]), null);
  set(up, 'sand');
  assert.equal(removalConflict(bot, plan, ops), 'survey_falling_column');
  set(up, 'air');
  const east = pos.offset(1, 0, 0);
  set(east, 'oak_slab', { waterlogged: true, type: 'bottom' });
  assert.equal(removalConflict(bot, plan, ops), 'survey_adjacent_fluid');
  set(east, 'wall_torch', { facing: 'east' });
  assert.equal(removalConflict(bot, plan, ops), 'survey_outside_attachment');
  set(east, 'air');

  set(pos, 'oak_log', { axis: 'y' });
  set(up, 'oak_log', { axis: 'y' });
  set(pos.offset(-1, 2, 0), 'oak_leaves', { persistent: false });
  assert.equal(removalConflict(bot, plan, ops), 'survey_cross_boundary_tree');
  assert.equal(removalConflict(bot, { ...plan, clipTrees: true }, ops), null);
});

test('survey ownership suppresses permanent world-editing reflexes and restores walk settings', async () => {
  let survey = true;
  const running = [];
  const names = ['night_rest', 'danger_bunker', 'unstick', 'unbury', 'recover_drops', 'provision', 'home_maintenance'];
  const brain = createBrain({ perceive: () => ({ alive: true }), permanentEnabled: () => !survey,
    behaviors: names.map((name) => ({ name, band: BAND.ESCAPE, want: () => 1,
      run: async () => { running.push(name); return { ok: true }; } })),
  });
  await brain.tick();
  assert.deepEqual(running, []);
  survey = false;
  await brain.tick();
  assert.equal(running.length, 1);
  await brain.dispose();
  const walk = { y: 0, toBreak: [], toPlace: [] };
  const dig = { y: 0, toBreak: [1] };
  const place = { y: 0, toPlace: [1] };
  const tower = { y: 2, toPlace: [1] };
  const movements = { canDig: true, allow1by1towers: true, allowParkour: true, scafoldingBlocks: [1],
    getNeighbors: () => [walk, dig, place, tower] };
  const restore = applyWalkOnlyMovements({ pathfinder: { movements } });
  assert.deepEqual(movements.getNeighbors({ y: 0 }), [walk]);
  assert.deepEqual([movements.canDig, movements.allow1by1towers, movements.allowParkour, movements.scafoldingBlocks], [false, false, false, []]);
  restore();
  assert.deepEqual(movements.getNeighbors({ y: 0 }), [walk, dig, place, tower]);
  assert.deepEqual([movements.canDig, movements.allow1by1towers, movements.allowParkour, movements.scafoldingBlocks], [true, true, true, [1]]);
});
