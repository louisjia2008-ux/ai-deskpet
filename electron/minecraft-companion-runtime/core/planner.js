'use strict';
// Pure planner: from the current inventory and placed stations, find the one
// step to take next toward a prioritized list of requirements.
//
// It walks the requirement tree against a *virtual* copy of the inventory, so
// items already earmarked for an earlier requirement are not counted twice.
// The first requirement whose inputs are all present becomes the next step.
// Nothing is remembered between calls: after any interruption, calling it
// again with the new inventory gives the right next step.

const { KNOWLEDGE, FUELS, countKey } = require('./knowledge');

// Guards against cycles only: a repeater from nothing is 14 levels deep
// (repeater, torch, redstone, iron pickaxe, iron, stone pickaxe, wood...).
const MAX_DEPTH = 24;

const stepTarget = (step, dimension) => ({ purpose: 'director_step', entity: `${step.kind}/${step.key || step.station}`, dimension });
const stepRetryAt = (step, planning) => planning?.ledger?.skip(stepTarget(step, planning.dimension))?.until || 0;

function planNext({ requirements, inventory, stations = {}, kb = KNOWLEDGE, planning }) {
  const virt = { ...inventory };
  const restore = (snapshot) => Object.assign(virt, snapshot);
  const check = (step) => {
    if (!step || step.kind === 'blocked') return step;
    const retryAt = stepRetryAt(step, planning);
    return retryAt ? { kind: 'blocked', key: step.key || step.station, retryAt } : step;
  };

  const take = (key, n) => {
    const entry = kb[key];
    let wanted = n;
    let names = Object.keys(virt).filter((name) => virt[name] > 0 && entry.match(name));
    // Families counted by their best variant (wool colors) draw from that variant only.
    if (entry.count) names = names.sort((a, b) => virt[b] - virt[a]).slice(0, 1);
    let taken = 0;
    for (const name of names) {
      const use = Math.min(virt[name], wanted);
      virt[name] -= use;
      wanted -= use;
      taken += use;
      if (wanted <= 0) break;
    }
    return taken;
  };

  function ensureTool(key, depth) {
    if (countKey(key, virt, kb) > 0) return null;
    return need(key, 1, depth + 1);
  }

  function ensureStation(station, depth) {
    if (stations[station]) return null;
    if ((virt[station] || 0) > 0) return { kind: 'place_station', station };
    return need(station, 1, depth + 1) || { kind: 'place_station', station };
  }

  function ensureFuel(items, depth) {
    let remaining = items;
    for (const [name, rate] of FUELS) {
      if (remaining <= 0) break;
      const have = virt[name] || 0;
      if (have <= 0) continue;
      const use = Math.min(have, Math.ceil(remaining / rate));
      virt[name] -= use;
      remaining -= use * rate;
    }
    if (remaining <= 0) return null;
    return need('log', Math.ceil(remaining / 1.5), depth + 1);
  }

  function need(key, count, depth = 0) {
    if (depth > MAX_DEPTH) return { kind: 'unplannable', key, reason: 'depth' };
    const entry = kb[key];
    if (!entry) return { kind: 'unplannable', key, reason: 'unknown' };
    // Tools are kept, not used up: one pickaxe serves every requirement that names it.
    const deficit = count - (entry.tool ? Math.min(count, countKey(key, virt, kb)) : take(key, count));
    if (deficit <= 0) return null;
    const snapshot = { ...virt };
    let deferred;
    for (const source of entry.sources) {
      if (source.when && !source.when(virt)) continue;
      const step = check(fromSource(source, key, deficit, depth));
      if (step?.kind !== 'blocked') return step;
      if (!deferred || step.retryAt < deferred.retryAt) deferred = step;
      restore(snapshot);
    }
    return deferred || { kind: 'unplannable', key, reason: 'no_source' };
  }

  function fromSource(source, key, deficit, depth) {
      if (source.kind === 'alias') return need(source.key, deficit, depth + 1);
      if (source.kind === 'craft') {
        const times = Math.min(source.maxBatch ?? Infinity, Math.ceil(deficit / source.yields));
        for (const [ingredient, per] of Object.entries(source.needs)) {
          const step = need(ingredient, per * times, depth + 1);
          if (step) return step;
        }
        if (source.table) {
          const step = ensureStation('crafting_table', depth);
          if (step) return step;
        }
        return { kind: 'craft', key, item: source.pick(inventory), times, table: source.table };
      }
      if (source.kind === 'gather') {
        if (source.tool) {
          const step = ensureTool(source.tool, depth);
          if (step) return step;
        }
        const step = { kind: 'gather', key, blocks: source.blocks, tool: source.tool || null, count: deficit };
        if (source.dimension) step.dimension = source.dimension;
        if (Number.isFinite(source.mineY)) step.mineY = source.mineY;
        if (source.rare) step.rare = true;
        return step;
      }
      if (source.kind === 'smelt') {
        const input = typeof source.inputItem === 'function' ? source.inputItem(virt) : source.inputItem;
        // A furnace accepts only one input type at a time. Reserve that exact
        // batch in the virtual bag before selecting fuel, never the same units.
        // Mixed logs can be processed in separate batches.
        const count = typeof source.inputItem === 'function' && input ? Math.min(deficit, virt[input]) : deficit;
        if (typeof source.inputItem === 'function' && input) virt[input] -= count;
        else {
          const inputStep = need(source.input, count, depth + 1);
          if (inputStep) return inputStep;
        }
        const stationStep = ensureStation('furnace', depth);
        if (stationStep) return stationStep;
        const fuelStep = ensureFuel(count, depth);
        if (fuelStep) return fuelStep;
        return { kind: 'smelt', key, input, count };
      }
      if (source.kind === 'farm') {
        return { kind: 'farm', key, crop: source.crop, count: deficit };
      }
      if (source.kind === 'fill') {
        // Each fill turns one empty bucket into a full one.
        const bucketStep = need(source.bucket, deficit, depth + 1);
        if (bucketStep) return bucketStep;
        return { kind: 'fill', key, liquid: source.liquid, count: deficit };
      }
      if (source.kind === 'hunt') {
        return { kind: 'hunt', key, mobs: source.mobs, count: deficit };
      }
      if (source.kind === 'cast') {
        // One lava bucket a block, the water bucket and the pickaxe come back.
        for (const kept of [source.tool, source.water, source.lava]) {
          const step = ensureTool(kept, depth);
          if (step) return step;
        }
        return { kind: 'cast', key, count: deficit };
      }
    return { kind: 'unplannable', key, reason: 'no_source' };
  }

  let deferred;
  for (const requirement of requirements) {
    const snapshot = { ...virt };
    const step = check(need(requirement.key, requirement.count));
    if (step?.kind === 'blocked') {
      if (!deferred || step.retryAt < deferred.retryAt) deferred = { ...step, for: requirement.key };
      restore(snapshot);
      continue;
    }
    if (step) return { ...step, for: requirement.key };
  }
  return deferred || null;
}

module.exports = { stepTarget, stepRetryAt, planNext };
