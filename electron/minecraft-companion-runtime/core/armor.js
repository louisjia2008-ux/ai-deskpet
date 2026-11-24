'use strict';
// Armour (and a shield) in the bag that beats what is worn: what to put on.

const { isAbort } = require('./confirm');

const ARMOR_SLOTS = [['head', 5, /_helmet$/], ['torso', 6, /_chestplate$/], ['legs', 7, /_leggings$/], ['feet', 8, /_boots$/]];
const OFF_HAND = 45;
const RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const rank = (name) => RANK.indexOf(name.split('_')[0]);

function bestArmor(bot, matches, score = rank) {
  return bot.inventory.items().filter(i => matches(i.name)).sort((a, b) => score(b.name) - score(a.name))[0];
}

/** The armour (and shield) in the bag that beats what is worn, as [item, slot] pairs. */
function upgrades(bot) {
  const out = [];
  const dimension = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
  // End goals deliberately wear a pumpkin; Nether goals need an actual
  // gold piece. Preserve those choices while upgrading the other slots.
  const goldSlot = dimension === 'the_nether'
    ? ARMOR_SLOTS.find(([, index]) => /^golden_/.test(bot.inventory.slots[index]?.name || ''))?.[1] : null;
  for (const [slot, index, pattern] of ARMOR_SLOTS) {
    const worn = bot.inventory.slots[index];
    if ((dimension === 'the_end' && slot === 'head' && worn?.name === 'carved_pumpkin') || index === goldSlot) continue;
    const best = bestArmor(bot, name => pattern.test(name));
    if (best && (!worn || rank(worn.name) < rank(best.name))) out.push([best, slot]);
  }
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield && bot.inventory.slots[OFF_HAND]?.name !== 'shield') out.push([shield, 'off-hand']);
  return out;
}

async function equipAndRecord(bot, ctx, item, slot) {
  try {
    await bot.equip(item, slot);
    ctx.record('equip', { item: item.name, slot });
  } catch (error) {
    if (isAbort(error)) throw error;
    return { ok: false, reason: 'equip_failed', item: item.name };
  }
}

async function equipUpgrades(bot, ctx) {
  for (const [item, slot] of upgrades(bot)) {
    const failed = await equipAndRecord(bot, ctx, item, slot);
    if (failed) return failed;
  }
  return { ok: true };
}

module.exports = { upgrades, equipAndRecord, equipUpgrades, ARMOR_SLOTS, bestArmor, armorRank: rank };
