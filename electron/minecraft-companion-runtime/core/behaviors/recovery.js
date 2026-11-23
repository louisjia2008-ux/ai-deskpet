'use strict';
// Recovery behaviors shared by every goal. A goal only has to say what is
// missing; these notice when the body itself is the problem and fix that:
//   - stuck: the goal keeps failing to find a path, or fails while the bot has
//     not moved for a while (a pit, a ledge, a tree top) -> unstick,
//   - full bag: drops can no longer be picked up -> store or throw away junk,
//   - death loop: the bot keeps dying in the same place -> leave the place,
//     sit nights out in a bunker, and after too many deaths end the goal.
// They watch the brain's events and the bot's deaths; the brain still decides
// who owns the body, so survival reflexes keep outranking them.

const { waiting, factsOf, isComplete } = require('../action-result');
const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep } = require('../confirm');
const { upgrades } = require('../armor');

const PATH_FAILURES = new Set(['NoPath', 'Timeout', 'path_timeout', 'not_arrived', 'no_progress', 'chase_stuck', 'leg_blocked']);
// Never wanted by any goal; thrown away first when the bag is full.
const JUNK = new Set(['gravel', 'flint', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dripstone_block',
  'pointed_dripstone', 'rotten_flesh', 'poisonous_potato', 'spider_eye', 'cobweb', 'dead_bush',
  // Ground cover broken on the way: a bag once held 37 wildflowers and 20 leaf litter.
  'wildflowers', 'leaf_litter', 'pink_petals', 'short_grass', 'tall_grass', 'fern', 'big_dripleaf', 'small_dripleaf',
  'moss_carpet', 'hanging_roots', 'glow_lichen', 'vine', 'seagrass',
  // Mined on the way, wanted by no goal: a bag full of them failed every craft (no room for the output).
  'raw_copper', 'copper_ingot', 'lapis_lazuli', 'mossy_cobblestone', 'moss_block', 'glow_ink_sac',
  'smooth_basalt', 'amethyst_block', 'amethyst_shard', 'budding_amethyst']);
// Useful in moderation: one stack is kept, the rest goes.
// A stack of netherrack is the nether's building block: bridges, steps out of lava.
const SURPLUS = { dirt: 64, cobblestone: 64, cobbled_deepslate: 64, sand: 64, netherrack: 64, stick: 64, egg: 16,
  coal: 64, feather: 32, bone: 16, string: 16, leather: 16, white_wool: 16, redstone: 64, clay_ball: 16,
  // Nether scaffolding comes home by the stack; seeds pile up at every harvest.
  basalt: 32, blackstone: 32, nether_bricks: 16, wheat_seeds: 32 };
// A tool or weapon more than once is a slot each: one is kept.
const SINGLE = new Set(['bow', 'crossbow', 'fishing_rod', 'flint_and_steel', 'shears']);
// Sheared or dropped wool of any other colour: a bed takes three of one colour, so a few are kept.
const WOOL_KEPT = 3;
// Still full with none of those: ground blocks dug anywhere go, whole stacks
// (a part stack frees no slot). A full bag fails every craft.
const CHEAP = new Set(['dirt', 'sand', 'cobbled_deepslate', 'netherrack', 'coarse_dirt']);
const SAPLINGS_KEPT = 8;
const dimensionOf = (bot) => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');

/** What a full bag can lose, junk first: [{ name, count }]. `keep` exempts items a goal still needs. */
function discardable(inventory, keep = () => false) {
  const junk = [];
  const surplus = [];
  for (const [name, count] of Object.entries(inventory || {})) {
    if (count <= 0 || keep(name)) continue;
    if (JUNK.has(name)) junk.push({ name, count });
    else if (SURPLUS[name] && count > SURPLUS[name]) surplus.push({ name, count: count - SURPLUS[name] });
    else if (name.endsWith('_sapling') && count > SAPLINGS_KEPT) surplus.push({ name, count: count - SAPLINGS_KEPT });
    else if (name.endsWith('_wool') && count > WOOL_KEPT) surplus.push({ name, count: count - WOOL_KEPT });
    else if (SINGLE.has(name) && count > 1) surplus.push({ name, count: count - 1 });
  }
  if (junk.length || surplus.length) return [...junk, ...surplus];
  return Object.entries(inventory || {}).filter(([name, count]) => count > 0 && CHEAP.has(name) && !keep(name))
    .map(([name, count]) => ({ name, count }));
}

/** What boxes the bot in, for the log: every non-air block within one cell of its body. */
function surroundings(bot) {
  const feet = bot.entity?.position?.floored?.();
  if (!feet || typeof bot.blockAt !== 'function') return null;
  const cells = [];
  for (let dy = -1; dy <= 2; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const name = bot.blockAt(feet.offset(dx, dy, dz))?.name;
        if (name && !/^(cave_|void_)?air$/.test(name)) cells.push(`${dx},${dy},${dz}:${name}`);
      }
    }
  }
  return { feet: `${feet.x},${feet.y},${feet.z}`, cells };
}

function createRecovery({
  bot,
  actions = defaultActions,
  skills = defaultSkills,
  now = Date.now,
  thresholds = {},
  activeGoal = () => null,
  stopOnDeathLoop = () => true,
} = {}) {
  if (!bot) throw new TypeError('bot is required');
  const t = {
    pathFailures: 2, // goal path failures in a row before unsticking
    stillMs: 45000, // no movement for this long while the goal fails -> stuck
    stillDistance: 2,
    fullSlots: 1, // free main-inventory slots at or below this -> tidy
    storageRange: 48,
    clusterMs: 10 * 60000, // this many deaths within clusterMs near each other -> dangerous place
    clusterDeaths: 3,
    clusterRadius: 24,
    leaveDistance: 48,
    deathWindowMs: 60 * 60000, // more than maxDeaths within this -> the goal fails
    // A second death on one task stops it: the owner (or the model) decides
    // whether to go back, rather than the bot feeding its kit to the same cave.
    maxDeaths: 1,
    // In the nether and the End dying is part of the job (the dragon fight).
    maxDeathsAway: 8,
    // A death this soon after respawning is the spawn point's, not the task's
    // (a creeper waiting there at night). Two more of those still end it.
    respawnGraceMs: 60000,
    respawnDeathsAllowed: 2,
    bunkerPollMs: 3000,
    ...thresholds,
  };
  let brain = null;
  const goalTrack = { active: false, pathStreak: 0, failsSinceAnchor: 0, lastOkAt: -Infinity, since: -Infinity };
  let anchor = null; // { position, at }: where the bot last stood still since
  const deaths = []; // { position, at }
  let danger = null; // { center, until, left }
  let bunker = null; // { bunker, since }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const resetMotion = (position) => {
    anchor = position ? { position: position.clone ? position.clone() : { ...position }, at: now() } : null;
    goalTrack.failsSinceAnchor = 0;
  };

  function observe(event) {
    switch (event?.type) {
      case 'goal_set':
        Object.assign(goalTrack, { active: true, pathStreak: 0, failsSinceAnchor: 0, lastOkAt: now(), since: now() });
        anchor = null;
        break;
      case 'goal_done':
      case 'goal_failed':
      case 'goal_cleared':
      case 'stopped':
        goalTrack.active = false;
        goalTrack.pathStreak = 0;
        break;
      case 'behavior_finished':
        if (!String(event.behavior || '').startsWith('goal:')) break;
        if (event.result?.wait || ['start', 'interrupted'].includes(event.result?.kind)) break;
        if (event.result?.ok ?? event.ok) {
          goalTrack.pathStreak = 0;
          goalTrack.lastOkAt = now();
        } else if (event.reason !== 'aborted') {
          goalTrack.failsSinceAnchor += 1;
          if (PATH_FAILURES.has(event.reason)) goalTrack.pathStreak += 1;
        }
        break;
      default:
    }
  }

  function trackMotion(state) {
    if (!state?.position) return;
    if (!anchor || distance(state.position, anchor.position) > t.stillDistance) resetMotion(state.position);
  }

  function stuckReason(state) {
    if (!goalTrack.active || state.sheltered || bunker) return null;
    if (goalTrack.pathStreak >= t.pathFailures) return 'path_failures';
    if (anchor && now() - anchor.at >= t.stillMs && goalTrack.failsSinceAnchor > 0 && goalTrack.lastOkAt <= anchor.at) {
      return 'not_moving';
    }
    return null;
  }

  const calm = (state, range) => !state.hostiles?.some((h) => h.distance <= range);
  // Quartz owns an explicit safe route while this profile is active. A
  // generic recovery may dig stairs or move toward an unrelated waypoint;
  // path failure is not permission to bypass that route's safety checks.
  const tripOwnsRecovery = () => dimensionOf(bot) === 'the_nether'
    && bot.pathfinder?.movements?.companionWalkOnly === true;

  const unstick = {
    name: 'unstick',
    band: BAND.MAINTENANCE,
    want(state) {
      trackMotion(state);
      if (tripOwnsRecovery()) return 0;
      return stuckReason(state) && calm(state, 6) ? 0.9 : 0;
    },
    async run(ctx) {
      // The trip can acquire the profile after maintenance was selected.
      if (tripOwnsRecovery()) {
        ctx.record('unstick_deferred', { dimension: 'the_nether', delegate: 'nether_trip' });
        return { ok: false, reason: 'trip_recovery_owned' };
      }
      const state = ctx.perceive();
      ctx.record('unstick', { why: stuckReason(state), at: state.position?.floored?.() || state.position });
      try {
        const result = await actions.unstick(bot, ctx);
        if (!isComplete(result) && !result?.wait) ctx.record('unstick_failed', { reason: result?.reason, around: surroundings(bot) });
        return result;
      } finally {
        // Whatever happened, the goal gets a fresh look before the next attempt.
        goalTrack.pathStreak = 0;
        resetMotion(bot.entity?.position || state.position);
      }
    },
  };

  const keep = (name) => typeof bot.companionKeep === 'function' && bot.companionKeep(name);
  const bagFull = (state) => Number.isFinite(state.freeSlots) && state.freeSlots <= t.fullSlots;

  const tidy = {
    name: 'tidy_inventory',
    band: BAND.MAINTENANCE,
    want(state) {
      if (!bagFull(state) || state.sheltered || !calm(state, 8)) return 0;
      // Thrown in a tunnel, it lies on the way back out and is picked up again
      // (over and over): wait until the goal is back up top. A mine sheds
      // its own rubble at the front (mining.js).
      if (typeof actions.underground === 'function' && actions.underground(bot)) return 0;
      return discardable(state.inventory, keep).length ? 0.7 : 0;
    },
    async run(ctx) {
      const state = ctx.perceive();
      const items = discardable(state.inventory, keep);
      if (!items.length) return { ok: false, reason: 'nothing_to_discard' };
      // Junk and surplus are thrown away, never stored: the house chest holds
      // what goals gather (a machine's materials), and a few full bags of
      // gravel would leave no room for them.
      ctx.record('tidy_inventory', { action: 'toss', items });
      return tossItems(ctx, items);
    },
  };

  async function tossItems(ctx, items) {
    const before = bot.inventory.emptySlotCount();
    const at = bot.entity.position.clone();
    await (skills.tossStacks || defaultSkills.tossStacks)(bot, ctx, items);
    // Thrown items can be picked up again after two seconds: walk off.
    await actions.fleeFrom(bot, ctx, at, { distance: 6, timeoutMs: 6000 });
    return bot.inventory.emptySlotCount() > before ? { ok: true, freed: bot.inventory.emptySlotCount() - before }
      : { ok: false, reason: 'toss_unconfirmed' };
  }

  // Deaths: a cluster marks the place as dangerous; too many fail the goal.
  function onDeath() {
    const position = bot.entity?.position?.clone?.();
    if (!position) return;
    const at = now();
    const dimension = dimensionOf(bot);
    const cause = lastOwnMessage && at - lastOwnMessage.at <= 3000 ? lastOwnMessage.cause : null;
    lastOwnMessage = null;
    const previous = deaths.at(-1);
    const respawn = Boolean(previous && respawnedAt >= previous.at && at - respawnedAt <= t.respawnGraceMs);
    deaths.push({ position, at, dimension, cause, respawn });
    while (deaths.length && at - deaths[0].at > t.deathWindowMs) deaths.shift();
    bunker = null;
    bot.companionSheltered = false;
    const near = deaths.filter((d) => d.dimension === dimension && at - d.at <= t.clusterMs
      && distance(d.position, position) <= t.clusterRadius);
    // The End's island is the fight itself: there is nowhere safer to go and
    // the kit on the ground is what the next attempt needs.
    if (near.length >= t.clusterDeaths && dimension !== 'the_end') {
      const center = near.reduce((c, d) => ({ x: c.x + d.position.x / near.length, y: c.y + d.position.y / near.length,
        z: c.z + d.position.z / near.length }), { x: 0, y: 0, z: 0 });
      danger = { center, dimension, until: at + t.clusterMs, left: false, deaths: near.length };
      bot.companionDeathDanger = danger;
    }
    // Only this goal's deaths count: one asked again after a death loop gets a fresh start.
    const limit = dimension === 'overworld' ? t.maxDeaths : t.maxDeathsAway;
    const own = deaths.filter((d) => d.at >= goalTrack.since);
    const counted = own.filter((d) => !d.respawn).length;
    if ((counted > limit || own.length > limit + t.respawnDeathsAllowed) && brain && goalTrack.active && stopOnDeathLoop()) {
      // The server's death message ("was shot by Skeleton") arrives around the
      // death itself: wait for it, so whoever reviews the failure knows why.
      clearTimeout(failTimer);
      failTimer = setTimeout(() => {
        if (!goalTrack.active || !stopOnDeathLoop()) return;
        const causes = own.map((d) => `${d.cause || 'died'} at ${Math.round(d.position.x)},${Math.round(d.position.y)},${Math.round(d.position.z)}${d.respawn ? ' just after respawning' : ''}`);
        brain.failGoal(`death_loop: ${causes.join('; ')}`).catch(() => {});
      }, 1500);
      failTimer.unref?.();
    }
  }
  let failTimer = null;
  // "DeskPetCore was slain by Husk": kept with the death it explains. The
  // server can send it just before or just after the death itself.
  let lastOwnMessage = null;
  const onMessage = (message) => {
    if (typeof message !== 'string' || !message.startsWith(`${bot.username} `)) return;
    const cause = message.slice(bot.username.length + 1, 160);
    const last = deaths.at(-1);
    // Explains the death just before it, or is kept for the one coming next.
    if (last && !last.cause && now() - last.at <= 3000) last.cause = cause;
    else lastOwnMessage = { cause, at: now() };
  };
  let respawnedAt = -Infinity;
  const onSpawn = () => { respawnedAt = now(); };
  bot.on?.('death', onDeath);
  bot.on?.('messagestr', onMessage);
  bot.on?.('spawn', onSpawn);

  const dangerActive = () => danger && danger.until > now() && danger.dimension === dimensionOf(bot);
  const nearDanger = (state) => dangerActive() && state.position && distance(state.position, danger.center) < t.leaveDistance - 8;

  // Respawned where the bot keeps dying (the world spawn on a beach, a mob
  // farm of a cave): first move well away, preferring dry land.
  const leaveDanger = {
    name: 'leave_danger',
    band: BAND.MAINTENANCE,
    want(state) {
      if (!nearDanger(state) || danger.left || state.sheltered || bunker) return 0;
      return state.isDay === false ? 0 : 0.95;
    },
    async run(ctx) {
      const target = escapeTarget(ctx.perceive().position);
      ctx.record('leave_danger', { from: danger.center, to: target, deaths: danger.deaths });
      const moved = await actions.goNear(bot, ctx, target, 4, { timeoutMs: 90000 });
      if (moved.ok || distance(bot.entity.position, danger.center) >= t.leaveDistance - 8) danger.left = true;
      return moved;
    },
  };

  function escapeTarget(from) {
    const c = danger.center;
    const away = Math.atan2(from.z - c.z, from.x - c.x);
    let best = null;
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4;
      let water = 0;
      for (let d = 8; d <= t.leaveDistance; d += 8) {
        const x = Math.floor(c.x + Math.cos(angle) * d);
        const z = Math.floor(c.z + Math.sin(angle) * d);
        if (columnIsWater(x, Math.floor(from.y), z)) water += 1;
      }
      // Few water columns first; among equals, the direction already away from the deaths.
      const turn = Math.abs(Math.atan2(Math.sin(angle - away), Math.cos(angle - away)));
      const score = water * 10 + turn;
      if (!best || score < best.score) best = { angle, score };
    }
    const r = t.leaveDistance;
    return { x: c.x + Math.cos(best.angle) * r, y: from.y, z: c.z + Math.sin(best.angle) * r };
  }

  function columnIsWater(x, y, z) {
    if (typeof bot.blockAt !== 'function') return false;
    for (let dy = 8; dy >= -8; dy -= 1) {
      const block = bot.blockAt(new Vec3(x, y + dy, z));
      if (!block || (block.boundingBox === 'empty' && !/water|lava/.test(block.name))) continue;
      return /water|lava|kelp|seagrass/.test(block.name);
    }
    return false;
  }

  // In a dangerous place after dark, a sealed 1x1 shaft is the only safe bed.
  const nightBunker = {
    name: 'danger_bunker',
    band: BAND.MAINTENANCE,
    want(state) {
      if (bunker) return 1;
      // Nights only matter in the overworld.
      if (!dangerActive() || state.isDay !== false || state.sheltered || dimensionOf(bot) !== 'overworld') return 0;
      // Pearls are hunted in the dark, and the deaths are the hunt's own:
      // shut in, a bot sat out whole nights of the hunt it was set.
      if (activeGoal() === 'hunt_pearls') return 0;
      // Already far from the deaths: the goal's own night handling is enough.
      return state.position && distance(state.position, danger.center) < t.leaveDistance * 2 ? 1 : 0;
    },
    async run(ctx) {
      if (!bunker) {
        ctx.record('danger_bunker', { action: 'dig_in' });
        const dug = await skills.digIn(bot, ctx);
        if (!dug.ok) return dug;
        bunker = { bunker: factsOf(dug).bunker, since: now() };
        bot.companionSheltered = true;
        return { ok: true };
      }
      if (ctx.perceive().isDay === false) {
        await sleep(t.bunkerPollMs, ctx.signal);
        return waiting('sheltering_until_daylight');
      }
      ctx.record('danger_bunker', { action: 'dig_out' });
      const out = await skills.digOut(bot, ctx, bunker.bunker);
      if (isComplete(out)) {
        bunker = null;
        bot.companionSheltered = false;
      }
      return out;
    },
  };

  // Armour made and left in the bag (an outfit cut short by hunger): put it
  // on. A world hunted pearls with a full iron set in its bag, and the bag
  // so full that nothing it dug could be picked up.
  const wear = {
    name: 'wear_armor',
    band: BAND.MAINTENANCE,
    want(state) {
      if (typeof bot.equip !== 'function' || !calm(state, 6)) return 0;
      return upgrades(bot).length ? 0.75 : 0;
    },
    async run(ctx) {
      for (const [item, slot] of upgrades(bot)) {
        try {
          await bot.equip(item, slot);
          ctx.record('equip', { item: item.name, slot });
        } catch (error) {
          if (error?.code === 'aborted') throw error;
          return { ok: false, reason: 'equip_failed', item: item.name };
        }
      }
      return { ok: true };
    },
  };

  return {
    behaviors: [unstick, tidy, wear, leaveDanger, nightBunker],
    observe,
    attach(target) { brain = target; },
    lastDeathCause: () => deaths.at(-1)?.cause ?? null,
    status: () => ({ goal: { ...goalTrack }, deaths: deaths.length, danger: dangerActive() ? { ...danger } : null,
      bunker: Boolean(bunker) }),
    dispose() {
      bot.removeListener?.('death', onDeath);
      bot.removeListener?.('messagestr', onMessage);
      bot.removeListener?.('spawn', onSpawn);
      clearTimeout(failTimer);
    },
  };
}

module.exports = { createRecovery, discardable, PATH_FAILURES, JUNK };
