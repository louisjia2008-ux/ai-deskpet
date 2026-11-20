'use strict';

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { sleep, waitUntil } = require('./confirm');

const DOWN = 0;
const UP = 1;
const FACES = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1),
  new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
];
const FACE_ORDER = [UP, 2, 3, 4, 5, DOWN];
const DIRECTIONS = { north: FACES[2], south: FACES[3], west: FACES[4], east: FACES[5] };
const INTERACTIVE = /(_door|_trapdoor|_gate|_bed|_button|chest|barrel|crafting_table|furnace)$/;
const HAZARDOUS = /lava|water|fire|magma|campfire|cactus|powder_snow|sweet_berry_bush/;
const REACH = 4.35;
const vec = ({ x, y, z }) => new Vec3(x, y, z);

function placementSpec(target) {
  const [id, properties = ''] = target.replace(/^minecraft:/, '').split('[');
  const state = Object.fromEntries(properties.replace(/\]$/, '').split(',').filter(Boolean).map((pair) => pair.split('=')));
  return { id, ...state };
}

function facing(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
}

function expectedLook(spec) {
  const direction = DIRECTIONS[spec.facing];
  if (!direction) return null;
  const opposite = spec.id === 'chest' || spec.id === 'furnace';
  return opposite ? facing(direction, new Vec3(0, 0, 0)) : spec.facing;
}

function samples(block, face, varied) {
  const normal = FACES[face];
  const axis = normal.x ? 0 : normal.y ? 1 : 2;
  const points = [];
  for (const shape of block.shapes) {
    const plane = shape[axis + (normal.x + normal.y + normal.z > 0 ? 3 : 0)];
    const values = varied ? [0.5, 0.25, 0.75] : [0.5];
    for (const u of values) {
      for (const v of values) {
        const p = [u, v, v];
        if (axis === 0) p[1] = u;
        if (axis === 2) p[1] = v;
        const delta = p.map((q, i) => i === axis ? plane : shape[i] + (shape[i + 3] - shape[i]) * q);
        points.push(block.position.offset(...delta));
      }
    }
  }
  return points;
}

function cast(bot, eye, point, block, face) {
  const delta = point.minus(eye);
  const distance = delta.norm();
  if (distance > REACH || distance < 0.01) return null;
  const hit = bot.world.raycast(eye, delta.scaled(1 / distance), distance + 0.01);
  return hit?.position.equals(block.position) && (face === undefined || hit.face === face) ? hit : null;
}

function intersectsBody(feet, blockPos) {
  return feet.x + 0.31 > blockPos.x && feet.x - 0.31 < blockPos.x + 1 &&
    feet.z + 0.31 > blockPos.z && feet.z - 0.31 < blockPos.z + 1 &&
    feet.y + 1.8 > blockPos.y && feet.y < blockPos.y + 1;
}

function digHit(bot, feet, eye, pos) {
  if (pos.x === Math.floor(feet.x) && pos.z === Math.floor(feet.z) && pos.y >= feet.y - 1) return null;
  const block = bot.blockAt(pos);
  if (!block) return null;
  if (!block.shapes.length) {
    // Prismarine collision rays omit plants. The segment to their center must still be unobstructed.
    const point = pos.offset(0.5, 0.5, 0.5);
    const delta = point.minus(eye);
    const distance = delta.norm();
    if (distance < REACH && distance > 0.01 && !bot.world.raycast(eye, delta.scaled(1 / distance), distance)) return { block, point };
    return null;
  }
  for (const face of FACE_ORDER) {
    for (const point of samples(block, face, true)) {
      if (cast(bot, eye, point, block, face)) return { block, point, face: FACES[face] };
    }
  }
  return null;
}

function doorHinge(bot, pos, spec, local) {
  const direction = DIRECTIONS[spec.facing];
  const left = new Vec3(direction.z, 0, -direction.x);
  const right = left.scaled(-1);
  const count = (side) => [0, 1].filter((dy) => bot.blockAt(pos.plus(side).offset(0, dy, 0))
    ?.shapes.some((shape) => shape.every((n, i) => n === (i < 3 ? 0 : 1)))).length;
  const balance = count(right) - count(left);
  if (balance !== 0) return balance > 0 ? 'right' : 'left';
  const { x, z } = direction;
  return (x < 0 && local.z < 0.5) || (x > 0 && local.z > 0.5)
    || (z < 0 && local.x > 0.5) || (z > 0 && local.x < 0.5) ? 'right' : 'left';
}

function buildHit(bot, feet, eye, step, spec, used) {
  const pos = vec(step[0].pos);
  const tool = spec.id === 'farmland';
  const waterBucket = spec.id === 'water';
  const solid = !['farmland', 'water', 'wheat', 'torch'].includes(spec.id);
  if (solid && step.some((op) => intersectsBody(feet, vec(op.pos)))) return null;
  const look = expectedLook(spec);
  const faces = ['farmland', 'wheat', 'torch'].includes(spec.id) || spec.id.endsWith('_door') || spec.id.endsWith('_bed')
    ? [UP] : FACE_ORDER;
  for (const face of faces) {
    const axis = FACES[face].x ? 'x' : FACES[face].y ? 'y' : 'z';
    if (spec.axis && spec.axis !== axis) continue;
    const block = bot.blockAt(tool ? pos : pos.minus(FACES[face]));
    if (!block?.shapes.length || HAZARDOUS.test(block.name)) continue;
    if (block.name === spec.id && spec.id.endsWith('_slab') && face === UP) continue;
    if (waterBucket && face === DOWN) continue;
    const varied = Boolean(look || spec.half || spec.type || block.shapes.length > 1);
    for (const point of samples(block, face, varied)) {
      const local = point.minus(block.position);
      if (look && facing(eye, point) !== look) continue;
      const half = spec.id.endsWith('_stairs') ? spec.half : spec.id.endsWith('_slab') ? spec.type : null;
      if (half && (face === DOWN || (face !== UP && local.y > 0.5)) !== (half === 'top')) continue;
      if (spec.hinge && doorHinge(bot, pos, spec, local) !== spec.hinge) continue;
      if (waterBucket && (bot.blockAt(pos)?.shapes.length || FACES.some((normal, dir) =>
        dir !== UP && !bot.blockAt(pos.plus(normal))?.shapes.length))) continue;
      const hit = cast(bot, eye, point, block, face);
      if (!hit) continue;
      const key = `${feet.floored()};${face};${point}`;
      if (!used.has(key)) return { block, face, point, local, key, waterBucket, look };
    }
  }
  return null;
}

function eyeAt(bot, feet) {
  return feet.offset(0, bot.entity.eyeHeight || 1.62, 0);
}

function hitFor(bot, step, feet, used) {
  const pos = vec(step[0].pos);
  if (feet.distanceTo(pos.offset(0.5, 0, 0.5)) > 6) return null;
  const eye = eyeAt(bot, feet);
  if (step[0].target === 'minecraft:air') return digHit(bot, feet, eye, pos);
  return buildHit(bot, feet, eye, step, placementSpec(step[0].target), used);
}

function standingPoint(bot, pos) {
  const ground = bot.blockAt(pos.offset(0, -1, 0));
  const feet = bot.blockAt(pos);
  const head = bot.blockAt(pos.offset(0, 1, 0));
  if (!ground?.shapes.length || HAZARDOUS.test(ground.name) || !feet || !head ||
      feet.shapes.length || head.shapes.length || HAZARDOUS.test(feet.name) || HAZARDOUS.test(head.name)) return null;
  const support = ground.shapes.filter((box) => box[0] <= 0.5 && box[3] >= 0.5 && box[2] <= 0.5 && box[5] >= 0.5);
  if (!support.length) return null;
  const height = Math.max(...support.map((box) => box[4]));
  if (height < 0.5) return null;
  return pos.offset(0.5, height - 1, 0.5);
}

function stationChoices(bot, step, used) {
  const pos = vec(step[0].pos);
  const stations = [];
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      if (x * x + z * z > 20) continue;
      for (let y = -4; y <= 3; y++) {
        const cell = pos.offset(x, y, z);
        const feet = standingPoint(bot, cell);
        if (!feet || !hitFor(bot, step, feet, used)) continue;
        stations.push(cell);
      }
    }
  }
  return stations.sort((a, b) => a.distanceSquared(bot.entity.position) - b.distanceSquared(bot.entity.position));
}

async function openDoorIfVisible(bot, ctx, plan) {
  const door = plan.template?.door;
  if (!door) return false;
  const block = bot.blockAt(vec(door));
  if (!block?.name.endsWith('_door') || block.getProperties().open) return false;
  const eye = eyeAt(bot, bot.entity.position);
  if (!cast(bot, eye, block.position.offset(0.5, 0.5, 0.5), block)) return false;
  return (await actions.openSurveyDoor(bot, ctx, block)).ok;
}

async function closePlanDoor(bot, ctx, plan, onFailure) {
  const door = plan.template?.door;
  if (!door) return { ok: true };
  const pos = vec(door);
  const open = bot.blockAt(pos)?.getProperties().open === true;
  if (!open) return { ok: true };
  const step = [{ pos, target: 'minecraft:air' }];
  const used = new Set();
  const usable = () => hitFor(bot, step, bot.entity.position, used);
  const hit = usable() || await walkToStations(bot, ctx, plan, stationChoices(bot, step, used), usable, onFailure);
  if (!hit) return { ok: false, reason: 'door_station_unreachable', pos: door };
  return actions.closeSurveyDoor(bot, ctx, hit.block);
}

async function walkToStations(bot, ctx, plan, stations, usable, onFailure) {
  const remaining = [...stations];
  for (let attempt = 0; attempt < 3 && remaining.length; attempt++) {
    const goal = new goals.GoalCompositeAny(remaining.map((p) => new goals.GoalBlock(p.x, p.y, p.z)));
    const moved = await actions.goTo(bot, ctx, goal, {
      timeoutMs: 12000, retryNoProgress: false,
      arrived: (at) => goal.isEnd(at.floored()) || goal.isEnd(at.offset(0, 0.51, 0).floored()) || Boolean(usable()),
    });
    if (await waitUntil(() => bot.entity.onGround, { signal: ctx.signal, timeoutMs: 350 })) {
      const hit = usable();
      if (hit) return hit;
    }
    const here = bot.entity.position;
    onFailure(moved.ok ? 'station_unusable' : moved.reason, {
      feet: { x: here.x, y: here.y, z: here.z }, candidates: remaining.length,
    });
    if (!moved.ok && await openDoorIfVisible(bot, ctx, plan)) continue;
    const previous = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].distanceTo(here) < 1.4) remaining.splice(i, 1);
    }
    if (previous === remaining.length && !moved.ok) return null;
  }
  return null;
}

async function climbSurveyScaffold(bot, ctx, plan, onFailure) {
  const steps = plan.ops.filter((op) => op.phase === 'remove_scaffold' && op.pos.y > plan.groundY)
    .sort((a, b) => b.pos.y - a.pos.y);
  const latest = steps.find((op) => bot.blockAt(vec(op.pos))?.name === 'dirt');
  if (!latest) return;
  const top = vec(latest.pos).offset(0, 1, 0);
  if (bot.entity.position.y >= top.y - 0.1) return;
  const goal = new goals.GoalBlock(top.x, top.y, top.z);
  const arrived = (pos) => pos.y >= top.y - 0.1 && Math.hypot(pos.x - top.x - 0.5, pos.z - top.z - 0.5) < 0.7;
  let walk = await actions.goTo(bot, ctx, goal, { timeoutMs: 10000, retryNoProgress: false, arrived });
  if (!walk.ok && await openDoorIfVisible(bot, ctx, plan)) {
    walk = await actions.goTo(bot, ctx, goal, { timeoutMs: 10000, retryNoProgress: false, arrived });
  }
  if (!walk.ok) onFailure(walk.reason, {
    feet: bot.entity.position, scaffoldTop: { x: top.x, y: top.y, z: top.z },
  });
}

async function aimAndPlace(bot, ctx, target, hit, item) {
  if (!item) return { ok: false, reason: 'no_material' };
  const sneak = INTERACTIVE.test(hit.block.name);
  let dispatched;
  try {
    await bot.equip(item, 'hand');
    if (sneak) {
      bot.setControlState('sneak', true);
      await sleep(60, ctx.signal);
    }
    await bot.lookAt(hit.point, true);
    // Mineflayer schedules the actual rotation packet on its next physics tick.
    if (hit.look || hit.waterBucket) await sleep(65, ctx.signal);
    const eye = eyeAt(bot, bot.entity.position);
    const reference = bot.blockAt(hit.block.position);
    if (!reference || reference.stateId !== hit.block.stateId || !cast(bot, eye, hit.point, reference, hit.face)) {
      return { ok: false, reason: 'placement_face_changed' };
    }
    const { yaw, pitch } = bot.entity;
    const view = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    if (hit.look && facing(eye, eye.plus(view)) !== hit.look) return { ok: false, reason: 'placement_face_changed' };
    if (hit.waterBucket) {
      const actual = bot.world.raycast(eye, view, REACH);
      if (!actual?.position.equals(reference.position) || actual.face !== hit.face) {
        return { ok: false, reason: 'placement_face_changed' };
      }
    }
    dispatched = actions.surveyPlace(bot, ctx, {
      pos: target, reference: hit.waterBucket ? null : reference.position,
      run: () => {
        if (hit.waterBucket) return bot.activateItem();
        return bot._genericPlace(reference, FACES[hit.face], { forceLook: 'ignore', delta: hit.local, swingArm: 'right' });
      },
    });
    return dispatched;
  } finally {
    if (sneak) bot.setControlState('sneak', false);
  }
}

module.exports = { vec, placementSpec, hitFor, stationChoices, walkToStations, aimAndPlace,
  openDoorIfVisible, closePlanDoor, climbSurveyScaffold };
