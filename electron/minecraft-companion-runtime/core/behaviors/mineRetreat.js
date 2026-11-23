'use strict';

const { BAND } = require('../brain');
const mining = require('../mining');
const actions = require('../actions');

function createMineRetreat({ bot, adaptation, enabled }) {
  function threat(state) {
    const route = bot.companionMineRoute;
    if (!enabled() || !route || !state.position || state.position.y >= route.surfaceY - 1
      || String(bot.game?.dimension || '').replace('minecraft:', '') !== 'overworld') return null;
    // Existing immediate survival behaviors own lava, drowning and suffocation.
    if (bot.entity.isInLava || (bot.entity.isInWater && bot.oxygenLevel < 15)) return null;
    if (route.safetyRetreat) return route.safetyRetreat;
    if (!mining.knownOpen(route, state.position.floored())
      && (Math.hypot(state.position.x - route.front.x, state.position.z - route.front.z) > 12
        || Math.abs(state.position.y - route.front.y) > 10)) return null;
    const enemy = state.hostiles?.find((e) => /^(silverfish|cave_spider|creeper)$/.test(e.name) && e.distance <= 10);
    if (enemy) return enemy.name;
    if (state.health < (route.closed ? 17 : 12) || state.food <= 6) return 'low_supplies';
    return null;
  }
  return {
    name: 'mine_retreat', band: BAND.ESCAPE,
    want: (state) => threat(state)
      && adaptation.plan('mine_hazard', { position: bot.companionMineRoute.entrance }).method !== 'do_other_work' ? 0.9 : 0,
    async run(ctx) {
      const state = ctx.perceive();
      const mine = bot.companionMineRoute;
      const why = threat(state);
      if (!why) return { ok: false, reason: 'threat_cleared' };
      const scope = adaptation.scope(() => !ctx.signal?.aborted && enabled() && bot.companionMineRoute === mine);
      const area = { position: mine.entrance };
      if (!mine.safetyRetreat) {
        mine.safetyRetreat = why;
        const hazardous = why !== 'low_supplies';
        if (hazardous) {
          mine.retiring = true;
          scope.teach('mine_danger', state.position, 'overworld', why, 48);
          scope.teach('mine_danger', mine.entrance, 'overworld', why, 40);
        }
        scope.promote('mine_hazard', area, 'known_exit', why);
      }
      const start = bot.entity.position.clone();
      return scope.run('mine_hazard', area, async (method) => {
        const exit = method === 'known_exit' ? await mining.leaveMine(bot, ctx, { mine }, actions) : null;
        if (exit?.ok && bot.entity.position.distanceTo(start) >= 0.5) return { ...exit, progress: false };
        if (method === 'known_exit' && exit) return exit.ok ? { ok: false, reason: 'mine_exit_not_arrived' } : exit;
        const surfaced = await actions.surface(bot, ctx, { targetY: mine.surfaceY });
        return surfaced && surfaced.progress !== false ? surfaced : { ok: false, reason: 'mine_exit_blocked' };
      }, { learn: { kind: 'mine_danger', radius: 48 } });
    },
  };
}

module.exports = { createMineRetreat };
