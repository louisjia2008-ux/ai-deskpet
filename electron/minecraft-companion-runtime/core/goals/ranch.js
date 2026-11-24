'use strict';
// Goal: a fenced pen holding `target` animals of one kind, bred from the
// ones led in. Each run() reads the pen and the animals from the world and
// does one thing: make or place fences, set the gate, lead an animal in, or
// breed two adults.

const { isComplete, waiting } = require('../action-result');
const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const defaultHusbandry = require('../husbandry');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { posKey } = require('../blacklist');
const { ledgerFor, ledgerTarget, recordTarget } = require('../failure-ledger');
const { sleep } = require('../confirm');
const { createPlannerRunner, DOWN } = require('./common');

const BREED_COOLDOWN_MS = 5 * 60 * 1000 + 5000; // vanilla: 6000 ticks
// How far a search for animals may take the bot from its pen before it walks back.
const ROAM = 80;
// Wheat kept back for breeding; the rest may be baked into bread when hungry.
const FEED_RESERVE = 4;

function createRanchGoal({ bot, kind = 'cow', target = 3, size = 6, center = null,
  skills = defaultSkills, actions = defaultActions, husbandry = defaultHusbandry, kb = KNOWLEDGE, exclude = () => false, waitMs = 3000 } = {}) {
  const memory = { center, pen: null, table: null, steps: 0, bredAt: 0, born: 0 };
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const inPenArea = (p) => memory.pen && p.x >= memory.pen.corner.x - 1 && p.x <= memory.pen.corner.x + size
    && p.z >= memory.pen.corner.z - 2 && p.z <= memory.pen.corner.z + size;
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, purpose: 'farm_gather',
    avoid: (p) => inPenArea(p) || exclude(p) });

  const penCount = () => (memory.pen ? husbandry.animalsIn(bot, memory.pen, kind).length : 0);
  const penMiddle = () => new Vec3(memory.pen.corner.x + size / 2, memory.pen.corner.y, memory.pen.corner.z + size / 2);

  async function goBack(ctx, why) {
    ctx.record('ranch', { action: 'return', why, distance: Math.round(bot.entity.position.distanceTo(penMiddle())) });
    // A new heading next time: the last one led away from the animals.
    memory.heading = undefined;
    const moved = await actions.goNear(bot, ctx, new Vec3(memory.pen.outside.x + 0.5, memory.pen.outside.y, memory.pen.outside.z + 0.5), 3, { timeoutMs: 60000 });
    return moved.ok || bot.entity.position.distanceTo(penMiddle()) < 16 ? { ok: true } : moved;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    if (!memory.pen) {
      const corner = husbandry.choosePenSite(blockAt, memory.center || bot.entity.position, { size, exclude });
      if (!corner) return skills.explore(bot, ctx, memory);
      memory.pen = husbandry.penLayout(corner, size);
      ctx.record('pen_chosen', { corner });
      return { ok: true };
    }
    const pen = memory.pen;
    const inventory = inventoryFor(state);
    const stations = { crafting_table: tableHere() };
    // Out of sight of the pen its fences read as missing and its animals as
    // gone: walk back before judging either.
    if (pen.fences.some((p) => !blockAt(p)) || bot.entity.position.distanceTo(penMiddle()) > ROAM) return goBack(ctx, 'out_of_sight');

    // Hungry with nothing to eat: bake the spare wheat before the hunger drive
    // takes over and goes hunting (perhaps the very animals being kept).
    const edible = Object.keys(state.inventory).some((n) => state.inventory[n] > 0 && n !== 'wheat' && bot.registry?.foodsByName?.[n]);
    if (state.food <= 16 && !edible && (state.inventory.wheat || 0) >= 3 + FEED_RESERVE) {
      const bake = planNext({ requirements: [{ key: 'bread', count: countKey('bread', inventory, kb) + 1 }], inventory, stations, kb });
      if (bake) return step(ctx, { ...bake, for: 'bread' });
    }

    // The fence line first, then the gate.
    const ledger = ledgerFor(bot, ctx), fence = p => ledgerTarget(bot, 'ranch_fence', p);
    const animal = e => ledgerTarget(bot, 'ranch_lure', e.position, { entity: e.id });
    const missing = pen.fences.filter(p => !kb.fence.match(blockAt(p)?.name || '') && !ledger.skip(fence(p)));
    if (missing.length) {
      const need = planNext({ requirements: [{ key: 'fence', count: missing.length }, { key: 'fence_gate', count: blockAt(pen.gate)?.name.endsWith('_fence_gate') ? 0 : 1 }],
        inventory, stations, kb });
      if (need && countKey('fence', inventory, kb) === 0) return step(ctx, need);
      ctx.record('ranch', { action: 'fence', position: posKey(missing[0]) });
      const placed = await skills.placeAt(bot, ctx, missing[0], (n) => kb.fence.match(n), { faces: DOWN });
      return recordTarget(bot, ctx, placed, fence(missing[0]));
    }
    const gate = blockAt(pen.gate);
    if (!gate?.name.endsWith('_fence_gate')) {
      const need = planNext({ requirements: [{ key: 'fence_gate', count: 1 }], inventory, stations, kb });
      if (need) return step(ctx, need);
      ctx.record('ranch', { action: 'gate' });
      // Placed from just outside, so it spans the fence line (faces north-south).
      const placed = await skills.placeAt(bot, ctx, pen.gate, (n) => kb.fence_gate.match(n),
        { faces: DOWN, stand: { x: pen.gate.x, y: pen.gate.y, z: pen.gate.z - 1 } });
      // An animal standing in the opening wanders off again by itself.
      if (placed.reason === 'cell_occupied_by_entity') { await sleep(waitMs, ctx.signal); return waiting('ranch_opening_occupied'); }
      return placed;
    }
    const facing = gate.getProperties?.().facing;
    if (facing && facing !== 'north' && facing !== 'south') {
      ctx.record('ranch', { action: 'gate_turned', facing });
      // Turned across the opening it lets animals walk past: take it up and place it again.
      const reach = await actions.goToDig(bot, ctx, gate, { timeoutMs: 20000 });
      if (!reach.ok) return reach;
      const dug = await actions.digBlock(bot, ctx, gate);
      if (dug.ok) await actions.collectDrops(bot, ctx, gate.position.offset(0.5, 0.5, 0.5), (n) => kb.fence_gate.match(n), { radius: 4, timeoutMs: 3000 });
      return dug;
    }

    const inside = husbandry.animalsIn(bot, pen, kind);
    const adults = inside.filter((e) => !husbandry.isBaby(bot, e));
    if (!husbandry.FOOD[kind]?.some((n) => (state.inventory[n] || 0) > 0)) return { ok: false, reason: 'no_food' };
    if (adults.length >= 2 && Date.now() - memory.bredAt > BREED_COOLDOWN_MS) {
      ctx.record('ranch', { action: 'breed', adults: adults.length });
      const result = await husbandry.breed(bot, ctx, pen, kind);
      memory.bredAt = Date.now();
      if (result.born) memory.born += 1;
      return result;
    }
    // More to lead in: the nearest one outside the pen.
    const outside = Object.values(bot.entities)
      .filter((e) => e.name === kind && e.position && !pen.contains(e.position) && !ledger.skip(animal(e))
        && !husbandry.isBaby(bot, e) && e.position.distanceTo(bot.entity.position) < 64)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (outside && adults.length < Math.max(2, target - 1)) {
      ctx.record('ranch', { action: 'lure', id: outside.id, distance: Math.round(outside.position.distanceTo(bot.entity.position)) });
      const result = await husbandry.lure(bot, ctx, pen, outside);
      return recordTarget(bot, ctx, result, animal(outside));
    }
    const settling = adults.length < 2;
    // A visible adult can settle back into the pen before another search.
    if (settling && !Object.values(bot.entities).some((e) => e.name === kind && e.position && !pen.contains(e.position)
      && !husbandry.isBaby(bot, e) && e.position.distanceTo(penMiddle()) < ROAM)) return skills.explore(bot, ctx, memory);
    if (pen.contains(bot.entity.position)) return husbandry.leave(bot, ctx, pen);
    await sleep(waitMs, ctx.signal);
    return waiting(settling ? 'animals_settling' : 'animals_breeding');
  }

  return {
    name: 'ranch',
    noProgressLimit: 30,
    memory,
    // Hunger must not be stilled with the animals this goal is keeping.
    spares: (entity) => entity?.name === kind,
    isDone: () => penCount() >= target && (!memory.pen || !memory.pen.contains(bot.entity.position)),
    progress: () => memory.steps,
    async run(ctx) {
      const result = await runOnce(ctx);
      if (isComplete(result)) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createRanchGoal };
