'use strict';
// Chooses what the bot does next when no player has given it a task.
//
// The director never moves the body. Whenever the brain has had no goal for a
// moment it scores every registered card against the current world and hands
// the brain the most needed goal. A running goal normally finishes before the
// next choice, but bounded waits and repeated failures can yield the body.
// Nothing is remembered about "how far" a goal got; the next choice reads the
// world again, so deaths and player interruptions need no recovery.
//
// A card: { id, stage, risk: 'low'|'medium'|'high', requires?(state, memory),
//           need(state, memory) -> 0..100, create(memory) -> goal }

const RISKS = new Set(['low', 'medium', 'high']);
const MINUTE = 60_000;
const STEP_COOLDOWN = 10 * MINUTE;
const FAILURE_WINDOW = 30 * MINUTE;
const stepKey = (kind, item) => `${kind}/${item}`;

/** How far a card's need counts right now; risky work waits for daylight and a healthy body. */
function riskFactor(risk, state) {
  if (risk === 'low') return 1;
  const night = state.isDay === false;
  const weak = state.health < 12 || state.food < 8;
  if (risk === 'high') return night || weak ? 0 : 0.8;
  return night ? 0.4 : weak ? 0.6 : 1;
}

/**
 * Pure choice: the highest-scoring eligible card, plus every card's score
 * (and why it was left out) for the event log.
 */
function chooseNext(state, memory, cards, { stage = 0, cooldowns = new Map(), now = Date.now() } = {}) {
  const scores = [];
  let best = null;
  for (const card of cards) {
    const entry = { id: card.id, score: 0 };
    scores.push(entry);
    if (card.stage > stage) { entry.skipped = 'stage'; continue; }
    const cooldown = cooldowns.get(card.id);
    if (cooldown && cooldown.until > now) { entry.skipped = 'cooldown'; entry.until = cooldown.until; continue; }
    try {
      if (card.requires && !card.requires(state, memory)) { entry.skipped = 'requires'; continue; }
      const need = Math.max(0, Math.min(100, Number(card.need(state, memory)) || 0));
      entry.score = Math.round(need * riskFactor(card.risk, state));
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
  stageOf = () => 0,
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
  adaptation = null,
} = {}) {
  if (!brain || typeof perceive !== 'function') throw new TypeError('brain and perceive are required');
  for (const card of cards) validateCard(card);
  const cooldowns = new Map(); // card id -> { count, until }
  const blockedSteps = new Map();
  const failureWindows = new Map(); // card -> reason -> failure timestamps
  let enabled = false;
  let own = null; // { id, goal }: the goal the director handed the brain
  let playerActive = false;
  let pausedUntil = 0;
  let idleSince = null;
  let lastIdle = null;

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };

  function settle(type, event) {
    const { id, expedition } = own;
    own = null;
    if (expedition) memory.homePending = true;
    if (type === 'goal_done') {
      adaptation?.progress();
      if (id === 'wheat_farm') {
        memory.wheatFarmDone = true;
        memory.wheatPlots = memory.wheatFarm?.memory.plots;
      }
      cooldowns.delete(id);
      return;
    }
    if (type === 'goal_yielded') {
      cooldowns.set(id, { count: 0, until: event.until });
      return;
    }
    if (type !== 'goal_failed') return;
    const count = (cooldowns.get(id)?.count || 0) + 1;
    const delay = Math.min(maxCooldownMs, failureCooldownMs * 2 ** (count - 1));
    cooldowns.set(id, { count, until: now() + delay });
    emit('autonomy_cooldown', { card: id, count, until: now() + delay, reasons: event.reasons });
  }

  function governor(card, definition) {
    let waits = 0, waitMs = 0, streak = null, failures = 0;
    const byReason = failureWindows.get(card) || new Map();
    failureWindows.set(card, byReason);
    const generic = (state) => adaptation?.plan('goal', { position: state?.position, target: card });
    let recoveredRevision = null;
    return {
      adapt: adaptation && ((valid) => adaptation.scope(valid)),
      async before(ctx) {
        const p = generic(ctx.perceive());
        if (!p) return null;
        if (p.method === 'recover' && recoveredRevision !== `${p.key}:${p.revision}`) {
          if (typeof definition.recover === 'function') {
            recoveredRevision = `${p.key}:${p.revision}`;
            ctx.record('adaptation_use', { task: 'goal', method: 'recover', card });
            await definition.recover();
            return null;
          }
          adaptation.promote('goal', p, 'other_work', 'no_recovery_available');
          return adaptation.defer(generic(ctx.perceive()));
        }
        if (['other_work', 'do_other_work'].includes(p.method)) return adaptation.defer(p);
        return null;
      },
      stepBlocked(kind, item) {
        const key = stepKey(kind, item);
        const until = blockedSteps.get(key);
        if (until > now()) return until;
        if (until) blockedSteps.delete(key);
        return 0;
      },
      stepOutcome(step, result, record) {
        if (result?.waited || result?.reason === 'aborted') return;
        const key = stepKey(step.kind, step.key || step.station);
        if (key !== streak || result?.ok) { streak = key; failures = 0; }
        if (result?.ok !== false || ++failures < 3) return;
        const until = now() + STEP_COOLDOWN;
        blockedSteps.set(key, until);
        record('step_blocked', { card, step: key, count: failures, reason: result.reason, until });
        failures = 0;
      },
      outcome(result, elapsedMs) {
        const at = now();
        if (result?.waited) {
          waits += 1;
          waitMs += Math.max(0, elapsedMs);
          if (result.retryAt > at || waits >= waitLimit || waitMs >= waitBudgetMs) {
            return { card, reason: result.reason || 'waiting', waits, waitMs, until: Math.max(at + yieldCooldownMs, result.retryAt || 0) };
          }
          return null;
        }
        waits = 0;
        if (adaptation && !result?.sourceHandled && result?.reason !== 'aborted') {
          const p = generic(perceive());
          adaptation.scope(() => true).outcome(p, result?.ok ? { ...result, progress: false } : result);
        }
        if (result?.ok !== false || !result.reason || result.reason === 'aborted') return null;
        for (const [reason, times] of byReason) if (times.at(-1) <= at - FAILURE_WINDOW) byReason.delete(reason);
        const times = (byReason.get(result.reason) || []).filter((t) => t > at - FAILURE_WINDOW);
        times.push(at);
        byReason.set(result.reason, times);
        if (times.length < 10) return null; // cool before an eleventh repeat
        const until = Math.max(at + STEP_COOLDOWN, times[0] + FAILURE_WINDOW);
        emit('autonomy_loop_blocked', { card, reason: result.reason, count: times.length, until });
        return { card, reason: 'repeated_failure', failure: result.reason, until };
      },
    };
  }

  return {
    /** Feed every brain event here. */
    handleEvent(event) {
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
      if (brain.status().goal) { idleSince = null; return null; }
      // A player goal can also end without an event (stop, clear).
      if (playerActive) { playerActive = false; pausedUntil = now() + resumeDelayMs; }
      own = null;
      if (now() < pausedUntil) return null;
      if (idleSince === null) idleSince = now();
      if (now() - idleSince < idleMs) return null;
      const state = perceive();
      if (!state || state.alive === false) return null;
      const stage = stageOf(state, memory);
      const maxStage = scope(memory);
      const paused = memory.stagePauses || {};
      const excluded = [];
      const available = cards.filter((card) => {
        const budgetStage = card.budgetStage ?? card.stage;
        if (card.stage > maxStage && !card.safeReturn) {
          excluded.push({ id: card.id, skipped: 'range' });
        } else if (card.expedition && !card.safeReturn && paused[budgetStage] > now()) {
          excluded.push({ id: card.id, skipped: 'stage_paused', until: paused[budgetStage] });
        } else return true;
        return false;
      });
      const choice = chooseNext(state, memory, available, { stage, cooldowns, now: now() });
      if (!choice.card) {
        idleSince = now();
        const scores = [...choice.scores, ...excluded];
        const until = Math.min(...scores.filter((s) => s.until > now()).map((s) => s.until));
        const reason = Number.isFinite(until) ? 'no_eligible_card_until_retry' : 'no_current_demand_or_prerequisites';
        onIdle(state, reason);
        const signature = JSON.stringify([stage, scores]);
        if (lastIdle !== signature) emit('autonomy_idle', { stage, reason, until: Number.isFinite(until) ? until : null, scores });
        lastIdle = signature;
        return null;
      }
      lastIdle = null;
      const goal = choice.card.create(memory);
      emit('autonomy_choice', { card: choice.card.id, goal: goal.name, stage, scores: choice.scores });
      const generation = brain.setGoal(goal, { autonomy: governor(choice.card.id, goal) });
      own = { id: choice.card.id, goal: goal.name, generation, expedition: choice.card.expedition, stage: choice.card.budgetStage ?? choice.card.stage, cardStage: choice.card.stage,
        safeReturn: choice.card.safeReturn };
      idleSince = null;
      return choice.card.id;
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
      || typeof card.need !== 'function' || typeof card.create !== 'function'
      || (card.requires !== undefined && typeof card.requires !== 'function')) {
    throw new TypeError('Card needs id, stage, risk, need(state, memory) and create(memory)');
  }
  return card;
}

module.exports = { createDirector, chooseNext, riskFactor };
