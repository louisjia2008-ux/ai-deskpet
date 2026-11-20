'use strict';

const actions = require('./actions');
const skills = require('./skills');
const { abortError, waitUntil } = require('./confirm');
const { vec, placementSpec, openDoorIfVisible, descendSurveyScaffold } = require('./survey-placement');

const HOE = 'wooden_hoe';
const SALVAGE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|mud|cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|calcite|dripstone_block|sand|red_sand|sandstone|red_sandstone|gravel|.+_log|.+_stem)$/;
const PATH_TIMEOUT = 14000;

function materialFor(op) {
  const spec = placementSpec(op.target);
  if (spec.id === 'air' || spec.half === 'upper' || spec.part === 'head') return null;
  return { farmland: HOE, wheat: 'wheat_seeds', water: 'water_bucket' }[spec.id] || spec.id;
}

function isMaterial(name, item) {
  return name === HOE ? item.name.endsWith('_hoe') : item.name === name;
}

function count(stacks, name) {
  return stacks.filter((item) => isMaterial(name, item)).reduce((total, item) => total + item.count, 0);
}

function batchFor(steps, stackLimit) {
  const needed = new Map();
  for (const step of steps) {
    const item = materialFor(step[0]);
    if (!item) continue;
    needed.set(item, Math.min(item === HOE ? 1 : stackLimit, (needed.get(item) || 0) + 1));
  }
  return needed;
}

function room(window, item, start, end) {
  return window.slots.slice(start, end).reduce((total, slot) => {
    if (!slot) return total + item.stackSize;
    if (slot.type === item.type && slot.metadata === item.metadata && !slot.nbt && !item.nbt) {
      return total + item.stackSize - slot.count;
    }
    return total;
  }, 0);
}

function missingMaterials(bot, needed) {
  return Object.fromEntries([...needed].flatMap(([name, qty]) => {
    const short = qty - count(bot.inventory.items(), name);
    return short > 0 ? [[`minecraft:${name}`, short]] : [];
  }));
}

function createSurveyInventory(bot) {
  const baseline = new Map();
  for (const stack of bot.inventory.items()) baseline.set(stack.name, (baseline.get(stack.name) || 0) + stack.count);
  return { baseline, borrowed: new Set() };
}

function createSurveySupplies(bot, plan, { baseline, borrowed } = createSurveyInventory(bot)) {
  const chestPos = plan.supplyChest ? vec(plan.supplyChest) : null;

  async function chestTransaction(ctx, use) {
    if (!chestPos) return { ok: false, reason: 'no_supply_chest' };
    if (!actions.withinReach(bot, chestPos, 3.8)) {
      await descendSurveyScaffold(bot, ctx, plan);
      let travel = await actions.goNear(bot, ctx, chestPos.offset(0.5, 0, 0.5), 2, { timeoutMs: PATH_TIMEOUT });
      if (!travel.ok && await openDoorIfVisible(bot, ctx, plan)) {
        travel = await actions.goNear(bot, ctx, chestPos.offset(0.5, 0, 0.5), 2, { timeoutMs: PATH_TIMEOUT });
      }
      if (!travel.ok || !actions.withinReach(bot, chestPos, 4.3)) return { ok: false, reason: 'supply_chest_unreachable' };
    }
    const chest = bot.blockAt(chestPos);
    if (chest?.name !== 'chest') return { ok: false, reason: 'supply_chest_changed' };
    const window = await actions.openSurveyChest(bot, ctx, chest);
    if (!window) return { ok: false, reason: 'supply_chest_unreachable' };
    // Mineflayer's transfers take multiple clicks. A cancelled grant may finish
    // the click already sent, but it must not start the next one.
    const click = bot.clickWindow;
    bot.clickWindow = function (...args) {
      if (ctx.signal.aborted) throw abortError(ctx.signal);
      if (bot.currentWindow !== window) throw new Error('supply_chest_closed');
      return click.apply(bot, args);
    };
    try {
      return await use(window);
    } catch (error) {
      if (ctx.signal.aborted) throw abortError(ctx.signal);
      return { ok: false, reason: 'supply_chest_transfer', detail: error.message };
    } finally {
      bot.clickWindow = click;
      if (bot.currentWindow === window) window.close();
    }
  }

  async function withdraw(window, name, quantity) {
    let left = quantity;
    for (const item of window.containerItems()) {
      if (!isMaterial(name, item) || left <= 0) continue;
      const n = Math.min(left, item.count, room(window, item, window.inventoryStart, window.inventoryEnd));
      if (n <= 0) break;
      // Revocation can interrupt after the server transfers a stack but before
      // Mineflayer resolves the window operation.
      borrowed.add(item.name);
      await window.withdraw(item.type, item.metadata, n, item.nbt);
      left -= n;
    }
    return quantity - left;
  }

  async function craftFromInventory(ctx, needed) {
    for (const [name, yieldCount] of [['oak_planks', 4], ['stick', 4]]) {
      const short = (needed.get(name) || 0) - count(bot.inventory.items(), name);
      if (short <= 0 || !bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, null).length) continue;
      await skills.craft(bot, ctx, { item: name, times: Math.ceil(short / yieldCount) });
    }
  }

  async function ensure(ctx, steps, stackLimit = 128) {
    const needed = batchFor(steps, stackLimit);
    if (!Object.keys(missingMaterials(bot, needed)).length) return { ok: true };
    await craftFromInventory(ctx, needed);
    if (!Object.keys(missingMaterials(bot, needed)).length) return { ok: true };
    if (!chestPos) return { ok: true, missing: missingMaterials(bot, needed) };

    const pulled = await chestTransaction(ctx, async (window) => {
      const have = () => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean);
      for (const [name, qty] of needed) {
        const short = qty - count(have(), name);
        if (short <= 0) continue;
        const amount = await withdraw(window, name, short);
        const remaining = short - amount;
        if (remaining <= 0) continue;
        if (name === 'oak_planks') await withdraw(window, 'oak_log', Math.max(0, Math.ceil(remaining / 4) - count(have(), 'oak_log')));
        if (name === 'stick') await withdraw(window, 'oak_planks', Math.max(0, 2 * Math.ceil(remaining / 4) - count(have(), 'oak_planks')));
      }
      return { ok: true };
    });
    if (!pulled.ok) return pulled;
    await craftFromInventory(ctx, needed);
    return { ok: true, missing: missingMaterials(bot, needed) };
  }

  async function collect(ctx, op) {
    const origin = vec(op.pos).offset(0.5, 0.35, 0.5);
    const drops = () => Object.values(bot.entities).some((entry) => {
      if (entry.name !== 'item' || entry.position.distanceTo(origin) > 3) return false;
      const item = entry.getDroppedItem?.();
      return item && SALVAGE.test(item.name);
    });
    if (await waitUntil(drops, { timeoutMs: 180, signal: ctx.signal })) {
      await actions.collectDrops(bot, ctx, origin, (name) => SALVAGE.test(name), { radius: 3, timeoutMs: 4000 });
    }
  }

  async function putBack(ctx) {
    if (!chestPos) return { ok: true };
    const returns = new Map();
    for (const item of bot.inventory.items()) {
      if (!borrowed.has(item.name) && !SALVAGE.test(item.name) && item.name !== 'bucket') continue;
      returns.set(item.name, (returns.get(item.name) || 0) + item.count);
    }
    for (const [name, quantity] of returns) {
      const extra = quantity - (baseline.get(name) || 0);
      if (extra <= 0) returns.delete(name);
      else returns.set(name, extra);
    }
    if (!returns.size) return { ok: true };
    return chestTransaction(ctx, async (window) => {
      for (const name of returns.keys()) {
        const items = window.slots.slice(window.inventoryStart, window.inventoryEnd).filter((item) => item?.name === name);
        // The final placement acknowledgement can precede the inventory slot update.
        // The contents delivered when opening the chest are the current server view.
        let left = items.reduce((total, item) => total + item.count, 0) - (baseline.get(name) || 0);
        for (const item of items) {
          const n = Math.min(left, item.count, room(window, item, 0, window.inventoryStart));
          if (n <= 0) break;
          await window.deposit(item.type, item.metadata, n, item.nbt);
          left -= n;
        }
        if (left > 0) return { ok: false, reason: 'chest_full' };
      }
      return { ok: true };
    });
  }

  return { ensure, putBack, collect, item: (op) => bot.inventory.items().find((item) => isMaterial(materialFor(op), item)) };
}

module.exports = { createSurveyInventory, createSurveySupplies, materialFor };
