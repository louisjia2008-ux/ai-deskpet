'use strict';
// Body actions are bounded, cancellable and confirm effects against server state.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { waitUntil, runCancellable, sleep, abortError } = require('./confirm');
const { ownedItems } = require('./perception');
const { dropReturnPosition } = require('./pathReturn');
const { posKey } = require('./blacklist');
const { homeContains, safeStand, SIDES: CARDINAL } = require('./home-topology');
const { pickItem, isSealSoil, isSealRock } = require('./materials');
const shore = require('./shore-route');
const { meleeGeometry, meleeSight, MeleeFollowGoal, entitySizeEvidence } = require('./entityGeometry');
const { surveyDigPermit, withSurveyStep, surveyPlace, openSurveyChest, openSurveyDoor, closeSurveyDoor, isSurveyNight } = require('./survey-plan-actions');
const { complete, createAttempt, departRoute, factsOf, failure, rescueOf, resultFrom, settleAction, settleRoute, startProblem, waterRouteFailure } = require('./action-result');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';

function haltBody(bot) {
  try { bot.pathfinder?.setGoal(null); } catch { /* ignore */ }
  try { dropReturnPosition(bot); } catch { /* ignore */ }
  try { bot.clearControlStates?.(); } catch { /* ignore */ }
}

// Allow pillaring only toward higher destinations inside a shaft.
const CLIMB_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'sandstone', 'red_sandstone'];
// Carried sand and gravel can also pillar on a solid floor.
const SCAFFOLD_BLOCKS = [...CLIMB_BLOCKS, 'sand', 'red_sand', 'gravel'];
async function withClimbing(bot, targetY, run) {
  const movements = bot.pathfinder?.movements;
  if (movements?.companionWalkOnly) return run();
  if (!movements || !Number.isFinite(targetY) || targetY - bot.entity.position.y <= 3 || !underground(bot)) return run();
  const saved = { towers: movements.allow1by1towers, scaffold: movements.scafoldingBlocks };
  movements.allow1by1towers = true;
  // In the nether, mostly netherrack: some cobblestone is kept for steps out of lava.
  movements.scafoldingBlocks = movements.companionNether ? require('./nether').netherScaffolding(bot)
    : SCAFFOLD_BLOCKS.map((name) => bot.registry.itemsByName[name]?.id).filter(Number.isInteger);
  try {
    return await run();
  } finally {
    movements.allow1by1towers = saved.towers;
    movements.scafoldingBlocks = saved.scaffold;
  }
}

const solidGround = (block) => block && block.boundingBox === 'block' && !block.name.endsWith('_leaves')
  && !/_(log|wood|stem|hyphae)$/.test(block.name);

function openSky(bot, feet) {
  for (let dy = 2; dy < 48; dy += 1) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block) return true;
    if (solidGround(block)) return false;
  }
  return true;
}

const dimensionOf = (bot) => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
const houseOf = (bot) => bot.companionHomestead?.()?.memory?.house;
const isHomeTarget = (bot, p) => dimensionOf(bot) === 'overworld'
  && (bot.companionHomeTarget?.(p, 'overworld') || homeContains(houseOf(bot), p));

// A nearby walkable exit distinguishes an overhang from a shaft.
function openTerrainNearby(bot, feet, { cover, depth = 3 } = {}) {
  const visited = new Set([posKey(feet)]);
  const queue = [{ p: feet, left: depth }];
  for (const { p, left } of queue) {
    if (!left) continue;
    for (const [dx, dz] of CARDINAL) {
      const next = [0, 1, -1].map(dy => p.offset(dx, dy, dz))
        .find(q => safeStand(pos => bot.blockAt(pos), q) && (q.y <= p.y || bot.blockAt(p.offset(0, 2, 0))?.boundingBox === 'empty'));
      if (!next || visited.has(posKey(next))) continue;
      if (!cover || openSky(bot, next)) return true;
      visited.add(posKey(next));
      queue.push({ p: next, left: left - 1 });
    }
  }
  return false;
}

// Caves and pits lack a nearby walking exit. The surface reference is a hint.
function underground(bot) {
  const feet = bot.entity.position.floored();
  if (dimensionOf(bot) === 'overworld' && homeContains(houseOf(bot), feet)) return false;
  let cover = false;
  for (let dy = 2; dy < 10 && !cover; dy += 1) cover = Boolean(solidGround(bot.blockAt(feet.offset(0, dy, 0))));
  if (!cover && feet.y < bot.companionSurfaceY - 1) cover = !openSky(bot, feet);
  if (cover) return !openTerrainNearby(bot, feet, { cover: true });
  let walledSides = 0;
  for (const [dx, dz] of CARDINAL) {
    for (const reach of [1, 2]) {
      if (solidGround(bot.blockAt(feet.offset(dx * reach, 2, dz * reach)))) { walledSides += 1; break; }
    }
  }
  return walledSides >= 3 && !openTerrainNearby(bot, feet);
}

// Centre the body before a first diagonal can catch a wall corner.
async function recentre(bot, ctx, { accept = () => true } = {}) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const feet = bot.entity.position.floored();
  const supported = () => bot.entity.onGround === true
    && bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block'
    && bot.entity.position.floored().equals(feet) && accept(feet, bot.entity.position);
  // Swimming, ladders and a body already falling are the native planner's.
  if (!supported()) return;
  const centre = feet.offset(0.5, 0, 0.5);
  const distance = () => Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z);
  const previousSneak = Boolean(bot.controlState?.sneak);
  const previousCompanionSneaking = bot.companionSneaking;
  try {
    bot.setControlState('sprint', false);
    bot.companionSneaking = true;
    bot.setControlState('sneak', true);
    for (let i = 0; i < 30 && distance() > 0.15 && supported(); i += 1) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      await bot.lookAt(centre.offset(0, bot.entity.position.y - centre.y + 1.6, 0), true);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!supported()) break;
      bot.setControlState('forward', true);
      await sleep(50, ctx.signal);
      bot.setControlState('forward', false);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sneak', previousSneak);
    if (previousCompanionSneaking === undefined) delete bot.companionSneaking;
    else bot.companionSneaking = previousCompanionSneaking;
  }
}

function offCentre(bot) {
  const p = bot.entity.position;
  return Math.hypot(p.x - (Math.floor(p.x) + 0.5), p.z - (Math.floor(p.z) + 0.5)) > 0.2;
}

const ROUTE_FAILURE = /^(nopath|timeout|path_timeout|not_arrived|no_progress|leg_blocked|chase_stuck)$/i;
const goalPosition = (bot, goal) => goal.pos || (Number.isFinite(goal.x) && Number.isFinite(goal.z)
  ? { x: goal.x, y: Number.isFinite(goal.y) ? goal.y : Math.floor(bot.entity.position.y), z: goal.z } : null);
function routeOrigin(bot) {
  return startProblem(bot) ?? (dimensionOf(bot) === 'overworld' && bot.blockAt && underground(bot) ? 'underground' : null);
}

function originFailure(bot, raw, before, destination, ctx) {
  if (!raw || raw.ok) return raw;
  const result = resultFrom(raw, ctx, bot);
  if (!before || rescueOf(ctx) || waterRouteFailure(result) || !ROUTE_FAILURE.test(result.reason)
    || bot.entity.position.distanceTo(before) >= 2) return result;
  const mine = bot.companionMineRoute;
  const knownMine = cause => ['underground', 'path_first_step'].includes(cause) && mine
    && require('./mining').knownOpen(mine, bot.entity.position.floored());
  if (result.kind === 'start') {
    const { source } = result.facts;
    if (source && source !== 'self_stuck' && !knownMine(source)) bot.companionSelfStuck?.force(`route_origin_${source}`);
    return result;
  }
  if (result.kind !== 'target') return result;
  // A blocked first step out of a completed home belongs to its exit.
  const home = bot.companionHomestead?.();
  const blockedExit = bot.companionSelfStuck && /^nopath$/i.test(result.reason) && destination && dimensionOf(bot) === 'overworld'
    && home?.isInside?.() && homeContains(home.memory?.house, before) && !isHomeTarget(bot, destination);
  const cause = ctx?.departure || (blockedExit ? 'home_exit_blocked' : null);
  if (!cause || knownMine(cause)) return result;
  bot.companionSelfStuck?.force(`route_origin_${cause}`);
  return failure('self_stuck', { source: cause }, ctx ?? result);
}

async function goTo(bot, ctx, goal, options = {}) {
  if (ctx?.route && !rescueOf(ctx)) return goToRoute(bot, departRoute(ctx, bot), goal, options);
  const position = goalPosition(bot, goal), xz = position && !goal.pos && !Number.isFinite(goal.y);
  return settleRoute(bot, createAttempt(ctx, bot), position, run => goToRoute(bot, run, goal, options),
    options.routeEntity ?? (xz ? `xz:${position.x},${position.z}` : null));
}

async function goToRoute(bot, ctx, goal, options) {
  const exclusions = bot.pathfinder?.movements?.exclusionAreasStep;
  if (ctx.dryRoute && exclusions && !options.dryScoped) {
    const { wet } = require('./dry-route');
    const avoidWater = b => wet(b) || (b?.position && wet(bot.blockAt(b.position.offset(0, 1, 0)))) ? 1000 : 0;
    exclusions.push(avoidWater);
    try { return await goToRoute(bot, ctx, goal, { ...options, dryScoped: true }); }
    finally {
      const i = exclusions.indexOf(avoidWater);
      if (i >= 0) exclusions.splice(i, 1);
    }
  }
  const { targetY } = options;
  if (Number.isFinite(targetY) && targetY - bot.entity.position.y > 3 && underground(bot)) {
    return withClimbing(bot, targetY, () => goToRoute(bot, ctx, goal, { ...options, targetY: undefined }));
  }
  const before = !rescueOf(ctx) && !ctx.nearDestination && bot.companionSelfStuck ? bot.entity.position.clone() : null;
  const done = (result) => {
    if (result.ok) return result;
    const p = goalPosition(bot, goal);
    result = originFailure(bot, result, before, p, ctx);
    if (result.kind === 'target' && !waterRouteFailure(result) && before && bot.companionSelfStuck.pathFailed(p, result, before)) {
      return failure('self_stuck', { source: 'self_stuck' }, ctx);
    }
    return result;
  };
  if (offCentre(bot) && !goal.isEnd(bot.entity.position.floored())) await recentre(bot, ctx);
  const first = await goToOnce(bot, ctx, goal, options);
  // A scoped deadline can leave retries to the caller.
  if (first.kind === 'start' || first.reason !== 'no_progress' || options.retryNoProgress === false) return done(first);
  await nudge(bot, ctx);
  return done(await goToOnce(bot, ctx, goal, options));
}

async function goToOnce(bot, ctx, goal, { timeoutMs = 30000, arrived } = {}) {
  // Allow a full 10-second planner cycle before stopping a stationary route.
  let stalled = false;
  const start = bot.entity.position.clone();
  let last = start;
  let lastMoveAt = Date.now();
  let firstStepFailed = false;
  const atOrigin = () => bot.entity.position.floored().equals(start.floored());
  const onPlan = plan => {
    if (plan.status === 'noPath' && plan.visitedNodes === 1 && atOrigin()) firstStepFailed = true;
  };
  const onReset = reason => {
    if (reason === 'stuck' && atOrigin()) firstStepFailed = true;
  };
  bot.on?.('path_update', onPlan);
  bot.on?.('path_reset', onReset);
  const failed = (reason, facts) => failure(reason, facts, ctx, { bot, firstStepFailed: firstStepFailed && atOrigin() });
  const watchdog = setInterval(() => {
    const now = bot.entity.position;
    if (now.distanceTo(last) > 0.5 || bot.targetDigBlock) { last = now.clone(); lastMoveAt = Date.now(); return; }
    if (Date.now() - lastMoveAt > 12000) { stalled = true; haltBody(bot); }
  }, 1000);
  try {
    await runCancellable(() => bot.pathfinder.goto(goal), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'path_timeout', cancel: () => haltBody(bot),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    haltBody(bot);
    if (stalled) return failed('no_progress');
    const reason = ['NoPath', 'Timeout', 'path_timeout', 'GoalChanged', 'PathStopped'].find(code =>
      code.toLowerCase() === String(error?.code || error?.name).toLowerCase());
    return reason ? failed(reason) : failed('path_failed', { native: error?.code || error?.name });
  } finally {
    clearInterval(watchdog);
    bot.removeListener?.('path_update', onPlan);
    bot.removeListener?.('path_reset', onReset);
  }
  // Pathfinder can "finish" with an empty path; arrival must be checked.
  const at = bot.entity.position;
  const reached = arrived ? arrived(at) : goal.isEnd(at.floored());
  return reached ? complete(!atOrigin()) : failed('not_arrived');
}

async function goNear(bot, ctx, position, range = 2, options = {}) {
  ctx = createAttempt(ctx, bot);
  if (!rescueOf(ctx) && !bot.pathfinder?.movements?.companionWalkOnly && isHomeTarget(bot, position)) {
    return goHome(bot, ctx, position, range, options);
  }
  const tracker = !rescueOf(ctx) && bot.companionSelfStuck;
  const before = tracker && bot.entity.position.clone();
  let result = await goNearAdapted(bot, before ? { ...ctx, nearDestination: true } : ctx, position, range, options);
  result = originFailure(bot, result, before, position, ctx);
  if (result?.kind === 'target' && !waterRouteFailure(result) && !result.facts.target
    && !result.facts.destinationObserved && tracker?.pathFailed(position, result, before)) {
    return failure('self_stuck', { source: 'self_stuck' }, ctx);
  }
  return result;
}

async function goNearAdapted(bot, ctx, position, range, options) {
  const { blockTarget, watchDestination } = require('./target-recovery');
  const destination = options.destination;
  const walk = () => goNearOnce(bot, ctx, position, range, options);
  // An exact work target owns its approach and existing ladder.
  if (destination) return watchDestination(bot, ctx, destination.spec, destination.observe, walk, destination);
  if (!ctx.adapt || options.skipAdaptation || rescueOf(ctx) || dimensionOf(bot) !== 'overworld'
    || bot.companionSelfStuck?.inTarget() || routeOrigin(bot)
    || bot.entity.position.distanceTo(position) <= range + 1.5) return walk();
  const before = bot.entity.position.clone();
  const task = { position, origin: before, target: 'walk' };
  const plan = ctx.adapt.plan('route', task);
  const cell = new Vec3(position.x, position.y, position.z).floored();
  const spec = blockTarget(bot, 'route', 'walk', cell, { cells: [cell.offset(0, -1, 0), cell.offset(0, 1, 0)] });
  if (ctx.adapt.targets.avoid(spec) || ctx.adapt.ledger?.regionHard(position)) return fail('route_region_avoided');
  return ctx.adapt.run('route', task, (method, _plan, observe) => {
    if (method === 'avoid_region') return fail('route_region_avoided');
    if (method === 'alternate_target') return fail('choose_another_target');
    return watchDestination(bot, ctx, spec, observe, () => goNearOnce(bot, ctx, position, range,
      { ...options, lateral: method === 'waypoint' ? (plan.failures % 2 === 0 ? 1 : -1) : 0 }));
  }, plan.method === 'avoid_region' ? { threshold: 1, learn: { kind: 'hard_route', radius: 6 } } : undefined)
    .then(result => result.wait ? fail('route_region_avoided') : result);
}

async function recoverHomeOrigin(bot, ctx, destination) {
  const rescue = { ...ctx, rescue: 'home_escape' };
  const mine = bot.companionMineRoute;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const reason = routeOrigin(bot);
    if (!reason) return null;
    const from = bot.entity.position.clone();
    ctx.record?.('home_route_recovery', { phase: 'start', reason, from, destination });
    let result;
    if (reason === 'water') {
      const ashore = await swimAshore(bot, rescue, { maxTicks: 400 }) || await stepOutOfPool(bot, rescue);
      result = ashore ? { ok: true } : fail('shore_unreached');
    } else if (reason === 'self_stuck') {
      const home = bot.companionHomestead?.();
      result = home?.nearForSelfRecovery?.() ? await home.escapeHome(rescue) : await unstick(bot, rescue);
      if (result.ok) bot.companionSelfStuck.release();
    } else {
      const exit = mine && await require('./mining').leaveMine(bot, rescue, { mine });
      result = exit?.ok ? exit : await surface(bot, rescue);
    }
    const position = bot.entity.position.clone();
    ctx.record?.('home_route_recovery', { phase: 'finish', reason, from, position, destination, ok: !routeOrigin(bot),
      result: resultFrom(result, rescue, bot) });
    if (!routeOrigin(bot)) return null;
    if (factsOf(result).adaptation?.exhausted) return resultFrom(result, ctx, bot);
    if (position.distanceTo(from) < 0.75 && !factsOf(result).adaptation?.switched) break;
  }
  return failure('home_origin_unrecovered', { source: routeOrigin(bot) }, ctx, bot);
}

async function goHome(bot, ctx, position, range, options) {
  const unblocked = await recoverHomeOrigin(bot, ctx, position);
  if (unblocked) return unblocked;
  if (bot.companionTemporaryBlocks?.list().length) {
    await shore.clearRouteBridge(bot, ctx, bridgeOperations(bot, ctx));
  }
  const flat = Math.hypot(position.x - bot.entity.position.x, position.z - bot.entity.position.z);
  const timeoutMs = Math.max(options.timeoutMs ?? 30000, Math.min(120000, 15000 + flat * 800));
  const route = { ...ctx, nearDestination: true };
  const approach = { ...options, timeoutMs, segmentFirst: true };
  let result = await goNearOnce(bot, route, position, range, approach);
  if (routeOrigin(bot) && !factsOf(result).shore) {
    const recovered = await recoverHomeOrigin(bot, ctx, position);
    if (recovered) return recovered;
    result = await goNearOnce(bot, route, position, range, approach);
  }
  const destination = new Vec3(position.x, position.y, position.z).floored();
  if (factsOf(result).shore && !result.ok && !isHomeTarget(bot, bot.entity.position.floored())) return result;
  const porch = houseOf(bot)?.entrance;
  if (!result.ok || (porch && destination.equals(porch) && !safeStand(p => bot.blockAt(p), destination))) {
    const repaired = await bot.companionHomestead?.()?.repairHomeAccess?.(ctx);
    if (repaired?.ok) result = await goNearOnce(bot, route, position, range, approach);
    else if (repaired) return repaired;
  }
  if (result.ok) ctx.record?.('home_route_arrived', { destination: position, position: bot.entity.position.floored() });
  return result;
}

function bridgeOperations(bot, ctx) {
  return {
    materials: CLIMB_BLOCKS,
    isProtected: p => Boolean(isHomeTarget(bot, p) || ctx.protectedCell?.(p)
      || bot.companionPlayerBlock?.(p) || bot.companionProtectBlock?.(bot.blockAt(p))),
    dig: (block, options) => digBlock(bot, ctx, block, options),
  };
}

async function walkGroundLegs(bot, ctx, position, goal, route, prefix, initial = null) {
  const { remaining, attempt, direct } = route;
  let last = initial;
  let bank = initial && shore.waterContact(bot, true);
  let returns = bank ? 1 : 0;
  let avoided = false;
  const shoreFailure = result => result.kind === 'start' || result.kind === 'interrupted' || waterRouteFailure(result)
    ? { ...result, facts: { ...result.facts, shore: true } }
    : failure('shore_route_unconfirmed', { shore: true, cause: result.reason }, ctx, bot);
  const report = (from, waypoint, result, dry, cost, advanced) => ctx.record?.(`${prefix}_route_leg`, {
    from, position: bot.entity.position.clone(), destination: position, waypoint: { x: waypoint.x, z: waypoint.z },
    advanced, dry, arrived: result.ok, reason: result.reason, result: resultFrom(result, ctx, bot), ...cost,
  });
  const take = async (waypoint, dryOnly) => {
    const from = bot.entity.position.clone();
    const before = shore.routeCost(bot, goal, from);
    const result = await attempt(waypoint, { timeoutMs: Math.min(12000, remaining()), retryNoProgress: false }, dryOnly);
    const dry = result.ok ? await shore.settleDry(bot, ctx.signal) : shore.steadyGround(bot);
    const cost = result.ok && dry ? shore.progress(before, shore.routeCost(bot, goal, bot.entity.position)) : {};
    const sameBank = bank && shore.shoreDistance(bot.entity.position, bank) < 7;
    const advanced = Boolean(result.ok && dry && cost.closer && !(returns >= 2 && sameBank));
    report(from, waypoint, result, dry, cost, advanced);
    return { result, advanced };
  };
  const observeBank = async () => {
    const edge = shore.waterContact(bot, true);
    if (!edge) return null;
    returns = bank && shore.shoreDistance(edge, bank) < 7 ? returns + 1 : 1;
    bank = edge;
    if (!shore.waterContact(bot)) return null;
    return recoverHomeOrigin(bot, ctx, position);
  };
  const confirmedDirect = async (limit, dryOnly) => {
    const result = await direct(limit, dryOnly);
    return result.ok && !(await shore.settleDry(bot, ctx.signal)) ? fail('not_arrived') : result;
  };
  for (let leg = 0; leg < 12 && remaining() > 0; leg += 1) {
    if (shore.waterContact(bot)) {
      const recovery = await recoverHomeOrigin(bot, ctx, position);
      if (recovery) return shoreFailure(recovery);
    }
    if (bank && returns >= 2) {
      const oldBank = bank;
      route.shoreHandled = true;
      ctx.record?.(`${prefix}_route_shore`, { phase: 'alternate', bank, returns });
      const detour = await confirmedDirect(Math.min(20000, remaining() / 2), true);
      if (detour.ok) return detour;
      if (shore.waterContact(bot)) {
        const recovery = await recoverHomeOrigin(bot, ctx, position);
        if (recovery) return shoreFailure(recovery);
      }
      let leftBank = false;
      for (const p of shore.bankDetours(bot, bank, goal)) {
        if (remaining() < 5000) break;
        const moved = await take(new goals.GoalBlock(p.x, p.y, p.z), true);
        if (moved.result.ok && shore.steadyGround(bot) && shore.shoreDistance(bot.entity.position, oldBank) >= 7) {
          leftBank = true;
          break;
        }
      }
      if (!leftBank && remaining() > 5000) {
        const move = async p => {
          const moved = await attempt(new goals.GoalBlock(p.x, p.y, p.z),
            { timeoutMs: Math.min(4000, remaining()), retryNoProgress: false }, true);
          return moved.ok && await shore.settleDry(bot, ctx.signal) && bot.entity.position.floored().equals(p);
        };
        leftBank = await shore.crossRouteBridge(bot, ctx, goal, { ...bridgeOperations(bot, ctx), move });
      }
      if (!leftBank) {
        ctx.record?.(`${prefix}_route_shore`, { phase: 'exhausted', bank, returns, position: bot.entity.position.clone() });
        return shoreFailure(last?.ok === false ? last : detour);
      }
      avoided = true;
      bank = null;
      returns = 0;
      continue;
    }
    const here = bot.entity.position.clone();
    const dx = position.x - here.x, dz = position.z - here.z;
    const flat = Math.hypot(dx, dz);
    if (flat <= 20) {
      const nearWater = shore.waterContact(bot, true);
      last = await confirmedDirect(nearWater ? Math.min(10000, remaining()) : remaining(), avoided);
      if (last.ok || !shore.waterContact(bot, true)) return last;
      const recovery = await observeBank();
      if (recovery) return shoreFailure(recovery);
      continue;
    }
    let advanced = false;
    for (const side of [0, -8, 8]) {
      if (remaining() <= 0) break;
      const waypoint = new goals.GoalNearXZ(here.x + (16 * dx - side * dz) / flat, here.z + (16 * dz + side * dx) / flat, 3);
      const moved = await take(waypoint, avoided);
      last = moved.result;
      if (moved.advanced) {
        advanced = true;
        if (bank && shore.shoreDistance(bot.entity.position, bank) >= 7) { bank = null; returns = 0; }
        break;
      }
      const recovery = await observeBank();
      if (recovery) return shoreFailure(recovery);
      if (returns >= 2) break;
    }
    if (advanced || returns >= 2) continue;
    last = await confirmedDirect(remaining(), avoided);
    if (last.ok || !shore.waterContact(bot, true)) return last;
    const recovery = await observeBank();
    if (recovery) return shoreFailure(recovery);
  }
  const result = last?.ok === false ? last : fail('path_timeout');
  return route.shoreHandled ? shoreFailure(result) : result;
}

async function goNearOnce(bot, ctx, position, range, options) {
  return settleRoute(bot, ctx, position, run => goNearRoute(bot, run, position, range, options), options.routeEntity);
}

async function goNearRoute(bot, ctx, position, range, options) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  // Direct, waypoint and final approach share one deadline.
  const timeoutMs = options.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  const expiry = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, expiry.signal]) : expiry.signal;
  const scoped = { ...ctx, signal };
  const timer = setTimeout(() => { expiry.abort('path_timeout'); haltBody(bot); }, timeoutMs);
  const remaining = () => Math.max(0, deadline - Date.now());
  const attempt = async (goal, options, dryOnly = false) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const result = await goTo(bot, dryOnly ? { ...scoped, dryRoute: true } : scoped, goal, options);
    // A native route can resolve a failure after cancellation.
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    return result;
  };
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  const direct = (limit = remaining(), dryOnly = false) => remaining() <= 0 ? Promise.resolve(fail('path_timeout'))
    : attempt(goal, {
      targetY: position.y, ...options, timeoutMs: Math.min(limit, remaining()),
      arrived: (at) => options.exact ? goal.isEnd(at.floored()) : at.distanceTo(position) <= range + 1.5,
    }, dryOnly);
  const route = { remaining, attempt, direct, shoreHandled: false };
  try {
    if (options.segmentFirst) return await walkGroundLegs(bot, scoped, position, goal, route, 'home');
    if (options.lateral) {
      const here = bot.entity.position;
      const dx = position.x - here.x, dz = position.z - here.z;
      const length = Math.hypot(dx, dz);
      if (length > 2) {
        const step = Math.min(10, length / 2) / length;
        const side = options.lateral * 6 / length;
        const intermediate = new goals.GoalNearXZ(here.x + dx * step - dz * side, here.z + dz * step + dx * side, 2);
        const moved = await attempt(intermediate, { timeoutMs: Math.min(12000, remaining()), retryNoProgress: false });
        if (!moved.ok) return moved;
      }
      return await direct();
    }
    // Reserve time for waypoint legs on long trips.
    const far = Math.hypot(position.x - bot.entity.position.x, position.z - bot.entity.position.z) > 20;
    const result = await direct(far ? Math.min(20000, remaining()) : remaining());
    if (result.ok || result.facts?.enteredWater || !ROUTE_FAILURE.test(result.reason)) return result;
    if (result.kind === 'start' && result.facts.source !== 'water') return result;
    if (dimensionOf(bot) === 'overworld' && !rescueOf(ctx) && !bot.pathfinder?.movements?.companionWalkOnly
      && shore.waterContact(bot, true)) {
      return await walkGroundLegs(bot, scoped, position, goal, route, 'travel', result);
    }
    for (let leg = 0; leg < 6 && remaining() > 0; leg += 1) {
      const here = bot.entity.position;
      const dx = position.x - here.x;
      const dz = position.z - here.z;
      const flat = Math.hypot(dx, dz);
      if (flat <= 20) return await direct();
      const step = 16 / flat;
      const waypoint = new goals.GoalNearXZ(here.x + dx * step, here.z + dz * step, 3);
      const before = here.clone();
      const guarded = dimensionOf(bot) === 'overworld' && !rescueOf(ctx) && !bot.pathfinder?.movements?.companionWalkOnly;
      const cost = guarded && shore.routeCost(bot, goal, before);
      const moved = await attempt(waypoint, { timeoutMs: Math.min(20000, remaining()), ...(guarded ? {} : { arrived: () => true }) });
      if (guarded) {
        if (shore.waterContact(bot, true) && (!moved.ok || !shore.steadyGround(bot))) {
          return await walkGroundLegs(bot, scoped, position, goal, route, 'travel', moved);
        }
        const dry = moved.ok && await shore.settleDry(bot, scoped.signal);
        if (!dry || !shore.progress(cost, shore.routeCost(bot, goal, bot.entity.position)).closer) {
          return moved.ok ? fail('leg_blocked') : moved;
        }
      } else if (bot.entity.position.distanceTo(before) < 4) return moved.ok ? fail('leg_blocked') : moved;
    }
    return await direct();
  } catch (error) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (expiry.signal.aborted) return route.shoreHandled
      ? failure('shore_route_unconfirmed', { shore: true, cause: 'path_timeout' }, ctx, bot)
      : failure('path_timeout', {}, ctx, bot);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Moves to any spot from which `block` can be seen and dug. */
function goToDig(bot, ctx, block, options = {}) {
  if (bot.companionPlayerBlock?.(block.position)) return Promise.resolve(fail('protected_player_block'));
  // Plants have no collision shape, so a line-of-sight goal can never be met.
  if (block.boundingBox === 'empty') {
    return goTo(bot, ctx, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), {
      targetY: block.position.y, ...options, arrived: () => withinReach(bot, block.position),
    });
  }
  const goal = new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 });
  return goTo(bot, ctx, goal, {
    targetY: block.position.y - 1,
    ...options,
    arrived: () => withinReach(bot, block.position),
  });
}

function withinReach(bot, position, reach = 4.5) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  return eye.distanceTo(position.offset(0.5, 0.5, 0.5)) <= reach;
}

async function digBlock(bot, ctx, block, { timeoutMs = 12000, tool: chosen = null, point = null, face = null, ownedHomeRemoval = null } = {}) {
  if (ownedHomeRemoval && !ownedHomeRemoval(block)) return fail('not_owned_home_block');
  if (bot.companionProtectBlock?.(block) && !ownedHomeRemoval?.(block)) return fail('protected_home');
  const position = block.position;
  if (bot.companionPlayerBlock?.(position)) return fail('protected_player_block');
  const initialPermit = surveyDigPermit(bot, ctx, position);
  if (initialPermit?.reason) return fail(initialPermit.reason);
  const originalName = block.name;
  const canReach = () => initialPermit && point
    ? bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).distanceTo(point) <= 4.5
    : withinReach(bot, position);
  if (!canReach()) return fail('out_of_reach');
  // The fastest tool unless the caller picked one (to spare a better pickaxe).
  const tool = chosen || bot.pathfinder?.bestHarvestTool?.(block);
  if (tool) {
    try { await bot.equip(tool, 'hand'); } catch { /* digging by hand still works, slower */ }
  }
  const current = bot.blockAt(position);
  if (!current) return fail('unloaded');
  if (current.name !== originalName) return fail('block_changed');
  if (bot.companionPlayerBlock?.(position)) return fail('protected_player_block');
  if (ownedHomeRemoval && !ownedHomeRemoval(current)) return fail('not_owned_home_block');
  if (bot.companionProtectBlock?.(current) && !ownedHomeRemoval?.(current)) return fail('protected_home');
  if (initialPermit ? !current.diggable : !bot.canDigBlock(current)) return fail('cannot_dig');
  // The server digs five times slower in mid-air, so wait for footing.
  if (!bot.entity.onGround && !bot.entity.isInWater) {
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal });
  }
  if (bot.pathfinder?.movements?.companionWalkOnly) {
    const body = bot.entity.position;
    const supportsBody = position.y === Math.floor(body.y) - 1
      && position.x < body.x + 0.3 && position.x + 1 > body.x - 0.3
      && position.z < body.z + 0.3 && position.z + 1 > body.z - 0.3;
    if (supportsBody) {
      const below = bot.blockAt(position.offset(0, -1, 0));
      const fullShape = !below?.shapes || (below.shapes.length === 1 && below.shapes[0].length === 6
        && below.shapes[0].every((value, i) => value === [0, 0, 0, 1, 1, 1][i]));
      if (!below || below.boundingBox !== 'block' || !fullShape || /lava|water|fire|magma|campfire|cactus/.test(below.name)) {
        return fail('unsafe_support_dig');
      }
    }
  }
  if (initialPermit) {
    await bot.lookAt(point || position.offset(0.5, 0.5, 0.5), true);
    if (!canReach()) return fail('out_of_reach');
  }
  const permit = surveyDigPermit(bot, ctx, position);
  if (permit?.reason) return fail(permit.reason);
  let denial;
  try {
    permit?.start(face);
    // Skip the native look wait so cancellation can stop the active dig.
    await runCancellable(() => bot.dig(permit ? bot.blockAt(position) : current, permit ? 'ignore' : true), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'dig_timeout', cancel: () => bot.stopDigging(),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    // The server may still have broken it; trust only the block state below.
  } finally {
    denial = permit?.end();
  }
  if (denial) return fail(denial);
  const gone = await waitUntil(() => {
    const observed = bot.blockAt(position);
    return observed && observed.name !== originalName;
  },
    { timeoutMs: 1500, signal: ctx.signal });
  return gone ? { ok: true } : fail('dig_unconfirmed');
}

function droppedItemName(entity) {
  try { return entity.getDroppedItem?.()?.name || null; } catch { return null; }
}

function nearbyDrops(bot, origin, radius, matchName) {
  return Object.values(bot.entities).filter((entity) => {
    if (entity.name !== 'item' || !entity.position) return false;
    if (entity.position.distanceTo(origin) > radius) return false;
    const name = droppedItemName(entity);
    return name === null || matchName(name); // metadata may not have arrived yet
  });
}

function countItems(bot, matchName) {
  let total = 0;
  for (const item of ownedItems(bot)) if (matchName(item.name)) total += item.count;
  return total;
}

/** Walks over matching item drops near `origin`; ok once the inventory count rises. */
async function collectDrops(bot, ctx, origin, matchName, { radius = 6, timeoutMs = 10000 } = {}) {
  const before = countItems(bot, matchName);
  // Drops spawn a tick after the block breaks and then fall.
  await waitUntil(() => nearbyDrops(bot, origin, radius, matchName).length > 0,
    { timeoutMs: 1000, signal: ctx.signal });
  const deadline = Date.now() + timeoutMs;
  for (const drop of nearbyDrops(bot, origin, radius, matchName)) {
    if (Date.now() >= deadline) break;
    if (!bot.entities[drop.id]) continue;
    await goNear(bot, ctx, drop.position, 0.5, { timeoutMs: Math.max(1000, deadline - Date.now()) });
    await waitUntil(() => !bot.entities[drop.id], { timeoutMs: 800, signal: ctx.signal });
  }
  const gained = await waitUntil(() => countItems(bot, matchName) > before, { timeoutMs: 1500, signal: ctx.signal });
  const delta = countItems(bot, matchName) - before;
  return gained ? { ok: true, gained: delta } : fail('drops_not_collected', { gained: 0 });
}

// Foods worth eating at any hunger; risky foods only when starving.
const RISKY_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew']);

function pickFood(bot, accepts = () => true) {
  const foods = bot.registry.foodsByName || {};
  const candidates = bot.inventory.items().filter((item) => foods[item.name] && accepts(item));
  const safe = candidates.filter((item) => !RISKY_FOODS.has(item.name));
  const pool = safe.length ? safe : (bot.food <= 6 || bot.health <= 8 ? candidates : []);
  pool.sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0));
  return pool[0] || null;
}

// Mineflayer's consume() can await its private timer after releasing the item.
// Survey survival must release the body as soon as the authorization is revoked.
async function consumeHeldUntil(bot, ctx, confirmed, timeoutMs) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  try {
    bot.activateItem();
    return await waitUntil(confirmed, { timeoutMs, signal: ctx.signal });
  } finally {
    bot.deactivateItem();
  }
}

async function eat(bot, ctx, { timeoutMs = 5000, accepts, survey = false } = {}) {
  if (bot.food >= 20) return complete(false);
  const food = pickFood(bot, accepts);
  if (!food) return fail('no_food', { need: { food: 1 } });
  const name = food.name;
  const countBefore = countItems(bot, (n) => n === name);
  const foodBefore = bot.food;
  try {
    await bot.equip(food, 'hand');
  } catch {
    return fail('equip_failed');
  }
  const eaten = () => countItems(bot, (n) => n === name) < countBefore && (bot.food > foodBefore || bot.food >= 20);
  if (survey) return await consumeHeldUntil(bot, ctx, eaten, timeoutMs) ? { ok: true, ate: name } : fail('eat_unconfirmed', { ate: name });
  try {
    await runCancellable(() => bot.consume(), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'eat_timeout', cancel: () => bot.deactivateItem(),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    // consume() can reject although the server applied the meal; check below.
  }
  const confirmed = await waitUntil(eaten, { timeoutMs: 2000, signal: ctx.signal });
  return confirmed ? { ok: true, ate: name } : fail('eat_unconfirmed', { ate: name });
}

const MATERIAL_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
function weaponScore(name) {
  const [material, kind] = name.split('_');
  const rank = MATERIAL_RANK.indexOf(material);
  if (rank < 0) return -1;
  if (kind === 'sword') return 10 + rank * 2;
  if (kind === 'axe') return 9 + rank * 2;
  return -1;
}

async function equipBestWeapon(bot) {
  const best = bot.inventory.items()
    .map((item) => ({ item, score: weaponScore(item.name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)[0];
  if (best && bot.heldItem?.name !== best.item.name) {
    try { await bot.equip(best.item, 'hand'); } catch { /* fight with whatever is held */ }
  }
  const shield = bot.inventory.items().find((item) => item.name === 'shield');
  const offhand = bot.inventory.slots?.[45];
  if (shield && offhand?.name !== 'shield') {
    try { await bot.equip(shield, 'off-hand'); } catch { /* optional */ }
  }
}

// Mobs that a stray sweep turns on the bot, the whole pack at once.
const BYSTANDERS = new Set(['zombified_piglin', 'piglin', 'enderman', 'villager', 'iron_golem']);
// A sweep also hurts a player standing by the target, such as the owner being guarded.
const bystanderBeside = (bot, target) => Object.values(bot.entities).some((e) => e !== target && e !== bot.entity
  && (BYSTANDERS.has(e.name) || e.type === 'player')
  && e.position && e.position.distanceTo(target.position) <= 2.5 && e.position.distanceTo(bot.entity.position) <= 4.5);

// Fight until confirmed defeat, expiry, cancellation or a higher priority.
async function attack(bot, ctx, entityId, { timeoutMs = 15000, reach = 3, yieldTo = null, canPursue = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  try {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    await equipBestWeapon(bot);
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (Date.now() >= deadline) return fail('combat_timeout');
    const weaponSelectedAt = Date.now();
    // Chasing something up on the surface from a pit needs the same climbing allowance.
    const first = bot.entities[entityId];
    if (first && first.position.y - bot.entity.position.y >= 1.5 && underground(bot)) {
      return await withClimbing(bot, first.position.y + 4, () => attackLoop(bot, ctx, entityId, deadline, reach, weaponSelectedAt, yieldTo, canPursue));
    }
    return await attackLoop(bot, ctx, entityId, deadline, reach, weaponSelectedAt, yieldTo, canPursue);
  } finally {
    haltBody(bot);
  }
}

// Close on level ground by hand; reserve pathfinding for obstacles.
const DIRECT_APPROACH = 4.5;
const STEP_HAZARD = /lava|fire|water|magma|cactus|sweet_berry|powder_snow|campfire/;
function directStep(bot, target) {
  const here = bot.entity.position;
  const flat = target.position.minus(here);
  flat.y = 0;
  const length = Math.hypot(flat.x, flat.z);
  if (!bot.entity.onGround || length > DIRECT_APPROACH || length < 0.5 || Math.abs(target.position.y - here.y) > 0.6) return false;
  const next = here.offset(flat.x / length * 0.8, 0, flat.z / length * 0.8).floored();
  const floor = bot.blockAt?.(next.offset(0, -1, 0));
  const feet = bot.blockAt?.(next);
  const head = bot.blockAt?.(next.offset(0, 1, 0));
  if (floor?.boundingBox !== 'block' || feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty') return false;
  return ![floor, feet, head].some((b) => STEP_HAZARD.test(b.name));
}

async function attackLoop(bot, ctx, entityId, deadline, reach, weaponSelectedAt, yieldTo = null, canPursue = null) {
  // A chase that has not closed in for 8 s is not going to (cliff, water, canopy).
  let closest = Infinity;
  let closestAt = Date.now();
  // Vanishing is not dying: an animal that wanders out of tracking range also
  // disappears. Only a seen death, or vanishing next to the bot after hits, counts.
  let died = false;
  let hits = 0;
  let lastDistance = Infinity;
  let lastSentAt = null;
  let decisionKey = null;
  const onDead = (entity) => { if (entity?.id === entityId) died = true; };
  bot.on?.('entityDead', onDead);
  try {
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (died) return { ok: true, died, hits };
      const target = bot.entities[entityId];
      if (!target || !target.isValid) return died || (hits > 0 && lastDistance <= reach + 2) ? { ok: true, died, hits } : fail('target_lost');
      if (yieldTo?.()) return fail('combat_yielded', { died: false, hits, yielded: true });
      const geometry = meleeGeometry(bot.entity, target, bot.registry);
      if (!geometry) {
        ctx.record?.('combat_geometry_unknown', { targetId: entityId, mob: target.name, nativeWidth: target.width,
          nativeHeight: target.height, metadata: target.metadata ?? null, evidence: entitySizeEvidence(target, bot.registry) });
        return fail('unknown_target_geometry');
      }
      const distance = geometry.distance;
      const sight = distance <= reach ? meleeSight(bot, geometry) : 'out_of_reach';
      const canStrike = distance <= reach && sight === 'clear';
      if (!canStrike && canPursue && !canPursue(target.position)) return fail('combat_leash');
      lastDistance = distance;
      if (distance < closest - 0.5) { closest = distance; closestAt = Date.now(); }
      const key = `${geometry.size},${canStrike},${sight}`;
      if (key !== decisionKey) {
        decisionKey = key;
        ctx.record?.('combat_geometry', { targetId: entityId, mob: target.name, size: geometry.size,
          width: geometry.width, height: geometry.height, feetDistance: geometry.feetDistance, reachDistance: distance,
          sight, mode: canStrike ? 'strike' : 'approach', reach });
      }
      if (!canStrike && Date.now() - closestAt > 8000) {
        return fail(distance > reach ? 'chase_stuck' : sight === 'blocked' ? 'line_of_sight_blocked' : 'line_of_sight_unknown');
      }
      let sent = false;
      if (!canStrike && distance > reach && directStep(bot, target)) {
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
        await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0), true);
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (canPursue && !canPursue(target.position)) return fail('combat_leash');
        bot.setControlState('forward', true);
      } else if (!canStrike) {
        bot.setControlState?.('forward', false);
        // Set once: the observed hitbox goal tracks the target itself, and resetting it every
        // tick restarts path planning before any path is found.
        const current = bot.pathfinder.goal;
        if (!(current instanceof MeleeFollowGoal) || current.entity !== target || current.reach !== reach) {
          bot.pathfinder.setGoal(new MeleeFollowGoal(bot, target, reach), true);
        }
      } else {
        bot.setControlState?.('forward', false);
        bot.pathfinder.setGoal(null);
        const aim = distance > 1e-6 ? geometry.point : target.position.offset(0, geometry.height * 0.5, 0);
        await bot.lookAt(aim, true);
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (died) return { ok: true, died, hits };
        // A falling critical hit avoids sweeping nearby bystanders.
        if (bot.entity.onGround && bystanderBeside(bot, target)) {
          bot.setControlState('jump', true);
          await waitUntil(() => !bot.entity.onGround && (bot.entity.velocity?.y ?? 0) < 0, { timeoutMs: 800, signal: ctx.signal }).catch(() => {});
          bot.setControlState('jump', false);
        }
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (died) return { ok: true, died, hits };
        // Looking and the optional jump yield to packets. Recheck the same
        // live target and its sightline immediately before the attack packet.
        const fresh = bot.entities[entityId] === target && target.isValid && meleeGeometry(bot.entity, target, bot.registry);
        if (fresh && fresh.distance <= reach && meleeSight(bot, fresh) === 'clear') {
          bot.attack(target);
          const sentAt = Date.now();
          ctx.record?.('combat_attack', { targetId: entityId, mob: target.name, size: fresh.size,
            width: fresh.width, height: fresh.height, feetDistance: fresh.feetDistance, reachDistance: fresh.distance,
            weapon: bot.heldItem?.name || null, sentAt, sinceWeaponSelectionMs: sentAt - weaponSelectedAt,
            sincePreviousAttackMs: lastSentAt === null ? null : sentAt - lastSentAt });
          lastSentAt = sentAt;
          lastDistance = fresh.distance;
          hits += 1;
          sent = true;
        }
      }
      await sleep(sent ? 625 : 150, ctx.signal); // existing sword attack cooldown
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (died) return { ok: true, died, hits };
    }
    return fail('combat_timeout');
  } finally {
    bot.removeListener?.('entityDead', onDead);
    haltBody(bot);
  }
}

/** Runs away from `from` until at least `distance` blocks separate them. */
async function fleeFrom(bot, ctx, from, { distance = 16, timeoutMs = 8000 } = {}) {
  const goal = new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, distance));
  return goTo(bot, ctx, goal, {
    timeoutMs, arrived: (at) => at.distanceTo(from) >= distance - 1,
  });
}

// Sneak to the centre of one safe adjacent cell without overshooting.
async function nudge(bot, ctx, { accept = () => true } = {}) {
  const start = bot.entity.position.clone();
  const feet = start.floored();
  const open = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = feet.offset(dx, 0, dz);
    if (!accept(cell) || !open(bot.blockAt(cell)) || !open(bot.blockAt(cell.offset(0, 1, 0)))) continue;
    if (bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    const centre = cell.offset(0.5, 0, 0.5);
    try {
      bot.setControlState('sprint', false);
      bot.companionSneaking = true;
      bot.setControlState('sneak', true);
      for (let i = 0; i < 30; i += 1) {
        const p = bot.entity.position;
        if (Math.hypot(p.x - centre.x, p.z - centre.z) < 0.3) break;
        await bot.lookAt(centre.offset(0, 1.6, 0), true);
        bot.setControlState('forward', true);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('sneak', false);
      bot.companionSneaking = false;
    }
    if (bot.entity.position.distanceTo(start) > 0.7) return true;
  }
  return false;
}

/** On a tree canopy: break the leaves underfoot until standing on real ground. */
async function dropThroughLeaves(bot, ctx) {
  const start = bot.entity.position.clone();
  for (let i = 0; i < 10; i += 1) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below) break;
    if (below.boundingBox === 'empty') {
      await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
      continue;
    }
    if (!below.name.endsWith('_leaves')) break;
    const dug = await digBlock(bot, ctx, below, { timeoutMs: 4000 });
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround && bot.entity.position.y < below.position.y + 1.5, { timeoutMs: 2000, signal: ctx.signal });
  }
  return start.y - bot.entity.position.y >= 1;
}

// Scoop water from beneath a ceiling to make room to breathe and dig.
async function drainPocket(bot, ctx) {
  if (!bot.entity?.isInWater || typeof bot.blockAt !== 'function' || typeof bot.inventory?.items !== 'function') return false;
  const feet = bot.entity.position.floored();
  const head = feet.offset(0, 1, 0);
  const ceiling = bot.blockAt(feet.offset(0, 2, 0));
  if (!ceiling || ceiling.boundingBox !== 'block') return false;
  const bucket = bot.inventory.items().find((i) => i.name === 'bucket');
  const sources = [];
  for (const base of [head, feet]) {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(base.offset(dx, dy, dz));
      if (b?.name === 'water' && Number(b.getProperties?.().level) === 0) sources.push(b);
    }
  }
  if (!bucket || !sources.length) return blockInflow(bot, ctx, feet);
  try { await bot.equip(bucket, 'hand'); } catch (error) { if (error?.code === 'aborted') throw error; return false; }
  let drained = 0;
  for (const target of sources) {
    if (!bot.inventory.items().some((i) => i.name === 'bucket')) break;
    await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
    await sleep(100, ctx.signal);
    try { bot.activateItem(); } catch { /* checked below */ }
    if (await waitUntil(() => bot.blockAt(target.position)?.name !== 'water'
      || Number(bot.blockAt(target.position)?.getProperties?.().level) !== 0, { timeoutMs: 1000, signal: ctx.signal })) drained += 1;
  }
  if (drained) ctx.record?.('drain_pocket', { drained, at: `${feet.x},${feet.y},${feet.z}` });
  if (drained) return true;
  return blockInflow(bot, ctx, feet);
}

// If a bucket cannot remove the source, block the inflow to drain the cell.
async function blockInflow(bot, ctx, feet) {
  const own = new Set([0, 1].map((dy) => `${feet.x},${feet.y + dy},${feet.z}`));
  const inflow = [];
  for (const dy of [1, 2]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(feet.offset(dx, dy, dz));
      if (b?.name === 'water') inflow.push(b);
    }
  }
  if (!inflow.length || typeof bot.placeBlock !== 'function') return false;
  const filler = pickItem('filler', bot.inventory.items());
  if (!filler) return false;
  try { await bot.equip(filler, 'hand'); } catch (error) { if (error?.code === 'aborted') throw error; return false; }
  let walled = 0;
  for (const cell of inflow) {
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = bot.blockAt(cell.position.offset(dx, dy, dz));
      if (!ref || ref.boundingBox !== 'block' || own.has(`${ref.position.x},${ref.position.y},${ref.position.z}`)) continue;
      try {
        await bot.lookAt(ref.position.offset(0.5 - dx * 0.5, 0.5 - dy * 0.5, 0.5 - dz * 0.5), true);
        await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz));
        walled += 1;
      } catch (error) {
        if (error?.code === 'aborted') throw error;
        continue;
      }
      break;
    }
  }
  if (!walled) return false;
  ctx.record?.('block_inflow', { walled, at: `${feet.x},${feet.y},${feet.z}` });
  return waitUntil(() => bot.blockAt(feet.offset(0, 1, 0))?.name !== 'water', { timeoutMs: 4000, signal: ctx.signal });
}

async function unstick(bot, ctx, { landed = () => true } = {}) {
  const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (under && under.name.endsWith('_leaves') && await dropThroughLeaves(bot, ctx)) return { ok: true, moved: 'off_canopy' };
  // The pathfinder only passes an open door.
  if (await openNearDoor(bot, ctx)) return { ok: true, moved: 'opened_door' };
  // A shore approach that cannot verify a landing falls through to the next method.
  if (await swimAshore(bot, ctx) && landed()) return { ok: true, moved: 'swam_ashore' };
  if (await stepOutOfPool(bot, ctx) && landed()) return { ok: true, moved: 'out_of_pool' };
  if (await drainPocket(bot, ctx)) return { ok: true, moved: 'drained_pocket' };
  const pit = shallowPitTarget(bot);
  if (pit && ctx.adapt) {
    const up = await surface(bot, ctx, { targetY: pit });
    if (up) return up;
  } else if (pit && await climbPitDirectly(bot, ctx, pit)) return { ok: true, moved: 'pit_pillar' };
  if (await nudge(bot, ctx)) return { ok: true, moved: 'nudged' };
  const start = bot.entity.position.clone();
  const movements = bot.pathfinder.movements;
  // Down in a pit or a mine: pillar straight back up to ground level. With
  // nothing to pillar with, the pit walls supply it; failing that, dig a
  // staircase out.
  if (underground(bot)) {
    const surface = Number.isFinite(bot.companionSurfaceY) ? bot.companionSurfaceY : start.y + 6;
    if (countItems(bot, (n) => CLIMB_BLOCKS.includes(n)) < 4) await gatherClimbBlocks(bot, ctx);
    await withClimbing(bot, surface + 4, () => goTo(bot, ctx, new goals.GoalY(Math.floor(surface)), { timeoutMs: 30000,
      arrived: () => true }));
    if (bot.entity.position.y - start.y >= 2) return { ok: true, moved: 'climbed' };
    const stairs = await digStairsUp(bot, ctx, Number.isFinite(bot.companionSurfaceY) ? bot.companionSurfaceY : localSurfaceY(bot));
    if (stairs >= 2) return { ok: true, moved: 'stairs' };
  }
  const saved = movements.maxDropDown;
  // In the Nether a drop or a hole dug down may end in a lava sea: no deeper drops than the
  // Nether movements allow, and no digging down.
  const nether = String(bot.game?.dimension || '').endsWith('the_nether');
  try {
    // Fall damage is (height - 3); keep at least 5 health after any drop.
    if (!nether) movements.maxDropDown = Math.max(saved, Math.min(12, Math.floor(bot.health) - 2));
    const walkOut = async () => {
      for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const goal = new goals.GoalNearXZ(start.x + Math.cos(angle) * 8, start.z + Math.sin(angle) * 8, 2);
        await goTo(bot, ctx, goal, { timeoutMs: 15000, arrived: () => true });
        if (bot.entity.position.distanceTo(start) > 3) return true;
      }
      return false;
    };
    if (await walkOut()) return { ok: true, moved: 'walked' };
    // Boxed in beside lava: try again with only the lava cells themselves shut.
    if (nether && await require('./nether').withLavaMarginsLifted(bot, walkOut)) return { ok: true, moved: 'walked_near_lava' };
    // A fence top can leave the planner without a starting node.
    if (await breakLattice(bot, ctx) && await walkOut()) return { ok: true, moved: 'broke_lattice' };
    // A low wet cell needs headroom before the body can rise.
    if (!nether && await openHeadroom(bot, ctx) && await walkOut()) return { ok: true, moved: 'opened_headroom' };
  } finally {
    movements.maxDropDown = saved;
  }
  for (let i = 0; i < (nether ? 0 : 8); i += 1) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block' || !bot.canDigBlock(below)) break;
    const dug = await digBlock(bot, ctx, below);
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
    if (start.y - bot.entity.position.y >= 2) return { ok: true, moved: 'dug_down' };
  }
  return bot.entity.position.distanceTo(start) > 2 ? { ok: true, moved: 'partial' } : fail('stuck');
}

/** Digs the block over the bot's head and those beside its head. True if any went. */
const SEA = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);
/** Out on open water, swims along the surface to the nearest land within sight. True once ashore. */
async function swimAshore(bot, ctx, { maxTicks = 1200 } = {}) {
  const feet = bot.entity.position.floored();
  const wet = (p) => SEA.has(bot.blockAt(p)?.name);
  if (!wet(feet) && !wet(feet.offset(0, -1, 0))) return false;
  // Not a puddle: open water all round.
  if (![[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dz]) => wet(feet.offset(dx, -1, dz)))) return false;
  // Solid ground about the water's level with open air over it.
  const shore = bot.findBlock({ maxDistance: 96, matching: (b) => b.boundingBox === 'block' && !SEA.has(b.name),
    useExtraInfo: (b) => b.position.y >= feet.y - 2 && b.position.y <= feet.y + 1
      && bot.blockAt(b.position.offset(0, 1, 0))?.boundingBox === 'empty' && !SEA.has(bot.blockAt(b.position.offset(0, 1, 0))?.name) });
  // No land in sight: swim a stretch towards home, the way back to land.
  const home = typeof bot.companionHomeAt === 'function' ? bot.companionHomeAt() : null;
  if (!shore && !home) return false;
  const start = bot.entity.position.clone();
  const leg = home && Math.min(64, Math.hypot(home.x - start.x, home.z - start.z));
  const heading = home && Math.atan2(home.z - start.z, home.x - start.x);
  const target = shore ? shore.position.offset(0.5, 1, 0.5)
    : new Vec3(start.x + Math.cos(heading) * leg, start.y, start.z + Math.sin(heading) * leg);
  ctx.record('swim_ashore', { to: shore ? shore.position : target.floored(), home: !shore,
    distance: Math.round(Math.hypot(target.x - start.x, target.z - start.z)) });
  try {
    for (let i = 0; i < maxTicks; i += 1) {
      const here = bot.entity.position;
      if (Math.hypot(here.x - target.x, here.z - target.z) < 1.2 || (bot.entity.onGround && !wet(here.floored()))) break;
      await bot.lookAt(target.offset(0, 0.6, 0), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(50, ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  // Out, or beside the shore with a step left for the planner; out at sea, a good stretch nearer home.
  const end = bot.entity.position;
  if (!shore) return Math.hypot(end.x - start.x, end.z - start.z) > 16;
  return !wet(end.floored()) || Math.hypot(end.x - target.x, end.z - target.z) < 1.5;
}

// Lower a flooded pit's rim to a step the bot can climb from water.
async function stepOutOfPool(bot, ctx, { maxTicks = 200 } = {}) {
  const feet = bot.entity.position.floored();
  const wet = (p) => SEA.has(bot.blockAt(p)?.name);
  if (!wet(feet) && !wet(feet.offset(0, -1, 0))) return false;
  let top = wet(feet) ? feet : feet.offset(0, -1, 0);
  while (wet(top.offset(0, 1, 0))) top = top.offset(0, 1, 0);
  const here = bot.entity.position;
  const ledges = [];
  for (let dx = -4; dx <= 4; dx += 1) {
    for (let dz = -4; dz <= 4; dz += 1) {
      const from = top.offset(dx, 0, dz);
      if (!wet(from) || bot.blockAt(from.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
      for (const [sx, sz] of SIDES) {
        const ledge = from.offset(sx, 0, sz);
        const b = bot.blockAt(ledge);
        if (b?.boundingBox !== 'block' || wet(ledge)) continue;
        ledges.push({ ledge, from, d: Math.hypot(ledge.x + 0.5 - here.x, ledge.z + 0.5 - here.z) });
      }
    }
  }
  ledges.sort((a, b) => a.d - b.d);
  const swimTo = async (target, done) => {
    try {
      for (let i = 0; i < maxTicks && !done(); i += 1) {
        // Eyes level or up: looking down at the water swims the bot under.
        const p = bot.entity.position;
        await bot.lookAt(new Vec3(target.x, Math.max(target.y, p.y + 1.62), target.z), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  };
  for (const { ledge, from } of ledges.slice(0, 4)) {
    const cells = [ledge.offset(0, 1, 0), ledge.offset(0, 2, 0)];
    if (cells.some((c) => { const b = bot.blockAt(c); return FLUID.test(b?.name || '') || (b?.boundingBox !== 'empty' && b?.diggable === false); })) continue;
    // Swim up against the ledge, then cut the rim above it away.
    const beside = from.offset(0.5, 0.5, 0.5);
    await swimTo(beside, () => Math.hypot(bot.entity.position.x - beside.x, bot.entity.position.z - beside.z) < 0.8);
    let open = true;
    for (const c of cells) {
      const b = bot.blockAt(c);
      if (!b || b.boundingBox === 'empty') continue;
      const dug = await digBlock(bot, ctx, b, { timeoutMs: Math.max(8000, (Number(bot.digTime?.(b)) || 0) + 3000) });
      if (!dug.ok) { open = false; break; }
    }
    if (!open) continue;
    const step = ledge.offset(0.5, 1, 0.5);
    ctx.record('step_out_of_pool', { ledge: `${ledge.x},${ledge.y},${ledge.z}` });
    await swimTo(step, () => bot.entity.onGround && !wet(bot.entity.position.floored()));
    if (!wet(bot.entity.position.floored()) && bot.entity.position.y >= ledge.y + 0.9) return true;
  }
  return false;
}

const WOODEN_DOOR = /^(?!iron_).*_door$/;
/** Opens the nearest closed wooden door within a few blocks. True if one opened. */
async function openNearDoor(bot, ctx) {
  const block = bot.findBlock({ maxDistance: 6, useExtraInfo: true, matching: (b) => WOODEN_DOOR.test(b.name)
    && b.getProperties?.().half === 'lower' && b.getProperties().open === false });
  if (!block) return false;
  if (!withinReach(bot, block.position)) await goNear(bot, ctx, block.position, 2, { timeoutMs: 15000 });
  if (!withinReach(bot, block.position)) return false;
  try { await bot.activateBlock(bot.blockAt(block.position)); } catch { return false; }
  return waitUntil(() => bot.blockAt(block.position)?.getProperties?.().open === true, { timeoutMs: 1500, signal: ctx.signal });
}

async function openHeadroom(bot, ctx) {
  const head = bot.entity.position.floored().offset(0, 1, 0);
  const cells = [head.offset(0, 1, 0), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => head.offset(dx, 0, dz))];
  let dug = 0;
  for (const cell of cells) {
    const block = bot.blockAt(cell);
    if (!block || block.boundingBox !== 'block' || !bot.canDigBlock(block)) continue;
    // Never open a ceiling that holds back water or lava.
    if (['water', 'lava'].includes(bot.blockAt(cell.offset(0, 1, 0))?.name)) continue;
    const result = await digBlock(bot, ctx, block);
    if (result.ok) dug += 1;
  }
  return dug > 0;
}

const LATTICE = /(_fence|_wall|iron_bars|_pane)$/;
/** Digs fences, walls and bars in and around the bot's body. True if any went. */
async function breakLattice(bot, ctx) {
  const feet = bot.entity.position.floored();
  const cells = [];
  for (let dy = -1; dy <= 1; dy += 1) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push(feet.offset(dx, dy, dz));
  let broke = 0;
  for (const cell of cells) {
    const block = bot.blockAt(cell);
    if (!block || !LATTICE.test(block.name) || !bot.canDigBlock?.(block)) continue;
    const dug = await digBlock(bot, ctx, block);
    if (dug.ok) broke += 1;
  }
  if (broke) ctx.record?.('unstick_lattice', { broke });
  return broke > 0;
}

const FLUID = /water|lava/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const fluidNext = (bot, p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .some(([dx, dy, dz]) => FLUID.test(bot.blockAt(p.offset(dx, dy, dz))?.name || ''));

/** Digs a few pit-wall blocks at or above foot level for their dirt or cobblestone. */
async function gatherClimbBlocks(bot, ctx, { want = 6 } = {}) {
  const pickaxe = bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
  const feet = bot.entity.position.floored();
  const walls = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = 0; dy <= 2; dy += 1) {
        if (dx === 0 && dz === 0) continue;
        const block = bot.blockAt(feet.offset(dx, dy, dz));
        if (!block || !(isSealSoil(block.name) || (pickaxe && isSealRock(block.name)))) continue;
        if (fluidNext(bot, block.position) || !withinReach(bot, block.position)) continue;
        walls.push(block);
      }
    }
  }
  walls.sort((a, b) => Number(isSealRock(a.name)) - Number(isSealRock(b.name)));
  let gained = 0;
  for (const block of walls) {
    if (gained >= want) break;
    const before = countItems(bot, (n) => CLIMB_BLOCKS.includes(n));
    const dug = await digBlock(bot, ctx, block, { timeoutMs: 8000 });
    if (!dug.ok) continue;
    await collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), (n) => CLIMB_BLOCKS.includes(n), { radius: 4, timeoutMs: 3000 });
    gained += Math.max(0, countItems(bot, (n) => CLIMB_BLOCKS.includes(n)) - before);
  }
  return gained;
}

/** The highest standing level among the columns a few blocks around the bot. */
function localSurfaceY(bot, { radius = 3, above = 10 } = {}) {
  const feet = bot.entity.position.floored();
  let best = feet.y;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const column = feet.offset(Math.round(Math.cos(angle) * radius), 0, Math.round(Math.sin(angle) * radius));
    for (let dy = above; dy >= 0; dy -= 1) {
      if (solidGround(bot.blockAt(column.offset(0, dy, 0)))) { best = Math.max(best, feet.y + dy + 1); break; }
    }
  }
  return best;
}

// The pathfinder can return without moving in a narrow, open shaft. There
// is room to jump and place on the floor without asking it to find a route.
function shallowPitTarget(bot) {
  if (String(bot.game?.dimension || '').replace('minecraft:', '') !== 'overworld'
    || bot.pathfinder?.movements?.companionWalkOnly || !underground(bot)) return null;
  const feet = bot.entity.position.floored();
  if (!openSky(bot, feet)) return null;
  const rim = localSurfaceY(bot, { above: 5 });
  const height = rim - feet.y;
  return height >= 2 && height <= 6 ? rim : null;
}

async function climbPitDirectly(bot, ctx, targetY) {
  const from = bot.entity.position.floored();
  const depth = targetY - from.y;
  const below = bot.blockAt(from.offset(0, -1, 0));
  if (depth < 1 || depth > 6 || bot.entity.onGround !== true || !solidGround(below)
    || FLUID.test(below.name) || /^(magma_block|campfire|soul_campfire|cactus)$/.test(below.name)
    || ![0, 1, 2].every((dy) => /^(air|cave_air|void_air)$/.test(bot.blockAt(from.offset(0, dy, 0))?.name || ''))
    || bot.companionNearPlayerBuild?.(from)
    || countItems(bot, (name) => CLIMB_BLOCKS.includes(name)) < depth) return false;
  ctx.record?.('recovery_switch', { task: 'pit_exit', to: 'direct_pillar', at: posKey(from), targetY });
  const blocks = new RegExp(`^(?:${CLIMB_BLOCKS.join('|')})$`);
  await recentre(bot, ctx);
  await require('./end').pillarUp(bot, ctx, targetY, { maxSteps: depth + 2, blocks,
    stop: () => ctx.signal?.aborted || bot.entity.isInWater || bot.entity.isInLava || bot.companionNearPlayerBuild?.(bot.entity.position.floored()) });
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const ok = bot.entity.onGround && bot.entity.position.y >= targetY - 0.1;
  ctx.record?.('pit_pillar_result', { at: posKey(bot.entity.position), targetY, ok: Boolean(ok) });
  return Boolean(ok);
}

// Clear headroom and climb one stair at a time, avoiding fluid-adjacent digs.
async function digStairsUp(bot, ctx, targetY, { maxSteps = 24, stop = () => false } = {}) {
  const clearable = (p) => {
    const b = bot.blockAt(p);
    if (!b || FLUID.test(b.name)) return false;
    if (b.boundingBox === 'empty') return true;
    return bot.canDigBlock(b) && b.diggable !== false && !fluidNext(bot, p);
  };
  let direction = null;
  let climbed = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const feet = bot.entity.position.floored();
    if (stop() || feet.y >= Math.floor(targetY)) break;
    const sides = direction ? [direction, ...SIDES.filter((d) => d !== direction)] : SIDES;
    const next = sides.find(([dx, dz]) => {
      const ahead = feet.offset(dx, 0, dz);
      return bot.blockAt(ahead)?.boundingBox === 'block' && !FLUID.test(bot.blockAt(ahead).name)
        && clearable(feet.offset(0, 2, 0)) && clearable(ahead.offset(0, 1, 0)) && clearable(ahead.offset(0, 2, 0));
    });
    if (!next) break;
    direction = next;
    const ahead = feet.offset(next[0], 0, next[1]);
    for (const p of [feet.offset(0, 2, 0), ahead.offset(0, 2, 0), ahead.offset(0, 1, 0)]) {
      const b = bot.blockAt(p);
      if (b && b.boundingBox !== 'empty') {
        // Deepslate by hand takes 15 seconds a block: the timeout follows the dig.
        const digMs = typeof bot.digTime === 'function' ? bot.digTime(b) : 0;
        const dug = await digBlock(bot, ctx, b, { timeoutMs: Math.max(8000, (Number(digMs) || 0) + 3000) });
        if (!dug.ok) return climbed;
      }
    }
    const up = ahead.offset(0, 1, 0);
    const moved = await goToOnce(bot, ctx, new goals.GoalBlock(up.x, up.y, up.z), { timeoutMs: 5000 });
    if (!moved.ok || bot.entity.position.y < feet.y + 0.9) return climbed;
    climbed += 1;
  }
  return climbed;
}

// Descend to solid floors, turning before a dig or step would expose fluid.
/** Walks onto the cell `into` (one block over and one down), by hand. */
async function stepInto(bot, ctx, into) {
  const centre = into.offset(0.5, 0, 0.5);
  try {
    for (let i = 0; i < 40; i += 1) {
      const p = bot.entity.position;
      if (p.floored().y <= into.y && Math.hypot(p.x - centre.x, p.z - centre.z) < 0.4) break;
      await bot.lookAt(centre.offset(0, 1.6, 0), true);
      bot.setControlState('forward', Math.hypot(p.x - centre.x, p.z - centre.z) > 0.25);
      await new Promise((r) => setTimeout(r, 75));
      if (ctx.signal?.aborted) break;
    }
  } finally {
    bot.setControlState('forward', false);
  }
}

async function digStairsDown(bot, ctx, target, { maxSteps = 16 } = {}) {
  const clearable = (p) => {
    const b = bot.blockAt(p);
    if (!b || FLUID.test(b.name)) return false;
    if (b.boundingBox === 'empty') return !fluidNext(bot, p);
    return bot.canDigBlock(b) && b.diggable !== false && !fluidNext(bot, p);
  };
  const floorOk = (p) => {
    const b = bot.blockAt(p);
    return b && b.boundingBox === 'block' && !FLUID.test(b.name) && !/magma/.test(b.name)
      && !FLUID.test(bot.blockAt(p.offset(0, -1, 0))?.name || '');
  };
  let down = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const feet = bot.entity.position.floored();
    if (feet.y <= target.y) break;
    const dx = target.x - feet.x;
    const dz = target.z - feet.z;
    const toward = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
    const order = [toward, ...SIDES.filter(([x, z]) => x !== toward[0] || z !== toward[1])];
    const next = order.find(([x, z]) => {
      const ahead = feet.offset(x, 0, z);
      return clearable(ahead.offset(0, 1, 0)) && clearable(ahead) && clearable(ahead.offset(0, -1, 0)) && floorOk(ahead.offset(0, -2, 0));
    });
    if (!next) {
      ctx.record?.('stairs_blocked', { at: `${feet.x},${feet.y},${feet.z}`, sides: order.map(([x, z]) => {
        const a = feet.offset(x, 0, z);
        return [clearable(a.offset(0, 1, 0)), clearable(a), clearable(a.offset(0, -1, 0)), floorOk(a.offset(0, -2, 0))].map(Number).join('');
      }) });
      break;
    }
    const ahead = feet.offset(next[0], 0, next[1]);
    for (const p of [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)]) {
      // Sand or gravel overhead falls into the cell again: dig until it stays open.
      for (let tries = 0; tries < 8; tries += 1) {
        const b = bot.blockAt(p);
        if (!b || b.boundingBox === 'empty') break;
        if (tries === 0) haltBody(bot);
        const dug = await digBlock(bot, ctx, b, { timeoutMs: 8000 });
        // Unconfirmed: sand fell back in, or the server dropped the break; dig again.
        if (dug.ok || (dug.reason === 'dig_unconfirmed' && tries < 7)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        ctx.record?.('stairs_dig_failed', { block: b.name, at: `${p.x},${p.y},${p.z}`, reason: dug.reason || null });
        return down;
      }
    }
    const into = ahead.offset(0, -1, 0);
    const moved = await goToOnce(bot, ctx, new goals.GoalBlock(into.x, into.y, into.z), { timeoutMs: 5000 });
    // The pathfinder can call a one-block step down done before the body
    // drops; walk it by hand.
    if (bot.entity.position.floored().y >= feet.y) await stepInto(bot, ctx, into);
    if (bot.entity.position.floored().y >= feet.y) {
      ctx.record?.('stairs_step_failed', { reason: moved.reason || null, into: `${into.x},${into.y},${into.z}` });
      return down;
    }
    down += 1;
  }
  return down;
}

/** Climbs back to the surface reference level (or `targetY`) if the bot is below it. */
async function surface(bot, ctx, { targetY, bunker = false } = {}) {
  ctx = { ...ctx, rescue: 'surface' };
  const explicit = Number.isFinite(targetY);
  if ((!bunker && !underground(bot)) || (explicit && bot.entity.position.y >= targetY - 0.1)) return null;
  const start = bot.entity.position.floored();
  const rim = shallowPitTarget(bot) || (bunker && explicit && targetY);
  const reference = Math.max(bot.companionSurfaceY ?? start.y + 4, localSurfaceY(bot));
  const target = Math.floor(explicit ? targetY : Math.max(start.y + 2, reference));
  if (!explicit && bot.entity.position.y >= target - 1) return null;
  const reached = () => explicit ? bot.entity.position.y >= target - 0.1 : bot.entity.onGround !== false && !underground(bot);
  const climb = (y, options) => withClimbing(bot, y + 4, () => goTo(bot, { ...ctx, nearDestination: true }, new goals.GoalY(y), options));
  if (rim && ctx.adapt) {
    const deadline = Date.now() + 30_000;
    const shaft = { position: start };
    let nextRim = rim;
    let result;
    for (let step = 0; nextRim && step < 8 && Date.now() < deadline; step += 1) {
      const legTarget = Math.min(target, nextRim);
      result = await ctx.adapt.run('pit', shaft, async (method) => {
        if (method === 'pathfinder') {
          await climb(legTarget, { timeoutMs: Math.max(1, Math.min(12000, deadline - Date.now())), retryNoProgress: false });
        } else if (method === 'direct_pillar') {
          await climbPitDirectly(bot, ctx, legTarget);
        } else {
          await digStairsUp(bot, ctx, legTarget, { maxSteps: 8, stop: reached });
        }
        return reached() || bot.entity.position.y >= legTarget - 0.1
          ? { ok: true, surfaced: reached() } : failure('still_below_surface', {}, ctx, bot);
      }, { threshold: 1 });
      if (reached() || result.wait || (!result.ok && !factsOf(result).adaptation?.switched)) return result;
      if (factsOf(result).adaptation?.exhausted) return result;
      nextRim = shallowPitTarget(bot);
    }
    if (result && (nextRim || !result.ok)) return result;
  }
  await climb(target, { timeoutMs: 30000, arrived: () => true });
  if (reached()) return { ok: true, surfaced: true };
  if (rim) {
    await climbPitDirectly(bot, ctx, Math.min(rim, target));
    if (reached()) return { ok: true, surfaced: true };
  }
  await digStairsUp(bot, ctx, target, { maxSteps: Math.min(24, target - Math.floor(bot.entity.position.y) + 4), stop: reached });
  if (reached()) return { ok: true, surfaced: true };
  // A long ascent can take several cancellable steps. Only report a failure
  // when the body made no meaningful climb and still has no surface exit.
  return !explicit && bot.entity.position.y - start.y >= 2 ? { ok: true, surfaced: false } : fail('still_below_surface');
}

module.exports = {
  withSurveyStep: settleAction(withSurveyStep),
  surveyPlace: (bot, ctx, options) => resultFrom(surveyPlace(bot, ctx, options), ctx, bot),
  openSurveyChest, openSurveyDoor: settleAction(openSurveyDoor), closeSurveyDoor: settleAction(closeSurveyDoor), isSurveyNight,
  drainPocket,
  recentre, surface: settleAction(surface, 'surface'), underground, openSky, localSurfaceY, isHomeTarget, routeOrigin, originFailure,
  unstick: settleAction(unstick, 'unstick'), nudge, breakLattice, openHeadroom, openNearDoor, swimAshore, stepOutOfPool, gatherClimbBlocks,
  digStairsUp, digStairsDown, goTo: settleAction(goTo), goNear: settleAction(goNear), goToDig: settleAction(goToDig), withinReach,
  digBlock: settleAction(digBlock), collectDrops: settleAction(collectDrops), countItems, eat: settleAction(eat), pickFood,
  attack: settleAction(attack), directStep, fleeFrom: settleAction(fleeFrom),
  equipBestWeapon, haltBody, weaponScore, droppedItemName, RISKY_FOODS, consumeHeldUntil,
};
