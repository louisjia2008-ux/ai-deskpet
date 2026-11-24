'use strict';
// Goal: carry a list of items, gathered from nothing if need be, and wear the
// armour among them. What a player gets ready before a trip (the nether, the
// End): a full iron set, a bow and arrows, buckets, obsidian, eyes of ender.
//
// The gathering is deviceProject.js's: whatever the bag lacks is gathered
// into the home chest (gatherMaterials.js) and taken out again. The "device"
// here builds nothing; once everything is carried it puts the armour on.
// Food is the exception: put in the chest it is not there to eat, and a bot
// gathering iron for an hour starved with its meat stored at home. It is
// hunted last, straight into the bag (stockFood.js).

const { createDeviceProjectGoal } = require('./deviceProject');
const { createStockFoodGoal } = require('./stockFood');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { upgrades, equipUpgrades } = require('../armor');

// Tools and weapons stay in the bag as they are made: stored, the bot spent
// hours mining with stone picks and fighting bare-handed beside a chest
// holding its iron sword and pickaxe.
const CARRY = /(_sword|_pickaxe|_axe)$|^(shield|bow)$/;

function createKit({ bot, items, home, kb = KNOWLEDGE }) {
  const carried = (state, r) => Math.min(r.count, countKey(r.key, state.inventory, kb));
  const food = items.find((r) => r.key === 'food');
  const gathered = items.filter((r) => r !== food);
  const hunt = food ? createStockFoodGoal({ bot, target: food.count, home: () => home?.centre, kb }) : null;
  return {
    name: 'kit',
    // A device with no site: deviceProject walks to a site only while this is unset.
    memory: { device: { kind: 'kit' } },
    needs: () => gathered,
    ironDebt(inventory) {
      const need = gathered.reduce((total, item) => total + (item.count - carried({ inventory }, item))
        * (kb[item.key].sources?.find(source => source.needs?.iron_ingot)?.needs.iron_ingot || 0), 0);
      return Math.max(0, need - (inventory.raw_iron || 0) - (inventory.iron_ingot || 0));
    },
    isDone: (state) => items.every((r) => carried(state, r) >= r.count) && upgrades(bot).length === 0,
    progress: (state) => items.reduce((n, r) => n + carried(state, r), 0) + (upgrades(bot).length === 0 ? 1 : 0),
    async run(ctx) {
      const equipped = await equipUpgrades(bot, ctx);
      if (!equipped.ok) return equipped;
      if (hunt && !hunt.isDone(ctx.perceive())) return hunt.run(ctx);
      return { ok: true };
    },
  };
}

/** `items`: [{ key, count }] in the knowledge's keys; `home`: { chest, stations, centre } of the finished house. */
function createOutfitGoal({ bot, items, home, kb = KNOWLEDGE, ...rest } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('items must be a non-empty list');
  for (const r of items) {
    if (!kb[r?.key] || !Number.isSafeInteger(r.count) || r.count < 1) throw new TypeError(`bad item ${JSON.stringify(r)}`);
  }
  const device = createKit({ bot, items, home, kb });
  return createDeviceProjectGoal({ bot, name: 'outfit', device, home, kb, carry: (key) => CARRY.test(key), ...rest, countWorn: true });
}

module.exports = { createOutfitGoal, upgrades };
