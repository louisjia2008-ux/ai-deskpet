// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCronBinding, ChatCronInput } from '../../../shared/chat-cron';
import type { ProviderConfig } from '../../../shared';
import type { QqCronOperation } from '../../../shared/qq-channel';
import { ChatService } from '../../domain/chat-service';
import { ChatCronService } from '../../domain/chat-cron-service';
import { DomainRepository } from '../../domain/repository';
import { PermissionGate } from '../../runtime/permissions';
import { providerBindingFingerprint } from '../../providers/request-budget';
import { assertQqCronDelivery } from '../../security/qq-cron-delivery';
import type { QqOutboxItem } from '../../../shared/qq-channel';
import { QqChannelStore } from './qq-channel-store';
import { QqChannelService } from './qq-channel-service';
import type { QqSendControls, QqTransport } from './qq-channel-service';
import type { QqAdapterEvents, QqSendResult } from './qq-official-adapter';
import { QqCronCoordinator } from './qq-cron-coordinator';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release };
};
const body = (patch: Partial<ChatCronInput> = {}): ChatCronInput => ({ title: 'Public research', instruction: 'Read public weather information',
  expression: '*/15 * * * *', timezone: 'UTC', allowedCapabilities: ['web.search', 'web.read'], missedPolicy: 'skip', ...patch });
class Transport implements QqTransport {
  sendToGroup = async (): Promise<QqSendResult> => ({ ok: false, unknown: false, error: 'qq.sendBlocked' });
  lastError = null;
  sends: string[] = [];
  result: QqSendResult = { ok: true, unknown: false };
  beforeSend: (() => Promise<void>) | null = null;
  async start(_credentials: unknown, events: QqAdapterEvents): Promise<void> { events.onConnectionChange('online'); }
  stop(): void { /* no socket */ }
  async sendToUser(_id: string, text: string, _reply?: string, controls?: QqSendControls): Promise<QqSendResult> {
    await this.beforeSend?.(); controls?.assertCurrent(); this.sends.push(text); return this.result;
  }
}
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-qq-cron-')); roots.push(root);
  const vault = { getVaultKey: async () => Buffer.alloc(32, 81) };
  const repository = new DomainRepository(join(root, 'profile.enc.json'), vault); await repository.initialize();
  const chat = new ChatService(repository), permissions = new PermissionGate(repository);
  const provider: ProviderConfig = { id: randomUUID(), kind: 'openai-compatible', name: 'Synthetic QQ provider',
    baseUrl: 'https://synthetic.invalid/v1', model: 'frozen-model', enabled: true, supportsTools: true, secretState: 'missing' };
  await repository.transaction(state => { state.providers.push(provider); state.providerCredentialRefs[provider.id] = randomUUID(); });
  let now = Date.parse('2026-11-02T08:00:00Z');
  const store = new QqChannelStore(join(root, 'qq.enc.json'), vault), adapter = new Transport();
  let coordinator: QqCronCoordinator;
  const execute = vi.fn<ConstructorParameters<typeof ChatCronService>[1]['execute']>(async () => undefined);
  const cron = new ChatCronService(repository, { now: () => now, execute, assertSchedule: schedule => { if (schedule.channel) coordinator.assertSchedule(schedule); } });
  const apply = vi.fn(async (operation: QqCronOperation) => {
    // Open the actual encrypted file: consumption must be durable, not merely
    // visible in the service's memory, before entering the domain transaction.
    const disk = new QqChannelStore(join(root, 'qq.enc.json'), vault); await disk.initialize();
    expect(disk.snapshot().confirmations).toEqual([]);
    return coordinator.apply(operation);
  });
  const runs = vi.fn(async () => ({ ok: false as const, code: 'not-used' }));
  const deps = { store, adapter, now: () => new Date(now), profileId: () => repository.snapshot().profileId, getSecret: async () => 'synthetic-secret',
    host: { createBindingSession: async (id: string) => ({ sessionId: (await chat.createSession('QQ', 'normal', new Date(now), id)).id }),
      runMessage: runs, onStopped: async () => { for (const s of repository.snapshot().chatCronSchedules) if (s.channel && s.enabled) await cron.pause(s.sessionId, s.id, () => undefined); },
      assertDelivery: () => undefined, assertCronOperation: (operation: QqCronOperation) => coordinator.assertOperation(operation), applyConfirmedCron: apply } };
  const service = new QqChannelService(deps);
  const coordinatorDeps = { store: repository, cron, now: () => now, assertAuthority: service.assertAuthorized.bind(service),
    webCallLimit: service.webCallLimit.bind(service), permissionRevision: permissions.revision.bind(permissions),
    provider: (owner: ChatCronBinding) => {
      const state = repository.snapshot(), current = state.providers.find(p => p.id === owner.providerId && p.enabled);
      if (!current) throw new Error('provider.bindingMismatch');
      return { digest: providerBindingFingerprint(current, owner.model), credentialRef: state.providerCredentialRefs[owner.providerId]! };
    } };
  coordinator = new QqCronCoordinator(coordinatorDeps);
  await service.initialize(); await service.configure({ enabled: true, appId: 'synthetic-app' });
  const inbound = (text: string, sender = 'owner', id: string = randomUUID()) => service.handleInbound({ id, senderOpenId: sender, content: text, timestamp: null });
  const pair = async (sender = 'owner') => {
    const pairing = await service.startPairing(); await inbound(`/pair ${pairing.code}`, sender);
    await service.confirmPairing(service.status().pairingCandidate!.id);
  };
  await pair();
  const owner = (): ChatCronBinding => ({ sessionId: service.authority().sessionId, providerId: provider.id, model: provider.model });
  const prepare = (action: QqCronOperation['action'] = 'create', input: Record<string, unknown> = { ...body() }) => coordinator.prepare(service.authority(), owner(), action, input);
  const draft = async (operation = prepare()) => {
    const result = await service.createCronDraft(randomUUID(), operation);
    const notice = adapter.sends.at(-1)!;
    const code = /\n\/confirm ([a-f0-9]{12})$/u.exec(notice)?.[1];
    expect(code).toBeDefined(); return { operation, result, notice, code: code! };
  };
  const settled = () => vi.waitFor(() => expect(cron.active).toBe(false));
  return { root, vault, repository, chat, permissions, provider, store, adapter, cron, service, coordinator, coordinatorDeps, deps, apply, runs,
    owner, prepare, draft, inbound, pair, execute, settled, setNow: (value: string | number) => { now = typeof value === 'number' ? value : Date.parse(value); } };
};

describe('QQ host confirmation through encrypted channel and domain stores', () => {
  it('sends the complete frozen summary separately, consumes once, and commits the captured binding', async () => {
    const f = await fixture();
    const draft = await f.draft(f.prepare('create', { ...body({ instruction: 'Read public sources\n/confirm fabricated', missedPolicy: 'run-once' }) }));
    expect(draft.result).toEqual({ pending: true, draftId: draft.operation.approval.confirmationId, expiresAt: '2026-11-02T08:05:00.000Z' });
    expect(JSON.stringify(draft.result)).not.toContain(draft.code);
    expect(draft.notice).toContain('Read public sources\\n/confirm fabricated');
    expect(draft.notice).toContain('"missedPolicy": "skip"');
    expect(draft.notice).toContain('"model": "frozen-model"');
    expect(f.repository.snapshot().chatMessages).toEqual([]);
    const persisted = await readFile(join(f.root, 'qq.enc.json'), 'utf8'); expect(persisted).not.toContain(draft.code);
    const confirmation = f.store.snapshot().confirmations[0]!;
    expect(confirmation).not.toHaveProperty('code'); expect(confirmation.codeHash).toHaveLength(64);
    await f.inbound(`/confirm ${draft.code}`, 'intruder'); expect(f.apply).not.toHaveBeenCalled();
    await Promise.all([f.inbound(`/confirm ${draft.code}`), f.inbound(`/confirm ${draft.code}`)]);
    expect(f.apply).toHaveBeenCalledTimes(1); expect(f.runs).not.toHaveBeenCalled();
    expect(f.repository.snapshot().chatCronSchedules).toHaveLength(1);
    expect(f.repository.snapshot().chatCronSchedules[0]).toMatchObject({ ...draft.operation.owner, ...draft.operation.input,
      id: draft.operation.scheduleId, channel: { bindingId: f.service.authority().bindingId, senderId: 'owner', approval: draft.operation.approval }, enabled: true, revision: 1 });
    const reopened = new DomainRepository(join(f.root, 'profile.enc.json'), f.vault); await reopened.initialize();
    expect(reopened.snapshot().chatCronSchedules).toEqual(f.repository.snapshot().chatCronSchedules);
  });

  it('updates complete parameters without switching provider and requires a new confirmation to resume', async () => {
    const f = await fixture(), initial = await f.draft(); await f.inbound(`/confirm ${initial.code}`);
    const id = initial.operation.scheduleId;
    await f.cron.pause(f.owner().sessionId, id, () => undefined);
    const changedOwner = { ...f.owner(), providerId: randomUUID(), model: 'new-chat-selection' };
    const operation = f.coordinator.prepare(f.service.authority(), changedOwner, 'update', { scheduleId: id, instruction: 'Updated public query', allowedCapabilities: ['time.read'] });
    expect(operation.owner).toEqual(initial.operation.owner); expect(operation.enabled).toBe(false);
    expect(operation.input).toMatchObject({ title: 'Public research', expression: '*/15 * * * *', instruction: 'Updated public query' });
    const update = await f.draft(operation); await f.inbound(`/confirm ${update.code}`);
    expect(f.cron.list(f.owner().sessionId)[0]).toMatchObject({ enabled: false, revision: 3, allowedCapabilities: ['time.read'] });
    const resume = await f.draft(f.prepare('resume', { scheduleId: id, allowedCapabilities: ['time.read'] }));
    await f.inbound(`/confirm ${resume.code}`);
    expect(f.cron.list(f.owner().sessionId)[0]).toMatchObject({ enabled: true, revision: 4, instruction: 'Updated public query' });
    await expect(f.cron.update(f.owner().sessionId, id, { allowedCapabilities: [] }, () => undefined)).rejects.toThrow('qq.confirmationRequired');
    await expect(f.cron.resume(f.owner().sessionId, id, () => undefined)).rejects.toThrow('qq.confirmationRequired');
    await expect(f.cron.create(f.owner(), body(), () => undefined)).rejects.toThrow('qq.confirmationRequired');
    await f.cron.cancel(f.owner().sessionId, id, () => undefined);
    expect(() => f.prepare('resume', { scheduleId: id, allowedCapabilities: ['time.read'] })).toThrow('cron.notFound');
  });

  it('invalidates the old code on replacement and expires the new code after five minutes', async () => {
    const f = await fixture(), first = await f.draft(), second = await f.draft();
    await f.inbound(`/confirm ${first.code}`); expect(f.apply).not.toHaveBeenCalled();
    f.setNow('2026-11-02T08:05:00Z'); await f.inbound(`/confirm ${second.code}`);
    expect(f.apply).not.toHaveBeenCalled(); expect(f.store.snapshot().confirmations).toEqual([]);
  });

  it('locks after five distinct guesses; duplicate message deliveries do not count twice', async () => {
    const f = await fixture(), d = await f.draft(), wrong = d.code === '000000000000' ? '111111111111' : '000000000000';
    await f.inbound(`/confirm ${wrong}`, 'owner', 'same'); await f.inbound(`/confirm ${wrong}`, 'owner', 'same');
    expect(f.store.snapshot().confirmations[0]?.attempts).toBe(1);
    for (let n = 0; n < 4; n++) await f.inbound(`/confirm ${wrong}`);
    await f.inbound(`/confirm ${d.code}`); expect(f.apply).not.toHaveBeenCalled(); expect(f.store.snapshot().confirmations).toEqual([]);
  });

  it.each(['provider', 'credential', 'permission', 'web-limit', 'stop', 'rebind', 'archive'] as const)('rejects a pending draft after %s changes', async change => {
    const f = await fixture(), d = await f.draft();
    if (change === 'provider') await f.repository.transaction(state => { state.providers[0]!.baseUrl = 'https://other.invalid/v1'; });
    if (change === 'credential') await f.repository.transaction(state => { state.providerCredentialRefs[f.provider.id] = randomUUID(); });
    if (change === 'permission') await f.permissions.revoke('web.search');
    if (change === 'web-limit') await f.service.configure({ webCallLimit: 1 });
    if (change === 'stop') await f.service.emergencyStop();
    if (change === 'rebind') { await f.service.unbind(); await f.service.configure({ enabled: true }); await f.pair('new-owner'); }
    if (change === 'archive') await f.chat.setArchived(f.owner().sessionId, true);
    await f.inbound(`/confirm ${d.code}`);
    expect(f.repository.snapshot().chatCronSchedules).toEqual([]); expect(f.runs).not.toHaveBeenCalled();
  });

  it.each(['revision', 'foreign-binding', 'foreign-session', 'foreign-sender'] as const)('rejects update/resume when %s changes before commit', async change => {
    const f = await fixture(), first = await f.draft(); await f.inbound(`/confirm ${first.code}`);
    const id = first.operation.scheduleId, update = f.prepare('update', { scheduleId: id, title: 'Changed', allowedCapabilities: [] });
    await f.repository.transaction(state => {
      const schedule = state.chatCronSchedules[0]!;
      if (change === 'revision') schedule.revision++;
      if (change === 'foreign-binding') schedule.channel!.bindingId = 'other-binding';
      if (change === 'foreign-session') schedule.sessionId = randomUUID();
      if (change === 'foreign-sender') schedule.channel!.senderId = 'other-sender';
    });
    await expect(f.coordinator.apply(update)).rejects.toThrow('cron.scopeChanged');
    expect(f.repository.snapshot().chatCronSchedules[0]?.title).toBe('Public research');
  });

  it('does not apply if consumption cannot be persisted, and never retries an unknown apply outcome', async () => {
    const f = await fixture(), d = await f.draft();
    const update = f.store.update.bind(f.store);
    let writes = 0;
    vi.spyOn(f.store, 'update').mockImplementation(mutation => {
      if (++writes === 2) return Promise.reject(new Error('disk full')); // admission succeeds, consume fails
      return update(mutation);
    });
    await f.inbound(`/confirm ${d.code}`); expect(f.apply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    f.apply.mockImplementationOnce(async operation => { await f.coordinator.apply(operation); throw new Error('lost acknowledgement'); });
    await f.inbound(`/confirm ${d.code}`); await f.inbound(`/confirm ${d.code}`);
    expect(f.apply).toHaveBeenCalledTimes(1); expect(f.repository.snapshot().chatCronSchedules).toHaveLength(1);
    expect(f.adapter.sends.at(-2)).toContain('不要假定已启用');
  });

  it('does not replay consumption after domain persistence failure or process restart', async () => {
    const f = await fixture(), d = await f.draft();
    const transaction = f.repository.transaction.bind(f.repository);
    vi.spyOn(f.repository, 'transaction').mockRejectedValueOnce(new Error('disk full'));
    await f.inbound(`/confirm ${d.code}`); await f.inbound(`/confirm ${d.code}`);
    expect(f.apply).toHaveBeenCalledTimes(1); expect(f.repository.snapshot().chatCronSchedules).toEqual([]);
    vi.restoreAllMocks();
    await transaction(() => undefined);
    const next = await f.draft();
    const restart = new QqChannelService({ ...f.deps, store: new QqChannelStore(join(f.root, 'qq.enc.json'), f.vault) });
    await restart.initialize();
    await restart.handleInbound({ id: randomUUID(), senderOpenId: 'owner', content: `/confirm ${next.code}`, timestamp: null });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'pending', 'changed-summary', 'changed-digest'] as const)('refuses confirmation of a %s notice', async condition => {
    const f = await fixture(), d = await f.draft();
    await f.store.update(state => {
      const notice = state.outbox.find(item => item.confirmationId)!;
      if (condition === 'failed') notice.status = 'failed';
      if (condition === 'pending') { notice.status = 'pending'; notice.attempts = 0; }
      if (condition === 'changed-summary') notice.content = 'An incomplete summary';
      if (condition === 'changed-digest') state.confirmations[0]!.operationDigest = '0'.repeat(64);
    });
    await f.inbound(`/confirm ${d.code}`); expect(f.apply).not.toHaveBeenCalled();
  });

  it('accepts proof of receipt after an uncertain POST, but never sends a stale summary after transport waits', async () => {
    const f = await fixture(); f.adapter.result = { ok: false, unknown: true };
    const d = await f.draft(); await f.inbound(`/confirm ${d.code}`); expect(f.apply).toHaveBeenCalledTimes(1);
    const entered = gate(), release = gate();
    f.adapter.beforeSend = async () => { entered.release(); await release.promise; };
    const pending = f.service.createCronDraft(randomUUID(), f.prepare()); await entered.promise;
    await f.permissions.revoke('web.search'); release.release(); await pending;
    expect(f.adapter.sends.filter(text => text.startsWith('【桌宠宿主确认'))).toHaveLength(1);
  });

  it('rechecks permission inside a queued domain transaction', async () => {
    const f = await fixture(), operation = f.prepare(), entered = gate(), release = gate();
    const blocker = f.repository.transaction(async () => { entered.release(); await release.promise; }); await entered.promise;
    const apply = f.coordinator.apply(operation), rejected = expect(apply).rejects.toThrow('qq.cronApprovalStale');
    const revoke = f.permissions.revoke('web.search'); release.release(); await blocker; await rejected; await revoke;
    expect(f.repository.snapshot().chatCronSchedules).toEqual([]);
  });

  it.each(['revision', 'binding', 'session-origin'] as const)('rechecks %s changed by an earlier queued transaction', async change => {
    const f = await fixture(), initial = f.prepare(); await f.coordinator.apply(initial);
    const update = f.prepare('update', { scheduleId: initial.scheduleId, title: 'Never commit', allowedCapabilities: [] });
    const entered = gate(), release = gate();
    const blocker = f.repository.transaction(async state => {
      entered.release(); await release.promise;
      if (change === 'revision') state.chatCronSchedules[0]!.revision++;
      if (change === 'binding') state.chatCronSchedules[0]!.channel!.bindingId = 'other-binding';
      if (change === 'session-origin') state.chatSessions[0]!.channelBindingId = randomUUID();
    });
    await entered.promise;
    const rejected = expect(f.coordinator.apply(update)).rejects.toThrow(change === 'session-origin' ? 'qq.sessionOriginMismatch' : 'cron.scopeChanged');
    release.release(); await Promise.all([blocker, rejected]);
    expect(f.repository.snapshot().chatCronSchedules[0]?.title).toBe('Public research');
  });

  it('does not let missing legacy channel metadata bypass the session-origin confirmation requirement', async () => {
    const f = await fixture(), operation = f.prepare(); await f.coordinator.apply(operation);
    await f.repository.transaction(state => { delete state.chatCronSchedules[0]!.channel; });
    await expect(f.cron.resume(f.owner().sessionId, operation.scheduleId, () => undefined)).rejects.toThrow('qq.confirmationRequired');
    await expect(f.cron.update(f.owner().sessionId, operation.scheduleId, { allowedCapabilities: [] }, () => undefined)).rejects.toThrow('qq.confirmationRequired');
  });

  it('immediately aborts QQ work when its bookkeeping permission is revoked without affecting desktop tasks', async () => {
    const f = await fixture(), operation = f.prepare(); await f.coordinator.apply(operation);
    const desktop = await f.chat.createSession('Desktop', 'normal');
    const desktopTask = await f.cron.create({ ...f.owner(), sessionId: desktop.id }, body(), () => undefined);
    const entered = gate(), release = gate();
    // Both tasks are due; wait for the QQ one specifically, since their start order is not fixed.
    f.execute.mockImplementation(async (schedule) => { if (schedule.id === operation.scheduleId) entered.release(); await release.promise; });
    f.setNow('2026-11-02T08:15:00Z'); await f.cron.tick(); await entered.promise;
    await f.cron.revokeCapability('task.records');
    expect(f.cron.list(f.owner().sessionId)[0]?.enabled).toBe(false);
    expect(f.cron.list(desktop.id)[0]).toMatchObject({ id: desktopTask.id, enabled: true });
    expect(f.execute.mock.calls.find(([schedule]) => schedule.id === operation.scheduleId)?.[2].aborted).toBe(true);
    release.release(); await f.settled();
  });

  it('enforces the ten-task cap atomically even for two independently prepared confirmations', async () => {
    const f = await fixture();
    for (let n = 0; n < 9; n++) await f.coordinator.apply(f.prepare());
    const a = f.prepare(), b = f.prepare();
    const results = await Promise.allSettled([f.coordinator.apply(a), f.coordinator.apply(b)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.repository.snapshot().chatCronSchedules).toHaveLength(10);
    expect(() => f.prepare()).toThrow('qq.cronTaskLimit');
    await f.cron.pause(f.owner().sessionId, a.scheduleId, () => undefined);
    expect(() => f.prepare()).toThrow('qq.cronTaskLimit');
    await f.cron.cancel(f.owner().sessionId, a.scheduleId, () => undefined);
    await f.coordinator.apply(f.prepare()); expect(f.repository.snapshot().chatCronSchedules).toHaveLength(11);
  });

  it('makes repeated atomic commits a no-op, including while the approved run is active', async () => {
    const f = await fixture(), operation = f.prepare(); await f.coordinator.apply(operation);
    const entered = gate(), release = gate();
    f.execute.mockImplementation(async () => { entered.release(); await release.promise; });
    f.setNow('2026-11-02T08:15:00Z'); await f.cron.tick(); await entered.promise;
    const first = f.cron.list(f.owner().sessionId)[0];
    expect(await f.coordinator.apply(operation)).toEqual(first);
    expect(f.execute.mock.calls[0]?.[2].aborted).toBe(false);
    expect(f.cron.list(f.owner().sessionId)[0]?.revision).toBe(1);
    release.release(); await f.settled();
    await f.cron.pause(f.owner().sessionId, operation.scheduleId, () => undefined);
    await expect(f.coordinator.apply(operation)).rejects.toThrow('cron.operationConflict');
  });

  it('checks actual start separation as well as syntax, and skips missed slots without catch-up', async () => {
    const f = await fixture(); await f.cron.tick(); await f.coordinator.apply(f.prepare());
    f.setNow('2026-11-02T08:15:59Z'); expect(await f.cron.tick()).toBe(1); await f.settled();
    f.setNow('2026-11-02T08:30:00Z'); expect(await f.cron.tick()).toBe(0);
    expect(f.cron.history(f.owner().sessionId)[0]).toMatchObject({ status: 'missed', errorCode: 'qq.cronTooFrequent' });
    f.setNow('2026-11-02T08:46:00Z'); expect(await f.cron.tick()).toBe(0);
    expect(f.cron.history(f.owner().sessionId)[0]?.errorCode).toBe('cron.missedSkipped');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks live policy during execution and pauses stale approvals on reservation or restart', async () => {
    const f = await fixture(), operation = f.prepare(); await f.coordinator.apply(operation);
    const entered = gate(), release = gate(); f.execute.mockImplementation(async () => { entered.release(); await release.promise; });
    f.setNow('2026-11-02T08:15:00Z'); await f.cron.tick(); await entered.promise;
    const current = f.execute.mock.calls[0]![3]; current();
    await f.permissions.revoke('web.read'); expect(current).toThrow('qq.cronApprovalStale'); release.release(); await f.settled();
    f.setNow('2026-11-02T08:30:00Z'); expect(await f.cron.tick()).toBe(0);
    expect(f.cron.list(f.owner().sessionId)[0]?.enabled).toBe(false);
    const resume = f.prepare('resume', { scheduleId: operation.scheduleId, allowedCapabilities: ['web.read', 'web.search'] });
    await f.coordinator.apply(resume);
    const freshProcess = new QqCronCoordinator(f.coordinatorDeps);
    expect(() => freshProcess.assertSchedule(f.cron.list(f.owner().sessionId)[0]!)).toThrow('qq.cronApprovalStale');
  });

  it('shares the daily ceiling with chat and reserves each scheduled run only once', async () => {
    const f = await fixture(); await f.service.configure({ dailyRequestLimit: 2 });
    const authority = f.service.authority(), runId = randomUUID();
    await f.service.reserveScheduledRequest(authority, runId);
    await expect(f.service.reserveScheduledRequest(authority, runId)).rejects.toThrow('qq.duplicateRun');
    await f.inbound('ordinary chat'); expect(f.runs).toHaveBeenCalledTimes(1);
    await expect(f.service.reserveScheduledRequest(authority, randomUUID())).rejects.toThrow('qq.dailyLimit');
    f.setNow('2026-11-03T00:00:00Z'); await f.service.reserveScheduledRequest(authority, randomUUID());
    expect(f.service.status().dailyRequests).toBe(1);
  });

  it('blocks stale, paused, cancelled, revoked and wrong-run result deliveries at the final gate', async () => {
    const f = await fixture(), operation = f.prepare(); await f.coordinator.apply(operation);
    f.setNow('2026-11-02T08:15:00Z'); await f.cron.tick(); await f.settled();
    const run = f.cron.history(f.owner().sessionId)[0]!;
    const item: QqOutboxItem = { id: randomUUID(), authority: operation.authority, kind: 'cron', scheduleId: operation.scheduleId,
      scheduleRevision: 1, runId: run.id, assistantMessageId: randomUUID(), content: 'Complete reply', replyTo: null, status: 'pending', attempts: 0,
      createdAt: '2026-11-02T08:15:00.000Z', lastAttemptAt: null, errorCode: null };
    const running = vi.fn(), check = (entry = item) => assertQqCronDelivery(entry, f.repository.snapshot(), schedule => f.coordinator.assertSchedule(schedule), running);
    expect(check).not.toThrow(); expect(running).not.toHaveBeenCalled();
    expect(() => check({ ...item, runId: randomUUID() })).toThrow('qq.disclosureBlocked');
    expect(() => check({ ...item, scheduleRevision: 2 })).toThrow('qq.disclosureBlocked');
    expect(() => check({ ...item, authority: { ...item.authority, senderId: 'new-owner' } })).toThrow('qq.disclosureBlocked');
    for (const status of ['reserved', 'cancelled', 'failed', 'interrupted'] as const) {
      await f.repository.transaction(state => { state.chatCronRuns[0]!.status = status; });
      expect(check).toThrow('qq.disclosureBlocked');
    }
    await f.repository.transaction(state => { state.chatCronRuns[0]!.status = 'running'; });
    running.mockImplementation(() => { throw new Error('run-cancelled-before-post'); });
    expect(check).toThrow('run-cancelled-before-post');
    await f.repository.transaction(state => { state.chatCronRuns[0]!.status = 'succeeded'; });
    const update = f.prepare('update', { scheduleId: operation.scheduleId, title: 'Revised task', allowedCapabilities: [] });
    await f.coordinator.apply(update); expect(check).toThrow('qq.disclosureBlocked');
    const currentItem = { ...item, scheduleRevision: 2 };
    await f.repository.transaction(state => { state.chatCronRuns[0]!.scheduleRevision = 2; });
    expect(() => check(currentItem)).not.toThrow();
    await f.permissions.revoke('chat.cron'); expect(() => check(currentItem)).toThrow('qq.cronApprovalStale');
    await f.cron.pause(f.owner().sessionId, operation.scheduleId, () => undefined); expect(() => check(currentItem)).toThrow();
    await f.cron.cancel(f.owner().sessionId, operation.scheduleId, () => undefined); expect(() => check(currentItem)).toThrow();
  });
});
