// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainRepository } from './repository';
import { TimerService } from './timer-service';
import { createDefaultState, persistentStateSchema } from './schemas';
import { formatTimerDeadline } from '../../shared/timer-time';
import { ChatService } from './chat-service';
import { prepareChatContext } from './chat-context';
const roots: string[] = [];
const now = new Date('2026-10-22T10:00:00.000Z');
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-durable-timer-')); roots.push(root);
  const reopen = async () => { const repo = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 7) }); await repo.initialize(); return repo; };
  const repository = await reopen(); const notify = vi.fn(async () => undefined);
  return { repository, reopen, notify, service: new TimerService(repository, notify) };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it('opens existing version-one profiles with no timers field', () => {
  const old: Partial<ReturnType<typeof createDefaultState>> = createDefaultState(); delete old.timers;
  expect(persistentStateSchema.parse(old).timers).toEqual([]);
});
it('persists a single trusted receipt across retry and restart, retaining it for conversational recall', async () => {
  const f = await fixture(); const chat = new ChatService(f.repository);
  const session = await chat.createSession('receipt', 'normal');
  await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Remind me to drink water in 60 seconds.', status: 'complete', errorCode: null });
  const message = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
  const receipt = { timerId: crypto.randomUUID(), label: 'Water', seconds: 60, dueAt: '2026-10-22T10:01:00Z', timeZone: 'Asia/Shanghai' };
  await chat.addTimerReceipt(message.id, receipt); await chat.addTimerReceipt(message.id, receipt);
  await chat.stampHostReply(message.id);
  const reopened = new ChatService(await f.reopen()).listMessages(session.id);
  expect(reopened.find((item) => item.id === message.id)?.timerReceipts).toEqual([receipt]);
  const context = prepareChatContext({ sessionId: session.id, history: reopened, memories: [], query: 'When?', locale: 'en',
    binding: { providerId: 'synthetic-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true },
    requiredMessages: [{ role: 'user', content: 'When?' }], maxOutputTokens: 512,
    contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' },
  }).messages;
  expect(context.some((item) => item.content.includes('2026-10-22 18:01:00 (Asia/Shanghai, GMT+08:00)'))).toBe(true);
  expect(reopened.find((item) => item.id === message.id)?.requestReceipts).toBeUndefined();
});
it('returns an explicit local deadline and handles midnight and daylight-saving changes', async () => {
  const f = await fixture(); const service = new TimerService(f.repository, f.notify, () => 'Asia/Shanghai');
  const result = await service.create(120, 'water', new Date('2026-10-22T15:59:00Z'));
  expect(result).toMatchObject({ seconds: 120, label: 'water', dueAt: '2026-10-22T16:01:00.000Z', timeZone: 'Asia/Shanghai', localDueAt: '2026-10-23 00:01:00 (Asia/Shanghai, GMT+08:00)' });
  expect(formatTimerDeadline('2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-01 01:30:00 (America/New_York, GMT-04:00)');
  expect(formatTimerDeadline('2026-11-01T06:30:00Z', 'America/New_York')).toBe('2026-11-01 01:30:00 (America/New_York, GMT-05:00)');
});
it('restores the exact deadline, delivers overdue reminders once, and persists completion across restarts', async () => {
  const f = await fixture(); const result = await f.service.create(60, '喝水', now);
  expect(result.dueAt).toBe('2026-10-22T10:01:00.000Z');
  const second = new TimerService(await f.reopen(), f.notify);
  expect(await second.tick(new Date('2026-10-22T10:00:59Z'))).toBe(0);
  expect(await Promise.all([second.tick(new Date('2026-10-22T10:02:00Z')), second.tick(new Date('2026-10-22T10:02:00Z'))])).toEqual([1, 0]);
  expect(f.notify).toHaveBeenCalledOnce();
  const third = new TimerService(await f.reopen(), f.notify);
  expect(await third.tick(new Date('2026-10-22T10:03:00Z'))).toBe(0);
  expect(third.list()[0]).toMatchObject({ id: result.timerId, status: 'completed' });
});
it('keeps notification failures pending and persists cancellation without later firing', async () => {
  const f = await fixture(); await f.service.create(1, 'retry', now);
  f.notify.mockRejectedValueOnce(new Error('notification unavailable'));
  await expect(f.service.tick(new Date(now.getTime() + 2_000))).rejects.toThrow('notification unavailable');
  expect((await f.reopen()).snapshot().timers[0]?.status).toBe('pending');
  await f.service.tick(new Date(now.getTime() + 3_000));
  const cancel = await f.service.create(1, 'cancel', now); await f.service.cancel(cancel.timerId);
  const next = new TimerService(await f.reopen(), f.notify);
  expect(await next.tick(new Date(now.getTime() + 4_000))).toBe(0);
  expect(f.notify).toHaveBeenCalledTimes(2);
});
