'use strict';
// One reading of the fight that every survival behavior follows.
//
// Escape, defend, hunting and fetching drops used to decide each on its own
// thresholds, so they took turns: one hit on a skeleton, run from a creeper,
// back to the skeleton, off after a rabbit with the skeleton still in range.
// Here the hostiles around the bot are weighed against what it can take on
// (weapon, armour, health) into a single stance:
//
//   retreat - outmatched, a creeper about to blow, or too hurt to stay
//   fight   - something worth fighting is in reach and the bot can win
//   alert   - hostiles about: no hunting, no going back for drops
//   calm    - nothing hostile within sight
//
// A retreat is held until the bot is clear or recovered, so the next tick
// does not send it straight back in.
//
// Holding ground (guarding the owner first, the model's call) takes on worse
// odds, and backs off only when the mobs beside it could finish it in one
// more round of hits, or from a creeper. Ignoring the odds outright got the
// bot killed: on hard two zombies took 9 health a round, from 8.8 to dead
// before a fixed line at 3 was ever crossed.
//
// Hard difficulty hits half again as hard as normal; easy, less.

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'breeze']);
// How much of a fight each mob is next to a zombie.
const WEIGHT = {
  husk: 1.1, spider: 1.2, cave_spider: 1.3, skeleton: 1.5, stray: 1.5, bogged: 1.5, pillager: 1.5,
  witch: 2, wither_skeleton: 2.5, blaze: 2, breeze: 2, vindicator: 4, ravager: 6, piglin_brute: 5,
  hoglin: 3, zoglin: 3, evoker: 4, vex: 1.5, warden: 50, slime: 0.8, magma_cube: 1, silverfish: 0.3, endermite: 0.3,
};
// Fighting strength by weapon. A healthy player beats one zombie bare-handed
// (twenty punches, knocking it back each time), so bare hands take on one
// zombie at full health and back off from two, or from one when hurt.
const WEAPON_POWER = { wooden: 2, golden: 2, stone: 3, iron: 3.5, diamond: 4.5, netherite: 5.5 };
const UNARMED = 1.3;
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const MELEE_REACH = 12;
const RANGED_REACH = 16;
const CREEPER_BLAST = 4;
const RETREAT_MIN_MS = 4000;
const RISK = { cautious: 0.7, normal: 1, bold: 1.4 };
const HOLD_GROUND = 1.5;
const HOLD_GROUND_HEALTH = 3;
const DIFFICULTY = { peaceful: 0, easy: 0.6, normal: 1, hard: 1.5 };
// One melee hit by difficulty (a zombie's; the weights scale the rest).
const HIT = { peaceful: 0, easy: 2, normal: 3, hard: 4.5 };

function weaponPower(inventory) {
  let best = UNARMED;
  for (const name of Object.keys(inventory || {})) {
    const [material, kind] = name.split('_');
    if (kind !== 'sword' && kind !== 'axe') continue;
    best = Math.max(best, (WEAPON_POWER[material] || 0) * (kind === 'axe' ? 0.9 : 1));
  }
  return best;
}

/** What the bot can take on right now: weapon, armour pieces worn or carried, and health. */
function capability(state) {
  const pieces = Object.keys(state.inventory || {}).filter((name) => ARMOR.test(name)).length;
  return weaponPower(state.inventory) * (1 + 0.2 * Math.min(4, pieces)) * Math.max(0, state.health) / 20;
}

/** Summed weight of the hostiles, each fading out with distance. */
function danger(hostiles, difficulty = 'normal') {
  let total = 0;
  for (const h of hostiles) {
    if (h.name === 'creeper') { total += h.distance <= CREEPER_BLAST + 2 ? 2 : 0; continue; }
    const reach = RANGED.has(h.name) ? RANGED_REACH : MELEE_REACH;
    const closeness = h.distance <= 4 ? 1 : Math.max(0, 1 - (h.distance - 4) / (reach - 4));
    total += (WEIGHT[h.name] ?? 1) * closeness;
  }
  return total * (DIFFICULTY[difficulty] ?? 1);
}

// A zombie a step out is on the bot within the second: one at 3.7 went
// uncounted, the line stayed at 4.5 from two, and the bot died at 8.5.
const BESIDE = 4.5;

/** What the melee mobs beside the bot take off in one round of hits. */
function roundOfHits(hostiles, difficulty = 'normal') {
  return hostiles.filter((h) => h.distance <= BESIDE && h.name !== 'creeper' && !RANGED.has(h.name))
    .reduce((sum, h) => sum + (HIT[difficulty] ?? 3) * Math.min(2, WEIGHT[h.name] ?? 1), 0);
}

function createStance({ now = Date.now, escapeHealth = 6, escapeRange = 6 } = {}) {
  let retreat = null; // { since, reason }
  let risk = 'normal';
  let last = null;

  /**
   * `hostiles`: the threats the survival behaviors already filtered (calm
   * neutrals left out), nearest first. `engage`: the target defend would pick.
   */
  function read(state, hostiles, engage, { holdGround = false, difficulty = 'normal' } = {}) {
    if (last && last.state === state) return last.reading;
    const time = now();
    const power = capability(state) * RISK[risk] * (holdGround ? HOLD_GROUND : 1);
    const threat = danger(hostiles, difficulty);
    const nearest = hostiles[0] || null;
    const creeper = hostiles.find((h) => h.name === 'creeper' && h.distance <= CREEPER_BLAST);
    let reason = null;
    const hurtAt = holdGround ? Math.max(HOLD_GROUND_HEALTH, roundOfHits(hostiles, difficulty)) : escapeHealth;
    if (creeper) reason = 'creeper';
    else if (nearest && state.health <= hurtAt && nearest.distance <= escapeRange) reason = 'hurt';
    else if (nearest && nearest.distance <= 6 && threat > power) reason = 'outmatched';
    if (reason) {
      if (!retreat) retreat = { since: time, reason };
      else retreat.reason = reason;
    } else if (retreat) {
      // Held until clear of them, or healed enough to win: not the moment the
      // nearest one steps back out of range.
      const clear = !hostiles.some((h) => h.distance <= 10);
      const recovered = state.health > hurtAt + 4 && threat <= power * 0.6;
      if (time - retreat.since >= RETREAT_MIN_MS && (clear || recovered)) retreat = null;
    }
    const stance = retreat ? 'retreat' : engage ? 'fight' : hostiles.length ? 'alert' : 'calm';
    const reading = { stance, reason: retreat?.reason ?? null, danger: Math.round(threat * 10) / 10,
      capability: Math.round(power * 10) / 10, risk };
    last = { state, reading };
    return reading;
  }

  return {
    read,
    /** Layer 3 (the model) can trade safety for persistence per task. */
    setRisk(level) {
      if (!Object.hasOwn(RISK, level)) throw new TypeError('risk must be cautious, normal or bold');
      risk = level;
      last = null;
    },
    reset() { retreat = null; last = null; },
  };
}

module.exports = { createStance, capability, danger, roundOfHits, weaponPower, RANGED };
