'use strict';
// The goals the director may pick on its own, one card each (see director.js).
// A new goal joins autonomy by adding a card here; it needs no director changes.
//
// Stages are read from the world every time, never stored:
//   0  no finished home yet
//   1  home, bed, furniture and iron gear done: food, then the machines
//      (a cobblestone generator with a hopper, then the hopper-fed furnace),
//      each built beside the house from materials gathered into its chest

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

function createReserveCards(bot, kb, food, inOverworld) {
  const hasRoom = (state) => state.freeSlots !== 0 && inOverworld();
  const cobble = (state) => countKey('cobblestone', state.inventory, kb);
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return [food, {
    id: 'stock_wood', stage: 0, risk: 'medium', requires: hasRoom,
    demand: (state) => Math.max(0, 1 - countKey('log', state.inventory, kb) / 64),
    create: () => createGatherLogsGoal({ bot, count: 1 }),
  }, {
    id: 'stock_cobblestone', stage: 0, risk: 'medium',
    requires: (state) => hasRoom(state) && countKey('pickaxe', state.inventory, kb) > 0,
    demand: (state) => Math.max(0, 1 - cobble(state) / 64),
    create: (memory) => {
      const home = homeOf(memory);
      const protect = home && avoidFor(memory, home);
      return createGatherBlocksGoal({ bot, name: 'stock_cobblestone', count: 1, searchRadius: 20,
        itemMatch: kb.cobblestone.match, blockMatch: kb.cobblestone.sources[0].blocks,
        acceptTarget(block) {
          const p = block.position;
          if (p.y < Math.floor(bot.entity.position.y) - 2 || protect?.(p)
            || bot.companionProtectBlock?.(block) || bot.companionPlayerBlock?.(p)) return false;
          const neighbors = faces.map((face) => bot.blockAt(p.offset(...face)));
          return neighbors.some((b) => b?.name === 'air') && neighbors.every((b) => b && !/water|lava/.test(b.name));
        },
      });
    },
  }];
}

function createDefaultCards({ bot, kb = KNOWLEDGE, homestead = {}, foodTarget = FOOD_TARGET, progression = false } = {}) {
  // One homestead for the whole run: it holds the chosen site and which
  // furniture has been used, so every later pick continues the same house.
  const home = (memory) => (memory.homestead ||= createHomesteadGoal({ bot, autonomous: progression, ...homestead }));

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
      risk: 'medium',
      demand: (state) => {
        const food = countKey('food', state.inventory, kb);
        return food < 4 ? 1 + (4 - food) / 16 : Math.max(0, (1 - food / foodTarget) * 0.75);
      },
      create: memory => createStockFoodGoal({ bot, target: foodTarget, kb, home: () => homeOf(memory)?.centre }),
    },
  ];

  // One project per machine for the whole run, like the homestead.
  const machine = (id, makeDevice, headingOffset) => (memory) => {
    if (memory[id]) return memory[id];
    const home = homeOf(memory);
    const avoid = avoidFor(memory, home, id);
    const device = makeDevice((p) => avoid(p) || bot.companionNearPlayerBuild?.(p));
    memory[id] = createDeviceProjectGoal({ bot, name: id === 'cobbleGenerator' ? 'build_cobble_generator' : 'build_auto_smelter',
      device, home: { ...home, headingOffset }, kb });
    return memory[id];
  };
  const built = (memory, id, state) => Boolean(memory[id]?.isDone(state));
  const deviceWork = create => (_state, _memory, inventory) => materialWork(create().needs(), inventory, kb);
  cards.push(
    {
      id: 'cobble_generator',
      stage: 1,
      risk: 'medium', local: true,
      requires: (state, memory) => Boolean(homeOf(memory)) && !built(memory, 'cobbleGenerator', state),
      work: deviceWork(() => createCobbleGeneratorGoal({ bot, collector: true })),
      create: machine('cobbleGenerator', (avoid) => createCobbleGeneratorGoal({ bot, harvest: GENERATOR_HARVEST, collector: true, avoid }), 0),
    },
    {
      id: 'auto_smelter',
      stage: 1,
      risk: 'low', local: true,
      requires: (state, memory) => Boolean(homeOf(memory)) && built(memory, 'cobbleGenerator', state) && !built(memory, 'autoSmelter', state),
      work: deviceWork(() => createAutoSmelterGoal({ bot, count: SMELT_COUNT, fuel: progression ? 'charcoal' : 'coal' })),
      create: machine('autoSmelter', (avoid) => createAutoSmelterGoal({ bot, count: SMELT_COUNT, ...(progression ? { fuel: 'charcoal' } : {}), avoid }), Math.PI),
    },
  );

  if (progression) {
    const route = createProgression({ bot, kb, homeOf, avoidFor });
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
