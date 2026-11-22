'use strict';

// Placement uses vanilla 1.21.8 BlockState.canReplace with another block
// item. Survey grants keep their existing, versioned terrain permissions.
const cover = new Map();
for (const [kind, surveyReplace, surveyPlant, paired, names] of [
  ['air', true, false, false, ['air', 'cave_air', 'void_air']],
  ['replace', true, true, false, ['short_grass', 'fern', 'dead_bush', 'bush',
    'short_dry_grass', 'tall_dry_grass', 'leaf_litter']],
  ['replace', true, true, true, ['tall_grass', 'large_fern']],
  ['snow', true, false, false, ['snow']],
  ['clear', false, true, false, ['firefly_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium',
    'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'pink_petals', 'wildflowers',
    'open_eyeblossom', 'closed_eyeblossom']],
  ['clear', false, true, true, ['sunflower', 'lilac', 'rose_bush', 'peony']],
  ['clear', false, false, false, ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
    'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling', 'mangrove_propagule',
    'azalea', 'flowering_azalea', 'red_mushroom', 'brown_mushroom']],
]) {
  for (const name of names) cover.set(name, { kind, surveyReplace, surveyPlant, paired });
}

const isAir = name => cover.get(name)?.kind === 'air';
const isSurveyPlant = name => cover.get(name)?.surveyPlant === true;
const isSurveyReplaceable = name => cover.get(name)?.surveyReplace === true;
const isWaterlogged = block => {
  const waterlogged = block?.getProperties?.().waterlogged;
  return waterlogged === true || waterlogged === 'true';
};

function naturalCover(block) {
  const entry = cover.get(block?.name);
  if (!entry || isWaterlogged(block)) return null;
  if (entry.kind === 'snow') return Number(block.getProperties?.().layers) === 1 ? 'replace' : 'clear';
  return entry.kind;
}

// Replacing or digging either half of these plants also removes the other.
function plantPartner(block, position, blockAt) {
  if (!cover.get(block?.name)?.paired) return null;
  const half = block.getProperties?.().half;
  if (half !== 'lower' && half !== 'upper') return null;
  const other = position.offset(0, half === 'lower' ? 1 : -1, 0);
  const partner = blockAt(other);
  return partner?.name === block.name && partner.getProperties?.().half === (half === 'lower' ? 'upper' : 'lower')
    ? other : null;
}

module.exports = { isAir, naturalCover, plantPartner, isSurveyPlant, isSurveyReplaceable, isWaterlogged };
