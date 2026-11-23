'use strict';
// Goal: a working wheat farm and bread from it.
//
// Every run() reads the plots from the world and does the most useful single
// thing: harvest a ripe crop, sow an empty farmland, till a new plot, bake
// bread, or fetch what one of those needs (a hoe, seeds). With nothing ready
// it waits, which neither spends nor refills the goal's stall budget.

const { waiting } = require('../action-result');
const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const defaultFarming = require('../farming');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { posKey } = require('../blacklist');
const { sleep } = require('../confirm');
const { createPlannerRunner } = require('./common');
const { targetsFor } = require('../failure-ledger');
const { blockTarget, alternateStand } = require('../target-recovery');

// Farther than this from the centre, the farm's ground may be out of view.
const FAR_FROM_FARM = 48;

function createFarmGoal({ bot, center, plots: plotCount = 16, bread = 3, home = null,
  skills = defaultSkills, farming = defaultFarming, actions = defaultActions, kb = KNOWLEDGE, exclude = () => false, waitMs = 3000,
  mode = 'bread', sharedMemory = null, minRipe = 3 } = {}) {
  const memory = sharedMemory || { center: center || null, barren: false, plots: null, table: home?.table || null, steps: 0, harvested: 0, shortfall: {} };
  const stateAt = (p) => farming.plotState(bot, p);
  const count = (states) => (memory.plots || []).filter((p) => states.includes(stateAt(p))).length;
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  // Never put the crafting table on a plot.
  const onPlot = (p) => (memory.plots || []).some((q) => q.x === p.x && q.z === p.z);
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, purpose: 'farm_gather',
    avoid: (p) => onPlot(p) || exclude(p) });

  const operation = { ripe: 'harvest', empty: 'plant', untilled: 'till' };
  const spec = (p, step) => blockTarget(bot, 'farm', step, p, {
    cells: [{ ...p, y: p.y + 1 }], tools: /_hoe$/,
  });
  const unavailable = (p, targets, allowHarvest = true) => {
    const step = operation[stateAt(p)];
    return step && (allowHarvest || step !== 'harvest') && targets.excluded(spec(p, step));
  };

  function plots(ctx, targets) {
    if (!memory.center) memory.center = bot.entity.position.floored();
    const prior = memory.plots || [];
    const keep = prior.filter(p => !['lost', 'blocked'].includes(stateAt(p)) && !unavailable(p, targets, false));
    if (keep.length < plotCount) {
      const picks = farming.choosePlots(blockAt, memory.center, {
        count: plotCount - keep.length,
        exclude: p => exclude(p) || keep.some(q => q.x === p.x && q.z === p.z) || unavailable(p, targets, false),
        findWater: (c, r) => farming.findWater(bot, c, r),
      });
      memory.plots = [...keep, ...picks];
      if (keep.length < prior.length) ctx.record('farm_replaced_plots', { removed: prior.filter(p => !keep.includes(p)).map(posKey), added: picks.map(posKey) });
    }
    return memory.plots;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    const targets = targetsFor(bot, ctx);
    // Asked for from far off (a hunt that wandered 900 blocks away): plots
    // chosen there were none, and the goal explored for an hour and a half
    // instead of going back. Walk back to the farm first.
    const c = memory.center;
    const at = bot.entity.position;
    const enough = mode === 'sow' ? plotCount : Math.min(4, plotCount);
    const fits = (p) => farming.choosePlots(blockAt, p, { count: plotCount, exclude: (q) => exclude(q) || unavailable(q, targets, false),
      findWater: (w, r) => farming.findWater(bot, w, r) }).length >= enough;
    const moveTo = (ground) => {
      ctx.record('farm', { action: 'move', from: posKey(memory.center), to: posKey(ground) });
      memory.center = ground;
      memory.plots = null;
      memory.barren = false;
      return farming.returnTo(bot, ctx, ground);
    };
    if (mode === 'harvest' && !memory.plots?.length) return { ok: true };
    if (mode !== 'harvest' && c && Math.hypot(at.x - c.x, at.z - c.z) > FAR_FROM_FARM) {
      // Out looking for soil, the old centre has none to go back to: the
      // nearest soil here that holds a farm, or further on.
      if (memory.barren && farming.findGround) {
        const ground = farming.findGround(bot, at.floored(), FAR_FROM_FARM, { fits });
        return ground ? moveTo(ground) : skills.explore(bot, ctx, memory);
      }
      ctx.record('farm', { action: 'return', distance: Math.round(Math.hypot(at.x - c.x, at.z - c.z)) });
      return farming.returnTo(bot, ctx, c);
    }
    const list = mode === 'harvest' ? memory.plots : plots(ctx, targets);
    if (mode !== 'harvest' && list.length < enough && farming.findGround) {
      // No soil around the centre (sand, stone): move the farm to the nearest soil that holds one.
      const ground = farming.findGround(bot, memory.center, FAR_FROM_FARM, { fits });
      if (ground) return moveTo(ground);
      memory.barren = true;
      return skills.explore(bot, ctx, memory);
    }
    if (!list.length) return skills.explore(bot, ctx, memory);
    // A seed search can wander out of view of the farm. Its plots then read
    // as unknown, never ripe or empty, and the goal would wait there forever.
    const unseen = list.find((p) => farming.plotState(bot, p) === 'unknown');
    if (unseen) {
      ctx.record('farm', { action: 'return', plot: posKey(unseen) });
      return farming.returnTo(bot, ctx, unseen);
    }
    const byState = (s) => list.filter((p) => stateAt(p) === s && !unavailable(p, targets));
    const work = (step, p) => targets.run(spec(p, step), () => farming[step](bot, ctx, p), async (reason) => {
      const moved = await alternateStand(bot, ctx, actions, { ...p, y: p.y + 1 }, { avoid: onPlot });
      return moved.ok ? farming[step](bot, ctx, p) : { ok: false, reason };
    });
    const stations = { crafting_table: tableHere() };
    const inventory = inventoryFor(state);

    // Bread first whenever three wheat are in the bag: with a large farm
    // something is always ripe, and the harvest would never end.
    if (mode !== 'sow' && (mode === 'harvest' || countKey('bread', state.inventory, kb) < bread) && (inventory.wheat || 0) >= 3) {
      const breadStep = planNext({ requirements: [{ key: 'bread', count: countKey('bread', state.inventory, kb) + 1 }], inventory, stations, kb,
        stepBlocked: ctx.stepBlocked });
      if (breadStep && breadStep.kind !== 'farm') return step(ctx, { ...breadStep, for: 'bread' });
    }
    const ripe = mode !== 'sow' && byState('ripe')[0];
    if (ripe) {
      ctx.record('farm', { action: 'harvest', plot: posKey(ripe) });
      if (mode === 'harvest') memory.harvestPending = true;
      const result = await work('harvest', ripe);
      if (result.ok) memory.harvested += result.gained || 0;
      return result;
    }
    const empty = byState('empty')[0];
    if (empty && (inventory.wheat_seeds || 0) > 0) {
      ctx.record('farm', { action: 'plant', plot: posKey(empty) });
      return work('plant', empty);
    }
    // Tilled only with a seed to sow: bare farmland dries back to dirt, and a
    // farm short of seeds in the desert tilled the same plots 400 times.
    const untilled = byState('untilled')[0];
    if (untilled && (inventory.wheat_seeds || 0) > 0) {
      const hoeStep = planNext({ requirements: [{ key: 'hoe', count: 1 }], inventory, stations, kb, stepBlocked: ctx.stepBlocked });
      if (hoeStep) return step(ctx, { ...hoeStep, for: 'hoe' });
      ctx.record('farm', { action: 'till', plot: posKey(untilled) });
      return work('till', untilled);
    }
    // Empty farmland and no seeds: break grass until some drop.
    if ((byState('empty').length || untilled) && !(inventory.wheat_seeds > 0)) {
      ctx.record('farm', { action: 'seeds' });
      const result = await farming.gatherSeeds(bot, ctx, { exclude: (p) => list.some((q) => q.x === p.x && q.z === p.z) });
      if (result.reason === 'no_grass') return skills.explore(bot, ctx, memory);
      return result;
    }
    // Everything sown: the crops grow on their own.
    await sleep(waitMs, ctx.signal);
    return waiting(mode === 'bread' ? 'crops_growing' : 'no_available_plot');
  }

  return {
    name: mode === 'harvest' ? 'harvest_wheat' : 'farm',
    noProgressLimit: 30,
    memory,
    harvestNeeded: () => Boolean(memory.harvestPending || count(['ripe']) >= minRipe),
    isDone(state) {
      if (mode === 'sow') return count(['growing', 'ripe']) >= plotCount;
      if (mode === 'harvest') {
        if (!memory.harvestPending && count(['ripe']) < minRipe) return true;
        if (count(['unknown', 'ripe', 'empty', 'untilled']) || (state.inventory.wheat || 0) >= 3) return false;
        memory.harvestPending = false;
        return true;
      }
      return countKey('bread', state.inventory, kb) >= bread
        && (!(state.inventory.wheat_seeds > 0) || !count(['empty']));
    },
    progress: () => memory.steps,
    async run(ctx) {
      const result = await runOnce(ctx);
      if (result.ok && !result.wait) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createFarmGoal };
