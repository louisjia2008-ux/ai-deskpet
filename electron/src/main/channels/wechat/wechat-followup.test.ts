// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { wechatFollowupSettingsSchema } from '../../../shared/wechat-followup';
import type { WeChatDigestContext } from './wechat-digest-scheduler';
import type { WeChatFollowupEvidenceRow } from './wechat-followup-evidence';
import { WeChatFollowup } from './wechat-followup';

const binding = 'a'.repeat(64);
const otherBinding = 'b'.repeat(64);
const groupId = 'c'.repeat(64);
const otherGroup = 'd'.repeat(64);
const mentionId = 'e'.repeat(64);
const replyId = 'f'.repeat(64);
const authorId = '1'.repeat(64);
const original = '示例报名 周四下午6点前确认一下';
const groupTitle = '示例指定群';
const otherRequest = '示例材料请你发一下';
const minute = 60_000;
const start = Date.parse('2026-11-16T09:00:00+08:00');
const startSeconds = Math.floor(start / 1_000);
const roots: string[] = [];
type Host = ConstructorParameters<typeof WeChatFollowup>[2];

async function fixture({ cloud = false, secondGroup = false }: { cloud?: boolean; secondGroup?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-followup-'));
  roots.push(root);
  const path = join(root, 'followup.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 218) };
  const current = { now: start, binding: binding as string | null, available: true, paused: false, quiet: false, truncated: false,
    otherFailure: null as 'missing' | 'truncated' | 'read' | null };
  const mention: WeChatFollowupEvidenceRow = { id: mentionId, at: startSeconds + 60, role: 'member',
    author: authorId, mentionsOwner: true, text: `@示例主人 ${original}` };
  const resolved: WeChatFollowupEvidenceRow = { id: replyId, at: startSeconds + 240, role: 'owner', quoteId: mention.id, text: '确认了。' };
  const rows: WeChatFollowupEvidenceRow[] = [mention];
  const otherRows: WeChatFollowupEvidenceRow[] = [{ ...mention, id: '5'.repeat(64), at: startSeconds + 90,
    text: `@示例主人 ${otherRequest}` }];
  const read = vi.fn<Host['read']>(async (owner, group, since, until) => {
    expect(owner).toBe(current.binding);
    expect(group === groupId || (secondGroup && group === otherGroup)).toBe(true);
    if (group === otherGroup && current.otherFailure === 'read') throw Error('fixture read failed');
    return { rows: (group === groupId ? rows : otherRows).filter(row => row.at >= since && row.at < until),
      truncated: group === groupId ? current.truncated : current.otherFailure === 'truncated' };
  });
  const deliverOwner = vi.fn<Host['deliverOwner']>(async () => 'sent');
  const summarize = vi.fn<Host['summarize']>(async ({ text }) => text);
  const host: Host = { now: () => current.now, available: () => current.available, paused: async () => current.paused,
    quiet: () => current.quiet, ownerBinding: async () => current.binding, timezone: () => 'Asia/Shanghai',
    roster: async () => [{ id: groupId, title: groupTitle },
      ...(current.otherFailure === 'missing' ? [] : [{ id: otherGroup, title: '示例第二群' }])], read, summarize, deliverOwner };
  const reopen = () => new WeChatFollowup(path, vault, host);
  const service = reopen();
  const assertCurrent = vi.fn(async () => {
    if (!current.available || current.binding !== binding) throw Error('wechat.authorityRevoked');
  });
  const guard = (): WeChatDigestContext => ({ binding, now: current.now, dueAt: current.now, signal: new AbortController().signal, assertCurrent });
  const settings = wechatFollowupSettingsSchema.parse({ groups: [{ id: groupId, cloud }, ...(secondGroup ? [{ id: otherGroup }] : [])], waitMinutes: 10 });
  await service.configure(binding, settings, assertCurrent);
  const move = (minutes: number) => { current.now = start + minutes * minute; };
  const prepare = async () => {
    const output = await service.generate(guard());
    return { text: output.messages[0]!, metadata: output.metadata?.[0] };
  };
  const send = ({ text, metadata }: Awaited<ReturnType<typeof prepare>>, target = service) =>
    target.deliverReport({ binding, deliveryId: '2'.repeat(64), text }, guard(), metadata);
  return { path, current, rows, resolved, service, reopen, guard, assertCurrent, settings, move, prepare, send, read, summarize, deliverOwner };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('waits for the configured interval, reads only selected groups, and delivers only through the owner private channel by default', async () => {
  const f = await fixture();
  expect(f.settings.groups).toEqual([{ id: groupId, cloud: false }]);
  f.move(10);
  expect(await f.service.generate(f.guard())).toEqual({ entries: [], messages: [] });
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(f.read).toHaveBeenCalledExactlyOnceWith(binding, groupId, startSeconds, startSeconds + 600);
  f.move(11);
  const prepared = await f.prepare();
  const { text } = prepared;
  expect(text).toContain('群里还没看到你的回复');
  expect(text).toContain(groupTitle);
  expect(text).toContain('周四下午6点前');
  expect(f.summarize).not.toHaveBeenCalled();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(await f.send(prepared, f.reopen())).toBe('sent');
  expect(f.deliverOwner).toHaveBeenCalledExactlyOnceWith({ binding, deliveryId: '2'.repeat(64), text });
  expect(f.read.mock.calls.every(([, id]) => id === groupId)).toBe(true);
  expect(await readFile(f.path, 'utf8')).not.toContain(original);
});

it('suppresses reports when paused or when the source is truncated, including truncation at the send boundary', async () => {
  const f = await fixture();
  f.move(12);
  f.current.paused = true;
  expect(await f.service.generate(f.guard())).toEqual({ entries: [], messages: [] });
  expect(f.read).not.toHaveBeenCalled();
  f.current.paused = false;
  f.current.truncated = true;
  expect(await f.service.generate(f.guard())).toEqual({ entries: [], messages: [], issue: 'read', failures: 1 });
  expect(await f.service.list(binding)).toEqual([]);
  f.current.truncated = false;
  const prepared = await f.prepare();
  expect(prepared.text).toContain(original);
  f.current.truncated = true;
  expect(await f.send(prepared)).toBe('retry');
  expect(f.deliverOwner).not.toHaveBeenCalled();
});

it.each(['missing', 'truncated', 'read'] as const)('sends only reverified lines when the other group fails at delivery (%s)', async failure => {
  const f = await fixture({ secondGroup: true });
  f.move(12);
  const prepared = await f.prepare();
  expect(prepared.text).toContain(original);
  expect(prepared.text).toContain(otherRequest);

  f.current.otherFailure = failure;
  expect(await f.send(prepared)).toBe('sent');
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  const sent = f.deliverOwner.mock.calls[0]![0].text;
  expect(sent).toContain(original);
  expect(sent).not.toContain(otherRequest);

  f.current.otherFailure = null;
  const next = await f.prepare();
  expect(next.text).toContain(otherRequest);
  expect(next.text).not.toContain(original);
});

it('retains snooze and manual completion across restarts and subsequent successful scans', async () => {
  const f = await fixture();
  f.move(12);
  await f.service.tick();
  const number = mentionId.slice(0, 12);
  expect(await f.service.command(binding, `展开跟进 ${number}`, f.assertCurrent)).toContain(original);
  expect(await f.service.command(binding, `稍后跟进 ${number} 15`, f.assertCurrent)).toBe('已延后 15 分钟。');
  await f.service.drain();
  const restarted = f.reopen();
  await expect(restarted.list(binding)).resolves.toMatchObject([{ id: mentionId, snoozedUntil: start + 27 * minute }]);
  f.move(26);
  await restarted.tick();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  f.move(29);
  await restarted.tick();
  expect(f.deliverOwner).toHaveBeenCalledExactlyOnceWith({ binding, deliveryId: expect.stringMatching(/^[a-f0-9]{64}$/u),
    text: expect.stringContaining(original) });
  expect(await restarted.command(binding, `完成跟进 ${number}`, f.assertCurrent)).toBe('已标为处理完成。');
  await restarted.drain();
  const review = f.reopen();
  f.move(35);
  expect(await review.generate(f.guard())).toEqual({ entries: [], messages: [] });
  expect(await review.command(binding, '待跟进', f.assertCurrent)).toBe('目前没有待跟进事项。');
  expect(f.deliverOwner).toHaveBeenCalledOnce();
});

it('refreshes evidence at delivery and drops a source answered while opted-in summarization ran', async () => {
  const f = await fixture({ cloud: true });
  f.move(12);
  f.summarize.mockImplementationOnce(async ({ guard }) => {
    await guard.assertCurrent();
    f.rows.push(f.resolved);
    return '合成简报';
  });
  const prepared = await f.prepare();
  expect(prepared.text).toContain('合成简报');
  expect(f.summarize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding, groupId, text: original }));
  expect(await f.send(prepared)).toBe('skipped');
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(await f.service.list(binding)).toEqual([]);
});

it('persists uncertain deliveries before the send and does not retry them after reopening', async () => {
  const f = await fixture();
  f.move(12);
  f.deliverOwner.mockResolvedValueOnce('uncertain');
  const prepared = await f.prepare();
  expect(await f.send(prepared)).toBe('uncertain');
  expect(await f.send(prepared)).toBe('skipped');
  await f.service.drain();
  const restarted = f.reopen();
  f.move(15);
  expect(await restarted.generate(f.guard())).toEqual({ entries: [], messages: [] });
  expect(await restarted.list(binding)).toMatchObject([{ id: mentionId }]);
  expect(f.deliverOwner).toHaveBeenCalledOnce();
});

it('removes a newly answered item from its bubble while sending the remaining follow-up', async () => {
  const f = await fixture();
  const another = '下周比赛的名单请你发一下';
  f.rows.push({ id: '3'.repeat(64), at: startSeconds + 90, role: 'member', author: '4'.repeat(64), mentionsOwner: true,
    text: `@示例主人 ${another}` });
  f.move(14);
  const prepared = await f.prepare();
  expect(prepared.text).toContain(original);
  expect(prepared.text).toContain(another);
  f.rows.push(f.resolved);
  expect(await f.send(prepared)).toBe('sent');
  const delivered = f.deliverOwner.mock.calls[0]![0].text;
  expect(delivered).toContain(another);
  expect(delivered).not.toContain(original);
});

it('rejects a replaced owner binding before a prepared report can leave the app', async () => {
  const f = await fixture();
  f.move(12);
  const prepared = await f.prepare();
  expect(prepared.text).toContain(original);
  f.current.binding = otherBinding;
  expect(await f.send(prepared)).toBe('retry');
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  await expect(f.service.list(binding)).rejects.toThrow('wechat.authorityRevoked');
  expect(await f.service.list(otherBinding)).toEqual([]);
  expect((await f.service.settings(otherBinding)).groups).toEqual([]);
});

it('resumes the same snooze bubble on the next eligible scan after a safe retry', async () => {
  const f = await fixture();
  f.move(12);
  await f.service.tick();
  await f.service.act(binding, { id: mentionId, action: 'snooze', minutes: 5 });
  f.deliverOwner.mockResolvedValueOnce('retry');
  f.move(18);
  await f.service.tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  expect(f.service.health().lastFailure).toBeNull();
  const restarted = f.reopen();
  f.current.quiet = true;
  f.move(21);
  await restarted.tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  f.current.quiet = false;
  f.move(24);
  await restarted.tick();
  expect(f.deliverOwner.mock.calls[0]).toEqual(f.deliverOwner.mock.calls[1]);
  f.move(27);
  await restarted.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
});

it('drops a snooze bubble after three retries across restart and lets later bubbles and new reminders through', async () => {
  const f = await fixture();
  const earlier = [mentionId, ...['3', '4'].map(digit => digit.repeat(64))];
  const later = '6'.repeat(64), newlySnoozed = '7'.repeat(64);
  for (const [i, id] of [...earlier.slice(1), later, newlySnoozed].entries()) f.rows.push({
    id, at: startSeconds + 100 + i, role: 'member', author: authorId, mentionsOwner: true,
    text: `@示例主人 请你核对第${i + 1}份示例资料`,
  });
  f.move(14);
  await f.service.tick();
  for (const id of [...earlier, later]) await f.service.act(binding, { action: 'snooze', id, minutes: 5 });
  f.deliverOwner.mockResolvedValueOnce('retry').mockResolvedValueOnce('retry').mockResolvedValueOnce('retry');

  f.move(20);
  await f.service.tick();
  f.move(23);
  await f.service.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
  expect(f.service.health().lastFailure).toBeNull();
  await f.service.act(binding, { action: 'snooze', id: newlySnoozed, minutes: 5 });
  const restarted = f.reopen();
  f.move(26);
  await restarted.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(4);
  const attempted = f.deliverOwner.mock.calls.map(([part]) => part);
  expect(attempted.slice(0, 3)).toEqual([attempted[0], attempted[0], attempted[0]]);
  expect(attempted[3]?.text).toContain(later.slice(0, 12));
  expect(restarted.health().lastFailure).toEqual({ at: f.current.now, code: 'wechat.digest_delivery_failed' });

  f.move(29);
  await restarted.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(5);
  expect(f.deliverOwner.mock.calls[4]?.[0].text).toContain(newlySnoozed.slice(0, 12));
  expect(restarted.health().lastFailure).toBeNull();
  expect((await restarted.generate(f.guard())).messages[0]).toContain(original); // Not marked successfully sent.
});
