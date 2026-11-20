'use strict';

const { once } = require('node:events');
const { Vec3 } = require('vec3');
const { abortError, waitUntil } = require('./confirm');
const { matchesExpect, matchesTarget, positionKey, replaceable, removalConflict, stateName } = require('./survey-plan-rules');

const scopes = new WeakMap();
const STEP = Symbol('surveyStep');
const AIR = 'minecraft:air';
const CHESTS = new Set(['chest', 'trapped_chest']);
const CUSTOM_COMPONENTS = new Set(['block_state', 'block_entity_data', 'custom_data']);
const faceOffsets = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const fail = (reason) => ({ ok: false, reason });
const asVec = ({ x, y, z }) => new Vec3(x, y, z);
const isSurveyNight = (bot) => bot.time?.timeOfDay >= 12542 && bot.time.timeOfDay <= 23460;

function checkStep(scope, step, pos, remove) {
  if (!scope || scope.step !== step || !step || scope.grant.signal.aborted || step.signal?.aborted) return 'survey_unauthorized';
  if (isSurveyNight(scope.bot)) return 'survey_night';
  if (positionKey(step.ops[0].pos) !== positionKey(pos) || step.ops.some((op) => (op.target === AIR) !== remove)) {
    return 'survey_wrong_operation';
  }
  if (!step.ops.every((op) => matchesExpect(scope.bot, op))) return 'survey_site_changed';
  return remove ? removalConflict(scope.bot, scope.plan, step.ops) : null;
}

function acknowledge(scope) {
  for (const [op, previous] of scope.attempted) {
    const event = scope.grant.applied(op.pos);
    if (event && event !== previous) {
      scope.attempted.delete(op);
      scope.pending.delete(op);
      scope.byPosition.get(positionKey(op.pos)).shift();
    }
  }
  while (scope.phaseIndex < scope.phases.length && !scope.phases[scope.phaseIndex].some((op) => scope.pending.has(op))) {
    scope.phaseIndex += 1;
  }
}

function rememberAttempt(scope, step) {
  for (const op of step.ops) scope.attempted.set(op, scope.grant.applied(op.pos));
}

function safeHit(bot, permit, data) {
  const offset = faceOffsets[data.direction];
  if (!permit.reference || positionKey(data.location) !== positionKey(permit.reference) || !offset) return false;
  const clicked = asVec(data.location);
  const current = bot.blockAt(clicked);
  if (!current) return false;
  const target = positionKey(permit.pos);
  const onTarget = positionKey(clicked) === target;
  const name = permit.step.ops[0].target.split('[', 1)[0].replace(/^minecraft:/, '');
  const held = bot.heldItem?.name;
  if (name === 'farmland') return onTarget && data.direction === 1 && held?.endsWith('_hoe');
  if (name === 'wheat') return !onTarget && data.direction === 1 && positionKey(clicked.offset(...offset)) === target
    && current.name === 'farmland' && held === 'wheat_seeds';
  if (held !== name) return false;
  if (onTarget) return replaceable(stateName(current));
  if (replaceable(stateName(current)) || positionKey(clicked.offset(...offset)) !== target) return false;
  const slab = name.endsWith('_slab') && current.name === name && current.getProperties?.().type;
  if (slab === 'bottom' && (data.direction === 1 || data.direction >= 2 && data.cursorY > 0.5)
    || slab === 'top' && (data.direction === 0 || data.direction >= 2 && data.cursorY <= 0.5)) return false;
  return true;
}

/** Enforce body exclusivity even if a stale reflex bypasses the action helpers. */
function installSurveyActions(bot, plan, grant) {
  if (scopes.has(bot)) throw new Error('A survey already owns the bot');
  const client = bot._client;
  if (typeof client?.write !== 'function') throw new Error('Survey construction needs a live game connection');
  const byPosition = new Map();
  const phases = [];
  for (const op of [...plan.ops].sort((a, b) => a.order - b.order)) {
    const key = positionKey(op.pos);
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(op);
    if (phases.at(-1)?.[0].phase !== op.phase) phases.push([]);
    phases.at(-1).push(op);
  }
  const authorizedDoors = new Map(plan.ops.filter((op) => /^minecraft:(?!iron_)[a-z_]+_door\[/.test(op.target))
    .map((op) => [positionKey(op.pos), op.target]));
  const scope = { bot, plan, grant, byPosition, phases, phaseIndex: 0, pending: new Set(plan.ops), attempted: new Map(), authorizedDoors,
    step: null, dig: null, use: null };
  const originalWrite = client.write;
  function guardedWrite(packet, data) {
    if (packet === 'block_dig' && (data.status === 0 || data.status === 2)) {
      const reason = checkStep(scope, scope.dig, data.location, true);
      if (reason) {
        if (scope.dig) scope.dig.denial = reason;
        return undefined;
      }
      if (data.status === 0) rememberAttempt(scope, scope.dig);
      if (scope.dig.face !== null) {
        // Native forceLook='ignore' still defaults to the top face. Retain
        // our validated hit face for both the start and finish packets.
        bot.targetDigFace = scope.dig.face;
        data = { ...data, face: scope.dig.face };
      }
    } else if (packet === 'block_place' || packet === 'use_item') {
      const permit = scope.use;
      if (!permit || permit.sent || permit.signal?.aborted || grant.signal.aborted || data.hand === 1) return undefined;
      if (permit.step) {
        const reason = checkStep(scope, permit.step, permit.pos, false);
        if (reason) { permit.denial = reason; return undefined; }
        if (bot.heldItem?.components?.some((component) => CUSTOM_COMPONENTS.has(component.type))) {
          permit.denial = 'survey_custom_item_data';
          return undefined;
        }
        if (packet === 'block_place') {
          if (!safeHit(bot, permit, data)) return undefined;
        } else if (permit.reference || bot.heldItem?.name !== 'water_bucket' || permit.step.ops[0].target !== 'minecraft:water[level=0]') {
          return undefined;
        }
        rememberAttempt(scope, permit.step);
      } else if (packet !== 'block_place' || positionKey(data.location) !== positionKey(permit.pos) || !permit.stillSafe()) {
        return undefined;
      }
      permit.sent = true;
    }
    return originalWrite.call(this, packet, data);
  }
  scopes.set(bot, scope);
  client.write = guardedWrite;
  return () => {
    if (scopes.get(bot) !== scope) return;
    scopes.delete(bot);
    if (client.write === guardedWrite) client.write = originalWrite;
  };
}

async function withSurveyStep(bot, ctx, ops, run) {
  const scope = scopes.get(bot);
  if (!scope || scope.step || scope.grant.signal.aborted || ctx.signal?.aborted || !ops.length) return fail('survey_unauthorized');
  acknowledge(scope);
  const phase = scope.phases[scope.phaseIndex]?.[0].phase;
  const keys = ops.map((op) => positionKey(op.pos));
  if (keys.length !== new Set(keys).size || ops.some((op, i) => op.phase !== phase || scope.byPosition.get(keys[i])?.[0] !== op)) {
    return fail('survey_wrong_operation');
  }
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, scope.grant.signal]) : scope.grant.signal;
  const step = { ops: [...ops], signal };
  scope.step = step;
  try {
    return await run({ ...ctx, signal, [STEP]: step });
  } finally {
    scope.step = null;
  }
}

function surveyDigPermit(bot, ctx, pos) {
  const scope = scopes.get(bot);
  if (!scope) return ctx[STEP] ? { reason: 'survey_unauthorized' } : null;
  const step = ctx[STEP];
  const reason = checkStep(scope, step, pos, true);
  return reason ? { reason } : { start(face) {
    step.denial = null;
    const index = face && faceOffsets.findIndex(([x, y, z]) => x === face.x && y === face.y && z === face.z);
    step.face = Number.isInteger(index) && index >= 0 ? index : null;
    scope.dig = step;
  },
    end() { if (scope.dig === step) scope.dig = null; return step.denial; } };
}

function surveyPlace(bot, ctx, { pos, reference = null, run }) {
  const scope = scopes.get(bot);
  const step = ctx[STEP];
  const reason = checkStep(scope, step, pos, false);
  if (reason) return fail(reason);
  if (scope.use) return fail('survey_interaction_busy');
  const permit = { step, signal: ctx.signal, pos, reference, sent: false, denial: null };
  scope.use = permit;
  try {
    // The actual packet must be sent before run returns. Catch a rejected
    // native _genericPlace Promise without giving it a later packet permit.
    Promise.resolve(run()).catch(() => {});
    return permit.sent ? { ok: true } : fail(permit.denial || 'survey_place_unsent');
  } finally { scope.use = null; }
}

function reach(bot, pos) {
  const entity = bot.entity;
  return entity?.position?.offset(0, entity.eyeHeight ?? 1.62, 0).distanceTo(asVec(pos).offset(0.5, 0.5, 0.5)) <= 4.5;
}

async function interact(bot, ctx, pos, stillSafe) {
  const scope = scopes.get(bot);
  if (!scope || scope.use || scope.grant.signal.aborted || ctx.signal?.aborted || !reach(bot, pos) || !stillSafe()) return false;
  const permit = { signal: ctx.signal, pos, stillSafe, sent: false };
  scope.use = permit;
  try {
    await bot.activateBlock(bot.blockAt(asVec(pos)));
    return permit.sent;
  } finally { scope.use = null; }
}

async function openSurveyChest(bot, ctx, block) {
  const scope = scopes.get(bot);
  const pos = block?.position;
  if (!pos || !scope?.plan.supplyChest || positionKey(pos) !== positionKey(scope.plan.supplyChest) || bot.currentWindow) return null;
  const stillSafe = () => CHESTS.has(bot.blockAt(pos)?.name) && !bot.controlState?.sneak;
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, scope.grant.signal, AbortSignal.timeout(4000), ...(ctx.signal ? [ctx.signal] : [])]);
  const opened = once(bot, 'windowOpen', { signal });
  opened.catch(() => {});
  try {
    if (!await interact(bot, { ...ctx, signal }, pos, stillSafe)) return null;
    const [window] = await opened;
    return window;
  } catch (error) {
    if (ctx.signal?.aborted || scope.grant.signal.aborted) throw abortError(ctx.signal?.aborted ? ctx.signal : scope.grant.signal);
    if (!signal.aborted) throw error;
    return null;
  } finally { stop.abort(); }
}

async function setSurveyDoor(bot, ctx, block, open) {
  const scope = scopes.get(bot);
  const pos = block?.position;
  if (!scope || !pos || scope.grant.signal.aborted || ctx.signal?.aborted) return fail('survey_unauthorized_door');
  const target = scope.authorizedDoors.get(positionKey(pos));
  const templateDoor = scope.plan.template?.door;
  const alreadyBuiltDoor = scope.plan.revision > 1 && templateDoor && pos.x === templateDoor.x && pos.z === templateDoor.z
    && (pos.y === templateDoor.y || pos.y === templateDoor.y + 1);
  if (!target && !alreadyBuiltDoor) return fail('survey_unauthorized_door');
  if (bot.heldItem) await bot.unequip('hand');
  const stillSafe = () => {
    const actual = bot.blockAt(pos);
    const properties = actual?.getProperties?.();
    if (!/^(?!iron_)[a-z_]+_door$/.test(actual?.name ?? '') || properties?.open !== !open || bot.heldItem || bot.controlState?.sneak
      || target && !matchesTarget(actual, target) || !['lower', 'upper'].includes(properties.half)) return false;
    const pair = pos.offset(0, properties.half === 'lower' ? 1 : -1, 0);
    const pairTarget = scope.authorizedDoors.get(positionKey(pair));
    const opposite = bot.blockAt(pair);
    const otherProps = opposite?.getProperties?.();
    return opposite?.name === actual.name && otherProps && otherProps.half !== properties.half
      && ['open', 'facing', 'hinge', 'powered'].every((key) => otherProps[key] === properties[key])
      && (pairTarget ? matchesTarget(opposite, pairTarget) : alreadyBuiltDoor);
  };
  if (!await interact(bot, ctx, pos, stillSafe)) return fail('survey_door_unsent');
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, scope.grant.signal]) : scope.grant.signal;
  return await waitUntil(() => bot.blockAt(pos)?.getProperties?.().open === open, { timeoutMs: 750, signal })
    ? { ok: true } : fail('survey_door_unconfirmed');
}

const openSurveyDoor = (bot, ctx, block) => setSurveyDoor(bot, ctx, block, true);
const closeSurveyDoor = (bot, ctx, block) => setSurveyDoor(bot, ctx, block, false);

module.exports = { installSurveyActions, withSurveyStep, surveyDigPermit, surveyPlace,
  openSurveyChest, openSurveyDoor, closeSurveyDoor, isSurveyNight };
