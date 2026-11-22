// R1 detector thresholds live here. Time values are elapsed milliseconds.
// Each condition requires evidence of the symptom itself. For example, a
// failed approach is distinct from a failed chase.
const DOCTOR_RULE_THRESHOLDS = Object.freeze({
  // Separate route legs, construction shortages and recovery retries.
  D2: Object.freeze({ count: 3, windowMs: 135_000, minimumMs: 8_000, recoveryMinimumMs: 60_000,
    shortageWindowMs: 180_000, shortagePlanMs: 30_000, radius: 8, maxGroups: 48, maxFailures: 12 }),
  // Repeated requests need correlated unsuccessful executions or an already
  // witnessed shortage. A planner poll alone does not establish a stall.
  D3: Object.freeze({ count: 4, failedAttempts: 3, minimumMs: 25_000, windowMs: 165_000, maxSteps: 32 }),
  // Preserve ordinary reroutes and vertical progress; require multiple observed returns.
  D4: Object.freeze({ windowMs: 300_000, minimumMs: 75_000, radius: 6, verticalRadius: 3, maxDiameter: 48,
    repeats: 4, homeFailures: 2, shoreRepeats: 3, maxVisits: 48 }),
  // A five-minute daylight work interval, interrupted by confirmed progress.
  D5: Object.freeze({ daylightMs: 300_000, maxSampleGapMs: 45_000, newAreaBlocks: 8, maxWorkReceipts: 256, maxTargets: 32 }),
  // Confirm a departure across consecutive samples, or give a distant bot a
  // minute and a half to make progress on its return or shelter.
  D6: Object.freeze({ duskTick: 10_800, nightTick: 12_542, dawnTick: 23_460,
    duskDistance: 48, nightDistance: 72, growth: 12, legGrowth: 4, minimumMs: 50_000,
    nightMs: 90_000, maxSampleGapMs: 45_000, evidenceMs: 120_000, mineDepth: 12, interruptions: 2,
    departureSamples: 3, homeRadiusSlack: 2 }),
  D7: Object.freeze({ waitMs: 120_000, maxCooldowns: 32 }),
  // Several completed select/yield pairs, excluding the first few fair retries.
  D8: Object.freeze({ count: 5, windowMs: 600_000, minWaitAttempts: 2, maxCards: 24 }),
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

function adaptationIdentity(event) {
  return shortText(event.key) ?? [event.dimension, event.region, event.target]
    .map(shortText).join(':');
}

function failureLocation(event, frame, build) {
  const reason = failureReason(event);
  if (!reason) return null;
  if (event.type === 'home_route_leg' && event.advanced === false) {
    const location = point(event.from || event.position);
    const destination = point(event.destination);
    return location && { reason, location, scope: 'home route', key: destination && pointText(destination),
      origin: true, provesWork: true };
  }
  if (event.type === 'target_failure') {
    const location = point(event.position);
    const scope = shortText(event.goal) || shortText(event.behavior) || 'target';
    return location && { reason, location, scope,
      key: shortText(event.key) || shortText(event.target), attemptAt: event.failureAt };
  }
  if (event.type === 'adaptation_attempt' && event.outcome === 'failure' && event.task !== 'goal') {
    const location = point(event.position);
    return location && { reason, location, scope: shortText(event.task) || 'adaptation',
      key: adaptationIdentity(event), provesWork: true, recovery: event.task === 'mine_hazard' };
  }
  if (event.type === 'behavior_finished' && event.ok === false && build) {
    const shortage = reason === 'no_material';
    const scope = shortText(event.behavior);
    return { reason, location: build.position, scope, shortage,
      key: shortage ? [build.what, scope, event.generation].join(':') : build.id };
  }
  // These results describe the body's current position, not an action target.
  if (event.type === 'behavior_finished' && event.ok === false && event.behavior === 'home_escape') {
    const location = point(frame.context.position);
    return location && { reason, location, scope: event.behavior, origin: true, recovery: true };
  }
  return null;
}

function sameFailure(group, failure, radius) {
  return group.reason === failure.reason && group.scope === failure.scope && group.key === failure.key
    && (!group.dimension || !failure.dimension || group.dimension === failure.dimension)
    && distance(group.location, failure.location) <= radius
    && (!Number.isFinite(group.location.y) || !Number.isFinite(failure.location.y)
      || Math.abs(group.location.y - failure.location.y) <= radius);
}

function resolvedGroup(group, event, build, at) {
  if (event.type === 'home_route_arrived') return group.scope === 'home route' || group.recovery;
  if (event.type === 'self_stuck_escaped') return group.origin;
  if (event.type === 'site_abandoned') return group.shortage;
  if (event.type === 'adaptation_attempt' && event.outcome === 'success') {
    return group.scope === event.task && group.key === adaptationIdentity(event);
  }
  if (event.type === 'target_reached') {
    return group.key != null && group.key === (shortText(event.key) || shortText(event.target));
  }
  if (group.shortage && event.type === 'goal_done') return group.scope === 'goal:' + event.goal;
  if (build && event.ok === true && at > group.lastAt) {
    // Count repeated stock-outs of the same local construction job, even if
    // earlier stock-outs were temporarily relieved by successful placement.
    const expected = group.shortage ? group.confirmed && group.lastPosition : group.location;
    return expected && group.scope === event.behavior && pointText(expected) === pointText(build.position);
  }
  return false;
}

function recordShortagePlan(group, event, frame, settings) {
  if (!group.confirmed || frame.at - group.lastAt > settings.shortageWindowMs || event.type !== 'plan_step'
    || event.behavior !== group.scope || event.generation !== group.generation || event.kind !== 'gather'
    || !Number.isFinite(event.count)) return false;

  const signature = JSON.stringify([shortText(event.key), shortText(event.for), event.count]);
  if (group.plan?.signature !== signature) {
    group.plan = { signature, first: mark(frame) };
    group.retry = null;
  }
  return frame.at - group.plan.first.at >= settings.shortagePlanMs;
}

function repeatFailures() {
  const settings = DOCTOR_RULE_THRESHOLDS.D2;
  let groups = [];
  let active = null;
  return {
    ingest(event, frame, build) {
      const { at, context } = frame;
      if (frame.inactive || frame.sleepingAtHome) {
        groups.length = 0;
        active = null;
        return null;
      }
      groups = groups.filter((group) => at - group.lastAt <= group.windowMs && !resolvedGroup(group, event, build, at));
      if (active && !groups.includes(active)) active = null;

      const failure = failureLocation(event, frame, build);
      if (failure && (!frame.waiting || failure.provesWork)) {
        failure.dimension = shortText(event.dimension) || frame.dimension;
        let group = groups.find((row) => sameFailure(row, failure, settings.radius));
        if (!group) {
          group = { ...failure, generation: event.generation, entries: [],
            windowMs: failure.shortage ? settings.shortageWindowMs : settings.windowMs };
          append(groups, group, settings.maxGroups);
        }
        trim(group.entries, at, group.windowMs);
        const attemptAt = Number.isFinite(failure.attemptAt) ? failure.attemptAt : at;
        if (!group.entries.some((entry) => entry.attemptAt === attemptAt)) {
          append(group.entries, { ...mark(frame), attemptAt }, settings.maxFailures);
          group.lastAt = at;
          group.lastPosition = failure.location;
          group.plan = null;
          group.retry = null;
          const minimum = group.recovery ? settings.recoveryMinimumMs : settings.minimumMs;
          group.confirmed = group.entries.length >= settings.count && at - group.entries[0].at >= minimum;
          if (group.confirmed && !group.shortage) active = group;
          else if (active === group) active = null;
        }
      }
      if (!frame.waiting && event.type === 'plan_step') {
        for (const group of groups) {
          if (group.shortage && recordShortagePlan(group, event, frame, settings)) {
            group.retry = [group.plan.first, mark(frame)];
            active = group;
          }
        }
      }
      if (!active || (active.shortage && !active.retry)) return null;
      const current = point(context.position);
      if (event.type === 'doctor_observation' && active.origin && current && distance(current, active.location) > 3 * settings.radius) {
        groups = groups.filter((group) => group !== active);
        active = null;
        return null;
      }
      const first = active.entries[0];
      const key = active.scope + ':' + active.reason + ':' + first.evidence;
      const retries = active.retry || [];
      const shortage = active.shortage ? ' and the same material request still remains unresolved' : '';
      return detect(key, first.at,
        active.scope + ' has failed with ' + active.reason + ' at least ' + active.entries.length
        + ' times near ' + pointText(active.lastPosition) + shortage + '.', [first, ...active.entries.slice(-settings.count), ...retries]);
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
  const behavior = shortText(event.behavior || event.goal);
  const generation = Number.isSafeInteger(event.generation) ? event.generation : null;
  const id = JSON.stringify([behavior, generation, shortText(event.kind), stepKey, output]);
  const count = event.count;
  const stock = inventory ? observedItemCount(inventory, material) : null;
  const outputStock = inventory ? observedItemCount(inventory, output) : null;
  // Historic traces sometimes omit count. Inventory observations can also
  // supply concrete evidence that the needed material has not changed.
  if (!Number.isFinite(count) && !inventory) return null;
  return { id, behavior, generation, material, output, count, stock, outputStock };
}

function planProgress(previous, current) {
  return (Number.isFinite(previous.count) && Number.isFinite(current.count) && previous.count !== current.count)
    || (previous.stock !== null && current.stock !== null && previous.stock !== current.stock)
    || (previous.outputStock !== null && current.outputStock !== null && previous.outputStock !== current.outputStock);
}

function samePlanOwner(signature, event) {
  return signature.behavior === (event.behavior || event.goal)
    && signature.generation === (event.generation ?? null);
}

function repeatedPlans() {
  const settings = DOCTOR_RULE_THRESHOLDS.D3;
  const steps = new Map();
  let inventory = null;
  let active = null;
  let shortage = null;

  function outcome(event, frame) {
    const previous = [...steps.values()].find((step) => step.pending && samePlanOwner(step.signature, event));
    if (!previous) return;
    previous.pending = false;
    if (event.ok === true) {
      // The outcome alone is not a milestone, but it does break a streak of
      // failures. Mining fronts and useful navigation often yield ok before
      // the final count changes.
      if (previous.failures || previous.interruptions) steps.delete(previous.signature.id);
    } else if (event.ok === false && failureReason(event)) {
      previous.failures++;
      append(previous.outcomes, mark(frame), settings.failedAttempts);
    } else if (event.ok === false && event.reason === 'aborted') {
      previous.interruptions++;
      append(previous.outcomes, mark(frame), settings.failedAttempts);
    }
  }

  function observation(event) {
    inventory = Object.fromEntries(Object.entries(event.inventory).slice(0, 256)
      .filter(([, value]) => Number.isFinite(value)));
    let completed = false;
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
    return completed;
  }

  return {
    ingest(event, frame, build) {
      const { at } = frame;
      let completed = false;
      if (event.type === 'doctor_observation' && event.inventory && typeof event.inventory === 'object') {
        completed = observation(event);
      }
      if (frame.inactive || frame.sleepingAtHome || GOAL_ENDED.has(event.type) || event.type === 'site_abandoned') {
        steps.clear();
        shortage = null;
      }
      if (event.type === 'behavior_finished') {
        outcome(event, frame);
        if (build && event.ok === true) {
          steps.delete(build.id);
          if (shortage && samePlanOwner(shortage, event)) shortage = null;
        }
        if (build && event.ok === false && failureReason(event) === 'no_material') {
          shortage = { ...mark(frame), behavior: shortText(event.behavior), generation: event.generation ?? null };
        }
      }
      if (event.type === 'home_route_arrived' || (event.type === 'home_route_leg' && event.advanced === true)) {
        for (const [id, step] of steps) {
          if (samePlanOwner(step.signature, event)) steps.delete(id);
        }
      }
      for (const [id, step] of steps) {
        if (at - step.first.at > settings.windowMs) steps.delete(id);
      }
      if (shortage && at - shortage.at > settings.windowMs) shortage = null;
      if (active && steps.get(active.signature.id) !== active) active = null;

      const buildFailure = build && event.ok === false && failureReason(event);
      if (!frame.waiting && (event.type === 'plan_step' || buildFailure)) {
        const signature = buildFailure ? { id: build.id, material: build.what, output: build.what,
          stock: null, outputStock: null, position: build.position } : planSignature(event, inventory);
        if (signature) {
          let step = steps.get(signature.id);
          if (step && planProgress(step.signature, signature)) {
            completed ||= signature.count < step.signature.count;
            if (active === step) active = null;
            step = null;
          }
          if (!step) {
            step = { first: mark(frame), attempts: 0, signature, marks: [], failures: 0, interruptions: 0, outcomes: [] };
          }
          step.signature = signature;
          step.attempts++;
          if (!buildFailure) {
            for (const previous of steps.values()) {
              if (samePlanOwner(previous.signature, event)) previous.pending = false;
            }
            step.pending = true;
          }
          if (buildFailure) step.failures++;
          append(step.marks, mark(frame), settings.count);
          boundedSet(steps, signature.id, step, settings.maxSteps);
          const buildingBlocked = !buildFailure && shortage && samePlanOwner(shortage, event)
            && step.failures + step.interruptions >= settings.failedAttempts;
          if (step.attempts >= settings.count && at - step.first.at >= settings.minimumMs
            && (step.failures >= settings.failedAttempts || buildingBlocked)) {
            step.shortage = buildingBlocked && shortage;
            active = step;
          }
        }
      }
      if (!active || frame.waiting) return { detection: null, completed };
      const { signature } = active;
      const requested = Number.isFinite(signature.count) ? signature.count + ' ' : '';
      const plan = signature.position ? 'The same ' + signature.material + ' build at ' + pointText(signature.position)
        + ' has failed' : 'The plan has requested ' + requested + signature.material + ' for ' + signature.output;
      const receipts = [active.first, ...active.marks, ...active.outcomes, ...(active.shortage ? [active.shortage] : [])]
        .sort((a, b) => a.at - b.at || a.evidence - b.evidence);
      return { detection: detect(signature.id + ':' + active.first.evidence, active.first.at,
        plan + ' ' + active.attempts + ' times over ' + minutes(at - active.first.at)
        + ' minutes with repeated unsuccessful attempts.', receipts), completed };
    },
    reset() { steps.clear(); inventory = null; active = null; shortage = null; },
    size() { return steps.size + Object.keys(inventory || {}).length + Number(Boolean(shortage))
      + [...steps.values()].reduce((count, step) => count + step.marks.length + step.outcomes.length, 0); },
  };
}

function routeLoop() {
  const settings = DOCTOR_RULE_THRESHOLDS.D4;
  const samples = [];
  const homes = [];
  const relocations = [];
  const banks = [];
  let homeDestination = null;
  let active = null;

  function near(a, b) {
    return distance(a, b) <= settings.radius
      && (!Number.isFinite(a.y) || !Number.isFinite(b.y) || Math.abs(a.y - b.y) <= settings.verticalRadius);
  }

  function clear(...tracks) {
    for (const track of tracks) track.length = 0;
    if (active && tracks.includes(active.track)) active = null;
  }

  function visit(track, position, frame, action, failed = false) {
    if (!position) return;
    if (active?.track === track && distance(active.first.position, position) > settings.maxDiameter) active = null;
    const previous = track.at(-1);
    if (previous && near(previous.position, position)) {
      if (failed) previous.failure = mark(frame);
      return;
    }
    append(track, { ...mark(frame), position, action, failure: failed ? mark(frame) : null }, settings.maxVisits);
    // A move to a different neighborhood ends this local pattern.
    while (track.some((row) => distance(row.position, position) > settings.maxDiameter)) track.shift();
  }

  function repeated(track) {
    const first = track[0];
    const last = track.at(-1);
    if (track.length < settings.repeats + 2 || last.at - first.at < settings.minimumMs) return null;
    let visits = 0;
    const distinct = [];
    for (let i = 2; i < track.length; i += 1) {
      const row = track[i];
      if (!track.slice(0, i - 1).some((earlier) => near(earlier.position, row.position))) continue;
      visits += 1;
      if (!distinct.some((earlier) => near(earlier.position, row.position))) distinct.push(row);
    }
    if (visits < settings.repeats || distinct.length < 2) return null;
    return distinct;
  }

  function confirm(track, hits, summary, extra = []) {
    if (!active || active.track !== track) active = { track, first: track[0] };
    active.last = track.at(-1).at;
    active.hits = [active.first, ...hits, ...extra, track.at(-1)];
    active.summary = summary;
  }

  return {
    ingest(event, frame, progressed) {
      if (frame.inactive || frame.sleepingAtHome || frame.context.goal === 'survey_plan') {
        clear(samples, homes, relocations, banks);
        homeDestination = null;
        return null;
      }
      for (const track of [samples, homes, relocations, banks]) trim(track, frame.at, settings.windowMs);
      if (event.type === 'home_route_arrived') {
        clear(samples, homes, banks);
        homeDestination = null;
      }
      if (event.type === 'site_chosen') clear(relocations);
      // Sampling alone cannot distinguish a small return into a mining shaft
      // from a loop. Require 3D revisits and discard recent productive work.
      if (frame.waiting || progressed || ['mine_loot', 'mine_frontier', 'mine_leave'].includes(event.type)) clear(samples);

      if (event.type === 'home_route_shore' && event.phase === 'alternate' && event.returns >= 2) {
        const bank = point(event.bank);
        if (bank) {
          if (active?.track === banks && distance(active.first.position, bank) > settings.maxDiameter) active = null;
          append(banks, { ...mark(frame), position: bank }, settings.maxVisits);
          while (banks.some((row) => distance(row.position, bank) > settings.maxDiameter)) banks.shift();
          if (banks.length >= settings.shoreRepeats && frame.at - banks[0].at >= settings.minimumMs
            && banks.some((row) => !near(row.position, banks[0].position))) {
            confirm(banks, banks.slice(-settings.shoreRepeats),
              'The route has switched between nearby banks without breaking the repeated shore returns.');
          }
        }
      } else if (event.type === 'home_route_leg' || event.type === 'home_relocation_leg') {
        const isHomeRoute = event.type === 'home_route_leg';
        const track = isHomeRoute ? homes : relocations;
        const destination = point(event.destination);
        if (isHomeRoute && destination) {
          if (homeDestination && !near(homeDestination, destination)) clear(homes, banks);
          homeDestination = destination;
        }
        visit(track, point(event.from), frame, null);
        visit(track, point(event.position), frame, null, isHomeRoute && event.advanced === false);
        const repeats = repeated(track);
        if (repeats) {
          const failures = track.map((row) => row.failure)
            .filter((failure) => failure && frame.at - failure.at <= settings.windowMs);
          if (!isHomeRoute || failures.length >= settings.homeFailures) {
            confirm(track, repeats, 'Travel is repeatedly revisiting the same ' + repeats.length + ' local positions.', failures);
          }
        }
      } else if (event.type === 'doctor_observation' && !frame.waiting) {
        const action = shortText(event.engine?.running ?? frame.behavior ?? frame.context.goal);
        visit(samples, point(event.position), frame, action);
        const actions = new Set(samples.map((row) => row.action).filter(Boolean));
        if (actions.size >= 2) {
          const repeats = repeated(samples);
          if (repeats) confirm(samples, repeats, 'Travel is repeatedly revisiting the same ' + repeats.length + ' local positions.');
        }
      }
      if (active && (!active.track.length || frame.at - active.last > settings.windowMs)) active = null;
      return active && detect('loop:' + active.first.evidence, active.first.at, active.summary, active.hits);
    },
    reset() { clear(samples, homes, relocations, banks); homeDestination = null; },
    size() { return samples.length + homes.length + relocations.length + banks.length; },
  };
}

function daylightProgress() {
  const settings = DOCTOR_RULE_THRESHOLDS.D5;
  const receipts = new Map();
  const targets = new Map();
  const pending = new Map();
  let since = null;
  let previous = null;
  let homeMilestone = null;
  let working = false;
  let waiting = false;
  let search = null;

  function clearClock() { since = previous = null; }
  function clearGoal() {
    clearClock();
    working = waiting = false;
    search = null;
    pending.clear();
    targets.clear();
  }
  function complete(id) {
    if (receipts.has(id)) return false;
    boundedSet(receipts, id, true, settings.maxWorkReceipts);
    return true;
  }
  function observedProgress(event, frame) {
    const inventory = event.inventory;
    if (!inventory || typeof inventory !== 'object') return false;
    const goal = frame.context.goal;
    if (goal === 'stock_food' && !targets.has('doctor:food')) boundedSet(targets, 'doctor:food', null, settings.maxTargets);
    if (goal === 'farm' || goal === 'harvest_wheat') {
      for (const crop of ['wheat', 'wheat_seeds', 'bread']) {
        if (!targets.has(crop)) boundedSet(targets, crop, null, settings.maxTargets);
      }
    }
    let advanced = false;
    for (const [item, previousCount] of targets) {
      const count = item === 'doctor:food'
        ? Object.entries(inventory).reduce((total, [name, quantity]) => total
          + (/^(?:cooked_)?(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)$|^(?:bread|baked_potato|apple|carrot|mushroom_stew)$/.test(name)
            && Number.isFinite(quantity) ? quantity : 0), 0)
        : observedItemCount(inventory, item);
      if (previousCount !== null && count > previousCount) advanced = true;
      targets.set(item, count);
    }
    return advanced;
  }
  return {
    progress(event, build, frame, planCompleted) {
      let advanced = MILESTONES.has(event.type) || planCompleted;
      if (event.type === 'goal_set' || GOAL_ENDED.has(event.type) || event.type === 'stopped') clearGoal();
      if (event.type === 'site_abandoned' || event.type === 'site_chosen') {
        receipts.clear();
        search = null;
        advanced ||= event.type === 'site_chosen';
      }
      if (event.type === 'plan_step') {
        for (const value of [event.item || event.key, event.for]) {
          const item = shortText(value);
          if (item && !targets.has(item)) boundedSet(targets, item, null, settings.maxTargets);
        }
      }
      const behavior = shortText(event.behavior);
      if (behavior?.startsWith('goal:')) {
        const positionKey = shortText(event.position) || shortText(event.plot);
        const work = ['site_dig', 'site_fill', 'mine_loot', 'mine_ore'].includes(event.type)
          || (event.type === 'farm' && ['plant', 'harvest', 'till'].includes(event.action));
        if (work && positionKey) boundedSet(pending, behavior,
          event.type + ':' + (event.action ?? '') + ':' + positionKey, settings.maxTargets);
        if (event.type === 'farm' && event.action === 'seeds') {
          boundedSet(pending, behavior, 'grass_break', settings.maxTargets);
        }
        // A successful seed attempt without an explore fallback confirms a
        // grass block was broken. Exploring by itself confirms only travel.
        if (event.type === 'explore' && pending.get(behavior) === 'grass_break') pending.delete(behavior);
        if (event.type === 'behavior_finished') {
          const receipt = pending.get(behavior);
          pending.delete(behavior);
          if (event.ok === true && receipt && (receipt === 'grass_break' || complete(receipt))) advanced = true;
          if (['crops_growing', 'no_available_plot', 'waiting_for_wheat', 'sheltering_until_daylight'].includes(event.reason)) {
            waiting = true;
          }
        }
        if (event.type === 'behavior_abandoned' || event.type === 'behavior_started') pending.delete(behavior);
      }
      if (build && event.ok === true && build.what !== 'scaffold' && complete(build.id)) advanced = true;
      if (event.type === 'home_relocation_leg' && event.ok === true && !event.inWater) {
        const from = point(event.from);
        const to = point(event.position);
        if (from && to) {
          search ||= { origin: from, radius: 0 };
          const radius = distance(search.origin, to);
          if (radius > search.radius + settings.newAreaBlocks) {
            search.radius = radius;
            clearClock(); // New search area is progress for D5, and D4 still checks the path.
          }
        }
      }
      if (event.type === 'doctor_observation') {
        const home = point(event.home?.anchor);
        const id = home && [pointText(home), event.home.usable === true, event.home.finished === true].join(':');
        if (id && id !== homeMilestone) advanced = true;
        homeMilestone = id;
        if (observedProgress(event, frame)) advanced = true;
      }
      if (advanced) clearClock();
      if (['plan_step', 'build', 'farm', 'site_dig', 'site_fill', 'home_relocation_leg', 'explore_for'].includes(event.type)) waiting = false;
      working ||= event.type === 'plan_step' || event.type === 'build'
        || (event.type === 'behavior_started' && behavior?.startsWith('goal:'));
      return advanced;
    },
    ingest(event, frame, idle) {
      const { at, context } = frame;
      if (event.type !== 'doctor_observation') return undefined;
      if (!working || idle || waiting || event.isDay !== true || frame.waiting || !context.goal) {
        clearClock();
        return null;
      }
      if (previous && at - previous.at > settings.maxSampleGapMs) clearClock();
      since ||= mark(frame);
      previous = mark(frame);
      const elapsed = at - since.at;
      if (elapsed < settings.daylightMs) return null;
      return detect('daylight:' + since.evidence, since.at,
        (context.card || context.goal) + ' has spent ' + minutes(elapsed)
          + ' minutes working in daylight without completing a plan step or reaching a milestone.', [since, previous]);
    },
    reset() { clearGoal(); receipts.clear(); homeMilestone = null; },
    size() { return receipts.size + targets.size + pending.size; },
  };
}

function distanceAtDusk() {
  const settings = DOCTOR_RULE_THRESHOLDS.D6;
  let homeId = null;
  let prior = null;
  let departure = [];
  let late = null;
  let shelterStarted = null;
  let protection = null;
  let homeward = null;
  let outboundTarget = null;
  let interrupted = [];
  let lastLeg = null;
  let lastMineAt = null;
  function clearSamples() { prior = late = null; departure = []; }
  function clear() {
    clearSamples();
    homeId = shelterStarted = protection = homeward = outboundTarget = lastLeg = lastMineAt = null;
    interrupted = [];
  }
  function recent(witness, at, age = settings.evidenceMs) {
    return witness !== null && at - witness.at <= age;
  }
  function isNightEvent(event) { return event.type === 'night' || event.type === 'night_rest'; }
  return {
    ingest(event, frame) {
      const { at, context } = frame;
      const home = point(event.home?.anchor || context.home?.anchor);
      const time = event.timeOfDay ?? frame.context.timeOfDay;
      const dimension = event.dimension ?? frame.dimension;
      const sampling = event.type === 'doctor_observation';
      const outsideDusk = !Number.isFinite(time) || time < settings.duskTick || time >= settings.dawnTick;
      if (frame.inactive || !home || (sampling && outsideDusk)
        || (dimension && !['overworld', 'minecraft:overworld'].includes(dimension))) {
        clear();
        return null;
      }
      const duskHome = isNightEvent(event) && event.action === 'dusk_home';
      if (outsideDusk && !homeId && !duskHome) return undefined;
      const id = pointText(home);
      if (homeId !== id) clear();
      homeId = id;
      const diggingShelter = isNightEvent(event) && event.action === 'dig_in';
      if (duskHome || diggingShelter) {
        protection = { ...mark(frame), behavior: event.behavior, generation: event.generation, action: event.action };
        homeward = outboundTarget = null;
      }
      const sameProtection = recent(protection, at) && protection.behavior === event.behavior
        && protection.generation === event.generation;
      if (event.type === 'preempted' && sameProtection && ['provision', 'hunt'].includes(event.by)) {
        trim(interrupted, at, settings.evidenceMs);
        append(interrupted, { ...mark(frame), intent: protection.evidence }, settings.interruptions);
        protection = shelterStarted = null;
      }
      if (event.type === 'behavior_finished' && sameProtection) {
        if (event.ok === true && protection.action === 'dusk_home') {
          homeward = { ...mark(frame), behavior: protection.behavior, generation: protection.generation,
            startedAt: protection.at, intent: protection.evidence };
        }
        protection = null;
      }
      if (event.type === 'target_selected' && recent(homeward, at) && homeward.behavior === event.behavior
        && homeward.generation === event.generation) {
        const position = point(event.position);
        outboundTarget = position && distance(home, position) >= settings.nightDistance
          ? { ...mark(frame), position } : null;
      }
      if (isNightEvent(event) && ['dug_in', 'sleep'].includes(event.action)) protection = homeward = outboundTarget = null;
      if (event.type === 'home_route_leg' || event.type === 'home_route_arrived') {
        const destination = point(event.destination);
        const pos = point(event.position);
        const from = point(event.from);
        if (destination && pos && distance(home, destination) <= (context.home?.size ?? 5) + settings.homeRadiusSlack) {
          if (event.type === 'home_route_arrived') {
            clear();
            return null;
          }
          if (event.advanced === true && from && distance(home, pos) < distance(home, from)) {
            lastLeg = { ...mark(frame), distance: distance(home, pos) };
          }
        }
      }
      if ((isNightEvent(event) && ['dig_in', 'dug_in', 'sleep'].includes(event.action))
        || (event.type === 'behavior_started' && event.behavior === 'night_rest')) {
        if (!recent(shelterStarted, at, settings.nightMs)) shelterStarted = mark(frame);
      }
      if (['mine_return', 'mine_progress', 'mine_ore', 'mine_loot'].includes(event.type)) lastMineAt = at;
      if (!sampling) return undefined;
      const pos = point(event.position);
      const mine = pos && pos.y <= home.y - settings.mineDepth
        && (event.mining || (lastMineAt !== null && at - lastMineAt <= settings.evidenceMs));
      const emergency = ['escape', 'breathe', 'recover_drops', 'defend', 'avoid'].includes(frame.behavior);
      if (!pos || frame.waiting || mine || emergency) {
        clearSamples();
        return null;
      }
      const current = { ...mark(frame), distance: distance(home, pos) };
      if (prior && at - prior.at > settings.maxSampleGapMs) clearSamples();
      const lastSample = prior;
      const growth = lastSample ? current.distance - lastSample.distance : 0;
      if (growth < settings.legGrowth) departure = [current];
      else append(departure, current, settings.departureSamples);
      prior = current;
      const afterDark = event.isDay === false || (event.isDay !== true && time >= settings.nightTick);
      const recentlyReturning = recent(lastLeg, at, settings.maxSampleGapMs);
      trim(interrupted, at, settings.evidenceMs);
      const lastHomewardPoint = recentlyReturning ? lastLeg : lastSample;
      if (afterDark && current.distance >= settings.nightDistance && interrupted.length >= settings.interruptions
        && lastHomewardPoint && current.distance - lastHomewardPoint.distance >= settings.growth) {
        return detect('dusk:' + id, interrupted[0].at,
          'The bot is ' + Math.round(current.distance) + ' blocks from home after dark after two return or shelter attempts were interrupted.',
          [...interrupted.flatMap(row => [{ evidence: row.intent }, row]), lastHomewardPoint, current]);
      }
      if (afterDark && current.distance >= settings.nightDistance && growth >= settings.growth
        && recent(homeward, at) && recent(outboundTarget, at)
        && distance(pos, outboundTarget.position) <= (context.home?.size ?? 5) + settings.homeRadiusSlack) {
        return detect('dusk:' + id, homeward.startedAt, 'The bot ended its dusk return to pursue a new target and is now '
          + Math.round(current.distance) + ' blocks from home after dark.',
        [{ evidence: homeward.intent }, homeward, outboundTarget, lastSample, current]);
      }
      if (recent(shelterStarted, at, settings.maxSampleGapMs)) {
        late = null;
        departure = [current];
        return null;
      }
      if (current.distance >= settings.duskDistance && departure.length === settings.departureSamples && !recentlyReturning
        && at - departure[0].at >= settings.minimumMs && current.distance - departure[0].distance >= settings.growth) {
        const first = departure[0];
        return detect('dusk:' + id, first.at,
          'The bot is ' + Math.round(current.distance) + ' blocks from home '
          + (afterDark ? 'after dark' : 'at dusk')
          + ' after moving ' + Math.round(current.distance - first.distance) + ' blocks farther away.', departure);
      }
      if (afterDark && current.distance >= settings.nightDistance && !recentlyReturning && growth > -settings.legGrowth) {
        late ||= current;
        if (at - late.at >= settings.nightMs) {
          return detect('dusk:' + id, late.at, 'The bot remains ' + Math.round(current.distance)
            + ' blocks from home after dark without confirmed progress toward home or shelter.', [late, current]);
        }
      } else {
        late = null;
      }
      return null;
    },
    reset: clear,
    size() {
      return departure.length + interrupted.length
        + [prior, late, shelterStarted, protection, homeward, outboundTarget, lastLeg, lastMineAt]
          .filter(value => value !== null).length;
    },
  };
}

function directorIdle() {
  const settings = DOCTOR_RULE_THRESHOLDS.D7;
  const cooldowns = new Map();
  let idle = null;

  function idleDeadline(event, at) {
    if (event.reason === IDLE_REASON && Number.isFinite(event.until) && event.until > at) return { until: event.until };
    if (event.reason != null || !Array.isArray(event.scores)) return null;
    // Old idle records have scores without a reason or deadline. Corroborate
    // a card skipped for cooldown with an actual, still-live cooldown receipt.
    let current = null;
    for (const score of event.scores) {
      if (!score || typeof score !== 'object') continue;
      if (!score.skipped && score.score > 0) return null;
      const cooldown = score.skipped === 'cooldown' && cooldowns.get(shortText(score.id));
      if (cooldown?.until > at && (!current || cooldown.until < current.until)) current = cooldown;
    }
    return current;
  }

  return {
    ingest(event, frame) {
      if (event.type === 'autonomy_cooldown') {
        const card = shortText(event.card);
        if (card && Number.isFinite(event.until) && event.until > frame.at) {
          boundedSet(cooldowns, card, { until: event.until, receipt: mark(frame) }, settings.maxCooldowns);
        }
      }
      if (event.type === 'autonomy_idle') {
        const deadline = idleDeadline(event, frame.at);
        const start = idle && frame.at <= idle.until ? idle.start : mark(frame);
        idle = deadline ? { ...deadline, start } : null;
      }
      if (event.type === 'autonomy_disabled') cooldowns.clear();
      if (event.type === 'autonomy_choice' || event.type === 'goal_set' || event.type === 'autonomy_disabled') idle = null;
      if (!idle || frame.at >= idle.until) {
        idle = null;
        return null;
      }
      if (frame.waiting) {
        // A legitimate wait must not contribute to the two-minute idle clock.
        idle.start = mark(frame);
        return null;
      }
      if (frame.at - idle.start.at < settings.waitMs || frame.context.goal) return null;
      const receipts = idle.receipt ? [idle.receipt, idle.start, mark(frame)] : [idle.start, mark(frame)];
      return detect('idle:' + idle.start.evidence, idle.start.at,
        'The director has spent ' + minutes(frame.at - idle.start.at) + ' minutes waiting for a card to retry with no task running.',
        receipts);
    },
    reset() { idle = null; cooldowns.clear(); },
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
      if (event.type === 'autonomy_disabled' || frame.inactive) { clear(); return null; }

      const dawn = (event.type === 'doctor_observation' && event.isDay === true)
        || (['night', 'night_rest'].includes(event.type) && event.action === 'dug_out');
      for (const [key, entries] of cycles) {
        trim(entries, at, settings.windowMs);
        if (!entries.length || (dawn && entries[0].night)) cycles.delete(key);
      }
      if (active && (cycles.get(active.key)?.length ?? 0) < settings.count) active = null;

      if (event.type === 'autonomy_choice' && typeof event.card === 'string') {
        selected = { ...mark(frame), card: shortText(event.card), goal: shortText(event.goal), generation: null };
      } else if (event.type === 'goal_set' && selected && event.goal === selected.goal) {
        selected.generation = event.generation ?? null;
      } else if (GOAL_ENDED.has(event.type)) {
        const matching = selected && (event.card ? event.card === selected.card : event.goal === selected.goal)
          && (selected.generation === null || event.generation == null || event.generation === selected.generation);
        if (matching) {
          const waited = explicitWait(event.reason);
          // A rest can be physically correct while its short retry budget causes
          // the director to repeat an equivalent choice throughout one night.
          const night = waited && frame.isDay === false && event.waits >= settings.minWaitAttempts
            && event.waitMs > 0 && Number.isFinite(event.until) && event.until > at;
          if (event.type === 'goal_yielded' && (night || (!waited && !frame.waiting
            && event.reason !== 'waiting' && !Number.isFinite(event.waits)))) {
            const key = selected.card + (night ? ':night' : ':blocked');
            const entries = cycles.get(key) || [];
            append(entries, { ...mark(frame), selection: selected, night }, settings.count);
            boundedSet(cycles, key, entries, settings.maxCards);
            if (entries.length >= settings.count && active?.key !== key) {
              active = { key, first: entries[0].selection };
            }
          } else if (event.type === 'goal_done') {
            for (const key of [selected.card + ':blocked', selected.card + ':night']) {
              cycles.delete(key);
              if (active?.key === key) active = null;
            }
          }
          selected = null;
        }
      }

      if (!active) return null;
      const entries = cycles.get(active.key);
      const note = entries[0].night ? ' before the same night ended.' : ' in ' + minutes(settings.windowMs) + ' minutes.';
      return detect(active.key + ':' + active.first.evidence, active.first.at,
        'The director has selected and yielded the ' + active.first.card + ' card at least ' + settings.count
        + ' times' + note, [...entries.map((entry) => entry.selection), ...entries]);
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
