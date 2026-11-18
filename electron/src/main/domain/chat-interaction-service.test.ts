import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent, PermissionDescriptor } from '../../shared';
import { PermissionGate } from '../runtime/permissions';
import type { ToolDescriptor } from '../runtime/tool-registry';
import { ChatInteractionService } from './chat-interaction-service';
import { ChatService } from './chat-service';
import { DomainRepository } from './repository';

const descriptors: Array<Omit<PermissionDescriptor, 'state' | 'expiresAt'>> = [
  { capabilityId: 'web.read', titleCode: 'permission.webRead.title', detailCode: 'permission.webRead.detail', risk: 'medium' },
  { capabilityId: 'chat.cron', titleCode: 'permission.chatCron', detailCode: 'permission.chatCron.detail', risk: 'high' },
];
const tool: ToolDescriptor = { id: 'web.read', title: 'Read public page', capabilityId: 'web.read', risk: 'medium', sideEffect: false, parameters: {} };
const resources: Array<{ root: string; interactions: ChatInteractionService; repository: DomainRepository }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const item of resources.splice(0)) { item.interactions.cancelAll(); await item.repository.flush(); await rm(item.root, { recursive: true, force: true }); }
});
const fixture = async (options: { emitThrows?: boolean; timeoutMs?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-chat-interaction-'));
  let locked = false;
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => { if (locked) throw new Error('Fixture vault locked'); return Buffer.alloc(32, 65); } });
  await repository.initialize(); const chat = new ChatService(repository); const permissions = new PermissionGate(repository);
  const session = await chat.createSession('Synthetic interactive run', 'normal');
  await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Read this public page.', status: 'complete', errorCode: null });
  const assistant = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  const events: ChatEvent[] = [];
  const interactions = new ChatInteractionService(chat, permissions, descriptors, (event) => {
    if (options.emitThrows) throw new Error('Synthetic renderer disconnected');
    events.push(event);
  }, options.timeoutMs ?? 60_000);
  resources.push({ root, interactions, repository }); const runId = randomUUID(); interactions.start(runId, session.id, assistant.id, true);
  const followup = (content: string, operationId = randomUUID()) => interactions.followup({ runId, sessionId: session.id, operationId, content });
  const requestApproval = () => interactions.requestApproval(runId, tool, { url: 'https://example.test/reference' }, new AbortController().signal);
  const decide = (decision: 'allow-once' | 'allow-run' | 'deny') => interactions.resolveApproval({ runId, sessionId: session.id, approvalId: interactions.get(session.id)!.approval!.id, decision });
  return { repository, chat, permissions, session, assistant, events, interactions, runId, followup, requestApproval, decide, lock: (value: boolean) => { locked = value; } };
};

describe('task-long approval', () => {
  const approvedOnce = async (f: Awaited<ReturnType<typeof fixture>>) => { const waiting = f.requestApproval(); f.decide('allow-run'); (await waiting)!.release(); };
  it('approves later calls of the same capability without another card', async () => {
    const f = await fixture(); await approvedOnce(f);
    expect(f.events.filter((event) => event.type === 'interaction' && event.state.approval !== null)).toHaveLength(1);
    const lease = await f.requestApproval();
    expect(lease).toBeDefined(); lease!.assertCurrent(); lease!.release();
    expect(f.interactions.get(f.session.id)?.approval).toBeNull();
    expect(f.events.filter((event) => event.type === 'interaction' && event.state.approval !== null)).toHaveLength(1);
  });
  it('leaves a once-only decision asking again', async () => {
    const f = await fixture(); const waiting = f.requestApproval(); f.decide('allow-once'); (await waiting)!.release();
    const next = f.requestApproval(); expect(f.interactions.get(f.session.id)?.approval).not.toBeNull();
    f.decide('deny'); await expect(next).rejects.toThrow('chat.approvalDenied');
  });
  it('ends when the user adds instructions', async () => {
    const f = await fixture(); await approvedOnce(f); await f.followup('Do not write anything.');
    const next = f.requestApproval(); expect(f.interactions.get(f.session.id)?.approval).not.toBeNull();
    f.decide('deny'); await expect(next).rejects.toThrow('chat.approvalDenied');
  });
  it('ends when the permission changes', async () => {
    const f = await fixture(); await approvedOnce(f); await f.permissions.revoke('web.read');
    const next = f.requestApproval(); expect(f.interactions.get(f.session.id)?.approval).not.toBeNull();
    f.decide('deny'); await expect(next).rejects.toThrow('chat.approvalDenied');
  });
  it('does not outlive its run or grant anything lasting', async () => {
    const f = await fixture(); await approvedOnce(f); f.interactions.finish(f.runId);
    expect(await f.requestApproval()).toBeUndefined();
    expect(f.permissions.list(descriptors).find((item) => item.capabilityId === 'web.read')?.state).toBe('not-requested');
    expect(f.repository.snapshot().persistentPermissionGrants).toEqual([]);
  });
  it('never offers or accepts it for a recurring schedule', async () => {
    const f = await fixture();
    const cron: ToolDescriptor = { id: 'cron.create', title: 'Create schedule', capabilityId: 'chat.cron', risk: 'high', sideEffect: true, parameters: {} };
    const waiting = f.interactions.requestApproval(f.runId, cron, {}, new AbortController().signal);
    expect(f.interactions.get(f.session.id)?.approval?.allowRun).toBe(false);
    expect(() => f.decide('allow-run')).toThrow('chat.approvalExpired');
    await expect(waiting).rejects.toThrow('chat.approvalExpired');
  });
  it('carries the disclosure recipient to the card', async () => {
    const f = await fixture(); const disclosure = { providerName: 'Synthetic cloud', model: 'alpha', destination: 'remote' as const };
    const waiting = f.interactions.requestApproval(f.runId, tool, {}, new AbortController().signal, disclosure);
    expect(f.interactions.get(f.session.id)?.approval?.disclosure).toEqual(disclosure);
    f.decide('deny'); await expect(waiting).rejects.toThrow('chat.approvalDenied');
  });
});

describe('host-owned chat interaction lifecycle', () => {
  it('persists additions once, drains them in order, and does not finish over queued requirements', async () => {
    const f = await fixture(); const operationId = randomUUID();
    const first = await f.followup('Only use official sources.', operationId);
    expect(await f.followup(' Only use official sources. ', operationId)).toEqual(first);
    await expect(f.followup('A different requirement.', operationId)).rejects.toThrow('chat.followupConflict');
    const second = await f.followup('Reply in Chinese.');
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([]);
    expect(f.interactions.get(f.session.id)).toMatchObject({ queuedFollowups: 2, acceptingFollowups: true });
    expect(f.interactions.finishing(f.runId)).toBe(false);
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([{ role: 'user', content: 'Only use official sources.' }, { role: 'user', content: 'Reply in Chinese.' }]);
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([first.id, second.id]);
    f.interactions.consumedFollowupIds(f.runId).push(randomUUID());
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([]);
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([first.id, second.id]);
    expect(f.events.filter((event) => event.type === 'followup')).toHaveLength(2);
    expect(f.interactions.finishing(f.runId)).toBe(true);
    await expect(f.followup('Too late.')).rejects.toThrow('chat.followupUnavailable');
    expect(f.chat.listMessages(f.session.id).filter((message) => message.followupToMessageId)).toHaveLength(2);
  });

  it('records newly adopted IDs only after their drain succeeds and clears them with the run', async () => {
    const f = await fixture(); const first = await f.followup('First adopted requirement.');
    await f.interactions.drainFollowups(f.runId);
    const second = await f.followup('Persisted but queued requirement.');
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([first.id]);
    await f.interactions.drainFollowups(f.runId);
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([first.id, second.id]);
    f.interactions.finish(f.runId);
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([]);
  });

  it('does not record or deliver a committed addition when the run is cancelled during drain', async () => {
    const f = await fixture(); let release!: () => void; let stored!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const persisted = new Promise<void>((resolve) => { stored = resolve; });
    const original = f.chat.addFollowup.bind(f.chat);
    vi.spyOn(f.chat, 'addFollowup').mockImplementation(async (...args) => {
      const message = await original(...args); stored(); await barrier; return message;
    });
    const accepted = f.followup('Retained for retry after cancellation.');
    const draining = f.interactions.drainFollowups(f.runId);
    await persisted; f.interactions.cancel(f.runId); release();
    const message = await accepted;
    expect(await draining).toEqual([]);
    expect(f.interactions.consumedFollowupIds(f.runId)).toEqual([]);
    expect(f.chat.listMessages(f.session.id).find((item) => item.id === message.id)?.content).toBe(message.content);
  });

  it('enforces run/session ownership and disabled follow-ups before any durable mutation', async () => {
    const f = await fixture(); const before = f.repository.snapshot();
    await expect(f.interactions.followup({ runId: f.runId, sessionId: randomUUID(), operationId: randomUUID(), content: 'Wrong owner.' })).rejects.toThrow('chat.followupUnavailable');
    await expect(f.interactions.followup({ runId: randomUUID(), sessionId: f.session.id, operationId: randomUUID(), content: 'Wrong run.' })).rejects.toThrow('chat.followupUnavailable');
    f.interactions.finish(f.runId); const nextRun = randomUUID(); f.interactions.start(nextRun, f.session.id, f.assistant.id, false);
    await expect(f.interactions.followup({ runId: nextRun, sessionId: f.session.id, operationId: randomUUID(), content: 'Unavailable for deterministic command.' })).rejects.toThrow('chat.followupUnavailable');
    expect(f.repository.snapshot()).toEqual(before);
  });

  it.each(['count', 'characters'] as const)('enforces the %s bound including submissions waiting for persistence', async (kind) => {
    const f = await fixture(); const count = kind === 'count' ? 8 : 4;
    const pending = Array.from({ length: count }, (_, index) => f.followup(kind === 'count' ? `Requirement ${index}` : String(index).repeat(8000)));
    await expect(f.followup('One more.')).rejects.toThrow('chat.followupLimit');
    await Promise.all(pending);
    expect(await f.interactions.drainFollowups(f.runId)).toHaveLength(count);
    await expect(f.followup('Still exceeds this run.')).rejects.toThrow('chat.followupLimit');
    expect(f.chat.listMessages(f.session.id).filter((message) => message.followupToMessageId)).toHaveLength(count);
  });

  it.each(['cancel', 'finish'] as const)('rejects new text after %s without discarding already stored additions', async (action) => {
    const f = await fixture(); const accepted = await f.followup('Keep this after the run stops.');
    f.interactions[action](f.runId);
    await expect(f.followup('New late text.')).rejects.toThrow('chat.followupUnavailable');
    expect(f.chat.listMessages(f.session.id).find((message) => message.id === accepted.id)).toEqual(accepted);
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([]);
  });

  it('cancels preparation promptly and handles late completion or rejection without continuing the run', async () => {
    const f = await fixture(); let rejectOperation!: (error: Error) => void;
    const operation = new Promise<string>((_resolve, reject) => { rejectOperation = reject; });
    const wait = f.interactions.wait(f.runId, operation);
    const rejected = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    f.interactions.cancel(f.runId); await rejected;
    rejectOperation(new Error('Late metadata failure')); await Promise.resolve(); await Promise.resolve();
    await expect(f.interactions.wait(f.runId, Promise.reject(new Error('Already-cancelled metadata failure')))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.interactions.signal(f.runId).aborted).toBe(true);
  });

  it('returns successful preparation and propagates its original failure', async () => {
    const f = await fixture();
    await expect(f.interactions.wait(f.runId, Promise.resolve('prepared'))).resolves.toBe('prepared');
    await expect(f.interactions.wait(f.runId, Promise.reject(new Error('Metadata unavailable')))).rejects.toThrow('Metadata unavailable');
  });

  it('does not lose persisted additions when renderer notifications throw', async () => {
    const f = await fixture({ emitThrows: true });
    const accepted = await f.followup('Persist despite a disconnected renderer.');
    expect(f.chat.listMessages(f.session.id).find((message) => message.id === accepted.id)).toEqual(accepted);
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([{ role: 'user', content: accepted.content }]);
    expect(f.interactions.finishing(f.runId)).toBe(true);
  });
});

describe('operation-bound inline approval', () => {
  it('rejects mismatched run/session/approval IDs and grants only the reviewed pending operation', async () => {
    const f = await fixture(); const waiting = f.requestApproval(); const request = f.interactions.get(f.session.id)!.approval!;
    const valid = { runId: f.runId, sessionId: f.session.id, approvalId: request.id, decision: 'allow-once' as const };
    expect(request).toMatchObject({ runId: f.runId, sessionId: f.session.id, messageId: f.assistant.id, toolId: 'web.read', capabilityId: 'web.read', inputTruncated: false });
    for (const patch of [{ runId: randomUUID() }, { sessionId: randomUUID() }, { approvalId: randomUUID() }]) {
      expect(() => f.interactions.resolveApproval({ ...valid, ...patch })).toThrow('chat.approvalExpired');
      expect(f.interactions.get(f.session.id)!.approval!.id).toBe(request.id);
    }
    f.interactions.resolveApproval(valid); const lease = await waiting;
    expect(lease).toBeDefined(); expect(() => lease!.assertCurrent()).not.toThrow();
    expect(f.interactions.get(f.session.id)!.approval).toBeNull();
    expect(() => f.interactions.resolveApproval(valid)).toThrow('chat.approvalExpired');
    expect(f.repository.snapshot().persistentPermissionGrants).toEqual([]);
    expect(f.permissions.list(descriptors)[0]?.state).toBe('not-requested');
    await expect(f.permissions.consume('web.read')).rejects.toThrow('Permission is required');
    lease!.release();
  });

  it('does not make one run’s approval consumable by another run or capability', async () => {
    const f = await fixture(); const secondSession = await f.chat.createSession('Another run', 'normal');
    const secondAnswer = await f.chat.addMessage({ sessionId: secondSession.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
    const secondRun = randomUUID(); f.interactions.start(secondRun, secondSession.id, secondAnswer.id, true);
    const firstPending = f.requestApproval();
    const secondPending = f.interactions.requestApproval(secondRun, tool, { url: 'https://example.test/second' }, new AbortController().signal);
    const secondId = f.interactions.get(secondSession.id)!.approval!.id;
    f.decide('allow-once'); const firstLease = await firstPending;
    expect(f.interactions.get(secondSession.id)!.approval!.id).toBe(secondId);
    await expect(f.permissions.consume('web.read')).rejects.toThrow('Permission is required');
    await expect(f.permissions.consume('workspace.write')).rejects.toThrow('Permission is required');
    f.interactions.cancel(secondRun); await expect(secondPending).resolves.toBeUndefined(); firstLease!.release();
    expect(f.repository.snapshot().persistentPermissionGrants).toEqual([]);
  });

  it('rejects a decision after permission revision changes and revokes an already issued lease', async () => {
    const f = await fixture(); const waiting = f.requestApproval();
    const request = f.interactions.get(f.session.id)!.approval!;
    await f.permissions.revoke('web.read');
    expect(() => f.interactions.resolveApproval({ runId: f.runId, sessionId: f.session.id, approvalId: request.id, decision: 'allow-once' })).toThrow('chat.approvalExpired');
    await expect(waiting).rejects.toThrow('chat.approvalExpired');
    const next = f.requestApproval(); f.decide('allow-once'); const lease = await next;
    expect(() => lease!.assertCurrent()).not.toThrow();
    await f.permissions.revoke('web.read');
    expect(lease!.signal.aborted).toBe(true); expect(() => lease!.assertCurrent()).toThrow('Permission is required'); lease!.release();
  });

  it('expires unanswered requests and rejects stale decisions using the host clock', async () => {
    const f = await fixture({ timeoutMs: 1000 }); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const waiting = f.requestApproval(); const request = f.interactions.get(f.session.id)!.approval!;
    const expired = expect(waiting).rejects.toThrow('chat.approvalExpired');
    await vi.advanceTimersByTimeAsync(1000);
    await expired; expect(f.interactions.get(f.session.id)!.approval).toBeNull();
    expect(() => f.interactions.resolveApproval({ runId: f.runId, sessionId: f.session.id, approvalId: request.id, decision: 'allow-once' })).toThrow('chat.approvalExpired');
  });

  it('rejects an expired decision even when its timer has not run yet', async () => {
    const f = await fixture({ timeoutMs: 1000 }); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const waiting = f.requestApproval(); const request = f.interactions.get(f.session.id)!.approval!;
    vi.setSystemTime(Date.now() + 1001);
    expect(f.interactions.get(f.session.id)!.approval!.id).toBe(request.id);
    expect(() => f.interactions.resolveApproval({ runId: f.runId, sessionId: f.session.id, approvalId: request.id, decision: 'allow-once' })).toThrow('chat.approvalExpired');
    await expect(waiting).rejects.toThrow('chat.approvalExpired');
    expect(f.repository.snapshot().persistentPermissionGrants).toEqual([]);
  });

  it('bounds an issued one-shot lease lifetime without storing a grant', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const waiting = f.requestApproval(); f.decide('allow-once'); const lease = await waiting;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(() => lease!.assertCurrent()).toThrow('Permission is required'); lease!.release();
    expect(f.repository.snapshot().persistentPermissionGrants).toEqual([]);
  });

  it.each(['deny', 'cancel', 'finish', 'abort'] as const)('settles pending approval after %s without creating permission', async (action) => {
    const f = await fixture(); const controller = new AbortController();
    const waiting = f.interactions.requestApproval(f.runId, tool, { url: 'https://example.test' }, controller.signal);
    if (action === 'deny') f.decide('deny'); else if (action === 'abort') controller.abort(); else f.interactions[action](f.runId);
    if (action === 'deny') await expect(waiting).rejects.toThrow('chat.approvalDenied');
    else await expect(waiting).resolves.toBeUndefined();
    expect(f.interactions.get(f.session.id)?.approval ?? null).toBeNull();
    await expect(f.permissions.consume('web.read')).rejects.toThrow('Permission is required');
  });

  it('invalidates the old approval only after a new requirement is durably accepted', async () => {
    const f = await fixture(); const waiting = f.requestApproval(); const stale = f.interactions.get(f.session.id)!.approval!;
    const accepted = await f.followup('Use a different official page.');
    await expect(waiting).resolves.toBeUndefined();
    expect(f.chat.listMessages(f.session.id).some((message) => message.id === accepted.id)).toBe(true);
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([{ role: 'user', content: accepted.content }]);
    const next = f.requestApproval(); const nextId = f.interactions.get(f.session.id)!.approval!.id;
    expect(nextId).not.toBe(stale.id);
    expect(() => f.interactions.resolveApproval({ runId: f.runId, sessionId: f.session.id, approvalId: stale.id, decision: 'allow-once' })).toThrow('chat.approvalExpired');
    expect(f.interactions.get(f.session.id)!.approval!.id).toBe(nextId);
    f.decide('deny'); await expect(next).rejects.toThrow('chat.approvalDenied');
  });

  it('keeps the original approval and persisted state after a failed addition, then safely retries the same ID', async () => {
    const f = await fixture(); const waiting = f.requestApproval(); const requestId = f.interactions.get(f.session.id)!.approval!.id;
    const operationId = randomUUID(); const before = f.repository.snapshot(); f.lock(true);
    await expect(f.followup('Use the revised source.', operationId)).rejects.toThrow('Fixture vault locked');
    expect(f.repository.snapshot()).toEqual(before);
    expect(f.interactions.get(f.session.id)).toMatchObject({ queuedFollowups: 0, approval: { id: requestId } });
    expect(f.events.filter((event) => event.type === 'followup')).toEqual([]);
    f.lock(false); const accepted = await f.followup('Use the revised source.', operationId);
    await expect(waiting).resolves.toBeUndefined();
    expect(await f.interactions.drainFollowups(f.runId)).toEqual([{ role: 'user', content: accepted.content }]);
    expect(f.chat.listMessages(f.session.id).filter((message) => message.id === operationId)).toHaveLength(1);
  });

  it('settles authorization even when renderer notifications throw', async () => {
    const f = await fixture({ emitThrows: true }); const waiting = f.requestApproval();
    f.decide('allow-once'); const lease = await waiting;
    expect(lease).toBeDefined(); expect(() => lease!.assertCurrent()).not.toThrow(); lease!.release();
    expect(f.interactions.get(f.session.id)!.approval).toBeNull();
  });
});
