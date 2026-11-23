'use strict';
const { nightBudget } = require('./nightRest');
// Reuse the established home's planner without replacing the current player
// or device goal. Survival and night rest stay above this maintenance work.
const { complete } = require('../action-result');
const { BAND } = require('../brain');

// Goals that bring their own tools and gear.
const OWN_GEAR = new Set(['homestead', 'outfit']);

function createHomeMaintenance({ bot, home, activeGoal = () => null, mayRepair = () => !activeGoal(), now = Date.now,
  missingGearDelayMs = 5000, noChangeLimit = 3, retryMs = 60000, stepLimitMs = 10 * 60000, watchMs = 1000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  let gearMissingSince = null;
  let noChange = 0;
  let retryAt = 0;
  let pauses = 0;
  let lastHome = null;
  let upgrade = null;

  function current() {
    const goal = home();
    if (goal !== lastHome) {
      lastHome = goal;
      gearMissingSince = null;
      noChange = 0;
      retryAt = 0;
      pauses = 0;
      upgrade = null;
    }
    return goal;
  }

  function observed(goal, state, { moved = true } = {}) {
    const status = goal.maintenance(state);
    // steps is an action counter, not evidence of changed inventory or world.
    return JSON.stringify({ ...status,
      inventory: Object.entries(state.inventory).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)),
      position: moved && state.position && [state.position.x, state.position.y, state.position.z].map((n) => Math.floor(n)),
      furnace: goal.memory.furnace });
  }

  function accountAttempt(ctx, goal, before, result) {
    // Waiting and survival preemption neither spend nor refill this budget.
    if (ctx.signal?.aborted || result?.wait || ['start', 'interrupted'].includes(result?.kind)) return;
    // A failed path can monopolize maintenance just as a no-op success can.
    // Only observed inventory/world/body progress resets the streak. A failed
    // walk always moves the body, so after a failure only the house and the
    // bag count: a crafting table out of reach took the body from a Nether
    // trip every thirty seconds, walking half way home and timing out.
    const failed = result?.ok === false;
    const after = observed(goal, ctx.perceive(), { moved: !failed });
    if ((failed ? before.still : before.key) === after) noChange += 1;
    else { noChange = 0; pauses = 0; }
    if (noChange >= noChangeLimit) {
      noChange = 0;
      // Each pause in a row waits twice as long, up to sixteen times.
      retryAt = now() + retryMs * 2 ** Math.min(pauses, 4);
      pauses += 1;
      ctx.record('home_maintenance_paused', { reason: 'no_observed_change', retryAt });
    }
  }

  const overworld = () => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') === 'overworld';
  function next(goal, state) {
    if (!goal?.memory.established || typeof goal.maintenance !== 'function' || !overworld()) return null;
    const active = activeGoal(), status = goal.maintenance(state);
    const safe = now() >= retryAt && state.alive !== false && state.health >= 10 && state.food > 12
      && !nightBudget(state).dark && !state.sheltered && !state.hostiles?.some(h => h.distance <= 8);
    const repair = safe && mayRepair() && goal.repairPart?.(state);
    if (repair) return repair;
    if (OWN_GEAR.has(active) && !(active === 'outfit' && status.missing.includes('chest'))) return null;
    gearMissingSince = status.gear.length ? gearMissingSince ?? now() : null;
    if (!safe) return null;
    if (status.missing.length || status.unverified.length
      || (gearMissingSince !== null && now() - gearMissingSince >= missingGearDelayMs)) return 'home';
    if (goal.optionalMaintenance && !active && !status.gear.length) {
      return goal.wantsLighting(state) ? 'lighting' : goal.wantsGuestBed(state) ? 'guestBed' : null;
    }
    return null;
  }
  // House work belongs to the overworld and to a few minutes at a time.
  // Carried through the portal beside the house, a repair walk hung in the
  // Nether for four hours: stop it once the bot is out of the overworld or
  // the step runs long, whether or not the step heeds its abort.
  async function watched(ctx, step) {
    const inner = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, inner.signal]) : inner.signal;
    const started = now();
    let timer = null;
    const watchdog = new Promise((resolve) => {
      const check = () => {
        if (ctx.signal?.aborted) return resolve({ ok: false, reason: 'aborted' });
        if (!overworld()) return resolve({ ok: false, reason: 'left_overworld' });
        if (now() - started > stepLimitMs) return resolve({ ok: false, reason: 'maintenance_timeout' });
        timer = setTimeout(check, watchMs);
      };
      check();
    });
    try {
      const run = Promise.resolve().then(() => step({ ...ctx, signal }));
      const result = await Promise.race([run, watchdog]);
      if (!inner.signal.aborted && result && (result.reason === 'left_overworld' || result.reason === 'maintenance_timeout')) {
        inner.abort(result.reason);
        run.catch(() => {});
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'home_maintenance',
    band: BAND.MAINTENANCE,
    want(state) {
      const work = next(current(), state);
      return work === 'home' ? 0.2 : work ? 0.1 : 0;
    },
    async run(ctx) {
      const goal = current();
      const start = ctx.perceive();
      const work = next(goal, start);
      if (!work) return complete(false);
      const before = { key: observed(goal, start), still: observed(goal, start, { moved: false }) };
      let result;
      try {
        const definition = work === 'home' ? goal : (upgrade?.kind === work && !upgrade.goal.isDone(start)
          ? upgrade.goal : (upgrade = { kind: work, goal: goal[`${work}Goal`]() }).goal);
        result = await watched(ctx, inner => definition.run(inner));
      } catch (error) {
        if (error?.code !== 'aborted' && error?.code !== 'ABORT_ERR' && error?.name !== 'AbortError') {
          try { accountAttempt(ctx, goal, before); } catch { /* Preserve the original repair exception. */ }
        }
        throw error;
      }
      accountAttempt(ctx, goal, before, result);
      return result;
    },
  };
}

module.exports = { createHomeMaintenance };
