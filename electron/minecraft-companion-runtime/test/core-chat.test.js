'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createCoreHost } = require('../core-host');

async function readyHost() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-chat-'));
  const events = [];
  const said = [];
  const bot = Object.assign(new EventEmitter(), { username: 'DeskPetCore', chat: (text) => said.push(text), waitForChunksToLoad: async () => {} });
  const host = createCoreHost({ dataDir, emit: (message) => { if (message.type === 'event') events.push(message.event); },
    createBot: () => bot, createCompanion: () => ({ status: () => ({}), dispose: async () => {} }) });
  await host.handle({ version: 1, id: 'connect', type: 'connect', config: { host: '127.0.0.1', port: 25565, username: 'DeskPetCore', auth: 'offline' } });
  bot.emit('spawn');
  while (host.status().connection.state !== 'ready') await new Promise((resolve) => setImmediate(resolve));
  return { host, bot, events, said, dataDir };
}

test('core forwards other players\' chat as data and ignores its own lines', async () => {
  const { host, bot, events, dataDir } = await readyHost();
  bot.emit('chat', 'OwnerPlayer', 'DeskPetCore，收集 3 个原木');
  bot.emit('chat', 'DeskPetCore', '好的');
  const chats = events.filter((event) => event.type === 'player_chat');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].username, 'OwnerPlayer');
  assert.equal(chats[0].message, 'DeskPetCore，收集 3 个原木');
  assert.equal(chats[0].connectionGeneration, host.status().connection.generation);
  await host.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('say sends one plain line and refuses commands or multi-line text', async () => {
  const { host, said, dataDir } = await readyHost();
  assert.equal((await host.handle({ version: 1, id: 's1', type: 'say', text: '我去砍树' })).ok, true);
  for (const [id, text] of [['s2', '/op OwnerPlayer'], ['s3', '  /kill @a'], ['s4', 'a\nb'], ['s5', ''], ['s6', 'x'.repeat(257)]]) {
    const reply = await host.handle({ version: 1, id, type: 'say', text });
    assert.equal(reply.ok, false, text);
  }
  assert.equal((await host.handle({ version: 1, id: 's7', type: 'say', text: 'hi', config: {} })).ok, false);
  assert.deepEqual(said, ['我去砍树']);
  await host.close();
  assert.equal((await host.handle({ version: 1, id: 's8', type: 'say', text: 'late' })).ok, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
