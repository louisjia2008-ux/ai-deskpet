'use strict';

const D1 = Object.freeze({
  sampleIntervalMs: 30_000,
  maxGapMs: 45_000, // A missed 30 s sample cannot prove continuous immobility.
  movementBlocks: 2, // Preserve the audit's 3D radius, including vertical escape.
  warnMs: 150_000,
  alertMs: 300_000,
});
const MAX_INVENTORY_TYPES = 64; // The game has fewer distinct occupied inventory slots.
const MINING = new Set(['mined', 'mine_progress', 'mine_ore', 'mine_loot']);

function point(value) {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
  return { x: value.x, y: value.y, z: value.z };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function sameInventory(a, b) {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([key, count]) => b[key] === count);
}

function inventoryCounts(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, MAX_INVENTORY_TYPES)
    .filter(([, count]) => Number.isFinite(count)));
}

function insideHome(home, position) {
  const anchor = home?.anchor;
  const size = home?.size ?? 5;
  return Boolean(anchor && position && anchor.x + 1 <= position.x && position.x < anchor.x + size - 1
    && anchor.z + 1 <= position.z && position.z < anchor.z + size - 1
    && anchor.y <= position.y && position.y < anchor.y + 1);
}

function createStationaryRule(onSegment) {
  let previous = null;
  let origin = null;
  let cards = new Set();
  let lastMining = null;
  let missing = 0;

  function close() {
    if (onSegment && origin && previous.at > origin.at) {
      onSegment({ at: origin.at, finish: previous.at, position: origin.position, cards: [...cards].sort() });
    }
    origin = null;
    cards = new Set();
  }

  return {
    reset() {
      close();
      previous = lastMining = null;
    },
    ingest(event, frame) {
      if (event.result?.wait && frame.scheduledWait) close();
      if (MINING.has(event.type)) lastMining = event.at;
      if (event.type !== 'doctor_observation') return undefined;

      const position = point(event.position);
      const at = event.at;
      if (!position || !Number.isFinite(at)) {
        close();
        previous = null;
        missing += 1;
        return null;
      }
      const gap = previous && (at <= previous.at || at - previous.at > D1.maxGapMs);
      if (gap) missing += 1;
      const owner = point(event.ownerPosition);
      const following = frame.context.goal === 'follow_owner' && owner && previous?.owner
        && distance(owner, position) <= 3 && distance(owner, previous.owner) < 1;
      const nightShelter = event.isDay === false && ((event.stationarySheltered ?? event.sheltered)
        || (event.sleeping === true && insideHome(frame.context.home, position)));
      const waiting = frame.scheduledWait || frame.context.goal === 'survey_plan' || event.survey === true
        || event.paused === true || following || nightShelter;
      const inventory = inventoryCounts(event.inventory);
      // A task label, idle cooldown or a bare dig animation cannot exempt a stall.
      const mining = previous && !gap && previous.inventory && inventory && !sameInventory(previous.inventory, inventory)
        && (previous.mining || event.mining || (lastMining > previous.at && lastMining <= at));
      const alive = event.alive !== false;
      const moved = origin && (event.dimension !== origin.dimension || distance(position, origin.position) >= D1.movementBlocks);
      if (origin && (waiting || !alive || mining || gap || moved)) close();

      previous = { at, position, dimension: event.dimension, inventory, mining: event.mining, owner, evidence: frame.evidence };
      if (!origin && alive && !waiting) origin = previous;
      if (!origin) return null;
      if (onSegment && cards.size < 64) cards.add(frame.context.card || '无卡片');
      const elapsed = at - origin.at;
      if (elapsed < D1.warnMs) return null;
      const place = ['x', 'y', 'z'].map(axis => Math.floor(origin.position[axis])).join(', ');
      return { severity: elapsed >= D1.alertMs ? 'alert' : 'warn', since: origin.at,
        summary: `The bot has stayed within ${D1.movementBlocks} blocks of (${place}) for ${Math.floor(elapsed / 1000)} seconds without a confirmed wait.`,
        evidence: [origin.evidence, frame.evidence], key: origin.at };
    },
    finish: close,
    missing: () => missing,
    size: () => [origin, previous].filter(value => value !== null).length,
  };
}

module.exports = { createStationaryRule, D1, point, insideHome };
