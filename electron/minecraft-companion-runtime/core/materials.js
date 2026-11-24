'use strict';
// What a blueprint still needs, as planner requirements. Pure: reads the world
// through `nameAt` and counts every block that is not in place yet, so a
// half-built machine only asks for what is missing.
//
// A blueprint block is { position, family } where family is a knowledge key
// (cobblestone, hopper, water_bucket...). Liquids are placed from buckets, so
// a water_bucket block counts as placed when the cell holds water.

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];

const PLACED_AS = { water_bucket: 'water', lava_bucket: 'lava' };

function isPlaced(block, name, kb) {
  if (!name) return false;
  if (typeof block.placed === 'function') return block.placed(name);
  if (PLACED_AS[block.family]) return name === PLACED_AS[block.family];
  return kb[block.family].match(name);
}

/** Requirements ({ key, count }) for every blueprint block not yet in place, in blueprint order. */
function materialsFor(blocks, nameAt, kb = require('./knowledge').KNOWLEDGE) {
  const totals = new Map();
  for (const block of blocks) {
    if (!kb[block.family]) throw new Error(`Unknown material ${block.family}`);
    if (isPlaced(block, nameAt(block.position), kb)) continue;
    totals.set(block.family, (totals.get(block.family) || 0) + 1);
  }
  return [...totals].map(([key, count]) => ({ key, count }));
}

function materialWork(requirements, inventory, kb) {
  const { countKey } = require('./knowledge');
  const totals = new Map();
  for (const { key, count } of requirements) totals.set(key, (totals.get(key) || 0) + count);
  let needed = 0, available = 0;
  for (const [key, count] of totals) {
    needed += count;
    available += Math.min(count, countKey(key, inventory, kb));
  }
  return { ready: available === needed, readiness: needed ? available / needed : 1, remaining: needed };
}

const SANDSTONE = Object.freeze({ sand: 'sandstone', red_sand: 'red_sandstone' });
const STONE = ['stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'calcite'];
const PLANKS = [...WOODS, 'crimson', 'warped', 'bamboo'].map(wood => wood + '_planks');
const MASONRY = ['cobblestone', ...STONE, 'cobbled_deepslate', ...Object.values(SANDSTONE)];
const EARTH = ['dirt', 'coarse_dirt', 'rooted_dirt'];
const FILL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'coarse_dirt', 'netherrack'];
const RULES = {
  wall: [MASONRY, EARTH, 'cobblestone'],
  roof: [PLANKS, [...MASONRY, ...EARTH], 'log'],
  filler: [FILL, [], 'dirt'],
  seal: [[...FILL, ...Object.values(SANDSTONE)], [], 'dirt'],
};
RULES.cave_wall = RULES.wall;
const accepts = (purpose, name) => RULES[purpose][0].includes(name) || RULES[purpose][1].includes(name);
const filler = name => accepts('filler', name);
const seal = name => accepts('seal', name);
const matchesRoofWood = name => RULES.roof[0].includes(name);
const matchesRoofFallback = name => RULES.roof[1].includes(name);
const stableSolid = block => block?.boundingBox === 'block'
  && !/^(water|lava|bubble_column|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|.*_anvil|dragon_egg)$/.test(block.name);
const isSealSoil = name => /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium)$/.test(name);
const isSealRock = name => /^(stone|cobblestone|deepslate|cobbled_deepslate|sandstone|red_sandstone)$/.test(name);
const naturalWall = block => stableSolid(block) && (accepts('cave_wall', block.name)
  || /^(grass_block|podzol|mycelium|mud|clay|terracotta|.*_terracotta|calcite|tuff|dripstone_block|basalt|blackstone|netherrack)$/.test(block.name));
const placedFor = (purpose, name, block) => accepts(purpose, name) || (purpose === 'cave_wall' && naturalWall(block));

function pickItem(purpose, items) {
  for (const name of RULES[purpose][0]) {
    const item = items.find(stack => stack.name === name && (stack.count ?? 1) > 0);
    if (item) return item;
  }
}

// Keep recipe ingredients in their original stacks. Worst case for a
// building's reserve is that the only stack able to craft an item is also the
// preferred building material, so reserve that stack first.
function budget(inventory, { wood = 0, stone = 0, canConvert = () => true } = {}) {
  const carried = { ...inventory }, craftable = {};
  for (const [item, count] of Object.entries(inventory)) {
    const wood = item.replace(/^stripped_/, '').match(/^(.+)_(?:log|wood|stem|hyphae)$/)?.[1];
    const bamboo = /^(?:stripped_)?bamboo_block$/.test(item);
    const name = SANDSTONE[item] || (bamboo ? 'bamboo_planks' : wood && `${wood}_planks`);
    if (!name || (!SANDSTONE[item] && !PLANKS.includes(name)) || !canConvert(name)) continue;
    const yields = SANDSTONE[item] ? 1 : bamboo ? 2 : 4;
    craftable[name] ||= { count: 0, yields };
    craftable[name].count += SANDSTONE[item] ? Math.floor(count / 4) : count * yields;
  }
  const reserve = (names, count) => {
    for (const name of names.sort((a, b) => total(b) - total(a))) {
      const kept = Math.min(count, carried[name] || 0);
      carried[name] = (carried[name] || 0) - kept;
      count -= kept;
      if (craftable[name]) {
        const converted = Math.min(count, craftable[name].count);
        craftable[name].count -= converted;
        count -= converted;
      }
    }
  };
  const total = name => (carried[name] || 0) + (craftable[name]?.count || 0);
  reserve([...PLANKS], wood);
  reserve(['cobblestone', 'cobbled_deepslate'], stone);
  return { carried, craftable, total };
}

function supply(purpose, stock, fallbacks, alternate = false) {
  const [preferred, fallback, source] = RULES[purpose];
  const sum = (names, count) => names.reduce((total, name) => total + count(name), 0);
  const primary = sum(preferred, stock.total);
  const mode = fallbacks[purpose];
  const group = alternate || (mode && (!primary || mode.reason === 'roof_work_stalled')) ? fallback : preferred;
  return { primary, available: sum(group, stock.total),
    carried: sum(group, name => stock.carried[name] || 0), item: group.find(name => stock.carried[name] > 0),
    conversion: group.find(name => stock.craftable[name]?.count > 0), source };
}

// Conversion uses items already in the bag and is separate from gathering a shortfall.
function acquisition(purpose, batch, stock, fallbacks, kb) {
  const have = supply(purpose, stock, fallbacks);
  const item = have.conversion;
  if (have.carried >= batch) return {};
  if (item) {
    const recipe = stock.craftable[item];
    return { conversion: { item, times: Math.ceil(Math.min(batch - have.carried, recipe.count) / recipe.yields) } };
  }
  const fallback = fallbacks[purpose];
  const hasPickaxe = Object.entries(stock.carried).some(([name, count]) => count > 0 && kb.pickaxe.match(name));
  const key = fallback ? (purpose === 'roof' && !fallback.masonryFailed && hasPickaxe ? 'cobblestone' : 'dirt') : have.source;
  if (key === 'cobblestone' && !hasPickaxe) return { failure: 'no_tool' };
  return { step: { kind: 'gather', key, blocks: kb[key].sources[0].blocks, count: batch - have.available } };
}

function setFallback(fallbacks, purpose, reason, masonryFailed = false) {
  if (reason && RULES[purpose]?.[1].length) fallbacks[purpose] = { reason, ...(masonryFailed ? { masonryFailed } : {}) };
  else delete fallbacks[purpose];
}

function restoreFallbacks(saved, variant) {
  const fallbacks = {};
  for (const purpose of ['wall', 'cave_wall', 'roof']) {
    const reason = saved.materialFallbacks?.[purpose]?.reason;
    if (typeof reason === 'string') setFallback(fallbacks, purpose, reason, saved.materialFallbacks[purpose].masonryFailed === true);
  }
  if (variant === 'hillside') setFallback(fallbacks, 'roof');
  else if (!fallbacks.roof && typeof saved.roofMaterial === 'string'
    && matchesRoofFallback(saved.roofMaterial.replace(/^roof_/, ''))) setFallback(fallbacks, 'roof', 'legacy_roof_material');
  return fallbacks;
}

module.exports = { WOODS, materialsFor, materialWork, accepts, filler, seal, pickItem, stableSolid, naturalWall, placedFor, matchesRoofWood,
  matchesRoofFallback, isSealSoil, isSealRock, SANDSTONE, budget, supply, acquisition, setFallback, restoreFallbacks };
