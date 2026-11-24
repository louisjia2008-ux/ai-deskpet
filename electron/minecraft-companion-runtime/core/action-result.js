'use strict';

const { AXIS_OFFSETS: WATER_STEPS } = require('./geometry');
const { randomUUID } = require('node:crypto');
const { Vec3 } = require('vec3');
const { classifyReason, FAILURE_LIMIT, FAILURE_WINDOW_MS, isComplete, isRescueBehavior } = require('./action-reasons');
const { countInventory, ownedItems } = require('./perception');

const receipts = new WeakMap();
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
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
  if (!position || !inWater(state) || route.entered) return;
  const reached = route.activeNode && position.floored().xzDistanceTo(route.activeNode.floored()) === 0;
  const movement = (reached ? route.activeNode : route.path?.[0] ?? route.activeNode)?.companionMove ?? 'unknown';
  route.entered = { position: { ...position }, at: Date.now(), start: route.start, movement };
}

function clearWaterRoutes(bot) {
  const recent = waterRoutes.get(bot);
  if (!recent) return;
  waterRoutes.delete(bot);
  bot.removeListener?.('physicsTick', recent.sample);
}

function rememberWaterRoute(bot, owner, evidence) {
  let recent = waterRoutes.get(bot);
  if (!recent) {
    const sample = () => { if (bot.entity?.onGround && !inWater(bot)) clearWaterRoutes(bot); };
    recent = { owners: new Map(), sample };
    waterRoutes.set(bot, recent);
    bot.on?.('physicsTick', sample);
  }
  recent.owners.set(owner, evidence);
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

const fail = (reason, details = {}) => ({ ok: false, reason, ...details });

const descriptions = {
  search_area_exhausted: 'No suitable work target was reachable within the search boundary.',
  aborted: 'The current action was cancelled before its outcome was confirmed.',
  no_suitable_site: 'The requested site scan found no buildable and reachable house site.',
  combat_leash: 'The target moved beyond the permitted pursuit area.',
  relocation_routes_exhausted: 'The relocation search ended without finding a usable site.',
  path_timeout: 'The walk did not reach its destination within the allowed time.',
  drops_not_collected: 'The expected drop did not appear in inventory.',
  Timeout: 'The native path planner ran out of time.',
  not_arrived: 'The movement finished without the body arriving at the destination.',
  still_below_surface: 'The body remains below the verified exit level.',
  chase_stuck: 'The chase stopped closing the distance to the target.',
  no_progress: 'The action stalled without confirmed movement or work.',
  place_unconfirmed: 'The server did not confirm the expected block placement.',
  self_escape_unconfirmed: 'The world and body position did not confirm an escape.',
  shelter_not_entered: 'The feet and head were not confirmed inside the shelter.',
};

function failureFacts(reason, facts, ctx, state) {
  const summary = Object.hasOwn(descriptions, reason) && descriptions[reason];
  if (!summary) return facts;
  const bot = state?.bot ?? state, at = bot?.entity?.position ?? state?.position;
  const home = bot?.companionHomeAt?.();
  const { distanceHome, target, adaptation, source, rescue, terminal, routeCaused, enteredWater, destinationObserved, ...details } = facts;
  const evidence = { target, adaptation, source, rescue, terminal, routeCaused, enteredWater, destinationObserved, summary,
    objective: facts.objective ?? facts.destination ?? facts.origin ?? facts.position ?? ctx?.route?.destination ?? ctx?.behavior ?? null,
    attempted: facts.attempted ?? facts.tried ?? [facts.method ?? facts.rescue ?? ctx?.behavior].filter(Boolean), need: facts.need ?? {},
    distanceHome: distanceHome ?? (home && at ? Math.round(Math.hypot(at.x - home.x, at.z - home.z) * 10) / 10 : null),
    ...details, ...(reason === 'aborted' && !facts.cause && ctx?.signal?.reason && { cause: String(ctx.signal.reason) }) };
  return boundedFacts(evidence);
}

function boundedFacts(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 160);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  if (value instanceof Vec3) return value.clone();
  if (Array.isArray(value)) return value.slice(0, 16).map(item => boundedFacts(item, depth + 1));
  if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) return undefined;
  let out = {};
  for (const [key, item] of Object.entries(value)) {
    const safe = boundedFacts(item, depth + 1);
    if (safe === undefined) continue;
    const next = { ...out, [key]: safe };
    if (depth || Buffer.byteLength(JSON.stringify(next)) <= 1024) out = next;
  }
  return out;
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
      facts = { ...facts, routeCaused: route.destination, waterPosition: route.linked.position, waterAt: route.linked.at,
        routeStart: route.linked.start, waterMovement: route.linked.movement };
    } else if (!facts.rescue && kind === 'target' && !source && route?.entered) {
      facts = { ...facts, enteredWater: true, waterPosition: route.entered.position, waterAt: route.entered.at,
        routeStart: route.entered.start, waterMovement: route.entered.movement };
    } else if (source || facts.rescue) kind = 'start';
    if (source) facts = { ...facts, source };
  }
  if (kind === 'material') {
    const bot = state?.bot ?? state;
    const bag = facts.carried ?? state?.inventory;
    const missing = Array.isArray(facts.missing) ? Object.fromEntries(facts.missing.flatMap(item =>
      typeof item === 'string' ? [[item, 1]] : item?.name ? [[item.name, item.short ?? 1]] : [])) : facts.missing;
    facts = { ...facts, need: facts.need ?? missing ?? {},
      carried: bag && typeof bag.items !== 'function' ? bag : countInventory(ownedItems(bot)) };
  }
  return { ok: false, kind, reason, facts: failureFacts(reason, facts, ctx, state), attemptId: createAttempt(ctx).attemptId };
}

const waterRouteFailure = result => Boolean(result?.facts?.enteredWater || result?.facts?.routeCaused);
function waterRouteTarget(bot, ctx, position, entity) {
  const destination = entity == null ? [position.x, position.y, position.z].map(Math.floor).join(',') : String(entity);
  const dimension = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
  return { purpose: 'route_water', dimension, position, entity: `${ctx.behavior || 'travel'}:${destination}` };
}

function departRoute(ctx, bot) {
  const route = ctx.route, wet = inWater(bot), at = bot.entity.position;
  if (wet && route.entered && sameWater(bot, route.entered.position, at)) route.linked = route.entered;
  if (!wet && bot.entity.onGround) {
    clearWaterRoutes(bot);
    route.linked = route.entered = null;
    route.start = at.clone();
  }
  route.departure = wet && route.linked ? 'water' : startProblem(bot);
  return { ...ctx, departure: route.departure };
}

async function settleRoute(bot, ctx, position, run, entity) {
  if (ctx.route || rescueOf(ctx) || !position) return run(ctx);
  const { ledgerFor, recordTarget } = require('./failure-ledger');
  const spec = waterRouteTarget(bot, ctx, position, entity), ledger = ledgerFor(bot, ctx);
  if (ledger.skip(spec)) return failure('choose_another_target', {}, ctx);
  const owner = `${spec.dimension}:${ctx.behavior || 'travel'}`;
  const recent = waterRoutes.get(bot)?.owners;
  const previous = recent?.get(owner), here = bot.entity.position.clone();
  const wet = inWater(bot);
  const linked = wet && previous?.key === spec.entity && sameWater(bot, previous.position, here) ? previous : null;
  if (!linked && recent?.delete(owner) && !recent.size) clearWaterRoutes(bot);
  const route = { destination: spec.entity, linked, start: here };
  const attempt = departRoute(createAttempt({ ...ctx, route }), bot);
  const sample = () => {
    if (inWater(bot)) {
      if (!route.departure) observeWater(route, bot);
    } else if (bot.entity.onGround) route.linked = route.entered = null;
    route.activeNode = route.path?.[0];
  };
  bot.on?.('physicsTick', sample);
  try {
    const result = resultFrom(await run(attempt), attempt, bot);
    if (!waterRouteFailure(result)) return result;
    if (inWater(bot) && route.entered) rememberWaterRoute(bot, owner, { key: spec.entity, ...route.entered });
    return recordTarget(bot, attempt, { ...result, facts: { ...result.facts, routeDestination: position } }, spec);
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
      && (!ctx || kind === 'interrupted' || (rescueOf(ctx) ? facts.rescue && kind !== 'start' : !facts.rescue || kind === 'start'))) {
      return Object.hasOwn(descriptions, reason) ? { ...value, facts: failureFacts(reason, facts, attempt, state) } : value;
    }
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
      if (rescueOf(attempt) && isComplete(result) && bot.entity?.onGround && !inWater(bot)) clearWaterRoutes(bot);
      return result;
    } catch (error) {
      if (error?.code !== 'aborted') throw error;
      return interrupted();
    }
  };
}

module.exports = { classifyReason, complete, createAttempt, departRoute, factsOf, fail, failure, FAILURE_LIMIT, FAILURE_WINDOW_MS,
  isComplete, isRescueBehavior, rescueOf, resultFrom, settleAction, settleRoute, startProblem, waiting, waterRouteFailure, waterRouteTarget };
