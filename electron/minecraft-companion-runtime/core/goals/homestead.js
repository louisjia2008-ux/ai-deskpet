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
const { chooseSite, chooseHillside, evaluateSite, safeCaveDig, canClearTerrain, isSoft, siteWork } = require('../site');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep, waitUntil } = require('../confirm');
const { runPlanned } = require('./common');
const { outwardLeg, gatherWood, OUTWARD_HEADINGS } = require('../adaptation-strategies');
const { alternateStand, clearTerrain } = require('../target-recovery');
const { topology, safeStand, isBed, clear, supports, SIDES } = require('../home-topology');
const { dryComponent, drySiteAccess } = require('../dry-route');
const { isAir: air, naturalCover } = require('../natural-cover');

const DEFAULT_GEAR = ['stone_sword', 'stone_tier_pickaxe', 'iron_sword', 'iron_pickaxe', 'shield'];
// Stone tools come before the house. Iron needs useful crafting and smelting stations.
const EARLY_GEAR = new Set(['stone_sword', 'stone_tier_pickaxe', 'pickaxe', 'wooden_pickaxe']);
const DOWN = [new Vec3(0, -1, 0)];
const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const FILLERS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const BATCH = 16;
const SITE_METHODS = ['near_flat', 'more_earthwork', 'compact', 'hillside'];
const SCOUT_RADIUS = 12;
const SCOUT_SPACING = 24;
const RAW_MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'];
const STORABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stick', 'rotten_flesh', 'feather', 'leather'];
const ROOF_MATERIALS = ['roof_cobblestone', 'roof_cobbled_deepslate', 'dirt', 'sandstone', 'red_sandstone'];

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
    owned: {},
    temporary: {},
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const skipped = createBlacklist({ ttlMs: 300000 });
  const reportedUpgradeBlocks = new Map();
  let lastSiteScout = null;

  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const v = (p) => new Vec3(p.x, p.y, p.z);
  const matches = (family, name) => Boolean(name) && kb[family].match(name);
  const roofMaterial = b => b.phase === 'roof' && b.family === 'planks' ? memory.roofMaterial || b.family : b.family;
  const roofFallbackMatches = name => matches('cave_wall', name) || ['coarse_dirt', 'red_sandstone'].includes(name);
  const matchesBuilding = (b, name) => matches(b.family, name)
    || (roofMaterial(b) !== b.family && roofFallbackMatches(name));

  const bedKeys = ['bed', 'guestBed'];
  const workSite = () => memory.established ? memory.house
    : { ...memory.house, foundation: [...memory.house.foundation, ...memory.house.torchSupports] };
  const idAt = (list, p) => list.some(q => posKey(q) === posKey(p));
  const below = (p) => ({ ...p, y: p.y - 1 });
  const top = (p) => ({ ...p, y: p.y + 1 });
  const room = (opts) => topology(memory.house, blockAt, opts);
  const scaffoldEntries = () => Object.values(memory.temporary).filter(entry => !entry.roof);
  const roofCap = () => Object.values(memory.temporary).find(entry => entry.roof);
  const bedsSafe = (hs) => !hs.unknown.length && !hs.missing.some(b => b.phase === 'roof')
    && !hs.scaffoldLeft && !scaffoldEntries().length;
  function ownedRecord(kind, position, roof) {
    const b = blockAt(position);
    if (!b || bot.companionPlayerBlock?.(position)) return;
    const entry = { position, name: b.name, stateId: b.stateId };
    if (roof) memory.temporary[posKey(position)] = { ...entry, roof };
    else if (kind === 'scaffold') memory.temporary[posKey(position)] = entry;
    else memory.owned[posKey(position)] = entry;
  }
  const stillOwned = (entry, block) => Boolean(entry && block?.name === entry.name
    && (entry.stateId === undefined || entry.stateId === block.stateId) && !bot.companionPlayerBlock?.(entry.position));

  function restoreConstruction(saved) {
    if (!memory.house || !saved || typeof saved !== 'object') return;
    const valid = (p) => p && [p.x, p.y, p.z].every(Number.isInteger);
    const h = memory.house;
    if (h.variant !== 'hillside' && ROOF_MATERIALS.includes(saved.roofMaterial)) memory.roofMaterial = saved.roofMaterial;
    const ops = new Map(h.blocks.map(b => [posKey(b.position), b]));
    for (const info of Object.values(saved.owned || {}).slice(0, 120)) {
      if (!valid(info?.position) || typeof info.name !== 'string') continue;
      const key = posKey(info.position), piece = ops.get(key);
      if (piece && matchesBuilding(piece, info.name)) memory.owned[key] = info;
    }
    for (const info of Object.values(saved.temporary || {}).slice(0, 10)) {
      if (!valid(info?.position)) continue;
      const panel = valid(info.roof) && ops.get(posKey(info.roof));
      if (memory.roofMaterial && panel?.phase === 'roof' && posKey(top(info.roof)) === posKey(info.position)
        && matches('planks', info.name) && !roofCap()) memory.temporary[posKey(info.position)] = info;
      if (idAt(h.scaffold, info.position) && FILLERS.has(info.name)) memory.temporary[posKey(info.position)] = info;
    }
    const savedPosition = saved.breach?.position;
    if (valid(savedPosition)) memory.breach = memory.owned[posKey(savedPosition)];
    for (const id of ['crafting_table', 'furnace', 'chest', 'bed', 'guestBed']) {
      const f = saved.furniture?.[id], inside = (p) => valid(p) && p.y === h.anchor.y && insideRoom(p);
      if (!inside(f?.position)) continue;
      if (h.furniture[id].head && (!inside(f.head)
        || !(inside(f.stand) || (valid(f.stand) && idAt([h.entrance], f.stand)))
        || Math.abs(f.position.x - f.head.x) + Math.abs(f.position.z - f.head.z) !== 1)) continue;
      h.furniture[id] = { ...h.furniture[id], position: f.position,
        ...(h.furniture[id].head ? { head: f.head, stand: f.stand } : {}) };
    }
    memory.cleanupRequested = scaffoldEntries().length > 0;
  }

  async function clearScaffold(ctx) {
    const ordered = scaffoldEntries().sort((a, b) => b.position.y - a.position.y);
    if (ordered.some(e => !blockAt(e.position))) {
      const entrance = v(memory.house.entrance);
      const moved = await actions.goNear(bot, { ...ctx, dryRoute: autonomous }, entrance, 4, { timeoutMs: 90000 });
      if (!moved.ok) return moved;
    }
    for (const entry of ordered) {
      const p = v(entry.position);
      const block = blockAt(p);
      if (!block) return { ok: false, reason: 'scaffold_unloaded' };
      if (!stillOwned(entry, block)) {
        delete memory.temporary[posKey(p)];
        continue;
      }
      if (bot.entity.position.floored().offset(0, -1, 0).equals(p)
        && !(supports(blockAt(p.offset(0, -1, 0))) && clear(blockAt(p.offset(0, 1, 0))))) {
        const stand = SIDES.map(([dx, dz]) => p.offset(dx, 1, dz)).find(q => safeStand(blockAt, q));
        if (!stand) return { ok: false, reason: 'standing_on_scaffold' };
        const off = await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z),
          { timeoutMs: 7000, retryNoProgress: false });
        if (!off.ok || bot.entity.position.floored().offset(0, -1, 0).equals(p)) return { ok: false, reason: 'standing_on_scaffold' };
      }
      if (!actions.withinReach?.(bot, p) || (bot.canSeeBlock && !bot.canSeeBlock(block))) {
        const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 10000, retryNoProgress: false });
        if (!reach.ok) return reach;
      }
      const dug = await actions.digBlock(bot, ctx, block, { ownedHomeRemoval: b => stillOwned(entry, b) });
      if (!dug.ok) return dug;
      delete memory.temporary[posKey(p)];
      ctx.record('scaffold_removed', { position: posKey(p) });
    }
    memory.cleanupRequested = false;
    return { ok: true };
  }
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

  function furnitureSpot(what, position, options) {
    const f = memory.house.furniture;
    if (!['crafting_table', 'furnace', 'chest', 'bed', 'guestBed'].includes(what)) return { position, options };
    const occupied = [position, ...(options.alsoClear || [])];
    if (what === 'bed' || what === 'guestBed') {
      if (!bedsSafe(houseState())) return null;
    }
    const current = room({ occupy: occupied });
    if (current.connected) return { position, options };
    if (!current.known) return null;
    const reserved = positionsFor(f).filter(p => ![f[what].position, f[what].head, f[what].stand].includes(p));
    reserved.push(...f.torches, memory.house.interiorCenter);
    const free = (p) => safeStand(blockAt, p) && !bot.companionPlayerBlock?.(p) && !idAt(reserved, p);
    const previous = f[what];
    if (previous.head) {
      for (const [dx, dz] of SIDES) {
        const shift = p => v(p).offset(dx, 0, dz);
        const next = { ...previous, position: shift(previous.position), head: shift(previous.head), stand: shift(previous.stand) };
        if (![next.position, next.head, next.stand].every(p => insideRoom(p) && free(p))
          || !room({ occupy: [next.position, next.head] }).connected) continue;
        return { position: next.position, changed: next,
          options: { ...options, stand: next.stand, alsoClear: [next.head], verify: () => matches('bed', nameAt(next.head)) } };
      }
      return null;
    }
    for (const p of current.cells.values()) {
      if (!free(p) || !room({ occupy: [p] }).connected) continue;
      return { position: p, options, changed: { ...previous, position: p } };
    }
    return null;
  }

  function houseState(ctx) {
    const house = memory.house;
    const unknown = [];
    const check = (p, match, required = true) => {
      const block = blockAt(p);
      if (!block) { if (required) unknown.push(p); return null; }
      return match(block.name, block);
    };
    const cap = roofCap();
    const missing = house.blocks.filter((b) => check(b.position, (name) => matchesBuilding(b, name)
      || Boolean(cap && posKey(cap.roof) === posKey(b.position) && air(name) && stillOwned(cap, blockAt(cap.position)))) === false);
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
    const playerBlock = p => bot.companionPlayerBlock?.(p);
    const available = p => naturalCover(blockAt(p)) && supports(blockAt(below(p))) && !playerBlock(p);
    if (placed.guestBed === false && [f.guestBed.position, f.guestBed.head].some(playerBlock)
      && !guestAlternates().some(b => [b.position, b.head, b.stand].every(available))) {
      blocked.push({ item: 'guestBed', position: f.guestBed.position, reason: 'protected_player_block' });
    }
    const torches = [];
    for (const p of f.torches) {
      if (check(p, (n) => n === 'torch', false) !== false || torchAlternates(p).some(q => nameAt(q) === 'torch')) continue;
      if (playerBlock(p) && !torchAlternates(p).some(available)) blocked.push({ item: 'torch', position: p, reason: 'protected_player_block' });
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
    if (block) return (name) => matchesBuilding(block, name);
    const f = house.furniture;
    if (posKey(f.crafting_table.position) === key) return (n) => n === 'crafting_table';
    if (posKey(f.furnace.position) === key) return (n) => n === 'furnace';
    if (posKey(f.chest.position) === key) return (n) => n === 'chest';
    for (const bed of bedKeys.map((id) => f[id])) {
      if (posKey(bed.position) === key || posKey(bed.head) === key) {
        return (n) => matches('bed', n);
      }
    }
    // No door yet: at night the doorway is plugged with dirt or stone, dug out again by day.
    if (posKey(f.door.position) === key || posKey(f.door.upper) === key) {
      return (n) => (n.endsWith('_door') && nameAt(f.door.position)?.endsWith('_door') && nameAt(f.door.upper)?.endsWith('_door'))
        || (memory.doorPlug && FILLERS.has(n));
    }
    if (memory.temporary[key]) return (n) => memory.temporary[key]?.name === n;
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
    for (const block of hs.missing) {
      const family = roofMaterial(block);
      remaining[family] = (remaining[family] || 0) + 1;
    }
    for (const [family, count] of Object.entries(remaining)) reqs.push({ key: family, count });
    if (!autonomous && bedsSafe(hs) && hs.placed.bed === false) reqs.push({ key: 'bed', count: 1 });
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

  function woodForFurniture(hs, inventory) {
    const unmade = (piece, count = 1) => Math.max(0, count - countKey(piece, inventory, kb));
    return (!hs.placed.crafting_table ? 4 * unmade('crafting_table') : 0)
      + (!hs.placed.chest ? 8 * unmade('chest') : 0) + (!hs.placed.door ? 6 * unmade('door') : 0)
      + 3 * unmade('bed', Number(hs.placed.bed === false) + Number(hs.placed.guestBed === false));
  }

  function chooseRoofMaterial(inventory, choices = ROOF_MATERIALS) {
    const count = key => countKey(key, inventory, kb) + (key === 'sandstone' ? Math.floor((inventory.sand || 0) / 4)
      : key === 'red_sandstone' ? Math.floor((inventory.red_sand || 0) / 4) : 0);
    const pickaxe = countKey('pickaxe', inventory, kb) > 0;
    return choices.filter(key => kb[key] && (!key.startsWith('roof_') || pickaxe || count(key) > 0))
      .sort((a, b) => count(b) - count(a))[0];
  }

  function selectRoofFallback(ctx, hs, exhaustion) {
    if (!autonomous || memory.roofMaterial || !hs || ctx.signal?.aborted || exhaustion?.task !== 'wood') return;
    const needed = hs.missing.filter(b => b.phase === 'roof' && b.family === 'planks').length;
    if (!needed) return;
    const { inventory } = ctx.perceive();
    const furniture = woodForFurniture(hs, inventory);
    // These items are kept in the bag by the autonomous home and stocking rules.
    const wood = Object.entries(inventory).reduce((sum, [n, count]) => sum
      + (matches('planks', n) ? count : matches('log', n) ? count * 4 : 0), 0);
    if (wood >= needed + furniture) return;
    const material = chooseRoofMaterial(inventory);
    if (!material) return;
    memory.roofMaterial = material;
    memory.batch = null;
    ctx.record('home_roof_fallback', { material: memory.roofMaterial.replace(/^roof_/, ''), needed,
      carried: countKey(memory.roofMaterial, inventory, kb), furniture, wood, method: exhaustion.method });
  }

  function complete(state, hs = memory.house && houseState()) {
    if (!memory.house) return false;
    if (!autonomous && !gear.every((key) => countKey(key, state.inventory, kb) > 0)) return false;
    // An expedition can unload home without damaging it. Only trust this
    // connection's verification: a loaded legacy home still needs its upgrade.
    if (hs.accessObstructed || hs.scaffoldLeft || scaffoldEntries().length) return false;
    if (hs.unknown.length) return memory.validated === true && !hs.missing.length && !hs.foundationMissing.length
        && !Object.entries(hs.placed).some(([id, placed]) => id !== 'guestBed' && (!autonomous || id !== 'bed') && placed === false);
    if (hs.missing.length || hs.foundationMissing.length || !hs.placed.door || (!autonomous && !hs.placed.bed) || !hs.placed.chest
      || !hs.placed.crafting_table || !hs.placed.furnace) return false;
    if (!room().connected || (!autonomous && Object.entries(memory.verified).some(([id, used]) => id !== 'guestBed' && !used))) return false;
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
    return { anchor: { ...memory.house.anchor }, size: memory.house.size,
      usable, finished: usable && memory.upgradesComplete === true, upgrades };
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
        if (ctx.adapt && step.key === 'log') {
          const hs = autonomous && house && !memory.established && !memory.roofMaterial ? houseState() : null;
          const result = await gatherWood({ bot, ctx: autonomous ? { ...ctx, dryRoute: true } : ctx,
            skills, actions, memory, anchor: house?.anchor,
            blocks: step.blocks, dropMatch: kb.log.match, blacklist, exclude: nearHouseColumn });
          selectRoofFallback(ctx, hs, result.adaptationExhausted);
          return result;
        }
        // Nothing within the usual 48 blocks: look as far as the loaded world
        // reaches before walking off to explore (a felled plain, a treeless hill).
        let result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
          blacklist, exclude: nearHouseColumn });
        if (result.reason === 'no_target_in_range') {
          if (step.for === memory.roofMaterial && !ctx.signal?.aborted) {
            const index = ROOF_MATERIALS.indexOf(memory.roofMaterial);
            const next = chooseRoofMaterial(ctx.perceive().inventory, ROOF_MATERIALS.slice(index + 1));
            if (next) {
              const material = next.replace(/^roof_/, '');
              ctx.record('home_roof_material_changed', { from: memory.roofMaterial.replace(/^roof_/, ''), material, reason: result.reason });
              memory.roofMaterial = next;
              memory.batch = null;
              return { ok: true, progress: false };
            }
          }
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
  function protectSite(ctx) {
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
      ctx.adapt?.pruneHome?.();
    }
    bot.companionHomeSite = memory.homeSite;
    if (!movements) return;
    if (!memory.protect) memory.protect = (block) => protects(block.position) ? 100 : insideHouse(block.position) ? 90 : 0;
    if (!movements.exclusionAreasBreak.includes(memory.protect)) movements.exclusionAreasBreak.push(memory.protect);
  }

  async function siteStep(ctx) {
    const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const work = siteWork(read, workSite(), (p, block) => expectedAt(p)(block.name));
    const essential = (p) => !optionalCell(p) && !idAt(memory.house.torchSupports, p);
    if (memory.established) {
      work.digs = work.digs.filter(d => essential(d.position));
      work.fills = work.fills.filter(d => essential(d.position));
    }
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
      const first = await dig();
      if (first.ok || first.sourceHandled || ['unloaded', 'protected_player_block', 'unsafe_excavation', 'protected_home'].includes(first.reason)) return first;
      const walk = await alternateStand(bot, ctx, actions, p);
      return walk.ok ? dig() : first;
    }
    if (work.fills.length && Object.keys(ctx.perceive().inventory).some((n) => FILLERS.has(n))) {
      ctx.record('site_fill', { position: posKey(work.fills[0].position) });
      return placeRecorded(ctx, work.fills[0].position, (n) => FILLERS.has(n), 'foundation', {});
    }
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
    const roofing = !walls.length ? roof.map((b) => ({ what: 'roof', position: b.position, material: roofMaterial(b),
      match: (n) => matches(roofMaterial(b), n), batch: Math.min(roof.length, BATCH) })) : [];
    // Leave the doorway and floor clear while accessing the compact roof.
    if (memory.house.variant === 'compact' && !memory.established && roofing.length) return [...tasks, ...roofing];
    const addDoor = () => piece('door', f.door.position, 'door', (n) => matches('door', n),
      { faces: DOWN, verify: () => matches('door', nameAt(f.door.upper)), alsoClear: [f.door.upper],
        ...(memory.house.variant === 'compact' && !memory.established ? { stand: memory.house.interiorCenter } : {}) });
    if (!walls.length && !hs.placed.door && memory.house.variant !== 'compact') addDoor();
    if (!hs.placed.chest) piece('chest', f.chest.position, 'chest', (n) => n === 'chest');
    for (const id of autonomous || !bedsSafe(hs) ? [] : ['bed']) {
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
    let deferredRoof = null;
    let roofAttempts = 0;
    for (const task of buildTasks(hs)) {
      if (deferredRoof && task.what !== 'roof') break;
      const have = countKey(task.material, inventory, kb);
      // Once a batch is started it continues until that material runs out.
      const continuing = memory.batch === task.material;
      if (have <= 0 || (whenBatchReady && !continuing && have < task.batch)) {
        waiting[task.material] = (waiting[task.material] || 0) + 1;
        continue;
      }
      memory.batch = task.batch > 1 ? task.material : null;
      const result = await placeRecorded(ctx, task.position, task.match, task.what, task.options);
      const blockedRoof = task.what === 'roof' && memory.house?.variant === 'compact' && !memory.established
        && bot.entity.position.y >= task.position.y + 0.9
        && !result.ok && !result.waited && !result.sourceHandled && !result.giveUp
        && ['NoPath', 'not_arrived', 'no_progress', 'path_timeout', 'Timeout'].includes(result.reason);
      if (!blockedRoof) return result;
      // An adjacent panel can make the current corner reachable. Try another
      // ready panel in this turn; the next turn reads the roof again.
      deferredRoof ||= result;
      roofAttempts += 1;
      if (roofAttempts >= 4) break;
    }
    if (deferredRoof) return deferredRoof;
    memory.batch = null;
    if (!whenBatchReady && Object.keys(waiting).length) ctx.record('build_waiting', waiting);
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

  const readSite = (x, y, z) => blockAt(new Vec3(x, y, z));

  function siteSearch(state, adaptation) {
    const protectedCell = (p) => bot.companionPlayerBlock?.(p);
    const avoid = (p) => nearDanger(p) || adaptation?.avoids('rejected_site', p) || bot.companionNearPlayerBuild?.(p);
    if (!autonomous || !adaptation) return { protectedCell, avoid };
    const wood = countKey('planks', state.inventory, kb) + countKey('log', state.inventory, kb) * 4;
    let access;
    return { protectedCell, avoid, access(house) {
      if (!access) {
        const logs = (bot.findBlocks?.({ matching: b => b && kb.log.match(b.name), maxDistance: 56, count: 192 }) || [])
          .filter(p => !protectedCell(p) && !adaptation.avoids('hard_route', p));
        access = drySiteAccess(blockAt, state.position, logs);
      }
      return access(house, wood >= (house.materials().planks || 0) + 23);
    } };
  }

  function findSite(state, searches, methods, radius) {
    for (const method of methods) {
      const site = method === 'hillside' ? chooseHillside(readSite, state.position, searches)
        : chooseSite(readSite, state.position, { ...searches, radius, variant: method === 'compact' ? 'compact' : 'starter',
          maxWork: method === 'near_flat' ? 12 : 32 });
      if (site) return site;
    }
    return null;
  }

  function adoptSite(ctx, site, method) {
    memory.house = createStarterHouse(site.anchor, site);
    memory.relocation = null;
    memory.homesteadRoute = null;
    ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs, method, variant: site.variant, route: site.route });
    return { ok: true, progress: false };
  }

  function scoutSite(state, adaptation, record) {
    if (!autonomous || memory.pinned || memory.house || memory.relocation?.candidate || state.isDay !== true
      || state.inWater || state.sheltered || state.onGround === false || state.hostiles?.some(e => e.distance <= 8)) return;
    const from = v(state.position).floored();
    if (lastSiteScout && Math.hypot(lastSiteScout.x - from.x, lastSiteScout.z - from.z) < SCOUT_SPACING
      && Math.abs(lastSiteScout.y - from.y) < 8) return;
    if (!safeStand(blockAt, from) || actions.underground?.(bot)) return;
    lastSiteScout = from;
    const started = performance.now();
    const site = findSite(state, siteSearch(state, adaptation), ['near_flat', 'compact'], SCOUT_RADIUS);
    if (site) (memory.relocation ||= {}).candidate = { site, from };
    record('home_site_scout', { from, anchor: site?.anchor || null, variant: site?.variant || null,
      elapsedMs: Math.round(performance.now() - started) });
  }

  async function useScoutedSite(ctx, state) {
    const { site, from } = memory.relocation.candidate;
    function validate(here) {
      const searches = siteSearch(here, ctx.adapt);
      if (searches.avoid(site.anchor)) return null;
      const current = evaluateSite(readSite, site.anchor, v(here.position).floored(), { variant: site.variant,
        protectedCell: searches.protectedCell });
      if (!current || current.anchor.y !== site.anchor.y || current.digs + current.fills > (site.variant === 'compact' ? 32 : 12)) return null;
      const route = searches.access(createStarterHouse(current.anchor, current));
      return route && { ...current, route };
    }
    let valid = validate(state);
    let failure = 'site_changed';
    if (!valid && state.position.distanceTo(from) > 3) {
      const returned = await actions.goNear(bot, { ...ctx, dryRoute: true }, from, 2, { timeoutMs: 45000, skipAdaptation: true });
      if (returned.waited || returned.sourceHandled || returned.reason === 'aborted') return returned;
      if (returned.ok) valid = validate(ctx.perceive());
      else failure = returned.reason;
    }
    if (valid) return adoptSite(ctx, valid, 'scouted');
    ctx.record('home_site_scout_rejected', { anchor: site.anchor, from, reason: failure });
    delete memory.relocation.candidate;
    return null;
  }

  async function abandonSite(ctx, reason, counted = false) {
    if (scaffoldEntries().length) {
      memory.cleanupRequested = true;
      const cleaned = await clearScaffold(ctx);
      if (!cleaned.ok) return cleaned;
    }
    const anchor = memory.house.anchor;
    let outcome;
    if (ctx.adapt && !counted) {
      const p = ctx.adapt.plan('home_site', { position: memory.searchOrigin || anchor });
      outcome = ctx.adapt.outcome(p, { ok: false, reason });
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
      house: null, protect: null, homeSite: null, established: false, siteDigs: 0, houseBuilt: 0, houseBed: false,
      relocate: false, explore: {}, exploreStreak: 0, scaffoldActive: false, doorPlug: false,
      relocation: { anchor, attempt: 0 }, siteAccessFailures: 0,
      furnace: { item: null, input: 0, output: 0 }, validated: false,
      owned: {}, temporary: {}, cleanupRequested: false,
      roofMaterial: null,
    });
    for (const key of Object.keys(memory.verified)) memory.verified[key] = false;
    blacklist.clear();
    skipped.clear();
    reportedUpgradeBlocks.clear();
    return { ...outcome, ok: true, abandoned: true, progress: false };
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
    return result.ok ? { ok: false, reason: 'relocation_not_arrived' } : result;
  }

  const nearbyWoolMobs = () => Object.values(bot.entities || {}).some((e) => e.position
    && e.position.distanceTo(bot.entity.position) <= 24 && !blacklist.has(`mob:${e.id}`)
    && ((e.name === 'sheep' && !skills.sheepWool?.(bot, e)?.sheared) || e.name === 'spider'));
  function wantsGuestBed(state) {
    if (!memory.established || memory.upgradesComplete || state.health < 16 || state.food < 12
      || Date.now() < (memory.guestBedRetryAt || 0)) return false;
    const hs = houseState();
    if (hs.placed.guestBed === true || hs.blocked.some((b) => b.item === 'guestBed')) return false;
    if (autonomous) return true;
    if (state.isDay !== true) return false;
    const spot = memory.house.furniture.guestBed.position;
    if (bot.entity.position.distanceTo(new Vec3(spot.x, spot.y, spot.z)) > 32) return false;
    return countKey('bed', state.inventory, kb) > 0 || countKey('wool', state.inventory, kb) >= 3
      || (state.inventory.white_wool || 0) + Math.floor((state.inventory.string || 0) / 4) >= 3 || nearbyWoolMobs();
  }

  async function returnForUpgrade(ctx) {
    const e = v(memory.house.entrance);
    if (bot.entity.position.distanceTo(e) <= 20) return null;
    ctx.record('home_finish_step', { step: 'return_home', position: posKey(e) });
    const walked = await actions.goNear(bot, { ...ctx, dryRoute: true }, e, 4, { timeoutMs: 90000 });
    return { ...walked, transit: true };
  }

  async function bedUpgrade(ctx, id) {
    const transit = (memory.sheepScan || []).length && nameAt(memory.house.furniture.crafting_table.position)
      && !countKey('bed', ctx.perceive().inventory, kb) ? null : await returnForUpgrade(ctx);
    if (transit) return transit;
    const hs = houseState(ctx), state = ctx.perceive(), inventory = state.inventory;
    if (!bedsSafe(houseState(ctx))) return null;
    const f = memory.house.furniture[id];
    if (hs.placed[id] === true) return { ok: true, already: true };
    if (countKey('bed', inventory, kb)) {
      return placeRecorded(ctx, f.position, (n) => matches('bed', n), id,
        { stand: f.stand, verify: () => matches('bed', nameAt(f.head)), alsoClear: [f.head], requireAir: true });
    }
    const stations = { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace };
    const step = plan(ctx, { requirements: [{ key: 'bed', count: 1 }], inventory, stations });
    if (!step || step.kind === 'blocked') return { ok: false, reason: 'bed_materials_unavailable' };
    if (step.kind !== 'hunt' || step.key !== 'wool') {
      memory.sheepScan = null;
      return (await returnForUpgrade(ctx)) || runPlannerStep(ctx, step, null);
    }
    const area = { position: memory.house.anchor, target: id === 'bed' ? 'primary' : 'guest' };
    async function huntSheep() {
      ctx.record('home_finish_step', { step: 'sheep_wool', item: id, radius: 128 });
      const fleece = woolPreference(inventory);
      const inArea = e => e.position?.distanceTo(v(area.position)) <= 128;
      const eligible = Object.values(bot.entities || {}).some(e => e.name === 'sheep' && inArea(e) && fleece.accept?.(e) !== false);
      const result = await skills.huntOne(bot, ctx, { mobs: ['sheep'], dropMatch: kb.wool.match, blacklist, radius: 128,
        targetGoal: 'homestead', ...fleece, accept: e => inArea(e) && fleece.accept?.(e) !== false });
      if (result.reason !== 'no_mob_in_range') return result.ok && !result.gained ? { ok: false, reason: 'no_wool_collected' } : result;
      if (eligible) return { ok: true, waited: true, reason: 'no_eligible_sheep_near_home', retryAt: Date.now() + 30_000 };
      // A single entity snapshot only covers tracked mobs, not the search
      // radius. Look from dry ground in each accessible quarter first.
      const e = v(memory.house.entrance);
      const searched = (memory.sheepScan ||= []);
      const quarter = (p) => (p.x >= e.x ? 1 : 0) + (p.z >= e.z ? 2 : 0);
      const dry = dryComponent(blockAt, bot.entity.position, 40);
      const look = [...dry.values()].filter(p => !searched.includes(quarter(p))
        && p.distanceTo(e) >= 25 && p.distanceTo(e) <= 44 && p.distanceTo(bot.entity.position) >= 12)
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0];
      if (look) {
        searched.push(quarter(look));
        ctx.record('home_finish_step', { step: 'scout_for_sheep', item: id, position: posKey(look) });
        const result = await actions.goNear(bot, { ...ctx, dryRoute: true }, look, 2, { timeoutMs: 35000 });
        return { ...result, transit: true };
      }
      memory.sheepScan = null;
      return result;
    }
    async function huntSpiders() {
      if (state.isDay !== false) {
        ctx.record('home_finish_step', { step: 'await_spiders_at_night', item: id, missing: Math.max(0, 12 - (inventory.string || 0) - 4 * (inventory.white_wool || 0)) });
        return { ok: true, waited: true, reason: 'await_spiders_at_night', retryAt: Date.now() + 30_000 };
      }
      const home = await returnForUpgrade(ctx);
      if (home) return home;
      ctx.record('home_finish_step', { step: 'spider_string', item: id });
      const result = await skills.huntOne(bot, ctx, { mobs: ['spider'], dropMatch: kb.string.match, blacklist, radius: 48,
        targetGoal: 'homestead', accept: e => e.position.distanceTo(v(area.position)) <= 48 });
      if (result.reason === 'no_mob_in_range') return { ok: true, waited: true, reason: 'no_spider_near_home', retryAt: Date.now() + 30_000 };
      return result.ok && !result.gained ? { ok: false, reason: 'no_string_collected' } : result;
    }
    if (!ctx.adapt) {
      if (Date.now() < (memory.noSheepUntil || 0)) return huntSpiders();
      const result = await huntSheep();
      if (result.reason !== 'no_mob_in_range') return result;
      memory.noSheepUntil = Date.now() + 15 * 60_000;
      return huntSpiders();
    }
    if (ctx.adapt.avoids('no_sheep', area.position)) ctx.adapt.promote('bed', area, 'spider_string', 'known_no_sheep');
    return ctx.adapt.run('bed', area, async (method) => {
      if (method === 'sheep') return huntSheep();
      if (method === 'spider_string') return huntSpiders();
      ctx.record('home_finish_step', { step: 'shelter_first', item: id });
      if (state.isDay === false) {
        const sheltered = await nightStep(ctx, hs, state);
        if (sheltered && !sheltered.ok) return sheltered;
      }
      return { ok: false, reason: 'bed_hunt_exhausted' };
    }, { learn: (result, attempt) => attempt.method === 'sheep' && result.reason === 'no_mob_in_range'
      ? { kind: 'no_sheep', position: area.position, radius: 128 } : null });
  }

  function guestBedGoal() {
    let done = false, steps = 0;
    return {
      name: 'guest_bed',
      isDone: () => done || Boolean(memory.house && houseState().placed.guestBed === true),
      progress: () => steps,
      async run(ctx) {
        const state = ctx.perceive();
        if (autonomous) {
          const result = await bedUpgrade(ctx, 'guestBed') || { ok: true, waited: true, reason: 'roof_not_ready_for_bed' };
          if (result.ok && !result.waited) steps++;
          if (result.targetExcluded) memory.guestBedRetryAt = Date.now() + 5 * 60_000;
          return result;
        }
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
    if (!memory.established || memory.upgradesComplete || state.health < 16 || state.food < 12) return false;
    if (autonomous) {
      const hs = houseState();
      return hs.torches.length > 0 || memory.house.furniture.torches.some(p => !blockAt(p));
    }
    if (!state.isDay) return false;
    const { x, y, z } = memory.house.anchor;
    if (bot.entity.position.distanceTo(new Vec3(x, y, z)) > 16) return false;
    const bag = state.inventory;
    return houseState().torches.length > 0 && ((bag.torch || 0) > 0
      || ((bag.coal || 0) + (bag.charcoal || 0) > 0 && (bag.stick || 0) > 0));
  }

  function lightingGoal() {
    let steps = 0;
    return {
      name: 'home_lighting',
      isDone: () => Boolean(memory.house && memory.house.furniture.torches
        .every(p => nameAt(p) === 'torch' || torchAlternates(p).some(q => nameAt(q) === 'torch'))),
      progress: () => steps,
      async run(ctx) {
        const transit = autonomous && await returnForUpgrade(ctx);
        if (transit) return transit;
        const hs = houseState(ctx);
        const state = ctx.perceive();
        const torch = hs.torches[0];
        if (!torch) return { ok: true, waited: true, reason: hs.blocked.find(b => b.item === 'torch')?.reason || 'lighting_site_unloaded' };
        if ((state.inventory.torch || 0) > 0) {
          const placed = await placeRecorded(ctx, torch, (n) => n === 'torch', 'torch', { faces: DOWN, requireAir: true, passable: true });
          if (placed.ok) steps++;
          return placed;
        }
        const step = plan(ctx, { requirements: [{ key: 'torch', count: hs.torches.length }], inventory: state.inventory,
          stations: { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace } });
        if (!step || step.kind === 'blocked' || (!autonomous && step.kind !== 'craft')) {
          return { ok: true, waited: true, reason: 'lighting_materials_unavailable', retryAt: Date.now() + 30_000 };
        }
        ctx.record('home_finish_step', { step: step.kind, material: step.key, for: 'torch', missing: hs.torches.length });
        const result = await runPlannerStep(ctx, step, null);
        if (result.ok && !result.waited) steps++;
        return result;
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
          if (!naturalCover(blockAt(p))) continue;
          if (blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block' || nearHouseColumn(p)) continue;
          const placed = await skills.placeAt(bot, ctx, p, (n) => n === 'crafting_table', { faces: DOWN, requireAir: true });
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
    if (typeof actions.surface !== 'function') return null;
    const feet = bot.entity.position.floored();
    if (memory.house && feet.y === memory.house.anchor.y && insideRoom(feet) && supports(blockAt(below(feet)))) return null;
    const result = await actions.surface(bot, ctx);
    if (result) ctx.record('surface', { ok: result.ok });
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
        try {
          await pillarUp(bot, ctx, peak.y, { maxSteps: 2, blocks: { test: (name) => FILLERS.has(name) }, stop });
        } finally {
          if (FILLERS.has(nameAt(upper))) ownedRecord('scaffold', upper);
        }
        if (!FILLERS.has(nameAt(upper)) || bot.entity.position.y < peak.y - 0.1) return { ok: false, reason: 'roof_step_unconfirmed' };
      }
      // The centre is a permanent tile at the top of the temporary step.
      // Work from above its plane rather than losing sight of the remaining
      // wall tops behind adjacent finished roof blocks.
      const old = nameAt(peak);
      if (!match(old)) {
        try { await pillarUp(bot, ctx, peak.y + 1, { maxSteps: 2, blocks: { test: match }, stop }); }
        finally { if (air(old) && match(nameAt(peak))) ownedRecord('roof', peak); }
      }
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
      .filter((p) => matches('planks', nameAt(p)) || (memory.roofMaterial && roofFallbackMatches(nameAt(p))))
      .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
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
    const original = position;
    const site = furnitureSpot(what, position, options);
    if (site) {
      position = site.position;
      options = site.options;
    }
    const place = async (p = position, opts = options) => {
      if (!site) return { ok: false, reason: 'furniture_blocks_exit' };
      if ([p, ...(opts.alsoClear || [])].some(q => bot.companionPlayerBlock?.(q) && !match(nameAt(q)))) {
        return { ok: false, reason: 'protected_player_block' };
      }
      ctx.record('build', { what, position: posKey(p), ...(what === 'roof' && memory.roofMaterial
        ? { material: memory.roofMaterial.replace(/^roof_/, '') } : {}) });
      // A distant hunt/mining trip needs one long walk before local placement.
      if (bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y, p.z + 0.5)) > 12) {
        ctx.record('return_home', { for: what });
        const back = await actions.goNear(bot, autonomous ? { ...ctx, dryRoute: true } : ctx,
          v(memory.house.entrance), 3, { timeoutMs: 90000 });
        if (!back.ok) return back;
      }
      if (opts.stand && !safeStand(blockAt, opts.stand)) return { ok: false, reason: 'unsafe_build_stand' };
      const result = what === 'roof' && memory.house.variant === 'compact' && !memory.established
        ? await placeCompactRoof(ctx, p, match, opts)
        : await skills.placeAt(bot, ctx, p, match, opts);
      if (result.ok && site.changed && posKey(p) === posKey(site.position)) {
        memory.house.furniture[what] = site.changed;
        ctx.record('home_furniture_moved', { item: what, from: posKey(original), to: posKey(p) });
      }
      if (result.ok && !result.already && ['scaffold', 'wall', 'roof'].includes(what) && match(nameAt(p))) ownedRecord(what, p);
      if (what === 'roof' && result.ok && !houseState(ctx).missing.some(b => b.phase === 'roof')) {
        memory.scaffoldActive = false;
        memory.cleanupRequested = scaffoldEntries().length > 0;
      }
      return result;
    };
    const groundCover = (q) => naturalCover(blockAt(q)) && supports(blockAt(below(q))) && !bot.companionPlayerBlock?.(q);
    async function recover(reason) {
      if (optionalStep(what)) {
        // Native placeAt handles classified plant cover. Only earthwork
        // remains eligible for this terrain-repair fallback.
        const conflicts = [position, ...(options.alsoClear || [])].filter(q => !naturalCover(blockAt(q)));
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
          const alternate = torchAlternates(position).find(groundCover);
          if (alternate) return place(alternate);
        } else {
          const bed = guestAlternates().find(b => [b.position, b.head].every(groundCover) && safeStand(blockAt, b.stand)
            && room({ occupy: [b.position, b.head] }).connected);
          if (bed) {
            const moved = await place(bed.position, { ...options, stand: bed.stand, alsoClear: [bed.head], verify: () => match(nameAt(bed.head)) });
            if (moved.ok) memory.house.furniture.guestBed = bed;
            return moved;
          }
        }
      }
      if (['occupied', 'protected_player_block', 'no_support', 'furniture_blocks_exit'].includes(reason)) return { ok: false, reason };
      const entrance = memory.house.entrance;
      const exteriorLight = what === 'torch' && position.z < memory.house.anchor.z;
      if ((exteriorLight || (options.stand && posKey(options.stand) === posKey(entrance)))
        && (await crossDoorstep(ctx)).ok) return place(position, { ...options, stand: entrance });
      const walked = await alternateStand(bot, ctx, actions, options.stand || position,
        { avoid: q => optionalStep(what) && idAt(memory.house.furniture.torches, q) });
      return walked.ok ? place() : { ok: false, reason };
    }
    const first = await place();
    const result = first.ok || first.sourceHandled || ['unloaded', 'no_material', 'aborted'].includes(first.reason)
      ? first : await recover(first.reason);
    // The functional house may now finish as soon as this door is placed.
    if (what === 'door' && result.ok && !result.already && ctx.perceive().isDay === true) await setDoor(ctx, true);
    if (ctx.adapt && !memory.pinned && !memory.established && result.ok && !result.already && memory.searchOrigin) {
      ctx.adapt.outcome(ctx.adapt.plan('home_site', { position: memory.searchOrigin }), result);
    }
    if (ctx.adapt && !memory.pinned && !memory.established && !result.ok && !result.sourceHandled && memory.searchOrigin
      && ['place_unconfirmed', 'not_arrived', 'NoPath', 'no_support'].includes(result.reason)
      && (memory.houseBuilt || 0) < memory.house.blocks.length * 0.75) {
      const route = ctx.adapt.plan('home_site', { position: memory.searchOrigin });
      const outcome = ctx.adapt.outcome(route, result);
      if (outcome.adaptationSwitched) {
        const abandoned = await abandonSite(ctx, result.reason, true);
        return abandoned.ok ? { ...outcome, ...abandoned } : abandoned;
      }
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

  function raisedBedLandings(at, { roofMayOpen = false } = {}) {
    const p = at.floored();
    if (!isBed(blockAt(p)) || at.y - p.y < 0.4) return [];
    return SIDES.map(([dx, dz]) => p.offset(dx, 0, dz)).filter(q => safeStand(blockAt, q)
      && (clear(blockAt(q.offset(0, 2, 0))) || roofMayOpen));
  }

  function trapped() {
    if (!memory.house || !bot.entity || bot.isSleeping) return null;
    const at = bot.entity.position, cell = at.floored();
    if (!insideRoom(cell)) return null;
    const { y } = memory.house.anchor;
    if (cell.y !== y) return null;
    if (isBed(blockAt(cell)) && at.y - y > 0.4 && !raisedBedLandings(at).length) return 'bed_under_low_roof';
    if (memory.doorPlug && bot.companionSheltered) return null;
    const roof = room();
    if (roof.known && roof.cells.has(posKey(cell)) && !roof.reachable.has(posKey(cell))
      && (memory.established || (roof.open && houseState().scaffoldLeft))) return 'interior_cut_off';
    return null;
  }

  async function walkOne(ctx, candidate, { high = false } = {}) {
    if (!safeStand(blockAt, candidate) || (high && !clear(blockAt(candidate.offset(0, 2, 0))))
      || !bot.lookAt || !bot.setControlState) return { ok: false, reason: 'unsafe_escape_step' };
    const initial = bot.entity.position.clone();
    const airspace = () => safeStand(blockAt, candidate) && (!high || clear(blockAt(candidate.offset(0, 2, 0))));
    try {
      await bot.lookAt(candidate.offset(0.5, initial.y - candidate.y + 1.62, 0.5), true);
      ctx.signal?.throwIfAborted();
      if (!airspace()) return { ok: false, reason: 'unsafe_escape_step' };
      bot.setControlState('forward', true);
      const reached = await waitUntil(() => !airspace() || (bot.entity.position.floored().equals(candidate)
        && bot.entity.position.distanceTo(initial) > 0.45), { timeoutMs: 1300, signal: ctx.signal, intervalMs: 25 });
      return reached && bot.entity.position.floored().equals(candidate) ? { ok: true } : { ok: false, reason: 'escape_step_unconfirmed' };
    } finally {
      bot.setControlState('forward', false);
    }
  }

  async function walkOut(ctx) {
    const e = v(memory.house.entrance);
    const done = () => bot.entity.position.floored().equals(e);
    if (done()) return { ok: true };
    if (doorOpen() === false) await setDoor(ctx, true);
    const feet = bot.entity.position.floored();
    const aisle = e.offset(0, 0, 2);
    // From a side cell next to the door, a diagonal shortcut clips the
    // wall. Align on the level aisle before asking for the outward route.
    if (insideRoom(feet) && feet.y === aisle.y && feet.z === aisle.z && Math.abs(feet.x - aisle.x) === 1
      && safeStand(blockAt, feet) && safeStand(blockAt, aisle)) {
      const landed = await waitUntil(() => bot.entity.onGround && bot.entity.position.floored().equals(feet)
        && Math.abs(bot.entity.position.y - feet.y) < 0.1, { timeoutMs: 1000, signal: ctx.signal, intervalMs: 25 });
      if (landed) await walkOne(ctx, aisle);
    }
    const walked = await actions.goTo(bot, ctx, new goals.GoalBlock(e.x, e.y, e.z),
      { timeoutMs: 6500, retryNoProgress: false });
    if (!done() && insideRoom(bot.entity.position.floored())) await crossDoorstep(ctx);
    return done() ? { ok: true } : { ok: false, reason: walked.reason || 'doorstep_unreached' };
  }

  function repairFaces(p) {
    return SIDES.map(([dx, dz]) => new Vec3(dx, 0, dz)).filter(d => supports(blockAt(p.plus(d))));
  }

  function roofWoodWork(state) {
    if (!memory.roofMaterial || !memory.established || state.isDay !== true || state.sheltered
      || state.health < 16 || state.food < 12 || state.hostiles?.some(h => h.distance <= 8)) return null;
    const at = bot.entity.position;
    const cap = roofCap();
    const hs = houseState();
    if (hs.unknown.length || memory.breach || !complete(state, hs) || !status(state).finished) return null;
    const remaining = memory.house.blocks.filter(b => b.phase === 'roof'
      && roofFallbackMatches(nameAt(b.position)) && stillOwned(memory.owned[posKey(b.position)], blockAt(b.position)));
    const planks = countKey('planks', state.inventory, kb);
    // Enough to finish all owned panels, one temporary cap, and an eight-plank reserve.
    if (cap ? planks < Number(!matches('planks', nameAt(cap.roof))) : planks < remaining.length + 9) return null;
    const panels = cap ? [cap.roof] : remaining.map(b => b.position);
    const candidates = [];
    for (const p of panels) {
      const panel = v(p), cover = panel.offset(0, 1, 0);
      if ([panel, cover].some(q => bot.companionPlayerBlock?.(q)) || (!cap && !air(nameAt(cover)))) continue;
      for (const [dx, dz] of SIDES) {
        const stand = cover.offset(dx, 0, dz);
        if (Math.abs(at.y - stand.y) > 2 || at.distanceTo(stand) > 8 || !safeStand(blockAt, stand)
          || bot.companionPlayerBlock?.(stand)) continue;
        candidates.push({ panel, cover, stand, distance: at.distanceTo(stand) });
      }
    }
    return candidates.sort((a, b) => a.distance - b.distance)[0] || null;
  }

  async function replaceRoofPanel(ctx, work) {
    const { panel, cover, stand } = work;
    const ready = () => !ctx.signal?.aborted && ctx.perceive().isDay === true
      && bot.entity.position.floored().equals(stand) && safeStand(blockAt, stand)
      && ![panel, cover, stand].some(p => bot.companionPlayerBlock?.(p));
    const material = n => matches('planks', n);
    const existing = memory.owned[posKey(panel)];
    let cap = roofCap();
    const covered = () => stillOwned(cap, blockAt(cover));
    const roofPresent = () => material(nameAt(panel));
    if (!ready()) return { ok: false, reason: 'roof_wood_unsafe_stand' };
    if (!cap || !covered()) {
      if (cap) {
        delete memory.temporary[posKey(cover)];
        if (roofPresent()) return { ok: true };
      }
      if (!stillOwned(existing, blockAt(panel)) || !air(nameAt(cover)) || !ready()) {
        return { ok: false, reason: 'roof_wood_panel_changed' };
      }
      try {
        await skills.placeAt(bot, ctx, cover, material, { stand, faces: DOWN, requireAir: true });
      } finally {
        if (material(nameAt(cover))) ownedRecord('roof_cap', cover, panel);
      }
      cap = roofCap();
      if (!covered()) return { ok: false, reason: 'roof_wood_cap_unconfirmed' };
      ctx.record('home_roof_wood_cap', { position: posKey(panel), cap: posKey(cover), block: cap.name });
    }
    if (!roofPresent()) {
      if (!ready() || !covered()) return { ok: false, reason: 'roof_wood_cover_unavailable' };
      const faces = repairFaces(panel);
      if (!faces.length) return { ok: false, reason: 'roof_wood_no_support' };
      if (!air(nameAt(panel))) {
        const dug = await actions.digBlock(bot, ctx, blockAt(panel),
          { ownedHomeRemoval: b => ready() && covered() && stillOwned(existing, b) });
        if (!dug.ok) return dug;
      }
      if (!ready() || !covered() || !air(nameAt(panel))) return { ok: false, reason: 'roof_wood_opening_changed' };
      try {
        await skills.placeAt(bot, ctx, panel, material, { stand, faces, requireAir: true });
      } finally {
        if (roofPresent()) ownedRecord('roof', panel);
      }
      if (!roofPresent()) return { ok: false, reason: 'roof_wood_replacement_unconfirmed' };
    }
    if (!ready() || !covered()) return { ok: false, reason: 'roof_wood_cleanup_blocked' };
    const cleared = await actions.digBlock(bot, ctx, blockAt(cover),
      { ownedHomeRemoval: b => ready() && roofPresent() && stillOwned(cap, b) });
    if (!cleared.ok || !air(nameAt(cover))) return { ok: false, reason: cleared.reason || 'roof_wood_cap_still_present' };
    delete memory.temporary[posKey(cover)];
    ctx.record('home_roof_wood_replaced', { position: posKey(panel), from: existing?.name, block: nameAt(panel) });
    if (memory.house.blocks.every(b => b.phase !== 'roof' || matches('planks', nameAt(b.position)))) memory.roofMaterial = null;
    return { ok: true };
  }

  function roofWoodGoal() {
    let replaced = false;
    return {
      name: 'home_roof_wood',
      isDone: state => replaced || !roofWoodWork(state),
      progress: () => Number(replaced),
      async run(ctx) {
        const work = roofWoodWork(ctx.perceive());
        if (!work) return { ok: true, skipped: 'roof_wood_unavailable' };
        const { stand } = work;
        const movements = bot.pathfinder?.movements;
        const canDig = movements?.canDig;
        if (movements) movements.canDig = false;
        try {
          if (!bot.entity.position.floored().equals(stand)) {
            const moved = await actions.goTo(bot, { ...ctx, nearDestination: true }, new goals.GoalBlock(stand.x, stand.y, stand.z),
              { timeoutMs: 5000, retryNoProgress: false });
            if (!moved.ok) return { ...moved, giveUp: true };
          }
          const result = await replaceRoofPanel(ctx, work);
          replaced = result.ok;
          return replaced || ctx.signal?.aborted ? result : { ...result, giveUp: true };
        } finally {
          if (movements) movements.canDig = canDig;
        }
      },
    };
  }

  async function repairHomeBreach(ctx) {
    const entry = memory.breach;
    if (!entry) return { ok: true };
    const p = v(entry.position);
    if (stillOwned(entry, blockAt(p))) { memory.breach = null; return { ok: true }; }
    if (bot.companionPlayerBlock?.(p) || !clear(blockAt(p))) return { ok: false, reason: 'breach_cell_changed' };
    if (!bot.inventory.items().some(i => i.name === entry.name)) {
      return { ok: false, reason: 'missing_breach_repair_material' };
    }
    const faces = repairFaces(p);
    const stand = p.offset(0, -2, 0);
    const under = p.y === memory.house.anchor.y + 2 && safeStand(blockAt, stand) && faces.length > 0;
    if (under && !insideRoom(bot.entity.position.floored())) await enterShelter(ctx);
    const placed = await skills.placeAt(bot, ctx, p, n => n === entry.name,
      under ? { faces, stand, requireAir: true } : { requireAir: true });
    if (!placed.ok || !stillOwned(entry, blockAt(p))) return { ok: false, reason: placed.reason || 'breach_repair_unconfirmed' };
    memory.breach = null;
    ctx.record('home_breach_repaired', { position: posKey(p), block: entry.name });
    return { ok: true };
  }

  async function repairHomeAccess(ctx) {
    const house = memory.house;
    if (!house || !autonomous || !ctx.adapt) return null;
    const e = v(house.entrance), at = bot.entity.position;
    const horizontal = Math.hypot(at.x - e.x - 0.5, at.z - e.z - 0.5);
    if (horizontal > 10 || Math.abs(at.y - e.y) > 5) return null;

    const door = v(house.furniture.door.position);
    const path = [e, door, door.offset(0, 0, 1)];
    const stands = path.flatMap(p => [p, p.offset(0, 1, 0)]);
    const floors = path.map(p => p.offset(0, -1, 0));
    if (![...stands, ...floors].every(blockAt)) return null;
    const action = { ...ctx, selfRescue: true };
    const bad = stands.find(p => !clear(blockAt(p)) && !(p.z === door.z && matches('door', nameAt(p))));
    const missing = floors.find(p => !supports(blockAt(p)));
    if (!bad && !missing) {
      if (doorOpen() === false) return setDoor(action, true);
      return null;
    }

    const obstruction = bad || missing;
    const reason = bad ? 'home_entry_obstructed' : 'home_entry_support_missing';
    const block = nameAt(obstruction);
    ctx.record('home_access_repair', { reason, block, position: posKey(obstruction) });
    const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const protectedCell = bot.companionPlayerBlock?.(obstruction) || bot.companionProtectBlock?.(blockAt(obstruction));
    if (bad && !protectedCell && canClearTerrain(read, bad)) return clearTerrain(bot, action, actions, bad);
    if (!bad && !protectedCell && clear(blockAt(missing)) && safeCaveDig(read, missing)) {
      const filled = await skills.placeAt(bot, action, missing, n => FILLERS.has(n), { requireAir: true });
      if (!filled.ok || supports(blockAt(missing))) return filled;
      return { ok: false, reason: 'home_access_repair_unconfirmed' };
    }
    if (memory.pinned) return { ok: false, reason: 'home_access_requires_owner' };

    const anchor = house.anchor;
    const abandoned = await abandonSite(ctx, reason, true);
    if (!abandoned.ok || memory.house) return abandoned;
    ctx.record('home_access_relocated', { anchor, reason, block, position: posKey(obstruction) });
    return { ok: false, reason: 'home_site_relocated', sourceHandled: true, giveUp: true };
  }

  async function escapeHome(ctx) {
    const rescue = { ...ctx, selfRescue: true };
    const initial = bot.entity.position.clone();
    const finish = async (method) => {
      if (memory.breach) {
        const repaired = await repairHomeBreach(rescue);
        if (!repaired.ok) return repaired;
        const out = await walkOut(rescue);
        if (!out.ok) return out;
      }
      ctx.record('self_stuck_escaped', { method, from: posKey(initial.floored()), position: posKey(bot.entity.position.floored()) });
      return { ok: true };
    };
    let out = await walkOut(rescue);
    if (out.ok) return finish('door');
    if (scaffoldEntries().length) {
      await clearScaffold(rescue);
      out = await walkOut(rescue);
      if (out.ok) return finish('remove_temporary');
    }
    if (!memory.breach) {
      // Open one adjacent roof panel over an otherwise valid floor, not the
      // block under the bot. A bed corner must land in the doorway component.
      const at = bot.entity.position;
      const connected = room().reachable;
      const land = raisedBedLandings(at, { roofMayOpen: true }).find(q => {
        const p = q.offset(0, 2, 0);
        return connected.has(posKey(q)) && repairFaces(p).length > 0
          && stillOwned(memory.owned[posKey(p)], blockAt(p));
      });
      const p = land?.offset(0, 2, 0);
      let candidate = p && { p, land };
      if (!candidate && insideRoom(at.floored()) && at.y - Math.floor(at.y) < 0.2) {
        const feet = at.floored(), exterior = q => !insideRoom(q)
          && (q.x === memory.house.anchor.x || q.x === memory.house.anchor.x + memory.house.size - 1
            || q.z === memory.house.anchor.z || q.z === memory.house.anchor.z + memory.house.size - 1);
        for (const [dx, dz] of SIDES) {
          const gap = feet.offset(dx, 0, dz);
          if (!exterior(gap) || !safeStand(blockAt, gap.offset(dx, 0, dz))) continue;
          const blocking = [gap, gap.offset(0, 1, 0)].filter(q => !clear(blockAt(q)));
          if (blocking.length !== 1 || !supports(blockAt(gap.offset(0, -1, 0)))
            || !stillOwned(memory.owned[posKey(blocking[0])], blockAt(blocking[0]))) continue;
          candidate = { p: blocking[0], land: gap };
          break;
        }
      }
      if (candidate) {
        const p = candidate.p, entry = memory.owned[posKey(p)];
        memory.breach = entry; // remember before issuing a world edit
        const dug = await actions.digBlock(bot, rescue, blockAt(p), { ownedHomeRemoval: b => stillOwned(entry, b) });
        if (dug.ok && clear(blockAt(p))) {
          ctx.record('home_breach_opened', { position: posKey(p), block: entry.name });
          if (!bot.inventory.items().some(i => i.name === entry.name)) {
            await actions.collectDrops(bot, rescue, p, n => n === entry.name, { radius: 3, timeoutMs: 3000 });
          }
          await walkOne(rescue, candidate.land, { high: Boolean(land) });
          out = await walkOut(rescue);
          if (out.ok) return finish('repaired_breach');
        } else if (stillOwned(entry, blockAt(p))) {
          memory.breach = null;
        }
      }
    }
    // Fall back to the usual exit route through natural terrain only. It
    // cannot break the home or someone else's blocks via pathfinding.
    const surfaced = await actions.surface?.(bot, rescue, { targetY: Math.max(memory.house.anchor.y, Math.floor(initial.y) + 3) });
    if (surfaced?.ok && bot.entity.position.distanceTo(initial) >= 2) {
      out = await walkOut(rescue);
      if (out.ok) return finish('surface');
      if (!insideRoom(bot.entity.position.floored()) && !memory.breach) return finish('surface');
    }
    return { ok: false, reason: 'home_escape_unconfirmed' };
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

  // The planner treats the upper half of an open wooden door as a solid
  // block. A short, level walk along the verified centreline can still pass it.
  async function crossDoorstep(ctx, inward = false) {
    const { entrance, furniture } = memory.house;
    const { x, y, z } = entrance;
    const inside = new Vec3(x, y, z + 2);
    const outside = new Vec3(x, y, z);
    const from = inward ? outside : inside;
    const destination = inward ? inside : outside;
    const door = furniture.door.position;
    const feet = () => bot.entity.position.floored();
    if (feet().equals(destination)) return { ok: true };
    if ((!inward && !insideRoom(feet())) || !actions.goTo || !bot.lookAt || !bot.setControlState) {
      return { ok: false, reason: 'not_at_doorway' };
    }
    const passable = () => {
      const state = blockAt(door)?.getProperties?.();
      return state?.open && ['north', 'south'].includes(state.facing)
        && [outside, inside, door].every(q => blockAt(below(q))?.boundingBox === 'block')
        && [outside, inside].every(q => [q, top(q)].every(cell => {
          const block = blockAt(cell);
          return block && isSoft(block);
        }));
    };
    if (!passable()) return { ok: false, reason: 'doorway_not_clear' };
    if (!feet().equals(from)) {
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(from.x, from.y, from.z),
        { timeoutMs: 5000, retryNoProgress: false });
      if (!moved.ok || !feet().equals(from)) return { ok: false, reason: moved.reason || 'not_at_doorway' };
    }
    if (Math.abs(bot.entity.position.x - (x + 0.5)) > 0.15) await actions.recentre?.(bot, ctx, { accept: p => p.equals(from) });
    if (!passable() || !feet().equals(from) || Math.abs(bot.entity.position.x - (x + 0.5)) > 0.16) {
      return { ok: false, reason: 'doorway_not_clear' };
    }
    try {
      await bot.lookAt(destination.offset(0.5, 1.62, 0.5), true);
      ctx.signal?.throwIfAborted();
      bot.setControlState('forward', true);
      const reached = await waitUntil(() => feet().equals(destination) || !passable(), { timeoutMs: 1500, signal: ctx.signal });
      if (!reached || !feet().equals(destination)) return { ok: false, reason: 'doorstep_unreached' };
    } finally {
      bot.setControlState('forward', false);
    }
    ctx.record('home_doorway_crossed', { position: posKey(entrance), inward });
    return { ok: true };
  }

  function enterShelter(ctx) {
    const e = memory.house?.entrance, at = bot.entity.position;
    if (!e || insideRoom(at.floored()) || at.z > e.z + 1 || Math.abs(at.y - e.y) > 1
      || Math.hypot(at.x - e.x - 0.5, at.z - e.z - 0.5) > 6) return null;
    return crossDoorstep(ctx, true);
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
    if (bedsSafe(hs) && !hs.placed.bed && countKey('bed', state.inventory, kb) > 0 && !blacklist.has('night:bed')) {
      const f = house.furniture;
      const placed = await placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
        { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)) });
      if (!placed.ok) blacklist.add('night:bed', placed.reason, 60000);
      return placed;
    }
    // Already dark and far from home: the walk back is where nights kill.
    // Dig in where the bot is instead.
    const homeDistance = bot.entity.position.distanceTo(new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5));
    const strandedFar = homeDistance > 64;
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
        ctx.record('night', { action: 'sleep', bed: id });
        const slept = await skills.useBed(bot, ctx, { position: bed });
        if (slept.ok) { memory.verified[id] = true; return slept; }
      }
      // Monsters too close to sleep: do not keep trying all night.
      if (!shellDone && available.length) memory.bedRefusedAt = Date.now();
    }
    if (shellDone && !strandedFar) {
      if (!insideRoom(bot.entity.position.floored())) {
        ctx.record('night', { action: 'shelter' });
        const crossed = await enterShelter(ctx);
        if (crossed?.ok) return crossed;
        return actions.goNear(bot, ctx, v(house.interiorCenter), 0, { timeoutMs: 40000, exact: true });
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
    if (blacklist.has('bunker')) return null;
    ctx.record('night', { action: 'dig_in' });
    const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => FILLERS.has(n), avoid: nearHouseColumn, prepareSeal: autonomous });
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
    restoreConstruction,
    status,
    maintenance,
    scoutSite,
    protects,
    wantsGuestBed,
    guestBedGoal,
    wantsLighting,
    lightingGoal,
    wantsRoofWood: (state) => Boolean(roofWoodWork(state)),
    roofWoodGoal,
    isInside: () => Boolean(memory.established && insideRoom(bot.entity.position.floored())),
    enterShelter,
    trapped,
    probeDoor: walkOut,
    escapeHome,
    repairHomeBreach,
    repairHomeAccess,
    nearForSelfRecovery: () => Boolean(memory.house && insideRoom(bot.entity.position.floored())),
    requestCleanup: () => { memory.cleanupRequested = scaffoldEntries().length > 0; },
    needsCleanup: () => Boolean(memory.cleanupRequested),
    clearScaffold,
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
    let state = ctx.perceive();
    if (memory.cleanupRequested) return clearScaffold(ctx);
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
        const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => FILLERS.has(n), prepareSeal: autonomous });
        if (dug.ok) {
          ctx.record('night', { action: 'dug_in' });
          memory.bunker = dug.bunker; bot.companionSheltered = true;
        }
        else blacklist.add('early_bunker', dug.reason, 60_000);
        return dug;
      }
      if (ctx.adapt && !memory.pinned) {
        if (memory.relocation?.candidate) {
          const chosen = await useScoutedSite(ctx, state);
          if (chosen) return chosen;
          state = ctx.perceive();
        }
        const origin = (memory.searchOrigin ||= bot.entity.position.clone());
        return ctx.adapt.run('home_site', { position: origin }, async (method) => {
          let site;
          if (method === 'relocate' || method === 'move_to_fresh_area') {
            const up = await surfaceFirst(ctx);
            if (up) return up;
            const route = (memory.homesteadRoute ||= {});
            if (route.method !== method) {
              route.heading = method === 'move_to_fresh_area' ? 2 : 0;
              route.bearing = Math.atan2(state.position.z - origin.z, state.position.x - origin.x);
              route.method = method;
            }
            const travelCtx = autonomous ? { ...ctx, dryRoute: true } : ctx;
            for (let tried = 0; tried < OUTWARD_HEADINGS.length; tried++) {
              const from = bot.entity.position.clone();
              const started = Date.now();
              const moved = await outwardLeg(bot, travelCtx, actions, route, origin,
                { distance: method === 'relocate' ? 28 : 40, bearing: route.bearing });
              if (ctx.signal?.aborted || moved.reason === 'aborted' || moved.sourceHandled || moved.waited) return moved;
              const here = ctx.perceive();
              const distance = Math.hypot(here.position.x - from.x, here.position.z - from.z);
              ctx.record('home_relocation_leg', { method, from, position: here.position, distance, inWater: here.inWater,
                ok: moved.ok, reason: moved.reason, elapsedMs: Date.now() - started });
              if (here.inWater || (!moved.ok && distance < 16)) {
                if (moved.ok) route.heading += 1; // An X/Z goal can finish in water.
                continue;
              }

              // A completed leg, or a partial leg that reached new dry
              // ground, gives the porch search a new starting point.
              site = findSite(here, siteSearch(here, ctx.adapt), SITE_METHODS);
              if (site) break;
              return { ok: true, moved: distance, progress: false };
            }
            if (!site) return { ok: false, reason: 'relocation_routes_exhausted' };
          } else {
            site = findSite(state, siteSearch(state, ctx.adapt), [method]);
            if (!site) return { ok: false, reason: 'no_suitable_site' };
          }
          return adoptSite(ctx, site, method);
        });
      }
      const site = chooseSite(readSite, near || state.position, siteSearch(state, ctx.adapt));
      if (!site) return memory.relocation?.anchor ? exploreRelocation(ctx) : explore(ctx, 'site');
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
      return actions.goNear(bot, autonomous ? { ...ctx, dryRoute: true } : ctx, v(memory.house.entrance), 3,
        { timeoutMs: 60000 });
    }
    protectSite(ctx);
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
    // Homeward travel may start before dark; shelter and the door use perception.
    const atNight = state.isDay === false;
    if (!atNight) { memory.bedRefusedAt = null; memory.doorPlug = false; }
    bot.companionSheltered = false;
    // After a death the bot is no longer in its bunker: forget it.
    if (memory.bunker) {
      const top = memory.bunker.top;
      const at = bot.entity.position;
      if (Math.hypot(at.x - (top.x + 0.5), at.z - (top.z + 0.5)) > 1.5 || at.y > top.y + 0.5 || at.y < top.y - 5) memory.bunker = null;
    }
    if (memory.bunker && !atNight) {
      ctx.record('night', { action: 'dig_out' });
      const out = await skills.digOut(bot, ctx, memory.bunker);
      if (out.ok) { ctx.record('night', { action: 'dug_out' }); memory.bunker = null; }
      return out;
    }
    // No shell to sleep in yet and out searching: back on the site's own
    // ground before dusk, rather than dig in on whatever rock the search
    // ended on (bare stone without a pickaxe gives no block to seal with).
    if (!atNight && state.timeOfDay >= 10800 && hs.missing.length && !blacklist.has('dusk_home')) {
      const e = memory.house.entrance;
      if (bot.entity.position.distanceTo(new Vec3(e.x, e.y, e.z)) > 48) {
        ctx.record('night', { action: 'dusk_home' });
        const back = await actions.goNear(bot, ctx, new Vec3(e.x, e.y, e.z), 3, { timeoutMs: 90000 });
        if (!back.ok) blacklist.add('dusk_home', back.reason, 120000);
        return back;
      }
    }
    if (atNight) {
      // The permanent night-rest behavior owns established autonomous homes.
      if (!autonomous || !memory.established || ctx.behavior !== 'home_maintenance') {
        const night = await nightStep(ctx, hs, state);
        if (night) return night;
      }
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
    const fallbackRoofOpen = memory.roofMaterial && hs.missing.some(b => b.phase === 'roof');
    if (hs.placed.crafting_table && !skipped.has('crafting_table') && !fallbackRoofOpen) {
      early.unshift({ key: 'crafting_table', count: 1, optional: true });
    }
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
    if (!autonomous && !atNight && state.health >= 12 && countKey('food', state.inventory, kb) < 10 && !blacklist.has('stockpile')) {
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
    if (!autonomous && bedsSafe(hs) && !hs.placed.bed && !skipped.has('wool') && !blacklist.has('early_bed')) {
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
