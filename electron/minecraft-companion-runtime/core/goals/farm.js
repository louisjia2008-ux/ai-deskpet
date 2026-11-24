'use strict';
// Goal: a working wheat farm and bread from it.
//
// Every run() reads the plots from the world and does the most useful single
// thing: harvest a ripe crop, sow an empty farmland, till a new plot, bake
// bread, or fetch what one of those needs (a hoe, seeds). With nothing ready
// it waits, which neither spends nor refills the goal's stall budget.

const { isComplete, waiting } = require('../action-result');
const { Vec3 } = require('vec3');
const { nightBudget } = require('../behaviors/nightRest');
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
const { runSearchLeg } = require('../adaptation-strategies');

// Farther than this from the centre, the farm's ground may be out of view.
const FAR_FROM_FARM = 48;

function createFarmGoal({ bot, center, plots: plotCount = 16, bread = 3, home = null,
  skills = defaultSkills, farming = defaultFarming, actions = defaultActions, kb = KNOWLEDGE, exclude = () => false, waitMs = 3000,
  mode = 'bread', sharedMemory = null, minRipe = 3 } = {}) {
  const memory = sharedMemory || { center: center || null, plots: null, table: home?.table || null, harvested: 0 };
  const homestead = () => bot.companionHomestead?.()?.memory;
  const anchor = () => home?.anchor || homestead()?.house?.interiorCenter || homestead()?.searchOrigin || center
    || (memory.anchor ||= bot.entity?.position.floored());
  const distance = (p, c = anchor()) => c ? Math.hypot(p.x - c.x, p.z - c.z) : 0;
  const outside = p => distance(p) > FAR_FROM_FARM;
  const stateAt = (p) => farming.plotState(bot, p);
  const count = (states) => (memory.plots || []).filter(p => !outside(p) && states.includes(stateAt(p))).length;
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  // Never put the crafting table on a plot.
  const onPlot = (p) => (memory.plots || []).some((q) => q.x === p.x && q.z === p.z);
  const explore = (ctx, kind) => {
    const search = (memory.search ||= {})[kind] ||= {};
    const { x, z } = anchor();
    search.around = { x, z, radius: FAR_FROM_FARM };
    return runSearchLeg(ctx, search, () => skills.explore(bot, ctx, search),
      { reason: 'no_farmland_near_home', observe: () => bot.entity.position });
  };
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, purpose: 'farm_gather',
    avoid: (p) => onPlot(p) || outside(p) || exclude(p), explore });

  const operation = { ripe: 'harvest', empty: 'plant', untilled: 'till' };
  const spec = (p, step) => blockTarget(bot, 'farm', step, p, {
    cells: [{ ...p, y: p.y + 1 }], tools: /_hoe$/,
  });
  const unavailable = (p, targets, allowHarvest = true) => {
    const step = operation[stateAt(p)];
    return step && (allowHarvest || step !== 'harvest') && targets.excluded(spec(p, step));
  };

  const choose = (targets, center, count, keep = []) => farming.choosePlots(blockAt, center, {
    count, exclude: p => outside(p) || exclude(p) || keep.some(q => q.x === p.x && q.z === p.z) || unavailable(p, targets, false),
    findWater: (c, r) => farming.findWater(bot, c, r),
  });
  function plots(ctx, targets, budget, enough) {
    if (!memory.center || outside(memory.center)) memory.center = anchor();
    const prior = memory.plots || [];
    const keep = prior.filter(p => !outside(p) && !['lost', 'blocked'].includes(stateAt(p)) && !unavailable(p, targets, false)
      && (stateAt(p) === 'unknown' || !farming.litPlot || farming.litPlot(blockAt, p)));
    const missing = plotCount - keep.length;
    if (missing > 0) {
      let picks = choose(targets, memory.center, missing, keep);
      if (picks.length < enough - keep.length && farming.findGround) {
        const fits = p => distance(p) <= Math.min(FAR_FROM_FARM, budget.maxOutingDistance)
          && choose(targets, p, missing, keep).length >= enough - keep.length;
        const ground = farming.findGround(bot, anchor(), FAR_FROM_FARM, { fits });
        if (ground) {
          memory.center = ground;
          picks = choose(targets, ground, missing, keep);
        }
      }
      memory.plots = [...keep, ...picks];
      if (keep.length < prior.length) ctx.record('farm_replaced_plots', { removed: prior.filter(p => !keep.includes(p)).map(posKey), added: picks.map(posKey) });
      if (picks.length) ctx.record('farm_plots', { total: memory.plots.length, plotKeys: memory.plots.map(posKey),
        dry: memory.plots.filter(p => p.hydrated === false).length });
    }
    return memory.plots;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    const targets = targetsFor(bot, ctx);
    const at = bot.entity.position;
    const c = anchor();
    const budget = nightBudget(state, c);
    if (budget.maxOutingDistance <= 0) return waiting('waiting_for_safe_daylight');
    if (outside(at)) return actions.goNear(bot, { ...ctx, dryRoute: true }, new Vec3(c.x, c.y, c.z), 6, { timeoutMs: 60000 });
    const { workArea } = ctx;
    ctx = { ...ctx, dryRoute: true, pathArea: p => distance(p) <= FAR_FROM_FARM - 1,
      workArea: p => distance(p) <= FAR_FROM_FARM - 4 && (!workArea || workArea(p)) };
    const enough = mode === 'sow' ? plotCount : Math.min(4, plotCount);
    const list = mode === 'harvest' ? (memory.plots || []).filter(p => !outside(p)) : plots(ctx, targets, budget, enough);
    if (!list.length) return mode === 'harvest' ? { ok: true } : explore(ctx, 'ground');
    if (list.length >= enough && memory.search) delete memory.search.ground;
    // A seed search can wander out of view of the farm. Its plots then read
    // as unknown, never ripe or empty, and the goal would wait there forever.
    const unseen = list.find((p) => farming.plotState(bot, p) === 'unknown');
    if (unseen) {
      ctx.record('farm', { action: 'return', plot: posKey(unseen) });
      return farming.returnTo(bot, ctx, unseen);
    }
    const byState = (s) => list.filter((p) => stateAt(p) === s && !unavailable(p, targets));
    const work = (step, p) => {
      ctx.record('farm', { action: step, plot: posKey(p) });
      return targets.run(spec(p, step), () => farming[step](bot, ctx, p), async (reason) => {
        const moved = await alternateStand(bot, ctx, actions, { ...p, y: p.y + 1 }, { avoid: onPlot });
        return moved.ok ? farming[step](bot, ctx, p) : { ok: false, reason };
      });
    };
    const stations = { crafting_table: tableHere() };
    const inventory = inventoryFor(state);
    if (mode !== 'harvest' && inventory.water_bucket && farming.irrigate && !memory.irrigationTried
      && list.some(p => !p.hydrated) && !farming.findWater(bot, c, FAR_FROM_FARM, false).length) {
      const result = await farming.irrigate(bot, ctx, list);
      if (result?.kind === 'interrupted' || result?.kind === 'start' || result?.wait) return result;
      memory.irrigationTried = true;
      if (isComplete(result)) {
        memory.plots = list.filter(p => p.hydrated || ['growing', 'ripe'].includes(stateAt(p)));
        return result;
      }
    }

    // Bread first whenever three wheat are in the bag: with a large farm
    // something is always ripe, and the harvest would never end.
    if (mode !== 'sow' && (mode === 'harvest' || countKey('bread', state.inventory, kb) < bread) && (inventory.wheat || 0) >= 3) {
      const breadStep = planNext({ requirements: [{ key: 'bread', count: countKey('bread', state.inventory, kb) + 1 }], inventory, stations, kb,
        planning: ctx.planning });
      if (breadStep && breadStep.kind !== 'farm') return step(ctx, { ...breadStep, for: 'bread' });
    }
    const ripe = mode !== 'sow' && byState('ripe')[0];
    if (ripe) {
      if (mode === 'harvest') memory.harvestPending = true;
      const result = await work('harvest', ripe);
      if (isComplete(result)) memory.harvested += result.gained || 0;
      return result;
    }
    const empty = byState('empty')[0];
    if (empty && inventory.wheat_seeds > 0) return work('plant', empty);
    // Tilled only with a seed to sow: bare farmland dries back to dirt, and a
    // farm short of seeds in the desert tilled the same plots 400 times.
    const untilled = byState('untilled')[0];
    if (untilled && inventory.wheat_seeds > 0) {
      const hoeStep = planNext({ requirements: [{ key: 'hoe', count: 1 }], inventory, stations, kb, planning: ctx.planning });
      if (hoeStep) return step(ctx, { ...hoeStep, for: 'hoe' });
      return work('till', untilled);
    }
    // Empty farmland and no seeds: break grass until some drop.
    if ((byState('empty').length || untilled) && !(inventory.wheat_seeds > 0)) {
      ctx.record('farm', { action: 'seeds' });
      const result = await farming.gatherSeeds(bot, ctx, { exclude: onPlot });
      if (result.reason === 'no_grass') return explore(ctx, 'seeds');
      if (result.seeds > 0 && memory.search) delete memory.search.seeds;
      return result;
    }
    // Everything sown: the crops grow on their own.
    if (mode !== 'harvest' && list.length < enough) return explore(ctx, 'ground');
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
    progress: state => mode === 'sow' ? count(['growing', 'ripe'])
      : memory.harvested + countKey('bread', state.inventory, kb),
    work(state, inventory = state.inventory) {
      if (mode !== 'sow') return { remaining: 3 * count(['unknown', 'ripe']) + 2 * count(['untilled'])
        + count(['empty']) + Math.floor((inventory.wheat || 0) / 3), position: memory.plots?.[0] ?? center };
      const remaining = plotCount - count(['growing', 'ripe']);
      const seeds = Math.min(remaining, inventory.wheat_seeds || 0);
      const hoe = Number(countKey('hoe', inventory, kb) > 0);
      return { remaining, ready: seeds === remaining && Boolean(hoe), readiness: (seeds + hoe) / (remaining + 1),
        progress: plotCount - remaining, position: memory.plots?.[0] ?? center };
    },
    run: runOnce,
  };
}

module.exports = { createFarmGoal };
