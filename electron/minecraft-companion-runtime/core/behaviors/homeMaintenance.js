'use strict';

const { complete, failure, isComplete } = require('../action-result');
const { BAND } = require('../brain');
const { createScheduleBackoff } = require('../schedule-backoff');
const { boundedWork } = require('../work-budget');
const { nightBudget } = require('./nightRest');

function createHomeMaintenance({ bot, home, activeGoal = () => null, mayRepair = () => !activeGoal(), now = Date.now,
  backoff = createScheduleBackoff(now), missingGearDelayMs = 5000, noChangeLimit = 3, retryMs = 60000,
  stepLimitMs = 10 * 60000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  const key = 'maintenance:house';
  const overworld = () => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') === 'overworld';
  let lastHome, gearMissingSince, upgrade, unchanged = 0;

  function work(state) {
    const goal = home();
    if (goal !== lastHome) {
      [lastHome, gearMissingSince, upgrade, unchanged] = [goal, null, null, 0];
      backoff.clear(key);
    }
    if (!goal?.memory.established || !overworld() || backoff.blocked(key) > now() || state.alive === false ||
        !(state.health >= 10 && state.food > 12) || state.sheltered || nightBudget(state).dark ||
        state.hostiles?.some(h => h.distance <= 8)) return null;
    const repair = mayRepair() && goal.repairPart?.(state);
    if (repair) return repair;
    const active = activeGoal(), status = goal.maintenance?.(state);
    if (!status || active === 'homestead' || active === 'outfit' && !status.missing.includes('chest')) return null;
    gearMissingSince = status.gear.length ? gearMissingSince ?? now() : null;
    if (status.missing.length || status.unverified.length ||
        (gearMissingSince !== null && now() - gearMissingSince >= missingGearDelayMs)) return 'home';
    if (goal.optionalMaintenance && !active && !status.gear.length) {
      return goal.wantsLighting(state) ? 'lighting' : goal.wantsGuestBed(state) ? 'guestBed' : null;
    }
    return null;
  }

  const observed = state => JSON.stringify([lastHome.maintenance(state), ...Object.entries(state.inventory).sort(),
    lastHome.memory.furnace]);
  return {
    name: 'home_maintenance',
    band: BAND.MAINTENANCE,
    want(state) {
      const step = work(state);
      return step === 'home' ? 0.2 : step ? 0.1 : 0;
    },
    async run(ctx) {
      const state = ctx.perceive(), step = work(state);
      if (!step) return complete(false);
      const goal = lastHome;
      const before = observed(state);
      const definition = step === 'home' ? goal : (upgrade?.kind === step && !upgrade.goal.isDone(state)
        ? upgrade : (upgrade = { kind: step, goal: goal[`${step}Goal`]() })).goal;
      const result = await boundedWork(bot, ctx, { timeoutMs: stepLimitMs, check: overworld,
        limitResult: () => failure(overworld() ? 'maintenance_timeout' : 'left_overworld', {}, ctx) },
      attempt => definition.run(attempt));
      if (ctx.signal?.aborted || result?.wait || ['start', 'interrupted'].includes(result?.kind)) return result;
      const after = ctx.perceive();
      if (before !== observed(after) || isComplete(result) && state.position?.distanceTo?.(after.position) >= 1) {
        unchanged = 0;
        backoff.clear(key);
      } else if (++unchanged >= noChangeLimit) {
        unchanged = 0;
        const { until: retryAt } = backoff.fail(key, retryMs, 16 * retryMs);
        ctx.record('home_maintenance_paused', { reason: 'no_observed_change', retryAt });
      }
      return result;
    },
  };
}

module.exports = { createHomeMaintenance };
