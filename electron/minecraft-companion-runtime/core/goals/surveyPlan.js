'use strict';

const actions = require('../actions');
const { sleep, waitUntil, abortError } = require('../confirm');
const { matchesExpect, matchesTarget, stateName } = require('../survey-plan-rules');
const { vec, placementSpec, hitFor, stationChoices, walkToStations, aimAndPlace,
  closePlanDoor, climbSurveyScaffold } = require('../survey-placement');
const { createSurveySupplies, materialFor } = require('../survey-supplies');

const MATERIAL_POLL_MS = 30000;
const PLACE_ATTEMPTS = 3;
const APPLIED_TIMEOUT_MS = 1300;
const DOUBLE_PLANTS = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony']);

function stepGroups(plan) {
  const ordered = [...plan.ops].sort((a, b) => a.order - b.order);
  const byPosition = new Map();
  for (const op of ordered) {
    const key = vec(op.pos).toString();
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(op);
  }

  const consumed = new Set();
  const groups = [];
  for (const op of ordered) {
    if (consumed.has(op)) continue;
    const spec = placementSpec(op.target);
    const door = spec.id.endsWith('_door');
    const bed = spec.id.endsWith('_bed');
    let primary = op;
    let secondary;
    if (door || bed) {
      const pos = vec(op.pos);
      const direction = door ? vec({ x: 0, y: 1, z: 0 }) : ({
        north: vec({ x: 0, y: 0, z: -1 }), south: vec({ x: 0, y: 0, z: 1 }),
        east: vec({ x: 1, y: 0, z: 0 }), west: vec({ x: -1, y: 0, z: 0 }),
      })[spec.facing];
      const first = door ? spec.half === 'lower' : spec.part === 'foot';
      const partner = direction && byPosition.get(pos.plus(direction.scaled(first ? 1 : -1)).toString())
        ?.find((other) => other.phase === op.phase && other.target === op.target.replace(
          door ? (first ? 'half=lower' : 'half=upper') : (first ? 'part=foot' : 'part=head'),
          door ? (first ? 'half=upper' : 'half=lower') : (first ? 'part=head' : 'part=foot')));
      if (!partner) throw Object.assign(new Error('missing_companion_cell'), { pos: op.pos });
      primary = first ? op : partner;
      secondary = first ? partner : op;
    }
    const step = secondary ? [primary, secondary] : [primary];
    for (const entry of step) consumed.add(entry);
    const phase = op.phase;
    const terrain = phase === 'terrain' ? (op.target === 'minecraft:air' ? 'cut' : 'fill') : phase;
    let level = 0;
    if (terrain === 'cut' || phase === 'remove_scaffold') level = -op.pos.y;
    if (terrain === 'fill' || ['walls', 'scaffold', 'floor', 'upper_walls'].includes(phase)) level = op.pos.y;
    const active = groups.at(-1);
    if (!active || active.key !== terrain) groups.push({ key: terrain, phase, steps: [] });
    groups.at(-1).steps.push({ step, level });
  }
  for (const group of groups) group.steps.sort((a, b) => a.level - b.level);
  return groups;
}

function createSurveyPlanGoal({ bot, plan, grant, ownerName, supplyInventory }) {
  let completed = 0;
  let stationFailures = 0;
  let phase = '';
  let groups;
  let groupIndex = 0;
  let workGroup = null;
  let followup = null;
  let interruptedAction = null;
  let waitingFor = null;
  let awaitingRevoke = false;
  const attempted = new Map();
  const accounted = new Set();
  const supplies = createSurveySupplies(bot, plan, supplyInventory);
  const night = () => actions.isSurveyNight(bot);

  function wrongSite(step) {
    return step.find((op) => {
      const block = bot.blockAt(vec(op.pos));
      return block && !matchesExpect(bot, op, block);
    });
  }

  function siteDetail(op) {
    return `expected ${op.expect}, actual ${stateName(bot.blockAt(vec(op.pos))) || 'unloaded'}`;
  }

  function matchesAppliedTarget(op) {
    const actual = bot.blockAt(vec(op.pos));
    if (matchesTarget(actual, op.target)) return true;
    // The Mod acknowledged the exact write. While the bot was defending, a
    // later vanilla tick can grow the crop, hydrate the soil or spread grass.
    if (op.target === 'minecraft:farmland[moisture=0]') return actual?.name === 'farmland';
    if (op.target === 'minecraft:wheat[age=0]') return actual?.name === 'wheat';
    return op.target === 'minecraft:dirt' && actual?.name === 'grass_block' &&
      ((op.kind === 'fill' && op.pos.y < plan.groundY) ||
        (plan.template?.id === 'wheat_field' && op.phase === 'foundation'));
  }

  async function overnight(ctx) {
    if (!night()) return;
    grant.state(phase, 'night');
    const position = bot.entity.position.floored();
    const covered = [2, 3, 4].some((y) => bot.blockAt(position.offset(0, y, 0))?.shapes.length);
    const owner = bot.players?.[ownerName]?.entity?.position;
    const siteX = (plan.selection.minX + plan.selection.maxX + 1) / 2;
    const siteZ = (plan.selection.minZ + plan.selection.maxZ + 1) / 2;
    if (!covered && owner && Math.hypot(owner.x - siteX, owner.z - siteZ) <= 12
      && bot.entity.position.distanceTo(owner) < 18) {
      await actions.goNear(bot, ctx, owner, 3, { timeoutMs: 4500, retryNoProgress: false });
    }
    while (night()) await sleep(350, ctx.signal);
    grant.state(phase, waitingFor?.reason || null, waitingFor?.missing);
  }

  async function duringDay(ctx, run) {
    for (;;) {
      await overnight(ctx);
      const daylight = new AbortController();
      const stopAtNight = () => { if (night()) daylight.abort('night'); };
      bot.on('time', stopAtNight);
      try {
        const signal = AbortSignal.any([ctx.signal, daylight.signal]);
        const result = await run({ ...ctx, signal });
        if (ctx.signal.aborted) throw abortError(ctx.signal);
        if (!daylight.signal.aborted) return result;
      } catch (error) {
        if (ctx.signal.aborted || !daylight.signal.aborted || error.code !== 'aborted') throw error;
      } finally {
        bot.removeListener('time', stopAtNight);
      }
    }
  }

  async function afterAction(ctx, step, before, rejection, timeoutMs = APPLIED_TIMEOUT_MS) {
    const primary = step[0];
    const result = () => {
      const applied = grant.applied(primary.pos);
      if (applied && applied !== before && step.every((op) => grant.applied(op.pos) === applied &&
        matchesAppliedTarget(op))) return 'applied';
      const rejected = grant.misplacement(primary.pos);
      if (rejected && rejected !== rejection) return 'misplacement';
      return null;
    };
    if (!await waitUntil(result, { timeoutMs, intervalMs: 35, signal: ctx.signal })) return null;
    return result();
  }

  async function observeMutation(ctx, step, run) {
    const pos = step[0].pos;
    const before = grant.applied(pos);
    const rejection = grant.misplacement(pos);
    try {
      return await run(before, rejection);
    } finally {
      if (ctx.signal.aborted && !grant.signal.aborted) {
        interruptedAction = { step, before, rejection, deadline: Date.now() + APPLIED_TIMEOUT_MS };
      }
    }
  }

  async function reconcileInterruptedAction(ctx) {
    if (!interruptedAction) return;
    const { step, before, rejection, deadline } = interruptedAction;
    // A use or finish-dig that was already on the wire can be accepted while
    // survival owns the body. Observe that transaction before attempting it again.
    const result = await afterAction(ctx, step, before, rejection, Math.max(0, deadline - Date.now()));
    const info = attempted.get(step[0]);
    if (result === 'misplacement' && info) recordMisplacement(ctx, step[0], info);
    interruptedAction = null;
  }

  function recordStation(ctx, op, reason, detail) {
    stationFailures++;
    ctx.record?.('survey_station_failed', { pos: op.pos, phase, reason, stationFailures, detail });
  }

  function recordMisplacement(ctx, op, info) {
    info.rejection = grant.misplacement(op.pos);
    ctx.record?.('survey_misplacement', { pos: op.pos, attempt: info.sent,
      expected: info.rejection.expected, actual: info.rejection.actual });
  }

  async function placeAtStation(ctx, step, firstHit) {
    const op = step[0];
    const info = attempted.get(op) || { hits: new Set(), sent: 0, rejection: grant.misplacement(op.pos) };
    attempted.set(op, info);
    const already = grant.applied(op.pos);
    if (already && step.every((entry) => grant.applied(entry.pos) === already &&
      matchesAppliedTarget(entry))) return { ok: true };
    let hit = firstHit;
    while (info.sent < PLACE_ATTEMPTS) {
      if (!hit || info.hits.has(hit.key)) {
        const usable = () => hitFor(bot, step, bot.entity.position, info.hits);
        hit = usable() || await walkToStations(bot, ctx, plan, stationChoices(bot, step, info.hits), usable,
          (reason, detail) => recordStation(ctx, op, reason, detail));
      }
      if (!hit) return { ok: false, reason: 'placement_station_unreachable' };
      const changed = wrongSite(step);
      if (changed) return { ok: false, reason: 'site_changed', pos: changed.pos, detail: siteDetail(changed) };
      const item = supplies.item(op);
      const { dispatched, result } = await observeMutation(ctx, step, async (before, rejection) => {
        const dispatched = await actions.withSurveyStep(bot, ctx, step,
          (stepCtx) => aimAndPlace(bot, stepCtx, vec(op.pos), hit, item));
        if (!dispatched.ok) return { dispatched };
        info.hits.add(hit.key);
        info.sent++;
        return { dispatched, result: await afterAction(ctx, step, before, rejection) };
      });
      if (!dispatched.ok) {
        if (dispatched.reason !== 'placement_face_changed') return dispatched;
        info.hits.add(hit.key);
        hit = null;
        continue;
      }
      if (result === 'applied') return { ok: true };
      if (result === 'misplacement') recordMisplacement(ctx, op, info);
      hit = null;
    }
    const rejected = info.rejection;
    return {
      ok: false, reason: rejected ? 'misplacement_retries_exhausted' : 'placement_unconfirmed',
      detail: rejected ? `expected ${rejected.expected}, actual ${rejected.actual}` : undefined,
    };
  }

  async function executeAtStation(ctx, step, hit) {
    const op = step[0];
    if (op.target !== 'minecraft:air') return placeAtStation(ctx, step, hit);
    return observeMutation(ctx, step, async (before, rejection) => {
      const dug = await actions.withSurveyStep(bot, ctx, step,
        (stepCtx) => actions.digBlock(bot, stepCtx, hit.block, { point: hit.point, face: hit.face }));
      if (await afterAction(ctx, step, before, rejection) !== 'applied') {
        return { ok: false, reason: dug.ok ? 'dig_unconfirmed' : dug.reason };
      }
      return { ok: true };
    });
  }

  function confirmedStep(entries) {
    const available = entries.filter((entry) => entry.level === entries[0].level);
    for (const { step } of available) {
      const applied = grant.applied(step[0].pos);
      if (!applied || accounted.has(applied)) continue;
      const appliedStep = applied.positions.map((pos) =>
        entries.flatMap((entry) => entry.step).find((op) => vec(op.pos).equals(vec(pos))));
      if (appliedStep.every((op) => op && grant.applied(op.pos) === applied && matchesAppliedTarget(op))) {
        return appliedStep;
      }
    }
    return null;
  }

  async function nextStep(ctx, entries) {
    await reconcileInterruptedAction(ctx);
    const applied = confirmedStep(entries);
    if (applied) return { ok: true, step: applied };
    const available = entries.filter((entry) => entry.level === entries[0].level);
    const work = [];
    for (const entry of available) {
      const op = entry.step[0];
      const pos = vec(op.pos);
      const block = bot.blockAt(pos);
      let step = entry.step;
      if (op.target === 'minecraft:air' && DOUBLE_PLANTS.has(block?.name)) {
        const upper = block.getProperties().half === 'upper';
        const neighbor = pos.offset(0, upper ? -1 : 1, 0);
        const pair = entries.find(({ step }) => step[0].target === 'minecraft:air' && vec(step[0].pos).equals(neighbor))?.step[0];
        const other = bot.blockAt(neighbor);
        if (!pair || other?.name !== block.name || other.getProperties().half === block.getProperties().half) {
          return { ok: false, reason: 'site_changed', pos: op.pos, detail: 'both halves of the plant must be authorized for removal' };
        }
        step = [op, pair];
      }
      const changed = wrongSite(step);
      if (changed) return { ok: false, pos: changed.pos, reason: 'site_changed', detail: siteDetail(changed) };
      work.push({ step, hit: () => hitFor(bot, step, bot.entity.position, attempted.get(op)?.hits || new Set()) });
    }
    let chosen = work.find((entry) => entry.hit());
    let hit = chosen?.hit();
    if (!chosen) {
      const stations = new Map();
      for (const { step } of work) {
        for (const cell of stationChoices(bot, step, attempted.get(step[0])?.hits || new Set())) stations.set(cell.toString(), cell);
        if (stations.size >= 36) break;
      }
      hit = await walkToStations(bot, ctx, plan, [...stations.values()], () => {
        chosen = work.find((entry) => entry.hit());
        return chosen?.hit();
      }, (reason, detail) => recordStation(ctx, work[0].step[0], reason, detail));
    }
    if (!chosen || !hit) {
      recordStation(ctx, work[0].step[0], 'no_reachable_station');
      return { ok: false, pos: work[0].step[0].pos, reason: 'no_reachable_station' };
    }
    const result = await executeAtStation(ctx, chosen.step, hit);
    return { ...result, step: chosen.step, pos: result.pos || chosen.step[0].pos };
  }

  async function hold(ctx) {
    while (!ctx.signal.aborted) await sleep(1000, ctx.signal);
    throw abortError(ctx.signal);
  }

  async function block(ctx, { reason, pos, detail }) {
    if (ctx.signal.aborted) throw abortError(ctx.signal);
    awaitingRevoke = true;
    ctx.record?.('survey_blocked', { phase, reason, pos, detail, completed, stationFailures });
    grant.blocked(reason, pos, detail);
    return hold(ctx);
  }

  function waitForRetry(ctx, reason, missing) {
    waitingFor ??= { reason, missing, deadline: Date.now() + MATERIAL_POLL_MS };
    return duringDay(ctx, async (stepCtx) => {
      grant.state(phase, waitingFor.reason, waitingFor.missing);
      await sleep(Math.max(0, waitingFor.deadline - Date.now()), stepCtx.signal);
      waitingFor = null;
      grant.state(phase, null);
    });
  }

  function checkpointStep(pending, step) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].step.every((op) => step.includes(op))) pending.splice(i, 1);
    }
    const op = step[0];
    accounted.add(grant.applied(op.pos));
    completed += step.length;
    grant.progress(completed);
    if (op.target === 'minecraft:air' || placementSpec(op.target).id.endsWith('_door')) followup = op;
  }

  async function finishFollowup(ctx) {
    if (!followup) return;
    const op = followup;
    await duringDay(ctx, (stepCtx) => op.target === 'minecraft:air' ? supplies.collect(stepCtx, op)
      : actions.openSurveyDoor(bot, stepCtx, bot.blockAt(vec(op.pos))));
    followup = null;
  }

  return {
    name: 'survey_plan',
    isDone: () => grant.result?.status === 'completed',
    progress: () => completed,
    async run(runCtx) {
      const ctx = { ...runCtx, signal: AbortSignal.any([runCtx.signal, grant.signal].filter(Boolean)) };
      try {
        if (awaitingRevoke) return hold(ctx);
        groups ??= stepGroups(plan);
        while (groupIndex < groups.length) {
          const group = groups[groupIndex];
          if (!workGroup) {
            phase = group.phase;
            workGroup = { pending: [...group.steps], prepared: false, restock: true, scaffoldApproachChecked: false };
            grant.state(phase, null);
          }
          const { pending } = workGroup;
          if (!workGroup.prepared) {
            const first = vec(pending[0].step[0].pos);
            if (!bot.blockAt(first)) {
              const travel = await duringDay(ctx, (stepCtx) => actions.goNear(bot, stepCtx, first, 4, { timeoutMs: 30000 }));
              if (!travel.ok) return block(ctx, { reason: 'worksite_unreachable', pos: first, detail: travel.reason });
            }
            // Load the upper floors from the ground while a safe route to the
            // chest is available. Shortages are handled at their own phase.
            if (plan.template?.id === 'two_storey_house' && phase === 'scaffold') {
              const later = groups.slice(groupIndex).flatMap((entry) => entry.steps.map(({ step }) => step));
              const loaded = await duringDay(ctx, (stepCtx) => supplies.ensure(stepCtx, later, 256));
              if (!loaded.ok) return block(ctx, loaded);
            }
            workGroup.prepared = true;
          }
          if (waitingFor) await waitForRetry(ctx, waitingFor.reason, waitingFor.missing);
          await finishFollowup(ctx);
          await reconcileInterruptedAction(ctx);
          while (pending.length) {
            const applied = confirmedStep(pending);
            if (applied) {
              checkpointStep(pending, applied);
              await finishFollowup(ctx);
              continue;
            }
            const currentLayer = pending.filter((entry) => entry.level === pending[0].level);
            const eligible = currentLayer.filter(({ step }) => !materialFor(step[0]) || supplies.item(step[0]));
            if (workGroup.restock || !eligible.length) {
              const materials = await duringDay(ctx, (stepCtx) => supplies.ensure(stepCtx, pending.map(({ step }) => step)));
              if (!materials.ok) return block(ctx, materials);
              if (Object.keys(materials.missing || {}).length) {
                await waitForRetry(ctx, 'materials', materials.missing);
                continue;
              }
              workGroup.restock = false;
            }
            const materialReady = currentLayer.filter(({ step }) => !materialFor(step[0]) || supplies.item(step[0]));
            if (!materialReady.length) continue;
            const highWall = plan.template?.id === 'two_storey_house' && phase === 'walls' &&
              currentLayer[0].level >= plan.groundY + 2;
            const deck = phase === 'floor' && currentLayer[0].level >= plan.groundY + 3;
            if ((phase === 'roof' || phase === 'upper_walls' || highWall || deck) && !workGroup.scaffoldApproachChecked) {
              await duringDay(ctx, (stepCtx) => climbSurveyScaffold(bot, stepCtx, plan,
                (reason, detail) => recordStation(ctx, pending[0].step[0], reason, detail),
                highWall || deck ? currentLayer[0].level : Infinity));
              workGroup.scaffoldApproachChecked = true;
            }
            // Removal can consume the second half of a plant on the layer below.
            const work = materialReady[0].step[0].target === 'minecraft:air' ? pending : materialReady;
            const result = await duringDay(ctx, (stepCtx) => nextStep(stepCtx, work));
            if (result.reason === 'no_material') {
              workGroup.restock = true;
              continue;
            }
            if (!result.ok) return block(ctx, result);
            checkpointStep(pending, result.step);
            await finishFollowup(ctx);
          }
          groupIndex++;
          workGroup = null;
        }
        if (waitingFor) await waitForRetry(ctx, waitingFor.reason, waitingFor.missing);
        for (;;) {
          const returned = await duringDay(ctx, (stepCtx) => supplies.putBack(stepCtx));
          if (returned.ok) break;
          if (returned.reason !== 'chest_full') return block(ctx, returned);
          await waitForRetry(ctx, 'chest_full');
        }
        const door = await duringDay(ctx, (stepCtx) =>
          closePlanDoor(bot, stepCtx, plan, (reason) => recordStation(ctx, { pos: plan.template.door }, reason)));
        if (!door.ok) return block(ctx, door);
        grant.state(phase, null);
        ctx.record?.('survey_settled', { completed, stationFailures });
        grant.settled();
        awaitingRevoke = true;
        return hold(ctx);
      } catch (error) {
        if (ctx.signal.aborted) throw abortError(ctx.signal);
        return block(ctx, { reason: 'construction_error', pos: error.pos, detail: error.message });
      }
    },
  };
}

module.exports = { createSurveyPlanGoal };
