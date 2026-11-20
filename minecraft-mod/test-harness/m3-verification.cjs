'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runtimeRequire, record } = require('./common.cjs');

const nbt = runtimeRequire('prismarine-nbt');
const registry = runtimeRequire('prismarine-registry')('1.21.8');
const Block = runtimeRequire('prismarine-block')(registry);
const dataDir = path.resolve(__dirname, '../src/main/resources/data/deskpet');
const AIR = 'minecraft:air';
const CARDINALS = ['north', 'east', 'south', 'west'];

function key(x, y, z) { return `${x},${y},${z}`; }
function posKey({ x, y, z }) { return key(x, y, z); }
function blockId(state) { return state.split('[')[0]; }

function canonical(id, properties = {}) {
  const sorted = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));
  return sorted.length ? `${id}[${sorted.map(([name, value]) => `${name}=${value}`).join(',')}]` : id;
}

function normalizeState(state) {
  const [id, properties] = state.replace(/\]$/, '').split('[', 2);
  return canonical(id, Object.fromEntries(properties ? properties.split(',').map((part) => part.split('=', 2)) : []));
}

function rotate(x, z, width, depth, turns) {
  switch (turns) {
    case 0: return [x, z];
    case 1: return [depth - 1 - z, x];
    case 2: return [width - 1 - x, depth - 1 - z];
    case 3: return [z, width - 1 - x];
    default: throw new Error(`Invalid rotation ${turns}`);
  }
}

async function templateTargets(plan) {
  const { id, anchor, rotation } = plan.template;
  const file = path.join(dataDir, 'structure', `${id}.nbt`);
  const template = nbt.simplify((await nbt.parse(await fs.readFile(file))).parsed);
  const [width, , depth] = template.size;
  const turns = rotation / 90;
  const tileWidth = turns % 2 ? depth : width;
  const tileDepth = turns % 2 ? width : depth;
  const { minX, maxX, minZ, maxZ } = plan.selection;
  const tilesX = id === 'wheat_field' ? Math.max(1, Math.floor((maxX - minX - 1) / tileWidth)) : 1;
  const tilesZ = id === 'wheat_field' ? Math.max(1, Math.floor((maxZ - minZ - 1) / tileDepth)) : 1;
  const palette = template.palette.map(({ Name, Properties }) => {
    const definition = registry.blocksByName[Name.split(':')[1]];
    assert.ok(definition, `Missing Minecraft block definition ${Name}`);
    const properties = { ...Block.fromStateId(definition.defaultState).getProperties(), ...Properties };
    if (CARDINALS.includes(properties.facing)) {
      properties.facing = CARDINALS[(CARDINALS.indexOf(properties.facing) + turns) % 4];
    }
    if (turns % 2 && ['x', 'z'].includes(properties.axis)) properties.axis = properties.axis === 'x' ? 'z' : 'x';
    return canonical(Name, properties);
  });
  const targets = new Map();
  for (const { pos: [x, y, z], state } of template.blocks) {
    const [rotX, rotZ] = rotate(x, z, width, depth, turns);
    for (let tx = 0; tx < tilesX; tx++) {
      for (let tz = 0; tz < tilesZ; tz++) {
        const pos = key(anchor.x + rotX + tx * tileWidth, anchor.y + y, anchor.z + rotZ + tz * tileDepth);
        targets.set(pos, palette[state]);
      }
    }
  }
  return targets;
}

function isInside(x, y, z, box) {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
}

function naturalGrassChange(before, after) {
  const earth = new Set(['minecraft:dirt', 'minecraft:grass_block']);
  return earth.has(blockId(before)) && earth.has(blockId(after));
}

function naturalFlows(before, after, box, targets) {
  const flow = new Map();
  const origins = [];
  for (const [x, y, z, oldState] of before) {
    const pos = key(x, y, z);
    if (blockId(oldState) !== 'minecraft:water' || blockId(after.get(pos) || '') !== 'minecraft:water'
        || targets.has(pos) || isInside(x, y, z, box)) continue;
    origins.push({ x, y, z, source: pos });
    flow.set(pos, pos);
  }
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  for (const { x, y, z, source } of origins) {
    for (const [dx, dy, dz] of directions) {
      const [nx, ny, nz] = [x + dx, y + dy, z + dz];
      const pos = key(nx, ny, nz);
      if (flow.has(pos) || targets.has(pos) || isInside(nx, ny, nz, box)) continue;
      if (!/^minecraft:water\[level=[1-9]\d*\]$/.test(after.get(pos) || '')) continue;
      flow.set(pos, source);
      origins.push({ x: nx, y: ny, z: nz, source });
    }
  }
  return flow;
}

async function verifyBlocks(plan, before, after, { normal = false, grade } = {}) {
  assert.equal(after.length, before.length);
  const byPos = new Map(after.map(([x, y, z, state]) => [key(x, y, z), normalizeState(state)]));
  const targets = new Map(plan.ops.map((op) => [posKey(op.pos), normalizeState(op.target)]));
  const template = await templateTargets(plan);
  const fills = new Set(plan.ops.filter((op) => op.kind === 'fill').map((op) => posKey(op.pos)));
  const flows = normal ? naturalFlows(before, byPos, plan.selection, targets) : new Map();
  const protectedKeys = new Set(plan.protected.map(posKey));
  const scaffolds = new Set(plan.ops.filter((op) => op.phase === 'remove_scaffold').map((op) => posKey(op.pos)));
  const footprintMismatches = [];
  const interior = [];
  const exterior = [];
  const natural = [];
  for (const [pos, target] of template) {
    if (!protectedKeys.has(pos) && byPos.get(pos) !== target) {
      footprintMismatches.push({ pos, target, actual: byPos.get(pos) });
    }
  }
  for (const [x, y, z, raw] of before) {
    const pos = key(x, y, z);
    const oldState = normalizeState(raw);
    const actual = byPos.get(pos);
    const within = isInside(x, y, z, plan.selection);
    const wanted = within ? targets.get(pos) ?? oldState : oldState;
    assert.ok(actual, `Missing snapshot cell ${pos}`);
    if (actual === wanted) continue;
    const change = { pos, before: oldState, expected: wanted, after: actual, insideSelection: within };
    if (normal && !targets.has(pos) && !protectedKeys.has(pos) && naturalGrassChange(oldState, actual)) {
      natural.push({ ...change, cause: 'Vanilla grass spread or grass death' });
    } else if (normal && fills.has(pos) && wanted === 'minecraft:dirt' && blockId(actual) === 'minecraft:grass_block') {
      natural.push({ ...change, cause: 'Grass spread onto the authorized dirt fill at the same grade' });
    } else if (!within && oldState === AIR && flows.has(pos)) {
      natural.push({ ...change, cause: 'Flowing water reached this cell from existing generated water', source: flows.get(pos) });
    } else if (within) {
      interior.push(change);
    } else {
      exterior.push(change);
    }
  }
  const scaffoldRemains = [...scaffolds].filter((pos) => byPos.get(pos) !== AIR);
  const gradingIssues = [];
  for (const op of plan.ops) {
    if (['clear', 'cut'].includes(op.kind) && op.pos.y < plan.groundY) gradingIssues.push({ operation: op, problem: 'cut below grade' });
    if (op.kind === 'fill' && (op.pos.y >= plan.groundY || op.pos.y < plan.groundY - plan.fillDepthLimit)) {
      gradingIssues.push({ operation: op, problem: 'fill outside authorized depth' });
    }
  }
  if (grade) {
    for (const [pos, wanted] of grade) {
      if (blockId(byPos.get(pos) || '') !== wanted) gradingIssues.push({ pos, expected: wanted, actual: byPos.get(pos) });
    }
  }
  record('m3-block-comparison', {
    cells: before.length, exactTemplateCells: template.size, scaffolds: [...scaffolds],
    footprintMismatches, interior, exterior, natural, scaffoldRemains, gradingIssues,
  });
  assert.deepEqual({ footprintMismatches, interior, exterior, scaffoldRemains, gradingIssues }, {
    footprintMismatches: [], interior: [], exterior: [], scaffoldRemains: [], gradingIssues: [],
  });
}

function itemStacks(snbt) {
  const totals = {};
  const damage = {};
  // Modern vanilla item stacks expose the lower-case fields `id` and `count`.
  const stacks = snbt.slice(snbt.indexOf('[') + 1, snbt.lastIndexOf(']')).trim();
  for (const stack of stacks ? stacks.split(/},\s*(?=\{\s*(?:count|Slot|components|id)\s*:)/) : []) {
    const count = stack.match(/\bcount:\s*(\d+)/)?.[1];
    const id = stack.match(/\bid:\s*"([\w:]+)"/)?.[1];
    assert.ok(count && id, `Unreadable item stack: ${stack}`);
    const durabilityUsed = Number(stack.match(/"minecraft:damage"\s*:\s*(\d+)/)?.[1] || 0);
    totals[id] = (totals[id] || 0) + Number(count);
    if (durabilityUsed) damage[id] = (damage[id] || 0) + durabilityUsed;
  }
  return { totals, damage };
}

async function inventories(rcon, chest) {
  const chestNbt = await rcon.command(`data get block ${chest.x} ${chest.y} ${chest.z} Items`);
  const botNbt = await rcon.command('data get entity DeskPetBot Inventory');
  assert.match(chestNbt, /following block data/);
  assert.match(botNbt, /following entity data/);
  const chestState = itemStacks(chestNbt);
  const botState = itemStacks(botNbt);
  return { chest: chestState.totals, bot: botState.totals, chestDamage: chestState.damage, botDamage: botState.damage };
}

function verifyMaterials(plan, before, after, replenished = {}, { normal = false } = {}) {
  const { required, excavated } = plan.materials;
  const entries = [...new Set([...Object.keys(required), ...Object.keys(excavated), 'minecraft:bucket'])].sort();
  const accounting = entries.map((item) => {
    const chestWithdrawal = (before.chest[item] || 0) + (replenished[item] || 0) - (after.chest[item] || 0);
    const botNetChange = (after.bot[item] || 0) - (before.bot[item] || 0);
    let expectedUse = required[item] || 0;
    const expectedFromDigging = excavated[item] || 0;
    if (item === 'minecraft:dirt') {
      expectedUse = plan.ops.filter((op) => blockId(op.target) === item && op.kind !== 'scaffold').length;
    }
    if (item.endsWith('_hoe')) expectedUse = 0;
    if (item === 'minecraft:bucket') expectedUse = -(required['minecraft:water_bucket'] || 0);
    return { item, chestWithdrawal, botNetChange, actualNetUse: chestWithdrawal - botNetChange,
      listed: required[item] || 0, expectedUse, expectedFromDigging };
  });
  record('m3-material-accounting', { before, after, replenished, accounting });
  const mismatches = accounting.filter((row) => (!normal || !row.expectedFromDigging)
    && row.actualNetUse !== row.expectedUse - row.expectedFromDigging);
  const retainedSalvage = accounting.filter((row) => /:(?:dirt|coarse_dirt|rooted_dirt|cobblestone|cobbled_deepslate|stone|.+_log)$/.test(row.item)
    && row.botNetChange > 0);
  assert.deepEqual({ mismatches, retainedSalvage }, { mismatches: [], retainedSalvage: [] });
  if (plan.template.id === 'wheat_field') {
    const hoe = 'minecraft:stone_hoe';
    assert.equal(before.chest[hoe], 1);
    assert.equal(after.chest[hoe], 1, 'The Core must return the stone hoe to the material chest');
    const expectedUses = plan.ops.filter((op) => op.phase === 'till').length;
    const spent = (after.chestDamage[hoe] || 0) - (before.chestDamage[hoe] || 0);
    assert.equal(spent, expectedUses, 'Each hoe action must consume exactly one point of vanilla durability');
    record('m3-farm-hoe-durability', { item: hoe, spent, expectedUses });
  }
}

module.exports = { inventories, verifyBlocks, verifyMaterials };
