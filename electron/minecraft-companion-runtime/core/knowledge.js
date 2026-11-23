'use strict';
// What the companion knows about obtaining things. Pure data: keys are
// resource families (any log counts as "log"), each with ordered sources.
//
// Source kinds:
//   craft  { yields, needs: { key: count }, table, pick(inventory) -> concrete item name }
//   gather { blocks(name) -> bool, tool?: key }      break a block, collect the drop
//          mineY?: when none is in sight, branch mine at this height (mining.js)
//   smelt  { input: key, fuel: true }                 at the home furnace
//   hunt   { mobs: [names] }                          kill, collect drops
//   fill   { liquid, bucket: key }                     use an empty bucket on a source block
//   cast   { tool, water, lava: keys }                 lava poured in a pit, water run over it (obsidian.js)
//   gather ... rare?: the drop only comes some of the time (flint from gravel)
//   station                                           a placed crafting table / furnace

const { WOODS, filler } = require('./materials');
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray',
  'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

const isLog = (n) => n.endsWith('_log') && !n.startsWith('stripped_') && WOODS.some((w) => n === `${w}_log`);
const isPlanks = (n) => n.endsWith('_planks') && WOODS.some((w) => n === `${w}_planks`);
const exact = (...names) => { const set = new Set(names); return (n) => set.has(n); };

// Raw meats are fine early; risky foods are handled by the eat action itself.
const MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cooked_beef', 'cooked_porkchop',
  'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'bread', 'apple', 'baked_potato', 'carrot', 'sweet_berries'];

function byMost(inventory, names) {
  let best = null;
  for (const name of names) if ((inventory[name] || 0) > (inventory[best] || 0)) best = name;
  return best;
}

/** Wood type with the most planks (or logs, if no planks yet). */
function dominantWood(inventory) {
  const planks = byMost(inventory, WOODS.map((w) => `${w}_planks`));
  if (planks) return planks.replace(/_planks$/, '');
  const log = byMost(inventory, WOODS.map((w) => `${w}_log`));
  return log ? log.replace(/_log$/, '') : 'oak';
}

const craft = (item, needs, { yields = 1, table = true, pick = () => item, maxBatch, when } = {}) => ({
  kind: 'craft', yields, ...(maxBatch === undefined ? {} : { maxBatch }), needs, table, pick, ...(when ? { when } : {}),
});
const recipe = (item, needs, { match = exact(item), tool, ...options } = {}) => ({
  match, ...(tool ? { tool } : {}), sources: [craft(item, needs, options)],
});
const toolAlias = (key, ...names) => ({ match: exact(...names), tool: true, sources: [{ kind: 'alias', key }] });
const gatherOre = (item, ore, tool, mineY, match = exact(item)) => ({
  match, sources: [{ kind: 'gather', blocks: exact(`${ore}_ore`, `deepslate_${ore}_ore`), tool, mineY }],
});

function armor(tiers, resource) {
  const parts = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
  return Object.fromEntries(Object.entries(parts).map(([piece, count]) => {
    const [item, ...upgrades] = tiers.map(tier => `${tier}_${piece}`);
    return [item, recipe(item, { [resource]: count }, { tool: true, match: exact(item, ...upgrades) })];
  }));
}

const KNOWLEDGE = {
  log: { match: isLog, sources: [{ kind: 'gather', blocks: isLog }] },
  planks: {
    match: isPlanks,
    // Every recipe takes one kind of planks (3 birch + 1 oak make no chest),
    // so only the most plentiful kind counts.
    count: (inv) => Math.max(0, ...WOODS.map((w) => inv[`${w}_planks`] || 0)),
    // Craft planks from whatever log is most plentiful.
    sources: [craft('oak_planks', { log: 1 }, { yields: 4, table: false,
      pick: (inv) => `${(byMost(inv, WOODS.map((w) => `${w}_log`)) || 'oak_log').replace(/_log$/, '')}_planks`,
    })],
  },
  stick: recipe('stick', { planks: 2 }, { yields: 4, table: false }),
  crafting_table: recipe('crafting_table', { planks: 4 }, { table: false }),
  wooden_pickaxe: recipe('wooden_pickaxe', { planks: 3, stick: 2 }, { tool: true }),
  // Tool tiers: a better tool satisfies a lower requirement.
  pickaxe: toolAlias('wooden_pickaxe', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
  iron_tier_pickaxe: toolAlias('iron_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
  stone_tier_pickaxe: toolAlias('stone_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
  cobblestone: {
    match: exact('cobblestone', 'cobbled_deepslate'),
    sources: [{ kind: 'gather', blocks: exact('stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'), tool: 'pickaxe' }],
  },
  stone_pickaxe: recipe('stone_pickaxe', { cobblestone: 3, stick: 2 }, { tool: true }),
  stone_sword: recipe('stone_sword', { cobblestone: 2, stick: 1 },
    { tool: true, match: exact('stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword') }),
  furnace: recipe('furnace', { cobblestone: 8 }),
  coal: gatherOre('coal', 'coal', 'pickaxe', 16, exact('coal', 'charcoal')),
  raw_iron: gatherOre('raw_iron', 'iron', 'stone_tier_pickaxe', 16),
  iron_ingot: { match: exact('iron_ingot'), sources: [{ kind: 'smelt', input: 'raw_iron', inputItem: 'raw_iron' }] },
  iron_sword: recipe('iron_sword', { iron_ingot: 2, stick: 1 },
    { tool: true, match: exact('iron_sword', 'diamond_sword', 'netherite_sword') }),
  iron_pickaxe: recipe('iron_pickaxe', { iron_ingot: 3, stick: 2 },
    { tool: true, match: exact('iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe') }),
  shield: recipe('shield', { iron_ingot: 1, planks: 6 }, { tool: true }),
  charcoal: {
    match: exact('charcoal'),
    sources: [{ kind: 'smelt', input: 'log', inputItem: (inv) => byMost(inv, Object.keys(inv).filter(KNOWLEDGE.log.match)) }],
  },
  torch_fuel: {
    match: exact('coal', 'charcoal'),
    sources: [{ kind: 'alias', key: 'charcoal' }],
  },
  torch: recipe('torch', { torch_fuel: 1, stick: 1 }, { yields: 4, table: false }),
  wool: {
    match: (n) => n.endsWith('_wool') && COLORS.some((c) => n === `${c}_wool`),
    // A bed needs three wool of one color, so only the most common color counts.
    count: (inv) => Math.max(0, ...COLORS.map((c) => inv[`${c}_wool`] || 0)),
    // Four string make a white wool: where there are no sheep, spiders still are.
    sources: [
      craft('white_wool', { string: 4 }, { maxBatch: 1, table: false, when: inv => (inv.string || 0) >= 4 }),
      { kind: 'hunt', mobs: ['sheep'] },
    ],
  },
  string: { match: exact('string'), sources: [{ kind: 'hunt', mobs: ['spider', 'cave_spider'] }] },
  bed: recipe('white_bed', { wool: 3, planks: 3 }, {
    match: (n) => n.endsWith('_bed'),
    pick: (inv) => `${(byMost(inv, COLORS.map((c) => `${c}_wool`)) || 'white_wool').replace(/_wool$/, '')}_bed`,
  }),
  chest: recipe('chest', { planks: 8 }),
  door: recipe('oak_door', { planks: 6 }, {
    match: (n) => n.endsWith('_door') && WOODS.some((w) => n === `${w}_door`),
    yields: 3, pick: (inv) => `${dominantWood(inv)}_door`,
  }),
  // Redstone machine parts. Natural redstone and quartz ore are mined where
  // they are seen; deep branch mining and the Nether are separate steps.
  bucket: recipe('bucket', { iron_ingot: 3 }),
  water_bucket: { match: exact('water_bucket'), sources: [{ kind: 'fill', liquid: 'water', bucket: 'bucket' }] },
  lava_bucket: { match: exact('lava_bucket'), sources: [{ kind: 'fill', liquid: 'lava', bucket: 'bucket' }] },
  hopper: recipe('hopper', { iron_ingot: 5, chest: 1 }),
  redstone: gatherOre('redstone', 'redstone', 'iron_tier_pickaxe', -53),
  diamond: gatherOre('diamond', 'diamond', 'iron_tier_pickaxe', -58),
  // The way to the Nether: a portal of obsidian lit with flint and steel.
  diamond_pickaxe: recipe('diamond_pickaxe', { diamond: 3, stick: 2 },
    { tool: true, match: exact('diamond_pickaxe', 'netherite_pickaxe') }),
  diamond_sword: recipe('diamond_sword', { diamond: 2, stick: 1 },
    { tool: true, match: exact('diamond_sword', 'netherite_sword') }),
  ...armor(['diamond', 'netherite'], 'diamond'),
  obsidian: {
    match: exact('obsidian'),
    sources: [{ kind: 'cast', tool: 'diamond_pickaxe', water: 'water_bucket', lava: 'lava_bucket' }],
  },
  flint: { match: exact('flint'), sources: [{ kind: 'gather', blocks: exact('gravel'), rare: true }] },
  flint_and_steel: recipe('flint_and_steel', { iron_ingot: 1, flint: 1 }, { tool: true, table: false }),
  quartz: {
    match: exact('quartz'),
    // A wooden pickaxe wears out on the netherrack of the way before the quartz is in.
    sources: [{ kind: 'gather', blocks: exact('nether_quartz_ore'), tool: 'stone_tier_pickaxe', dimension: 'the_nether' }],
  },
  // Smooth stone for repeaters: cobblestone smelted once.
  stone: { match: exact('stone'), sources: [{ kind: 'smelt', input: 'cobblestone', inputItem: 'cobblestone' }] },
  sand: { match: exact('sand'), sources: [{ kind: 'gather', blocks: exact('sand') }] },
  glass: { match: exact('glass'), sources: [{ kind: 'smelt', input: 'sand', inputItem: 'sand' }] },
  sugar_cane: { match: exact('sugar_cane'), sources: [{ kind: 'gather', blocks: exact('sugar_cane') }] },
  redstone_torch: recipe('redstone_torch', { redstone: 1, stick: 1 }, { table: false }),
  repeater: recipe('repeater', { redstone_torch: 2, redstone: 1, stone: 3 }),
  piston: recipe('piston', { planks: 3, cobblestone: 4, iron_ingot: 1, redstone: 1 }),
  observer: recipe('observer', { cobblestone: 6, redstone: 2, quartz: 1 }),
  bow: recipe('bow', { stick: 3, string: 3 }),
  dispenser: recipe('dispenser', { cobblestone: 7, bow: 1, redstone: 1 }),
  // Armour, worn rather than used up: a better piece satisfies a lower one.
  ...armor(['iron', 'diamond', 'netherite'], 'iron_ingot'),
  // Arrows for the end crystals and the dragon.
  feather: { match: exact('feather'), sources: [{ kind: 'hunt', mobs: ['chicken'] }] },
  arrow: recipe('arrow', { flint: 1, stick: 1, feather: 1 }, { yields: 4 }),
  // The way to the End: blaze rods come from a nether fortress (netherExpedition.js),
  // ender pearls from endermen at night (huntPearls.js); the eyes are crafted from both.
  blaze_rod: { match: exact('blaze_rod'), sources: [] },
  blaze_powder: recipe('blaze_powder', { blaze_rod: 1 }, { yields: 2, table: false }),
  ender_pearl: { match: exact('ender_pearl'), sources: [{ kind: 'hunt', mobs: ['enderman'] }] },
  ender_eye: recipe('ender_eye', { ender_pearl: 1, blaze_powder: 1 }, { table: false }),
  food: { match: exact(...MEATS), sources: [{ kind: 'hunt', mobs: ['cow', 'pig', 'sheep', 'chicken', 'rabbit'] }] },
  // Ranching: a fenced pen with a gate.
  fence: recipe('oak_fence', { planks: 4, stick: 2 }, {
    match: (n) => WOODS.some((w) => n === `${w}_fence`),
    yields: 3, pick: inv => `${dominantWood(inv)}_fence`,
  }),
  fence_gate: recipe('oak_fence_gate', { planks: 2, stick: 4 }, {
    match: (n) => WOODS.some((w) => n === `${w}_fence_gate`),
    pick: inv => `${dominantWood(inv)}_fence_gate`,
  }),
  // Farming: a hoe tills, seeds come from breaking grass, wheat from the farm.
  hoe: toolAlias('stone_hoe', 'wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe', 'netherite_hoe'),
  stone_hoe: recipe('stone_hoe', { cobblestone: 2, stick: 2 },
    { tool: true, match: exact('stone_hoe', 'iron_hoe', 'diamond_hoe', 'netherite_hoe') }),
  wheat_seeds: { match: exact('wheat_seeds'), sources: [{ kind: 'gather', blocks: exact('short_grass', 'tall_grass') }] },
  wheat: { match: exact('wheat'), sources: [{ kind: 'farm', crop: 'wheat' }] },
  bread: recipe('bread', { wheat: 3 }),
  dirt: { match: exact('dirt'), sources: [{ kind: 'gather', blocks: exact('dirt', 'grass_block', 'coarse_dirt') }] },
  filler: { match: filler, sources: [{ kind: 'alias', key: 'cobblestone' }] },
  sandstone: recipe('sandstone', { sand: 4 }, { maxBatch: 16, table: false }),
  red_sand: { match: exact('red_sand'), sources: [{ kind: 'gather', blocks: exact('red_sand') }] },
  red_sandstone: recipe('red_sandstone', { red_sand: 4 }, { maxBatch: 16, table: false }),
};

// Fuel accepted by the furnace, in preference order, with items smelted per unit.
const FUELS = [['coal', 8], ['charcoal', 8], ...WOODS.map((w) => [`${w}_planks`, 1.5]),
  ...WOODS.map((w) => [`${w}_log`, 1.5]), ['stick', 0.5]];

function countKey(key, inventory, kb = KNOWLEDGE) {
  const entry = kb[key];
  if (!entry) throw new Error(`Unknown resource ${key}`);
  if (entry.count) return entry.count(inventory);
  let total = 0;
  for (const [name, n] of Object.entries(inventory)) if (n > 0 && entry.match(name)) total += n;
  return total;
}

/** Which family a concrete item belongs to, for block placement material checks. */
function familyOf(name, kb = KNOWLEDGE) {
  for (const [key, entry] of Object.entries(kb)) if (!entry.tool && entry.match(name)) return key;
  return null;
}

module.exports = { KNOWLEDGE, FUELS, WOODS, COLORS, MEATS, isLog, isPlanks, countKey, familyOf, dominantWood, byMost };
