'use strict';

const { BAND } = require('../brain');
const { factsOf, isComplete } = require('../action-result');
const defaultActions = require('../actions');
const { safeStand, SIDES } = require('../home-topology');
const { wet } = require('../dry-route');
const { goals } = require('mineflayer-pathfinder');
const { abortError, sleep } = require('../confirm');
const { boundedWork } = require('../work-budget');

function createHomeEscape({ bot, home, tracker, adaptation, actions = defaultActions, now = Date.now }) {
  const methods = [
    ['step_out_of_pool', 8_000, async c => await actions.stepOutOfPool?.(bot, c, { maxTicks: 35 })
      || await actions.drainPocket?.(bot, c)],
    ['swim_ashore', 10_000, c => actions.swimAshore?.(bot, c, { maxTicks: 160 })],
    ['dig_exit', 20_000, c => actions.digWaterExit?.(bot, c)],
    ['pillar_up', 22_000, c => actions.digWaterExit?.(bot, c, { pillar: true })],
  ];
  let episode;
  const waterStuck = (state = {}) => Boolean(tracker.state() && (state.inWater || bot.entity.isInWater
    || wet(bot.blockAt(bot.entity.position.floored()))));
  function finish(ctx, method) {
    tracker.release();
    episode = null;
    ctx.record('self_stuck_escaped', { method, position: bot.entity.position.floored() });
    return { ok: true };
  }

  async function waterEscape(ctx, stuck) {
    const dry = () => defaultActions.dryLanding(bot, true);
    if (episode?.stuck !== stuck) episode = { stuck, index: 0, elapsed: 0, interruptions: [] };
    const record = (type, method, fields) => ctx.record(type, { episode: stuck.at, method, ...fields });
    if (episode.pending) {
      const { method, count, ...step } = episode.pending;
      episode.pending = null;
      if (count > 6) record('water_rescue_alert', method, { reason: 'preemption_limit', count });
      record('water_rescue_step', method, step);
    }
    if (dry()) return finish(ctx, 'dry_ground');
    if (episode.retryAt) {
      await sleep(Math.max(0, episode.retryAt - now()), ctx.signal);
      if (dry()) return finish(ctx, 'dry_ground');
      Object.assign(episode, { retryAt: 0, index: 0, elapsed: 0 });
    }
    while (episode.index < methods.length) {
      const [method, limit, run] = methods[episode.index];
      const started = now(), elapsed = episode.elapsed;
      record('water_rescue_step', method, { phase: elapsed ? 'resume' : 'start', elapsedMs: elapsed, limitMs: limit });
      try {
        await boundedWork(bot, ctx, { timeoutMs: Math.max(1, limit - elapsed), check: () => true, limitResult: () => null }, run);
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
      } catch (error) {
        if (!ctx.signal?.aborted) throw error;
        episode.elapsed += now() - started;
        if (ctx.signal.reason === 'preempted_by:breathe') {
          episode.interruptions = episode.interruptions.filter(at => at > now() - 300_000);
          episode.interruptions.push(now());
        }
        const count = episode.interruptions.length;
        if (count > 6 || episode.elapsed >= limit) {
          if (count > 6) episode.interruptions = [];
          episode.pending = { method, count, ...advance() };
        }
        throw error;
      }
      if (dry()) return finish(ctx, method);
      record('water_rescue_step', method, advance());

      function advance() {
        episode.index++;
        episode.elapsed = 0;
        return { phase: 'advance', elapsedMs: elapsed + now() - started, next: methods[episode.index]?.[0] };
      }
    }
    record('water_rescue_alert', null, { reason: 'methods_exhausted' });
    episode.retryAt = now() + 3000;
    return { ok: false, reason: 'self_escape_unconfirmed' };
  }

  return {
    name: 'home_escape',
    band: BAND.MAINTENANCE,
    rescue: waterStuck,
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
      const stuck = tracker.state();
      if (stuck && (waterStuck() || stuck.reason === 'route_origin_water' || episode?.stuck === stuck)) return waterEscape(rescue, stuck);
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
      const before = bot.entity.position.clone();
      const walked = await actions.unstick(bot, rescue);
      const escaped = result => bot.entity.position.distanceTo(before) >= 2 && !result?.wait && result?.reason !== 'still_below_surface'
        && factsOf(result).surfaced !== false;
      const climbed = !escaped(walked) && !walked.wait && await actions.surface?.(bot, rescue);
      return escaped(climbed || walked) ? finish(ctx, 'natural_route') : climbed?.wait ? climbed : walked.wait ? walked
        : { ok: false, reason: walked.reason || 'self_escape_unconfirmed' };
    },
  };
}

module.exports = { createHomeEscape };
