'use strict';

const { Vec3 } = require('vec3');
const { failure, isComplete, waiting } = require('./action-result');
const { nightBudget, travelTicks } = require('./scheduling');
const { wet } = require('./dry-route');
const { countKey } = require('./knowledge');

const FOOD_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const OPPORTUNITY_RANGE = 8;
const OPPORTUNITY_MS = 20_000;
const EXPLORATION_RANGE = 96;
const PROVISION_MS = 45_000;
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function boundedWork(bot, ctx, { timeoutMs, check, allow = ctx.workArea, limitResult = () => waiting('work_budget', Date.now() + 5000) }, run) {
  if (!check()) return limitResult();
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const cancel = () => controller.abort('work_budget');
  const timer = setTimeout(cancel, timeoutMs);
  const sample = () => { if (!check()) cancel(); };
  bot.on?.('physicsTick', sample);
  try {
    const result = await run({ ...ctx, signal, workArea: allow });
    if (!controller.signal.aborted || ctx.signal?.aborted) return result;
  } catch (error) {
    if (!controller.signal.aborted || ctx.signal?.aborted || error?.code !== 'aborted') throw error;
  } finally {
    clearTimeout(timer);
    bot.removeListener?.('physicsTick', sample);
  }
  return limitResult();
}

function explorationScope(ctx, origin, radius = EXPLORATION_RANGE) {
  const work = ctx.workArea, path = ctx.pathArea;
  return { workArea: p => horizontal(p, origin) <= radius - 4 && (!work || work(p)),
    pathArea: p => horizontal(p, origin) <= radius - 1 && (!path || path(p)),
    exploration: { origin, radius } };
}

function explorationExhausted(ctx) {
  return failure('search_area_exhausted', ctx.exploration || {}, ctx);
}

function dryAt(bot, p) {
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  return [feet, feet.offset(0, 1, 0)].every(position => {
    const b = bot.blockAt?.(position);
    return b && !wet(b) && !/lava|fire/.test(b.name);
  });
}

function opportunityAllowed(bot, state, position, workTicks = 160) {
  return Boolean(state.position && position && !state.sheltered && !state.inWater &&
    (state.dimension || 'overworld') === 'overworld' && !nightBudget(state).dusk &&
    Math.hypot(position.x - state.position.x, position.y - state.position.y, position.z - state.position.z) <= OPPORTUNITY_RANGE &&
    travelTicks(state.position, position) + workTicks <= OPPORTUNITY_MS / 50 && dryAt(bot, position));
}

async function localOpportunity(bot, ctx, kind, position, run) {
  const state = ctx.perceive();
  if (!opportunityAllowed(bot, state, position)) return waiting('work_budget');
  const from = bot.entity.position.clone(), started = Date.now();
  const details = { kind, distance: Math.round(position.distanceTo(from)) };
  const allow = p => (!ctx.workArea || ctx.workArea(p)) && p.distanceTo(from) <= OPPORTUNITY_RANGE && dryAt(bot, p);
  const check = () => !bot.entity.isInWater && !nightBudget(ctx.perceive()).dusk && allow(bot.entity.position);
  ctx.record('opportunity_started', details);
  try {
    return await boundedWork(bot, ctx, { timeoutMs: OPPORTUNITY_MS, check, allow }, run);
  } finally {
    ctx.record('opportunity', { ...details, durationMs: Date.now() - started });
  }
}

function createForaging({ bot, skills, home = () => null, mobs = FOOD_MOBS, dropMatch, spare = () => false, targetGoal, prepare }) {
  const memory = {};
  let origin;
  return async (ctx, radius = EXPLORATION_RANGE, { roam = true } = {}) => {
    const state = ctx.perceive(), position = state.position || bot.entity.position;
    origin ||= new Vec3(position.x, position.y, position.z);
    const anchor = home() || ctx.exploration?.origin || origin;
    const { maxOutingDistance: outing, distanceHome } = nightBudget({ ...state, position }, anchor);
    const leash = Math.min(EXPLORATION_RANGE, distanceHome + outing);
    const prior = ctx.workArea;
    const allow = p => horizontal(p, position) <= outing && (!prior || prior(p));
    const check = () => !nightBudget(ctx.perceive()).dusk && horizontal(bot.entity.position, anchor) <= leash;
    ctx = { ...ctx, ...explorationScope({ ...ctx, workArea: allow }, anchor, leash), dryRoute: true };
    if (distanceHome > EXPLORATION_RANGE) return explorationExhausted(ctx);
    return boundedWork(bot, ctx, { timeoutMs: PROVISION_MS, check }, async attempt => {
      const prepared = await prepare?.(attempt);
      if (prepared && !isComplete(prepared)) return prepared;
      const hunted = await skills.huntOne(bot, attempt, { mobs, radius, dropMatch, accept: e => !spare(e), targetGoal });
      if (!roam || hunted.reason !== 'no_mob_in_range' || !skills.pickBerries) return hunted;
      const berries = await skills.pickBerries(bot, attempt, { radius: Math.min(radius, 32) });
      if (berries.reason !== 'no_berries') return berries;
      return skills.explore(bot, attempt, memory);
    });
  };
}

function createOpportunisticHunt({ bot, skills, mobs, food, spare, backoff }) {
  return async (ctx, goal) => {
    if (goal === 'stock_food' || goal === 'return_and_store' || Date.now() < backoff.blocked('opportunity:hunt')) return;
    const state = ctx.perceive();
    if (countKey('food', state.inventory) >= 3 || state.health < 14 || state.hostiles?.length) return;
    const accept = e => !spare(e) && opportunityAllowed(bot, state, e.position);
    const target = Object.values(bot.entities || {}).find(e => mobs.includes(e.name) && accept(e));
    if (!target) return;
    backoff.defer('opportunity:hunt', Date.now() + 60_000);
    await localOpportunity(bot, ctx, 'hunt', target.position, attempt =>
      skills.huntOne(bot, attempt, { mobs, dropMatch: food, radius: OPPORTUNITY_RANGE, accept }));
  };
}

module.exports = { boundedWork, createForaging, createOpportunisticHunt, localOpportunity, opportunityAllowed, FOOD_MOBS, explorationScope, explorationExhausted, EXPLORATION_RANGE };
