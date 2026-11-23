'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createFollowOwnerGoal } = require('../core/goals/followOwner');
const { validateTool } = require('../core-tools');
const { createAttempt, failure, waiting } = require('../core/action-result');

function fixture() {
  const owner = { type: 'player', position: new Vec3(20, 64, 0) };
  const bot = Object.assign(new EventEmitter(), { health: 20, entity: { position: new Vec3(0, 64, 0) }, players: { Owner: { entity: owner } } });
  bot.entities = { 0: bot.entity, 1: owner };
  const walks = [];
  const fights = [];
  const actions = {
    attack: async (_bot, _ctx, id) => { fights.push(bot.entities[id].name); delete bot.entities[id]; return { ok: true, died: true, hits: 2 }; },
    goNear: async (_bot, _ctx, target, range) => {
      walks.push([target.x, target.z, range]);
      bot.entity.position = target.offset(1, 0, 0);
      return { ok: true };
    },
  };
  const ctx = { signal: new AbortController().signal, record: () => {} };
  return { owner, bot, walks, fights, actions, ctx };
}

test('come walks to the owner and is done once near', async () => {
  const { bot, walks, actions, ctx } = fixture();
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', actions });
  assert.equal(goal.name, 'come_to_owner');
  assert.equal(goal.isDone(), false);
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.deepEqual(walks, [[20, 0, 2]]);
  assert.equal(goal.isDone(), true);
});

test('follow never finishes, counts catch-ups and waits beside a still owner', async () => {
  const { owner, bot, walks, actions, ctx } = fixture();
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', stay: true, actions });
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.equal(goal.progress(), 1);
  assert.deepEqual(await goal.run(ctx), waiting('owner_within_range'));
  owner.position = new Vec3(60, 64, 10);
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.equal(goal.progress(), 2);
  assert.equal(goal.isDone(), false);
  assert.equal(walks.length, 2);
});

test('an owner out of sight or moving away is reported, not walked to blindly', async () => {
  const { owner, bot, actions, ctx } = fixture();
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', actions: { goNear: async () => { owner.position = new Vec3(90, 64, 0); return { ok: true }; } } });
  assert.deepEqual(await goal.run(ctx), { ok: false, reason: 'owner_moved' });
  bot.players = {};
  assert.deepEqual(await createFollowOwnerGoal({ bot, owner: 'Owner', actions }).run(ctx), { ok: false, reason: 'owner_not_in_sight' });
});

test('a following bot guards the owner: hostiles nearby, and whatever hurt them', async () => {
  const { owner, bot, fights, actions, ctx } = fixture();
  bot.entity.position = new Vec3(19, 64, 0);
  const mob = (id, name, x, type = 'hostile') => { bot.entities[id] = { id, name, type, position: new Vec3(x, 64, 0) }; };
  mob(10, 'creeper', 24);
  mob(11, 'enderman', 22);
  mob(12, 'zombie', 40);
  mob(13, 'cow', 21, 'animal');
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', stay: true, actions });
  // Nothing worth a fight: a creeper, a calm enderman, a far zombie and a cow.
  assert.deepEqual(await goal.run(ctx), waiting('owner_within_range'));
  assert.deepEqual(fights, []);
  mob(16, 'phantom', 24);
  assert.deepEqual(await goal.run(ctx), waiting('owner_within_range'));
  assert.deepEqual(fights, []);
  delete bot.entities[16];
  mob(14, 'skeleton', 26);
  assert.deepEqual(await goal.run(ctx), waiting('guarding_owner'));
  assert.deepEqual(fights, ['skeleton']);
  bot.emit('entityHurt', owner);
  assert.deepEqual(await goal.run(ctx), waiting('guarding_owner'));
  assert.deepEqual(fights, ['skeleton', 'enderman']);
  // Hurt and low on health itself, the bot leaves fights to its survival behaviors.
  mob(15, 'zombie', 23);
  bot.health = 6;
  assert.deepEqual(await goal.run(ctx), waiting('recovering_near_owner'));
  assert.deepEqual(fights, ['skeleton', 'enderman']);
  goal.dispose();
  assert.equal(bot.listenerCount('entityHurt'), 0);
});

test('come does not fight or listen; it only walks', async () => {
  const { bot, fights, actions, ctx } = fixture();
  bot.entities[10] = { id: 10, name: 'zombie', type: 'hostile', position: new Vec3(22, 64, 0) };
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', actions });
  assert.equal(bot.listenerCount('entityHurt'), 0);
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.deepEqual(fights, []);
});

test('the owner comes from configuration only', () => {
  assert.throws(() => createFollowOwnerGoal({ bot: {}, owner: '' }), { code: 'no_owner' });
  assert.deepEqual(validateTool('followOwner', { stay: true }), { stay: true });
  assert.throws(() => validateTool('followOwner', { player: 'Someone' }), /unsupported/);
});

test('guarding the owner first keeps fighting at health that would otherwise stop it', async () => {
  const { bot, fights, actions, ctx } = fixture();
  bot.entity.position = new Vec3(19, 64, 0);
  bot.entities[20] = { id: 20, name: 'zombie', type: 'hostile', position: new Vec3(23, 64, 0) };
  bot.health = 6;
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', stay: true, actions });
  await goal.run(ctx);
  assert.deepEqual(fights, []);
  bot.companionGuardOwnerFirst = true;
  await goal.run(ctx);
  assert.deepEqual(fights, ['zombie']);
  assert.deepEqual(validateTool('setPolicy', { risk: 'bold', guard: 'owner_first' }), { risk: 'bold', guard: 'owner_first' });
  assert.throws(() => validateTool('setPolicy', { risk: 'reckless' }), /unsupported value/);
});

test('guarding the owner, self-defence fights the zombie at the owner before the one beside the bot', async () => {
  const { createSurvivalBehaviors } = require('../core/behaviors/survival');
  const owner = new Vec3(0, 64, 6);
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld', difficulty: 'hard' },
    inventory: { items: () => [{ name: 'stone_sword' }], slots: [] }, blockAt: () => null, health: 20,
    players: { LLMTester: { entity: { position: owner } } }, companionGuarding: 'LLMTester',
  });
  let goal = 'follow_owner';
  const attacked = [];
  const actions = { attack: async (_bot, _ctx, id) => { attacked.push(id); return { ok: true, died: true, hits: 3 }; } };
  const defend = createSurvivalBehaviors({ bot, actions, activeGoal: () => goal }).find((b) => b.name === 'defend');
  const zombie = (id, at) => ({ id, name: 'zombie', position: at, distance: at.distanceTo(bot.entity.position) });
  // Beside the bot (3.5 off, 7 from the owner), and on the owner (1 off them, 5 from the bot).
  const hostiles = [zombie(1, new Vec3(3.5, 64, -0.5)), zombie(2, new Vec3(1, 64, 6))].sort((a, b) => a.distance - b.distance);
  const state = { health: 20, food: 20, position: bot.entity.position, hostiles, inventory: { stone_sword: 1 }, sheltered: false, isDay: false };
  const ctx = { perceive: () => state, record: () => {}, signal: new AbortController().signal };
  await defend.run(ctx);
  assert.deepEqual(attacked, [2]);
  // Not guarding: the nearest one, as before.
  goal = 'gather_logs';
  await defend.run(ctx);
  assert.deepEqual(attacked, [2, 1]);
  // One already on the bot is fought first all the same.
  goal = 'follow_owner';
  hostiles.unshift(zombie(3, new Vec3(1, 64, 1)));
  await defend.run(ctx);
  assert.deepEqual(attacked, [2, 1, 3]);
});

test('hurt, with the zombies it fled still about, the bot keeps its distance instead of walking back past them', async () => {
  const { bot, walks, fights, actions, ctx } = fixture();
  bot.entities[30] = { id: 30, name: 'zombie', type: 'hostile', position: new Vec3(9, 64, 0) };
  bot.health = 6;
  const goal = createFollowOwnerGoal({ bot, owner: 'Owner', stay: true, actions });
  assert.deepEqual(await goal.run(ctx), waiting('recovering_near_owner'));
  assert.deepEqual(walks, []);
  assert.deepEqual(fights, []);
  // Healed, it goes back to the owner (and the zombie near them is the guard's).
  bot.health = 16;
  await goal.run(ctx);
  assert.equal(walks.length + fights.length, 1);
  // Hurt with nothing about, it follows as ever.
  const calm = fixture();
  calm.bot.health = 6;
  await createFollowOwnerGoal({ bot: calm.bot, owner: 'Owner', stay: true, actions: calm.actions }).run(calm.ctx);
  assert.deepEqual(calm.walks, [[20, 0, 2]]);
});

test('a near zombie on level ground is walked at directly; a hole, lava or a height step is left to the pathfinder', () => {
  const { directStep } = require('../core/actions');
  const ground = new Map();
  const blockAt = (p) => {
    const special = ground.get(`${p.x},${p.y},${p.z}`);
    if (special) return special;
    return p.y < 64 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, blockAt };
  const zombie = (x, y = 64) => ({ position: new Vec3(x, y, 0.5) });
  assert.equal(directStep(bot, zombie(4)), true);
  assert.equal(directStep(bot, zombie(8)), false, 'too far: the pathfinder');
  assert.equal(directStep(bot, zombie(4, 65)), false, 'up a block');
  ground.set('1,63,0', { name: 'air', boundingBox: 'empty' });
  assert.equal(directStep(bot, zombie(4)), false, 'a hole in the next step');
  ground.set('1,63,0', { name: 'lava', boundingBox: 'block' });
  assert.equal(directStep(bot, zombie(4)), false, 'lava');
  ground.delete('1,63,0');
  bot.entity.onGround = false;
  assert.equal(directStep(bot, zombie(4)), false, 'mid-air');
});

test('guarding, a fight is broken off for a zombie that reached the owner, not when hurt; a dead one is not fought again', async () => {
  const { createSurvivalBehaviors } = require('../core/behaviors/survival');
  const owner = new Vec3(0, 64, 0);
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(8, 64, 0) }, game: { dimension: 'overworld', difficulty: 'hard' },
    inventory: { items: () => [{ name: 'stone_sword' }], slots: [] }, blockAt: () => null, health: 20,
    players: { LLMTester: { entity: { position: owner } } }, companionGuarding: 'LLMTester',
  });
  const zombie = (id, at) => ({ id, name: 'zombie', position: at, distance: at.distanceTo(bot.entity.position) });
  // The one fought is eight from the owner, beside the bot; the other is still five out.
  const far = zombie(1, new Vec3(10, 64, 0));
  const other = zombie(2, new Vec3(-5, 64, 0));
  bot.entities = { 1: far, 2: other };
  const state = { health: 20, food: 20, position: bot.entity.position, hostiles: [far, other], inventory: { stone_sword: 1 }, sheltered: false, isDay: false };
  const records = [];
  const ctx = { perceive: () => state, record: (type, data) => records.push([type, data]), signal: new AbortController().signal };
  const attacked = [];
  let polls = [];
  const actions = { attack: async (_bot, _ctx, id, options) => {
    attacked.push(id);
    const yieldTo = options?.yieldTo;
    if (!yieldTo) return { ok: true, died: true, hits: 1 };
    polls.push(yieldTo());
    // The other walks up to the owner while the bot fights.
    other.position = new Vec3(-1, 64, 0);
    other.distance = other.position.distanceTo(bot.entity.position);
    await new Promise((r) => setTimeout(r, 320));
    polls.push(yieldTo());
    return polls.at(-1) ? { ok: true, died: false, hits: 1, yielded: true } : { ok: true, died: true, hits: 2 };
  } };
  const defend = createSurvivalBehaviors({ bot, actions, activeGoal: () => 'follow_owner' }).find((b) => b.name === 'defend');
  await defend.run(ctx);
  assert.deepEqual(attacked, [1]);
  assert.deepEqual(polls, [false, true]);
  assert.ok(records.some(([type, d]) => type === 'defend_switch' && d.toOwner === 1));
  assert.ok(records.some(([type, d]) => type === 'defend_result' && d.yielded === true));
  // Hurt, the one on the bot is fought out.
  other.position = new Vec3(-5, 64, 0);
  bot.health = 8;
  polls = [];
  await defend.run(ctx);
  assert.deepEqual(polls, [false, false]);
  // Dead (still in view for its death animation), it is no longer a target.
  bot.health = 20;
  bot.emit('entityDead', far);
  attacked.length = 0;
  polls = [];
  await defend.run(ctx);
  assert.deepEqual(attacked, [2]);
});

test('an attack yields at once when told something else needs the bot', async () => {
  const actions = require('../core/actions');
  const target = { id: 5, name: 'zombie', isValid: true, position: new Vec3(6, 64, 0), height: 1.95, width: 0.6 };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), onGround: true }, entities: { 5: target },
    inventory: { items: () => [], slots: [] }, heldItem: null,
    pathfinder: { goal: null, setGoal() {} }, clearControlStates() {}, setControlState() {},
  });
  const ctx = createAttempt({ signal: new AbortController().signal, record: () => {} });
  const result = await actions.attack(bot, ctx, 5, { yieldTo: () => true });
  assert.deepEqual(result, failure('combat_yielded', { died: false, hits: 0, yielded: true }, ctx));
});
