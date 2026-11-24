'use strict';
// The goals the director may pick on its own, one card each (see director.js).
// A new goal joins autonomy by adding a card here; it needs no director changes.
//
// Stages are read from the world every time, never stored:
//   0  no finished home yet
//   1  home, bed, furniture and iron gear done: food, then the machines
//      (a cobblestone generator with a hopper, then the hopper-fed furnace),
//      each built beside the house from materials gathered into its chest

const { AXIS_OFFSETS: faces } = require('../geometry');
const { createHomesteadGoal } = require('./homestead');
const { createStockFoodGoal } = require('./stockFood');
const { createGatherBlocksGoal, createGatherLogsGoal } = require('./gatherBlocks');
const { createCobbleGeneratorGoal } = require('./cobbleGenerator');
const { createAutoSmelterGoal } = require('./autoSmelter');
const { createDeviceProjectGoal } = require('./deviceProject');
const { createProgression } = require('./progression');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { materialWork } = require('../materials');

const FOOD_TARGET = 16;
const GENERATOR_HARVEST = 8;
const SMELT_COUNT = 4;

/** The finished house as machines need it: chest, stations and centre; null before there is one. */
function homeOf(memory = {}) {
  const house = memory.homestead?.memory?.house;
  if (!house) return null;
  const f = house.furniture;
  return { chest: f.chest.position, stations: { crafting_table: f.crafting_table.position, furnace: f.furnace.position },
    centre: house.interiorCenter, anchor: house.anchor };
}

// Machines stay off the house (and its doorstep) and off each other.
function avoidFor(memory, home, self) {
  const a = home.anchor;
  return (p) => {
    if (p.x >= a.x - 2 && p.x <= a.x + 8 && p.z >= a.z - 4 && p.z <= a.z + 8) return true;
    if (self !== 'wheatFarm' && (memory.wheatFarm?.memory.plots || memory.wheatPlots || []).some((q) => q.x === p.x && q.z === p.z)) return true;
    for (const id of ['cobbleGenerator', 'autoSmelter']) {
      const d = id !== self && memory[id]?.memory.device?.device;
      if (!d) continue;
      const cells = d.kind === 'auto_smelter' ? [...d.dig, ...d.floor, ...d.clearAbove, ...d.parts.map((x) => x.position)]
        : [...d.open, ...d.seal, ...d.clearAbove, ...d.parts.map((x) => x.position)];
      if (cells.some((c) => Math.abs(c.x - p.x) <= 1 && Math.abs(c.z - p.z) <= 1 && Math.abs(c.y - p.y) <= 2)) return true;
    }
    return false;
  };
}

const stockWork = (stock, key, target, kb) => {
  const remaining = Math.max(0, target - countKey(key, stock, kb));
  return { remaining, readiness: 1 - remaining / target };
};

function createReserveCards(bot, kb, food, inOverworld) {
  const hasRoom = (state) => state.freeSlots !== 0 && inOverworld();
  const reserve = (id, key, create, requires = hasRoom) => ({
    id, stage: 0, risk: 'medium', requires, bounded: true, create,
    demand: state => stockWork(state.inventory, key, 64, kb).remaining / 64,
    work: (_state, _memory, stock) => stockWork(stock, key, 64, kb),
  });
  const wood = reserve('stock_wood', 'log', () => createGatherLogsGoal({ bot, count: 1 }));
  const cobblestone = reserve('stock_cobblestone', 'cobblestone', memory => {
    const home = homeOf(memory);
    const protect = home && avoidFor(memory, home);
    return createGatherBlocksGoal({ bot, name: 'stock_cobblestone', count: 1,
      itemMatch: kb.cobblestone.match, blockMatch: kb.cobblestone.sources[0].blocks,
      acceptTarget(block) {
        const p = block.position;
        if (p.y < Math.floor(bot.entity.position.y) - 2 || protect?.(p)
          || bot.companionProtectBlock?.(block) || bot.companionPlayerBlock?.(p)) return false;
        const neighbors = faces.map((face) => bot.blockAt(p.offset(...face)));
        return neighbors.some((b) => b?.name === 'air') && neighbors.every((b) => b && !/water|lava/.test(b.name));
      },
    });
  }, state => hasRoom(state) && countKey('pickaxe', state.inventory, kb) > 0);
  return [food, wood, cobblestone];
}

function createDefaultCards({ bot, kb = KNOWLEDGE, homestead = {}, foodTarget = FOOD_TARGET, progression = false } = {}) {
  // One homestead for the whole run: it holds the chosen site and which
  // furniture has been used, so every later pick continues the same house.
  const home = (memory) => (memory.homestead ||= createHomesteadGoal({ bot, origin: memory.explorationOrigin, autonomous: progression, ...homestead }));

  const cards = [
    {
      id: 'homestead',
      stage: 0,
      risk: 'low', local: true,
      requires: (state, memory) => !memory.homestead?.isDone(state),
      work: (state, memory, stock) => memory.homestead?.work?.(state, stock),
      create: home,
    },
    {
      id: 'stock_food',
      stage: progression ? 0 : 1,
      risk: 'medium', bounded: true,
      work: (_state, _memory, stock) => stockWork(stock, 'food', foodTarget, kb),
      demand: (state) => {
        const food = countKey('food', state.inventory, kb);
        return food < 4 ? 1 + (4 - food) / 16 : Math.max(0, (1 - food / foodTarget) * 0.75);
      },
      create: memory => createStockFoodGoal({ bot, target: foodTarget, kb, home: () => homeOf(memory)?.centre }),
    },
  ];

  // One project per machine for the whole run, like the homestead.
  const built = (memory, id, state) => Boolean(memory[id]?.isDone(state));
  const machine = (id, key, risk, makeDevice, headingOffset, after) => ({
    id, stage: 1, risk, local: true,
    requires: (state, memory) => Boolean(homeOf(memory)) && (!after || built(memory, after, state)) && !built(memory, key, state),
    work: (_state, _memory, inventory) => materialWork(makeDevice().needs(), inventory, kb),
    create(memory) {
      if (memory[key]) return memory[key];
      const home = homeOf(memory);
      const avoid = avoidFor(memory, home, key);
      return (memory[key] = createDeviceProjectGoal({ bot, name: `build_${id}`,
        device: makeDevice(p => avoid(p) || bot.companionNearPlayerBuild?.(p)), home: { ...home, headingOffset }, kb }));
    },
  });
  cards.push(
    machine('cobble_generator', 'cobbleGenerator', 'medium',
      avoid => createCobbleGeneratorGoal({ bot, harvest: GENERATOR_HARVEST, collector: true, avoid }), 0),
    machine('auto_smelter', 'autoSmelter', 'low',
      avoid => createAutoSmelterGoal({ bot, count: SMELT_COUNT, fuel: progression ? 'charcoal' : 'coal', avoid }), Math.PI, 'cobbleGenerator'),
  );

  if (progression) {
    const route = createProgression({ bot, kb, homeOf, avoidFor });
    const outsideScope = new Set(['return_home', 'nether_supplies', 'nether_fortress', 'nether_return',
      'ender_pearls', 'end_supplies', 'stronghold', 'dragon_return']);
    for (const card of [...cards, ...route.cards]) card.bounded = !outsideScope.has(card.id);
    const overworld = () => !['the_nether', 'the_end'].includes(String(bot.game?.dimension).replace('minecraft:', ''));
    cards[1].requires = overworld;
    for (const card of cards.filter(card => card.local)) {
      const requires = card.requires;
      card.requires = (state, memory) => overworld() && requires(state, memory);
    }
    return { ...route, cards: [...route.cards, ...cards], reserveCards: createReserveCards(bot, kb, cards[1], overworld) };
  }
  const stageOf = (state, memory) => (memory.homestead?.isDone(state) ? 1 : 0);
  return { cards, stageOf };
}

module.exports = { createDefaultCards, homeOf, FOOD_TARGET, GENERATOR_HARVEST, SMELT_COUNT };
