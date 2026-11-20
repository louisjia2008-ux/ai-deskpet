'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Vec3, record, until } = require('./common.cjs');
const { Y, coords, commandAssert, describeSlot } = require('./wand-session.cjs');
const { inventories } = require('./m3-verification.cjs');

const SURVIVAL_SCENARIOS = ['night_full', 'day_attack', 'hunger', 'death'];
const NIGHT_TICK = 12542;
const DAY_TICK = 23461;
const PLAYER = 'DeskPetBot';
const MOB_TAG = 'deskpet_m3_survival';
const NO_ENTITY = /No entity was found/;
const WATCHED_HOSTILES = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'witch', 'stray', 'husk', 'phantom', 'bogged']);

async function numberData(rcon, entity, property, nullable = false) {
  const data = await rcon.command(`data get entity ${entity} ${property}`);
  if (nullable && NO_ENTITY.test(data)) return null;
  const number = data.match(/following entity data:\s*(-?\d+(?:\.\d+)?)[a-z]*$/i)?.[1];
  assert.ok(number !== undefined, `Unreadable ${property} for ${entity}: ${data}`);
  return Number(number);
}

async function positionData(rcon, entity) {
  const data = await rcon.command(`data get entity ${entity} Pos`);
  if (NO_ENTITY.test(data)) return null;
  const coordsData = data.match(/following entity data: \[([^\]]+)\]/)?.[1].split(',')
    .map((value) => Number(value.trim().replace(/[a-z]$/i, '')));
  assert.ok(coordsData?.length === 3 && coordsData.every(Number.isFinite), `Unreadable position: ${data}`);
  return new Vec3(...coordsData);
}

async function timeData(rcon, type) {
  const data = await rcon.command(`time query ${type}`);
  const time = data.match(/The time is (\d+)/)?.[1];
  assert.ok(time !== undefined, `Unreadable ${type} from server: ${data}`);
  return Number(time);
}

async function giveItem(rcon, slot, item, count = 1) {
  commandAssert(await rcon.command(`item replace entity ${PLAYER} ${slot} with ${item} ${count}`), `Equip ${item}`);
}

async function prepareSurvival(rcon, scenario) {
  if (!SURVIVAL_SCENARIOS.includes(scenario)) return;
  assert.match(await rcon.command('difficulty normal'), /Difficulty|difficulty/);
  if (['night_full', 'day_attack'].includes(scenario)) {
    for (const [slot, item] of [
      ['hotbar.2', 'iron_sword'], ['weapon.offhand', 'shield'], ['armor.head', 'iron_helmet'],
      ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'],
      ['hotbar.3', 'bread'],
    ]) await giveItem(rcon, slot, item, item === 'bread' ? 8 : 1);
    return;
  }
  if (scenario === 'hunger') {
    await rcon.command(`effect give ${PLAYER} minecraft:hunger 20 127 true`);
    try {
      await until(async () => (await numberData(rcon, PLAYER, 'foodLevel')) <= 7,
        'vanilla hunger effect lowers the authoritative food level', 15000, 100);
    } finally {
      await rcon.command(`effect clear ${PLAYER} minecraft:hunger`);
    }
    await giveItem(rcon, 'hotbar.2', 'bread', 8);
    const food = await numberData(rcon, PLAYER, 'foodLevel');
    assert.ok(food >= 4 && food <= 7, `Expected food near 6 before Owner confirmed, got ${food}`);
    record('m3-survival-hunger-before', { food, bread: 8 });
    return food;
  }
}

const SPAWN_OFFSETS = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 1], [-3, -1], [1, -3], [-1, 3]];

async function summonThreats(rcon, bot, kinds, { helmets = false } = {}) {
  const origin = await positionData(rcon, PLAYER);
  assert.ok(origin, 'Server has the Core player before the encounter');
  const cells = SPAWN_OFFSETS.map(([x, z]) => new Vec3(Math.floor(origin.x) + x, Y, Math.floor(origin.z) + z));
  const free = cells.filter((cell) => bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === 'block'
    && !bot.blockAt(cell)?.shapes.length && !bot.blockAt(cell.offset(0, 1, 0))?.shapes.length);
  assert.ok(free.length >= kinds.length, `Only ${free.length} open summon locations by ${origin}`);
  const startAt = Date.now();
  const mobs = [];
  for (const [index, kind] of kinds.entries()) {
    const tag = `${MOB_TAG}_${index}`;
    const at = free[index].offset(0.5, 0, 0.5);
    // Sheltering a daylight zombie with a leather cap keeps vanilla AI active in the open.
    const gear = helmets ? ',equipment:{head:{id:"minecraft:leather_helmet",count:1}}' : '';
    const nbt = `{PersistenceRequired:1b,Tags:["${MOB_TAG}","${tag}"]${gear}}`;
    commandAssert(await rcon.command(`summon minecraft:${kind} ${coords(at)} ${nbt}`), `Summon real ${kind}`);
    mobs.push({ kind, tag, at, selector: `@e[tag=${tag},limit=1]` });
  }
  record('m3-survival-threats', { startAt, player: origin, mobs });
  return { startAt, origin, mobs };
}

async function observeEncounter(env, encounter) {
  const { rcon, plan, robot, evidence } = env;
  const position = await positionData(rcon, PLAYER);
  const health = await numberData(rcon, PLAYER, 'Health', true);
  const mobs = [];
  for (const mob of encounter.mobs) {
    const health = await numberData(rcon, mob.selector, 'Health', true);
    const at = health === null ? null : await positionData(rcon, mob.selector);
    mobs.push({ name: mob.kind, tag: mob.tag, at, health });
  }
  const events = evidence.coreEvents.filter((event) => event.type === 'core' && event.at >= encounter.startAt);
  const attacks = events.filter(({ payload }) => payload.type === 'combat_attack' || /survey.*(fight|attack)/.test(payload.type));
  const retreats = events.filter(({ payload }) => (payload.type === 'behavior_started' && /retreat|flee|escape/.test(payload.behavior))
    || /survey.*(retreat|flee|escape)/.test(payload.type));
  // An outbound attack has to accompany observed server damage, so merely selecting a response is insufficient.
  const fought = attacks.length > 0 && mobs.some((mob) => mob.health === null || mob.health < 20);
  const fled = retreats.length > 0 && position && position.distanceTo(encounter.origin) >= 3;
  const { minX, maxX, minZ, maxZ } = plan.selection;
  const siteDistance = position && Math.hypot(position.x - (minX + maxX + 1) / 2, position.z - (minZ + maxZ + 1) / 2);
  const nearby = Object.values(robot.entities).flatMap(({ name, id, position: at }) => {
    if (!position || !at || !WATCHED_HOSTILES.has(name)) return [];
    const distance = position.distanceTo(at);
    return distance <= 20 ? [{ name, id, at, distance }] : [];
  }).sort((left, right) => left.distance - right.distance);
  const result = { position, siteDistance, health, mobs, nearby, attacks: attacks.length, retreats: retreats.length, fought, fled: Boolean(fled) };
  record('m3-survival-encounter-sample', result);
  return result;
}

async function fullNight(env, { waitPlan, verifyWaiting, planState, progress }) {
  const { id, plan, rcon, robot, take, evidence } = env;
  await waitPlan(rcon, id, (state) => state.status === 'running' && progress(state) >= Math.floor(plan.ops.length / 2),
    'half of the original plan completed before dusk', 180000);
  for (const command of ['gamerule doMobSpawning true', `time set ${NIGHT_TICK}`, 'gamerule doDaylightCycle true']) {
    commandAssert(await rcon.command(command), 'Start an uninterrupted natural night');
  }
  const startTick = await timeData(rcon, 'gametime');
  const startDayTick = await timeData(rcon, 'daytime');
  const start = performance.now();
  const night = await verifyWaiting(env, 'night', '夜里停工');
  const before = await take('natural_night_start');
  const light = robot.blockAt(robot.entity.position.floored());
  assert.equal(light?.light, 0, 'No artificial block light may protect the bot in the night fixture');
  assert.ok(!before.blocks.some(([, , , state]) => /:(?:\w+_)?(?:torch|lantern|glowstone|sea_lantern|shroomlight|fire)(?:\[|$)/.test(state)),
    'No luminous blocks belong in the dark fixture at sundown');
  record('m3-survival-night-fixture', { startTick, startDayTick, blockLight: light.light, skyLight: light.skyLight, progress: progress(night) });
  const encounter = await summonThreats(rcon, robot, ['zombie', 'zombie', 'skeleton']);
  let defense;
  let minHealth = 20;
  let maxSiteDistance = 0;
  let lastNightHash;
  let dayTick;
  for (let sample = 0; performance.now() - start < 13 * 60_000; sample++) {
    dayTick = await timeData(rcon, 'daytime');
    const state = await planState(rcon, id);
    const observed = await observeEncounter(env, encounter);
    if (observed.fought || observed.fled) defense ||= observed;
    maxSiteDistance = Math.max(maxSiteDistance, observed.siteDistance ?? 0);
    minHealth = Math.min(minHealth, observed.health ?? 0);
    assert.equal(evidence.deaths.length, 0, 'The Core player died during the hostile night');
    assert.ok(observed.health > 0, 'The Core player is alive according to the server');
    assert.equal(state.violations, 0);
    if (dayTick < NIGHT_TICK || dayTick >= DAY_TICK) break;
    if (state.waiting !== 'night' && dayTick >= DAY_TICK - 20 && await timeData(rcon, 'daytime') >= DAY_TICK) {
      dayTick = await timeData(rcon, 'daytime');
      break;
    }
    assert.equal(state.status, 'running');
    assert.equal(state.waiting, 'night');
    assert.equal(progress(state), progress(night), 'Construction must stay still throughout the night');
    const remainingMs = (DAY_TICK - dayTick) * 50;
    if (remainingMs <= 1500 && !lastNightHash) {
      lastNightHash = (await take('natural_night_end')).hash;
      assert.equal(lastNightHash, before.hash, 'No block in the snapshot should change during the untreated night');
    }
    const interval = sample < 16 ? 800 : observed.nearby.length || observed.health < 18 ? 1600 : 10000;
    await delay(Math.min(interval, Math.max(250, remainingMs - 1000)));
  }
  const ticks = (await timeData(rcon, 'gametime')) - startTick;
  const elapsedSeconds = (performance.now() - start) / 1000;
  assert.ok((dayTick >= DAY_TICK || dayTick < NIGHT_TICK) && ticks >= DAY_TICK - startDayTick - 30 && elapsedSeconds >= 500,
    `The server has not naturally completed the night (${dayTick}, ${ticks} ticks, ${elapsedSeconds}s)`);
  assert.ok(defense, 'Server samples must corroborate Core fighting or retreat before dawn');
  assert.ok(lastNightHash, 'The server snapshot must cover the last part of the night before construction restarts');
  const resumed = await waitPlan(rcon, id, (state) => progress(state) > progress(night), 'blocks resume automatically after sunrise', 90000);
  record('m3-survival-night-pass', { id, startDayTick, endDayTick: dayTick, ticks, elapsedSeconds, minHealth, maxSiteDistance,
    defense, stoppedAt: progress(night), resumedAt: progress(resumed) });
}

async function dayAttack(env, { waitPlan, planState, progress }) {
  const { id, plan, rcon, robot, evidence } = env;
  const active = await waitPlan(rcon, id, (state) => state.status === 'running' && progress(state) >= Math.floor(plan.ops.length / 3),
    'daytime construction before the zombie encounter', 120000);
  const at = await timeData(rcon, 'daytime');
  assert.ok(at < NIGHT_TICK);
  const encounter = await summonThreats(rcon, robot, ['zombie'], { helmets: true });
  let evidenceSample;
  const outcome = await until(async () => {
    const observation = await observeEncounter(env, encounter);
    assert.equal(evidence.deaths.length, 0, 'Core must survive the daytime encounter');
    assert.ok(observation.health > 0);
    if (observation.fought || observation.fled) evidenceSample ||= observation;
    const threat = observation.mobs[0];
    if (evidenceSample && (threat.health === null || (threat.at && observation.position.distanceTo(threat.at) >= 8))) {
      return { ...observation, decision: threat.health === null ? 'defeated' : 'escaped' };
    }
    return false;
  }, 'server records the Core fighting or escaping the zombie', 90000, 450);
  const protectedThrough = progress(await planState(rcon, id));
  const resumed = await waitPlan(rcon, id, (state) => progress(state) > protectedThrough, 'work resumes after daytime protection', 90000);
  record('m3-survival-day-pass', { id, injectedAt: progress(active), protectedThrough, resumedAt: progress(resumed), outcome });
}

async function hunger(env, { planState }) {
  const { id, rcon, chest, evidence } = env;
  const initial = env.foodBefore;
  assert.ok(initial >= 4 && initial <= 7, `Initial server food was ${initial}`);
  const fed = await until(async () => {
    const current = await numberData(rcon, PLAYER, 'foodLevel');
    if (current <= initial) return false;
    const inventory = await inventories(rcon, chest);
    const bread = inventory.bot['minecraft:bread'] ?? 0;
    return bread < 8 && { food: current, bread };
  }, 'bot eats its own bread and vanilla increases its food while authorized', 45000, 250);
  const state = await planState(rcon, id);
  assert.equal(state.status, 'running');
  assert.equal(state.violations, 0);
  assert.ok(!evidence.deaths.length);
  record('m3-survival-hunger-pass', { id, initial, ...fed, elapsedSeconds: (performance.now() - env.started) / 1000 });
}

function readDeathPosition(raw) {
  const match = raw.match(/pos:\s*\[(?:I;\s*)?(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/i);
  assert.ok(match, `Server's last death location did not include a block position: ${raw}`);
  return new Vec3(...match.slice(1).map(Number));
}

async function death(env, { waitPlan, planState, progress }) {
  const { id, rcon, owner, robot, evidence, take } = env;
  const active = await waitPlan(rcon, id, (state) => state.status === 'running' && state.phase === 'walls' && progress(state) >= 16,
    'Core is working with actual construction supplies before /kill', 120000);
  const lastAlive = await positionData(rcon, PLAYER);
  assert.ok(lastAlive);
  commandAssert(await rcon.command(`kill ${PLAYER}`), 'Kill only the isolated test player');
  const paused = await waitPlan(rcon, id, (state) => state.status === 'paused', 'Mod pauses on genuine death');
  assert.equal(paused.reason, 'bot_died');
  assert.equal(paused.blocked?.reason, 'bot_died');
  assert.equal(paused.blocked?.dimension, 'minecraft:overworld');
  await until(() => evidence.deaths.length > 0 && robot.health > 0, 'Core receives vanilla death and respawn', 20000);
  const tags = ['last_death_location', 'LastDeathLocation'];
  let raw = '';
  for (const tag of tags) {
    raw = await rcon.command(`data get entity ${PLAYER} ${tag}`);
    if (/minecraft:overworld/.test(raw)) break;
  }
  const deathBlock = readDeathPosition(raw);
  const reported = paused.blocked.pos;
  assert.deepEqual(reported, { x: deathBlock.x, y: deathBlock.y, z: deathBlock.z });
  await until(() => JSON.stringify(describeSlot(owner.currentWindow?.slots[4])).includes('机器人死亡'),
    'Owner construction status displays the death coordinate');
  const statusSlot = JSON.stringify(describeSlot(owner.currentWindow?.slots[4]));
  assert.ok(statusSlot.includes(`${deathBlock.x}, ${deathBlock.y}, ${deathBlock.z}`));
  const dropped = await rcon.command(`execute positioned ${coords(deathBlock)} if entity @e[type=item,distance=..4]`);
  assert.match(dropped, /Test passed/);
  const stopped = await take('death_paused');
  const respawn = await positionData(rcon, PLAYER);
  assert.ok(respawn && respawn.distanceTo(deathBlock) > 4);
  const grace = performance.now();
  await delay(12000);
  const still = await planState(rcon, id);
  assert.equal(still.status, 'paused');
  assert.equal(still.reason, 'bot_died');
  assert.equal(still.plan.revision, active.plan.revision);
  assert.equal(progress(still), progress(paused));
  assert.equal(still.violations, 0);
  assert.equal((await take('death_no_auto_resume')).hash, stopped.hash);
  assert.match(await rcon.command(`execute positioned ${coords(deathBlock)} if entity @e[type=item,distance=..4]`), /Test passed/);
  assert.ok(!evidence.coreEvents.some(({ type, payload }) => type === 'core' && payload?.behavior === 'recover_drops'),
    'Core must leave the dropped construction supplies at the recorded death site');
  assert.equal(evidence.coreEvents.filter(({ type, payload }) => type === 'survey_plan' && payload.type === 'accepted' && payload.planId === id).length, 1);
  record('m3-survival-death-pass', { id, completed: progress(paused), deathBlock: reported, raw, lastAlive, respawn,
    pausedAfterRespawnMs: performance.now() - grace, statusSlot, violations: still.violations });
  return { done: true };
}

async function exerciseSurvival(env, helpers) {
  switch (env.scenario) {
    case 'night_full': await fullNight(env, helpers); break;
    case 'day_attack': await dayAttack(env, helpers); break;
    case 'hunger': await hunger(env, helpers); break;
    case 'death': return death(env, helpers);
    default: throw new Error(`Unknown survival scenario ${env.scenario}`);
  }
  return { replenished: {} };
}

module.exports = { SURVIVAL_SCENARIOS, prepareSurvival, exerciseSurvival };
