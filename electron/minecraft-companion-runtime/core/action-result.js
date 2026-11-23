'use strict';

const { randomUUID } = require('node:crypto');
const { classifyReason, FAILURE_LIMIT, FAILURE_WINDOW_MS, isRescueBehavior } = require('./action-reasons');
const { countInventory, ownedItems } = require('./perception');

const receipts = new WeakMap();
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const rescueOf = ctx => ctx?.rescue || (isRescueBehavior(ctx?.behavior) ? ctx.behavior : null);

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

function startProblem(state) {
  if (state?.source) return state.source;
  const bot = state?.bot ?? state;
  if (state?.selfStuck || bot?.companionSelfStuck?.state?.()) return 'self_stuck';
  const feet = bot?.entity?.position?.floored?.();
  if (state?.inWater || bot?.entity?.isInWater || (feet && WATER.has(bot.blockAt?.(feet)?.name))) return 'water';
  if (state?.firstStepFailed) return 'path_first_step';
  return null;
}

function failure(reason, facts = {}, ctx, state) {
  let kind = classifyReason(reason);
  const rescue = rescueOf(ctx);
  if (kind !== 'interrupted') {
    const source = facts.source || startProblem(state);
    if (rescue) {
      if (kind === 'start') kind = 'environment';
      facts = { ...facts, rescue: facts.rescue || rescue };
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
    const attempt = createAttempt(rescue ? { ...ctx, rescue } : ctx);
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

module.exports = { classifyReason, complete, createAttempt, factsOf, failure, FAILURE_LIMIT, FAILURE_WINDOW_MS,
  isRescueBehavior, rescueOf, resultFrom, settleAction, startProblem, waiting };
