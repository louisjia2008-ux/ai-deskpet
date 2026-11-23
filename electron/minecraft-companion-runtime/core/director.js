'use strict';
// Reassess autonomous cards between steps while the selected card owns the goal.

const { stepTarget } = require('./planner');
const { createAdaptation } = require('./adaptation');
const { complete, failure, isComplete } = require('./action-result');
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

function chooseNext(state, memory, cards, { stage = 0, cooldowns = new Map(), now = Date.now(),
  inputs = schedulingInputs(state, { home: memory.homestead?.memory?.house?.interiorCenter }), ledger,
  targets = new Map(), definitions = new Map(), current = null } = {}) {
  const scores = [];
  const hazards = ledger?.snapshot().filter(entry => entry.purpose === 'target_hazard' && entry.dimension === state.dimension)
    .map(entry => entry.position) ?? [];
  const stock = { ...state.inventory };
  for (const contents of Object.values(memory.autonomyStock || {})) {
    for (const [item, count] of Object.entries(contents)) stock[item] = (stock[item] || 0) + count;
  }
  let best = null;
  for (const card of cards) {
    const entry = { id: card.id, score: 0 };
    scores.push(entry);
    if (card.stage > stage) { entry.skipped = 'stage'; continue; }
    const cooldown = cooldowns.get(card.id);
    if (cooldown && cooldown.until > now) { entry.skipped = 'cooldown'; entry.until = cooldown.until; continue; }
    try {
      if (card.requires && !card.requires(state, memory)) { entry.skipped = 'requires'; continue; }
      const goal = definitions.get(card.id);
      const estimated = card.work?.(state, memory, stock);
      const reported = goal?.work?.(state, stock);
      const active = current?.id === card.id ? current : null;
      const work = { ...estimated, ...reported, position: active?.position ?? reported?.position ?? estimated?.position,
        readiness: Math.max(estimated?.readiness ?? 0, reported?.readiness ?? 0), progress: reported?.progress ?? active?.progress };
      Object.assign(entry, cardValue(card, memory, inputs, now, work, ledger, hazards, targets.get(card.id), active ? now - active.progressAt : 0));
      if (entry.score === 0) entry.skipped = 'no_value';
    } catch (error) {
      entry.skipped = `error:${error?.message || error}`;
      continue;
    }
    if (entry.score > 0 && (!best || entry.score > best.score)) best = { card, score: entry.score };
  }
  return { card: best?.card || null, scores };
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
  const cooldowns = new Map(); // card id -> { count, until }
  const definitions = new Map(), targets = new Map();
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
      cooldowns.delete(id);
      return;
    }
    if (type === 'goal_yielded') {
      if (event.reason === 'card_value_changed') return;
      cooldowns.set(id, { count: event.reason === 'adaptation_exhausted' ? 1 : 0, until: event.until });
      return;
    }
    if (type !== 'goal_failed') return;
    if (event.result?.wait || ['start', 'interrupted'].includes(event.result?.kind)
      || event.result?.reason === 'home_site_relocated' || event.reasons?.includes('home_site_relocated')) return;
    const count = (cooldowns.get(id)?.count || 0) + 1;
    const delay = Math.min(maxCooldownMs, failureCooldownMs * 2 ** (count - 1));
    cooldowns.set(id, { count, until: now() + delay });
    emit('autonomy_cooldown', { card: id, count, until: now() + delay, reasons: event.reasons });
  }

  function evaluate(state, at, pool = cards) {
    const stage = stageOf(state, memory), maxStage = scope(memory), excluded = [];
    const available = pool.filter(card => {
      const until = memory.stagePauses?.[card.budgetStage ?? card.stage];
      if (card.stage > maxStage && !card.safeReturn) excluded.push({ id: card.id, skipped: 'range' });
      else if (card.expedition && !card.safeReturn && until > at) excluded.push({ id: card.id, skipped: 'stage_paused', until });
      else return true;
      return false;
    });
    const inputs = schedule(state);
    const { card, scores } = chooseNext(state, memory, available, { stage, cooldowns, now: at, inputs,
      ledger: adaptation?.failureLedger, targets, definitions, current: own });
    return { card, scores: [...scores, ...excluded], stage, inputs };
  }

  function reconsider(current, state, at, boundary) {
    if (own !== current || !state || state.alive === false) return null;
    const { card, scores, stage, inputs } = evaluate(state, at);
    const value = current.value = scores.find(score => score.id === current.id)?.score || 0;
    const challenger = card?.id !== current.id && card && scores.find(score => score.id === card.id);
    const stalled = at - current.progressAt >= STOP_MS;
    const sheltered = inputs.dark && state.sheltered;
    const change = !sheltered && boundary && challenger && challenger.score > value * SWITCH_RATIO;
    const reason = stalled ? 'card_stalled' : change ? 'card_value_changed' : sheltered ? 'sheltered'
      : !boundary && challenger && challenger.score > value * SWITCH_RATIO ? 'awaiting_step_boundary'
      : challenger ? 'switch_margin' : 'highest_value';
    if (stalled || change || at >= current.nextScoreAt) {
      current.nextScoreAt = at + RESCORE_MS;
      emit('autonomy_choice', { card: current.id, goal: current.goal, stage, scores,
        reason, reassessment: true, retained: !stalled && !change, challenger: challenger?.id });
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
      planning: () => ({ ledger, dimension: perceive()?.dimension }),
      stepOutcome(step, result, record) {
        clearFailures(card, result);
        if (!ledger || !result || result.wait || ['start', 'interrupted'].includes(result.kind)
          || result.facts?.target || result.facts?.adaptation || result.facts?.terminal) return result;
        const target = stepTarget(step, perceive()?.dimension);
        targets.set(card, target);
        if (streak && (streak.entity !== target.entity || streak.dimension !== target.dimension) && !ledger.skip(streak)) {
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
        if (isComplete(result) && result.progress !== false && !result.facts?.transit) {
          current.progressAt = at;
          current.progress += 1;
        }
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
            const state = perceive();
            if (state && nightBudget(state).dark && state.sheltered) return null;
          }
          waits += 1;
          waitMs += Math.max(0, elapsedMs);
          if (result.wait.until > at || waits >= waitLimit || waitMs >= waitBudgetMs) {
            return { card, reason: result.wait.reason, waits, waitMs, until: Math.max(at + yieldCooldownMs, result.wait.until || 0) };
          }
          return reconsider(current, perceive(), at, true);
        }
        waits = 0;
        return reconsider(current, perceive(), at, true);
      },
    };
  }

  return {
    /** Feed every brain event here. */
    handleEvent(event) {
      if (own && ['autonomy_milestone', 'site_chosen', 'home_part_restored', 'depot_built'].includes(event?.type)) {
        own.progressAt = now();
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
      const status = brain.status(), active = status.goal;
      if (active) {
        idleSince = null;
        if (own?.reserveUntil != null && now() >= own.reserveUntil) {
          void brain.clearGoal('reserve_work_ended').catch((error) =>
            emit('autonomy_error', { reason: String(error?.message || error) }));
        } else if (own && own.generation === active.generation && now() >= own.nextScoreAt) {
          const current = own;
          const result = reconsider(current, perceive(), now(), status.running !== `goal:${current.goal}`);
          if (result && own === current) {
            cooldowns.set(current.id, { count: 0, until: result.until });
            void brain.clearGoal(result.reason).catch(error => emit('autonomy_error', { reason: String(error) }));
          }
        }
        return null;
      }
      // A player goal can also end without an event (stop, clear).
      if (playerActive) { playerActive = false; pausedUntil = now() + resumeDelayMs; }
      own = null;
      if (now() < pausedUntil) return null;
      if (idleSince === null) idleSince = now();
      if (now() - idleSince < idleMs) return null;
      const state = perceive();
      if (!state || state.alive === false) return null;
      const at = now();
      const { stage, scores, card: initial, inputs } = evaluate(state, at);
      const retryAt = Math.min(...scores.filter((score) => score.until > at).map((score) => score.until));
      let card = initial;
      let reserveUntil = null;
      if (Number.isFinite(retryAt) && (!card || reserveCards.includes(card))) {
        if (state.isDay === true && !inputs.dusk) {
          const reserve = evaluate(state, at, reserveCards);
          card = reserve.card || card;
          scores.push(...reserve.scores.filter(score => !scores.some(other => other.id === score.id)));
        } else card = null;
        if (card) reserveUntil = Math.min(retryAt, at + RESERVE_WORK_MS);
      }
      if (!card) {
        idleSince = now();
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
      emit('autonomy_choice', { card: card.id, goal: goal.name, stage, scores, reason: 'highest_value', retained: false,
        ...(reserveUntil === null ? {} : { reserveUntil, retryAt }) });
      const current = { id: card.id, goal: goal.name, expedition: card.expedition, stage: card.budgetStage ?? card.stage,
        cardStage: card.stage, safeReturn: card.safeReturn, reserveUntil, progressAt: at, nextScoreAt: at + RESCORE_MS,
        progress: 0, value: scores.find(score => score.id === card.id)?.score || 0 };
      current.generation = brain.setGoal(goal, { autonomy: governor(current, goal) });
      own = current;
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
    noteDeath(cause, { at = now(), dimension = null, position = null, stage = own?.stage, card = own?.id } = {}) {
      const cutoff = at - 24 * 60 * 60_000;
      const deaths = (memory.routeDeaths || []).filter((death) => death.at >= cutoff);
      const latest = deaths.at(-1);
      if (latest?.at === at) {
        if (cause && cause !== latest.cause) {
          latest.cause = cause;
          emit('autonomy_death_cause', { deathAt: at, cause, card: latest.card });
        }
        return false;
      }
      const definition = cards.find((c) => c.id === card);
      const expedition = Boolean(definition?.expedition && !definition.safeReturn);
      const death = { at, cause: cause || null, dimension, position, stage: stage ?? null, card: card ?? null, expedition };
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
        cooldowns: [...cooldowns].filter(([, c]) => c.until > now()).map(([id, c]) => ({ id, count: c.count, until: c.until })),
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
