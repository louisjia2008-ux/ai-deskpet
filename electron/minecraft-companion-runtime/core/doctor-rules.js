// R1 detector thresholds live here. Time values are elapsed milliseconds.
// Calibrated on the six development cases; each condition requires evidence of
// the symptom itself (e.g. a failed approach is distinct from a failed chase).
const DOCTOR_RULE_THRESHOLDS = Object.freeze({
  // Three failures permit an ordinary attempt and retry. An eight-second
  // minimum ignores the immediate fallbacks of a single search.
  D2: Object.freeze({ count: 3, windowMs: 135_000, minimumMs: 8_000, radius: 8, maxGroups: 48, maxFailures: 12 }),
  // A sequence of instantaneous planner calls alone is weak evidence.
  D3: Object.freeze({ count: 4, minimumMs: 25_000, windowMs: 165_000, maxSteps: 32 }),
  // Enough room for local reroutes, but require repeat visits after departure.
  D4: Object.freeze({ windowMs: 300_000, minimumMs: 75_000, radius: 6, maxDiameter: 48,
    repeats: 4, shoreRepeats: 3, maxVisits: 48 }),
  // A half daylight cycle with work attempted and no completed work.
  D5: Object.freeze({ daylightMs: 300_000, maxSampleGapMs: 45_000, maxBuilds: 242 }),
  // The dusk radius is the existing 48-block return threshold. Darkness
  // alone needs 1.5 times that distance because a normal return takes time.
  D6: Object.freeze({ duskTick: 10_800, nightTick: 12_542, dawnTick: 23_460,
    duskDistance: 48, nightDistance: 72, growth: 12, minimumMs: 50_000,
    windowMs: 120_000, maxSamples: 16 }),
  D7: Object.freeze({ waitMs: 120_000 }),
  // Several completed select/yield pairs, excluding the first few fair retries.
  D8: Object.freeze({ count: 5, windowMs: 600_000, maxCards: 24 }),
});

const EXPECTED_FAILURES = new Set(['aborted', 'self_stuck', 'reserve_work_ended', 'waiting',
  'adaptation_other_work', 'sheltering_until_daylight', 'deferred', 'awaiting_daylight',
  'night_shelter', 'night_restricted']);
const GOAL_ENDED = new Set(['goal_done', 'goal_cleared', 'goal_failed', 'goal_yielded']);
const MILESTONES = new Set(['goal_done', 'depot_built', 'autonomy_milestone']);
const IDLE_REASON = 'no_eligible_card_until_retry';

function point(value) {
  if (typeof value === 'string' && /^-?\d+,-?\d+,-?\d+$/.test(value)) {
    const [x, y, z] = value.split(',').map(Number);
    return { x, y, z };
  }
  if (Number.isFinite(value?.x) && Number.isFinite(value?.z)) return { x: value.x, y: value.y, z: value.z };
  return null;
}

function shortText(value) { return typeof value === 'string' ? value.slice(0, 256) : null; }

function distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function pointText(p) {
  return Number.isFinite(p.y) ? '(' + [p.x, p.y, p.z].map(Math.floor).join(', ') + ')'
    : '(' + [p.x, p.z].map(Math.floor).join(', ') + ')';
}
function minutes(ms) { return (ms / 60_000).toFixed(1); }
function mark({ at, evidence }) { return { at, evidence }; }

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}
function append(entries, entry, limit) {
  entries.push(entry);
  if (entries.length > limit) entries.shift();
}
function trim(entries, at, windowMs) {
  while (entries.length && at - entries[0].at > windowMs) entries.shift();
}
function evidence(entries) { return entries.map((entry) => entry.evidence); }
function detect(key, since, summary, events) {
  return { key, severity: 'alert', since, summary, evidence: evidence(events) };
}
function explicitWait(reason) { return /(?:shelter|wait|await|defer).*(?:night|daylight|dawn)|night_(?:shelter|restricted)/.test(reason || ''); }

function failureReason(event) {
  const reason = shortText(event.reason)?.toLowerCase();
  return reason && !EXPECTED_FAILURES.has(reason) && !explicitWait(reason) ? reason : null;
}

function failureLocation(event, frame, build) {
  const reason = failureReason(event);
  if (!reason) return null;
  if (event.type === 'home_route_leg' && event.advanced === false) {
    const location = point(event.from || event.position);
    return location && { reason, location, scope: 'home route' };
  }
  if (event.type === 'target_failure') {
    const location = point(event.position);
    return location && { reason, location, scope: shortText(event.goal) || shortText(event.behavior) || 'target',
      exact: typeof event.target === 'string' && Boolean(point(event.target)) };
  }
  if (event.type === 'adaptation_attempt' && event.outcome === 'failure' && event.task !== 'goal') {
    const location = point(event.position);
    return location && { reason, location, scope: shortText(event.task) || 'adaptation' };
  }
  if (event.type === 'behavior_finished' && event.ok === false && build) {
    return { reason, location: build.position, scope: event.behavior, exact: true };
  }
  // Some old recordings only have the recovery action outcome. Restrict this
  // inference to actions whose failure describes their own current location.
  if (event.type === 'behavior_finished' && event.ok === false && event.behavior === 'home_escape') {
    const location = point(frame.context.position);
    return location && { reason, location, scope: event.behavior };
  }
  return null;
}

function sameLocation(group, location, exact, radius) {
  if (exact) return group.location.x === location.x && group.location.y === location.y && group.location.z === location.z;
  return distance(group.location, location) <= radius;
}

function repeatFailures() {
  const settings = DOCTOR_RULE_THRESHOLDS.D2;
  let groups = [];
  let active = null;
  return {
    ingest(event, frame, build) {
      const { at, context } = frame;
      const arriving = event.type === 'home_route_arrived';
      const recoveredTarget = event.type === 'target_reached' && point(event.position);
      if (arriving || recoveredTarget || (build && event.ok === true)) {
        groups = groups.filter((group) => !(arriving ? group.scope === 'home route'
          : sameLocation(group, recoveredTarget || build.position, group.exact, settings.radius)));
      }
      groups = groups.filter((group) => at - group.lastAt <= settings.windowMs);
      if (active && !groups.includes(active)) active = null;
      if (frame.waiting) {
        groups.length = 0;
        active = null;
        return null;
      }
      const failure = failureLocation(event, frame, build);
      if (failure) {
        const { reason, location, scope, exact } = failure;
        let group = groups.find((row) => row.reason === reason && row.scope === scope && row.exact === exact
          && sameLocation(row, location, exact, settings.radius));
        if (!group) {
          group = { reason, location, scope, exact, first: mark(frame), entries: [] };
          append(groups, group, settings.maxGroups);
        }
        trim(group.entries, at, settings.windowMs);
        if (!group.entries.length) group.first = mark(frame);
        // A target-memory event can report an extension of the same failure.
        // failureAt identifies the original attempt in that case.
        const attemptAt = event.type === 'target_failure' && Number.isFinite(event.failureAt) ? event.failureAt : at;
        if (attemptAt !== group.attemptAt) {
          append(group.entries, mark(frame), settings.maxFailures);
          group.attemptAt = attemptAt;
        }
        group.lastAt = at;
        if (group.entries.length >= settings.count && at - group.first.at >= settings.minimumMs) active = group;
      }
      if (!active) return null;
      const current = point(context.position);
      if (event.type === 'doctor_observation' && current && !active.exact && distance(current, active.location) > 3 * settings.radius) {
        groups = groups.filter((group) => group !== active);
        active = null;
        return null;
      }
      const key = active.scope + ':' + active.reason + ':' + active.first.evidence;
      return detect(key, active.first.at,
        active.scope + ' has failed with ' + active.reason + ' at least ' + active.entries.length
        + ' times near ' + pointText(active.location) + '.', [active.first, ...active.entries.slice(-settings.count)]);
    },
    reset() { groups = []; active = null; },
    size() { return groups.length + groups.reduce((count, group) => count + group.entries.length, 0); },
  };
}

function observedItemCount(inventory, item) {
  if (item === 'log' || item === 'planks') {
    const suffix = item === 'log' ? /(?:_log|_stem)$/ : /_planks$/;
    return Object.entries(inventory).reduce((sum, [name, count]) => sum
      + ((name === item || suffix.test(name)) && Number.isFinite(count) ? count : 0), 0);
  }
  return Number.isFinite(inventory[item]) ? inventory[item] : 0;
}

function planSignature(event, inventory) {
  const stepKey = shortText(event.key || event.item || event.step);
  if (!stepKey) return null;
  const output = shortText(event.for) || stepKey;
  const material = shortText(event.item) || stepKey;
  const id = [shortText(event.behavior || event.goal) || '', shortText(event.kind) || 'step', stepKey, output].join(':');
  const count = event.count;
  const stock = inventory ? observedItemCount(inventory, material) : null;
  const outputStock = inventory ? observedItemCount(inventory, output) : null;
  // Historic traces sometimes omit count. Inventory observations can also
  // supply concrete evidence that the needed material has not changed.
  if (!Number.isFinite(count) && !inventory) return null;
  return { id, material, output, count, stock, outputStock };
}

function planProgress(previous, current) {
  return (Number.isFinite(previous.count) && Number.isFinite(current.count) && previous.count !== current.count)
    || (previous.stock !== null && current.stock !== null && previous.stock !== current.stock)
    || (previous.outputStock !== null && current.outputStock !== null && previous.outputStock !== current.outputStock);
}

function repeatedPlans() {
  const settings = DOCTOR_RULE_THRESHOLDS.D3;
  const steps = new Map();
  let inventory = null;
  let active = null;
  return {
    ingest(event, frame, build) {
      const { at } = frame;
      let completed = false;
      if (event.type === 'doctor_observation' && event.inventory && typeof event.inventory === 'object') {
        // Retain only scalar counts and keep malformed inputs bounded too.
        inventory = Object.fromEntries(Object.entries(event.inventory).slice(0, 256)
          .filter(([, value]) => Number.isFinite(value)));
        for (const step of steps.values()) {
          if (step.signature.position) continue;
          const stock = observedItemCount(inventory, step.signature.material);
          const outputStock = observedItemCount(inventory, step.signature.output);
          if (planProgress(step.signature, { ...step.signature, stock, outputStock })) {
            steps.delete(step.signature.id);
            completed ||= outputStock > step.signature.outputStock || stock > step.signature.stock;
          } else if (step.signature.stock === null) {
            step.signature = { ...step.signature, stock, outputStock };
          }
        }
      }
      if (event.type === 'goal_done' || event.type === 'site_abandoned') steps.clear();
      if (build && event.ok === true) steps.delete(build.id);
      for (const [id, step] of steps) {
        if (at - step.lastAt > settings.windowMs) steps.delete(id);
      }
      if (active && steps.get(active.signature.id) !== active) active = null;
      if (!frame.waiting && (event.type === 'plan_step' || (build && event.ok === false && failureReason(event)))) {
        const signature = build ? { id: build.id, item: build.what, material: build.what, output: build.what,
          stock: null, outputStock: null, position: build.position } : planSignature(event, inventory);
        if (signature) {
          let step = steps.get(signature.id);
          if (step && planProgress(step.signature, signature)) {
            completed ||= signature.count < step.signature.count;
            if (active === step) active = null;
            step = null;
          }
          if (!step) step = { first: mark(frame), attempts: 0, signature, marks: [] };
          if (at - step.first.at > settings.windowMs && active !== step) {
            step.first = mark(frame);
            step.attempts = 0;
            step.marks.length = 0;
          }
          step.signature = signature;
          step.lastAt = at;
          step.attempts += 1;
          append(step.marks, mark(frame), settings.count);
          boundedSet(steps, signature.id, step, settings.maxSteps);
          if (step.attempts >= settings.count && at - step.first.at >= settings.minimumMs) active = step;
        }
      }
      if (!active || frame.waiting) return { detection: null, completed };
      const { signature } = active;
      const requested = Number.isFinite(signature.count) ? signature.count + ' ' : '';
      const plan = signature.position ? 'The same ' + signature.material + ' build at ' + pointText(signature.position)
        + ' has failed' : 'The plan has requested ' + requested + signature.material + ' for ' + signature.output;
      return { detection: detect(signature.id + ':' + active.first.evidence, active.first.at,
        plan + ' ' + active.attempts + ' times over ' + minutes(at - active.first.at)
        + ' minutes without observable progress.', [active.first, ...active.marks]), completed };
    },
    reset() { steps.clear(); inventory = null; active = null; },
    size() { return steps.size + Object.keys(inventory || {}).length
      + [...steps.values()].reduce((count, step) => count + step.marks.length, 0); },
  };
}

function routeLoop() {
  const settings = DOCTOR_RULE_THRESHOLDS.D4;
  const shore = [];
  const visits = [];
  let lastRoutedAt = null;
  let active = null;
  function clear() { shore.length = 0; visits.length = 0; lastRoutedAt = null; active = null; }

  function appendVisit(pos, frame, action) {
    if (!pos) return;
    const previous = visits.at(-1);
    if (previous && distance(previous.pos, pos) <= settings.radius) return;
    append(visits, { ...mark(frame), pos, action: shortText(action) }, settings.maxVisits);
    // Keep visits from one local neighborhood. A long detour starts its own
    // history even if the route eventually passes an old point again.
    while (visits.some((visit) => distance(visit.pos, pos) > settings.maxDiameter)) visits.shift();
  }

  return {
    ingest(event, frame, progressed) {
      if (frame.waiting || progressed || event.type === 'home_route_arrived') {
        clear();
        return null;
      }
      trim(visits, frame.at, settings.windowMs);
      trim(shore, frame.at, settings.windowMs);
      if (event.type === 'home_route_shore' && event.phase === 'alternate' && event.returns >= 2) {
        const bank = point(event.bank);
        if (bank) append(shore, { ...mark(frame), bank }, settings.maxVisits);
      }
      if (event.type === 'home_route_leg' || event.type === 'adaptation_route') lastRoutedAt = frame.at;
      if (event.type === 'home_route_leg') {
        appendVisit(point(event.from), frame, event.behavior);
        appendVisit(point(event.position), frame, event.behavior);
      }
      if (event.type === 'doctor_observation') {
        appendVisit(point(event.position), frame, event.engine?.running || frame.context.goal);
        if (active && visits.length === 1 && frame.at - active.seenAt > settings.minimumMs) active = null;
      }
      const shorelineLoop = shore.length >= settings.shoreRepeats
        && shore.some((entry) => distance(shore[0].bank, entry.bank) > settings.radius)
        && frame.at - shore[0].at >= settings.minimumMs;
      let hits = 0;
      const repeated = [];
      const haveRoute = lastRoutedAt !== null && frame.at - lastRoutedAt <= settings.windowMs;
      // Revisited cells must be separated by an out-and-back, not adjacent
      // samples of jitter. For uninstrumented travel require action changes.
      const haveDifferentActions = new Set(visits.map((visit) => visit.action).filter(Boolean)).size >= 2;
      if ((haveRoute || haveDifferentActions) && visits.length >= settings.repeats + 2
        && frame.at - visits[0].at >= settings.minimumMs) {
        for (let i = 2; i < visits.length; i++) {
          if (!visits.slice(0, i - 1).some(({ pos }) => distance(visits[i].pos, pos) <= settings.radius)) continue;
          hits += 1;
          if (!repeated.some(({ pos }) => distance(visits[i].pos, pos) <= settings.radius)) repeated.push(visits[i]);
        }
      }
      if (shorelineLoop || (hits >= settings.repeats && repeated.length >= 2)) {
        const samples = shorelineLoop ? shore : [visits[0], ...repeated];
        if (!active) {
          active = { first: samples[0], seenAt: frame.at, summary: shorelineLoop
            ? 'The route has retried a small set of banks after repeatedly returning to them.'
            : 'Travel is repeatedly revisiting the same ' + repeated.length + ' local positions.', samples };
        }
        active.seenAt = samples.at(-1).at;
        active.samples = samples;
      }
      if (active && frame.at - active.seenAt > settings.windowMs) active = null;
      return active && detect('loop:' + active.first.evidence, active.first.at, active.summary, active.samples);
    },
    reset: clear,
    size() { return visits.length + shore.length; },
  };
}

function daylightProgress() {
  const settings = DOCTOR_RULE_THRESHOLDS.D5;
  let since = null, previous = null, elapsed = 0, homeMilestone = null;
  let working = false;
  const built = new Map();
  function clear() { since = null; previous = null; elapsed = 0; working = false; }
  return {
    progress(event, build, frame, planCompleted) {
      let advanced = MILESTONES.has(event.type) || planCompleted;
      if (build && event.ok === true && build.what !== 'scaffold' && !built.has(build.id)) {
        boundedSet(built, build.id, true, settings.maxBuilds);
        advanced = true;
      }
      if (event.type === 'site_abandoned') {
        built.clear();
        advanced = true;
      }
      if (event.type === 'doctor_observation' && event.home?.anchor) {
        const home = point(event.home.anchor);
        const id = home && [pointText(home), event.home.usable === true, event.home.finished === true].join(':');
        if (id && id !== homeMilestone) advanced = true;
        homeMilestone = id;
      }
      if (advanced) clear();
      working ||= event.type === 'plan_step' || event.type === 'build'
        || (event.type === 'behavior_started' && event.behavior?.startsWith?.('goal:'));
      return advanced;
    },
    ingest(event, frame, idle) {
      const { at, context } = frame;
      if (event.type !== 'doctor_observation') return undefined;
      const eligible = working && !idle && event.isDay === true && !frame.waiting && (context.goal || context.card);
      if (event.isDay !== true || frame.waiting || (previous && at - previous.at > settings.maxSampleGapMs)) {
        since = null;
        elapsed = 0;
        previous = null;
      }
      if (!eligible) {
        previous = null;
        return null;
      }
      since ||= mark(frame);
      if (previous) elapsed += at - previous.at;
      previous = mark(frame);
      if (elapsed < settings.daylightMs) return null;
      return detect('daylight:' + since.evidence, since.at,
        (context.card || context.goal) + ' has spent ' + minutes(elapsed)
          + ' minutes working in daylight without completing a plan step or reaching a milestone.', [since, previous]);
    },
    reset() { clear(); built.clear(); homeMilestone = null; },
    size() { return built.size; },
  };
}

function distanceAtDusk() {
  const settings = DOCTOR_RULE_THRESHOLDS.D6;
  const samples = [];
  let homeId = null;
  function clear() { samples.length = 0; homeId = null; }
  return {
    ingest(event, frame) {
      if (frame.waiting) { clear(); return null; }
      if (event.type !== 'doctor_observation') return undefined;
      const pos = point(event.position);
      const home = point(event.home?.anchor || frame.context.home?.anchor || frame.context.home);
      const time = event.timeOfDay ?? frame.context.timeOfDay;
      if (!home || !pos || !Number.isFinite(time) || time < settings.duskTick || time >= settings.dawnTick
        || (event.dimension && !['overworld', 'minecraft:overworld'].includes(event.dimension))) {
        clear();
        return null;
      }
      const id = pointText(home);
      if (homeId !== id) clear();
      homeId = id;
      const current = { ...mark(frame), distance: distance(home, pos) };
      trim(samples, frame.at, settings.windowMs);
      append(samples, current, settings.maxSamples);
      const earlier = samples.find((sample) => frame.at - sample.at >= settings.minimumMs
        && current.distance - sample.distance >= settings.growth);
      if (current.distance < settings.duskDistance) return null;
      const afterDark = event.isDay === false || (event.isDay !== true && time >= settings.nightTick);
      if ((earlier && !afterDark) || (afterDark && current.distance >= settings.nightDistance)) {
        const first = earlier || current;
        return detect('dusk:' + id, first.at,
          'The bot is ' + Math.round(current.distance) + ' blocks from home '
          + (afterDark ? 'after dark' : 'at dusk')
          + (earlier ? ' after moving ' + Math.round(current.distance - earlier.distance) + ' blocks farther away.' : '.'),
        first === current ? [current] : [first, current]);
      }
      return null;
    },
    reset: clear,
    size() { return samples.length; },
  };
}

function directorIdle() {
  const settings = DOCTOR_RULE_THRESHOLDS.D7;
  let idle = null;
  return {
    ingest(event, frame) {
      if (event.type === 'autonomy_idle') {
        if (event.reason === IDLE_REASON && Number.isFinite(event.until)) idle ||= mark(frame);
        else idle = null;
      }
      if (event.type === 'autonomy_choice' || event.type === 'goal_set' || event.type === 'autonomy_disabled') idle = null;
      if (frame.waiting && idle) {
        // A legitimate wait must not contribute to the two-minute idle clock.
        idle = mark(frame);
        return null;
      }
      if (!idle || frame.at - idle.at < settings.waitMs || frame.context.goal) return null;
      return detect('idle:' + idle.evidence, idle.at,
        'The director has spent ' + minutes(frame.at - idle.at) + ' minutes waiting for a card to retry with no task running.',
      [idle, mark(frame)]);
    },
    reset() { idle = null; },
    isIdle() { return Boolean(idle); },
  };
}

function cardSwitches() {
  const settings = DOCTOR_RULE_THRESHOLDS.D8;
  const cycles = new Map();
  let selected = null;
  let active = null;
  function clear() { cycles.clear(); selected = null; active = null; }
  return {
    ingest(event, frame) {
      const { at } = frame;
      if (event.type === 'autonomy_disabled') { clear(); return null; }
      for (const [card, entries] of cycles) {
        trim(entries, at, settings.windowMs);
        if (!entries.length) cycles.delete(card);
      }
      if (active && (cycles.get(active.card)?.length ?? 0) < settings.count) active = null;
      if (event.type === 'autonomy_choice' && typeof event.card === 'string') {
        selected = { ...mark(frame), card: shortText(event.card), goal: shortText(event.goal) };
      } else if (GOAL_ENDED.has(event.type)) {
        const matching = selected && (event.card ? event.card === selected.card : event.goal === selected.goal);
        if (matching) {
          if (event.type === 'goal_yielded' && !explicitWait(event.reason) && !frame.waiting) {
            const entries = cycles.get(selected.card) || [];
            append(entries, { ...mark(frame), selection: selected }, settings.count);
            boundedSet(cycles, selected.card, entries, settings.maxCards);
            if (entries.length >= settings.count && active?.card !== selected.card) {
              active = { card: selected.card, first: entries[0].selection };
            }
          } else if (event.type === 'goal_done') {
            cycles.delete(selected.card);
            if (active?.card === selected.card) active = null;
          }
          selected = null;
        }
      }
      if (!active || frame.waiting) return null;
      const entries = cycles.get(active.card);
      return detect(active.card + ':' + active.first.evidence, active.first.at,
        'The director has selected and yielded the ' + active.card + ' card at least ' + settings.count
        + ' times in ' + minutes(settings.windowMs) + ' minutes.', [...entries.map((entry) => entry.selection), ...entries]);
    },
    reset: clear,
    size() { return [...cycles.values()].reduce((count, entries) => count + entries.length, 0); },
  };
}

function createDoctorRules() {
  const failures = repeatFailures();
  const plans = repeatedPlans();
  const route = routeLoop();
  const progress = daylightProgress();
  const dusk = distanceAtDusk();
  const idle = directorIdle();
  const switches = cardSwitches();
  const buildAttempts = new Map();
  return {
    ingest(event, frame) {
      const behavior = shortText(event.behavior);
      if (event.type === 'build' && behavior) {
        const position = point(event.position);
        const what = shortText(event.what);
        if (position && what) boundedSet(buildAttempts, behavior, {
          position, what, id: pointText(position) + ':' + what,
        }, DOCTOR_RULE_THRESHOLDS.D3.maxSteps);
      }
      let build = null;
      if (event.type === 'behavior_finished' || event.type === 'behavior_abandoned' || event.type === 'behavior_started') {
        if (event.type === 'behavior_finished') build = buildAttempts.get(behavior);
        buildAttempts.delete(behavior);
      }
      const repeated = plans.ingest(event, frame, build);
      const advanced = progress.progress(event, build, frame, repeated.completed);
      const idleDetection = idle.ingest(event, frame);
      return {
        D2: failures.ingest(event, frame, build),
        D3: repeated.detection,
        D4: route.ingest(event, frame, advanced),
        D5: advanced ? null : progress.ingest(event, frame, idle.isIdle()),
        D6: dusk.ingest(event, frame),
        D7: idleDetection,
        D8: switches.ingest(event, frame),
      };
    },
    reset() {
      for (const rule of [failures, plans, route, progress, dusk, idle, switches]) rule.reset();
      buildAttempts.clear();
    },
    size() {
      return failures.size() + plans.size() + route.size() + progress.size() + dusk.size() + switches.size() + buildAttempts.size;
    },
  };
}

module.exports = { createDoctorRules, DOCTOR_RULE_THRESHOLDS };
