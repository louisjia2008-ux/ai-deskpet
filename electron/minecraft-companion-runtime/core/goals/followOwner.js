'use strict';
// Goal: walk to the owner player, and with `stay` keep following and guarding them.
//
// The owner is the one configured player name, never a tool argument. Only a
// player the server currently sends an entity for can be found: one too far
// away (beyond entity tracking) fails with owner_not_in_sight. Without `stay`
// the goal is done once the bot stands near the owner; with `stay` it never
// finishes and runs until cancelled, waiting while the owner stands still.
//
// While following, the bot fights hostile mobs close to the owner, and first
// any mob that just hurt the owner (a provoked enderman or piglin included).
// The bot's own survival behaviors still outrank this: low health, fire or a
// creeper next to the bot preempt the goal.

const defaultActions = require('../actions');
const { sleep } = require('../confirm');
const { isHostile } = require('../perception');

const NEAR = 3;
const RANGE = 2;
const LEG_MS = 15000;
const IDLE_MS = 1000;
const GUARD_RANGE = 8;
const LEASH = 16;
const GUARD_HEALTH = 8;
const OWNER_FIRST_HEALTH = 3;
const AGGRESSOR_MS = 15000;
const FIGHT_MS = 10000;
const GIVE_UP_MS = 30000;
// A creeper hit in melee explodes beside the owner; the rest outclass a bot.
const NEVER_ENGAGE = new Set(['creeper', 'warden', 'ravager', 'piglin_brute', 'hoglin', 'ghast', 'elder_guardian']);
// Left alone unless they hurt the owner: hitting them first starts the fight.
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin']);
const PROVOKERS = new Set([...NEUTRAL, 'spider', 'cave_spider', 'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'goat']);
// Out of reach in the air most of the time: chased, they kept the bot from the
// zombies on the ground. Fought only while swooping at the bot itself.
const FLYERS = new Set(['phantom', 'vex', 'blaze', 'bee']);
const SWOOP = 3;
// Hurt this far with hostiles this close, the bot keeps its distance and heals
// instead of walking back: having fled three zombies, it went back to the owner
// past them at 6 health and was dead two hits later.
const HURT_HOLD = 10;
const HURT_CLEAR = 16;

function createFollowOwnerGoal({ bot, owner, stay = false, actions = defaultActions, now = Date.now } = {}) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(owner)) {
    throw Object.assign(new Error('No owner player name is configured'), { code: 'no_owner' });
  }
  const ownerEntity = () => bot.players?.[owner]?.entity || null;
  const distance = () => {
    const entity = ownerEntity();
    return entity ? bot.entity.position.distanceTo(entity.position) : Infinity;
  };
  const near = () => distance() <= NEAR;
  // Each time a following bot catches up counts as progress, so a long follow
  // is not failed by path stalls accumulated over many separate walks.
  let arrivals = 0;
  const aggressors = new Map(); // entity id -> until
  const unreachable = new Map(); // entity id -> until

  // entityHurt names no attacker: blame the closest mob within melee reach of
  // the owner, or an archer that can see them.
  const onHurt = (entity) => {
    const me = ownerEntity();
    if (!me || entity !== me) return;
    const culprit = Object.values(bot.entities || {})
      .filter((e) => e !== bot.entity && e.type !== 'player' && e.position && !NEVER_ENGAGE.has(e.name)
        && (isHostile(e) || PROVOKERS.has(e.name)) && e.position.distanceTo(me.position) <= 4.5)
      .sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))[0];
    if (culprit) aggressors.set(culprit.id, now() + AGGRESSOR_MS);
  };
  if (stay) bot.on?.('entityHurt', onHurt);
  // Whom the bot guards, for self-defence to pick its fights by (survival.js).
  if (stay) bot.companionGuarding = owner;

  function holdingBack() {
    if (!(bot.health <= HURT_HOLD)) return false;
    return Object.values(bot.entities || {}).some((e) => e !== bot.entity && e.type !== 'player' && e.position
      && isHostile(e) && !NEUTRAL.has(e.name) && e.position.distanceTo(bot.entity.position) <= HURT_CLEAR);
  }

  function guardTarget() {
    const me = ownerEntity();
    // Too far behind (just respawned, say), the bot first catches up: the leash would end any fight at once.
    // Guarding the owner first (the model's call) keeps fighting until the bot is nearly dead.
    const floor = bot.companionGuardOwnerFirst ? OWNER_FIRST_HEALTH : GUARD_HEALTH;
    if (!me || !(bot.health > floor) || bot.entity.position.distanceTo(me.position) > LEASH) return null;
    const time = now();
    const candidates = [];
    for (const e of Object.values(bot.entities || {})) {
      if (e === bot.entity || e.type === 'player' || !e.position || (unreachable.get(e.id) || 0) > time) continue;
      const fromOwner = e.position.distanceTo(me.position);
      const provoked = (aggressors.get(e.id) || 0) > time;
      if (provoked ? fromOwner > LEASH : (fromOwner > GUARD_RANGE || !isHostile(e) || NEUTRAL.has(e.name) || NEVER_ENGAGE.has(e.name))) continue;
      if (Math.abs(e.position.y - me.position.y) > 4) continue;
      if (FLYERS.has(e.name) && e.position.distanceTo(bot.entity.position) > SWOOP) continue;
      candidates.push({ e, rank: (provoked ? 0 : 100) + fromOwner });
    }
    return candidates.sort((a, b) => a.rank - b.rank)[0]?.e || null;
  }

  async function guard(ctx, mob) {
    ctx.record('guard_target', { mob: mob.name, fromOwner: Math.round(mob.position.distanceTo(ownerEntity().position)) });
    // Stop a chase that drags the bot away from the owner.
    const leash = new AbortController();
    const check = setInterval(() => {
      const me = ownerEntity();
      const target = bot.entities?.[mob.id];
      if (!me || (target && target.position.distanceTo(me.position) > LEASH) || bot.entity.position.distanceTo(me.position) > LEASH + 4) {
        leash.abort('guard_leash');
      }
    }, 250);
    let result;
    try {
      result = await actions.attack(bot, { ...ctx, signal: AbortSignal.any([ctx.signal, leash.signal]) }, mob.id, { timeoutMs: FIGHT_MS });
    } catch (error) {
      if (ctx.signal?.aborted || !leash.signal.aborted) throw error;
      result = { ok: false, reason: 'guard_leash' };
    } finally {
      clearInterval(check);
    }
    if (result.ok) aggressors.delete(mob.id);
    else unreachable.set(mob.id, now() + GIVE_UP_MS);
    ctx.record('guard_result', { mob: mob.name, ok: result.ok, died: result.died === true, reason: result.reason });
    // Guarding is part of following, not a stalled walk.
    return { ok: true, waited: true };
  }

  return {
    name: stay ? 'follow_owner' : 'come_to_owner',
    // Following is open-ended: it reports how close it is, never a completion.
    isDone: () => !stay && near(),
    progress: () => (stay ? arrivals : Number(near())),
    async run(ctx) {
      const entity = ownerEntity();
      if (!entity) return { ok: false, reason: 'owner_not_in_sight' };
      const held = holdingBack();
      // Guarding the owner first (the model's call) still fights for them hurt.
      const mob = stay && (!held || bot.companionGuardOwnerFirst) ? guardTarget() : null;
      if (mob) return guard(ctx, mob);
      if (held) {
        ctx.record('following_owner', { owner, distance: Math.round(distance()), held: 'hurt' });
        await sleep(IDLE_MS, ctx.signal);
        return { ok: true, waited: true };
      }
      if (near()) {
        if (!stay) return { ok: true };
        await sleep(IDLE_MS, ctx.signal);
        return { ok: true, waited: true };
      }
      ctx.record('following_owner', { owner, distance: Math.round(distance()) });
      // A guarding bot turns from the walk as soon as something goes for the owner.
      const alarm = new AbortController();
      const watch = setInterval(() => { if ((stay && guardTarget()) || holdingBack()) alarm.abort('guard_alarm'); }, 250);
      let result;
      try {
        result = await actions.goNear(bot, { ...ctx, signal: AbortSignal.any([ctx.signal, alarm.signal]) }, entity.position.floored(), RANGE, { timeoutMs: LEG_MS });
      } catch (error) {
        if (ctx.signal?.aborted || !alarm.signal.aborted) throw error;
        return { ok: true, waited: true };
      } finally {
        clearInterval(watch);
      }
      if (alarm.signal.aborted) return { ok: true, waited: true };
      if (!near()) return result.ok ? { ok: false, reason: 'owner_moved' } : result;
      arrivals++;
      return { ok: true };
    },
    dispose() {
      bot.removeListener?.('entityHurt', onHurt);
      if (stay && bot.companionGuarding === owner) bot.companionGuarding = null;
    },
  };
}

module.exports = { createFollowOwnerGoal };
