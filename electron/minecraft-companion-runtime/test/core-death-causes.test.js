'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createRecovery } = require('../core/behaviors/recovery');

test('a second overworld death fails the task with both death messages, whichever side of the death they arrive', async () => {
  const bot = Object.assign(new EventEmitter(), { username: 'DeskPetCore', entity: { position: new Vec3(1, 64, 2) }, game: { dimension: 'overworld' } });
  const failures = [];
  const recovery = createRecovery({ bot });
  recovery.attach({ failGoal: async (reason) => { failures.push(reason); } });
  recovery.observe({ type: 'goal_set' });
  // Message first, then the death.
  bot.emit('messagestr', 'DeskPetCore was slain by Drowned');
  bot.emit('death');
  bot.entity.position = new Vec3(40, 70, -5);
  // The death first, then its message.
  bot.emit('death');
  bot.emit('messagestr', 'DeskPetCore was slain by Enderman');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(failures, ['death_loop: was slain by Drowned at 1,64,2; was slain by Enderman at 40,70,-5']);
  recovery.dispose();
});
