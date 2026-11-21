'use strict';
// The full chain: from an empty inventory to gear (stone, then iron tools and
// a shield) and a finished, furnished starter house whose furniture has been
// used for real (crafted at the table, smelted in the furnace, stored in the
// chest, slept in or set spawn at the bed).
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet          -> choose one (or explore)
//   2. site work left       -> dig an obstacle / fill a hole
//   3. planner has a step   -> gather / craft / smelt / hunt / place a station
//   4. house incomplete     -> place the next block or piece of furniture
//   5. furniture unverified -> use it
// The only memory kept across runs is the chosen site, what was left in the
// furnace, short-lived blacklists, and which furniture has been used.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey, familyOf } = require('../knowledge');
const { createStarterHouse } = require('../blueprints/starterHouse');
const { chooseSite, chooseHillside, safeCaveDig, canClearTerrain, isSoft, siteWork } = require('../site');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep, waitUntil } = require('../confirm');
const { runPlanned } = require('./common');
const { outwardLeg, gatherWood } = require('../adaptation-strategies');
const { targetsFor } = require('../target-memory');
const { blockTarget, alternateStand, clearTerrain } = require('../target-recovery');

const DEFAULT_GEAR = ['stone_sword', 'stone_tier_pickaxe', 'iron_sword', 'iron_pickaxe', 'shield'];
// Stone tools come before the house. Iron needs useful crafting and smelting stations.
const EARLY_GEAR = new Set(['stone_sword', 'stone_tier_pickaxe', 'pickaxe', 'wooden_pickaxe']);
const DOWN = [new Vec3(0, -1, 0)];
const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const FILLERS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const BATCH = 16;
const RAW_MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'];
const STORABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stick', 'rotten_flesh', 'feather', 'leather'];

function createHomesteadGoal({ bot, anchor = null, near = null, variant = 'starter', autonomous = false, gear = DEFAULT_GEAR, skills = defaultSkills, actions = defaultActions,
  kb = KNOWLEDGE, maxExploreStreak = 20, searchRadius = 128, maxSearchStreak = 8 } = {}) {
  const memory = {
    house: anchor ? createStarterHouse(anchor, { variant }) : null,
    // A spot the owner chose (or stood on): built there or not at all, never moved elsewhere.
    pinned: Boolean(anchor || near),
    furnace: { item: null, input: 0, output: 0 },
    explore: {},
    exploreStreak: 0,
    shortfall: {},
    verified: { crafting_table: false, furnace: false, chest: false, bed: false, guestBed: false },
    established: false,
    steps: 0,
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const skipped = createBlacklist({ ttlMs: 300000 });
  const reportedUpgradeBlocks = new Map();

  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const matches = (family, name) => Boolean(name) && kb[family].match(name);

  const bedKeys = ['bed', 'guestBed'];
  const workSite = () => memory.established ? memory.house
    : { ...memory.house, foundation: [...memory.house.foundation, ...memory.house.torchSupports] };
  const air = (name) => ['air', 'cave_air', 'void_air'].includes(name);
  const idAt = (list, p) => list.some(q => posKey(q) === posKey(p));
  const below = (p) => ({ ...p, y: p.y - 1 });
  const top = (p) => ({ ...p, y: p.y + 1 });
  const targetOf = (step, p, cells = []) => blockTarget(bot, 'homestead', step, p, { cells });
  const placementTarget = (what, p, options = {}) => targetOf(`place_${what}`, p, [below(p), ...(options.alsoClear || [])]);
  const optionalStep = (what) => what === 'torch' || what === 'guestBed';
  const optionalCell = (p) => {
    const h = memory.house, { torches, guestBed } = h.furniture;
    return idAt([...torches, guestBed.position, guestBed.head], p);
  };
  const positionsFor = (f) => [f.crafting_table.position, f.furnace.position, f.chest.position, f.door.position, f.door.upper,
    f.bed.position, f.bed.head, f.bed.stand, f.guestBed.position, f.guestBed.head, f.guestBed.stand];
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function torchAlternates(p) {
    const h = memory.house;
    return sides.map(([dx, dz]) => ({ x: p.x + dx, y: p.y, z: p.z + dz }))
      .filter(q => (p.z < h.anchor.z ? q.z === p.z : insideRoom(q))
        && !idAt([...positionsFor(h.furniture), h.entrance, h.interiorCenter, ...h.furniture.torches], q));
  }
  function guestAlternates() {
    const f = memory.house.furniture, bed = f.guestBed;
    const reserved = positionsFor(f).slice(0, -3).concat(f.torches, memory.house.interiorCenter);
    return sides.map(([dx, dz]) => {
      const move = (p) => ({ x: p.x + dx, y: p.y, z: p.z + dz });
      return { ...bed, position: move(bed.position), head: move(bed.head), stand: move(bed.stand) };
    }).filter(b => [b.position, b.head, b.stand].every(p => insideRoom(p) && !idAt(reserved, p)));
  }

  function houseState(ctx) {
    const house = memory.house;
    const unknown = [];
    const check = (p, match, required = true) => {
      const block = blockAt(p);
      if (!block) { if (required) unknown.push(p); return null; }
      return match(block.name, block);
    };
    const missing = house.blocks.filter((b) => check(b.position, (name) => matches(b.family, name)) === false);
    const foundationMissing = house.foundation.filter((p) => check(p,
      (name, block) => block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(name)) === false);
    const f = house.furniture;
    const both = (a, b) => a === false || b === false ? false : a === null || b === null ? null : true;
    if (!matches('bed', nameAt(f.guestBed.position))) {
      const installed = guestAlternates().find(b => matches('bed', nameAt(b.position)) && matches('bed', nameAt(b.head)));
      if (installed) f.guestBed = installed;
    }
    const placed = {
      crafting_table: check(f.crafting_table.position, (n) => n === 'crafting_table'),
      furnace: check(f.furnace.position, (n) => n === 'furnace'),
      chest: check(f.chest.position, (n) => n === 'chest'),
      bed: both(check(f.bed.position, (n) => matches('bed', n), !autonomous), check(f.bed.head, (n) => matches('bed', n), !autonomous)),
      door: both(check(f.door.position, (n) => n.endsWith('_door')), check(f.door.upper, (n) => n.endsWith('_door'))),
      guestBed: both(check(f.guestBed.position, (n) => matches('bed', n), false),
        check(f.guestBed.head, (n) => matches('bed', n), false)),
    };
    const blocked = [];
    const targets = targetsFor(bot, ctx);
    const guest = targets.excluded(placementTarget('guestBed', f.guestBed.position, { alsoClear: [f.guestBed.head] }));
    if (!placed.guestBed && guest) {
      blocked.push({ item: 'guestBed', position: f.guestBed.position, reason: guest.reason });
    }
    const torches = [];
    for (const p of f.torches) {
      if (check(p, (n) => n === 'torch', false) !== false || torchAlternates(p).some(q => nameAt(q) === 'torch')) continue;
      const stopped = targets.excluded(placementTarget('torch', p));
      if (stopped) blocked.push({ item: 'torch', position: p, reason: stopped.reason });
      else torches.push(p);
    }
    // A replacement is a new station/bed: its predecessor's successful use
    // cannot verify it. An unloaded cell does not erase that observation.
    for (const key of Object.keys(memory.verified)) if (placed[key] === false) memory.verified[key] = false;
    const accessObstructed = [house.entrance, top(house.entrance)].some(p => check(p, (_n, b) => isSoft(b)) === false);
    const scaffoldLeft = house.scaffold.some(p => FILLERS.has(nameAt(p)));
    return { missing, placed, unknown, foundationMissing, blocked, torches, accessObstructed, scaffoldLeft };
  }

  function expectedAt(p) {
    const house = memory.house;
    const key = posKey(p);
    const block = house.blocks.find((b) => posKey(b.position) === key);
    if (block) return (name) => matches(block.family, name);
    const f = house.furniture;
    if (posKey(f.crafting_table.position) === key) return (n) => n === 'crafting_table';
    if (posKey(f.furnace.position) === key) return (n) => n === 'furnace';
    if (posKey(f.chest.position) === key) return (n) => n === 'chest';
    for (const bed of bedKeys.map((id) => f[id])) {
      if (posKey(bed.position) === key || posKey(bed.head) === key) {
        return (n) => matches('bed', n) || (bed === f.guestBed && memory.established);
      }
    }
    // No door yet: at night the doorway is plugged with dirt or stone, dug out again by day.
    if (posKey(f.door.position) === key || posKey(f.door.upper) === key) {
      return (n) => (n.endsWith('_door') && nameAt(f.door.position)?.endsWith('_door') && nameAt(f.door.upper)?.endsWith('_door'))
        || (memory.doorPlug && FILLERS.has(n));
    }
    if (house.scaffold.some((p2) => posKey(p2) === key) && memory.scaffoldActive) return (n) => FILLERS.has(n);
    if (f.torches.some((t) => posKey(t) === key)) return (n) => n === 'torch';
    return () => false;
  }

  // Nothing is mined under the house at any depth: a pit there ends up below
  // the protected foundation with no way back up.
  function nearHouseColumn(p) {
    const a = memory.house?.anchor;
    if (!a) return false;
    return p.x >= a.x - 2 && p.x <= a.x + 8 && p.z >= a.z - 2 && p.z <= a.z + 8 && p.y <= a.y + 5;
  }

  function insideHouse(p) {
    const a = memory.house?.anchor;
    if (!a) return false;
    return p.x >= a.x - 1 && p.x <= a.x + 7 && p.z >= a.z - 1 && p.z <= a.z + 7 && p.y >= a.y - 3 && p.y <= a.y + 5;
  }

  function protects(p) {
    if (!memory.house || !p || !insideHouse(p)) return false;
    const block = blockAt(p);
    if (!block) return false;
    if (workSite().foundation.some((cell) => posKey(cell) === posKey(p))) {
      return block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(block.name);
    }
    return expectedAt(p)(block.name);
  }

  // Only observed defects are repair requests. A distant unloaded house is
  // unknown, never a collection of missing walls to rebuild from a guess.
  function maintenance(state) {
    if (!memory.house) return { missing: [], unknown: [], gear: [], unverified: [] };
    const hs = houseState();
    const missing = hs.missing.map((b) => `${b.family}@${posKey(b.position)}`);
    missing.push(...hs.foundationMissing.map((p) => `foundation@${posKey(p)}`));
    if (hs.accessObstructed) missing.push('entrance');
    if (state.isDay && hs.placed.door && doorOpen() === false && insideRoom(bot.entity.position.floored())) missing.push('day_door');
    for (const [key, placed] of Object.entries(hs.placed)) {
      if (key === 'guestBed' || (autonomous && key === 'bed')) continue;
      if (placed === false && !hs.blocked.some(({ item }) => item === key)) missing.push(key);
    }
    return { missing, unknown: hs.unknown.map(posKey), blocked: hs.blocked,
      gear: gear.filter((key) => countKey(key, state.inventory, kb) <= 0),
       unverified: Object.keys(memory.verified).filter((key) => key !== 'guestBed' && !memory.verified[key] && hs.placed[key] === true) };
  }

  // House materials only; gear is planned separately before and after the house.
  function requirements(state, hs) {
    const reqs = [];
    for (const [key, entry] of Object.entries(memory.shortfall)) {
      if (entry.until < Date.now()) { delete memory.shortfall[key]; continue; }
      reqs.push({ key, count: countKey(key, state.inventory, kb) + entry.extra });
    }
    const work = siteWork((x, y, z) => bot.blockAt(new Vec3(x, y, z)), memory.house, (p, block) => expectedAt(p)(block.name));
    const stair = memory.scaffoldActive ? memory.house.scaffold.filter((p) => !FILLERS.has(nameAt(p))).length : 0;
    if (work.fills.length + stair) reqs.push({ key: 'dirt', count: work.fills.length + stair });
    const remaining = {};
    for (const block of hs.missing) remaining[block.family] = (remaining[block.family] || 0) + 1;
    for (const [family, count] of Object.entries(remaining)) reqs.push({ key: family, count });
    if (!autonomous && hs.placed.bed === false) reqs.push({ key: 'bed', count: 1 });
    for (const piece of ['chest', 'door']) if (!hs.placed[piece]) reqs.push({ key: piece, count: 1 });
    if (!hs.placed.furnace) reqs.push({ key: 'furnace', count: 1 });
    if (!hs.placed.crafting_table) reqs.push({ key: 'crafting_table', count: 1 });
    return reqs;
  }

  function plannerInventory(state) {
    const inventory = { ...state.inventory };
    // Items left in the furnace still count; otherwise they would be gathered twice.
    if (memory.furnace.item === 'raw_iron') {
      inventory.raw_iron = (inventory.raw_iron || 0) + memory.furnace.input;
      inventory.iron_ingot = (inventory.iron_ingot || 0) + memory.furnace.output;
    }
    return inventory;
  }

  function complete(state, hs = memory.house && houseState()) {
    if (!memory.house) return false;
    if (!autonomous && !gear.every((key) => countKey(key, state.inventory, kb) > 0)) return false;
    // An expedition can unload home without damaging it. Only trust this
    // connection's verification: a loaded legacy home still needs its upgrade.
    if (hs.accessObstructed || hs.scaffoldLeft) return false;
    if (hs.unknown.length) return memory.validated === true && !hs.missing.length && !hs.foundationMissing.length
        && !Object.entries(hs.placed).some(([id, placed]) => id !== 'guestBed' && (!autonomous || id !== 'bed') && placed === false);
    if (hs.missing.length || hs.foundationMissing.length || !hs.placed.door || (!autonomous && !hs.placed.bed) || !hs.placed.chest
      || !hs.placed.crafting_table || !hs.placed.furnace) return false;
    if (!autonomous && Object.entries(memory.verified).some(([id, used]) => id !== 'guestBed' && !used)) return false;
    memory.established = true;
    memory.validated = true;
    return true;
  }

  function status(state) {
    if (!memory.house) return null;
    const hs = houseState();
    const usable = complete(state, hs);
    const upgrades = [
      ...memory.house.furniture.torches.map(p => {
        const blocked = hs.blocked.find(b => b.item === 'torch' && posKey(b.position) === posKey(p));
        if (blocked) return { ...blocked, status: 'blocked' };
        const placed = nameAt(p) === 'torch' || torchAlternates(p).some(q => nameAt(q) === 'torch');
        return { item: 'torch', position: p, status: placed ? 'placed' : nameAt(p) ? 'missing' : 'unknown' };
      }),
      { item: 'guestBed', position: memory.house.furniture.guestBed.position,
        status: hs.placed.guestBed === true ? 'placed' : hs.placed.guestBed === null ? 'unknown' : 'missing' },
    ];
    const guestBlocked = hs.blocked.find(b => b.item === 'guestBed');
    if (guestBlocked) upgrades[upgrades.length - 1] = { ...guestBlocked, status: 'blocked' };
    const visible = upgrades.every(u => u.status === 'placed');
    if (visible) memory.upgradesComplete = true;
    else if (upgrades.some(u => ['missing', 'blocked'].includes(u.status))) memory.upgradesComplete = false;
    return { anchor: { ...memory.house.anchor }, usable, finished: usable && memory.upgradesComplete === true, upgrades };
  }

  async function explore(ctx, why) {
    memory.exploreStreak += 1;
    // With a site, materials are looked for around it: one search ran 850
    // blocks out after trees, was caught by the night there and died twice.
    // Nothing within reach ends the task, and the owner hears what is missing.
    // Before a site is chosen, the owner's spot is the centre to stay around.
    const a = memory.house?.anchor || near;
    if (a) {
      memory.explore.around = { x: a.x, z: a.z, radius: searchRadius };
      // Still on the way back (respawned 500 blocks off): those legs search
      // nothing near the site, and once used them all up to say no tree grew
      // around a house in a forest.
      if (Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z) > searchRadius) memory.exploreStreak -= 1;
      if (memory.exploreStreak > maxSearchStreak) {
        return { ok: false, reason: `none_near_site:${why} within ${searchRadius} of ${a.x},${a.y},${a.z}`, giveUp: true };
      }
    } else delete memory.explore.around;
    if (memory.exploreStreak > maxExploreStreak) return { ok: false, reason: `exhausted:${why}` };
    ctx.record('explore_for', { why, streak: memory.exploreStreak });
    return skills.explore(bot, ctx, memory.explore);
  }

  const plan = (ctx, args) => planNext({ ...args, kb, stepBlocked: ctx.stepBlocked });
  const runPlannerStep = (ctx, step, requirement) => runPlanned(ctx, step, () => executePlannerStep(ctx, step, requirement));

  async function executePlannerStep(ctx, step, requirement) {
    ctx.record('plan_step', { kind: step.kind, key: step.key, for: step.for, item: step.item, count: step.count ?? step.times });
    const house = memory.house;
    // A crafting table carried along: crafting happens where the bot is, down
    // in its quarry, rather than after a climb that can fail and a walk back.
    const portable = step.kind === 'craft' && step.table && !nearHouseTable()
      && (ctx.perceive().inventory.crafting_table || 0) > 0;
    // Everything else happens up top: climb out of the pit first.
    if (step.kind !== 'gather' && !portable) {
      const up = await surfaceFirst(ctx);
      if (up) return { ...up, transit: true };
    }
    switch (step.kind) {
      case 'place_station': {
        // A station needs its foundation; if that hole is still open, fill it first.
        const spot = house.furniture[step.station].position;
        const below = { x: spot.x, y: spot.y - 1, z: spot.z };
        if (blockAt(below)?.boundingBox !== 'block') {
          blacklist.delete(`site:${posKey(below)}`);
          ctx.record('station_needs_foundation', { station: step.station });
          return placeRecorded(ctx, below, (n) => FILLERS.has(n), 'foundation', {});
        }
        return placeRecorded(ctx, spot, (n) => n === step.station, step.station, { faces: DOWN });
      }
      case 'craft': {
        let table = step.table ? house.furniture.crafting_table.position : null;
        let carried = null;
        if (portable) {
          const placed = await placePortableTable(ctx);
          if (placed.ok) table = carried = placed.position;
          else {
            const up = await surfaceFirst(ctx);
            if (up) return up;
          }
        }
        let result;
        try {
          result = await skills.craft(bot, ctx, { item: step.item, times: step.times, tablePosition: table });
        } finally {
          if (carried) await pickUpTable(ctx, carried);
        }
        if (result.ok && result.usedTable && !carried) memory.verified.crafting_table = true;
        // Short of something the plan thought was there: plan for it explicitly for a while.
        for (const m of result.missing || []) {
          const family = familyOf(m.name, kb);
          if (family) memory.shortfall[family] = { extra: m.short, until: Date.now() + 120000 };
        }
        return result;
      }
      case 'gather': {
        if (ctx.adapt && step.key === 'log') return gatherWood({ bot, ctx, skills, actions, memory, anchor: house?.anchor,
          blocks: step.blocks, dropMatch: kb.log.match, blacklist, exclude: nearHouseColumn });
        // Nothing within the usual 48 blocks: look as far as the loaded world
        // reaches before walking off to explore (a felled plain, a treeless hill).
        let result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
          blacklist, exclude: nearHouseColumn });
        if (result.reason === 'no_target_in_range') {
          result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
            blacklist, exclude: nearHouseColumn, radius: 128 });
        }
        if (result.reason === 'no_target_in_range') {
          if (requirement?.optional) { skipped.add(requirement.key, 'unavailable'); return { ok: true, skipped: requirement.key }; }
          return explore(ctx, step.key);
        }
        return result;
      }
      case 'smelt': {
        const result = await skills.smelt(bot, ctx, { input: step.input, count: step.count,
          furnacePosition: house.furniture.furnace.position, memory: memory.furnace });
        if (result.ok) memory.verified.furnace = true;
        return result;
      }
      case 'hunt': {
        // Optional food runs wait until the bot is healthy again.
        if (requirement?.optional && ctx.perceive().health < 12) {
          skipped.add(requirement.key, 'low_health', 60000);
          return { ok: true, skipped: requirement.key };
        }
        // Food is wanted close by (a rabbit 93 blocks off led across a lake);
        // sheep for the bed are worth a longer walk.
        const result = await skills.huntOne(bot, ctx, { mobs: step.mobs, dropMatch: kb[step.key].match, blacklist,
          radius: step.key === 'food' ? 48 : 96,
          ...(step.key === 'wool' ? woolPreference(ctx.perceive().inventory) : {}) });
        // No sheep anywhere near: spiders drop string, four of which make wool.
        if (result.reason === 'no_mob_in_range' && step.key === 'wool') {
          const spider = await skills.huntOne(bot, ctx, { mobs: ['spider', 'cave_spider'], dropMatch: (n) => n === 'string', blacklist, radius: 48 });
          if (spider.reason !== 'no_mob_in_range') return spider;
        }
        if (result.reason === 'no_mob_in_range') {
          if (requirement?.optional) { skipped.add(requirement.key, 'unavailable'); return { ok: true, skipped: requirement.key }; }
          return explore(ctx, step.key);
        }
        return result;
      }
      default:
        return { ok: false, reason: `unplannable:${step.key}:${step.reason}` };
    }
  }

  // Finished structure and its supporting floor must survive other goals'
  // paths. Misplaced obstacles remain diggable so site repair can clear them.
  function protectSite() {
    const movements = bot.pathfinder?.movements;
    if (!memory.house) return;
    bot.companionSurfaceY = memory.house.anchor.y;
    if (!memory.protectBlock) memory.protectBlock = (block) => Boolean(block?.position && protects(block.position));
    bot.companionProtectBlock = memory.protectBlock;
    // The house and the ground site work keeps clear: nothing else is built
    // there (a nether portal in it was dug out again by home maintenance).
    if (!memory.homeSite) {
      const clear = new Set((memory.house.clearance || []).map(posKey));
      memory.homeSite = (p) => insideHouse(p) || clear.has(posKey(p));
    }
    bot.companionHomeSite = memory.homeSite;
    if (!movements) return;
    if (!memory.protect) memory.protect = (block) => protects(block.position) ? 100 : insideHouse(block.position) ? 90 : 0;
    if (!movements.exclusionAreasBreak.includes(memory.protect)) movements.exclusionAreasBreak.push(memory.protect);
  }

  async function siteStep(ctx) {
    const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const work = siteWork(read, workSite(), (p, block) => expectedAt(p)(block.name));
    const targets = targetsFor(bot, ctx);
    const essential = (p) => !optionalCell(p) && !idAt(memory.house.torchSupports, p);
    let stopped = null;
    const eligible = (step, p) => {
      if (memory.established && !essential(p)) return false;
      const blocked = targets.excluded(step === 'place_foundation' ? placementTarget('foundation', p) : targetOf(step, p));
      if (blocked) {
        if (essential(p)) stopped = blocked;
        return false;
      }
      return true;
    };
    work.digs = work.digs.filter(d => eligible('site_dig', d.position));
    work.fills = work.fills.filter(d => eligible('place_foundation', d.position));
    // Down a cave (fallen in, or after its drops): every dig and fill on the
    // site was a path up through the rock, and each one timed out. Climb first.
    if (work.digs.length || work.fills.length) {
      const up = await surfaceFirst(ctx);
      if (up) return up;
    }
    // A site that keeps needing digging was misjudged; pick another while nothing stands on it yet.
    if (!memory.established && !memory.pinned && work.digs.length && memory.siteDigs > (memory.house.variant === 'hillside' ? 70 : 40)
      && nameAt(memory.house.furniture.crafting_table.position) !== 'crafting_table') {
      return abandonSite(ctx, 'unsuitable_ground');
    }
    if (work.digs.length) {
      memory.siteDigs = (memory.siteDigs || 0) + 1;
      if (memory.house.variant === 'hillside') work.digs.sort((a, b) => a.position.z - b.position.z
        || b.position.y - a.position.y || Math.abs(a.position.x - memory.house.entrance.x) - Math.abs(b.position.x - memory.house.entrance.x));
      const target = work.digs[0];
      const p = target.position;
      const dig = async () => {
        const block = blockAt(p);
        if (!block) return { ok: false, reason: 'unloaded' };
        if (bot.companionPlayerBlock?.(p)) return { ok: false, reason: 'protected_player_block' };
        if (memory.house.variant === 'hillside' && (!safeCaveDig(read, p)
          || !(/^(stone|andesite|diorite|granite|deepslate|sandstone|dirt)$/.test(block.name)
            || (p.z < memory.house.anchor.z && canClearTerrain(read, p))))) return { ok: false, reason: 'unsafe_excavation' };
        ctx.record('site_dig', { position: posKey(p), block: target.name });
        const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 30000 });
        if (!reach.ok) return reach;
        const diggingTool = memory.house.variant === 'hillside' && /^(stone|andesite|diorite|granite|deepslate|sandstone)$/.test(block.name)
          ? bot.inventory.items().find((item) => item.name.endsWith('_pickaxe')) : null;
        const dug = await actions.digBlock(bot, ctx, block, { tool: diggingTool });
        if (dug.ok) await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), () => true, { timeoutMs: 3000 });
        return dug;
      };
      return targets.run(targetOf('site_dig', p), dig, async (reason) => {
        if (['protected_player_block', 'unsafe_excavation', 'protected_home'].includes(reason)) return { ok: false, reason };
        const walk = await alternateStand(bot, ctx, actions, p);
        return walk.ok ? dig() : { ok: false, reason };
      });
    }
    if (work.fills.length && Object.keys(ctx.perceive().inventory).some((n) => FILLERS.has(n))) {
      ctx.record('site_fill', { position: posKey(work.fills[0].position) });
      return placeRecorded(ctx, work.fills[0].position, (n) => FILLERS.has(n), 'foundation', {});
    }
    if (stopped && !work.fills.length) return memory.established || memory.pinned
      ? { ok: true, waited: true, reason: 'site_target_excluded', retryAt: stopped.until }
      : abandonSite(ctx, stopped.reason);
    return null;
  }

  // Ordered build tasks. Walls and roof are placed in batches so that one
  // gathered block does not mean one trip home.
  function buildTasks(hs) {
    const f = memory.house.furniture;
    const tasks = [];
    const piece = (what, position, material, match, options = { faces: DOWN }) =>
      tasks.push({ what, position, material, match, options, batch: 1 });
    if (!hs.placed.crafting_table) piece('crafting_table', f.crafting_table.position, 'crafting_table', (n) => n === 'crafting_table');
    // The top wall row and the roof are laid from the stair.
    if (memory.scaffoldActive) {
      // The upper compact step is made by jumping onto it, not by blocking
      // headroom before the bot can climb the first step.
      const steps = memory.house.variant === 'compact' ? memory.house.scaffold.slice(0, 1) : memory.house.scaffold;
      for (const p of steps) {
        if (!FILLERS.has(nameAt(p))) tasks.push({ what: 'scaffold', position: p, material: 'dirt',
          match: (n) => FILLERS.has(n), options: { faces: DOWN }, batch: 1 });
      }
    }
    const walls = hs.missing.filter((b) => b.phase === 'walls');
    for (const b of walls) tasks.push({ what: 'wall', position: b.position, material: b.family,
      match: (n) => matches(b.family, n), batch: Math.min(walls.length, BATCH) });
    const roof = hs.missing.filter((b) => b.phase === 'roof');
    const roofing = !walls.length ? roof.map((b) => ({ what: 'roof', position: b.position, material: b.family,
      match: (n) => matches(b.family, n), batch: Math.min(roof.length, BATCH) })) : [];
    // Leave the doorway and floor clear while accessing the compact roof.
    if (memory.house.variant === 'compact' && !memory.established && roofing.length) return [...tasks, ...roofing];
    const addDoor = () => piece('door', f.door.position, 'door', (n) => matches('door', n),
      { faces: DOWN, verify: () => matches('door', nameAt(f.door.upper)), alsoClear: [f.door.upper],
        ...(memory.house.variant === 'compact' && !memory.established ? { stand: memory.house.interiorCenter } : {}) });
    if (!walls.length && !hs.placed.door && memory.house.variant !== 'compact') addDoor();
    if (!hs.placed.chest) piece('chest', f.chest.position, 'chest', (n) => n === 'chest');
    for (const id of autonomous ? [] : ['bed']) {
      if (hs.placed[id] !== false || hs.blocked.some(({ item }) => item === id)) continue;
      const bed = f[id];
      piece(id, bed.position, 'bed', (n) => matches('bed', n),
        { stand: bed.stand, verify: () => matches('bed', nameAt(bed.head)), alsoClear: [bed.head],
          requireAir: memory.established && id === 'guestBed' });
    }
    if (!hs.placed.furnace) piece('furnace', f.furnace.position, 'furnace', (n) => n === 'furnace');
    if (!walls.length && !hs.placed.door && memory.house.variant === 'compact'
      && hs.placed.furnace && hs.placed.chest && hs.placed.crafting_table) addDoor();
    tasks.push(...roofing);
    return tasks;
  }

  async function buildStep(ctx, hs, inventory, { whenBatchReady }) {
    const waiting = {};
    const targets = targetsFor(bot, ctx);
    let blocked = null;
    const tasks = buildTasks(hs).filter((task) => {
      const stopped = targets.excluded(placementTarget(task.what, task.position, task.options));
      if (stopped) blocked = stopped;
      return !stopped;
    });
    for (const task of tasks) {
      if (blacklist.has(`build:${posKey(task.position)}`)) {
        (waiting.blacklisted = waiting.blacklisted || []).push(`${task.what}@${posKey(task.position)}`);
        continue;
      }
      const have = countKey(task.material, inventory, kb);
      // Once a batch is started it continues until that material runs out.
      const continuing = memory.batch === task.material;
      if (have <= 0 || (whenBatchReady && !continuing && have < task.batch)) {
        waiting[task.material] = (waiting[task.material] || 0) + 1;
        continue;
      }
      memory.batch = task.batch > 1 ? task.material : null;
      return placeRecorded(ctx, task.position, task.match, task.what, task.options);
    }
    memory.batch = null;
    if (!whenBatchReady && Object.keys(waiting).length) ctx.record('build_waiting', waiting);
    // The blacklist only defers a failed placement while other work exists.
    // With nothing else to do, retry the earliest one that has material.
    if (!whenBatchReady) {
      const retry = tasks.find((task) => countKey(task.material, inventory, kb) > 0);
      if (retry) return placeRecorded(ctx, retry.position, retry.match, retry.what, retry.options);
      if (blocked) return memory.established || memory.pinned
        ? { ok: true, waited: true, reason: 'build_target_excluded', retryAt: blocked.until }
        : abandonSite(ctx, blocked.reason);
    }
    return null;
  }

  // A bed takes three wool of one color: go for sheep of the color most within
  // reach (already owned plus visible), and never for sheared ones.
  function woolPreference(inventory) {
    if (typeof skills.sheepWool !== 'function') return {};
    const sheep = Object.values(bot.entities || {}).filter((e) => e.name === 'sheep' && e.position
      && e.position.distanceTo(bot.entity.position) <= 96);
    const fleece = new Map(sheep.map((e) => [e.id, skills.sheepWool(bot, e)]));
    const score = {};
    for (const wool of fleece.values()) if (wool && !wool.sheared) score[wool.color] = (score[wool.color] || 0) + 1;
    for (const [name, n] of Object.entries(inventory)) {
      const color = name.endsWith('_wool') ? name.slice(0, -5) : null;
      if (color && color in score) score[color] += n * 2;
    }
    const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
    return {
      accept: (e) => !fleece.get(e.id)?.sheared,
      penalty: (e) => (best && fleece.get(e.id)?.color !== best ? 200 : 0),
    };
  }

  // Raiders (an outpost) seen near a spot: no house there.
  function nearDanger(p) {
    return (bot.companionDanger || []).some((d) => Math.hypot(d.x - p.x, d.z - p.z) < 80)
      || (memory.abandonedSites || []).some((a) => Math.hypot(a.x - p.x, a.z - p.z) <= 40);
  }

  function abandonSite(ctx, reason, counted = false) {
    const anchor = memory.house.anchor;
    if (ctx.adapt && !counted) {
      const p = ctx.adapt.plan('home_site', { position: memory.searchOrigin || anchor });
      ctx.adapt.outcome(p, { ok: false, reason });
    }
    ctx.record('site_abandoned', { anchor, reason, built: memory.houseBuilt || 0 });
    // Autonomous goals use the expiring, world-persistent rejected_site lesson.
    if (!ctx.adapt) memory.abandonedSites = [...(memory.abandonedSites || []), anchor].slice(-16);
    const movements = bot.pathfinder?.movements;
    if (movements && memory.protect) movements.exclusionAreasBreak = movements.exclusionAreasBreak.filter((f) => f !== memory.protect);
    if (bot.companionProtectBlock === memory.protectBlock) bot.companionProtectBlock = null;
    if (bot.companionHomeSite === memory.homeSite) bot.companionHomeSite = null;
    ctx.adapt?.teach('rejected_site', anchor, 'overworld', reason, 32);
    bot.companionChest = null;
    bot.companionSurfaceY = undefined;
    Object.assign(memory, {
      house: null, protect: null, homeSite: null, siteDigs: 0, houseBuilt: 0, houseBed: false,
      relocate: false, explore: {}, exploreStreak: 0, scaffoldActive: false, doorPlug: false,
      relocation: { anchor, attempt: 0 }, siteAccessFailures: 0,
      furnace: { item: null, input: 0, output: 0 }, validated: false,
    });
    for (const key of Object.keys(memory.verified)) memory.verified[key] = false;
    blacklist.clear();
    skipped.clear();
    reportedUpgradeBlocks.clear();
    return { ok: true, abandoned: true, progress: false };
  }

  async function exploreRelocation(ctx) {
    const r = memory.relocation;
    if (r.retryAt > Date.now()) return { ok: true, waited: true, reason: 'relocation_routes_exhausted', retryAt: r.retryAt };
    if (r.retryAt) { r.attempt = 0; r.retryAt = 0; }
    const up = await surfaceFirst(ctx);
    if (up) return up;
    const from = bot.entity.position.clone();
    const closest = (bot.companionDanger || []).filter((p) => Math.hypot(from.x - p.x, from.z - p.z) < 80)
      .sort((a, b) => from.distanceTo(a) - from.distanceTo(b))[0] || r.anchor;
    const outward = Math.atan2(from.z - closest.z, from.x - closest.x);
    const turns = [0, 1, -1, 2, -2, 3, -3, 4];
    const distance = r.attempt < turns.length ? 24 : 12;
    const angle = outward + turns[r.attempt % turns.length] * Math.PI / 4;
    const x = Math.round(from.x + Math.cos(angle) * distance);
    const z = Math.round(from.z + Math.sin(angle) * distance);
    ctx.record('recovery_switch', { task: 'homestead_site', to: 'outward_route', x, z, attempt: r.attempt + 1 });
    const route = new goals.GoalNearXZ(x, z, 3);
    const result = await actions.goTo(bot, ctx, route, { timeoutMs: 15000, retryNoProgress: false });
    if (result.reason === 'aborted' || ctx.signal?.aborted) return result;
    const moved = bot.entity.position.distanceTo(from);
    if (result.ok && moved >= 6 && route.isEnd(bot.entity.position.floored())) return { ok: true, moved };
    if (++r.attempt >= 2 * turns.length) r.retryAt = Date.now() + 10 * 60_000;
    return { ok: false, reason: result.ok ? 'relocation_not_arrived' : result.reason };
  }

  const nearbyWoolMobs = () => Object.values(bot.entities || {}).some((e) => e.position
    && e.position.distanceTo(bot.entity.position) <= 24 && !blacklist.has(`mob:${e.id}`)
    && ((e.name === 'sheep' && !skills.sheepWool?.(bot, e)?.sheared) || e.name === 'spider'));
  function wantsGuestBed(state) {
    if (!memory.established || state.isDay !== true || state.health < 16 || state.food < 12 || Date.now() < (memory.guestBedRetryAt || 0)) return false;
    const hs = houseState();
    if (hs.placed.guestBed !== false || hs.blocked.some((b) => b.item === 'guestBed')) return false;
    const spot = memory.house.furniture.guestBed.position;
    if (bot.entity.position.distanceTo(new Vec3(spot.x, spot.y, spot.z)) > 32) return false;
    return countKey('bed', state.inventory, kb) > 0 || countKey('wool', state.inventory, kb) >= 3
      || (state.inventory.white_wool || 0) + Math.floor((state.inventory.string || 0) / 4) >= 3 || nearbyWoolMobs();
  }

  function wantsPrimaryBed(state) {
    if (!autonomous || !memory.established || state.isDay !== true || state.health < 16 || state.food < 12
      || Date.now() < (memory.primaryBedRetryAt || 0)) return false;
    const hs = houseState();
    const bed = memory.house.furniture.bed;
    if (hs.placed.bed !== false || targetsFor(bot).excluded(placementTarget('bed', bed.position, { alsoClear: [bed.head] }))) return false;
    return countKey('bed', state.inventory, kb) > 0 || countKey('wool', state.inventory, kb) >= 3
      || (state.inventory.white_wool || 0) + Math.floor((state.inventory.string || 0) / 4) >= 3 || nearbyWoolMobs();
  }

  async function primaryBedStep(ctx, inventory, stations) {
    const f = memory.house.furniture.bed;
    if (targetsFor(bot, ctx).excluded(placementTarget('bed', f.position, { alsoClear: [f.head] }))) return null;
    if (countKey('bed', inventory, kb)) return placeRecorded(ctx, f.position, (n) => matches('bed', n), 'bed',
      { stand: f.stand, verify: () => matches('bed', nameAt(f.head)), alsoClear: [f.head] });
    const step = plan(ctx, { requirements: [{ key: 'bed', count: 1 }], inventory, stations });
    if (!step || step.kind === 'blocked') return null;
    if (!ctx.adapt || step.kind !== 'hunt' || step.key !== 'wool') return runPlannerStep(ctx, step, null);
    const area = { position: memory.house.anchor, target: 'primary' };
    const bedPlan = ctx.adapt.plan('bed', area);
    if (bedPlan.method === 'sheep' && !bedPlan.failures && ctx.adapt.avoids('no_sheep', area.position)) {
      ctx.adapt.promote('bed', area, 'spider_string', 'known_no_sheep');
    }
    const current = ctx.adapt.plan('bed', area);
    if (current.method === 'shelter_first') {
      if (memory.bedDeferral !== current.revision) {
        await ctx.adapt.run('bed', area, () => {
          ctx.record('adaptation_use', { task: 'bed', method: 'shelter_first', anchor: area.position });
          memory.bedDeferral = current.revision;
          return { ok: true, progress: false, reason: 'bed_deferred' };
        });
      }
      return null; // still craft/place it if materials later arrive naturally
    }
    return ctx.adapt.run('bed', area, async (method) => {
      if (method === 'sheep') {
        const result = await skills.huntOne(bot, ctx, { mobs: ['sheep'], dropMatch: kb.wool.match, blacklist, radius: 128,
          ...woolPreference(inventory) });
        if (result.reason === 'no_mob_in_range') ctx.adapt.teach('no_sheep', area.position, 'overworld', result.reason, 128);
        return result.ok && !result.gained ? { ok: false, reason: 'no_wool_collected' } : result;
      }
      const result = await skills.huntOne(bot, ctx, { mobs: ['spider'], dropMatch: kb.string.match, blacklist, radius: 48 });
      return result.ok && !result.gained ? { ok: false, reason: 'no_string_collected' } : result;
    });
  }

  function primaryBedGoal() {
    let done = false;
    return {
      name: 'primary_bed', isDone: () => done || houseState().placed.bed === true, progress: () => 0,
      async run(ctx) {
        const hs = houseState();
        const result = await primaryBedStep(ctx, ctx.perceive().inventory, { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace });
        if (result && result.ok) return result;
        done = true;
        memory.primaryBedRetryAt = Date.now() + 5 * 60_000;
        return result || { ok: true, progress: false };
      },
    };
  }

  function guestBedGoal() {
    let done = false, steps = 0;
    return {
      name: 'guest_bed',
      isDone: () => done || houseState().placed.guestBed === true,
      progress: () => steps,
      async run(ctx) {
        const state = ctx.perceive();
        if (wantsGuestBed(state) && steps < 12) {
          const bed = memory.house.furniture.guestBed;
          const inventory = state.inventory;
          let result;
          if (countKey('bed', inventory, kb)) {
            result = await placeRecorded(ctx, bed.position, (n) => matches('bed', n), 'guestBed',
              { stand: bed.stand, verify: () => matches('bed', nameAt(bed.head)), alsoClear: [bed.head], requireAir: true });
          } else {
            const step = plan(ctx, { requirements: [{ key: 'bed', count: 1 }], inventory, stations: { crafting_table: true } });
            if (step?.kind === 'hunt') {
              const hunt = (mobs, match, options) => skills.huntOne(bot, ctx, { mobs, dropMatch: match, blacklist, radius: 24, ...options });
              result = await runPlanned(ctx, step, async () => {
                const sheep = await hunt(['sheep'], kb.wool.match, woolPreference(inventory));
                return sheep.reason === 'no_mob_in_range' ? hunt(['spider'], kb.string.match) : sheep;
              });
            } else if (step && step.kind !== 'gather') result = await runPlannerStep(ctx, step, null);
          }
          if (result?.ok && !result.waited) { steps += 1; return result; }
          if (result?.sourceHandled && !result.targetExcluded) return result;
        }
        memory.guestBedRetryAt = Date.now() + 5 * 60_000;
        done = true;
        return { ok: true, skipped: 'guest_bed_optional' };
      },
    };
  }

  function wantsLighting(state) {
    if (!memory.established || !state.isDay || state.health < 16 || state.food < 12) return false;
    const { x, y, z } = memory.house.anchor;
    if (bot.entity.position.distanceTo(new Vec3(x, y, z)) > 16) return false;
    const bag = state.inventory;
    return houseState().torches.length > 0 && ((bag.torch || 0) > 0
      || ((bag.coal || 0) + (bag.charcoal || 0) > 0 && (bag.stick || 0) > 0));
  }

  function lightingGoal() {
    return {
      name: 'home_lighting',
      isDone: (state) => !wantsLighting(state),
      progress: () => memory.house.furniture.torches.length - houseState().torches.length,
      async run(ctx) {
        const hs = houseState(ctx);
        const state = ctx.perceive();
        const torch = hs.torches[0];
        if (!torch) return { ok: true };
        if ((state.inventory.torch || 0) > 0) {
          return placeRecorded(ctx, torch, (n) => n === 'torch', 'torch', { faces: DOWN, requireAir: true, passable: true });
        }
        const step = plan(ctx, { requirements: [{ key: 'torch', count: 1 }], inventory: state.inventory, stations: {} });
        return step?.kind === 'craft' && step.key === 'torch'
          ? runPlannerStep(ctx, step, null) : { ok: true, waited: true, reason: 'lighting_materials_unavailable' };
      },
    };
  }

  function nearHouseTable() {
    const spot = memory.house?.furniture.crafting_table.position;
    return Boolean(spot) && nameAt(spot) === 'crafting_table'
      && bot.entity.position.distanceTo(new Vec3(spot.x + 0.5, spot.y, spot.z + 0.5)) <= 6;
  }

  async function placePortableTable(ctx) {
    const here = bot.entity.position.floored();
    for (let r = 1; r <= 3; r += 1) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        for (const dy of [0, 1, -1]) {
          const p = here.offset(dx, dy, dz);
          if (nameAt(p) !== 'air' && nameAt(p) !== 'cave_air') continue;
          if (blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block' || nearHouseColumn(p)) continue;
          const placed = await skills.placeAt(bot, ctx, p, (n) => n === 'crafting_table', { faces: DOWN });
          if (placed.reason === 'cell_occupied_by_entity') continue;
          if (placed.ok) ctx.record('portable_table', { action: 'place', position: posKey(p) });
          return placed.ok ? { ok: true, position: { x: p.x, y: p.y, z: p.z } } : placed;
        }
      }
    }
    return { ok: false, reason: 'no_table_spot' };
  }

  async function pickUpTable(ctx, position) {
    const block = blockAt(position);
    if (block?.name !== 'crafting_table') return;
    try {
      const dug = await actions.digBlock(bot, ctx, block);
      if (dug.ok) await actions.collectDrops(bot, ctx, new Vec3(position.x, position.y, position.z),
        (n) => n === 'crafting_table', { radius: 4, timeoutMs: 5000 });
      ctx.record('portable_table', { action: 'pick_up', ok: dug.ok });
    } catch (error) {
      // Interrupted (a fight, a cancel): the table stays; another is cheap.
      if (!ctx.signal?.aborted) throw error;
    }
  }

  async function surfaceFirst(ctx) {
    if (typeof actions.surface !== 'function' || blacklist.has('surface')) return null;
    const result = await actions.surface(bot, ctx);
    if (result) ctx.record('surface', { ok: result.ok });
    // A climb that failed should not hold up every other step: carry on
    // where the bot is and try again later.
    if (result && !result.ok && !result.adaptationSwitched) blacklist.add('surface', result.reason, 60000);
    return result;
  }

  async function placeCompactRoof(ctx, position, match, options) {
    const [base, upper] = memory.house.scaffold;
    const peak = new Vec3(upper.x, upper.y + 1, upper.z);
    const centreTile = position.x === peak.x && position.z === peak.z;
    const pillarUp = require('../end').pillarUp;
    const stop = () => {
      const p = bot.entity.position.floored();
      return p.x !== peak.x || p.z !== peak.z || bot.companionPlayerBlock?.(upper) || bot.companionPlayerBlock?.(peak);
    };
    if (centreTile && bot.entity.position.y < peak.y + 0.9) {
      const feet = nameAt(upper) && FILLERS.has(nameAt(upper)) ? peak : peak.offset(0, -1, 0);
      const onStep = new goals.GoalBlock(feet.x, feet.y, feet.z);
      if (!FILLERS.has(nameAt(base)) || bot.companionPlayerBlock?.(upper) || bot.companionPlayerBlock?.(peak)) {
        return { ok: false, reason: 'roof_step_unavailable' };
      }
      if (!onStep.isEnd(bot.entity.position.floored())) {
        const moved = await actions.goTo(bot, ctx, onStep, { timeoutMs: 10000, retryNoProgress: false });
        if (!moved.ok) {
          ctx.record('roof_step_failed', { reason: moved.reason, at: posKey(bot.entity.position.floored()), target: posKey(feet) });
          return moved;
        }
      }
      if (feet.y < peak.y) {
        if (!/^(air|cave_air)$/.test(nameAt(upper) || '') || bot.inventory.items().every((item) => !FILLERS.has(item.name))) {
          return { ok: false, reason: 'roof_step_needs_filler' };
        }
        await actions.recentre(bot, ctx);
        await pillarUp(bot, ctx, peak.y, { maxSteps: 2, blocks: { test: (name) => FILLERS.has(name) }, stop });
        if (!FILLERS.has(nameAt(upper)) || bot.entity.position.y < peak.y - 0.1) return { ok: false, reason: 'roof_step_unconfirmed' };
      }
      // The centre is a permanent tile at the top of the temporary step.
      // Work from above its plane rather than losing sight of the remaining
      // wall tops behind adjacent finished roof blocks.
      await pillarUp(bot, ctx, peak.y + 1, { maxSteps: 2, blocks: { test: match }, stop });
      const placed = match(nameAt(peak)) && bot.entity.position.y >= peak.y + 0.9;
      ctx.record('roof_work_step', { at: posKey(bot.entity.position.floored()), position: posKey(position), ok: placed });
      return placed ? { ok: true } : { ok: false, reason: 'roof_step_unconfirmed' };
    }
    const placed = await skills.placeAt(bot, ctx, position, match, options);
    if (placed.ok || centreTile || !['not_arrived', 'NoPath', 'Timeout', 'no_progress'].includes(placed.reason)) return placed;
    if (bot.entity.position.y < peak.y + 0.9) return placed;
    // An occluded corner may be visible from another roof panel after the
    // inner tiles connect the deck. Move on the finished panels, not off it.
    const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => new Vec3(position.x + dx, position.y, position.z + dz))
      .filter((p) => matches('planks', nameAt(p))).sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    for (const panel of adjacent.slice(0, 2)) {
      const stand = panel.offset(0, 1, 0);
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 5000, retryNoProgress: false });
      if (!moved.ok) continue;
      const retry = await skills.placeAt(bot, ctx, position, match, options);
      if (retry.ok) return retry;
    }
    return placed;
  }

  async function placeRecorded(ctx, position, match, what, options = {}) {
    const up = await surfaceFirst(ctx);
    if (up) return up;
    const place = async (p = position, opts = options) => {
      if ([p, ...(opts.alsoClear || [])].some(q => bot.companionPlayerBlock?.(q) && !match(nameAt(q)))) {
        return { ok: false, reason: 'protected_player_block' };
      }
      ctx.record('build', { what, position: posKey(p) });
      // A distant hunt/mining trip needs one long walk before local placement.
      if (bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y, p.z + 0.5)) > 12) {
        ctx.record('return_home', { for: what });
        const back = await actions.goNear(bot, ctx, new Vec3(p.x, p.y, p.z), 4, { timeoutMs: 90000 });
        if (!back.ok) return back;
      }
      return what === 'roof' && memory.house.variant === 'compact' && !memory.established
        ? placeCompactRoof(ctx, p, match, opts)
        : skills.placeAt(bot, ctx, p, match, opts);
    };
    const groundAir = (q) => air(nameAt(q)) && blockAt(below(q))?.boundingBox === 'block' && !bot.companionPlayerBlock?.(q);
    const result = await targetsFor(bot, ctx).run(placementTarget(what, position, options), () => place(), async (reason) => {
      if (optionalStep(what)) {
        const conflicts = [position, ...(options.alsoClear || [])].filter(q => !air(nameAt(q)));
        const safe = (q) => !bot.companionPlayerBlock?.(q) && !bot.companionProtectBlock?.(blockAt(q))
          && canClearTerrain((x, y, z) => bot.blockAt(new Vec3(x, y, z)), q);
        if (conflicts.length && conflicts.every(safe)) {
          for (const q of conflicts) {
            const cleared = await clearTerrain(bot, ctx, actions, q);
            if (!cleared.ok) return cleared;
          }
          return place();
        }
        if (what === 'torch') {
          const alternate = torchAlternates(position).find(groundAir);
          if (alternate) return place(alternate);
        } else {
          const bed = guestAlternates().find(b => [b.position, b.head, b.stand].every(groundAir) && air(nameAt(top(b.stand))));
          if (bed) {
            const moved = await place(bed.position, { ...options, stand: bed.stand, alsoClear: [bed.head], verify: () => match(nameAt(bed.head)) });
            if (moved.ok) memory.house.furniture.guestBed = bed;
            return moved;
          }
        }
      }
      if (['occupied', 'protected_player_block', 'no_support'].includes(reason)) return { ok: false, reason };
      const walked = await alternateStand(bot, ctx, actions, options.stand || position,
        { avoid: q => optionalStep(what) && idAt(memory.house.furniture.torches, q) });
      return walked.ok ? place() : { ok: false, reason };
    });
    if (optionalStep(what) && result.targetExcluded && result.reason !== 'target_excluded') {
      ctx.record('home_upgrade_blocked', { item: what, position: posKey(position), reason: result.reason, retryAt: result.retryAt });
    }
    // The functional house may now finish as soon as this door is placed.
    if (what === 'door' && result.ok && !result.already && ctx.perceive().isDay === true) await setDoor(ctx, true);
    if (ctx.adapt && !memory.pinned && !memory.established && result.ok && !result.already && memory.searchOrigin) {
      ctx.adapt.outcome(ctx.adapt.plan('home_site', { position: memory.searchOrigin }), result);
    }
    // A mob in the way moves on quickly; other failures wait a little longer.
    if (!result.ok) blacklist.add(`build:${posKey(position)}`, result.reason, result.reason === 'cell_occupied_by_entity' ? 4000 : 15000);
    if (ctx.adapt && !memory.pinned && !memory.established && !result.ok && memory.searchOrigin
      && ['place_unconfirmed', 'not_arrived', 'NoPath', 'no_support'].includes(result.reason)
      && (memory.houseBuilt || 0) < memory.house.blocks.length * 0.75) {
      const route = ctx.adapt.plan('home_site', { position: memory.searchOrigin });
      const outcome = ctx.adapt.outcome(route, result);
      if (outcome.adaptationSwitched) return abandonSite(ctx, result.reason, true);
      return outcome;
    }
    return result;
  }

  // The door stays open by day so paths walk straight through (the
  // pathfinder's own door opening is unreliable), and is shut at night once
  // the bot is inside.
  function doorOpen() {
    const door = blockAt(memory.house.furniture.door.position);
    if (!door || !matches('door', door.name) || typeof door.getProperties !== 'function') return null;
    const open = door.getProperties().open;
    return open === true || open === 'true';
  }

  function insideRoom(p) {
    const a = memory.house.anchor;
    const end = memory.house.size - 1;
    return p.x >= a.x + 1 && p.x < a.x + end && p.z >= a.z + 1 && p.z < a.z + end && Math.abs(p.y - a.y) < 2;
  }

  async function setDoor(ctx, open) {
    const state = doorOpen();
    if (state === null || state === open) return null;
    const position = memory.house.furniture.door.position;
    const door = blockAt(position);
    if (!actions.withinReach(bot, door.position)) {
      const moved = await actions.goNear(bot, ctx, door.position, 2, { timeoutMs: 30000 });
      if (!moved.ok && !actions.withinReach(bot, door.position)) return moved;
    }
    ctx.record('door', { open });
    try { await bot.activateBlock(blockAt(position)); } catch { /* checked below */ }
    const done = await waitUntil(() => doorOpen() === open, { timeoutMs: 1500, signal: ctx.signal });
    return done ? { ok: true } : { ok: false, reason: 'door_unchanged' };
  }

  async function nightStep(ctx, hs, state) {
    const house = memory.house;
    if (memory.bunker) {
      bot.companionSheltered = true;
      await sleep(3000, ctx.signal);
      return { ok: true, waited: true, reason: 'sheltering_until_daylight' };
    }
    // Walls and roof are enough to spend the night in: without a door yet, the doorway gets plugged.
    const shellDone = !hs.missing.length;
    // A bed still in the bag goes down at its spot before dark.
    if (!hs.placed.bed && countKey('bed', state.inventory, kb) > 0 && !blacklist.has('night:bed')) {
      const f = house.furniture;
      const placed = await placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
        { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)) });
      if (!placed.ok) blacklist.add('night:bed', placed.reason, 60000);
      return placed;
    }
    // Already dark and far from home: the walk back is where nights kill.
    // Dig in where the bot is instead.
    const homeDistance = bot.entity.position.distanceTo(new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5));
    const strandedFar = state.timeOfDay >= 12542 && homeDistance > 64;
    if (hs.placed.bed && !memory.bedRefusedAt && !strandedFar) {
      const available = bedKeys.filter((id) => hs.placed[id] && ![house.furniture[id].position, house.furniture[id].head]
        .some((p) => String(blockAt(p)?.getProperties?.().occupied) === 'true'));
      for (const id of available) {
        const bed = house.furniture[id].position;
        const centre = new Vec3(bed.x + 0.5, bed.y, bed.z + 0.5);
        if (bot.entity.position.distanceTo(centre) > 4) {
          ctx.record('night', { action: 'go_home' });
          return actions.goNear(bot, ctx, centre, 2, { timeoutMs: 60000 });
        }
        if (state.timeOfDay < 12542) {
          await sleep(2000, ctx.signal);
          return { ok: true, waited: true, reason: 'waiting_for_sleep_time' };
        }
        ctx.record('night', { action: 'sleep', bed: id });
        const slept = await skills.useBed(bot, ctx, { position: bed });
        if (slept.ok) { memory.verified[id] = true; return slept; }
      }
      // Monsters too close to sleep: do not keep trying all night.
      if (!shellDone && available.length) memory.bedRefusedAt = Date.now();
    }
    if (shellDone && !strandedFar) {
      const centre = new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5);
      if (bot.entity.position.distanceTo(centre) > 2) {
        ctx.record('night', { action: 'shelter' });
        return actions.goNear(bot, ctx, centre, 1, { timeoutMs: 40000 });
      }
      if (insideRoom(bot.entity.position.floored())) {
        if (hs.placed.door) {
          const shut = await setDoor(ctx, false);
          if (shut) return shut;
        } else {
          const door = house.furniture.door;
          const open = [door.position, door.upper].find((p) => blockAt(p)?.boundingBox !== 'block');
          if (open && Object.keys(state.inventory).some((n) => FILLERS.has(n)) && !blacklist.has('plug')) {
            memory.doorPlug = true;
            ctx.record('night', { action: 'plug_doorway' });
            const plugged = await skills.placeAt(bot, ctx, open, (n) => FILLERS.has(n));
            if (!plugged.ok) blacklist.add('plug', plugged.reason, 20000);
            return plugged;
          }
        }
      }
      bot.companionSheltered = true;
      await sleep(3000, ctx.signal);
      return { ok: true, waited: true, reason: 'sheltering_until_daylight' };
    }
    if (state.timeOfDay < 12542) return null; // still light enough to keep working
    if (blacklist.has('bunker')) return null;
    ctx.record('night', { action: 'dig_in' });
    const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => FILLERS.has(n), avoid: nearHouseColumn });
    if (dug.ok) {
      ctx.record('night', { action: 'dug_in' });
      memory.bunker = dug.bunker; bot.companionSheltered = true;
    }
    // Nowhere to dig in (sand, water): keep working through the night instead of retrying.
    else if (['no_bunker_spot', 'no_seal_block'].includes(dug.reason)) blacklist.add('bunker', dug.reason, 60000);
    return dug;
  }

  async function verifyStep(ctx, hs) {
    const f = memory.house.furniture;
    if (!memory.verified.chest) {
      const store = STORABLE.find((n) => (ctx.perceive().inventory[n] || 0) > 0);
      ctx.record('verify', { furniture: 'chest', item: store || null });
      const result = await skills.useChest(bot, ctx, { position: f.chest.position,
        itemMatch: (n) => (store ? n === store : !n.endsWith('_sword') && !n.endsWith('_pickaxe') && n !== 'shield') });
      if (result.ok) memory.verified.chest = true;
      return result;
    }
    for (const id of ['bed']) {
      if (memory.verified[id] || !hs.placed[id]) continue;
      ctx.record('verify', { furniture: id });
      const result = await skills.useBed(bot, ctx, { position: f[id].position });
      if (result.ok || result.spawnSet) {
        memory.verified[id] = true;
      }
      if (result.spawnSet && !result.ok) return { ok: true, spawnSet: true };
      return result;
    }
    if (!memory.verified.crafting_table) {
      ctx.record('verify', { furniture: 'crafting_table' });
      const result = await skills.craft(bot, ctx, { item: 'stick', times: 1, tablePosition: f.crafting_table.position });
      if (result.ok && result.usedTable) memory.verified.crafting_table = true;
      return result;
    }
    if (!memory.verified.furnace) {
      ctx.record('verify', { furniture: 'furnace' });
      const inventory = { ...ctx.perceive().inventory, charcoal: 0 };
      return runPlannerStep(ctx, plan(ctx, { requirements: [{ key: 'charcoal', count: 1 }], inventory,
        stations: { crafting_table: true, furnace: true } }), null);
    }
    return null;
  }

  return {
    name: 'homestead',
    noProgressLimit: 40,
    // Start the route budget over without forgetting concrete exclusions.
    maxRecoveries: 6,
    recover() {
      blacklist.clear();
      skipped.clear();
      memory.recovery = true;
      // A fresh round of exploring for a site: the count is kept across asks
      // (one house per run), and once past its limit every later ask of the
      // house failed at once with exhausted:site.
      memory.exploreStreak = 0;
    },
    memory,
    status,
    maintenance,
    protects,
    wantsGuestBed,
    guestBedGoal,
    wantsLighting,
    lightingGoal,
    wantsPrimaryBed,
    primaryBedGoal,
    isInside: () => Boolean(memory.established && insideRoom(bot.entity.position.floored())),
    shelterDoor: (ctx, open) => {
      if (!memory.established || !insideRoom(bot.entity.position.floored())) return null;
      return doorOpen() === open ? { ok: true, already: true } : setDoor(ctx, open);
    },
    isDone: (state) => complete(state),
    optionalMaintenance: !autonomous,
    progress: () => memory.steps,
    async run(ctx) {
      if (memory.recovery) {
        memory.recovery = false;
        ctx.record('recovery', { at: bot.entity.position.floored() });
        await actions.unstick(bot, ctx);
        const entrance = memory.house?.entrance;
        if (entrance && bot.entity.position.distanceTo(new Vec3(entrance.x, entrance.y, entrance.z)) > 16) {
          return actions.goNear(bot, ctx, new Vec3(entrance.x, entrance.y, entrance.z), 3, { timeoutMs: 120000 });
        }
        return { ok: true };
      }
      const result = await runOnce(ctx);
      // Waiting (for dusk, out the night) is not progress: counting it would
      // refill the stall budget of a step that keeps failing every morning.
      if (result.ok && !result.waited) {
        memory.steps += 1;
        if (!result.moved) memory.exploreStreak = 0;
      }
      return result;
    },
  };

  async function runOnce(ctx) {
    const state = ctx.perceive();
    if (ctx.adapt && !memory.pinned && !memory.established && memory.house && !memory.searchOrigin) {
      const { x, y, z } = memory.house.anchor;
      memory.searchOrigin = new Vec3(x, y, z);
    }
    if (memory.relocate && memory.house && !memory.pinned && !memory.established) return abandonSite(ctx, 'repeated_nearby_deaths');
    if (!memory.house) {
      if (memory.bunker && state.isDay !== false) {
        const out = await skills.digOut(bot, ctx, memory.bunker);
        if (out.ok) {
          ctx.record('night', { action: 'dug_out' });
          memory.bunker = null; bot.companionSheltered = false;
        }
        return out;
      }
      if (state.isDay === false) {
        const top = memory.bunker?.top;
        if (top && Math.hypot(state.position.x - top.x, state.position.z - top.z) < 2) {
          await sleep(3000, ctx.signal);
          return { ok: true, waited: true, reason: 'sheltering_until_daylight' };
        }
        memory.bunker = null;
        if (blacklist.has('early_bunker')) {
          await sleep(3000, ctx.signal);
          return { ok: true, waited: true, reason: 'waiting_for_safe_daylight' };
        }
        const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => FILLERS.has(n) });
        if (dug.ok) {
          ctx.record('night', { action: 'dug_in' });
          memory.bunker = dug.bunker; bot.companionSheltered = true;
        }
        else blacklist.add('early_bunker', dug.reason, 60_000);
        return dug;
      }
      const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
      const options = { avoid: (p) => nearDanger(p) || ctx.adapt?.avoids('rejected_site', p) || bot.companionNearPlayerBuild?.(p),
        protectedCell: (p) => bot.companionPlayerBlock?.(p) };
      if (ctx.adapt && !memory.pinned) {
        const origin = (memory.searchOrigin ||= bot.entity.position.clone());
        return ctx.adapt.run('home_site', { position: origin }, async (method) => {
          if (method === 'relocate' || method === 'move_to_fresh_area') {
            const up = await surfaceFirst(ctx);
            if (up) return up;
            const route = (memory.homesteadRoute ||= {});
            if (route.method !== method) {
              route.heading = method === 'move_to_fresh_area' ? 2 : 0;
              route.method = method;
            }
            const moved = await outwardLeg(bot, ctx, actions, route, origin, { distance: method === 'relocate' ? 28 : 40 });
            if (moved.ok && Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) >= 200) {
              memory.searchOrigin = null;
              memory.homesteadRoute = {};
              memory.relocation = null;
            }
            return moved;
          }
          const site = method === 'hillside' ? chooseHillside(read, state.position, options)
            : chooseSite(read, state.position, { ...options, variant: method === 'compact' ? 'compact' : 'starter',
              maxWork: method === 'near_flat' ? 12 : 32 });
          if (!site) return { ok: false, reason: 'no_suitable_site' };
          memory.house = createStarterHouse(site.anchor, site);
          memory.relocation = null;
          ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs, method, variant: site.variant });
          return { ok: true, progress: false };
        });
      }
      const site = chooseSite(read, near || state.position, options);
      if (!site) return memory.relocation ? exploreRelocation(ctx) : explore(ctx, 'site');
      memory.house = createStarterHouse(site.anchor);
      memory.relocation = null;
      ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs });
      return { ok: true };
    }
    // Respawned far away from a site that barely stands and has no bed yet:
    // starting over here is cheaper than the long walk back.
    {
      const a = memory.house.anchor;
      const far = Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z) > 150;
      if (!memory.established && !memory.pinned && (far || nearDanger(a)) && !memory.houseBed && (memory.houseBuilt || 0) < memory.house.blocks.length * 0.3) {
        return abandonSite(ctx, far ? 'far' : 'raiders');
      }
    }
    // Unloaded chunks read as missing blocks; go home before judging the house.
    if ([...memory.house.clearance, ...workSite().foundation].some((p) => !blockAt(p))) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(memory.house.entrance.x, memory.house.entrance.y, memory.house.entrance.z), 3,
        { timeoutMs: 60000 });
    }
    protectSite();
    {
      const hs0 = houseState();
      // The roof rests on faces above eye level from the floor, so the step
      // stands once the walls are up and until the roof is done.
      const dy = (b) => b.position.y - memory.house.anchor.y;
      // Once up it stays until the whole shell stands, even if a lower block
      // has to be put back meanwhile; otherwise it is torn down and rebuilt.
      const lowerRowsDone = !hs0.missing.some((b) => b.phase === 'walls' && dy(b) < 2);
      memory.scaffoldActive = (memory.scaffoldActive || lowerRowsDone) && hs0.missing.length > 0;
    }
    const site = await siteStep(ctx);
    if (site) return site;

    const hs = houseState(ctx);
    const blockedNow = new Set();
    for (const conflict of hs.blocked) {
      const position = posKey(conflict.position);
      blockedNow.add(position);
      if (reportedUpgradeBlocks.get(position) !== conflict.reason) ctx.record('home_upgrade_blocked', { ...conflict, position });
      reportedUpgradeBlocks.set(position, conflict.reason);
    }
    for (const position of reportedUpgradeBlocks.keys()) if (!blockedNow.has(position)) reportedUpgradeBlocks.delete(position);
    memory.houseBuilt = memory.house.blocks.length - hs.missing.length;
    memory.houseBed = hs.placed.bed;
    // A full bag is emptied into the house chest rather than onto the ground.
    bot.companionChest = hs.placed.chest ? memory.house.furniture.chest.position : null;
    const inventory = plannerInventory(state);
    const stations = { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace };
    // Evenings: home before dark, into bed at dusk, else a sealed bunker.
    const evening = Number.isFinite(state.timeOfDay) && state.timeOfDay >= 11800 && state.timeOfDay < 23400;
    if (!evening) { memory.bedRefusedAt = null; memory.doorPlug = false; }
    bot.companionSheltered = false;
    // After a death the bot is no longer in its bunker: forget it.
    if (memory.bunker) {
      const top = memory.bunker.top;
      const at = bot.entity.position;
      if (Math.hypot(at.x - (top.x + 0.5), at.z - (top.z + 0.5)) > 1.5 || at.y > top.y + 0.5 || at.y < top.y - 5) memory.bunker = null;
    }
    if (memory.bunker && !evening) {
      ctx.record('night', { action: 'dig_out' });
      const out = await skills.digOut(bot, ctx, memory.bunker);
      if (out.ok) { ctx.record('night', { action: 'dug_out' }); memory.bunker = null; }
      return out;
    }
    // No shell to sleep in yet and out searching: back on the site's own
    // ground before dusk, rather than dig in on whatever rock the search
    // ended on (bare stone without a pickaxe gives no block to seal with).
    if (!evening && state.timeOfDay >= 10800 && hs.missing.length && !blacklist.has('dusk_home')) {
      const e = memory.house.entrance;
      if (bot.entity.position.distanceTo(new Vec3(e.x, e.y, e.z)) > 48) {
        ctx.record('night', { action: 'dusk_home' });
        const back = await actions.goNear(bot, ctx, new Vec3(e.x, e.y, e.z), 3, { timeoutMs: 90000 });
        if (!back.ok) blacklist.add('dusk_home', back.reason, 120000);
        return back;
      }
    }
    if (evening) {
      const night = await nightStep(ctx, hs, state);
      if (night) return night;
    } else if (hs.placed.door && doorOpen() === false && !blacklist.has('door')) {
      const opened = await setDoor(ctx, true);
      if (opened && !opened.ok) blacklist.add('door', opened.reason, 30000);
      if (opened) return opened;
    }
    // Stone tools first, then a few pieces of food so lost health can be eaten back.
    const early = gear.filter((key) => EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    // A spare table in the bag, once the house has its own: four planks spare
    // every climb out of a quarry to craft a tool.
    // Not while it is set aside as unavailable (no tree in reach): re-added at
    // once, it was "skipped" twice a second for good.
    if (hs.placed.crafting_table && !skipped.has('crafting_table')) early.unshift({ key: 'crafting_table', count: 1, optional: true });
    if (!autonomous && !skipped.has('food')) early.push({ key: 'food', count: 4, optional: true });
    if (!hs.placed.door && hs.placed.crafting_table && !countKey('door', inventory, kb)) {
      const door = plan(ctx, { requirements: [{ key: 'door', count: 1 }], inventory, stations });
      if (door?.kind === 'craft' && door.key === 'door') return runPlannerStep(ctx, door, null);
    }
    const earlyStep = plan(ctx, { requirements: early, inventory, stations });
    if (earlyStep?.kind !== 'blocked' && earlyStep) return runPlannerStep(ctx, earlyStep, early.find((r) => r.key === earlyStep.for));
    // Raw meat is worth two to three times as much cooked: once the furnace
    // stands, a few pieces in the bag go into it before anything else.
    if (hs.placed.furnace) {
      const raw = RAW_MEATS.map((name) => [name, state.inventory[name] || 0]).sort((x, y) => y[1] - x[1])[0];
      const fuel = Object.keys(state.inventory).some((n) => n === 'coal' || n === 'charcoal' || kb.planks.match(n) || kb.log.match(n));
      if (raw[1] >= 3 && fuel && !blacklist.has('cook')) {
        ctx.record('cook', { item: raw[0], count: raw[1] });
        const cooked = await skills.smelt(bot, ctx, { input: raw[0], count: Math.min(raw[1], 8),
          furnacePosition: memory.house.furniture.furnace.position, memory: memory.furnace });
        memory.furnace.item = raw[0];
        if (cooked.ok) memory.verified.furnace = true;
        else blacklist.add('cook', cooked.reason, 120000);
        return cooked;
      }
    }
    // Animals close by are food in the bag for later: on mountains and in
    // forests the next one may be a long, failing chase away once hunger hits.
    if (!autonomous && !evening && state.health >= 12 && countKey('food', state.inventory, kb) < 10 && !blacklist.has('stockpile')) {
      const animals = Object.values(bot.entities || {}).some((e) => FOOD_MOBS.has(e.name) && e.position
        && e.position.distanceTo(bot.entity.position) <= 16 && !blacklist.has(`mob:${e.id}`));
      if (animals) {
        ctx.record('stockpile_food', {});
        const hunted = await skills.huntOne(bot, ctx, { mobs: [...FOOD_MOBS], dropMatch: kb.food.match, blacklist, radius: 16 });
        if (!hunted.ok) blacklist.add('stockpile', hunted.reason, 60000);
        return hunted;
      }
    }
    // Then the bed, placed at its spot in the future house: from the first
    // night on, the bot sleeps through the dark and respawns at home.
    if (autonomous && !hs.placed.bed && hs.placed.crafting_table && (state.isDay !== false || countKey('bed', state.inventory, kb))) {
      const bed = await primaryBedStep(ctx, inventory, stations);
      if (bed?.ok && !bed.waited) return bed;
    }
    if (!autonomous && !hs.placed.bed && !skipped.has('wool') && !blacklist.has('early_bed')) {
      if (countKey('bed', state.inventory, kb) > 0) {
        const f = memory.house.furniture;
        const placed = await placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
          { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)), alsoClear: [f.bed.head] });
        // An animal in the way or uneven ground: build on and come back to it.
        if (!placed.ok) blacklist.add('early_bed', placed.reason, 120000);
        return placed;
      }
      const bedReq = [{ key: 'bed', count: 1, optional: true }];
      const bedStep = plan(ctx, { requirements: bedReq, inventory, stations });
      if (bedStep && bedStep.kind !== 'blocked') {
        // Wool needs sheep; if none can be found, build on and try again later.
        const result = await runPlannerStep(ctx, bedStep, bedStep.key === 'wool' ? { key: 'wool', optional: true } : null);
        return result;
      }
    }
    // Then the house: build whatever a full batch of carried material allows.
    const ready = await buildStep(ctx, hs, state.inventory, { whenBatchReady: true });
    if (ready) return ready;
    const reqs = requirements(state, hs);
    const step = plan(ctx, { requirements: reqs, inventory, stations });
    if (step && step.kind !== 'blocked') return runPlannerStep(ctx, step, reqs.find((r) => r.key === step.for));
    const build = await buildStep(ctx, hs, state.inventory, { whenBatchReady: false });
    if (build) return build;
    if (step || earlyStep) return runPlannerStep(ctx, step || earlyStep, null);
    // Furniture is only tried out once the whole house stands.
    if (buildTasks(hs).length) return { ok: false, reason: 'build_blocked' };
    // Iron gear once the house is up.
    const late = gear.filter((key) => !EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    const lateStep = plan(ctx, { requirements: late, inventory, stations });
    if (lateStep) return runPlannerStep(ctx, lateStep, null);
    const verify = await verifyStep(ctx, hs);
    if (verify) return verify;
    return { ok: true, idle: true };
  }
}

module.exports = { createHomesteadGoal, DEFAULT_GEAR };
