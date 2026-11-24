'use strict';
// Choose a site, build a usable house through the material planner, and
// confirm optional upgrades against the current world.

const { complete: finished, createAttempt, factsOf, fail, failure, isComplete, resultFrom, waiting } = require('../action-result');
const { Vec3 } = require('vec3');
const { nightBudget } = require('../behaviors/nightRest');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { planNext } = require('../planner');
const { countMatching } = require('../perception');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createStarterHouse } = require('../blueprints/starterHouse');
const { filler, pickItem, placedFor, matchesRoofWood, matchesRoofFallback, budget, supply, acquisition, setFallback, restoreFallbacks } = require('../materials');
const { chooseSite, chooseHillside, evaluateSite, safeCaveDig, canClearTerrain, isSoft, siteWork } = require('../site');
const { vec: v, posKey } = require('../blacklist');
const { ledgerFor, ledgerTarget } = require('../failure-ledger');
const { waitUntil } = require('../confirm');
const { exploreFor, furnaceStock, gatherInLoadedRange, rememberShortfall, placeStation, recoverToward,
  runPlanned, shortfallRequirements, surfaceFirst: surface } = require('./common');
const { outwardLeg, gatherWood, OUTWARD_HEADINGS, outwardPoint, walkOutward } = require('../adaptation-strategies');
const { alternateStand, clearTerrain, withoutDigging } = require('../target-recovery');
const { topology, safeStand, isBed, clear, supports, SIDES } = require('../home-topology');
const { dryComponent, drySiteAccess } = require('../dry-route');
const { isAir: air, naturalCover } = require('../natural-cover');

const DEFAULT_GEAR = ['stone_sword', 'stone_tier_pickaxe', 'iron_sword', 'iron_pickaxe', 'shield'];
// Stone tools come before the house. Iron needs useful crafting and smelting stations.
const EARLY_GEAR = new Set(['stone_sword', 'stone_tier_pickaxe', 'pickaxe', 'wooden_pickaxe']);
const DOWN = [new Vec3(0, -1, 0)];
const BATCH = 16;
const SITE_METHODS = ['near_flat', 'more_earthwork', 'compact', 'hillside'];
const { boundedWork, explorationScope, EXPLORATION_RANGE } = require('../work-budget');
const SCOUT_RADIUS = 12;
const SCOUT_SPACING = 24;
const targetFailure = result => result?.kind === 'target' && !result.facts.target && !result.facts.adaptation;
const RAW_MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'];
const STATIONS = ['crafting_table', 'furnace', 'chest'];
const STORABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stick', 'rotten_flesh', 'feather', 'leather'];

function createHomesteadGoal({ bot, anchor = null, near = null, variant = 'starter', autonomous = false, gear = DEFAULT_GEAR, skills = defaultSkills, actions = defaultActions,
  kb = KNOWLEDGE, origin: spawn = null, maxExploreStreak = 20, searchRadius = EXPLORATION_RANGE, maxSearchStreak = 8 } = {}) {
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
    materialFallbacks: {},
  };
  let retryAt = { conversion: {} };
  const skipped = new Map();
  const isSkipped = key => skipped.get(key) > Date.now();
  const huntExcluded = e => {
    const ledger = ledgerFor(bot);
    return ['hunt', 'hunt_far'].some(purpose => ledger.skip(ledgerTarget(bot, purpose, e.position, { entity: e.id })));
  };
  const reportedUpgradeBlocks = new Map();
  const verifiedParts = new Map();
  let lastSiteScout = null;

  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const matches = (family, name) => Boolean(name) && kb[family].match(name);
  const matchesBuilding = (b, name, block) => placedFor(b.purpose, name, block);

  const bedKeys = ['bed', 'guestBed'];
  const essentialPieces = [...STATIONS, 'door', ...(autonomous ? [] : ['bed'])];
  const bedOptions = bed => ({ stand: bed.stand, verify: () => matches('bed', nameAt(bed.head)), alsoClear: [bed.head] });
  const placeBed = (ctx, id, options) => {
    const bed = memory.house.furniture[id];
    return placeRecorded(ctx, bed.position, kb.bed.match, id, { ...bedOptions(bed), ...options });
  };
  const fillMatch = () => {
    const item = pickItem('filler', bot.inventory.items());
    return item ? n => n === item.name : filler;
  };
  const torchAt = p => [p, ...torchAlternates(p)].some(q => nameAt(q) === 'torch');
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
    memory.materialFallbacks = restoreFallbacks(saved, h.variant);
    const ops = new Map(h.blocks.map(b => [posKey(b.position), b]));
    for (const info of Object.values(saved.owned || {}).slice(0, 120)) {
      if (!valid(info?.position) || typeof info.name !== 'string') continue;
      const key = posKey(info.position), piece = ops.get(key);
      if (piece && matchesBuilding(piece, info.name)) memory.owned[key] = info;
    }
    for (const info of Object.values(saved.temporary || {}).slice(0, 10)) {
      if (!valid(info?.position)) continue;
      const panel = valid(info.roof) && ops.get(posKey(info.roof));
      if (panel?.purpose === 'roof' && posKey(top(info.roof)) === posKey(info.position)
        && matchesRoofWood(info.name) && !roofCap()) memory.temporary[posKey(info.position)] = info;
      if (idAt(h.scaffold, info.position) && filler(info.name)) memory.temporary[posKey(info.position)] = info;
    }
    const savedPosition = saved.breach?.position;
    if (valid(savedPosition)) memory.breach = memory.owned[posKey(savedPosition)];
    for (const id of [...STATIONS, ...bedKeys]) {
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
          options: { ...options, ...bedOptions(next) } };
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
    const missing = house.blocks.filter((b) => check(b.position, (name, block) => matchesBuilding(b, name, block)
      || Boolean(cap && posKey(cap.roof) === posKey(b.position) && air(name) && stillOwned(cap, blockAt(cap.position)))) === false);
    const foundationMissing = house.foundation.filter((p) => check(p,
      (name, block) => block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(name)) === false);
    const f = house.furniture;
    const both = (a, b) => a === false || b === false ? false : a === null || b === null ? null : true;
    if (!matches('bed', nameAt(f.guestBed.position))) {
      const installed = guestAlternates().find(b => matches('bed', nameAt(b.position)) && matches('bed', nameAt(b.head)));
      if (installed) f.guestBed = installed;
    }
    const paired = (piece, match, required) => both(check(piece.position, match, required),
      check(piece.head || piece.upper, match, required));
    const placed = Object.fromEntries(STATIONS.map(id => [id, check(f[id].position, n => n === id)]));
    Object.assign(placed, {
      bed: paired(f.bed, kb.bed.match, !autonomous),
      door: paired(f.door, n => n.endsWith('_door')),
      guestBed: paired(f.guestBed, kb.bed.match, false),
    });
    const blocked = [];
    const playerBlock = p => bot.companionPlayerBlock?.(p);
    const available = p => naturalCover(blockAt(p)) && supports(blockAt(below(p))) && !playerBlock(p);
    if (placed.guestBed === false && [f.guestBed.position, f.guestBed.head].some(playerBlock)
      && !guestAlternates().some(b => [b.position, b.head, b.stand].every(available))) {
      blocked.push({ item: 'guestBed', position: f.guestBed.position, reason: 'protected_player_block' });
    }
    const torches = [];
    for (const p of f.torches) {
      if (!nameAt(p) || torchAt(p)) continue;
      if (playerBlock(p) && !torchAlternates(p).some(available)) blocked.push({ item: 'torch', position: p, reason: 'protected_player_block' });
      else torches.push(p);
    }
    // A replacement is a new station/bed: its predecessor's successful use
    // cannot verify it. An unloaded cell does not erase that observation.
    for (const key of Object.keys(memory.verified)) if (placed[key] === false) memory.verified[key] = false;
    const accessObstructed = [house.entrance, top(house.entrance)].some(p => check(p, (_n, b) => isSoft(b)) === false);
    const scaffoldLeft = house.scaffold.some(p => filler(nameAt(p)));
    return { missing, placed, unknown, foundationMissing, blocked, torches, accessObstructed, scaffoldLeft };
  }

  function expectedAt(p) {
    const house = memory.house;
    const key = posKey(p);
    const block = house.blocks.find((b) => posKey(b.position) === key);
    if (block) return (name, existing) => matchesBuilding(block, name, existing);
    const f = house.furniture;
    const station = STATIONS.find(id => posKey(f[id].position) === key);
    if (station) return n => n === station;
    if (bedKeys.some(id => idAt([f[id].position, f[id].head], p))) return kb.bed.match;
    if (posKey(f.door.position) === key || posKey(f.door.upper) === key) {
      return n => n.endsWith('_door') && nameAt(f.door.position)?.endsWith('_door') && nameAt(f.door.upper)?.endsWith('_door');
    }
    if (memory.temporary[key]) return (n) => memory.temporary[key]?.name === n;
    if (house.scaffold.some((p2) => posKey(p2) === key) && memory.scaffoldActive) return filler;
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
    if (idAt(memory.house.foundation, p) || idAt(memory.house.torchSupports, p)) {
      return block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(block.name);
    }
    return expectedAt(p)(block.name, block);
  }

  // Only observed defects are repair requests. A distant unloaded house is
  // unknown, never a collection of missing walls to rebuild from a guess.
  function maintenance(state) {
    if (!memory.house) return { missing: [], unknown: [], gear: [], unverified: [] };
    const hs = houseState();
    const missing = hs.missing.map((b) => `${b.purpose}@${posKey(b.position)}`);
    missing.push(...hs.foundationMissing.map((p) => `foundation@${posKey(p)}`));
    if (hs.accessObstructed) missing.push('entrance');
    for (const key of essentialPieces)
      if (hs.placed[key] === false && !hs.blocked.some(({ item }) => item === key)) missing.push(key);
    return { missing, unknown: hs.unknown.map(posKey), blocked: hs.blocked,
      gear: gear.filter((key) => countKey(key, state.inventory, kb) <= 0),
       unverified: Object.keys(memory.verified).filter((key) => key !== 'guestBed' && !memory.verified[key] && hs.placed[key] === true) };
  }

  // House materials only; gear is planned separately before and after the house.
  function requirements(state, hs, work) {
    const reqs = shortfallRequirements(memory, state.inventory, kb);
    const stair = memory.scaffoldActive ? memory.house.scaffold.filter(p => !filler(nameAt(p))).length : 0;
    if (work.fills.length + stair && !countKey('filler', state.inventory, kb)) reqs.push({ key: 'dirt', count: 1 });
    if (!autonomous && bedsSafe(hs) && hs.placed.bed === false) reqs.push({ key: 'bed', count: 1 });
    for (const piece of ['chest', 'door', 'furnace', 'crafting_table']) if (!hs.placed[piece]) reqs.push({ key: piece, count: 1 });
    return reqs;
  }

  const plannerInventory = state => furnaceStock({ ...state.inventory }, memory.furnace);

  function woodForFurniture(hs, inventory) {
    const unmade = (piece, count = 1) => Math.max(0, count - countKey(piece, inventory, kb));
    return (!hs.placed.crafting_table ? 4 * unmade('crafting_table') : 0)
      + (!hs.placed.chest ? 8 * unmade('chest') : 0) + (!hs.placed.door ? 6 * unmade('door') : 0)
      + 3 * unmade('bed', Number(hs.placed.bed === false) + Number(hs.placed.guestBed === false));
  }

  function materialStock(hs, inventory) {
    const stone = [
      ...gear.filter(key => EARLY_GEAR.has(key)), ...(!hs.placed.furnace ? ['furnace'] : []),
    ].reduce((sum, key) => sum + (countKey(key, inventory, kb) ? 0 :
      (kb[key].sources.flatMap(source => kb[source.key]?.sources || [source])
        .find(source => source.needs?.cobblestone)?.needs.cobblestone || 0)), 0);
    return budget(inventory, { wood: woodForFurniture(hs, inventory), stone,
      canConvert: item => !(retryAt.conversion[item] > Date.now()) });
  }

  function allowFallback(ctx, purpose, reason, detail = {}, masonryFailed = false) {
    setFallback(memory.materialFallbacks, purpose, reason, masonryFailed);
    memory.batch = null;
    ctx.record(purpose === 'roof' && !masonryFailed ? 'home_roof_fallback' : 'home_material_fallback', { purpose, reason, ...detail });
    return true;
  }

  function woodExhausted(ctx, exhaustion) {
    if (!exhaustion || exhaustion.task !== 'wood' || ctx.signal?.aborted || memory.materialFallbacks.roof
      || memory.established || !memory.house) return;
    const hs = houseState(), { inventory } = ctx.perceive();
    const needed = hs.missing.filter(b => b.purpose === 'roof').length;
    const wood = supply('roof', budget(inventory), {}).primary;
    const furniture = woodForFurniture(hs, inventory);
    if (!needed || wood >= needed + furniture) return;
    const { item, conversion, carried } = supply('roof', materialStock(hs, inventory), {}, true);
    return allowFallback(ctx, 'roof', exhaustion.reason || 'wood_exhausted', { needed, furniture, wood,
      material: item || conversion || 'cobblestone', carried, method: exhaustion.method });
  }

  async function materialStep(ctx, { purpose, batch }, hs) {
    const stock = materialStock(hs, ctx.perceive().inventory);
    const proof = { purpose, batch, ...supply(purpose, stock, memory.materialFallbacks) };
    const { conversion, failure, step } = acquisition(purpose, batch, stock, memory.materialFallbacks, kb);
    if (conversion) {
      ctx.record('home_material_conversion', { ...proof, ...conversion });
      const result = resultFrom(await skills.craft(bot, ctx, { tablePosition: null, ...conversion }), ctx, bot);
      if (!result.ok && !['start', 'interrupted'].includes(result.kind)) retryAt.conversion[conversion.item] = Date.now() + 30000;
      return result;
    }
    if (failure) {
      ctx.record('home_material_acquisition', { ...proof, reason: failure });
      allowFallback(ctx, purpose, failure);
      return { ok: true, progress: false };
    }
    if (!step) return null;
    const planned = { ...step, purpose, for: purpose };
    return runPlanned(ctx, planned, attempt => {
      attempt.record('home_material_acquisition', { ...proof, kind: step.kind, key: step.key });
      return executePlannerStep(attempt, planned);
    });
  }

  function complete(state, hs = memory.house && houseState()) {
    if (!memory.house) return false;
    if (!autonomous && !gear.every((key) => countKey(key, state.inventory, kb) > 0)) return false;
    // An expedition can unload home without damaging it. Only trust this
    // connection's verification: a loaded legacy home still needs its upgrade.
    if (hs.accessObstructed || hs.scaffoldLeft || scaffoldEntries().length || hs.missing.length || hs.foundationMissing.length) return false;
    if (hs.unknown.length) return memory.validated === true && essentialPieces.every(id => hs.placed[id] !== false);
    if (essentialPieces.some(id => !hs.placed[id])) return false;
    if (!room().connected || (!autonomous && Object.entries(memory.verified).some(([id, used]) => id !== 'guestBed' && !used))) return false;
    memory.established = true;
    memory.validated = true;
    return true;
  }

  function status(state) {
    if (!memory.house) return null;
    const hs = houseState();
    const usable = complete(state, hs);
    const { torches, guestBed } = memory.house.furniture;
    const part = (item, position, placed) => {
      const blocked = hs.blocked.find(b => b.item === item && posKey(b.position) === posKey(position));
      return { item, position, ...(blocked && { reason: blocked.reason }),
        status: blocked ? 'blocked' : placed === true ? 'placed' : placed === false ? 'missing' : 'unknown' };
    };
    const upgrades = [...torches.map(p => part('torch', p, torchAt(p) || (nameAt(p) ? false : null))),
      part('guestBed', guestBed.position, hs.placed.guestBed)];
    if (upgrades.every(u => u.status === 'placed')) memory.upgradesComplete = true;
    else if (upgrades.some(u => ['missing', 'blocked'].includes(u.status))) memory.upgradesComplete = false;
    return { anchor: { ...memory.house.anchor }, size: memory.house.size,
      usable, finished: usable && memory.upgradesComplete === true, upgrades };
  }

  function observeParts(state, at, emit) {
    if (!memory.established || !isNearHome(32)) return;
    for (const part of status(state).upgrades) {
      if (part.status === 'unknown') continue;
      const key = part.item === 'torch' ? posKey(part.position) : part.item;
      const prior = verifiedParts.get(key), lost = part.status !== 'placed';
      if (prior && lost !== prior.lost) {
        emit(lost ? 'home_part_lost' : 'home_part_restored', { ...part, lastConfirmedAt: prior.at });
      }
      if (prior || !lost) verifiedParts.set(key, { at: lost ? prior.at : at, lost });
    }
  }

  const isNearHome = distance => bot.entity.position.distanceTo(v(memory.house.entrance)) <= distance;
  function repairPart(state) {
    if (!memory.established || state.isDay !== true || !isNearHome(20)) return null;
    for (const [key, part] of verifiedParts) if (part.lost) {
      if (key === 'guestBed' ? wantsGuestBed(state) : wantsLighting(state)) return key === 'guestBed' ? 'guestBed' : 'lighting';
    }
    return null;
  }

  const explore = (ctx, why) => exploreFor(ctx, why, { bot, skills, memory, anchor: memory.house?.anchor || near,
    searchRadius, maxSearchStreak, maxExploreStreak });

  const plan = (ctx, args) => planNext({ ...args, kb, planning: ctx.planning, portableTable: true,
    positionForStep: step => memory.house?.furniture[step.station]?.position });
  const runPlannerStep = (ctx, step, requirement) => runPlanned(ctx, step, attempt => executePlannerStep(attempt, step, requirement));

  async function executePlannerStep(ctx, step, requirement) {
    const house = memory.house;
    // A crafting table carried along: crafting happens where the bot is, down
    // in its quarry, rather than after a climb that can fail and a walk back.
    const portable = step.kind === 'craft' && step.table && !nearHouseTable()
      && ctx.perceive().inventory.crafting_table > 0;
    // Everything else happens up top: climb out of the pit first.
    if (step.kind !== 'gather' && !portable) {
      const up = await surfaceFirst(ctx);
      if (up) return { ...up, transit: true };
    }
    const missingResource = () => {
      if (!requirement?.optional) return explore(ctx, step.key);
      skipped.set(requirement.key, Date.now() + 300000);
      return { ok: true, skipped: requirement.key };
    };
    switch (step.kind) {
      case 'place_station': {
        // A station needs its foundation; if that hole is still open, fill it first.
        const spot = house.furniture[step.station].position;
        const below = { x: spot.x, y: spot.y - 1, z: spot.z };
        if (blockAt(below)?.boundingBox !== 'block') {
          ctx.record('station_needs_foundation', { station: step.station });
          return placeRecorded(ctx, below, fillMatch(), 'foundation');
        }
        return placeRecorded(ctx, spot, (n) => n === step.station, step.station, { faces: DOWN });
      }
      case 'craft': {
        let table = step.table ? house.furniture.crafting_table.position : null;
        let carried = null;
        if (portable) {
          const placed = await placePortableTable(ctx);
          if (placed.ok) table = carried = placed.position;
          else return (await surfaceFirst(ctx)) || placed;
        }
        let result;
        try {
          result = await skills.craft(bot, ctx, { item: step.item, times: step.times, tablePosition: table });
        } finally {
          if (carried) await pickUpTable(ctx, carried);
        }
        if (result.ok && factsOf(result).usedTable && !carried) memory.verified.crafting_table = true;
        rememberShortfall(memory, kb, result);
        return result;
      }
      case 'gather': {
        if (ctx.adapt && step.key === 'log') {
          const result = await gatherWood({ bot, ctx: autonomous ? { ...ctx, dryRoute: true } : ctx,
            skills, actions, memory, anchor: house?.anchor,
            blocks: step.blocks, dropMatch: kb.log.match, exclude: nearHouseColumn });
          return woodExhausted(ctx, result.facts?.adaptation?.exhausted) ? finished(false) : result;
        }
        // Nothing within the usual 48 blocks: look as far as the loaded world
        // reaches before walking off to explore (a felled plain, a treeless hill).
        const options = { blocks: step.blocks, dropMatch: kb[step.key].match,
          exclude: nearHouseColumn, ...(step.purpose ? { eligibleFirst: true } : {}) };
        const result = resultFrom(await gatherInLoadedRange(bot, ctx, skills, options), ctx, bot);
        if (step.purpose && targetFailure(result) && !ctx.signal?.aborted) {
          const switched = step.key === 'log' ? woodExhausted(ctx, { task: 'wood', method: 'search', reason: result.reason })
            : step.key === 'cobblestone' && allowFallback(ctx, step.purpose, result.reason, {}, true);
          return switched ? { ok: true, progress: false } : result;
        }
        return result.reason === 'no_target_in_range' ? missingResource() : result;
      }
      case 'smelt': {
        const result = await skills.smelt(bot, ctx, { input: step.input, count: step.count,
          furnacePosition: house.furniture.furnace.position, memory: memory.furnace });
        if (isComplete(result)) memory.verified.furnace = true;
        return result;
      }
      case 'hunt': {
        // Optional food runs wait until the bot is healthy again.
        if (requirement?.optional && ctx.perceive().health < 12) {
          skipped.set(requirement.key, Date.now() + 60000);
          return { ok: true, skipped: requirement.key };
        }
        // Food is wanted close by (a rabbit 93 blocks off led across a lake);
        // sheep for the bed are worth a longer walk.
        const result = await skills.huntOne(bot, ctx, { mobs: step.mobs, dropMatch: kb[step.key].match,
          radius: 96, ...(step.key === 'wool' ? woolPreference(ctx.perceive().inventory) : {}) });
        // No sheep anywhere near: spiders drop string, four of which make wool.
        if (result.reason === 'no_mob_in_range' && step.key === 'wool') {
          const spider = await skills.huntOne(bot, ctx, { mobs: ['spider', 'cave_spider'], dropMatch: (n) => n === 'string', radius: 48 });
          if (spider.reason !== 'no_mob_in_range') return spider;
        }
        return result.reason === 'no_mob_in_range' ? missingResource() : result;
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

  async function siteStep(ctx, work) {
    const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
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
      if (!targetFailure(resultFrom(first, ctx, bot)) || ['protected_player_block', 'unsafe_excavation', 'protected_home'].includes(first.reason)) return first;
      const walk = await alternateStand(bot, ctx, actions, p);
      return walk.ok ? dig() : first;
    }
    if (work.fills.length && countKey('filler', ctx.perceive().inventory, kb)) {
      ctx.record('site_fill', { position: posKey(work.fills[0].position) });
      return placeRecorded(ctx, work.fills[0].position, fillMatch(), 'foundation');
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
        if (!filler(nameAt(p))) piece('scaffold', p, 'filler', fillMatch());
      }
    }
    const walls = hs.missing.filter((b) => b.phase === 'walls');
    const shell = (cells, what) => {
      const totals = {};
      for (const b of cells) totals[b.purpose] = (totals[b.purpose] || 0) + 1;
      return cells.map(b => ({ what, position: b.position, material: b.purpose, purpose: b.purpose,
        batch: Math.min(totals[b.purpose], BATCH) }));
    };
    tasks.push(...shell(walls, 'wall'));
    const roofing = walls.length ? [] : shell(hs.missing.filter(b => b.phase === 'roof'), 'roof');
    // Leave the doorway and floor clear while accessing the compact roof.
    if (memory.house.variant === 'compact' && !memory.established && roofing.length) return [...tasks, ...roofing];
    const addDoor = () => piece('door', f.door.position, 'door', (n) => matches('door', n),
      { faces: DOWN, verify: () => matches('door', nameAt(f.door.upper)), alsoClear: [f.door.upper],
        ...(memory.house.variant === 'compact' && !memory.established ? { stand: memory.house.interiorCenter } : {}) });
    if (!walls.length && !hs.placed.door && memory.house.variant !== 'compact') addDoor();
    if (!hs.placed.chest) piece('chest', f.chest.position, 'chest', (n) => n === 'chest');
    for (const id of autonomous || !bedsSafe(hs) ? [] : ['bed']) {
      if (hs.placed[id] !== false || hs.blocked.some(({ item }) => item === id)) continue;
      piece(id, f[id].position, 'bed', kb.bed.match, bedOptions(f[id]));
    }
    if (!hs.placed.furnace) piece('furnace', f.furnace.position, 'furnace', (n) => n === 'furnace');
    if (!walls.length && !hs.placed.door && memory.house.variant === 'compact'
      && hs.placed.furnace && hs.placed.chest && hs.placed.crafting_table) addDoor();
    tasks.push(...roofing);
    return tasks;
  }

  async function buildStep(ctx, tasks, inventory, stock, { whenBatchReady }) {
    const waiting = {};
    let deferredRoof = null;
    let roofAttempts = 0;
    for (const task of tasks) {
      if (deferredRoof && task.what !== 'roof') break;
      const material = task.purpose && supply(task.purpose, stock, memory.materialFallbacks);
      const have = material ? material.carried : countKey(task.material, inventory, kb);
      // Once a batch is started it continues until that material runs out.
      const continuing = task.purpose === 'roof' || memory.batch === task.material || memory.materialFallbacks[task.purpose]
        || bot.entity.position.distanceTo(v(task.position)) <= 12;
      if (have <= 0 || (whenBatchReady && !continuing && have < task.batch)) {
        waiting[task.material] = (waiting[task.material] || 0) + 1;
        continue;
      }
      memory.batch = task.batch > 1 ? task.material : null;
      const result = await placeRecorded(ctx, task.position, task.match, task.what,
        material ? { purpose: task.purpose, selection: material } : task.options);
      const blockedRoof = task.what === 'roof' && memory.house?.variant === 'compact' && !memory.established
        && bot.entity.position.y >= task.position.y + 0.9
        && targetFailure(result) && !result.facts.terminal
        && ['NoPath', 'not_arrived', 'no_progress', 'path_timeout', 'Timeout'].includes(result.reason);
      if (result.reason === 'furniture_blocks_exit') {
        ctx.record('home_furniture_deferred', { ...result.facts, item: task.what });
        continue;
      }
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
      accept: e => !fleece.get(e.id)?.sheared && (!memory.house || e.position.distanceTo(v(memory.house.anchor)) <= searchRadius),
      penalty: (e) => (best && fleece.get(e.id)?.color !== best ? 200 : 0),
    };
  }

  // Raiders (an outpost) seen near a spot: no house there.
  function nearDanger(p) {
    return (bot.companionDanger || []).some((d) => Math.hypot(d.x - p.x, d.z - p.z) < 80)
      || (memory.abandonedSites || []).some((a) => Math.hypot(a.x - p.x, a.z - p.z) <= 40);
  }

  const readSite = (x, y, z) => blockAt(new Vec3(x, y, z));

  function siteSearch(state, adaptation, wide = false) {
    const protectedCell = (p) => bot.companionPlayerBlock?.(p);
    const avoid = (p) => nearDanger(p) || adaptation?.avoids('rejected_site', p) || bot.companionNearPlayerBuild?.(p);
    if (!autonomous || !adaptation) return { protectedCell, avoid };
    const stock = budget(state.inventory), wood = supply('roof', stock, {}).primary;
    let access;
    return { protectedCell, avoid, access(house) {
      if (!access) {
        const logs = (bot.findBlocks?.({ matching: b => b && kb.log.match(b.name), maxDistance: wide ? 88 : 56, count: 192 }) || [])
          .filter(p => !protectedCell(p) && !adaptation.avoids('hard_route', p));
        access = drySiteAccess(blockAt, state.position, logs);
      }
      return access(house, wood >= 23 && (wood + supply('roof', stock, {}, true).available
        >= house.blocks.filter(b => b.purpose === 'roof').length + 23));
    } };
  }

  function findSite(state, searches, methods, radius, step) {
    for (const method of methods) {
      const site = method === 'hillside' ? chooseHillside(readSite, state.position, searches)
        : chooseSite(readSite, state.position, { ...searches, radius, step, variant: method === 'compact' ? 'compact' : 'starter',
          maxWork: method === 'near_flat' ? 12 : 32 });
      if (site) return site;
    }
    return null;
  }

  function adoptSite(ctx, site, method) {
    memory.house = createStarterHouse(site.anchor, method ? site : undefined);
    memory.relocation = null;
    if (method) memory.homesteadRoute = null;
    ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs,
      ...(method && { method, variant: site.variant, route: site.route }) });
    return method ? { ok: true, progress: false } : { ok: true };
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
      if (returned.wait || ['start', 'interrupted'].includes(returned.kind) || returned.facts?.adaptation) return returned;
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
      outcome = ctx.adapt.outcome(p, failure('site_rejected', { originalReason: reason }, ctx, bot));
    }
    const walls = memory.house.blocks.filter(b => b.phase === 'walls');
    const builtWalls = walls.filter(b => {
      const block = blockAt(b.position);
      return block && matchesBuilding(b, block.name, block);
    }).length;
    if (walls.length && builtWalls * 2 >= walls.length) {
      ctx.record('home_site_abandon_pending', { anchor, reason, builtWalls, walls: walls.length });
    }
    ctx.record('site_abandoned', { anchor, reason, built: memory.houseBuilt || 0 });
    // Autonomous goals use the expiring, world-persistent rejected_site lesson.
    if (!ctx.adapt) memory.abandonedSites = [...(memory.abandonedSites || []), anchor].slice(-16);
    const movements = bot.pathfinder?.movements;
    if (movements && memory.protect) movements.exclusionAreasBreak = movements.exclusionAreasBreak.filter((f) => f !== memory.protect);
    if (bot.companionProtectBlock === memory.protectBlock) bot.companionProtectBlock = null;
    if (bot.companionHomeSite === memory.homeSite) bot.companionHomeSite = null;
    bot.companionChest = null;
    bot.companionSurfaceY = undefined;
    Object.assign(memory, {
      house: null, protect: null, homeSite: null, established: false, siteDigs: 0, houseBuilt: 0, houseBed: false,
      relocate: false, explore: {}, exploreStreak: 0, scaffoldActive: false,
      relocation: { anchor, attempt: 0 }, siteAccessFailures: 0,
      furnace: { item: null, input: 0, output: 0 }, validated: false,
      owned: {}, temporary: {}, cleanupRequested: false,
      materialFallbacks: {},
    });
    ctx.adapt?.teach('rejected_site', anchor, 'overworld', failure('site_rejected', { originalReason: reason }, ctx), 32);
    for (const key of Object.keys(memory.verified)) memory.verified[key] = false;
    retryAt = { conversion: {} };
    skipped.clear();
    reportedUpgradeBlocks.clear();
    verifiedParts.clear();
    memory.upgradesComplete = false;
    return { ...outcome, ok: true, abandoned: true, progress: false };
  }

  async function relocateSite(ctx, state, origin, method) {
    const retry = !method && memory.relocation;
    if (retry?.retryAt > Date.now()) return waiting('relocation_routes_exhausted', retry.retryAt);
    if (retry?.retryAt) Object.assign(retry, { attempt: 0, retryAt: 0 });
    const up = await surfaceFirst(ctx);
    if (up) return up;
    if (retry) return relocateAway(ctx, retry);
    const route = (memory.homesteadRoute ||= { heading: 0,
      bearing: Math.atan2(state.position.z - origin.z, state.position.x - origin.x) });
    const exhausted = () => failure('relocation_routes_exhausted', { origin, travelled: (route.distance ?? 0) + (route.revisitDistance ?? 0),
      bestCandidate: route.best?.anchor ?? null, rejectedBecause: route.best?.rejectedBecause ?? null,
      attempted: [method] }, ctx);
    const travel = { ...ctx, dryRoute: true, ...explorationScope(ctx, origin, 200), exploration: undefined };
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const searches = here => {
      const scan = siteSearch(here, ctx.adapt, true);
      return { ...scan, avoid: p => !travel.workArea(p) ? 'relocation_radius' : scan.avoid(p) };
    };
    while (route.heading < OUTWARD_HEADINGS.length && (route.distance || 0) < 593) {
      let last = bot.entity.position.clone();
      const from = last, started = Date.now(), heading = route.heading, candidates = [];
      const measured = () => {
        const now = bot.entity.position;
        route.distance = (route.distance || 0) + distance(last, now);
        last = now.clone();
        return route.distance < 599 && distance(now, origin) <= 200;
      };
      if (route.legHeading !== heading) Object.assign(route, { legHeading: heading, legs: 0 });
      const moved = await boundedWork(bot, travel, { timeoutMs: 15000, check: measured,
        limitResult: exhausted }, attempt =>
        outwardLeg(bot, attempt, actions, route, origin, { distance: Math.min(28, 598 - route.distance), bearing: route.bearing }));
      measured();
      const here = ctx.perceive(), displacement = distance(from, here.position);
      if (displacement > 0) memory.relocationAnchor = v(here.position);
      const usable = !here.inWater && (moved.ok && !moved.wait || displacement >= 16);
      let site;
      if (usable) {
        const review = (candidate, reason) => {
          candidates.push([posKey(candidate.anchor), candidate.variant, reason]);
          if (reason !== 'restricted' && reason !== 'relocation_radius'
            && Number.isFinite(candidate.cost) && (!route.best || candidate.cost < route.best.cost)) {
            route.best = { ...candidate, rejectedBecause: reason };
          }
        };
        site = findSite(here, { ...searches(here), review }, ['near_flat'], 52, 2);
      }
      const interrupted = ctx.signal?.aborted || moved.wait || ['start', 'interrupted'].includes(moved.kind) || moved.facts?.adaptation;
      const legs = interrupted && displacement < 1 ? route.legs : ++route.legs;
      if (route.heading === heading && (legs >= 8 || !interrupted && !moved.ok)) route.heading++;
      ctx.record('home_relocation_leg', { method, origin, from, position: here.position, distance: displacement, total: route.distance, heading, legs,
        candidates, inWater: here.inWater, ok: moved.ok, reason: moved.reason, result: moved, elapsedMs: Date.now() - started });
      if (interrupted) return moved;
      if (site) return adoptSite(ctx, site, method);
      if (usable) return finished(false, { moved: displacement });
    }
    const best = route.best;
    ctx.record('home_relocation_budget', { method, distance: route.distance, anchor: best?.anchor, candidatesExhausted: true });
    if (best) {
      const before = bot.entity.position.clone();
      if (distance(before, best.anchor) > 5) {
        const moved = await actions.goNear(bot, travel, v(best.anchor), 4, { timeoutMs: 45000, skipAdaptation: true });
        const offset = distance(before, bot.entity.position);
        route.revisitDistance = (route.revisitDistance || 0) + offset;
        if (offset > 0) memory.relocationAnchor = bot.entity.position.clone();
        if (!moved.ok || moved.wait) return moved;
      }
      const here = ctx.perceive();
      const site = findSite(here, searches(here), SITE_METHODS.slice(1), 16, 1);
      if (site) return adoptSite(ctx, site, method);
    }
    return exhausted();
  }

  async function relocateAway(ctx, retry) {
    const from = bot.entity.position.clone();
    const closest = (bot.companionDanger || []).filter(p => Math.hypot(from.x - p.x, from.z - p.z) < 80)
      .sort((a, b) => from.distanceTo(a) - from.distanceTo(b))[0] || retry.anchor;
    const turns = OUTWARD_HEADINGS.length;
    const angle = Math.atan2(from.z - closest.z, from.x - closest.x) + OUTWARD_HEADINGS[retry.attempt % turns] * Math.PI / 4;
    const end = outwardPoint(from, angle, retry.attempt < turns ? 24 : 12);
    ctx.record('recovery_switch', { task: 'homestead_site', to: 'outward_route', ...end, attempt: retry.attempt + 1 });
    const walk = walkOutward(bot, ctx, actions, end, 15000);
    const result = await walk.result;
    const moved = bot.entity.position.distanceTo(from);
    if (moved > 0) memory.relocationAnchor = bot.entity.position.clone();
    if (result.reason === 'aborted' || ctx.signal?.aborted) return result;
    if (result.ok && moved >= 6 && walk.goal.isEnd(bot.entity.position.floored())) return { ok: true, moved };
    if (++retry.attempt >= 2 * turns) retry.retryAt = Date.now() + 10 * 60_000;
    return result.ok ? { ok: false, reason: 'relocation_not_arrived' } : result;
  }

  const nearbyWoolMobs = () => Object.values(bot.entities || {}).some((e) => e.position
    && e.position.distanceTo(bot.entity.position) <= 24 && !huntExcluded(e)
    && ((e.name === 'sheep' && !skills.sheepWool?.(bot, e)?.sheared) || e.name === 'spider'));
  function wantsGuestBed(state) {
    if (!memory.established || Date.now() < (memory.guestBedRetryAt || 0)) return false;
    const hs = houseState();
    if (hs.placed.guestBed === true || (memory.upgradesComplete && hs.placed.guestBed === null)
      || hs.blocked.some((b) => b.item === 'guestBed')) return false;
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
    if (!bedsSafe(hs)) return null;
    if (hs.placed[id] === true) return { ok: true, already: true };
    const { position, head } = memory.house.furniture[id];
    const support = upgradeSupport(ctx, state, [position, head]);
    if (support) return support;
    if (countKey('bed', inventory, kb)) return placeBed(ctx, id, { requireAir: true });
    const stations = { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace };
    const step = plan(ctx, { requirements: [{ key: 'bed', count: 1 }], inventory, stations });
    if (!step || step.kind === 'blocked') return { ok: false, reason: 'bed_materials_unavailable' };
    if (step.kind !== 'hunt' || step.key !== 'wool') {
      memory.sheepScan = null;
      return (await returnForUpgrade(ctx)) || runPlannerStep(ctx, step, null);
    }
    const area = { position: memory.house.anchor, target: id === 'bed' ? 'primary' : 'guest' };
    async function huntSheep() {
      const radius = Math.min(128, nightBudget(ctx.perceive(), memory.house.interiorCenter).maxOutingDistance);
      if (radius <= 0) return waiting('waiting_for_safe_daylight');
      ctx.record('home_finish_step', { step: 'sheep_wool', item: id, radius });
      const fleece = woolPreference(inventory);
      const inArea = e => e.position?.distanceTo(v(area.position)) <= 128;
      const eligible = Object.values(bot.entities || {}).some(e => e.name === 'sheep' && inArea(e) && fleece.accept?.(e) !== false);
      const result = await skills.huntOne(bot, ctx, { mobs: ['sheep'], dropMatch: kb.wool.match, radius,
        targetGoal: 'homestead', ...fleece, accept: e => inArea(e) && fleece.accept?.(e) !== false });
      if (result.reason !== 'no_mob_in_range') return result.ok && !factsOf(result).gained ? { ok: false, reason: 'no_wool_collected' } : result;
      if (eligible) return waiting('no_eligible_sheep_near_home', Date.now() + 30_000);
      // A single entity snapshot only covers tracked mobs, not the search
      // radius. Look from dry ground in each accessible quarter first.
      const e = v(memory.house.entrance);
      const searched = (memory.sheepScan ||= []);
      const quarter = (p) => (p.x >= e.x ? 1 : 0) + (p.z >= e.z ? 2 : 0);
      const dry = dryComponent(blockAt, bot.entity.position, 40);
      const look = [...dry.values()].filter(p => !searched.includes(quarter(p))
        && p.distanceTo(e) >= 25 && p.distanceTo(e) <= 44
        && p.distanceTo(bot.entity.position) >= 12 && p.distanceTo(bot.entity.position) <= radius)
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
      const radius = Math.min(48, nightBudget(ctx.perceive(), memory.house.interiorCenter).maxOutingDistance);
      if (radius <= 0) return waiting('waiting_for_safe_daylight');
      const home = await returnForUpgrade(ctx);
      if (home) return home;
      ctx.record('home_finish_step', { step: 'spider_string', item: id });
      const result = await skills.huntOne(bot, ctx, { mobs: ['spider'], dropMatch: kb.string.match, radius,
        targetGoal: 'homestead', accept: e => e.position.distanceTo(v(area.position)) <= 48 });
      if (result.reason === 'no_mob_in_range') return waiting('no_spider_near_home', Date.now() + 30_000);
      return result.ok && !factsOf(result).gained ? { ok: false, reason: 'no_string_collected' } : result;
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
      return { ok: false, reason: 'bed_hunt_exhausted' };
    }, { learn: (result, attempt) => attempt.method === 'sheep' && result.reason === 'no_mob_in_range'
      ? { kind: 'no_sheep', position: area.position, radius: 128 } : null });
  }

  function upgradeGoal(name, isDone, work) {
    let steps = 0;
    const advance = result => { steps++; return result; };
    return { name, isDone, progress: () => steps, run: ctx => work(ctx, advance, steps) };
  }

  function guestBedGoal() {
    let done = false;
    const placed = () => done || Boolean(memory.house && houseState().placed.guestBed === true);
    return upgradeGoal('guest_bed', placed, async (ctx, advance, steps) => {
      if (autonomous) {
        const result = await bedUpgrade(ctx, 'guestBed') || waiting('roof_not_ready_for_bed');
        if (result.facts?.target?.excluded) memory.guestBedRetryAt = Date.now() + 5 * 60_000;
        return isComplete(result) ? advance(result) : result;
      }
      const state = ctx.perceive(), { inventory } = state;
      if (wantsGuestBed(state) && steps < 12) {
        let result;
        if (countKey('bed', inventory, kb)) result = await placeBed(ctx, 'guestBed', { requireAir: true });
        else {
          const step = plan(ctx, { requirements: [{ key: 'bed', count: 1 }], inventory, stations: { crafting_table: true } });
          if (step?.kind === 'hunt') {
            result = await runPlanned(ctx, step, async attempt => {
              const hunt = (mobs, match, options) => skills.huntOne(bot, attempt, { mobs, dropMatch: match, radius: 24, ...options });
              const sheep = await hunt(['sheep'], kb.wool.match, woolPreference(inventory));
              return sheep.reason === 'no_mob_in_range' ? hunt(['spider'], kb.string.match) : sheep;
            });
          } else if (step && step.kind !== 'gather') result = await runPlannerStep(ctx, step, null);
        }
        if (isComplete(result)) return advance(result);
        if (result?.wait || result?.kind === 'start' || result?.facts?.adaptation) return result;
      }
      memory.guestBedRetryAt = Date.now() + 5 * 60_000;
      done = true;
      return { ok: true, skipped: 'guest_bed_optional' };
    });
  }

  function wantsLighting(state) {
    if (!memory.established) return false;
    if (autonomous) {
      const hs = houseState();
      return hs.torches.length > 0 || (!memory.upgradesComplete && memory.house.furniture.torches.some(p => !blockAt(p)));
    }
    if (!state.isDay) return false;
    const { x, y, z } = memory.house.anchor;
    if (bot.entity.position.distanceTo(new Vec3(x, y, z)) > 16) return false;
    const bag = state.inventory;
    return houseState().torches.length > 0 && ((bag.torch || 0) > 0
      || ((bag.coal || 0) + (bag.charcoal || 0) > 0 && (bag.stick || 0) > 0));
  }

  function upgradeSupport(ctx, state, cells) {
    const support = cells.map(below).find(p => !supports(blockAt(p)));
    if (!support) return null;
    if (!blockAt(support)) return waiting('lighting_site_unloaded');
    if (countKey('filler', state.inventory, kb)) return placeRecorded(ctx, support, fillMatch(), 'foundation', { requireAir: true });
    const step = plan(ctx, { requirements: [{ key: 'dirt', count: 1 }], inventory: state.inventory, stations: {} });
    return step ? runPlannerStep(ctx, step, null) : waiting('lighting_materials_unavailable');
  }

  function lightingGoal() {
    const placed = () => Boolean(memory.house?.furniture.torches.every(torchAt));
    return upgradeGoal('home_lighting', placed, async (ctx, advance) => {
      const transit = autonomous && await returnForUpgrade(ctx);
      if (transit) return transit;
      const hs = houseState(), state = ctx.perceive(), [torch] = hs.torches;
      if (!torch) return waiting(hs.blocked.find(b => b.item === 'torch')?.reason || 'lighting_site_unloaded');
      const support = upgradeSupport(ctx, state, [torch]);
      if (support) return support;
      if ((state.inventory.torch || 0) > 0) {
        const result = await placeRecorded(ctx, torch, n => n === 'torch', 'torch', { faces: DOWN, requireAir: true, passable: true });
        return result.ok ? advance(result) : result;
      }
      const step = plan(ctx, { requirements: [{ key: 'torch', count: hs.torches.length }], inventory: state.inventory,
        stations: { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace } });
      if (!step || step.kind === 'blocked' || (!autonomous && step.kind !== 'craft')) {
        return waiting('lighting_materials_unavailable', Date.now() + 30_000);
      }
      ctx.record('home_finish_step', { step: step.kind, material: step.key, for: 'torch', missing: hs.torches.length });
      const result = await runPlannerStep(ctx, step, null);
      return isComplete(result) ? advance(result) : result;
    });
  }

  function nearHouseTable() {
    const spot = memory.house?.furniture.crafting_table.position;
    return Boolean(spot) && nameAt(spot) === 'crafting_table'
      && bot.entity.position.distanceTo(new Vec3(spot.x + 0.5, spot.y, spot.z + 0.5)) <= 6;
  }

  async function placePortableTable(ctx) {
    const result = await placeStation(bot, ctx, { skills, avoid: nearHouseColumn, from: 1, to: 6,
      columns: r => [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] });
    if (!isComplete(result)) return result;
    ctx.record('portable_table', { action: 'place', position: posKey(result.position) });
    return { ok: true, position: result.position };
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

  function surfaceFirst(ctx) {
    const feet = bot.entity.position.floored();
    if (memory.house && feet.y === memory.house.anchor.y && insideRoom(feet) && supports(blockAt(below(feet)))) return null;
    return surface(bot, ctx, actions);
  }

  async function placeCompactRoof(ctx, position, match, placeTile) {
    const [base, upper] = memory.house.scaffold;
    const peak = new Vec3(upper.x, upper.y + 1, upper.z);
    const centreTile = position.x === peak.x && position.z === peak.z;
    const pillarUp = require('../end').pillarUp;
    const stop = () => {
      const p = bot.entity.position.floored();
      return p.x !== peak.x || p.z !== peak.z || bot.companionPlayerBlock?.(upper) || bot.companionPlayerBlock?.(peak);
    };
    if (centreTile && bot.entity.position.y < peak.y + 0.9) {
      const feet = nameAt(upper) && filler(nameAt(upper)) ? peak : peak.offset(0, -1, 0);
      const onStep = new goals.GoalBlock(feet.x, feet.y, feet.z);
      if (!filler(nameAt(base)) || bot.companionPlayerBlock?.(upper) || bot.companionPlayerBlock?.(peak)) {
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
        if (!/^(air|cave_air)$/.test(nameAt(upper) || '') || !pickItem('filler', bot.inventory.items())) {
          return { ok: false, reason: 'roof_step_needs_filler' };
        }
        await actions.recentre(bot, ctx);
        try {
          await pillarUp(bot, ctx, peak.y, { maxSteps: 2, blocks: { test: fillMatch() }, stop });
        } finally {
          if (filler(nameAt(upper))) ownedRecord('scaffold', upper);
        }
        if (!filler(nameAt(upper)) || bot.entity.position.y < peak.y - 0.1) return { ok: false, reason: 'roof_step_unconfirmed' };
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
    const placed = await placeTile();
    if (placed.ok || centreTile || !['not_arrived', 'NoPath', 'Timeout', 'no_progress'].includes(placed.reason)) return placed;
    if (bot.entity.position.y < peak.y + 0.9) return placed;
    // An occluded corner may be visible from another roof panel after the
    // inner tiles connect the deck. Move on the finished panels, not off it.
    const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => new Vec3(position.x + dx, position.y, position.z + dz))
      .filter((p) => placedFor('roof', nameAt(p)))
      .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    for (const panel of adjacent.slice(0, 2)) {
      const stand = panel.offset(0, 1, 0);
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 5000, retryNoProgress: false });
      if (!moved.ok) continue;
      const retry = await placeTile();
      if (retry.ok || retry.kind !== 'target') return retry;
    }
    return placed;
  }

  async function placeRecorded(ctx, position, match, what, options = {}) {
    ctx = createAttempt(ctx);
    const up = await surfaceFirst(ctx);
    if (up) return up;
    const original = position;
    const site = furnitureSpot(what, position, options);
    if (site) {
      position = site.position;
      options = site.options;
    }
    let placements = 0;
    const place = async (p = position, opts = options) => {
      if (!site) return failure('furniture_blocks_exit', { ...room({ occupy: [p, ...(opts.alsoClear || [])] }).obstruction,
        furniture: what }, ctx);
      const matchesPlaced = opts.purpose ? n => placedFor(opts.purpose, n) : match;
      if ([p, ...(opts.alsoClear || [])].some(q => bot.companionPlayerBlock?.(q) && !matchesPlaced(nameAt(q)))) {
        return { ok: false, reason: 'protected_player_block' };
      }
      // A distant hunt/mining trip needs one long walk before local placement.
      if (bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y, p.z + 0.5)) > 12) {
        ctx.record('return_home', { for: what });
        const back = await actions.goNear(bot, autonomous ? { ...ctx, dryRoute: true } : ctx,
          v(memory.house.entrance), 3, { timeoutMs: 90000 });
        if (!back.ok) return back;
      }
      if (opts.stand && !safeStand(blockAt, opts.stand)) return { ok: false, reason: 'unsafe_build_stand' };
      const placeTile = async () => {
        const retry = placements++ > 0;
        const at = posKey(p);
        const alreadyPlaced = matchesPlaced(nameAt(p)) && (!opts.verify || opts.verify());
        const inventory = ctx.perceive().inventory;
        const selection = opts.purpose && supply(opts.purpose, materialStock(houseState(ctx), inventory), memory.materialFallbacks);
        ctx.record('build', { attemptId: ctx.attemptId, what, position: at, retry, ...(selection ? { material: selection.item } : {}) });
        if (alreadyPlaced) return finished(false);
        if (selection && !selection.item) {
          const result = failure('no_material', { need: { [opts.purpose]: 1 }, carried: inventory, position: at }, ctx, bot);
          ctx.record('home_material_place_failed', { attemptId: ctx.attemptId, purpose: opts.purpose, what, position: at, ...selection, result });
          return result;
        }
        const chosen = selection ? n => n === selection.item : match;
        return resultFrom(await skills.placeAt(bot, ctx, p, chosen, { ...opts, materialNeed: selection?.item || what }), ctx, bot);
      };
      const chosen = opts.selection ? n => n === opts.selection.item : match;
      const result = what === 'roof' && memory.house.variant === 'compact' && !memory.established
        ? resultFrom(await placeCompactRoof(ctx, p, chosen, placeTile), ctx, bot) : await placeTile();
      if (isComplete(result) && site.changed && posKey(p) === posKey(site.position)) {
        memory.house.furniture[what] = site.changed;
        ctx.record('home_furniture_moved', { item: what, from: posKey(original), to: posKey(p) });
      }
      if (result.progress && ['scaffold', 'wall', 'roof'].includes(what) && matchesPlaced(nameAt(p))) ownedRecord(what, p);
      if (what === 'roof' && result.ok && !houseState(ctx).missing.some(b => b.phase === 'roof')) {
        memory.scaffoldActive = false;
        memory.cleanupRequested = scaffoldEntries().length > 0;
      }
      return result;
    };
    const groundCover = (q) => naturalCover(blockAt(q)) && supports(blockAt(below(q))) && !bot.companionPlayerBlock?.(q);
    async function recover(initial) {
      const { reason } = initial;
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
            const moved = await place(bed.position, { ...options, ...bedOptions(bed) });
            if (moved.ok) memory.house.furniture.guestBed = bed;
            return moved;
          }
        }
      }
      if (['occupied', 'protected_player_block', 'no_support', 'furniture_blocks_exit'].includes(reason)) return initial;
      const entrance = memory.house.entrance;
      const exteriorLight = what === 'torch' && position.z < memory.house.anchor.z;
      if ((exteriorLight || (options.stand && posKey(options.stand) === posKey(entrance)))
        && (await crossDoorstep(ctx)).ok) return place(position, { ...options, stand: entrance });
      const walked = await alternateStand(bot, ctx, actions, options.stand || position,
        { avoid: q => optionalStep(what) && idAt(memory.house.furniture.torches, q) });
      return walked.ok ? place() : initial;
    }
    const first = resultFrom(await place(), ctx, bot);
    const recoverable = targetFailure(first) || (first.kind === 'environment' && first.reason === 'place_unconfirmed');
    const result = recoverable ? resultFrom(await recover(first), ctx, bot) : first;
    // The functional house may now finish as soon as this door is placed.
    if (what === 'door' && result.progress) await setDoor(ctx, true);
    if (ctx.adapt && !memory.pinned && !memory.established && result.progress && memory.searchOrigin) {
      ctx.adapt.outcome(ctx.adapt.plan('home_site', { position: memory.searchOrigin }), result);
    }
    if (ctx.adapt && !memory.pinned && !memory.established && targetFailure(result) && memory.searchOrigin
      && ['place_unconfirmed', 'not_arrived', 'NoPath', 'no_support'].includes(result.reason)
      && (memory.houseBuilt || 0) < memory.house.blocks.length * 0.75) {
      const route = ctx.adapt.plan('home_site', { position: memory.searchOrigin });
      const outcome = ctx.adapt.outcome(route, result);
      if (outcome.facts?.adaptation?.switched) {
        const abandoned = await abandonSite(ctx, result.reason, true);
        return abandoned.ok ? resultFrom(abandoned, ctx, bot) : abandoned;
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
        && Math.hypot(bot.entity.position.x - candidate.x - 0.5, bot.entity.position.z - candidate.z - 0.5) < 0.25),
      { timeoutMs: 1300, signal: ctx.signal, intervalMs: 25 });
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
    const feet = () => bot.entity.position.floored(), aisle = e.offset(0, 0, 2);
    const origin = feet();
    if (insideRoom(origin) && safeStand(blockAt, origin) && await waitUntil(() => bot.entity.onGround
      && feet().equals(origin) && Math.abs(bot.entity.position.y - origin.y) < 0.1,
    { timeoutMs: 1000, signal: ctx.signal, intervalMs: 25 })) {
      const { cells, next, known } = room();
      if (known && cells.has(posKey(feet())) && !next.has(posKey(feet()))) return failure('interior_cut_off', {}, ctx, bot);
      let step;
      while (!feet().equals(aisle) && (step = next.get(posKey(feet()))) && insideRoom(step)) {
        if (!(await walkOne(ctx, step)).ok) break;
      }
      if (feet().equals(aisle) && (await crossDoorstep(ctx)).ok) return { ok: true };
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
    if (!memory.materialFallbacks.roof || !memory.established || state.isDay !== true || state.sheltered
      || state.hostiles?.some(h => h.distance <= 8)) return null;
    const at = bot.entity.position;
    const cap = roofCap();
    const hs = houseState();
    if (hs.unknown.length || memory.breach || !complete(state, hs) || !status(state).finished) return null;
    const remaining = memory.house.blocks.filter(b => b.purpose === 'roof'
      && matchesRoofFallback(nameAt(b.position)) && stillOwned(memory.owned[posKey(b.position)], blockAt(b.position)));
    const planks = countMatching(state.inventory, matchesRoofWood);
    // Enough to finish all owned panels, one temporary cap, and an eight-plank reserve.
    if (cap ? planks < Number(!matchesRoofWood(nameAt(cap.roof))) : planks < remaining.length + 9) return null;
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
    const material = matchesRoofWood;
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
    if (memory.house.blocks.every(b => b.purpose !== 'roof' || !matchesRoofFallback(nameAt(b.position))
      || !stillOwned(memory.owned[posKey(b.position)], blockAt(b.position)))) setFallback(memory.materialFallbacks, 'roof');
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
        return withoutDigging(bot.pathfinder?.movements, async () => {
          if (!bot.entity.position.floored().equals(stand)) {
            const moved = await actions.goTo(bot, { ...ctx, nearDestination: true }, new goals.GoalBlock(stand.x, stand.y, stand.z),
              { timeoutMs: 5000, retryNoProgress: false });
            if (!moved.ok) return resultFrom({ ...moved, facts: { ...moved.facts, terminal: true } }, ctx, bot);
          }
          const result = await replaceRoofPanel(ctx, work);
          replaced = result.ok;
          return replaced || ctx.signal?.aborted ? result : resultFrom({ ...result, facts: { ...result.facts, terminal: true } }, ctx, bot);
        });
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
    const action = { ...ctx, rescue: 'home_escape' };
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
      const filled = await skills.placeAt(bot, action, missing, fillMatch(), { requireAir: true });
      if (!filled.ok || supports(blockAt(missing))) return filled;
      return { ok: false, reason: 'home_access_repair_unconfirmed' };
    }
    if (memory.pinned) return { ok: false, reason: 'home_access_requires_owner' };

    const anchor = house.anchor;
    const abandoned = await abandonSite(ctx, reason, true);
    if (!abandoned.ok || memory.house) return abandoned;
    ctx.record('home_access_relocated', { anchor, reason, block, position: posKey(obstruction) });
    return failure('home_site_relocated', { terminal: true }, ctx);
  }

  async function escapeHome(ctx) {
    const rescue = { ...ctx, rescue: 'home_escape' };
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
    if (surfaced?.wait) return surfaced;
    if (isComplete(surfaced) && bot.entity.position.distanceTo(initial) >= 2) {
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

  async function enterShelter(ctx) {
    const e = memory.house?.entrance, at = bot.entity.position;
    if (!e || insideRoom(at.floored()) || at.z > e.z + 1 || Math.abs(at.y - e.y) > 1
      || Math.hypot(at.x - e.x - 0.5, at.z - e.z - 0.5) > 6) return null;
    if (doorOpen() === false) {
      const opened = await setDoor(ctx, true);
      if (opened && !isComplete(opened)) return opened;
    }
    return crossDoorstep(ctx, true);
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
      if (result.ok || factsOf(result).spawnSet) {
        memory.verified[id] = true;
      }
      if (factsOf(result).spawnSet && !result.ok) return { ok: true, spawnSet: true };
      return result;
    }
    if (!memory.verified.crafting_table) {
      ctx.record('verify', { furniture: 'crafting_table' });
      const result = await skills.craft(bot, ctx, { item: 'stick', times: 1, tablePosition: f.crafting_table.position });
      if (result.ok && factsOf(result).usedTable) memory.verified.crafting_table = true;
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
      retryAt = { conversion: {} };
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
    work(state, inventory) {
      if (!memory.house || memory.established) return null;
      const hs = houseState(), tasks = buildTasks(hs);
      const remaining = hs.missing.length + hs.foundationMissing.length + tasks.filter(task => !task.purpose).length;
      if (!inventory && remaining > 2) return { remaining, ready: false };
      inventory ??= state.inventory;
      const stock = materialStock(hs, inventory);
      const usable = new Map();
      let available = 0;
      for (const task of tasks) {
        const have = usable.get(task.material) ?? (task.purpose
          ? supply(task.purpose, stock, memory.materialFallbacks).available : countKey(task.material, inventory, kb));
        if (have > 0) { available++; usable.set(task.material, have - 1); }
      }
      return { remaining, ready: available >= remaining, readiness: remaining ? available / remaining : 1,
        position: memory.house.anchor };
    },
    maintenance,
    observeParts,
    repairPart,
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
    shelterSite: () => {
      const house = memory.house;
      if (!house || !(memory.established || memory.houseBuilt >= house.blocks.length && doorOpen() !== null)) return null;
      const at = bot.entity.position;
      return { house, inside: at.y >= house.anchor.y - 0.05 && insideRoom(at.floored()),
        covered: () => doorOpen() === false && house.blocks.every(b =>
          !['walls', 'roof'].includes(b.phase) || matchesBuilding(b, nameAt(b.position), blockAt(b.position))) };
    },
    shelterDoor: (ctx, open) => {
      if (!memory.house || !insideRoom(bot.entity.position.floored())) return null;
      return doorOpen() === open ? { ok: true, already: true } : setDoor(ctx, open);
    },
    isDone: (state) => complete(state),
    optionalMaintenance: !autonomous,
    progress: () => memory.steps,
    async run(ctx) {
      if (memory.recovery) return recoverToward(bot, ctx, actions, memory, memory.house?.entrance);
      const result = await runOnce(ctx);
      // Waiting (for dusk, out the night) is not progress: counting it would
      // refill the stall budget of a step that keeps failing every morning.
      if (isComplete(result)) {
        memory.steps += 1;
        if (!factsOf(result).moved) memory.exploreStreak = 0;
      }
      return result;
    },
  };

  async function runOnce(ctx) {
    let state = ctx.perceive();
    if (memory.cleanupRequested) return clearScaffold(ctx);
    if (ctx.adapt && !memory.pinned && !memory.established && memory.house && !memory.searchOrigin) {
      memory.searchOrigin = v(memory.house.anchor);
    }
    if (memory.relocate && memory.house && !memory.pinned && !memory.established) return abandonSite(ctx, 'repeated_nearby_deaths');
    if (!memory.house) {
      if (ctx.adapt && !memory.pinned) {
        if (memory.relocation?.candidate) {
          const chosen = await useScoutedSite(ctx, state);
          if (chosen) return chosen;
          state = ctx.perceive();
        }
        const origin = (memory.searchOrigin ||= spawn || bot.entity.position.clone());
        return ctx.adapt.run('home_site', { position: origin }, async (method) => {
          let site;
          if (method === 'relocate' || method === 'move_to_fresh_area') return relocateSite(ctx, state, origin, method);
          site = findSite(state, siteSearch(state, ctx.adapt), [method]);
          if (!site) return fail('no_suitable_site', { objective: origin, position: state.position, attempted: [method] });
          return adoptSite(ctx, site, method);
        });
      }
      const site = chooseSite(readSite, near || state.position, siteSearch(state, ctx.adapt));
      if (!site) return memory.relocation?.anchor ? relocateSite(ctx, state) : explore(ctx, 'site');
      return adoptSite(ctx, site);
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
    const work = siteWork(readSite, workSite(), (p, block) => expectedAt(p)(block.name, block));
    const site = await siteStep(ctx, work);
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
    // Stone tools first, then a few pieces of food so lost health can be eaten back.
    const early = gear.filter((key) => EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    // A spare table in the bag, once the house has its own: four planks spare
    // every climb out of a quarry to craft a tool.
    // Not while it is set aside as unavailable (no tree in reach): re-added at
    // once, it was "skipped" twice a second for good.
    const fallbackRoofOpen = memory.materialFallbacks.roof && hs.missing.some(b => b.purpose === 'roof');
    if (hs.placed.crafting_table && !isSkipped('crafting_table') && !fallbackRoofOpen) {
      early.unshift({ key: 'crafting_table', count: 1, optional: true });
    }
    if (!hs.placed.door && hs.placed.crafting_table && !countKey('door', inventory, kb)) {
      const door = plan(ctx, { requirements: [{ key: 'door', count: 1 }], inventory, stations });
      if (door?.kind === 'craft' && door.key === 'door') return runPlannerStep(ctx, door, null);
    }
    const earlyStep = plan(ctx, { requirements: early, inventory, stations });
    if (earlyStep && earlyStep.kind !== 'blocked') {
      const result = await runPlannerStep(ctx, earlyStep, early.find(r => r.key === earlyStep.for));
      if (!['furniture_blocks_exit', 'no_table_spot'].includes(result.reason)) return result;
    }
    // Raw meat is worth two to three times as much cooked: once the furnace
    // stands, a few pieces in the bag go into it before anything else.
    if (hs.placed.furnace) {
      const raw = RAW_MEATS.map((name) => [name, state.inventory[name] || 0]).sort((x, y) => y[1] - x[1])[0];
      const fuel = Object.keys(state.inventory).some((n) => n === 'coal' || n === 'charcoal' || kb.planks.match(n) || kb.log.match(n));
      if (raw[1] >= 3 && fuel && !(retryAt.cook > Date.now())) {
        ctx.record('cook', { item: raw[0], count: raw[1] });
        const cooked = await skills.smelt(bot, ctx, { input: raw[0], count: Math.min(raw[1], 8),
          furnacePosition: memory.house.furniture.furnace.position, memory: memory.furnace });
        memory.furnace.item = raw[0];
        if (isComplete(cooked)) memory.verified.furnace = true;
        else if (!cooked.wait) retryAt.cook = Date.now() + 120000;
        return cooked;
      }
    }
    // Then the bed, placed at its spot in the future house: from the first
    // night on, the bot sleeps through the dark and respawns at home.
    if (!autonomous && bedsSafe(hs) && !hs.placed.bed && !isSkipped('wool') && !(retryAt.earlyBed > Date.now())) {
      if (countKey('bed', state.inventory, kb) > 0) {
        const placed = await placeBed(ctx, 'bed');
        // An animal in the way or uneven ground: build on and come back to it.
        if (!placed.ok) retryAt.earlyBed = Date.now() + 120000;
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
    const tasks = buildTasks(hs), stock = materialStock(hs, state.inventory);
    const ready = await buildStep(ctx, tasks, state.inventory, stock, { whenBatchReady: true });
    if (ready) return ready;
    const material = tasks.find(task => task.purpose);
    const action = material && !work.fills.length && await materialStep(ctx, material, hs);
    if (action && !action.wait) return action;
    const reqs = requirements(state, hs, work);
    const step = plan(ctx, { requirements: reqs, inventory, stations });
    if (step && step.kind !== 'blocked') return runPlannerStep(ctx, step, reqs.find(r => r.key === step.for));
    const build = await buildStep(ctx, tasks, state.inventory, stock, { whenBatchReady: false });
    if (build) return build;
    if (action) return action;
    if (step || earlyStep) return runPlannerStep(ctx, step || earlyStep, null);
    if (tasks.length) return { ok: false, reason: 'build_blocked' };
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
