'use strict';
// Each tick reads the world and chooses one behavior to own the body.
// Interrupted goals resume by reading the changed inventory and blocks.

const { complete, failure, createAttempt, resultFrom } = require('./action-result');
const { interruptedWork } = require('./work-target');
const { DANGER, DEFAULT_TASK_VALUE, maintenanceUrgency, schedulingInputs } = require('./scheduling');
const { createScheduleBackoff } = require('./schedule-backoff');
const isDefinition = (def, methods) => typeof def?.name === 'string' && methods.every(key => typeof def[key] === 'function');
const BAND = Object.freeze({ IDLE: 0, GOAL: 50, MAINTENANCE: 100, DEFENSE: 120, ESCAPE: 130 });

function createBrain({
  perceive,
  behaviors = [],
  opportunity,
  schedule = schedulingInputs,
  taskAllowed = () => true,
  permanentEnabled = () => true,
  now = Date.now,
  backoff = createScheduleBackoff(now),
  onEvent = () => {},
  noProgressLimit = 6,
  failureCooldownMs = 2000,
  maxCooldownMs = 30000,
  goalRetryDelayMs = 250,
  abandonMs = 20000,
} = {}) {
  if (typeof perceive !== 'function') throw new TypeError('perceive is required');
  if (!Number.isFinite(abandonMs) || abandonMs <= 0 || abandonMs > 2147483647) throw new TypeError('abandonMs must be a positive timer duration');
  for (const behavior of behaviors) {
    if (!isDefinition(behavior, ['want', 'run']) || !Number.isFinite(behavior.band)) {
      throw new TypeError('Behavior needs name, band, want(state) and run(ctx)');
    }
  }
  const permanent = [...behaviors];
  let goal = null; // unique generation: { def, generation, taskId, best, stalls, reasons }
  let generation = 0;
  let paused = false;
  let running = null; // { behavior, controller, promise }
  let deferredTick = null; // a tick put off a turn after a behavior that settled at once
  let deciding = false;
  let disposed = false;
  let disposal = null;

  function assertActive() {
    if (disposed) throw Object.assign(new Error('Brain is disposed'), { code: 'disposed' });
  }

  function retirementError(entry) {
    return Object.assign(new Error('Aborted behavior has not settled; body ownership remains blocked'), {
      code: 'retirement_timeout', retryable: false,
      pending: [{ behavior: entry.behavior.name, ...correlation(entry.behavior.goalEntry) }],
    });
  }

  function assertBodyAvailable() {
    assertActive();
    if (running?.abandoned) throw retirementError(running);
  }

  const correlation = (entry) => entry
    ? { generation: entry.generation, ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }) }
    : {};

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };

  function goalBehavior() {
    if (!goal || paused || disposed) return null;
    const entry = goal;
    const def = entry.def;
    return {
      name: `goal:${def.name}`,
      band: BAND.GOAL,
      want: (state) => (taskAllowed(state, def) && !isGoalDone(entry, state) ? 1 : 0),
      run: (ctx) => def.run(ctx),
      isGoal: true,
      goalEntry: entry,
      def,
    };
  }

  function wantOf(behavior, state) {
    try { return Number(behavior.want(state)) || 0; } catch (error) {
      emit('want_error', { behavior: behavior.name, reason: describe(error), ...correlation(behavior.goalEntry) });
      return 0;
    }
  }

  const goalEvent = (type, entry, data = {}) => emit(type, { goal: entry?.def.name || null, ...data, ...correlation(entry) });

  function choose(state) {
    const def = goal?.def;
    let task;
    if (def) {
      try { task = def.work?.(state); } catch { /* Progress estimates are optional. */ }
      task = { ...task, returning: task?.returning || def.name === 'return_and_store' };
    }
    const inputs = schedule(state, { task });
    let best = null;
    for (const behavior of [...permanent.filter(permanentEnabled), goalBehavior()]) {
      if (!behavior || backoff.blocked(`body:${behavior.name}`) > now()) continue;
      const want = wantOf(behavior, state);
      if (want <= 0) continue;
      const choice = rating(behavior, want, inputs);
      if (choice.value > 0 && outranks(choice, best)) best = choice;
    }
    return { best, inputs };
  }

  function rating(behavior, want, inputs) {
    const { state } = inputs;
    if (behavior.band >= BAND.DEFENSE || behavior.band === BAND.IDLE) return { behavior, tier: behavior.band, value: want, want };
    if (behavior.name === 'eat' && state.food <= DANGER.food) return { behavior, tier: BAND.DEFENSE, value: want, want };
    const value = behavior.band === BAND.GOAL
      ? (behavior.goalEntry?.autonomy?.value?.() ?? DEFAULT_TASK_VALUE)
      : maintenanceUrgency(behavior.name, want, inputs);
    return { behavior, tier: BAND.GOAL, value, want };
  }

  function outranks(candidate, other) {
    return !other || candidate.tier > other.tier || candidate.tier === other.tier && candidate.value > other.value;
  }

  function failGoalEvaluation(entry, state, error, phase) {
    if (!entry || goal !== entry || disposed) return;
    finishGoal('goal_failed', entry, () => ({ progress: state ? safeProgress(entry.def, state) : null,
      reasons: [`goal_${phase}_error: ${describe(error)}`] }));
  }

  function finishGoal(type, entry, data) {
    goal = null;
    goalEvent(type, entry, typeof data === 'function' ? data() : data);
  }

  function isGoalDone(entry, state) {
    try {
      const result = entry.def.isDone(state);
      if (result && typeof result.then === 'function') {
        // Selection is synchronous. Reject an async predicate rather than
        // treating its Promise as truthy, and consume a possible rejection.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('Goal isDone must be synchronous');
      }
      return Boolean(result);
    } catch (error) {
      failGoalEvaluation(entry, state, error, 'evaluation');
      return true; // a failed definition is no longer eligible to run
    }
  }

  async function settleGoal(entry, state, result, preempted) {
    // Definition identity is not enough: callers may submit the same definition
    // again. Only the invocation which owns this generation may settle it.
    if (!entry || goal !== entry || paused || disposed) return;
    if (isGoalDone(entry, state)) {
      if (goal === entry && !disposed) finishGoal('goal_done', entry, () => ({ progress: safeProgress(entry.def, state) }));
      return;
    }
    // Being interrupted by survival is not a lack of progress, and neither is
    // waiting out the night: a wait neither spends nor refills the budget.
    if (preempted || result.kind === 'interrupted') return;
    const yielded = entry.autonomy?.outcome(result, now() - entry.startedAt);
    if (yielded) return finishGoal('goal_yielded', entry, { ...yielded, result });
    if (result.wait || result.kind === 'start') return;
    const progress = safeProgress(entry.def, state);
    // The goal knows it cannot go on here (nothing to build with in reach of
    // the site): end it now and say why, rather than burn the stall budget.
    if (result.facts?.terminal) return finishGoal('goal_failed', entry, { progress, reasons: [result.reason], result });
    if (progress > entry.best) {
      entry.best = progress;
      entry.stalls = 0;
      return;
    }
    // A concrete action, planning source, or the goal's adaptation ladder
    // already owns this failed attempt. Use the stall budget for runs that
    // reported success without advancing, and for ordinary non-autonomous goals.
    if (entry.autonomy && !result.ok && (result.facts.target || result.facts.adaptation || entry.autonomy.managesFailures)) return;
    entry.stalls += 1;
    if (!result.ok) entry.reasons.push(result.reason);
    if (entry.stalls >= (entry.def.noProgressLimit ?? noProgressLimit)) {
      const reasons = entry.reasons.slice(-entry.stalls);
      // A long goal may know a reset worth more rounds before giving up.
      if (typeof entry.def.recover === 'function' && entry.recoveries < (entry.def.maxRecoveries ?? 0)) {
        entry.recoveries += 1;
        entry.stalls = 0;
        goalEvent('goal_recovering', entry, { progress, attempt: entry.recoveries, reasons });
        if (goal === entry && !disposed) {
          try { await entry.def.recover(); } catch (error) {
            failGoalEvaluation(entry, state, error, 'recovery');
          }
        }
        return;
      }
      finishGoal('goal_failed', entry, { progress, reasons, result });
    }
  }

  function start({ behavior, want, tier, value }) {
    const controller = new AbortController();
    const entry = { behavior, controller, want, tier, preempted: false };
    const isCurrent = () => !disposed && (!behavior.isGoal || behavior.goalEntry === goal);
    const ctx = createAttempt({
      signal: controller.signal,
      bodySignal: controller.signal,
      perceive,
      record: (type, data) => {
        if (running === entry && !controller.signal.aborted && isCurrent()) {
          emit(type, { attemptId: ctx.attemptId, ...data, behavior: behavior.name, ...correlation(behavior.goalEntry) });
        }
      },
      ...correlation(behavior.goalEntry),
      behavior: behavior.name,
    }, safePerceive());
    entry.attemptId = ctx.attemptId;
    const autonomous = behavior.goalEntry?.autonomy;
    if (autonomous) {
      behavior.goalEntry.startedAt = now();
      ctx.adapt = autonomous.adapt?.(() => running === entry && isCurrent() && !controller.signal.aborted);
      ctx.planning = autonomous.planning?.();
      ctx.stepOutcome = (step, result) => {
        if (isCurrent() && !controller.signal.aborted) return autonomous.stepOutcome(step, result, ctx.record);
      };
    }
    const failed = error => {
      if (error?.code === 'result_reason_unmapped') ctx.record('result_reason_unmapped', { reason: error.reason });
      return failure(controller.signal.aborted || error?.code === 'aborted' ? 'aborted' : 'behavior_error',
        { error: error?.message || describe(error) }, ctx, safePerceive());
    };
    entry.promise = Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted || !isCurrent()) return failure('aborted', {}, ctx);
        const early = autonomous?.before && await autonomous.before(ctx);
        if (controller.signal.aborted || !isCurrent()) return failure('aborted', {}, ctx);
        if (!early && (autonomous || behavior.def?.name === 'homestead')) await opportunity?.(ctx, behavior.def.name);
        if (controller.signal.aborted || !isCurrent()) return failure('aborted', {}, ctx);
        const raw = early || await behavior.run(ctx);
        return resultFrom(raw, ctx, safePerceive());
      })
      .catch(failed)
      .then(async (result) => {
        try {
          if (controller.signal.aborted) result = failure('aborted', {}, ctx);
          if (isCurrent()) {
            backoff.observe(behavior.name, result, behavior.isGoal
              ? { base: goalRetryDelayMs, cap: 3000, stalls: goal?.stalls || 0, emit, cancelled: controller.signal.aborted }
              : { base: failureCooldownMs, cap: maxCooldownMs, emit, cancelled: controller.signal.aborted });
            if (behavior.isGoal) await settleGoal(behavior.goalEntry, safePerceive(), result, entry.preempted);
            // A terminal observer may synchronously submit another goal. Do not
            // let this finished callback perturb that goal's recovery tracking.
            if (!disposed && (!behavior.isGoal || !goal || goal === behavior.goalEntry)) {
              emit('behavior_finished', { behavior: behavior.name, ok: result.ok, reason: result.reason, result, attemptId: ctx.attemptId,
                ...correlation(behavior.goalEntry) });
            }
          }
          return result;
        } catch (error) {
          if (behavior.isGoal) failGoalEvaluation(behavior.goalEntry, safePerceive(), error, 'settle');
          else emit('behavior_error', { behavior: behavior.name, reason: describe(error) });
          return failed(error);
        } finally {
          // Even an evaluator/recovery failure must release the body. Otherwise
          // a rejected settlement leaves running pinned forever.
          if (running === entry) running = null;
          if (entry.abandoned) emit('behavior_unblocked', { behavior: behavior.name, ...correlation(behavior.goalEntry) });
          // Yield to packets and stdin after each attempt, even if it settled synchronously.
          if (!disposed) {
            deferredTick = new Promise((resolve) => setImmediate(() => {
              deferredTick = null;
              tick().catch(() => {}).then(resolve);
            }));
          }
        }
      });
    running = entry;
    emit('behavior_started', { behavior: behavior.name, band: tier, urgency: value, attemptId: ctx.attemptId, ...correlation(behavior.goalEntry) });
  }

  async function preempt(reason, entry = running, required = false) {
    if (!entry || running !== entry) return true;
    entry.preempted = true;
    entry.controller.abort(reason);
    // The timed-out promise still holds the body until it really settles.
    let timer;
    const settled = await Promise.race([entry.promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), abandonMs); })]);
    clearTimeout(timer);
    if (!settled && running === entry) {
      if (!entry.abandoned) {
        entry.abandoned = true;
        emit('behavior_abandoned', { behavior: entry.behavior.name, reason: String(reason),
          code: 'retirement_timeout', blocked: true, ...correlation(entry.behavior.goalEntry) });
      }
      if (required) throw retirementError(entry);
    }
    return settled;
  }

  function detachGoal() {
    const entry = goal;
    goal = null;
    paused = false;
    return entry;
  }

  function safePerceive() {
    try { return perceive(); } catch { return null; }
  }

  async function tick() {
    if (deciding || disposed || running?.abandoned) return;
    deciding = true;
    try {
      const state = safePerceive();
      if (!state || state.alive === false) {
        if (running) await preempt('unavailable');
        return;
      }
      const idleGoal = goal;
      if (idleGoal && !paused && !running && isGoalDone(idleGoal, state)) {
        await settleGoal(idleGoal, state, complete(false), false);
      }
      let { best, inputs } = choose(state);
      if (running) {
        const current = running.behavior;
        // A goal replaced by another one of the same name is no longer wanted.
        const stillWanted = current.isGoal ? !paused && goal === current.goalEntry : permanentEnabled(current);
        if (!stillWanted) {
          await preempt('goal_cleared');
        } else if ((current.isGoal && !taskAllowed(state, current.def)) || best && best.behavior.name !== current.name
            && (best.tier > running.tier || best.tier === BAND.GOAL && !best.behavior.isGoal
              && outranks(best, rating(current, running.want, inputs)))) {
          const by = best?.behavior.name ?? 'task_unavailable';
          emit('preempted', { behavior: current.name, by, attemptId: running.attemptId, ...correlation(current.goalEntry) });
          interruptedWork(running.controller.signal, by);
          await preempt(`preempted_by:${by}`);
        } else {
          return;
        }
        if (!running && !disposed) best = choose(safePerceive() || state).best;
      }
      // Re-choose after any preemption: the world may have changed while waiting.
      const next = running || disposed ? null : best;
      if (next) start(next);
    } finally {
      deciding = false;
    }
  }

  return {
    tick,
    setGoal(def, metadata = {}) {
      assertBodyAvailable();
      if (!isDefinition(def, ['isDone', 'progress', 'run'])) {
        throw new TypeError('Goal needs name, isDone(state), progress(state) and run(ctx)');
      }
      const state = safePerceive();
      const taskId = metadata?.taskId ?? def.metadata?.taskId ?? def.taskId;
      const nextGeneration = ++generation;
      goal = { def, generation: nextGeneration, taskId, autonomy: metadata?.autonomy, best: state ? safeProgress(def, state) : -Infinity,
        stalls: 0, recoveries: 0, reasons: [] };
      paused = false;
      backoff.clear(`body:goal:${def.name}`);
      goalEvent('goal_set', goal);
      // A chore running when the task arrives keeps the body only while it
      // still wants it under the new goal. Asked to follow and guard the
      // owner, the bot first finished a 55-block chase after a sheep, and the
      // owner was killed alone. Fights and escapes are never cut short here.
      const chore = running && !running.behavior.isGoal && running.behavior.band <= BAND.MAINTENANCE ? running : null;
      if (chore && state && wantOf(chore.behavior, state) <= 0) void preempt('goal_set', chore).catch(() => {});
      return nextGeneration;
    },
    async clearGoal(reason = 'cleared') {
      assertActive();
      const active = running, entry = detachGoal();
      // Publish before awaiting abort so an observer never receives an old
      // uncorrelated terminal event after a replacement was installed.
      if (entry) goalEvent('goal_cleared', entry, { reason });
      if (active?.behavior.isGoal) await preempt(reason, active, true);
    },
    /** Ends the goal as failed from outside (a death loop, say). */
    async failGoal(reason = 'failed') {
      assertActive();
      const active = running, entry = detachGoal();
      if (!entry) return;
      const state = safePerceive();
      goalEvent('goal_failed', entry, { progress: state ? safeProgress(entry.def, state) : null, reasons: [reason] });
      if (active?.behavior.isGoal) await preempt(reason, active, true);
    },
    /** Suspend goal work only. Permanent safety behaviors still own the body. */
    async pauseGoal(reason = 'paused') {
      assertActive();
      const active = running;
      if (!paused) {
        paused = true;
        goalEvent('goal_paused', goal, { reason });
      }
      if (active?.behavior.isGoal) await preempt(reason, active, true);
    },
    async resumeGoal() {
      assertBodyAvailable();
      if (!paused) return;
      paused = false;
      goalEvent('goal_resumed', goal);
      await tick();
    },
    /** Aborts whatever runs now but keeps the goal; the next tick re-plans. */
    async interrupt(reason = 'interrupted') {
      assertActive();
      const active = running;
      emit('interrupted', { reason, behavior: active?.behavior.name || null, ...correlation(active?.behavior.goalEntry) });
      await preempt(reason, active, true);
    },
    /** Legacy task stop: clears goals, but subsequent ticks keep safety active. */
    async stop(reason = 'stopped') {
      assertActive();
      const active = running, entry = detachGoal();
      emit('stopped', { reason, ...correlation(entry) });
      await preempt(reason, active, true);
    },
    /** Terminal all-stop. No future tick or goal can restart this brain. */
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      detachGoal();
      const operation = preempt('disposed', running, true);
      disposal = operation;
      // A caller may retry shutdown after the non-cooperative run finally settles.
      operation.catch(() => { if (disposal === operation) disposal = null; });
      return operation;
    },
    status() {
      const state = safePerceive();
      return {
        running: running?.behavior.name || null,
        paused,
        disposed,
        blocked: Boolean(running?.abandoned),
        inFlight: running ? [{ behavior: running.behavior.name, aborted: running.controller.signal.aborted,
          abandoned: Boolean(running.abandoned), ...correlation(running.behavior.goalEntry) }] : [],
        goal: goal ? { name: goal.def.name, progress: state ? safeProgress(goal.def, state) : null,
          stalls: goal.stalls, ...correlation(goal) } : null,
        cooldowns: backoff.state('body:').map(({ name, until }) => ({ name, until })),
      };
    },
    /** Join only one goal generation, never an unrelated safety behavior. */
    idleGoal: (goalGeneration) => Promise.all(goalGeneration !== undefined && running?.behavior.goalEntry?.generation === goalGeneration
      ? [running.promise] : []),
    /** Resolves once the currently running behavior (if any) has settled. */
    idle: () => running ? Promise.all([running.promise]) : deferredTick ?? Promise.resolve(),
  };
}

function describe(error) {
  return String(error?.code || error?.message || error || 'error');
}

function safeProgress(def, state) {
  try {
    const value = Number(def.progress(state));
    return Number.isFinite(value) ? value : -Infinity;
  } catch {
    return -Infinity;
  }
}

module.exports = { createBrain, BAND };
