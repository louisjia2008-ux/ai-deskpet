'use strict';

const { BAND } = require('../brain');
const defaultActions = require('../actions');
const { safeStand, SIDES } = require('../home-topology');
const { goals } = require('mineflayer-pathfinder');

function createHomeEscape({ bot, home, tracker, actions = defaultActions }) {
  return {
    name: 'home_escape',
    band: BAND.MAINTENANCE + 1,
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
      const rescue = { ...ctx, selfRescue: true };
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
        if (moved.ok) tracker.release();
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
      const before = bot.entity.position.clone();
      const walked = await actions.unstick(bot, rescue);
      if (bot.entity.position.distanceTo(before) < 2) await actions.surface(bot, rescue);
      if (bot.entity.position.distanceTo(before) < 2) return { ok: false, reason: walked.reason || 'self_escape_unconfirmed' };
      tracker.release();
      ctx.record('self_stuck_escaped', { method: 'natural_route', position: bot.entity.position.floored() });
      return { ok: true };
    },
  };
}

module.exports = { createHomeEscape };
