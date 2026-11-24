// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WeChatDigestFailure, WeChatDigestScheduler } from './wechat-digest-scheduler';
import type { WeChatDigestHost } from './wechat-digest-scheduler';

const owner = 'a'.repeat(64);
const formerOwner = 'b'.repeat(64);
const rootPaths: string[] = [];
const report = {
  entries: [{ title: 'Fixture room', summary: 'Fixture summary', detail: 'Fixture detailed result' }],
  messages: ['Summary part one', 'Summary part two'],
};
const release = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
};
const dayAt = (day: number, hhmm: string) => Date.parse(`2026-11-${day}T${hhmm}:00+08:00`);

async function fixture(feature: WeChatDigestHost['feature'] = 'wechat-group-digest') {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-wechat-digest-'));
  rootPaths.push(dir);
  const path = join(dir, 'digest.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 64) };
  const current = { now: dayAt(16, '21:20'), binding: owner as string | null, revision: 'revision-one', quiet: false, available: true, ready: true };
  const generate = vi.fn<WeChatDigestHost['generate']>(async () => structuredClone(report));
  const deliverOwner = vi.fn<WeChatDigestHost['deliverOwner']>(async () => 'sent');
  const ready = vi.fn(async () => current.ready);
  const host: WeChatDigestHost = {
    feature, generate, deliverOwner, now: () => current.now, available: () => current.available, ready,
    quiet: () => current.quiet, ownerBinding: async () => current.binding,
    spec: async () => ({ revision: current.revision, time: '21:30', timezone: 'Asia/Shanghai' }),
  };
  const reopen = () => new WeChatDigestScheduler(path, vault, host);
  const scheduler = reopen();
  await scheduler.tick();
  return { path, reopen, scheduler, current, generate, deliverOwner, ready };
}

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it.each(['wechat-group-digest', 'wechat-followup', 'wechat-official-brief', 'wechat-friends-moments'] as const)(
  '%s resumes encrypted pending parts without regenerating or resending confirmed parts', async feature => {
    const f = await fixture(feature);
    f.generate.mockResolvedValueOnce({ ...report, messages: [...report.messages, 'Final part'] });
    f.deliverOwner.mockResolvedValueOnce('sent').mockResolvedValueOnce('retry');
    f.current.now = dayAt(16, '21:30');
    await f.scheduler.tick();
    expect(await f.scheduler.health()).toMatchObject({ errorCode: null });
    expect(await readFile(f.path, 'utf8')).not.toContain('Final part');
    const restarted = f.reopen();
    f.current.now += 299_999;
    await restarted.tick();
    expect(f.deliverOwner).toHaveBeenCalledTimes(2);
    f.current.now++;
    await restarted.tick();
    const parts = f.deliverOwner.mock.calls.map(([part]) => part);
    expect(parts.map(part => part.text)).toEqual([...report.messages, report.messages[1], 'Final part']);
    expect(parts[1]?.deliveryId).toBe(parts[2]?.deliveryId);
    expect(f.generate).toHaveBeenCalledOnce();
    expect(await restarted.health()).toMatchObject({ state: 'ok' });
  });

it('defers a safe retry across quiet hours and stops if a retry is uncertain', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('sent').mockResolvedValueOnce('retry').mockResolvedValueOnce('uncertain');
  f.current.now = dayAt(16, '22:58');
  await f.scheduler.tick();
  f.current.quiet = true;
  f.current.now = dayAt(16, '23:03');
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
  f.current.quiet = false;
  f.current.now = dayAt(17, '08:00');
  await f.scheduler.tick();
  f.current.now += 15 * 60_000;
  await f.reopen().tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(3);
  expect(await f.scheduler.health()).toMatchObject({ errorCode: 'wechat.digest_delivery_uncertain' });
});

it('fails after three additional retries and records only numeric progress', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValue('retry').mockResolvedValueOnce('sent');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  for (let retry = 1; retry <= 3; retry++) {
    expect(await f.scheduler.health()).toMatchObject({ errorCode: null });
    f.current.now += 5 * 60_000;
    await f.scheduler.tick();
  }
  expect(await f.reopen().health()).toMatchObject({ errorCode: 'wechat.digest_delivery_failed', deliveryProgress: { sent: 1, total: 2 } });
  expect(new Set(f.deliverOwner.mock.calls.slice(1).map(([part]) => part.deliveryId)).size).toBe(1);
  f.current.now += 5 * 60_000;
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(5);
});

it('preserves the pre-send failure reason across restarts along with multipart progress', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValue({ status: 'retry', reason: 'drawer_state_unknown' }).mockResolvedValueOnce('sent');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  for (let retry = 1; retry <= 3; retry++) {
    f.current.now += 5 * 60_000;
    await f.reopen().tick();
  }
  expect(await f.reopen().health()).toMatchObject({ errorCode: 'wechat.drawer_state_unknown', deliveryProgress: { sent: 1, total: 2 } });
  expect(new Set(f.deliverOwner.mock.calls.slice(1).map(([part]) => part.deliveryId)).size).toBe(1);
});

it('waits for listener readiness without doing work or using a delivery retry', async () => {
  const f = await fixture();
  f.current.now = dayAt(16, '21:30');
  f.current.ready = false;
  await f.scheduler.tick();
  expect(f.generate).not.toHaveBeenCalled();

  f.current.ready = true;
  f.deliverOwner.mockResolvedValueOnce('retry');
  await f.scheduler.tick();
  f.current.ready = false;
  f.current.now += 6 * 60_000;
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();

  f.current.ready = true;
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(3);
  expect(await f.scheduler.health()).toMatchObject({ state: 'ok' });
});

it.each(['ready', 'available'] as const)('expires a retry at the next slot even when %s is false', async key => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('sent').mockResolvedValueOnce('retry');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  const failedPart = f.deliverOwner.mock.calls[1]![0];

  f.current[key] = false;
  f.current.now = dayAt(17, '21:30') - 1;
  await f.scheduler.tick();
  expect(await f.scheduler.health()).toMatchObject({ errorCode: null });
  expect(await f.scheduler.results(owner)).toMatchObject([{ outcome: 'retrying' }]);

  f.current.now++;
  const restarted = f.reopen();
  await restarted.tick();
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
  expect(await restarted.health()).toMatchObject({ errorCode: 'wechat.digest_delivery_failed', deliveryProgress: { sent: 1, total: 2 } });

  f.current[key] = true;
  f.current.now += 60_000;
  await restarted.tick();
  expect(f.generate).toHaveBeenLastCalledWith(expect.objectContaining({ dueAt: dayAt(17, '21:30') }));
  const newParts = f.deliverOwner.mock.calls.slice(2).map(([part]) => part);
  expect(newParts.map(part => part.text)).toEqual(report.messages);
  expect(newParts.every(part => part.deliveryId !== failedPart.deliveryId)).toBe(true);
  expect(await restarted.health()).toMatchObject({ state: 'ok', errorCode: null, failures: 1 });
  expect(await restarted.results(owner)).toMatchObject([
    { outcome: 'succeeded' }, { outcome: 'failed', deliveryProgress: { sent: 1, total: 2 } },
  ]);
});

it('never starts an old retry if the next slot arrives during its readiness check', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('retry');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();

  const nextSlot = dayAt(17, '21:30');
  f.current.now = nextSlot - 1;
  f.ready.mockImplementationOnce(async () => { f.current.now = nextSlot; return true; });
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  expect(await f.scheduler.health()).toMatchObject({ errorCode: 'wechat.digest_delivery_failed', deliveryProgress: { sent: 0, total: 2 } });

  await f.scheduler.tick();
  expect(f.generate).toHaveBeenLastCalledWith(expect.objectContaining({ dueAt: nextSlot }));
  expect(f.deliverOwner).toHaveBeenCalledTimes(3);
});

it('retires the old retry and handles the new slot in the same tick when ready', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('retry');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  f.current.now = dayAt(17, '21:30');
  await f.scheduler.tick();

  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(f.generate).toHaveBeenLastCalledWith(expect.objectContaining({ dueAt: f.current.now }));
  expect(f.deliverOwner).toHaveBeenCalledTimes(3);
  expect(await f.scheduler.results(owner)).toMatchObject([
    { outcome: 'succeeded' }, { outcome: 'failed', deliveryProgress: { sent: 0, total: 2 } },
  ]);
});

it.each(['revision', 'binding'] as const)('does not retry after a changed %s', async key => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('retry');
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  f.current[key] = formerOwner;
  f.current.now += 5 * 60_000;
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  expect(await f.scheduler.health()).toMatchObject({ errorCode: 'wechat.digest_interrupted' });
});

it('waits during the quiet interval, then sends ordered parts to the owner and stores only the encrypted result', async () => {
  const f = await fixture();
  f.current.now = dayAt(16, '21:30');
  f.current.quiet = true;
  await f.scheduler.tick();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  f.current.now = dayAt(17, '08:00');
  f.current.quiet = false;
  await f.scheduler.tick();
  expect(f.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    binding: owner, dueAt: dayAt(16, '21:30'), now: dayAt(17, '08:00'), signal: expect.any(AbortSignal),
  }));
  expect(f.deliverOwner.mock.calls.map(([item]) => item)).toEqual(report.messages.map(text => ({
    binding: owner, deliveryId: expect.stringMatching(/^[a-f0-9]{64}$/u), text,
  })));
  expect(new Set(f.deliverOwner.mock.calls.map(([item]) => item.deliveryId)).size).toBe(2);
  expect(await readFile(f.path, 'utf8')).not.toContain(report.entries[0]!.detail);
  expect(await f.reopen().expand(owner, 1)).toEqual(report.entries[0]);
  expect(await f.reopen().expand(owner, 0)).toBeNull();
  expect(await f.scheduler.health()).toMatchObject({ state: 'ok', errorCode: null, lastSuccessAt: new Date(f.current.now).toISOString() });
  f.current.binding = formerOwner;
  expect(await f.scheduler.results(owner)).toEqual([]);
});

it('reserves once, stops on the first unconfirmed send, and never repeats that slot after restart', async () => {
  const f = await fixture();
  f.deliverOwner.mockResolvedValueOnce('uncertain');
  f.current.now = dayAt(16, '21:30');
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  const restarted = f.reopen();
  await restarted.tick();
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  expect(await restarted.results(owner)).toEqual([{ at: f.current.now, outcome: 'uncertain', delivered: false, entries: report.entries }]);
  expect(await restarted.expand(owner, 1)).toBeNull();
  expect(await restarted.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_delivery_uncertain', failures: 1 });
  f.current.now = dayAt(17, '21:30');
  await restarted.tick();
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(f.deliverOwner).toHaveBeenCalledTimes(3);
});

it('settles the durable delivering reservation after a crash without sending it again', async () => {
  const f = await fixture();
  const entered = release<void>();
  const done = release<'uncertain'>();
  f.deliverOwner.mockImplementationOnce(async () => { entered.resolve(); return done.promise; });
  f.current.now = dayAt(16, '21:30');
  const pending = f.scheduler.tick();
  await entered.promise;
  try {
    const restarted = f.reopen();
    await restarted.tick();
    expect(f.deliverOwner).toHaveBeenCalledOnce();
    expect(await restarted.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_delivery_uncertain' });
  } finally { done.resolve('uncertain'); await pending; }
});

it('rechecks configuration before the model callback and does not regenerate an interrupted run', async () => {
  const f = await fixture();
  const useModel = vi.fn();
  f.generate.mockImplementationOnce(async guard => {
    f.current.revision = 'revoked';
    await guard.assertCurrent();
    useModel();
    return report;
  });
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  await f.reopen().tick();
  expect(useModel).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(await f.scheduler.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_interrupted' });
});

it('honors quiet hours between parts and does not finish an interrupted delivery later', async () => {
  const f = await fixture();
  f.deliverOwner.mockImplementationOnce(async () => {
    f.current.quiet = true;
    return 'sent';
  });
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  f.current.quiet = false;
  await f.reopen().tick();
  expect(f.deliverOwner).toHaveBeenCalledOnce();
  expect(await f.scheduler.results(owner)).toEqual([{ at: f.current.now, outcome: 'interrupted', delivered: false, entries: report.entries }]);
  expect(await f.scheduler.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_interrupted' });
});

it('reports an unavailable local model and lets a later slot run', async () => {
  const f = await fixture();
  f.generate.mockRejectedValueOnce(new WeChatDigestFailure('model'));
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(await f.scheduler.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_model' });
  f.current.now = dayAt(17, '21:30');
  await f.scheduler.tick();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
  expect(await f.scheduler.health()).toMatchObject({ state: 'ok', errorCode: null });
});

it('reports a missing owner binding without consuming the due occurrence', async () => {
  const f = await fixture();
  f.current.binding = null;
  f.current.now = dayAt(16, '21:30');
  await f.scheduler.tick();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.deliverOwner).not.toHaveBeenCalled();
  expect(await f.scheduler.health()).toMatchObject({ state: 'failing', errorCode: 'wechat.digest_read' });
  f.current.binding = owner;
  await f.scheduler.tick();
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.deliverOwner).toHaveBeenCalledTimes(2);
});
