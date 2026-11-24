'use strict';

const { factsOf } = require('../action-result');
const { Vec3 } = require('vec3');
const { countKey } = require('../knowledge');
const { materialWork } = require('../materials');
const { createOutfitGoal } = require('./outfit');
const { createFarmGoal } = require('./farm');
const { createNetherExpeditionGoal } = require('./netherExpedition');
const { createHuntPearlsGoal } = require('./huntPearls');
const { createEnterEndGoal } = require('./enterEnd');
const { createEndJourneyGoal } = require('./endJourney');
const { goNear } = require('../actions');
const { storeInChest, takeItems, placeAt } = require('../skills');
const { dimension, findPortal } = require('../nether');
const { upgrades } = require('../armor');
const { returnToEnd } = require('./endReturn');
const { exitPortalLit } = require('../end');

const RANGE = { overworld: 3, nether: 4, end: 6 };
const ARMOR = ['helmet', 'chestplate', 'leggings', 'boots'];
const key = (key, count = 1) => ({ key, count });
const IRON_TOOLS = [key('iron_pickaxe'), key('iron_sword'), key('shield')];
const IRON_ARMOR = ARMOR.map((piece) => key(`iron_${piece}`));
const OVERWORLD_IRON = [...IRON_TOOLS, ...IRON_ARMOR];
const IRON = [...OVERWORLD_IRON, key('bow'), key('arrow', 32), key('water_bucket'), key('lava_bucket')];
const DIAMOND = [key('diamond_pickaxe'), key('diamond_sword')];
const TRAVEL = [key('food', 16), key('cobblestone', 64), key('arrow', 32)];
const END = [key('bed'), key('ender_eye', 14), key('food', 24), key('cobblestone', 64), key('arrow', 64)];
const VALUABLES = ['diamond', 'blaze_rod', 'blaze_powder', 'ender_pearl', 'gold_ingot', 'elytra'];
const SUPPLIES = new Set(['dirt', 'gravel', 'cobbled_deepslate', 'rotten_flesh', 'netherrack']);
const HOME = 'return_and_store';

function createProgression({ bot, kb, homeOf, avoidFor }) {
  const here = () => dimension(bot);
  const milestones = (m) => (m.milestones ||= {});
  const chestCounts = (m) => Object.values(m.autonomyStock || {}).reduce((sum, counts) => {
    for (const item of VALUABLES) sum[item] = (sum[item] || 0) + (counts[item] || 0);
    return sum;
  }, {});
  const holds = (s, list) => list.every(({ key, count }) => countKey(key, s.inventory, kb) >= count);
  const eyes = (s) => s.inventory.ender_eye || 0;
  const total = (s, m, item) => (s.inventory[item] || 0) + (chestCounts(m)[item] || 0);
  const blaze = (s, m) => eyes(s) + total(s, m, 'blaze_powder') + 2 * total(s, m, 'blaze_rod');
  const pearls = (s, m) => eyes(s) + total(s, m, 'ender_pearl');
  const range = (m) => RANGE[m.range] ?? RANGE.nether;
  const farmOptions = (m) => ({
    bot, kb, center: m.homestead?.memory?.house?.entrance ?? homeOf(m).centre, plots: 9,
    home: { anchor: homeOf(m).centre, table: homeOf(m).stations.crafting_table },
    exclude: (p) => avoidFor(m, homeOf(m), 'wheatFarm')(p) || bot.companionNearPlayerBuild?.(p),
  });
  const farm = (m) => {
    if (!m.wheatFarm) {
      m.wheatFarm = createFarmGoal({ ...farmOptions(m), mode: 'sow' });
      if (m.wheatPlots?.length) m.wheatFarm.memory.plots = m.wheatPlots;
    }
    return m.wheatFarm;
  };
  const harvest = (m) => (m.wheatHarvest ||= createFarmGoal({ ...farmOptions(m), mode: 'harvest', sharedMemory: farm(m).memory }));
  const outfit = (m, items) => createOutfitGoal({ bot, items, home: { ...homeOf(m), chest: m.extraChests?.at(-1) || homeOf(m).chest }, kb });
  const netherKit = () => findPortal(bot, 48) || bot.companionNetherSearch?.overworldPortal
    ? TRAVEL : [...TRAVEL, key('obsidian', 10), key('flint_and_steel')];
  const inOverworld = () => here() === 'overworld';
  const litEnd = () => here() === 'the_end' && exitPortalLit(bot);
  const noDebuff = () => Object.values(bot.entity?.effects || {}).every((effect) =>
    bot.registry.effects?.[effect.id]?.type === 'good');
  const fit = (s) => s.isDay === true && s.health >= 18 && s.food >= 18 && noDebuff() && upgrades(bot).length === 0;
  const ready = (s, m, supplies) => !m.homePending && inOverworld() && holds(s, [...IRON, ...DIAMOND, ...supplies]) && fit(s);
  const chestKey = (p) => `${p.x},${p.y},${p.z}`;
  const chests = (m) => [homeOf(m).chest, ...(m.extraChests || [])];
  const atChest = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));

  function stageOf(s, m) {
    if (here() === 'the_end') return 6;
    if (here() === 'the_nether') return 4;
    if (!m.homestead?.isDone(s)) return 0;
    if (!m.wheatFarmDone || !finished(s, m) || !holds(s, OVERWORLD_IRON)) return 1;
    if (!holds(s, DIAMOND) || range(m) === 3) return 3;
    if (milestones(m).dragon) return 7;
    if (bot.companionEndPortal && milestones(m).end) return 5;
    if (range(m) === 4 || blaze(s, m) < 14 || pearls(s, m) < 14) return 4;
    return 5;
  }

  function homeStep(m) {
    let extraKit;
    const home = homeOf(m);
    return {
      name: HOME,
      isDone: () => !m.homePending,
      progress: () => m.homePending ? 0 : 1,
      dispose: () => extraKit?.dispose?.(),
      async run(ctx) {
        const from = bot.entity.position;
        const destination = new Vec3(home.centre.x + 0.5, home.centre.y, home.centre.z + 0.5);
        if (from.distanceTo(destination) > 8) return goNear(bot, ctx, destination, 5, { timeoutMs: 120000 });
        const { inventory } = ctx.perceive();
        const wants = Object.entries(inventory).filter(([name, count]) =>
          (VALUABLES.includes(name) && (name !== 'diamond' || holds({ inventory }, DIAMOND))) || (SUPPLIES.has(name) && count > 16))
          .map(([name, count]) => ({ match: (n) => n === name, count: VALUABLES.includes(name) ? count : count - 16 }));
        m.autonomyStock = {};
        for (const position of chests(m)) {
          if (atChest(position)?.name !== 'chest') continue;
          const result = await storeInChest(bot, ctx, { position, wants });
          if (!factsOf(result).contents) return result;
          m.autonomyStock[chestKey(position)] = factsOf(result).contents;
          for (const [name, count] of Object.entries(factsOf(result).stored || {})) {
            const left = wants.find((r) => r.match(name));
            if (left) left.count -= count;
          }
          for (let i = wants.length - 1; i >= 0; i--) if (wants[i].count <= 0) wants.splice(i, 1);
        }
        if (!wants.length) {
          m.homePending = false;
          ctx.record('autonomy_home', { stored: chestCounts(m) });
          return { ok: true };
        }
        const offsets = [1, 2, 3, 4, 5];
        const spots = offsets.map((x) => new Vec3(home.anchor.x + x, home.anchor.y, home.anchor.z + 7));
        const spot = spots.find((p) => atChest(p)?.name === 'air' && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
          && !bot.companionNearPlayerBuild?.(p));
        if (!spot) return { ok: false, reason: 'no_storage_site' };
        if (!inventory.chest) {
          extraKit ||= outfit(m, [key('chest')]);
          return extraKit.run(ctx);
        }
        const placed = await placeAt(bot, ctx, spot, (name) => name === 'chest', { requireAir: true });
        if (placed.ok) (m.extraChests ||= []).push({ x: spot.x, y: spot.y, z: spot.z });
        return placed;
      },
    };
  }

  const endKitItems = (m) => bot.companionEndPortal && milestones(m).end ? END.filter((r) => r.key !== 'ender_eye') : END;
  const endCrossingSupplies = [key('food', 12), key('cobblestone', 24), key('arrow', 32), key('bed')];
  const canEnterEnd = (s) => fit(s) && holds(s, endCrossingSupplies);
  const endSuppliesReady = (s, m) => (bot.companionEndPortal && milestones(m).end) || (blaze(s, m) >= 14 && pearls(s, m) >= 14);

  function endKit(m) {
    const kit = outfit(m, endKitItems(m));
    return {
      ...kit,
      async run(ctx) {
        const s = ctx.perceive();
        const missing = 14 - eyes(s);
        if (missing > 0 && endKitItems(m) === END) {
          const needs = {
            ender_pearl: missing - (s.inventory.ender_pearl || 0),
            blaze_powder: missing - (s.inventory.blaze_powder || 0) - 2 * (s.inventory.blaze_rod || 0),
          };
          needs.blaze_rod = Math.ceil((needs.blaze_powder - (chestCounts(m).blaze_powder || 0)) / 2);
          for (const position of chests(m)) {
            const stock = m.autonomyStock?.[chestKey(position)];
            if (!stock) continue;
            for (const [name, count] of Object.entries(needs)) {
              if (count <= 0 || !stock[name]) continue;
              const result = await takeItems(bot, ctx, { position, itemMatch: (item) => item === name, count });
              if (result.ok) stock[name] -= factsOf(result).taken;
              if (result.reason === 'chest_empty' || result.reason === 'chest_missing') {
                stock[name] = 0;
                return { ok: true };
              }
              return result;
            }
          }
        }
        return kit.run(ctx);
      },
    };
  }

  const card = (id, stage, requires, create, options) => ({ id, stage, risk: 'low', local: true, requires, create, ...options });
  const materials = (...requirements) => ({ work: (_s, _m, stock) => materialWork(requirements, stock, kb) });
  const finished = (s, m) => m.homestead?.status(s)?.finished === true;
  const readyToFinish = (s, m) => inOverworld() && holds(s, IRON_TOOLS) && m.wheatFarmDone;
  const cards = [
    card('wheat_farm', 1, (s, m) => inOverworld() && m.homestead?.isDone(s)
      && countKey('iron_pickaxe', s.inventory, kb) > 0 && !m.wheatFarmDone,
      (m) => farm(m), materials(key('wheat_seeds', 9), key('hoe'))),
    card('harvest_wheat', 1, (s, m) => inOverworld() && m.wheatFarmDone && homeOf(m) && farm(m).harvestNeeded(),
      (m) => harvest(m)),
    card('home_lighting', 1, (s, m) => readyToFinish(s, m) && m.homestead?.wantsLighting?.(s),
      (m) => m.homestead.lightingGoal(), materials(key('torch', 4))),
    card('guest_bed', 1, (s, m) => readyToFinish(s, m) && m.homestead?.wantsGuestBed?.(s),
      (m) => m.homestead.guestBedGoal(), materials(key('wool', 3), key('planks', 3))),
    card('return_home', 0, (s, m) => inOverworld() && Boolean(m.homestead?.memory.established)
      && (m.homePending || VALUABLES.some((item) => (s.inventory[item] || 0) > 0 && (item !== 'diamond' || holds(s, DIAMOND)))),
      (m) => { m.homePending = true; return homeStep(m); }, { safeReturn: true }),
    // A machine is useful, but its construction must not block making iron tools.
    card('iron_tools', 1, (s) => inOverworld() && !holds(s, IRON_TOOLS),
      (m) => outfit(m, IRON_TOOLS), materials(key('iron_ingot', 6), key('stick', 3), key('planks', 6))),
    card('iron_armor', 1, (s, m) => readyToFinish(s, m) && finished(s, m)
      && (!holds(s, IRON_ARMOR) || upgrades(bot).some(([item]) => item.name.startsWith('iron_'))),
      (m) => outfit(m, IRON_ARMOR), materials(key('iron_ingot', 24))),
    card('diamond_tools', 3, (s) => inOverworld() && !holds(s, DIAMOND), (m) => outfit(m, DIAMOND),
      materials(key('diamond', 5), key('stick', 3))),
    card('home_roof_wood', 3, (s, m) => inOverworld() && !m.homePending && m.wheatFarmDone
      && holds(s, OVERWORLD_IRON) && holds(s, DIAMOND) && m.homestead?.wantsRoofWood?.(s),
      (m) => m.homestead.roofWoodGoal()),
    card('nether_supplies', 4, (s, m) => inOverworld() && !m.homePending && blaze(s, m) < 14 && !holds(s, [...IRON, ...netherKit()]),
      (m) => outfit(m, [...IRON.filter((r) => r.key !== 'arrow'), ...netherKit()])),
    card('nether_fortress', 4, (s, m) => inOverworld() && range(m) >= 4 && blaze(s, m) < 14 && ready(s, m, netherKit()),
      (m) => createNetherExpeditionGoal({ bot, blazeRods: Math.max(1, Math.ceil((14 - (chestCounts(m).blaze_powder || 0)) / 2) - (chestCounts(m).blaze_rod || 0)), witherSkulls: 0, trades: 0,
        returnOnRespawn: true,
        canEnter: (s) => fit(s) && holds(s, [...IRON, ...DIAMOND, key('food', 12), key('cobblestone', 48)]) }),
      { expedition: true, budgetStage: 4 }),
    card('nether_return', 0, () => here() === 'the_nether', () => createNetherExpeditionGoal({ bot, blazeRods: 0, witherSkulls: 0, trades: 0 }),
      { expedition: true, safeReturn: true }),
    card('ender_pearls', 4, (s, m) => inOverworld() && range(m) >= 5 && !m.homePending && s.isDay === false
      && s.health >= 18 && s.food >= 16 && holds(s, IRON) && blaze(s, m) >= 14 && pearls(s, m) < 14,
      (m) => createHuntPearlsGoal({ bot, count: Math.max(1, 14 - (chestCounts(m).ender_pearl || 0)) }),
      { expedition: true, budgetStage: 4 }),
    card('end_supplies', 5, (s, m) => inOverworld() && range(m) >= 5 && !milestones(m).dragon
      && !m.homePending && endSuppliesReady(s, m) && !holds(s, endKitItems(m)), endKit),
    card('stronghold', 5, (s, m) => range(m) >= 5 && !milestones(m).dragon && ready(s, m, endKitItems(m))
      && !(m.stagePauses?.[6] > Date.now()),
      (m) => {
        if (bot.companionEndPortal && milestones(m).end) return {
          name: 'enter_end', isDone: () => here() === 'the_end',
          run: (ctx) => returnToEnd(bot, ctx, { canEnter: canEnterEnd }),
        };
        return createEnterEndGoal({ bot, canEnter: canEnterEnd });
      }, { expedition: true, budgetStage: 5 }),
    card('dragon_return', 6, () => here() === 'the_end',
      () => createEndJourneyGoal({ bot, withCity: false, home: true, alreadyInside: true }), { expedition: true, safeReturn: true, budgetStage: 6 }),
    card('diamond_armor', 6, (s, m) => inOverworld() && milestones(m).dragon && !holds(s, ARMOR.map((piece) => key(`diamond_${piece}`))),
       (m) => outfit(m, ARMOR.map((piece) => key(`diamond_${piece}`)))),
  ];
  return { cards, stageOf, range, litEnd };
}

module.exports = { createProgression, RANGE };
