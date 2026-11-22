'use strict';
// Blocks the bot itself placed lately: pillars and bridges the pathfinder
// builds, steps out of a hole. Gathering leaves them be. A world gathering
// cobblestone kept digging back the pillars it had just climbed on, fell,
// climbed again on new cobblestone, and never had more than a handful.

const { posKey } = require('./blacklist');

const KEEP_MS = 20 * 60 * 1000;

/** Wraps bot.placeBlock once; adds bot.companionPlacedRecently(position). */
function installPlacedMemory(bot, { keepMs = KEEP_MS, now = Date.now } = {}) {
  if (!bot || typeof bot.placeBlock !== 'function' || bot.placeBlock.companionPlaced) return () => {};
  const placed = new Map();
  const original = bot.placeBlock;
  const wrapped = function placeBlock(reference, face, ...rest) {
    try {
      if (reference?.position && face) {
        const key = posKey(reference.position.plus(face));
        placed.set(key, { at: now() });
      }
    } catch { /* never in the way of placing */ }
    return original.call(this, reference, face, ...rest);
  };
  wrapped.companionPlaced = true;
  bot.placeBlock = wrapped;
  bot.companionPlacedRecently = (position) => {
    const key = posKey(position);
    const entry = placed.get(key);
    if (!entry) return false;
    if (!entry.temporary && now() - entry.at > keepMs) { placed.delete(key); return false; }
    return true;
  };
  // An explicit temporary placement shares the ordinary placement ledger.
  // Keep only the server-confirmed block state and forget it after removal or
  // a change by someone else. An interrupted crossing may retry cleanup.
  bot.companionTemporaryBlocks = {
    remember(block) {
      const key = posKey(block.position);
      const entry = placed.get(key);
      if (entry) entry.temporary = { position: block.position, name: block.name, stateId: block.stateId };
    },
    list: () => [...placed.values()].flatMap(entry => entry.temporary ? [entry.temporary] : []),
    forget: (position) => placed.delete(posKey(position)),
  };
  return () => {
    if (bot.placeBlock === wrapped) bot.placeBlock = original;
    delete bot.companionPlacedRecently;
    delete bot.companionTemporaryBlocks;
  };
}

module.exports = { installPlacedMemory };
