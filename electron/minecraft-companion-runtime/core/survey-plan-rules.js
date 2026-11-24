'use strict';

const { integerBox } = require('./geometry');
const { Vec3 } = require('vec3');
const { isSurveyPlant, isSurveyReplaceable } = require('./natural-cover');

// Mirror PlanCompiler.matchesExpect and TerrainRules. The same fixture is
// exercised against Minecraft's block registry by the Mod JUnit suite.
const NATURAL_GROUND = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud',
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block',
  'sand', 'red_sand', 'gravel', 'sandstone', 'red_sandstone', 'clay', 'snow', 'snow_block',
]);
const BENIGN_OPEN = /^(?:minecraft:.*_(?:door|trapdoor|fence_gate)|minecraft:barrel)$/;
const id = (state) => state?.split('[', 1)[0];
const name = (state) => id(state)?.startsWith('minecraft:') ? id(state).slice(10) : '';
const log = (state) => name(state).endsWith('_log') && !name(state).startsWith('stripped_');
const naturalLeaves = (state) => name(state).endsWith('_leaves') && /\bpersistent=false(?=[,\]])/.test(state);
const positionKey = ({ x, y, z }) => `${x},${y},${z}`;
const asVec = ({ x, y, z }) => new Vec3(x, y, z);
const FACE = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const FLUID = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);
const FLOOR = /(_sapling|_mushroom|_orchid|_fungus|_roots|_sign|_carpet|rail|_door|torch)$/;
const FLOOR_SET = new Set(['redstone_wire', 'wheat', 'carrots', 'potatoes', 'beetroots', 'bamboo', 'bamboo_sapling',
  'sugar_cane', 'cactus', 'sweet_berry_bush', 'nether_wart', 'melon_stem', 'pumpkin_stem']);
const containsColumn = (area, { x, z }, band = 0) => x >= area.minX - band && x <= area.maxX + band
  && z >= area.minZ - band && z <= area.maxZ + band;
const contains = (bounds, pos) => containsColumn(bounds, pos) && pos.y >= bounds.minY && pos.y <= bounds.maxY;

function stateName(block) {
  if (!block?.name) return null;
  const blockId = block.name.includes(':') ? block.name : `minecraft:${block.name}`;
  const props = block.getProperties?.() ?? {};
  const keys = Object.keys(props).sort();
  return keys.length ? `${blockId}[${keys.map((key) => `${key}=${props[key]}`).join(',')}]` : blockId;
}

function matchesState(expected, actual) {
  if (!actual) return false;
  if (expected === actual) return true;
  return BENIGN_OPEN.test(id(actual)) && expected.replace('open=true', 'open=false') === actual.replace('open=true', 'open=false');
}

function matchesTarget(block, target) {
  return matchesState(target, stateName(block));
}

const replaceable = (state) => isSurveyReplaceable(name(state)) && !/\bwaterlogged=true(?=[,\]])/.test(state);

function matchesExpectState({ kind, expect: expected, target }, actual, hasNaturalCanopy = () => false) {
  if (!actual) return false;
  if (kind === 'clear' || kind === 'cut') {
    return NATURAL_GROUND.has(name(actual)) || isSurveyPlant(name(actual)) || naturalLeaves(actual)
      || (log(actual) && (expected === actual || hasNaturalCanopy()));
  }
  if (kind === 'fill') return replaceable(actual);
  if (kind === 'build' || kind === 'furnish' || kind === 'scaffold') {
    return matchesState(expected, actual) || (replaceable(actual) && isSurveyReplaceable(name(expected)))
      || (kind === 'build' && expected === 'minecraft:dirt' && target === 'minecraft:farmland[moisture=0]'
        && id(actual) === 'minecraft:grass_block');
  }
  return false;
}

function leafAcrossBorder(bot, origin, bounds) {
  if (!contains(bounds, origin)) return true;
  if (origin.x - bounds.minX >= 6 && bounds.maxX - origin.x >= 6 && origin.z - bounds.minZ >= 6 && bounds.maxZ - origin.z >= 6
      && origin.y - bounds.minY >= 6 && bounds.maxY - origin.y >= 6) return false;
  const checked = new Set([positionKey(origin)]);
  let frontier = [origin];
  for (let step = 0; step < 6 && frontier.length; step += 1) {
    const nextFrontier = [];
    for (const pos of frontier) {
      for (const direction of Object.values(FACE)) {
        const next = pos.offset(...direction);
        const key = positionKey(next);
        if (checked.has(key)) continue;
        checked.add(key);
        if (!naturalLeaves(stateName(bot.blockAt(next)))) continue;
        if (!contains(bounds, next)) return true;
        nextFrontier.push(next);
      }
    }
    frontier = nextFrontier;
  }
  return false;
}

function walkTree(bot, origin, area, found) {
  const checked = new Set([positionKey(origin)]);
  const queue = [origin];
  for (let index = 0; index < queue.length; index += 1) {
    const pos = queue[index];
    if (found('log', pos)) return true;
    for (const [dx, dy, dz] of integerBox([-1, 1], [-1, 1], [-1, 1])) {
      const next = pos.offset(dx, dy, dz);
      const key = positionKey(next);
      if (checked.has(key)) continue;
      checked.add(key);
      const actual = stateName(bot.blockAt(next));
      if (naturalLeaves(actual) && found('leaf', next)) return true;
      if (log(actual) && containsColumn(area, next, 8)) queue.push(next);
    }
  }
  return false;
}

function matchesExpect(bot, op, block = bot.blockAt(asVec(op.pos))) {
  const origin = asVec(op.pos);
  const area = { minX: origin.x, maxX: origin.x, minZ: origin.z, maxZ: origin.z };
  return matchesExpectState(op, stateName(block), () => walkTree(bot, origin, area, (type) => type === 'leaf'));
}

function supportsBlock(attached, attachedPos, support) {
  if (!attached?.name) return false;
  const name = attached.name;
  const props = attached.getProperties?.() ?? {};
  const onFloor = support.equals(attachedPos.offset(0, -1, 0));
  const wall = FACE[props.facing] || FACE.north;
  if (props.face === 'floor') return onFloor;
  if (props.face === 'ceiling') return support.equals(attachedPos.offset(0, 1, 0));
  if (props.face === 'wall' || /^wall_|_wall_|^ladder$/.test(name)) return support.equals(attachedPos.offset(...wall.map((value) => -value)));
  if (name === 'vine') {
    return ['up', 'north', 'south', 'east', 'west'].some((side) => props[side] && support.equals(attachedPos.offset(...FACE[side])));
  }
  if (onFloor) return isSurveyPlant(name) || FLOOR.test(name) || FLOOR_SET.has(name);
  return name === 'sugar_cane' && support.y === attachedPos.y - 1
    && Math.abs(support.x - attachedPos.x) + Math.abs(support.z - attachedPos.z) === 1;
}

function removalConflict(bot, plan, operations) {
  const positions = new Set(operations.map((op) => positionKey(op.pos)));
  for (const op of operations) {
    const pos = asVec(op.pos);
    const actual = stateName(bot.blockAt(pos));
    if (plan.selection && !plan.clipTrees) {
      if (log(actual) && walkTree(bot, pos, plan.selection, (type, at) => type === 'leaf'
        ? leafAcrossBorder(bot, at, plan.selection) : !contains(plan.selection, at))
        || naturalLeaves(actual) && leafAcrossBorder(bot, pos, plan.selection)) return 'survey_cross_boundary_tree';
    }
    for (const at of [pos, ...Object.values(FACE).map((direction) => pos.offset(...direction))]) {
      const block = bot.blockAt(at);
      if (FLUID.has(block?.name) || block?.getProperties?.().waterlogged === true) return 'survey_adjacent_fluid';
    }
    for (let above = pos.offset(0, 1, 0); FALLING.has(bot.blockAt(above)?.name); above = above.offset(0, 1, 0)) {
      if (!positions.has(positionKey(above))) return 'survey_falling_column';
    }
    for (const [x, y, z] of integerBox([-1, 1], [-1, 1], [-1, 1])) {
      if (x === 0 && y === 0 && z === 0) continue;
      const at = pos.offset(x, y, z);
      if (!positions.has(positionKey(at)) && supportsBlock(bot.blockAt(at), at, pos)) return 'survey_outside_attachment';
    }
  }
  return null;
}

module.exports = { matchesExpect, matchesExpectState, matchesTarget, stateName, positionKey, replaceable, removalConflict };
