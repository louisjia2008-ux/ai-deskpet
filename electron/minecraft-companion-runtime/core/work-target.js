'use strict';

const { failure, rescueOf } = require('./action-result');

const active = new WeakMap();
const hazardReasons = {
  breathe: 'target_needs_breath',
  leave_lava: 'target_near_lava',
  leave_fire: 'target_near_fire',
  leave_contact: 'target_near_contact_hazard',
  unbury: 'target_causes_suffocation',
};
const hazardTarget = (bot, position, entity) => ({
  purpose: 'target_hazard', position, entity,
  dimension: String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, ''),
});

async function withWorkTarget(bot, ctx, position, run, entity) {
  const { bodySignal: signal = ctx.signal, behavior } = ctx;
  const ledger = bot.companionFailureLedger;
  if (!position || !signal || !ledger || active.has(signal) || rescueOf(ctx)
      || !(behavior?.startsWith('goal:') || behavior === 'provision')) return run();
  const spec = hazardTarget(bot, { ...position }, entity);
  if (ledger.skip(spec)) return failure('target_excluded', { target: spec }, ctx);
  active.set(signal, { ledger, spec, ctx });
  try {
    return await run();
  } finally {
    active.delete(signal);
  }
}

function interruptedWork(signal, by) {
  const work = active.get(signal), reason = hazardReasons[by];
  if (work && reason) work.ledger.workInterrupted(work.spec, reason, work.ctx);
}

module.exports = { hazardTarget, withWorkTarget, interruptedWork };
