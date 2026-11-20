'use strict';

const assert = require('node:assert/strict');
const {
  SLOT, P, Y, Vec3, until, delay, record, coords, click, menuText, requireButton, dashboard,
  fixture, draft, startPlan, planWhere, take, settled, runWorld, protocol, readPlans,
} = require('./m4-session.cjs');
const { move, commandAssert, assertBlock } = require('./wand-session.cjs');
const { prepareSmall, previewFixture } = require('./fix1-session.cjs');
const { verifyBlocks } = require('./m3-verification.cjs');
const { pause, cancel } = require('./m4.cjs');

const names = { '': '施工', terrain: '整地', foundation: '地基', walls: '砌墙', scaffold: '搭脚手架',
  roof: '盖屋顶', furnish: '布置家具', remove_scaffold: '拆脚手架' };

function controls(env, status) {
  const active = status === 'running' || status === 'confirmed';
  const paused = status === 'paused';
  for (const [slot, label, enabled] of [
    [SLOT.pause, /暂停/, active], [SLOT.continue, /继续/, paused], [SLOT.recompare, /重新比对/, paused],
    [SLOT.remaining, /显示剩余工作/, active || paused], [SLOT.cancel, /取消施工/, active || paused],
  ]) requireButton(env.owner, slot, label, enabled);
  requireButton(env.owner, SLOT.history, /历史记录/);
}

async function hud(env, row, suffix, { action = true } = {}) {
  const heading = `生存小屋 · ${names[row.phase]} · ${row.completed}/${row.total}`;
  const bar = await until(() => [...env.ownerWire.bars.values()].find(({ title, progress }) =>
    title?.includes(`${names[row.phase]} · ${row.completed}/${row.total}`)
      && title.includes(suffix) && Math.abs(progress - row.completed / row.total) < 0.000001),
  `Owner Boss bar tracks authoritative ${heading} · ${suffix}`, 8000);
  assert.match(bar.title, /7[×xX]7|小屋/);
  const menu = await until(() => {
    const text = menuText(env.owner.currentWindow?.slots[SLOT.status]);
    return text.includes(`${names[row.phase]} · ${row.completed}/${row.total}`) && text.includes(suffix) && text;
  }, 'Owner dashboard tracks authoritative phase, count and reason', 8000);
  assert.match(menu, /越界 \d+ · 放错 \d+ · 现场变化 \d+ · 迟到操作 \d+/);
  assert.ok(menu.includes(`版本 ${row.plan.revision}`));
  const actionBar = action ? await until(() => env.ownerWire.action.findLast((text) =>
    text.includes(`${row.completed}/${row.total}`) && text.includes(suffix)),
  `Owner action bar reports ${suffix}`, 8000) : null;
  record('m4-hud-check', { status: row.status, completed: row.completed, total: row.total, phase: row.phase,
    reportedProgress: row.reportedProgress, version: row.plan.revision, bar, menu, actionBar });
}

function chatCount(env, name, count) {
  const matched = env.ownerWire.chat.filter((text) => text.includes(`【施工】 ${name} ·`));
  assert.equal(matched.length, count, JSON.stringify(env.ownerWire.chat));
  return matched.at(-1);
}

async function menuMarkersRemoved(env) {
  env.owner.closeWindow(env.owner.currentWindow);
  await until(() => env.ownerWire.displays.size === 0, 'closing the Owner menu removes all private display entities', 6000);
  assert.equal(env.owner.currentWindow, null);
}

async function progress(env) {
  const confirmed = await startPlan(env, { holdAccept: true, missingDoor: true });
  controls(env, 'confirmed');
  await hud(env, confirmed, '等待机器人接单', { action: false });
  assert.equal(env.ownerWire.bossPackets.filter(({ action }) => action === 0).length, 1);
  await env.rcon.command('time set night');
  const accept = await env.transport.release('accept');
  const night = await planWhere(env, (row) => row.status === 'running' && row.waiting === 'night', 'real Core waits at night');
  controls(env, 'running');
  await hud(env, night, '夜里停工');
  const injectedCount = night.plan.ops.length;
  assert.ok(injectedCount > night.completed);
  protocol(env, { ...accept, type: 'progress', completed: injectedCount });
  const reported = await planWhere(env, (row) => row.reportedProgress === injectedCount, 'isolated progress packet differs from server state');
  assert.equal(reported.completed, night.completed);
  await hud(env, reported, '夜里停工');
  record('m4-progress-counter-source', { authoritative: reported.completed, reported: injectedCount, total: reported.total });
  await env.rcon.command('time set day');
  const materials = await planWhere(env, (row) => row.status === 'running' && row.waiting === 'materials',
    'running plan waits for a real missing door', 120000);
  assert.equal(materials.missing['minecraft:oak_door'], 1);
  assert.ok(materials.completed < materials.total);
  await hud(env, materials, '等材料');
  requireButton(env.owner, SLOT.status, /缺料 minecraft:oak_door ×1/);
  await click(env.owner, SLOT.remaining);
  await until(() => env.ownerWire.displays.size > 0, 'Owner sees outstanding operation display entities', 6000);
  const remaining = materials.plan.ops.slice(materials.completed);
  assert.ok([...env.ownerWire.displays.values()].some(({ pos, display }) =>
    display === 'block' && remaining.some((op) => coords(op.pos) === coords(pos))));
  requireButton(env.owner, SLOT.remaining, /显示剩余工作 · 开/);
  await click(env.owner, SLOT.remaining);
  await until(() => env.ownerWire.displays.size === 0, 'remaining-work toggle clears virtual markers', 6000);
  requireButton(env.owner, SLOT.remaining, /显示剩余工作 · 关/);
  await click(env.owner, SLOT.remaining);
  await until(() => env.ownerWire.displays.size > 0, 're-enabling the toggle restores Owner-only markers', 6000);
  await menuMarkersRemoved(env);
  await env.owner.unequip('hand');
  assert.ok(!env.owner.heldItem, 'Owner opens the command without a wand in hand');
  commandAssert(await env.rcon.command(`item replace block ${coords(P.chest)} container.3 with oak_door 1`), 'Restock missing door');
  await planWhere(env, (row) => row.status === 'running' && row.completed >= 16 && row.phase === 'walls',
    'the real worker resumes and applies wall work after replenishment', 120000);
  const priorCommandCount = env.ownerWire.commands.length;
  const paused = await pause(env);
  assert.ok(env.ownerWire.commands.slice(priorCommandCount).some((message) => /生存小屋.*版本 1/.test(message)
    && message.includes('运行中') && message.includes('迟到操作')), 'Owner command sends real status text without a wand');
  controls(env, 'paused');
  await hud(env, paused, '主人暂停', { action: false });
  assert.match(chatCount(env, '暂停', 1), /主人暂停/);
  await click(env.owner, SLOT.continue);
  const completed = await settled(env, confirmed.plan.revision + 1);
  const after = await take(env, 'complete');
  await verifyBlocks(env.plan, env.before.blocks, after.blocks);
  chatCount(env, '开工', 1);
  chatCount(env, '暂停', 1);
  chatCount(env, '完成', 1);
  chatCount(env, '失败', 0);
  chatCount(env, '取消', 0);
  const updates = env.ownerWire.bossPackets.filter(({ progress }) => progress !== undefined).map(({ progress }) => progress);
  assert.ok(updates.length > 5 && updates.at(-1) <= 1);
  assert.ok(updates.every((value, index) => index === 0 || value >= updates[index - 1]), JSON.stringify(updates));
  let count = 0;
  const acknowledged = new Set([count]);
  for (const packet of env.applied.filter(({ planId }) => planId === env.id)) {
    count += packet.positions.length;
    acknowledged.add(count);
  }
  assert.equal(count, completed.total, 'independent sum of accepted server position acknowledgements');
  for (const ratio of updates) {
    const count = Math.round(ratio * completed.total);
    assert.ok(Math.abs(ratio - count / completed.total) < 0.000001);
    assert.ok(acknowledged.has(count), `Boss progress ${count}/${completed.total} lacked a server acknowledgement`);
  }
  assert.equal(env.ownerWire.bossPackets.filter(({ action }) => action === 1).length, 1);
  assert.equal(env.ownerWire.displays.size, 0);
  record('m4-progress-monotonic', { updates, acknowledged: [...acknowledged], transitions: env.ownerWire.chat });
}

async function markerAt(env, row, death, pauseNotifications) {
  const { pos } = row.blocked;
  assert.ok(pos);
  const color = death ? 0xB460FF : 0xFF3030;
  const display = await until(() => [...env.ownerWire.displays.values()].find((entity) => entity.display === 'block'
    && coords(entity.pos) === coords(pos) && entity.metadata.glow_color_override === color
    && (entity.metadata.shared_flags & 0x40)), 'entire glowing marker spawn at the recorded coordinate', 7000);
  const pattern = new RegExp(`${death ? '机器人死亡' : '受阻'} · ${pos.x}, ${pos.y}, ${pos.z}`);
  requireButton(env.owner, SLOT.status, pattern);
  assert.equal(env.ownerWire.displays.size, 1);
  assert.ok(chatCount(env, '暂停', pauseNotifications).includes(`${pos.x}, ${pos.y}, ${pos.z}`));
  record('m4-coordinate-marker', { death, pos, blocked: row.blocked, display });
  await menuMarkersRemoved(env);
}

async function cageWorker(env) {
  const center = new Vec3(-4, Y, 14);
  await move(env.rcon, env.robot, center.offset(0.5, 0, 0.5));
  const low = center.offset(-1, 0, -1);
  const high = center.offset(1, 2, 1);
  assert.match(await env.rcon.command(`fill ${coords(low)} ${coords(high)} bedrock outline`), /Successfully filled/);
  await env.rcon.command(`setblock ${coords(center)} air`);
}

async function markers(env) {
  await startPlan(env);
  await planWhere(env, (row) => row.status === 'running' && row.completed >= 16 && row.phase === 'walls',
    'actual worker already carries materials and has applied wall work', 120000);
  await env.rcon.command('time set night');
  await planWhere(env, (row) => row.status === 'running' && row.waiting === 'night', 'worker waits before constructing a real obstacle');
  await cageWorker(env);
  const cage = await take(env, 'cage_inserted');
  await env.rcon.command('time set day');
  const trapped = await planWhere(env, (row) => row.status === 'paused', 'real Core pauses with trapped path', 150000);
  assert.match(trapped.reason, /reach|path|chest_access|station/);
  assert.equal(trapped.violations, 0);
  assert.equal((await take(env, 'trapped_no_block_change')).hash, cage.hash);
  await markerAt(env, trapped, false, 1);
  await cancel(env);
  await startPlan(env);
  await planWhere(env, (row) => row.status === 'running' && row.phase === 'walls' && row.completed >= 16,
    'active real Core is building before direct server death fixture', 120000);
  await env.rcon.command('kill DeskPetBot');
  const died = await planWhere(env, (row) => row.status === 'paused' && row.reason === 'bot_died', 'real death pauses the current plan');
  assert.equal(died.blocked.dimension, 'minecraft:overworld');
  const death = await until(async () => {
    for (const tag of ['last_death_location', 'LastDeathLocation']) {
      const result = await env.rcon.command(`data get entity DeskPetBot ${tag}`);
      const match = result.match(/pos:\s*\[(?:I;\s*)?(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/i);
      if (match) return { x: +match[1], y: +match[2], z: +match[3] };
    }
    return false;
  }, 'read actual server death location through vanilla NBT', 12000);
  assert.deepEqual(died.blocked.pos, death);
  await markerAt(env, died, true, 2);
  await dashboard(env.owner);
  await until(() => env.ownerWire.displays.size === 1, 'reopened Owner status shows exactly one death marker', 7000);
  requireButton(env.owner, SLOT.cancel, /取消施工/);
  await click(env.owner, SLOT.cancel);
  await planWhere(env, (row) => row.status === 'cancelled', 'Owner cancels death-paused construction');
  await until(() => !env.ownerWire.bars.size && !env.ownerWire.displays.size, 'terminal cancellation removes Owner Boss bar and marker', 6000);
  chatCount(env, '取消', 2);

  await startPlan(env, { holdAccept: true });
  await env.rcon.command('time set night');
  await env.transport.release('accept');
  await planWhere(env, (row) => row.status === 'running' && row.waiting === 'night', 'worker waits at night before initial supply pickup');
  await cageWorker(env);
  await env.rcon.command('time set day');
  const supply = await planWhere(env, (row) => row.status === 'paused' && row.reason === 'supply_chest_unreachable',
    'real Core pauses while trying to reach the configured supply chest', 150000);
  assert.equal(coords(supply.blocked.pos), coords(P.chest));
  assert.equal(supply.violations, 0);
  await markerAt(env, supply, false, 3);
  await cancel(env, 3);
}

async function history(env) {
  await fixture(env);
  await prepareSmall(env.rcon);
  const terminal = [];
  for (let count = 0; count < 21; count++) {
    env.id = await previewFixture(env.rcon);
    const expired = count % 3 === 0;
    if (expired) {
      await env.rcon.command(`deskpet debug expire ${env.id}`);
      await env.rcon.command(`execute as Owner at @s run deskpet debug confirm ${env.id}`);
    } else {
      await env.rcon.command(`execute as Owner at @s run deskpet debug cancel ${env.id}`);
    }
    const status = expired ? 'expired' : 'cancelled';
    const row = await planWhere(env, (entry) => entry.status === status, `debug fixture enters real terminal ${status}`);
    assert.ok(row.finishedAt > 0 && row.finishOrder > 0);
    terminal.push(row);
  }
  await draft(env);
  requireButton(env.owner, SLOT.continue, /施工中/);
  await click(env.owner, SLOT.continue);
  controls(env, 'none');
  requireButton(env.owner, SLOT.status, /当前没有施工计划/);
  await click(env.owner, SLOT.history);
  requireButton(env.owner, SLOT.status, /最近 20 份已结束计划/);
  const entries = env.owner.currentWindow.slots.slice(9, 29);
  assert.equal(env.owner.currentWindow.slots.slice(0, 54).filter((item) => item?.name === 'paper').length, 20);
  const latest = terminal.slice(1).reverse();
  const visible = entries.map((item, index) => {
    const text = menuText(item);
    const expired = latest[index].status === 'expired';
    assert.match(text, /小屋/);
    assert.match(text, expired ? /已过期.*过期/ : /已取消.*取消/);
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    return { status: latest[index].status, finishOrder: latest[index].finishOrder, text };
  });
  const before = await readPlans(env.rcon);
  await click(env.owner, 9);
  await click(env.owner, 28);
  assert.deepEqual(await readPlans(env.rcon), before, 'clicking history entries has no side effects on server state');
  requireButton(env.owner, SLOT.back, /返回施工状态/);
  await click(env.owner, SLOT.back);
  requireButton(env.owner, SLOT.status, /当前没有施工计划/);
  record('m4-history-retained-latest-20', { visible, evicted: terminal[0].id });
}

async function failChat(env) {
  await startPlan(env, { holdAccept: true });
  await env.rcon.command('time set night');
  await env.transport.release('accept');
  await planWhere(env, (row) => row.waiting === 'night', 'real Core waits prior to test-only denial case');
  const target = new Vec3(-3, Y, 5);
  assert.ok(target.x < env.plan.selection.minX);
  commandAssert(await env.rcon.command(`setblock ${coords(target)} stone`), 'Place isolated disposable test block');
  await move(env.rcon, env.robot, target.offset(0.5, 0, 1.5));
  await env.rcon.command('gamemode creative DeskPetBot');
  await until(() => env.robot.blockAt(target)?.name === 'stone' && env.robot.game.gameMode === 'creative',
    'real worker client sees the disposable block and test-only mode', 5000);
  env.transport.breakFixture(target);
  const failed = await planWhere(env, (row) => row.status === 'failed', 'real Mod fails an intentionally unauthorized test-player action');
  assert.equal(failed.violations, 1);
  assert.equal(failed.completed, 0);
  await assertBlock(env.rcon, target, 'minecraft:stone');
  const denied = (await readPlans(env.rcon)).rejections.findLast((event) => event.planId === env.id);
  assert.equal(denied.category, 'violation');
  assert.equal(coords(denied.pos), coords(target));
  await until(() => !env.ownerWire.bars.size, 'Boss bar removed after real server failure', 6000);
  await delay(1200);
  chatCount(env, '开工', 1);
  chatCount(env, '失败', 1);
  chatCount(env, '暂停', 0);
  chatCount(env, '取消', 0);
  chatCount(env, '完成', 0);
  record('m4-failure-notification', { notifications: env.ownerWire.chat, reason: failed.reason, target });
}

const name = process.argv[2];
const cases = { progress, markers, history, 'fail-chat': failChat };
assert.ok(cases[name], `Expected one M4 Owner-presentation case: ${Object.keys(cases).join(', ')}`);
runWorld(name, cases[name]).catch((failure) => {
  record('m4-error', { scenario: name, error: failure.stack });
  process.exitCode = 1;
});
