'use strict';

const { randomUUID } = require('node:crypto');
const { classifyReason } = require('./action-reasons');
const { countInventory, ownedItems } = require('./perception');

const receipts = new WeakMap();
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const LEGACY_DIMENSION_ACTIONS = new Set([
  'goal:end_city', 'goal:end_dragon', 'goal:end_journey', 'goal:enter_end', 'goal:hunt_pearls',
  'goal:nether_expedition', 'goal:nether_quartz', 'fight_shulker', 'hide', 'leave_breath', 'retrieve_water', 'ride_levitation',
]);

function createAttempt(ctx = {}) {
  return ctx?.attemptId == null ? { ...ctx, attemptId: randomUUID() } : ctx;
}

function complete(progress = true, receipt) {
  const result = { ok: true, progress };
  if (receipt && Object.keys(receipt).length) receipts.set(result, receipt);
  return result;
}

function waiting(reason, until = null) {
  return { ok: true, wait: { reason, until } };
}

function startProblem(ctx, state) {
  if (state?.source) return state.source;
  const bot = state?.bot ?? state;
  if (state?.selfStuck || bot?.companionSelfStuck?.state?.()) return 'self_stuck';
  const feet = bot?.entity?.position?.floored?.();
  if (state?.inWater || bot?.entity?.isInWater || (feet && WATER.has(bot.blockAt?.(feet)?.name))) return 'water';
  if (ctx?.selfRescue || ['home_escape', 'unstick'].includes(ctx?.behavior)) return 'self_rescue';
  if (state?.firstStepFailed) return 'path_first_step';
  return null;
}

function failure(reason, facts = {}, ctx, state) {
  let kind = classifyReason(reason);
  const source = kind !== 'interrupted' && (facts.source || startProblem(ctx, state));
  if (source) {
    kind = 'start';
    facts = { ...facts, source };
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

function factsOf(result) {
  return result?.facts ?? receipts.get(result) ?? result ?? {};
}

function resultFrom(value, ctx, state) {
  if (value?.ok === false) {
    const { ok, kind, reason, facts, attemptId, ...details } = value;
    const attempt = createAttempt({ ...ctx, attemptId: ctx?.attemptId ?? attemptId });
    const baseKind = classifyReason(reason);
    if ((kind === baseKind || kind === 'start') && facts && attemptId === attempt.attemptId && !Object.keys(details).length) return value;
    const result = failure(reason, { ...details, ...facts }, attempt, state);
    if (kind === 'start' && result.kind !== 'start' && result.kind !== 'interrupted') result.kind = 'start';
    return result;
  }
  if (value?.wait) return waiting(value.wait.reason, value.wait.until);
  if (value?.ok !== true || receipts.has(value)) return value?.ok === true ? value : complete();
  const { ok, progress, ...receipt } = value;
  return complete(progress ?? !(receipt.already || receipt.idle || receipt.skipped), receipt);
}

function legacyDimensionResult(value, ctx, state) {
  if (!LEGACY_DIMENSION_ACTIONS.has(ctx?.behavior)) return resultFrom(value, ctx, state);
  if (value?.waited) return waiting(value.reason || 'dimension_action_pending', value.retryAt);
  const { sourceHandled, destinationUnconfirmed, handedOff, waited, sourceFailure, giveUp, ...result } = value ?? {};
  if (sourceFailure || giveUp) result.facts = { ...result.facts, ...(sourceFailure ? { source: sourceFailure } : {}), ...(giveUp ? { terminal: true } : {}) };
  return resultFrom(result, ctx, state);
}

function settleAction(run) {
  return async (bot, ctx, ...args) => {
    const attempt = createAttempt(ctx);
    const interrupted = () => failure('aborted', { cause: attempt.signal?.reason }, attempt);
    if (attempt.signal?.aborted) return interrupted();
    try {
      return resultFrom(await run(bot, attempt, ...args) ?? complete(false), attempt, bot);
    } catch (error) {
      if (error?.code !== 'aborted') throw error;
      return interrupted();
    }
  };
}

module.exports = { classifyReason, complete, createAttempt, factsOf, failure, legacyDimensionResult, resultFrom, settleAction, startProblem, waiting };
