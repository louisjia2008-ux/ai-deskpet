'use strict';

const { randomUUID } = require('node:crypto');
const { Vec3 } = require('vec3');
const { classifyReason, FAILURE_LIMIT, FAILURE_WINDOW_MS, isRescueBehavior } = require('./action-reasons');
const { countInventory, ownedItems } = require('./perception');

const receipts = new WeakMap();
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const WATER_STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const waterRoutes = new WeakMap();
const rescueOf = ctx => ctx?.rescue || (isRescueBehavior(ctx?.behavior) ? ctx.behavior : null);

function createAttempt(ctx = {}, state) {
  ctx ??= {};
  if (state && ctx.departure === undefined) ctx = { ...ctx, departure: startProblem(state) };
  return ctx.attemptId == null ? { ...ctx, attemptId: randomUUID() } : ctx;
}

function complete(progress = true, receipt) {
  const result = { ok: true, progress };
  if (receipt && Object.keys(receipt).length) receipts.set(result, receipt);
  return result;
}

function waiting(reason, until = null) {
  return { ok: true, wait: { reason, until } };
}

function inWater(state) {
  const bot = state?.bot ?? state;
  const feet = bot?.entity?.position?.floored?.();
  return state?.inWater || bot?.entity?.isInWater || (feet && WATER.has(bot.blockAt?.(feet)?.name));
}

function startProblem(state) {
  return state?.source || (state?.selfStuck || (state?.bot ?? state)?.companionSelfStuck?.state?.() ? 'self_stuck'
    : inWater(state) ? 'water' : state?.firstStepFailed ? 'path_first_step' : null);
}

function observeWater(route, state) {
  const position = (state?.bot ?? state)?.entity?.position ?? state?.position;
  if (position && inWater(state)) route.entered ??= { position: { ...position }, at: Date.now() };
}

function sameWater(bot, from, to) {
  if (to.distanceTo(from) <= 8) return true;
  const first = new Vec3(from.x, from.y, from.z).floored(), end = to.floored();
  if (!WATER.has(bot.blockAt?.(first)?.name)) return false;
  const cells = [first], seen = new Set([first.toString()]);
  for (const cell of cells) {
    if (cell.equals(end)) return true;
    if (cells.length >= 768) continue; // Missing or unvisited water is not proof of connection.
    for (const step of WATER_STEPS) {
      const next = cell.offset(...step), key = next.toString();
      if (!seen.has(key) && WATER.has(bot.blockAt?.(next)?.name)) { seen.add(key); cells.push(next); }
    }
  }
  return false;
}

function failure(reason, facts = {}, ctx, state) {
  let kind = classifyReason(reason);
  const rescue = rescueOf(ctx);
  if (kind !== 'interrupted') {
    const source = facts.source ?? (ctx?.departure || (state?.firstStepFailed ? 'path_first_step'
      : ctx?.departure === undefined ? startProblem(state) : null));
    const route = ctx?.route;
    if (route && !source && state) observeWater(route, state);
    if (rescue) {
      if (kind === 'start') kind = 'environment';
      facts = { ...facts, rescue: facts.rescue || rescue };
    } else if (!facts.rescue && kind === 'target' && route?.linked && source === 'water') {
      facts = { ...facts, routeCaused: route.destination, waterPosition: route.linked.position, waterAt: route.linked.at };
    } else if (!facts.rescue && kind === 'target' && !source && route?.entered) {
      facts = { ...facts, enteredWater: true, waterPosition: route.entered.position, waterAt: route.entered.at };
    } else if (source || facts.rescue) kind = 'start';
    if (source) facts = { ...facts, source };
  }
  if (kind === 'material') {
    const bot = state?.bot ?? state;
    const missing = Array.isArray(facts.missing) ? Object.fromEntries(facts.missing.flatMap(item =>
      typeof item === 'string' ? [[item, 1]] : item?.name ? [[item.name, item.short ?? 1]] : [])) : facts.missing;
    facts = { ...facts, need: facts.need ?? missing ?? {}, carried: facts.carried ?? state?.inventory
      ?? (bot?.inventory ? countInventory(ownedItems(bot)) : {}) };
  }
  return { ok: false, kind, reason, facts, attemptId: createAttempt(ctx).attemptId };
}

const waterRouteFailure = result => Boolean(result?.facts?.enteredWater || result?.facts?.routeCaused);
function waterRouteTarget(bot, ctx, position, entity) {
  const destination = entity == null ? [position.x, position.y, position.z].map(Math.floor).join(',') : String(entity);
  const dimension = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
  return { purpose: 'route_water', dimension, position, entity: `${ctx.behavior || 'travel'}:${destination}` };
}

async function settleRoute(bot, ctx, position, run, entity) {
  if (ctx.route || rescueOf(ctx) || !position) return run(ctx);
  const { ledgerFor, recordTarget } = require('./failure-ledger');
  const spec = waterRouteTarget(bot, ctx, position, entity), ledger = ledgerFor(bot, ctx);
  if (ledger.skip(spec)) return failure('choose_another_target', {}, ctx);
  const owner = `${spec.dimension}:${ctx.behavior || 'travel'}`;
  const recent = waterRoutes.get(bot) || new Map();
  waterRoutes.set(bot, recent);
  const previous = recent.get(owner), here = bot.entity.position.clone();
  const wet = inWater(bot);
  const linked = wet && previous?.key === spec.entity && sameWater(bot, previous.position, here) ? previous : null;
  if (!linked) recent.delete(owner);
  const route = { destination: spec.entity, linked };
  const attempt = createAttempt({ ...ctx, departure: linked ? 'water' : startProblem(bot), route });
  const sample = () => inWater(bot) ? !attempt.departure && observeWater(route, bot) : bot.entity.onGround && recent.clear();
  bot.on?.('physicsTick', sample);
  try {
    const result = resultFrom(await run(attempt), attempt, bot);
    if (!waterRouteFailure(result)) return result;
    if (inWater(bot) && route.entered) recent.set(owner, { key: spec.entity, ...route.entered });
    return recordTarget(bot, attempt, { ...result, facts: { ...result.facts, routeStart: here, routeDestination: position } }, spec);
  } finally {
    bot.removeListener?.('physicsTick', sample);
  }
}

function factsOf(result) {
  return result?.facts ?? receipts.get(result) ?? result ?? {};
}

function resultFrom(value, ctx, state) {
  if (value?.ok === false) {
    const { ok, kind, reason, facts, attemptId, ...details } = value;
    const attempt = createAttempt({ ...ctx, attemptId: ctx?.attemptId ?? attemptId });
    classifyReason(reason);
    if (kind && facts && attemptId === attempt.attemptId && !Object.keys(details).length
      && (!ctx || kind === 'interrupted' || (rescueOf(ctx) ? facts.rescue && kind !== 'start' : !facts.rescue || kind === 'start'))) return value;
    return failure(reason, { ...details, ...facts }, attempt, state);
  }
  if (value?.wait) return waiting(value.wait.reason, value.wait.until);
  if (value?.ok !== true || receipts.has(value)) return value?.ok === true ? value : complete();
  const { ok, progress, ...receipt } = value;
  return complete(progress ?? !(receipt.already || receipt.idle || receipt.skipped), receipt);
}

function settleAction(run, rescue) {
  return async (bot, ctx, ...args) => {
    const attempt = createAttempt(rescue ? { ...ctx, rescue } : ctx, bot);
    const interrupted = () => failure('aborted', { cause: attempt.signal?.reason }, attempt);
    if (attempt.signal?.aborted) return interrupted();
    try {
      const result = resultFrom(await run(bot, attempt, ...args) ?? complete(false), attempt, bot);
      if (rescueOf(attempt) && result.ok && bot.entity?.onGround && !inWater(bot)) waterRoutes.delete(bot);
      return result;
    } catch (error) {
      if (error?.code !== 'aborted') throw error;
      return interrupted();
    }
  };
}

module.exports = { classifyReason, complete, createAttempt, factsOf, failure, FAILURE_LIMIT, FAILURE_WINDOW_MS,
  isRescueBehavior, rescueOf, resultFrom, settleAction, settleRoute, startProblem, waiting, waterRouteFailure, waterRouteTarget };
