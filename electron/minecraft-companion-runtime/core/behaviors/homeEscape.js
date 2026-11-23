'use strict';

const { BAND } = require('../brain');
const { isComplete } = require('../action-result');
const defaultActions = require('../actions');
const { safeStand, SIDES } = require('../home-topology');
const { wet } = require('../dry-route');
const { goals } = require('mineflayer-pathfinder');
const { factsOf } = require('../action-result');

function createHomeEscape({ bot, home, tracker, adaptation, actions = defaultActions }) {
  return {
    name: 'home_escape',
    band: BAND.MAINTENANCE,
    want(state) {
      if (!state.alive || bot.isSleeping || String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') !== 'overworld') return 0;
      const goal = home();
      const geometry = goal?.trapped?.();
      if (geometry) tracker.force(geometry);
      if (tracker.state()) return 1;
      if (tracker.probe() || goal?.needsCleanup?.() || goal?.memory.breach) return 0.5;
      return 0;
    },
    async run(ctx) {
      const goal = home();
      const rescue = { ...ctx, rescue: 'home_escape', adapt: ctx.adapt ?? adaptation?.scope(() => !ctx.signal?.aborted) };
      tracker.takeProbe();
      if (!tracker.state() && goal?.needsCleanup?.()) return goal.clearScaffold(rescue);
      if (!tracker.state() && goal?.memory.breach) return goal.repairHomeBreach(rescue);
      if (goal?.nearForSelfRecovery?.()) {
        // The scheduler's probe is evidence only after a real failed walk.
        if (!tracker.state()) {
          const probe = await goal.probeDoor(rescue);
          if (probe.ok) { tracker.release(); return probe; }
          tracker.force('door_probe_failed');
        }
        const moved = await goal.escapeHome(rescue);
        if (isComplete(moved)) tracker.release();
        return moved;
      }
      if (!tracker.state()) {
        const feet = bot.entity.position.floored();
        const open = SIDES.map(([dx, dz]) => feet.offset(dx, 0, dz)).find(p => safeStand(q => bot.blockAt(q), p));
        if (open) {
          const step = await actions.goTo(bot, rescue, new goals.GoalBlock(open.x, open.y, open.z), { timeoutMs: 5000 });
          if (step.ok && bot.entity.position.floored().equals(open)) return step;
        }
        tracker.force('idle_exit_probe_failed');
      }
      const stuck = tracker.state();
      const waterOrigin = stuck?.reason === 'route_origin_water' ? stuck.position : null;
      function dryLanding() {
        const feet = bot.entity.position.floored();
        return !bot.entity.isInWater && bot.entity.onGround === true && safeStand(p => bot.blockAt(p), feet)
          && [-1, 0, 1].every(dy => !wet(bot.blockAt(feet.offset(0, dy, 0))));
      }
      function finish(method) {
        tracker.release();
        ctx.record('self_stuck_escaped', { method, position: bot.entity.position.floored() });
        return { ok: true };
      }
      const before = bot.entity.position.clone();
      if (waterOrigin && before.distanceTo(waterOrigin) >= 2 && dryLanding()) return finish('dry_ground');
      const walked = await actions.unstick(bot, rescue, waterOrigin ? { landed: dryLanding } : undefined);
      const escaped = () => waterOrigin ? dryLanding() && (bot.entity.position.distanceTo(waterOrigin) >= 2
        || ['swam_ashore', 'out_of_pool'].includes(factsOf(walked).moved)) : bot.entity.position.distanceTo(before) >= 2;
      const climbed = !escaped() && !walked.wait && await actions.surface?.(bot, rescue);
      return escaped() ? finish(waterOrigin ? 'dry_ground' : 'natural_route') : climbed?.wait ? climbed : walked.wait ? walked
        : { ok: false, reason: walked.reason || 'self_escape_unconfirmed' };
    },
  };
}

module.exports = { createHomeEscape };
