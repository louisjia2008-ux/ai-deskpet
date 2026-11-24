'use strict';
// Reassess autonomous cards between steps while the selected card owns the goal.

const { stepTarget, startTarget } = require('./planner');
const { createScheduleBackoff } = require('./schedule-backoff');
const { createAdaptation } = require('./adaptation');
const { complete, failure, isComplete, isRescueBehavior, factsOf } = require('./action-result');
const { schedulingInputs, travelTicks, nightBudget } = require('./scheduling');

const RISKS = new Set(['low', 'medium', 'high']);
const MINUTE = 60_000;
const RESERVE_WORK_MS = 45_000;

const RESCORE_MS = MINUTE;
const STALE_MS = 10 * MINUTE;
const STOP_MS = 14 * MINUTE;
// Small fluctuations in readiness or movement should not cancel a step sequence.
const SWITCH_RATIO = 1.18;
const UNLOCKS = {
  homestead: ['iron_tools', 'return_home', 'cobble_generator'],
  iron_tools: ['wheat_farm'],
  wheat_farm: ['home_lighting', 'guest_bed', 'harvest_wheat'],
  guest_bed: ['iron_armor'],
  home_lighting: ['iron_armor'],
  iron_armor: ['diamond_tools'],
  diamond_tools: ['home_roof_wood', 'nether_supplies', 'nether_fortress'],
  cobble_generator: ['auto_smelter'],
  nether_supplies: ['nether_fortress'],
  nether_fortress: ['ender_pearls'],
  ender_pearls: ['end_supplies'],
  end_supplies: ['stronghold'],
  stronghold: ['dragon_return'],
  dragon_return: ['diamond_armor'],
};

function downstream(id) {
  const cards = new Set(UNLOCKS[id] || []);
  for (const card of cards) for (const next of UNLOCKS[card] || []) cards.add(next);
  return cards.size;
}

function workStock(state, memory) {
  const stock = { ...state.inventory };
  for (const contents of Object.values(memory.autonomyStock || {})) {
    for (const [item, count] of Object.entries(contents)) stock[item] = (stock[item] || 0) + count;
  }
  return stock;
}

function readWork(card, goal, state, memory, stock) {
  return goal?.work?.(state, stock) ?? card.work?.(state, memory, stock);
}

const proofFields = current => ({ remaining: current.work?.remaining ?? null,
  readiness: current.work?.readiness ?? null, sinceProgressMs: current.sinceProgressMs });

function cardValue(card, memory, { state, home, returnTicks, ticksToDark, dark }, at, work, ledger, hazards, target, staleMs) {
  const position = work?.position ?? (card.local ? home : state.position);
  const travel = point => point && position ? travelTicks(point, position) : 0;
  const route = position === home && Number.isFinite(returnTicks) ? returnTicks : travel(state.position);
  const fromHome = travel(home);
  const remaining = work?.remaining ?? 4;
  const readiness = work?.readiness ?? Number(work?.ready ?? 0.5);
  const blocked = (target && ledger?.skip(target)) || (position && ledger?.regionHard(position, state.dimension));
  const nearby = p => p && position && travelTicks(p, position) <= 160;
  const hazard = position && (ledger?.regionHard(position, state.dimension, 'mine_danger') || hazards.some(nearby));
  const death = memory.routeDeaths?.some(entry => entry.at > at - STALE_MS && entry.dimension === state.dimension && nearby(entry.position));
  const weak = state.health < 12 || state.food < 8;
  const base = card.safeReturn ? 84 : Math.round(28 + 10 * Math.log2(1 + downstream(card.id)));
  const parts = {
    base, readiness: Math.round(10 * readiness), blocked: blocked ? -24 : 0,
    travel: -Math.min(26, Math.floor((route + fromHome) / 140)),
    daylight: card.safeReturn || !Number.isFinite(ticksToDark) ? 0
      : -Math.min(16, Math.ceil(Math.max(0, route + 120 * remaining - ticksToDark) / 100)),
    risk: -(Number(hazard || death || state.inWater || Boolean(home && position && position.y < home.y - 8)) * 14
      + Number(card.risk !== 'low' && (weak || dark)) * 14),
    progress: Math.min(8, Math.max(0, work?.progress ?? 0)),
    stale: staleMs >= STALE_MS ? -Math.min(80, 16 + Math.floor((staleMs - STALE_MS) / 3_000)) : 0,
  };
  const demand = card.demand?.(state, memory) ?? (card.need ? card.need(state, memory) / 100 : 1);
  return { ...parts, demand, remaining, score: Math.max(0, Math.round(demand * Object.values(parts).reduce((a, b) => a + b, 0))) };
}

function chooseNext(state, memory, cards, { stage = 0, maxStage = Infinity, reserveCards = [], cooldowns = new Map(), now = Date.now(),
  inputs = schedulingInputs(state, { home: memory.homestead?.memory?.house?.interiorCenter }), ledger,
  targets = new Map(), definitions = new Map(), current = null } = {}) {
  const entries = new Map();
  const hazards = ledger?.snapshot().filter(entry => entry.purpose === 'target_hazard' && entry.dimension === state.dimension)
    .map(entry => entry.position) ?? [];
  const stock = workStock(state, memory);
  for (const card of new Set([...cards, ...reserveCards])) {
    const entry = { id: card.id, score: 0 };
    entries.set(card, entry);
    const pause = memory.stagePauses?.[card.budgetStage ?? card.stage];
    if (!card.safeReturn && card.stage > maxStage) { entry.skipped = 'range'; continue; }
    if (!card.safeReturn && card.expedition && pause > now) { entry.skipped = 'stage_paused'; entry.until = pause; continue; }
    if (card.stage > stage) { entry.skipped = 'stage'; continue; }
    const cooldown = cooldowns.get(card.id);
    if (cooldown && cooldown.until > now) { entry.skipped = 'cooldown'; entry.until = cooldown.until; continue; }
    try {
      if (card.requires && !card.requires(state, memory)) { entry.skipped = 'requires'; continue; }
      const active = current?.id === card.id ? current : null;
      const work = { ...(active ? active.work : readWork(card, definitions.get(card.id), state, memory, stock)),
        progress: active?.progress };
      work.position = active?.position ?? work.position;
      Object.assign(entry, cardValue(card, memory, inputs, now, work, ledger, hazards, targets.get(card.id), active ? now - active.progressAt : 0));
      if (entry.score === 0) entry.skipped = 'no_value';
    } catch (error) {
      entry.skipped = `error:${error?.message || error}`;
    }
  }
  const score = card => entries.get(card)?.score || 0;
  const best = pool => pool.reduce((leader, card) => score(card) > score(leader) ? card : leader, null);
  return { card: best(cards), reserve: best(reserveCards), scores: cards.map(card => entries.get(card)),
    reserveScores: reserveCards.filter(card => !cards.includes(card)).map(card => entries.get(card)) };
}

function createDirector({
  brain,
  perceive,
  cards = [],
  reserveCards = [],
  stageOf = () => 0,
  schedule = (state) => schedulingInputs(state, { home: memory.homestead?.memory?.house?.interiorCenter }),
  scope = () => Infinity,
  memory = {},
  now = Date.now,
  backoff = createScheduleBackoff(now),
  onEvent = () => {},
  idleMs = 3000,
  resumeDelayMs = 30000,
  failureCooldownMs = MINUTE,
  maxCooldownMs = 5 * MINUTE,
  waitLimit = 8,
  waitBudgetMs = MINUTE,
  yieldCooldownMs = 30_000,
  onOverworldDeath = () => {},
  onIdle = () => {},
  adaptation = createAdaptation({ now, onEvent }),
} = {}) {
  if (!brain || typeof perceive !== 'function') throw new TypeError('brain and perceive are required');
  for (const card of [...cards, ...reserveCards]) validateCard(card);
  const cooldowns = { get: id => ({ until: backoff.blocked(`card:${id}`) }) };
  const definitions = new Map(), targets = new Map(), starts = new Map();
  let enabled = false;
  let own = null; // { id, goal }: the goal the director handed the brain
  let playerActive = false;
  let pausedUntil = 0;
  let idleSince = null;
  let lastIdle = null;

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };
  const adapt = adaptation?.scope(() => true);
  const generic = card => adapt?.plan('goal', { target: card });
  function clearFailures(card, result) {
    const p = isComplete(result) && result.progress !== false && generic(card);
    if (p?.failures) adapt.outcome(p, result);
  }

  function settle(type, event) {
    const { id, expedition } = own;
    own = null;
    if (expedition) memory.homePending = true;
    if (type === 'goal_done') {
      clearFailures(id, complete());
      adaptation?.progress();
      if (id === 'wheat_farm') {
        memory.wheatFarmDone = true;
        memory.wheatPlots = memory.wheatFarm?.memory.plots;
      }
      backoff.clear(`card:${id}`);
      return;
    }
    if (type === 'goal_yielded') {
      if (event.reason !== 'card_value_changed' && event.until > now()) {
        backoff.defer(`card:${id}`, event.until, Number(event.reason === 'adaptation_exhausted'));
      }
      return;
    }
    if (type !== 'goal_failed') return;
    if (event.result?.wait || ['start', 'interrupted'].includes(event.result?.kind)
      || event.result?.reason === 'home_site_relocated' || event.reasons?.includes('home_site_relocated')) return;
    const { count, until } = backoff.fail(`card:${id}`, failureCooldownMs, maxCooldownMs);
    emit('autonomy_cooldown', { card: id, count, until, reasons: event.reasons });
  }

  function evaluate(state, at, includeReserve = false) {
    const stage = stageOf(state, memory), inputs = schedule(state);
    const choice = chooseNext(state, memory, cards, { stage, maxStage: scope(memory), cooldowns, now: at, inputs,
      reserveCards: includeReserve ? reserveCards : [],
      ledger: adaptation?.failureLedger, targets, definitions, current: own });
    return { ...choice, stage, inputs };
  }

  function refreshWork(current, state, at, result) {
    if (!state || own !== current) return;
    const { card, definition } = current;
    try { current.work = readWork(card, definition, state, memory, workStock(state, memory)); }
    catch { current.work = null; } // A perception gap cannot prove progress.
    const { remaining, readiness } = current.work || {};
    const smaller = Number.isFinite(remaining) && current.bestRemaining != null && remaining < current.bestRemaining;
    const readier = Number.isFinite(readiness) && current.bestReadiness != null && readiness + 1e-9 >= current.bestReadiness + 0.05;
    if (Number.isFinite(remaining) && (current.bestRemaining == null || smaller)) current.bestRemaining = remaining;
    if (Number.isFinite(readiness) && (current.bestReadiness == null || readier)) current.bestReadiness = readiness;
    const legacy = !card.work && !definition.work && isComplete(result) && result.progress !== false && !factsOf(result).transit;
    if (smaller || readier || legacy) markProgress(current, at);
  }

  function markProgress(current, at) {
    current.progressAt = at;
    current.progress++;
  }

  function reconsider(current, state, at, boundary) {
    if (own !== current || !state || state.alive === false) return null;
    const { card, scores, stage, inputs } = evaluate(state, at);
    const value = current.value = scores.find(score => score.id === current.id)?.score || 0;
    const challenger = card?.id !== current.id && card && scores.find(score => score.id === card.id);
    current.sinceProgressMs = at - current.progressAt;
    const stalled = current.sinceProgressMs >= STOP_MS;
    const sheltered = inputs.dark && state.sheltered;
    const higher = challenger && challenger.score > value * SWITCH_RATIO;
    const change = !sheltered && boundary && higher;
    const reason = stalled ? 'card_stalled' : change ? 'card_value_changed' : sheltered ? 'sheltered'
      : higher ? 'awaiting_step_boundary'
      : challenger ? 'switch_margin' : 'highest_value';
    if (stalled || change || at >= current.nextScoreAt) {
      current.nextScoreAt = at + RESCORE_MS;
      emit('autonomy_choice', { card: current.id, goal: current.goal, stage, scores,
        reason, reassessment: true, retained: !stalled && !change, challenger: challenger?.id, ...proofFields(current) });
    }
    return stalled ? { card: current.id, reason, until: at + MINUTE }
      : change ? { card: current.id, reason, until: at } : null;
  }

  function governor(current, definition) {
    const card = current.id;
    let waits = 0, waitMs = 0, streak = null;
    const ledger = adaptation?.failureLedger;
    let recoveredRevision = null;
    return {
      adapt: adaptation && ((valid) => adaptation.scope(valid)),
      value: () => Math.max(1, current.value),
      managesFailures: Boolean(adaptation),
      async before(ctx) {
        const p = generic(card);
        if (!p) return null;
        if (p.method === 'recover' && recoveredRevision !== `${p.key}:${p.revision}`) {
          if (typeof definition.recover === 'function') {
            recoveredRevision = `${p.key}:${p.revision}`;
            ctx.record('adaptation_use', { task: 'goal', method: 'recover', card });
            await definition.recover();
            return null;
          }
          return ctx.adapt.outcome(p, failure('no_recovery_available', {}, ctx));
        }
        if (p.method === 'other_work') {
          ctx.record('adaptation_use', { task: 'goal', method: p.method, card });
          return ctx.adapt.outcome(p, failure('goal_methods_exhausted', {}, ctx));
        }
        if (p.method === 'do_other_work') return adaptation.defer(p);
        return null;
      },
      planning: () => ({ ledger, card, dimension: perceive()?.dimension }),
      stepOutcome(step, result, record) {
        clearFailures(card, result);
        if (!ledger || !result || result.wait || result.kind === 'interrupted' || result.facts?.rescue
          || isRescueBehavior(result.reason)) return result;
        const dimension = perceive()?.dimension;
        const retry = startTarget(step, { card, dimension });
        const key = `${retry.dimension}|${retry.entity}`;
        let target = stepTarget(step, dimension);
        if (result.kind === 'start') {
          const at = now();
          for (const [id, times] of starts) if (times.at(-1) <= at - 10 * MINUTE) starts.delete(id);
          const times = [...(starts.get(key) || []).filter(time => time > at - 10 * MINUTE), at];
          if (times.length < 8) { starts.set(key, times); return result; }
          target = retry;
          result = { ...result, kind: 'target', facts: { ...result.facts, startAttempts: times.length } };
        } else if (result.facts?.target || result.facts?.adaptation || result.facts?.terminal) {
          starts.delete(key);
          return result;
        }
        starts.delete(key);
        if (factsOf(result).transit) return result;
        targets.set(card, target);
        if (streak && (streak.entity !== target.entity || streak.purpose !== target.purpose || streak.dimension !== target.dimension) && !ledger.skip(streak)) {
          ledger.clearOnSuccess(streak);
        }
        streak = target;
        if (isComplete(result)) { ledger.clearOnSuccess(target); return result; }
        const saved = ledger.record(result, target);
        if (!saved) return result;
        const { undo: _undo, ...evidence } = saved;
        if (evidence.excluded) record('step_blocked', { card, step: target.entity, count: evidence.failures,
          reason: result.reason, until: evidence.retryAt, result });
        return { ...result, facts: { ...result.facts, target: evidence } };
      },
      outcome(result, elapsedMs) {
        clearFailures(card, result); // Direct steps such as tilling bypass the planner.
        const at = now();
        const state = perceive();
        refreshWork(current, state, at, result);
        const p = result?.ok === false && !result.facts?.target && !result.facts?.adaptation && !result.facts?.terminal
          && !['start', 'interrupted', 'material'].includes(result.kind) ? generic(card) : null;
        const handled = p ? adapt.outcome(p, result) : result;
        const exhausted = handled?.facts?.adaptation?.exhausted;
        if (exhausted) {
          return { card, reason: 'adaptation_exhausted', task: exhausted.task, method: exhausted.method, key: exhausted.key,
            failure: exhausted.reason, until: Math.max(at + yieldCooldownMs, exhausted.retryAt) };
        }
        if (result?.wait) {
          if (card === 'homestead' && result.wait.reason === 'sheltering_until_daylight') {
            if (state && nightBudget(state).dark && state.sheltered) return null;
          }
          waits += 1;
          waitMs += Math.max(0, elapsedMs);
          if (result.wait.until > at || waits >= waitLimit || waitMs >= waitBudgetMs) {
            return { card, reason: result.wait.reason, waits, waitMs, until: Math.max(at + yieldCooldownMs, result.wait.until || 0) };
          }
        } else waits = 0;
        return reconsider(current, state, at, true);
      },
    };
  }

  return {
    /** Feed every brain event here. */
    handleEvent(event) {
      if (own && ['autonomy_milestone', 'site_chosen', 'home_part_restored', 'depot_built'].includes(event?.type)) {
        markProgress(own, now());
      }
      if (own && event?.generation === own.generation) {
        if (event.type === 'plan_step') own.position = null;
        if (['target_selected', 'mine_ore', 'mine_loot'].includes(event.type) && /^-?\d+,-?\d+,-?\d+$/.test(event.position)) {
          const [x, y, z] = event.position.split(',').map(Number);
          own.position = { x, y, z };
        }
      }
      if (!event || !['goal_done', 'goal_failed', 'goal_cleared', 'goal_yielded'].includes(event.type)) return;
      if (own && event.goal === own.goal && (own.generation === undefined || event.generation === own.generation)) {
        settle(event.type, event);
      } else if (playerActive) {
        // The player's task is over; give them a moment before taking over again.
        playerActive = false;
        pausedUntil = now() + resumeDelayMs;
      }
    },
    /** A player just set a goal: it replaces whatever the director chose. */
    notePlayerGoal() {
      own = null;
      playerActive = true;
      idleSince = null;
    },
    tick() {
      if (!enabled) return null;
      if (!playerActive) adaptation?.poll();
      const at = now();
      const status = brain.status(), active = status.goal;
      if (active) {
        idleSince = null;
        const current = own;
        if (!current || current.generation !== active.generation) return null;
        const result = current.reserveUntil != null && at >= current.reserveUntil ? { reason: 'reserve_work_ended' }
          : at >= current.nextScoreAt ? reconsider(current, perceive(), at, status.running !== `goal:${current.goal}`) : null;
        if (result && own === current) {
          if (result.until > at) backoff.defer(`card:${current.id}`, result.until, 0);
          void brain.clearGoal(result.reason).catch(error => emit('autonomy_error', { reason: String(error?.message || error) }));
        }
        return null;
      }
      // A player goal can also end without an event (stop, clear).
      if (playerActive) { playerActive = false; pausedUntil = at + resumeDelayMs; }
      own = null;
      if (at < pausedUntil) return null;
      idleSince ??= at;
      if (at - idleSince < idleMs) return null;
      const state = perceive();
      if (!state || state.alive === false) return null;
      const { stage, scores, card: initial, reserve, reserveScores, inputs } = evaluate(state, at, true);
      const retryAt = Math.min(...scores.filter((score) => score.until > at).map((score) => score.until));
      let card = initial;
      let reserveUntil = null;
      if (Number.isFinite(retryAt) && (!card || reserveCards.includes(card))) {
        card = state.isDay === true && !inputs.dusk ? reserve || card : null;
        if (state.isDay === true && !inputs.dusk) scores.push(...reserveScores);
        if (card) reserveUntil = Math.min(retryAt, at + RESERVE_WORK_MS);
      }
      if (!card) {
        idleSince = at;
        const until = Number.isFinite(retryAt) ? retryAt : null;
        const reason = until === null ? 'no_current_demand_or_prerequisites' : 'no_eligible_card_until_retry';
        onIdle(state, reason);
        const signature = JSON.stringify([stage, scores]);
        if (lastIdle !== signature) emit('autonomy_idle', { stage, reason, until, scores });
        lastIdle = signature;
        return null;
      }
      lastIdle = null;
      const goal = card.create(memory);
      definitions.set(card.id, goal);
      const current = { id: card.id, card, definition: goal, goal: goal.name, expedition: card.expedition,
        stage: card.budgetStage ?? card.stage, cardStage: card.stage, safeReturn: card.safeReturn, reserveUntil,
        progressAt: at, nextScoreAt: at + RESCORE_MS, sinceProgressMs: 0,
        progress: 0, value: scores.find(score => score.id === card.id)?.score || 0 };
      current.generation = brain.setGoal(goal, { autonomy: governor(current, goal) });
      own = current;
      refreshWork(current, state, at);
      emit('autonomy_choice', { card: card.id, goal: goal.name, stage, scores, reason: 'highest_value', retained: false,
        ...proofFields(current), ...(reserveUntil === null ? {} : { reserveUntil, retryAt }) });
      idleSince = null;
      return card.id;
    },
    enable() {
      if (enabled) return;
      enabled = true;
      idleSince = null;
      lastIdle = null;
      emit('autonomy_enabled');
    },
    async disable(reason = 'autonomy_off') {
      if (!enabled) return;
      enabled = false;
      const mine = own;
      if (mine?.expedition) memory.homePending = true;
      own = null;
      if (mine && brain.status().goal?.name === mine.goal) await brain.clearGoal(reason);
      emit('autonomy_disabled', { reason });
    },
    async setRange(range) {
      memory.range = range;
      if (own && !own.safeReturn && own.cardStage > scope(memory)) await brain.clearGoal('autonomy_range_changed');
    },
    ownsGoal: () => own !== null,
    isEnabled: () => enabled,
    noteDeath(cause, { at = now(), dimension = null, position = null, night = false, stage = own?.stage, card = own?.id } = {}) {
      const cutoff = at - 24 * 60 * 60_000;
      const deaths = (memory.routeDeaths || []).filter((death) => death.at >= cutoff);
      const latest = deaths.at(-1);
      if (latest?.at === at) {
        if (cause && cause !== latest.cause) {
          latest.cause = cause;
          emit('autonomy_death_cause', { deathAt: at, cause, card: latest.card });
          if (!latest.expedition && latest.dimension === 'overworld' && !playerActive) onOverworldDeath(latest, deaths, memory, true);
        }
        return false;
      }
      const definition = cards.find((c) => c.id === card);
      const expedition = Boolean(definition?.expedition && !definition.safeReturn);
      const death = { at, cause: cause || null, dimension, position, night, stage: stage ?? null, card: card ?? null, expedition };
      deaths.push(death);
      memory.routeDeaths = deaths.slice(-128);
      emit('autonomy_death', death);
      if (!expedition && dimension === 'overworld' && !playerActive) onOverworldDeath(death, deaths, memory);
      if (!expedition || deaths.filter((d) => d.stage === stage && cards.some((c) => c.id === d.card && c.expedition && !c.safeReturn)).length < 2) return false;
      const pauses = (memory.stagePauses ||= {});
      if (pauses[stage] > now()) return false;
      pauses[stage] = at + 2 * 60 * 60_000;
      emit('autonomy_stage_paused', { stage, until: pauses[stage] });
      return true;
    },
    status() {
      const state = enabled ? perceive() : null;
      return {
        stage: state ? stageOf(state, memory) : null,
        range: memory.range ?? 'nether',
        goal: own?.goal ?? null,
        milestones: { ...memory.milestones },
        deaths: (memory.routeDeaths || []).slice(-10),
        stagePauses: Object.entries(memory.stagePauses || {}).filter(([, until]) => until > now()).map(([stage, until]) => ({ stage: Number(stage), until })),
        enabled,
        current: own?.id || null,
        playerActive,
        pausedUntil: pausedUntil > now() ? pausedUntil : null,
        cooldowns: backoff.state('card:').map(({ name: id, count, until }) => ({ id, count, until })),
      };
    },
    memory,
  };
}

function validateCard(card) {
  if (!card || typeof card.id !== 'string' || !Number.isFinite(card.stage) || !RISKS.has(card.risk)
      || typeof card.create !== 'function'
      || (card.requires !== undefined && typeof card.requires !== 'function')) {
    throw new TypeError('Card needs id, stage, risk and create(memory)');
  }
  return card;
}

module.exports = { createDirector, chooseNext };
