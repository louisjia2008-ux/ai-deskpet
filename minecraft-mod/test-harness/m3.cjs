'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeRequire, serverDir, VERSION, CHANNEL, Vec3, record, until, serverSettings, createRcon,
  decodeMessage, newBot, ready, closeBot } = require('./common.cjs');
const { BUTTON, P, Y, coords, move, equip, setupArena, snapshot, blockClick, openMenu, click,
  readPlans, commandAssert, describeSlot } = require('./wand-session.cjs');
const { inventories, verifyBlocks, verifyMaterials } = require('./m3-verification.cjs');

const TEMPLATES = ['starter_house', 'porch_cabin', 'two_storey_house', 'wheat_field'];
const TEMPLATE = { starter: 'starter_house', wheat: 'wheat_field', porch: 'porch_cabin', two: 'two_storey_house' };
const DIRECTIONS = ['north', 'east', 'south', 'west'];
const SCENARIOS = ['foundation', 'selection', 'materials', 'night', 'blocked', 'cancel', 'disconnect', 'disconnect_stock',
  'natural', 'chest_full', 'stone_fill'];
const MAX_RUN_MS = 15 * 60_000;
const MISSING_ID = 'minecraft:oak_door';
const STONE_HOE = 'minecraft:stone_hoe';
const STOCK = [
  ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64],
  ['oak_planks', 64], ['oak_planks', 64], ['oak_planks', 64], ['oak_planks', 64],
  ['oak_planks', 64], ['dirt', 64], ['oak_door', 1], ['red_bed', 1], ['torch', 16],
  ['chest', 1], ['crafting_table', 1], ['furnace', 1], ['glass', 16], ['oak_log', 32],
  ['oak_slab', 64], ['oak_stairs', 8], ['wheat_seeds', 64], ['wheat_seeds', 32],
  ['water_bucket', 1], ['stone_hoe', 1], ['dirt', 64], ['dirt', 64], ['oak_slab', 64],
];
const FIXTURE_ROBOT = new Vec3(-3.5, Y, 14.5);
const PATH_FAILURE = /stand|station|unreach|route|path|stuck|position|navigate|chest_access/i;

async function readSnapshot(rcon, settings, prefix, stage, bounds) {
  const name = `${prefix}_${stage}`;
  const hash = await snapshot(rcon, name, bounds.lower, bounds.upper);
  const file = path.join(settings.worldDir, 'deskpet-snapshots', `${name}.json`);
  return { hash, blocks: JSON.parse(await fs.readFile(file, 'utf8')).blocks };
}

function snapshotBounds({ minX, maxX, minY, maxY, minZ, maxZ }) {
  return { lower: new Vec3(minX - 8, minY, minZ - 8), upper: new Vec3(maxX + 8, maxY + 8, maxZ + 8) };
}

async function stockChest(rcon, chest, scenario, existing = false) {
  if (!existing) commandAssert(await rcon.command(`setblock ${coords(chest)} chest`), 'Set supply chest');
  assert.match(await rcon.command(`data merge block ${coords(chest)} {Items:[]}`), /Modified block data|Nothing changed/);
  for (const [slot, [item, count]] of STOCK.entries()) {
    if (scenario === 'materials' && `minecraft:${item}` === MISSING_ID) continue;
    commandAssert(await rcon.command(`item replace block ${coords(chest)} container.${slot} with ${item} ${count}`),
      `Stock ${count} ${item}`);
  }
}

async function equipRobot(rcon, scenario) {
  await rcon.command('gamemode survival DeskPetBot');
  await rcon.command('clear DeskPetBot');
  const pickaxe = scenario === 'cancel' ? 'wooden_pickaxe' : 'stone_pickaxe';
  commandAssert(await rcon.command(`item replace entity DeskPetBot hotbar.0 with ${pickaxe}`), 'Equip digging tool');
  commandAssert(await rcon.command('item replace entity DeskPetBot hotbar.1 with stone_shovel'), 'Equip shovel');
}

async function gradedArena(rcon, owner, robot, template, scenario) {
  await setupArena(rcon, [owner]);
  // Reuse does not carry dropped construction stock into the next isolated trial.
  await rcon.command(`kill @e[type=item,x=-8,y=${Y - 8},z=-8,dx=33,dy=24,dz=33]`);
  await equipRobot(rcon, scenario);
  await move(rcon, robot, FIXTURE_ROBOT);
  const grade = [];
  if (template === TEMPLATE.starter) {
    const mound = new Vec3(6, Y, 8);
    const pillar = mound.offset(0, 1, 0);
    for (const pos of [mound, pillar]) {
      const cuttingBlock = scenario === 'cancel' || (scenario === 'stone_fill' && pos.equals(pillar)) ? 'stone' : 'dirt';
      commandAssert(await rcon.command(`setblock ${coords(pos)} ${cuttingBlock}`), 'Build fixture mound');
      grade.push([`${pos.x},${pos.y},${pos.z}`, 'minecraft:air']);
    }
    const pit = [new Vec3(7, Y - 1, 8), new Vec3(8, Y - 1, 8), new Vec3(8, Y - 2, 8)];
    for (const pos of pit) {
      commandAssert(await rcon.command(`setblock ${coords(pos)} air`), 'Build fixture pit');
      const material = scenario === 'stone_fill' && pos.y === Y - 2 ? 'cobblestone' : 'dirt';
      grade.push([`${pos.x},${pos.y},${pos.z}`, `minecraft:${material}`]);
    }
    const perimeterMound = new Vec3(1, Y, 8);
    const protectedCell = new Vec3(1, Y - 1, 9);
    commandAssert(await rcon.command(`setblock ${coords(perimeterMound)} dirt`), 'Build outer grading probe');
    commandAssert(await rcon.command(`setblock ${coords(protectedCell)} obsidian`), 'Place protected block in the selection');
    grade.push([`${perimeterMound.x},${perimeterMound.y},${perimeterMound.z}`,
      scenario === 'selection' ? 'minecraft:air' : 'minecraft:dirt']);
    grade.push([`${protectedCell.x},${protectedCell.y},${protectedCell.z}`, 'minecraft:obsidian']);
  }
  await stockChest(rcon, P.chest, scenario, true);
  return { first: P.first, second: P.second, chest: P.chest, grade };
}

function naturalSurface(bot, x, z) {
  const plants = /^(short_grass|tall_grass|fern|large_fern|dandelion|poppy|azure_bluet|cornflower|oxeye_daisy|allium|.+_tulip)$/;
  for (let y = 86; y >= 60; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (/^(grass_block|dirt)$/.test(block.name)) return block.position;
    if (block.name !== 'air' && !plants.test(block.name)) return null;
  }
  return null;
}

async function naturalArena(rcon, owner, robot) {
  assert.match(await rcon.command('seed'), /\[11\]/);
  await rcon.command('gamemode creative Owner');
  await move(rcon, owner, new Vec3(-447.5, 84, 544.5));
  const site = await until(() => {
    const surface = (x, z) => naturalSurface(owner, x, z);
    const first = surface(-457, 553);
    const second = surface(-445, 565);
    const staging = surface(-458, 560);
    const chestFloor = surface(-460, 557);
    if (first && second && staging && chestFloor) return { first, second, staging, chest: chestFloor.offset(0, 1, 0) };
    return false;
  }, 'generated seed-11 terrain', 30_000, 250);
  assert.match(await rcon.command(`execute positioned ${coords(site.first.offset(0, 1, 0))} if biome ~ ~ ~ minecraft:plains`),
    /Test passed/);
  for (const [rule, value] of [['randomTickSpeed', 3], ['doMobSpawning', true], ['doFireTick', true],
    ['mobGriefing', true], ['doDaylightCycle', true]]) {
    await rcon.command(`gamerule ${rule} ${value}`);
    assert.ok((await rcon.command(`gamerule ${rule}`)).endsWith(String(value)));
  }
  await rcon.command('difficulty normal');
  await rcon.command('time set day');
  await equipRobot(rcon, 'natural');
  await move(rcon, robot, site.staging.offset(0.5, 1, 0.5));
  await stockChest(rcon, site.chest, 'natural');
  return site;
}

async function preview(rcon, owner, site, template, turns, scenario) {
  await equip(rcon, owner);
  await blockClick(rcon, owner, site.first, { ground: true });
  await blockClick(rcon, owner, site.second, { ground: true });
  await blockClick(rcon, owner, site.chest, { sneaking: true, ground: false });
  await openMenu(owner);
  for (let index = 0; index < TEMPLATES.indexOf(template); index++) await click(owner, BUTTON.template);
  for (let index = 0; index < turns; index++) await click(owner, BUTTON.rotation);
  if (scenario === 'selection') await click(owner, BUTTON.mode);
  const mode = scenario === 'selection' ? 'selection' : 'foundation';
  const result = (await readPlans(rcon)).plans.findLast((entry) => entry.status === 'previewed'
    && entry.plan.template.id === template && entry.plan.template.rotation === turns * 90
    && entry.plan.selection.minX === site.first.x && entry.plan.selection.maxZ === site.second.z
    && entry.plan.mode === mode);
  assert.ok(result, 'The real Owner GUI did not produce the selected template/rotation');
  record('m3-preview', { id: result.id, mode, template: result.plan.template, conflicts: result.plan.conflicts,
    groundY: result.plan.groundY, operations: result.plan.ops.length, materials: result.plan.materials });
  assert.deepEqual(result.plan.conflicts, [], 'The grade and structure preview must be unobstructed');
  assert.equal(owner.currentWindow?.slots[BUTTON.confirm]?.name, 'emerald_block');
  if (scenario !== 'natural') assert.equal(result.plan.groundY, Y, 'Grade from modal arena ground');
  return result;
}

async function planState(rcon, id) {
  const state = (await readPlans(rcon)).plans.find((entry) => entry.id === id);
  assert.ok(state, `No plan entry for ${id}`);
  return state;
}

function progress(state) {
  return state.completed ?? Object.values(state.consumed || {}).reduce((total, count) => total + count, 0);
}

async function waitPlan(rcon, id, predicate, description, timeout = 30_000, stopOnPause = true) {
  let reported;
  return until(async () => {
    const state = await planState(rcon, id);
    const { status, phase, waiting } = state;
    const change = JSON.stringify({ status, phase, waiting });
    if (change !== reported) {
      record('m3-server-state', { id, status, phase, waiting, completed: progress(state), total: state.total });
      reported = change;
    }
    if (predicate(state)) return state;
    if (['failed', 'cancelled', 'expired'].includes(state.status) || (stopOnPause && state.status === 'paused')) {
      record('m3-unexpected-stop', { id, status: state.status, reason: state.reason, completed: progress(state),
        phase: state.phase, violations: state.violations, misplacements: state.misplacements, blocked: state.blocked });
      throw new Error(`Plan ${id} ${state.status}: ${state.reason}`);
    }
    return false;
  }, description, timeout, 350);
}

async function verifyWaiting(env, kind, label) {
  const { rcon, id, owner, take } = env;
  const waiting = await waitPlan(rcon, id, (state) => state.status === 'running' && state.waiting === kind,
    `RUNNING with ${kind}`, MAX_RUN_MS);
  const stalled = progress(waiting);
  const initial = await take(`waiting_${kind}`);
  await until(() => JSON.stringify(describeSlot(owner.currentWindow?.slots[4])).includes(label), `Owner status shows ${label}`);
  await delay(1800);
  const second = await take(`still_waiting_${kind}`);
  const still = await planState(rcon, id);
  assert.equal(still.status, 'running');
  assert.equal(still.waiting, kind);
  assert.equal(progress(still), stalled);
  assert.equal(still.violations, 0);
  assert.equal(initial.hash, second.hash, `World changed while waiting for ${kind}`);
  record('m3-wait-verified', { id, kind, completed: stalled, missing: still.missing, menu: describeSlot(owner.currentWindow?.slots[4]) });
  return still;
}

async function exerciseScenario(env) {
  const { scenario, id, rcon, owner, robot, connect, started, take, chest, evidence } = env;
  const replenished = {};
  if (['night', 'disconnect'].includes(scenario)) {
    await waitPlan(rcon, id, (state) => state.status === 'running' && progress(state) >= 2, 'real server-side progress');
  }
  if (scenario === 'materials') {
    const waiting = await verifyWaiting(env, 'materials', '等材料');
    assert.equal(waiting.missing[MISSING_ID] ?? waiting.missing[MISSING_ID.split(':')[1]], 1);
    commandAssert(await rcon.command(`item replace block ${coords(chest)} container.9 with ${MISSING_ID} 1`), 'Owner adds missing door');
    replenished[MISSING_ID] = 1;
  }
  if (scenario === 'chest_full') {
    await waitPlan(rcon, id, (state) => state.status === 'running' && state.phase === 'sow' && progress(state) >= 200,
      'Sowing late enough to fill only the empty chest slots', MAX_RUN_MS);
    const storage = coords(chest);
    const items = await rcon.command(`data get block ${storage} Items`);
    assert.match(items, /following block data/);
    const occupied = new Set([...items.matchAll(/\bSlot:\s*(\d+)b/g)].map((match) => Number(match[1])));
    const empty = [...Array(27).keys()].filter((slot) => !occupied.has(slot));
    assert.ok(empty.length >= 2, 'Supply fixture must have room before filling it deliberately');
    for (const slot of empty) {
      commandAssert(await rcon.command(`item replace block ${storage} container.${slot} with stone 64`), 'Fill only empty chest slot');
    }
    const waiting = await verifyWaiting(env, 'chest_full', '等材料箱腾出空间');
    assert.equal(progress(waiting), env.plan.ops.length, 'The full chest must defer settlement after all construction');
    for (const slot of empty.slice(0, 2)) {
      commandAssert(await rcon.command(`item replace block ${storage} container.${slot} with air`), 'Owner frees a chest slot');
    }
  }
  if (scenario === 'night') {
    await rcon.command('gamerule doMobSpawning true');
    await rcon.command('time set night');
    await verifyWaiting(env, 'night', '夜里停工');
    await rcon.command('time set day');
  }
  if (scenario === 'blocked') {
    await waitPlan(rcon, id, (state) => state.status === 'running' && state.waiting === 'night', 'plan waits for daylight');
    const pos = robot.entity.position.floored();
    const lo = pos.offset(-1, 0, -1);
    const hi = pos.offset(1, 2, 1);
    assert.match(await rcon.command(`fill ${coords(lo)} ${coords(hi)} bedrock outline`), /Successfully filled/);
    await rcon.command(`setblock ${coords(pos)} air`);
    const cage = await take('cage_added');
    await rcon.command('time set day');
    const state = await waitPlan(rcon, id, (entry) => entry.status === 'paused', 'Core reports trapped standing cells', 150_000);
    const after = await take('cage_paused');
    assert.equal(after.hash, cage.hash, 'The trapped Core modified an arena block');
    assert.equal(state.violations, 0);
    assert.match(`${state.reason} ${JSON.stringify(state.blocked)}`, PATH_FAILURE);
    record('m3-blocked-pass', { id, elapsedMs: performance.now() - started, reason: state.reason, blocked: state.blocked });
    await click(owner, BUTTON.cancel);
    return { done: true };
  }
  if (scenario === 'cancel') {
    const start = await until(() => evidence.cancelStarted, 'observed actual Core START_DESTROY_BLOCK', 50_000);
    await evidence.cancelClick;
    await waitPlan(rcon, id, (entry) => entry.status === 'cancelled', 'Owner cancelled via construction menu', 5_000);
    const ack = await until(() => evidence.revokeAcks.at(-1), 'outbound production revoke_ack', 5_000, 20);
    const diggingMs = evidence.cancelAt - start.at;
    const ackMs = ack.at - evidence.cancelAt;
    assert.ok(diggingMs >= 250, `Cancellation happened before the dig had progressed: ${diggingMs} ms`);
    assert.ok(ackMs <= 1000, `Core revoke ACK took ${ackMs} ms after the Owner click`);
    assert.ok(evidence.digStatuses.some((dig) => dig.status === 1 && dig.at > start.at && dig.at <= ack.at),
      'Core must send ABORT_DESTROY_BLOCK before acknowledging revocation');
    assert.ok(!evidence.digStatuses.some((dig) => dig.status === 2), 'No FINISH_DESTROY_BLOCK may follow the cancellation');
    const stopped = await take('cancelled');
    await delay(1800);
    assert.equal((await take('after_cancel')).hash, stopped.hash, 'Blocks changed after Owner cancelled');
    const original = env.before.blocks.find(([x, y, z]) => x === start.pos.x && y === start.pos.y && z === start.pos.z);
    const final = stopped.blocks.find(([x, y, z]) => x === start.pos.x && y === start.pos.y && z === start.pos.z);
    assert.ok(original && final && original[3] === final[3], 'The interrupted block must remain unchanged');
    record('m3-cancel-pass', { id, digPos: start.pos, diggingMs, ackMs,
      digPackets: evidence.digStatuses.map((dig) => ({ status: dig.status, elapsedMs: dig.at - start.at })),
      serverSnapshot: stopped.hash });
    return { done: true };
  }
  if (scenario === 'disconnect' || scenario === 'disconnect_stock') {
    if (scenario === 'disconnect_stock') {
      assert.equal(env.plan.ops.length, 241, 'Use the single-tile raised wheat fixture');
      const tilling = await waitPlan(rcon, id, (state) => state.status === 'running' && state.phase === 'till' && progress(state) >= 85,
        'Core tilled the field with a borrowed hoe', MAX_RUN_MS);
      const inventory = await inventories(rcon, chest);
      assert.equal(inventory.chest[STONE_HOE] || 0, 0);
      assert.equal(inventory.bot[STONE_HOE], 1);
      const damage = inventory.botDamage[STONE_HOE];
      assert.ok(damage > 0 && damage < 80, `The borrowed hoe must have partly tilled the plot before disconnection, got ${damage}`);
      record('m3-disconnect-stock-borrowed', { id, completed: progress(tilling), damage, inventory });
    }
    await rcon.command('kick DeskPetBot M3 isolated connection loss');
    const paused = await waitPlan(rcon, id, (state) => state.status === 'paused', 'Mod pauses on disconnect');
    assert.equal(paused.reason, 'disconnected');
    const disconnected = await take('disconnected');
    await connect(true);
    await delay(2200);
    const reconnected = await planState(rcon, id);
    assert.equal(reconnected.status, 'paused');
    assert.equal(reconnected.plan.revision, 1);
    assert.equal(progress(reconnected), progress(paused));
    assert.equal((await take('reconnected')).hash, disconnected.hash);
    await click(owner, BUTTON.continue);
    const resumed = await waitPlan(rcon, id, (state) => ['running', 'completed'].includes(state.status) && state.plan.revision === 2,
      'Owner explicitly resumes revision 2', 20_000, false);
    assert.ok(resumed.plan.ops.length < env.plan.ops.length, 'Revision 2 must contain only remaining work');
    record('m3-disconnect-resumed', { id, completedBeforeDisconnect: progress(paused), remaining: resumed.plan.ops.length });
  }
  return { replenished };
}

async function main() {
  const [alias = 'starter', direction = 'north', scenario = 'foundation'] = process.argv.slice(2);
  const template = TEMPLATE[alias];
  const turns = DIRECTIONS.indexOf(direction);
  assert.ok(template && turns >= 0 && SCENARIOS.includes(scenario),
    `Use (${Object.keys(TEMPLATE).join('|')}) (${DIRECTIONS.join('|')}) (${SCENARIOS.join('|')})`);
  const scenarioTemplate = ['chest_full', 'disconnect_stock'].includes(scenario) ? TEMPLATE.wheat : TEMPLATE.starter;
  assert.ok(scenario === 'foundation' || template === scenarioTemplate, 'Use the scenario with its intended acceptance fixture');
  const prefix = `m3_${alias}_${direction}_${scenario}_${randomUUID().slice(0, 8)}`;
  const settings = await serverSettings();
  const rcon = await createRcon(settings);
  const owner = newBot(settings, 'Owner');
  const evidence = { coreEvents: [], revokeAcks: [], digStatuses: [], standFailures: 0 };
  let robot;
  const host = runtimeRequire('./core-host').createCoreHost({
    dataDir: await fs.mkdtemp(path.join(serverDir, 'm3-core-')),
    surveyPlanMode: 'execute',
    createBot(options) {
      const bot = runtimeRequire('mineflayer').createBot(options);
      const client = bot._client;
      const write = client.write.bind(client);
      client.write = (name, payload) => {
        const result = write(name, payload);
        if (name === 'block_dig') {
          const dig = { at: performance.now(), status: payload.status, pos: payload.location };
          evidence.digStatuses.push(dig);
          if (scenario === 'cancel' && payload.status === 0 && !evidence.cancelStarted) {
            evidence.cancelStarted = dig;
            record('m3-cancel-dig-start', { pos: dig.pos });
            evidence.cancelClick = delay(350).then(() => {
              evidence.cancelAt = performance.now();
              record('m3-owner-click-cancel', { digInFlightMs: evidence.cancelAt - dig.at });
              return owner.bot.clickWindow(BUTTON.cancel, 0, 0);
            });
          }
        }
        if (name === 'custom_payload' && payload.channel === CHANNEL) {
          const message = decodeMessage(payload.data);
          if (message.type === 'revoke_ack') {
            evidence.revokeAcks.push({ at: performance.now(), grantId: message.grantId });
            record('m3-outbound-revoke-ack', { grantId: message.grantId });
          }
        }
        return result;
      };
      robot = bot;
      return bot;
    },
    emit(message) {
      if (message.type !== 'event') return;
      const event = message.event;
      evidence.coreEvents.push(event);
      if (/stand.*failed|station.*failed|position.*failed/i.test(event.payload?.type || '')) evidence.standFailures++;
      if (['core', 'connection', 'task', 'survey_plan', 'survey_plan_execute'].includes(event.type)) record('m3-core-event', { event });
    },
  });
  async function connect(reconnect = false) {
    const config = { host: settings.host, port: settings.port, auth: 'offline', version: VERSION,
      username: 'DeskPetBot', ownerName: 'Owner' };
    const response = await host.handle({ id: randomUUID(), version: 1, type: reconnect ? 'reconnect' : 'connect', config });
    assert.ok(response.ok, JSON.stringify(response.error));
    await until(() => {
      const state = host.status().connection.state;
      assert.notEqual(state, 'error', JSON.stringify(host.status().connection.lastError));
      return state === 'ready';
    }, 'real Core ready', 60_000);
  }
  const started = performance.now();
  try {
    await Promise.all([ready(owner), connect()]);
    const scenarioSite = scenario === 'natural' ? await naturalArena(rcon, owner.bot, robot)
      : await gradedArena(rcon, owner.bot, robot, template, scenario);
    if (scenario === 'blocked') await rcon.command('time set night');
    const { id, plan } = await preview(rcon, owner.bot, scenarioSite, template, turns, scenario);
    const bounds = snapshotBounds(plan.selection);
    const take = (stage) => readSnapshot(rcon, settings, prefix, stage, bounds);
    const before = await take('before');
    const inventoryBefore = await inventories(rcon, scenarioSite.chest);
    const confirmedAt = performance.now();
    await click(owner.bot, BUTTON.confirm);
    try {
      if (scenario !== 'cancel') {
        await waitPlan(rcon, id, (entry) => ['running', 'completed'].includes(entry.status), 'Mod accepted a real Core grant', 15_000);
      }
      const scenarioResult = await exerciseScenario({ scenario, id, plan, before, rcon, owner: owner.bot, robot,
        connect, started: confirmedAt, take, chest: scenarioSite.chest, evidence });
      if (scenarioResult.done) return;
      const state = await waitPlan(rcon, id, (entry) => entry.status === 'completed', 'Mod authoritative COMPLETED', MAX_RUN_MS);
      const elapsedSeconds = (performance.now() - confirmedAt) / 1000;
      assert.equal(progress(state), plan.ops.length, 'All original authorized operations must complete');
      assert.equal(state.violations, 0);
      assert.equal(typeof state.misplacements, 'number');
      const final = await take('completed');
      const inventoryAfter = await inventories(rcon, scenarioSite.chest);
      await verifyBlocks(plan, before.blocks, final.blocks, { normal: scenario === 'natural', grade: scenarioSite.grade });
      verifyMaterials(plan, inventoryBefore, inventoryAfter, scenarioResult.replenished, { normal: scenario === 'natural' });
      if (scenario === 'disconnect_stock') {
        assert.equal(inventoryAfter.bot[STONE_HOE] || 0, 0);
        assert.equal(inventoryAfter.chestDamage[STONE_HOE], 80);
      }
      const grant = evidence.coreEvents.findLast(({ type, payload }) => type === 'survey_plan'
        && payload.type === 'accepted' && payload.planId === id && payload.revision === state.plan.revision)?.payload;
      assert.ok(grant, 'The completed revision must have come from the Mod');
      const doneIndex = await until(() => {
        const index = evidence.coreEvents.findIndex(({ type, payload }) => type === 'core'
          && payload.type === 'goal_done' && payload.planId === id);
        return index >= 0 ? { index } : false;
      }, 'host emits goal_done for this plan', 5000);
      const modCompletion = evidence.coreEvents.findIndex(({ type, payload }) => type === 'survey_plan'
        && payload.type === 'revoked' && payload.status === 'completed' && payload.grantId === grant.grantId);
      assert.ok(modCompletion >= 0 && modCompletion < doneIndex.index,
        'Core goal_done must follow the Mod completed event for the same grant');
      assert.deepEqual(owner.errors, []);
      record('m3-pass', { id, template, direction, scenario, elapsedSeconds, completed: progress(state),
        violations: state.violations, misplacements: state.misplacements, lateAttempts: state.lateAttempts,
        standFailures: evidence.standFailures, before: before.hash, after: final.hash });
    } catch (error) {
      const failedSnapshot = await take('failure').catch(() => null);
      record('m3-failure-evidence', { id, prefix, elapsedSeconds: (performance.now() - started) / 1000,
        snapshotHash: failedSnapshot?.hash, state: await planState(rcon, id).then(({ plan: ignored, ...state }) => state).catch(() => null),
        standFailures: evidence.standFailures });
      if (owner.bot.currentWindow?.slots[BUTTON.cancel]) await click(owner.bot, BUTTON.cancel).catch(() => {});
      throw error;
    }
  } finally {
    await host.close();
    closeBot(owner);
    rcon.close();
  }
}

main().catch((error) => {
  record('m3-failed', { error: error.stack });
  process.exitCode = 1;
});
