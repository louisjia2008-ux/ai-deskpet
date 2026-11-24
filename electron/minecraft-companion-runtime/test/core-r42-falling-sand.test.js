'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

function buried(walkable) {
  // Seed 2 L3890–L3910. Breaking the first of three sand blocks let
  // the remaining column fall into the same place and keep suffocating.
  const origin = new Vec3(246, 73, -45), open = origin.offset(1, 0, 0);
  let sand = 3, look;
  const log = [];
  const bot = {
    entity: { position: origin.offset(0.5, 0, 0.5) },
    blockAt(p) {
      const column = p.x === origin.x && p.z === origin.z;
      const inOpening = p.x === open.x && p.z === open.z;
      const name = p.y < origin.y ? 'stone' : column ? (sand && p.y > origin.y ? 'sand' : 'air')
        : (inOpening && walkable ? 'air' : 'stone');
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
    async lookAt(p) { look = p; },
    setControlState(key, on) {
      if (key === 'forward' && on && walkable && look.x > open.x) this.entity.position = open.offset(0.5, 0, 0.5);
    },
  };
  const actions = { ...require('../core/actions'), async digBlock(_bot, _ctx, block) {
    log.push({ type: 'dig', block });
    sand--;
    return { ok: true };
  } };
  return { bot, open, log, run() {
    const b = createSurvivalBehaviors({ bot, actions }).find(behavior => behavior.name === 'unbury');
    assert.equal(b.want(), 1);
    return b.run({ record: (type, fields) => log.push({ type, ...fields }) });
  } };
}

test('seed 2 falling sand escapes the column with feet and head clear before digging', async () => {
  const { bot, open, log, run } = buried(true);
  assert.equal((await run()).ok, true);
  assert.ok(bot.entity.position.floored().equals(open));
  assert.ok([0, 1].every(y => bot.blockAt(open.offset(0, y, 0)).name === 'air'));
  assert.deepEqual(log.map(r => [r.type, r.action, r.ok]), [['unbury', 'sideways', true]]);
});

test('a sealed gravity column falls back to digging when all four sides are blocked', async () => {
  const { log, run } = buried(false);
  assert.equal((await run()).ok, true);
  assert.equal(log.filter(r => r.type === 'dig').length, 3);
  assert.equal(log.filter(r => r.action === 'sideways').length, 0);
});
