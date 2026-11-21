import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QqAdapterEvents, QqInboundMessage, QqSendResult } from './qq-official-adapter';
import { qqOutboxItemSchema, QQ_GROUP_DAILY_LIMIT, QQ_MAX_QUEUED_MESSAGES } from '../../../shared/qq-channel';
import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import { QqChannelService } from './qq-channel-service';
import type { QqHostSurface, QqResolvedReplyImage, QqSendControls, QqTransport } from './qq-channel-service';
import { QqChannelStore } from './qq-channel-store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
};
class FakeAdapter implements QqTransport {
  lastError: string | null = null;
  starts = 0;
  stops = 0;
  events: QqAdapterEvents | null = null;
  sends: Array<{ openId: string; content: string; replyTo?: string }> = [];
  nextResult: QqSendResult = { ok: true, unknown: false };
  beforeSend: (() => Promise<void>) | null = null;
  async start(_credentials: { appId: string; secret: string }, events: QqAdapterEvents): Promise<void> {
    this.starts += 1; this.events = events; events.onConnectionChange('online');
  }
  stop(): void { this.stops += 1; }
  async sendToUser(openId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    await this.beforeSend?.(); controls?.signal.throwIfAborted(); controls?.assertCurrent();
    this.sends.push({ openId, content, ...(replyTo === undefined ? {} : { replyTo }) });
    return this.nextResult;
  }
  groupSends: Array<{ groupId: string; content: string; replyTo?: string }> = [];
  imageSends: Array<{ target: string; group: boolean; image: QqResolvedReplyImage }> = [];
  imageResult: QqSendResult = { ok: true, unknown: false };
  async sendImageToUser(target: string, image: QqResolvedReplyImage, _replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    controls?.signal.throwIfAborted(); controls?.assertCurrent(); this.imageSends.push({ target, group: false, image }); return this.imageResult;
  }
  async sendImageToGroup(target: string, image: QqResolvedReplyImage, _replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    controls?.signal.throwIfAborted(); controls?.assertCurrent(); this.imageSends.push({ target, group: true, image }); return this.imageResult;
  }
  async sendToGroup(groupId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    controls?.assertCurrent();
    this.groupSends.push({ groupId, content, ...(replyTo === undefined ? {} : { replyTo }) });
    return this.nextResult;
  }
}
const message = (id: string, senderOpenId: string, content: string): QqInboundMessage => ({ id, senderOpenId, content, timestamp: null });
const groupMessage = (id: string, senderOpenId: string, content: string, groupId = 'group-1'): QqInboundMessage => ({ ...message(id, senderOpenId, content), group: { groupId } });
const fixture = async (options: { host?: Partial<QqHostSurface>; now?: () => Date } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-qq-service-')); roots.push(root);
  const path = join(root, 'qq-channel-state.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 72) };
  const store = new QqChannelStore(path, vault);
  const adapter = new FakeAdapter();
  const runs = vi.fn<QqHostSurface['runMessage']>(async input => ({ ok: true, reply: `echo:${input.text}`, runId: randomUUID(), assistantMessageId: randomUUID() }));
  const stopped = vi.fn(async () => undefined);
  const host: QqHostSurface = { createBindingSession: async () => ({ sessionId: randomUUID() }), runMessage: runs,
    onStopped: stopped, assertDelivery: () => undefined, ...options.host };
  let profileId = randomUUID();
  const deps = { store, adapter, getSecret: async () => 'secret-value', host, profileId: () => profileId,
    now: options.now ?? (() => new Date('2026-11-02T12:00:00.000Z')) };
  const service = new QqChannelService(deps);
  await service.initialize();
  await service.configure({ enabled: true, appId: 'app-1' });
  stopped.mockClear();
  const pair = async (sender = 'owner-1'): Promise<void> => {
    const pairing = await service.startPairing();
    await service.handleInbound(message(randomUUID(), sender, `/pair ${pairing.code}`));
    await service.confirmPairing(store.snapshot().pairingCandidate!.id);
  };
  return { root, path, vault, store, adapter, service, deps, runs, stopped, pair, changeProfile: () => { profileId = randomUUID(); } };
};

describe('durable private QQ message queue', () => {
  const releases: Array<() => void> = [], services: QqChannelService[] = [], operations: Promise<void>[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(operations.splice(0));
    vi.restoreAllMocks();
  });
  const heldFixture = async (dailyRequestLimit = 50) => {
    const started = deferred(), finish = deferred(); releases.push(() => finish.resolve());
    const runMessage = vi.fn<QqHostSurface['runMessage']>(async input => {
      if (input.text === 'first' || input.text.endsWith('] first')) { started.resolve(); await finish.promise; }
      return { ok: true, reply: `echo:${input.text}`, runId: randomUUID(), assistantMessageId: randomUUID() };
    });
    const f = await fixture({ host: { runMessage } }); services.push(f.service);
    await f.service.configure({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001', dailyRequestLimit });
    await f.pair();
    const start = (inbound = message('first-id', 'owner-1', 'first')): Promise<void> => {
      const running = f.service.handleInbound(inbound); operations.push(running); return running;
    };
    return { ...f, runMessage, started, finish, start };
  };

  it('persists busy messages and receipts together, deduplicates redelivery, then executes FIFO with original reply targets', async () => {
    const f = await heldFixture(), running = f.start(); await f.started.promise;
    const second = message('second-id', 'owner-1', 'second');
    await Promise.all([f.service.handleInbound(second), f.service.handleInbound(second)]);
    await f.service.handleInbound(message('third-id', 'owner-1', 'third'));
    expect(f.runMessage.mock.calls.map(([input]) => input.text)).toEqual(['first']);
    const disk = new QqChannelStore(f.path, f.vault); await disk.initialize();
    expect(disk.snapshot().inboundQueue.map(item => [item.messageId, item.status])).toEqual([
      ['first-id', 'running'], ['second-id', 'queued'], ['third-id', 'queued'],
    ]);
    expect(f.adapter.sends.filter(item => item.replyTo === 'second-id')).toHaveLength(1);
    expect(f.adapter.sends.at(-1)?.content).toContain('作为新任务');
    expect(await readFile(f.path, 'utf8')).not.toContain('second');
    f.finish.resolve(); await running;
    expect(f.runMessage.mock.calls.map(([input]) => input.text)).toEqual(['first', 'second', 'third']);
    expect(f.store.snapshot().inboundQueue.every(item => item.status === 'completed' && item.content === '')).toBe(true);
    expect(f.adapter.sends.filter(item => item.content.startsWith('echo:'))).toEqual([
      { openId: 'owner-1', content: 'echo:first', replyTo: 'first-id' },
      { openId: 'owner-1', content: 'echo:second', replyTo: 'second-id' },
      { openId: 'owner-1', content: 'echo:third', replyTo: 'third-id' },
    ]);
    expect(f.store.snapshot().dailyUsage.requests).toBe(3);
  });

  it('bounds the queue, acknowledges rejection, and cancels only undispatched work without consuming its reserved daily slots', async () => {
    const f = await heldFixture(), running = f.start(); await f.started.promise;
    for (let n = 0; n < QQ_MAX_QUEUED_MESSAGES; n += 1) await f.service.handleInbound(message(`waiting-${n}`, 'owner-1', `waiting ${n}`));
    await f.service.handleInbound(message('overflow', 'owner-1', 'overflow'));
    expect(f.adapter.sends.at(-1)?.content).toContain('队列已满');
    expect(f.store.snapshot().dailyUsage.requests).toBe(1 + QQ_MAX_QUEUED_MESSAGES);
    await f.service.handleInbound(message('cancel-intruder', 'stranger', '/cancel-queue'));
    expect(f.store.snapshot().inboundQueue.filter(item => item.status === 'queued')).toHaveLength(QQ_MAX_QUEUED_MESSAGES);
    await f.service.handleInbound(message('queue-status', 'owner-1', '/queue'));
    expect(f.adapter.sends.at(-1)?.content).toContain(`等待 ${QQ_MAX_QUEUED_MESSAGES} 条`);
    await f.service.handleInbound(message('cancel-own', 'owner-1', '/cancel-queue'));
    expect(f.store.snapshot().inboundQueue.filter(item => item.status === 'cancelled')).toHaveLength(QQ_MAX_QUEUED_MESSAGES);
    expect(f.store.snapshot().dailyUsage.requests).toBe(1);
    expect(f.store.snapshot().inboundQueue[0]?.status).toBe('running');
    f.finish.resolve(); await running;
    expect(f.runMessage).toHaveBeenCalledOnce();
  });

  it('reserves daily limits at admission and reports a rejected message instead of silently accepting it', async () => {
    const f = await heldFixture(2), running = f.start(); await f.started.promise;
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    await f.service.handleInbound(message('over-budget', 'owner-1', 'over budget'));
    expect(f.adapter.sends.at(-1)?.content).toContain('没有加入队列');
    expect(f.store.snapshot().inboundQueue).toHaveLength(2);
    await f.service.handleInbound(message('over-budget', 'owner-1', 'over budget'));
    expect(f.store.snapshot().dailyUsage.requests).toBe(2);
    f.finish.resolve(); await running;
    expect(f.runMessage.mock.calls.map(([input]) => input.text)).toEqual(['first', 'second']);
  });

  it('keeps the existing /stop authority revocation, pauses waiting work, and requires explicit owner renewal after desktop enable', async () => {
    const f = await heldFixture(), running = f.start(); await f.started.promise;
    const oldAuthority = f.service.authority();
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    await f.service.handleInbound(message('stop', 'owner-1', '/stop'));
    expect(() => f.service.assertAuthorized(oldAuthority)).toThrow('qq.authorityRevoked');
    expect(f.store.snapshot().inboundQueue.map(item => item.status)).toEqual(['interrupted', 'paused']);
    const sentAtStop = f.adapter.sends.length;
    f.finish.resolve(); await running;
    expect(f.adapter.sends).toHaveLength(sentAtStop);
    await f.service.configure({ enabled: true });
    await f.service.handleInbound(message('resume-intruder', 'stranger', '/resume-queue'));
    await f.service.handleInbound(message('status-after-stop', 'owner-1', '/queue'));
    expect(f.adapter.sends.at(-1)?.content).toContain('暂停 1 条');
    expect(f.runMessage).toHaveBeenCalledOnce();
    await f.service.handleInbound(message('resume-owner', 'owner-1', '/resume-queue'));
    expect(f.runMessage).toHaveBeenCalledTimes(2);
    expect(f.runMessage.mock.calls[1]?.[0]).toMatchObject({ text: 'second', ...f.service.authority() });
    expect(f.runMessage.mock.calls[1]?.[0].authorityId).not.toBe(oldAuthority.authorityId);
    expect(f.store.snapshot().dailyUsage.requests).toBe(2);
  });

  it.each(['model', 'unbind', 'credentials'] as const)('revokes queued work on %s changes and cannot resume it under the later authority', async change => {
    const f = await heldFixture(), running = f.start(); await f.started.promise;
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    if (change === 'model') await f.service.configure({ model: 'another-model' });
    else if (change === 'unbind') await f.service.unbind();
    else await f.service.credentialsChanged(async () => undefined);
    expect(f.store.snapshot().inboundQueue.find(item => item.messageId === 'second')?.status).toBe('cancelled');
    f.finish.resolve(); await running;
    await f.service.configure({ enabled: true });
    if (change === 'unbind') await f.pair('new-owner');
    await f.service.handleInbound(message('resume-new', change === 'unbind' ? 'new-owner' : 'owner-1', '/resume-queue'));
    expect(f.runMessage).toHaveBeenCalledOnce();
  });

  it('recovers undispatched messages after restart without replaying the interrupted host call or later duplicate events', async () => {
    const f = await heldFixture(), running = f.start(); await f.started.promise;
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    await f.service.handleInbound(message('third', 'owner-1', 'third'));
    f.service.dispose(); f.finish.resolve(); await running;
    const store = new QqChannelStore(f.path, f.vault), adapter = new FakeAdapter();
    const restarted = new QqChannelService({ ...f.deps, store, adapter }); services.push(restarted);
    await restarted.initialize();
    await vi.waitFor(() => expect(store.snapshot().inboundQueue.map(item => item.status)).toEqual(['interrupted', 'completed', 'completed']));
    expect(f.runMessage.mock.calls.map(([input]) => input.text)).toEqual(['first', 'second', 'third']);
    expect(adapter.sends.some(item => item.content.includes('上次任务在执行时中断'))).toBe(true);
    await restarted.handleInbound(message('second', 'owner-1', 'second'));
    await restarted.handleInbound(message('first-id', 'owner-1', 'first'));
    expect(f.runMessage).toHaveBeenCalledTimes(3);
  });

  it('accepts a private message while a group is busy and drains it when that group finishes without exposing the owner queue', async () => {
    const f = await heldFixture();
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage('pair-queue-group', 'group-owner', `/pair ${pairing.code}`));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    const running = f.start(groupMessage('group-first', 'group-owner', 'first')); await f.started.promise;
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    await f.service.handleInbound(groupMessage('group-queue', 'group-owner', '/queue'));
    expect(f.adapter.groupSends.at(-1)?.content).toContain('只接受已配对主人的私聊');
    expect(f.runMessage).toHaveBeenCalledOnce();
    f.finish.resolve(); await running;
    expect(f.runMessage.mock.calls[1]?.[0]).toMatchObject({ text: 'second', senderId: 'owner-1' });
  });

  it('reads back an accepted-but-unacknowledged encrypted admission before handling a repeated event', async () => {
    const f = await heldFixture();
    const save = EncryptedJsonStore.prototype.save;
    vi.spyOn(EncryptedJsonStore.prototype, 'save').mockImplementationOnce(async function(this: EncryptedJsonStore<unknown>, value: unknown) {
      await save.call(this, value);
      throw new Error('synthetic lost acknowledgement after rename');
    });
    const inbound = message('uncertain-admission', 'owner-1', 'second');
    await f.service.handleInbound(inbound);
    expect(f.runMessage).not.toHaveBeenCalled();
    await f.service.handleInbound(inbound);
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.store.snapshot().dailyUsage.requests).toBe(1);
    expect(f.store.snapshot().inboundQueue).toHaveLength(1);
    expect(f.store.snapshot().inboundQueue[0]?.status).toBe('completed');
  });

  it('commits completion with its reply so a lost persistence acknowledgement neither reruns the host nor duplicates delivery', async () => {
    const f = await heldFixture();
    const save = EncryptedJsonStore.prototype.save; let injected = false;
    vi.spyOn(EncryptedJsonStore.prototype, 'save').mockImplementation(async function(this: EncryptedJsonStore<unknown>, value: unknown) {
      await save.call(this, value);
      if (!injected && typeof value === 'object' && value && 'inboundQueue' in value
        && Array.isArray(value.inboundQueue) && value.inboundQueue.some((item: { status?: unknown }) => item.status === 'completed')) {
        injected = true; throw new Error('synthetic lost completion acknowledgement');
      }
    });
    await f.service.handleInbound(message('completion', 'owner-1', 'second'));
    expect(injected).toBe(true);
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends).toEqual([{ openId: 'owner-1', content: 'echo:second', replyTo: 'completion' }]);
    expect(f.store.snapshot().inboundQueue[0]?.status).toBe('completed');
    await f.service.handleInbound(message('completion', 'owner-1', 'second'));
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends).toHaveLength(1);
  });

  it('does not dispatch or replay a task whose persisted dispatch intent lost its acknowledgement', async () => {
    const f = await heldFixture();
    const save = EncryptedJsonStore.prototype.save; let injected = false;
    vi.spyOn(EncryptedJsonStore.prototype, 'save').mockImplementation(async function(this: EncryptedJsonStore<unknown>, value: unknown) {
      await save.call(this, value);
      if (!injected && typeof value === 'object' && value && 'inboundQueue' in value
        && Array.isArray(value.inboundQueue) && value.inboundQueue.some((item: { status?: unknown }) => item.status === 'running')) {
        injected = true; throw new Error('synthetic lost dispatch acknowledgement');
      }
    });
    const inbound = message('dispatch-unknown', 'owner-1', 'second');
    await f.service.handleInbound(inbound);
    expect(injected).toBe(true);
    expect(f.store.snapshot().inboundQueue[0]?.status).toBe('interrupted');
    expect(f.adapter.sends.at(-1)?.content).toContain('未自动重试');
    await f.service.handleInbound(inbound);
    expect(f.runMessage).not.toHaveBeenCalled();
  });

  it('rechecks the new day budget before dispatch and leaves excess carried-over work paused until explicit recovery', async () => {
    let now = new Date('2026-11-02T23:59:00.000Z');
    const started = deferred(), finish = deferred(); releases.push(() => finish.resolve());
    const runMessage = vi.fn<QqHostSurface['runMessage']>(async input => {
      if (input.text === 'first') { started.resolve(); await finish.promise; }
      return { ok: true, reply: input.text, runId: randomUUID(), assistantMessageId: randomUUID() };
    });
    const f = await fixture({ now: () => now, host: { runMessage } }); services.push(f.service);
    await f.service.configure({ dailyRequestLimit: 2 }); await f.pair();
    const running = f.service.handleInbound(message('first-day', 'owner-1', 'first')); operations.push(running); await started.promise;
    await f.service.handleInbound(message('carry-over', 'owner-1', 'second'));
    now = new Date('2026-11-03T00:01:00.000Z');
    await f.service.reserveScheduledRequest(f.service.authority(), randomUUID());
    await f.service.reserveScheduledRequest(f.service.authority(), randomUUID());
    finish.resolve(); await running;
    expect(runMessage).toHaveBeenCalledOnce();
    expect(f.store.snapshot().inboundQueue.find(item => item.messageId === 'carry-over')?.status).toBe('paused');
    expect(f.adapter.sends.at(-1)?.content).toContain('已暂停');
    now = new Date('2026-11-04T00:01:00.000Z');
    await f.service.handleInbound(message('resume-new-day', 'owner-1', '/resume-queue'));
    expect(runMessage).toHaveBeenCalledTimes(2);
    expect(f.store.snapshot().dailyUsage).toEqual({ date: '2026-11-04', requests: 1 });
  });
});

describe('managed image replies', () => {
  const assetId = '7'.repeat(64), image: QqResolvedReplyImage = { base64: 'SYNTHETIC_MEMORY_ONLY', mime: 'image/png', sha256: assetId };
  const mediaFixture = async (resolveReplyImage: NonNullable<QqHostSurface['resolveReplyImage']> = vi.fn(async () => image),
    transport: 'onebot' | 'official' = 'onebot') => {
    const assertDelivery = vi.fn(), runMessage = vi.fn<QqHostSurface['runMessage']>(async () => ({ ok: true, reply: '已收到。', runId: randomUUID(), assistantMessageId: randomUUID(), attachments: [{ assetId, alt: '挥手的小猫' }] }));
    const f = await fixture({ host: { runMessage, resolveReplyImage, assertDelivery } });
    if (transport === 'onebot') await f.service.configure({ transport, onebotUrl: 'ws://127.0.0.1:3001' });
    await f.pair();
    return { ...f, assertDelivery, resolveReplyImage };
  };
  it.each(['onebot', 'official'] as const)('persists only an asset reference and confirms the text before the %s image dispatch', async transport => {
    const f = await mediaFixture(undefined, transport);
    const sendText = vi.spyOn(f.adapter, 'sendToUser');
    const sendImage = f.adapter.sendImageToUser.bind(f.adapter);
    vi.spyOn(f.adapter, 'sendImageToUser').mockImplementation(async (...args) => {
      expect(f.store.snapshot().outbox.find(row => row.replyTo === 'picture-turn' && !row.attachment)?.status).toBe('sent');
      return sendImage(...args);
    });
    await f.service.handleInbound(message('picture-turn', 'owner-1', '你好'));
    const rows = f.store.snapshot().outbox.filter(row => row.replyTo === 'picture-turn');
    expect(rows).toHaveLength(2); expect(rows.map(row => row.status)).toEqual(['sent', 'sent']);
    expect(rows[1]).toMatchObject({ attachment: { assetId, alt: '挥手的小猫' }, afterMessageId: rows[0]!.id,
      sourceSHA256: createHash('sha256').update('已收到。').digest('hex') });
    expect(JSON.stringify(f.store.snapshot())).not.toContain(image.base64);
    expect(f.adapter.sends.at(-1)?.content).toBe('已收到。');
    expect(sendText.mock.calls.find(([, , replyTo]) => replyTo === 'picture-turn')?.[3]?.reserveImageReply)
      .toBe(transport === 'official' ? true : undefined);
    expect(f.adapter.imageSends).toEqual([{ target: 'owner-1', group: false, image }]);
    expect(f.resolveReplyImage).toHaveBeenCalledExactlyOnceWith(assetId, f.service.authority());
    expect(f.assertDelivery.mock.calls.filter(([row]) => row.attachment).length).toBeGreaterThanOrEqual(3);
    const restored = new QqChannelStore(f.path, f.vault); await restored.initialize();
    expect(restored.snapshot().outbox.filter(row => row.attachment)).toEqual([rows[1]]);
  });
  it('does not send an image after an unknown text delivery, or blindly retry that image', async () => {
    const f = await mediaFixture(); f.adapter.nextResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    await f.service.handleInbound(message('lost-text', 'owner-1', '你好'));
    const rows = f.store.snapshot().outbox.filter(row => row.replyTo === 'lost-text');
    expect(rows.map(row => row.status)).toEqual(['unknown', 'discarded']); expect(f.adapter.imageSends).toEqual([]);
    f.adapter.nextResult = { ok: true, unknown: false }; await f.service.retryUnknownDeliveries();
    expect(f.adapter.imageSends).toEqual([]); expect(f.resolveReplyImage).not.toHaveBeenCalled();
  });
  it.each(['onebot', 'official'] as const)('delivers a private cron image only after the projected %s text, bound to the full cited source', async transport => {
    const f = await mediaFixture(undefined, transport);
    const content = '[sticker:with-text:greeting]\n早安，13~19°C。\n来源：合成天气网 https://weather.example.invalid/today';
    const reply = { content, runId: randomUUID(), assistantMessageId: randomUUID(), scheduleId: randomUUID(), scheduleRevision: 3,
      attachments: [{ assetId, alt: '挥手的小猫' }] };
    const sendImage = f.adapter.sendImageToUser.bind(f.adapter);
    vi.spyOn(f.adapter, 'sendImageToUser').mockImplementation(async (...args) => {
      expect(f.store.snapshot().outbox.find(row => row.kind === 'cron' && !row.attachment)?.status).toBe('sent');
      return sendImage(...args);
    });
    await f.service.deliverReply(f.service.authority(), reply);
    const rows = f.store.snapshot().outbox.filter(row => row.kind === 'cron');
    expect(rows.map(row => row.status)).toEqual(['sent', 'sent']);
    expect(rows.map(row => row.sourceSHA256)).toEqual(Array(2).fill(createHash('sha256').update(content).digest('hex')));
    expect(rows[1]).toMatchObject({ scheduleId: reply.scheduleId, scheduleRevision: 3, afterMessageId: rows[0]!.id });
    expect(f.adapter.sends.at(-1)?.content).toBe('早安，13~19°C。\n（合成天气网说的）');
    expect(f.adapter.imageSends).toEqual([{ target: 'owner-1', group: false, image }]);
    f.service.dispose();
  });
  it('does not let an uncertain cron text dispatch its image, and still advances the next scheduled reply', async () => {
    const f = await mediaFixture(); f.adapter.nextResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    const reply = { content: '[sticker:with-text:greeting]\n早安。', runId: randomUUID(), assistantMessageId: randomUUID(),
      scheduleId: randomUUID(), scheduleRevision: 1, attachments: [{ assetId, alt: '挥手的小猫' }] };
    await f.service.deliverReply(f.service.authority(), reply);
    expect(f.store.snapshot().outbox.map(row => row.status)).toEqual(['unknown', 'discarded']);
    expect(f.adapter.imageSends).toEqual([]);
    f.adapter.nextResult = { ok: true, unknown: false };
    await f.service.deliverReply(f.service.authority(), { ...reply, content: '下一条定时回复。', runId: randomUUID(), attachments: [] });
    expect(f.adapter.sends.at(-1)?.content).toBe('下一条定时回复。');
    expect(f.store.snapshot().outbox.at(-1)?.status).toBe('sent'); f.service.dispose();
  });
  it('routes a paired group image to that group and resolves it under the group authority', async () => {
    const f = await mediaFixture();
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage('pair-media-group', 'group-owner', `/pair ${pairing.code}`, 'media-group'));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    await f.service.handleInbound(groupMessage('group-picture-turn', 'group-owner', '庆祝一下', 'media-group'));
    expect(f.adapter.imageSends).toEqual([{ target: 'media-group', group: true, image }]);
    const row = f.store.snapshot().outbox.find(value => value.replyTo === 'group-picture-turn' && value.attachment)!;
    expect(row.status).toBe('sent');
    expect(f.resolveReplyImage).toHaveBeenCalledExactlyOnceWith(assetId, row.authority);
    expect(row.authority.senderId).toBe('group:media-group');
  });
  it('retries only a definitively failed image without duplicating its already delivered text', async () => {
    const f = await mediaFixture(); f.adapter.imageResult = { ok: false, unknown: false, error: 'qq.sendRetcode_1200' };
    await f.service.handleInbound(message('retry-image', 'owner-1', '你好'));
    const textSends = f.adapter.sends.length;
    expect(f.store.snapshot().outbox.find(row => row.attachment)?.status).toBe('failed');
    f.adapter.imageResult = { ok: true, unknown: false }; await f.service.retryUnknownDeliveries();
    expect(f.adapter.sends).toHaveLength(textSends); expect(f.adapter.imageSends).toHaveLength(2);
    expect(f.store.snapshot().outbox.find(row => row.attachment)?.status).toBe('sent');
  });
  it('never retries an image with an unknown transport receipt', async () => {
    const f = await mediaFixture(); f.adapter.imageResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    await f.service.handleInbound(message('lost-image', 'owner-1', '你好')); await f.service.retryUnknownDeliveries();
    expect(f.adapter.imageSends).toHaveLength(1);
    expect(f.store.snapshot().outbox.find(row => row.attachment)?.status).toBe('unknown');
  });
  it('rechecks revocation after waiting for managed image bytes and never calls transport with a stale binding', async () => {
    const entered = deferred(), proceed = deferred<QqResolvedReplyImage>();
    const resolveReplyImage = vi.fn(async () => { entered.resolve(); return proceed.promise; });
    const f = await mediaFixture(resolveReplyImage);
    const handling = f.service.handleInbound(message('revoke-image', 'owner-1', '你好'));
    await entered.promise; await f.service.emergencyStop(); proceed.resolve(image); await handling;
    expect(f.adapter.imageSends).toEqual([]);
  });
  it('blocks the official image if its confirmed text prerequisite disappears during image resolution', async () => {
    const entered = deferred(), proceed = deferred<QqResolvedReplyImage>();
    const f = await mediaFixture(async () => { entered.resolve(); return proceed.promise; }, 'official');
    const handling = f.service.handleInbound(message('expired-text-reference', 'owner-1', '你好'));
    await entered.promise;
    await f.store.update(state => {
      state.outbox = state.outbox.filter(row => row.replyTo !== 'expired-text-reference' || row.attachment);
    });
    proceed.resolve(image); await handling;
    expect(f.adapter.imageSends).toEqual([]);
    expect(f.adapter.sends.filter(row => row.replyTo === 'expired-text-reference')).toHaveLength(1);
  });
  it('keeps sending text if the transport does not expose an image send function', async () => {
    const resolveReplyImage = vi.fn(async () => image);
    const f = await fixture({ host: { resolveReplyImage, runMessage: async () => ({ ok: true, reply: '文字仍发送。', runId: randomUUID(), assistantMessageId: randomUUID(), attachments: [{ assetId, alt: '小猫' }] }) } });
    Object.defineProperty(f.adapter, 'sendImageToUser', { value: undefined });
    await f.pair();
    await f.service.handleInbound(message('official-reply', 'owner-1', '你好'));
    expect(f.adapter.sends.at(-1)?.content).toBe('文字仍发送。'); expect(f.adapter.imageSends).toEqual([]);
    expect(f.store.snapshot().outbox.some(row => row.attachment)).toBe(false);
    expect(resolveReplyImage).not.toHaveBeenCalled();
  });
});

describe('standalone official private image replies', () => {
  const assetId = '8'.repeat(64);
  const attachment = { assetId, alt: '午间招手' };
  const image: QqResolvedReplyImage = { base64: 'SYNTHETIC_MEMORY_ONLY', mime: 'image/png', sha256: assetId };
  const makeReply = () => ({ ok: true as const, reply: '', runId: randomUUID(), assistantMessageId: randomUUID(),
    attachments: [attachment], stickerOnly: true as const });

  it('persists and sends one image against the original private inbound with no text prerequisite', async () => {
    const reply = makeReply(), resolveReplyImage = vi.fn(async () => image), assertDelivery = vi.fn();
    const f = await fixture({ host: { runMessage: async () => reply, resolveReplyImage, assertDelivery } });
    await f.pair();
    const beforeText = f.adapter.sends.length;
    const send = vi.spyOn(f.adapter, 'sendImageToUser');
    await f.service.handleInbound(message('standalone-private', 'owner-1', '中午好呀'));
    const rows = f.store.snapshot().outbox.filter(row => row.replyTo === 'standalone-private');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ kind: 'reply', status: 'sent', authority: f.service.authority(), attachment,
      standaloneImage: true, runId: reply.runId, assistantMessageId: reply.assistantMessageId,
      sourceSHA256: createHash('sha256').update('').digest('hex') });
    expect(row).not.toHaveProperty('afterMessageId');
    expect(f.adapter.sends).toHaveLength(beforeText);
    expect(send).toHaveBeenCalledExactlyOnceWith('owner-1', image, 'standalone-private', expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect(resolveReplyImage).toHaveBeenCalledExactlyOnceWith(assetId, f.service.authority());
    expect(assertDelivery.mock.calls.every(([item]) => item.standaloneImage === true)).toBe(true);
    const restored = new QqChannelStore(f.path, f.vault); await restored.initialize();
    expect(restored.snapshot().outbox.find(item => item.id === row.id)).toEqual(row);
    expect(JSON.stringify(restored.snapshot())).not.toContain(image.base64);
    expect(qqOutboxItemSchema.safeParse({ ...row, afterMessageId: randomUUID() }).success).toBe(false);
    expect(qqOutboxItemSchema.safeParse({ ...row, sourceSHA256: '0'.repeat(64) }).success).toBe(false);
    expect(qqOutboxItemSchema.safeParse({ ...row, replyTo: null }).success).toBe(false);
    expect(qqOutboxItemSchema.safeParse({ ...row, authority: { ...row.authority, senderId: 'group:outside' } }).success).toBe(false);
  });

  it.each(['missing-image', 'multiple-images', 'nonempty-reply', 'unsupported-send', 'onebot', 'group'] as const)(
    'blocks an invalid standalone branch (%s) before resolving bytes or queuing a send', async scenario => {
      const reply = makeReply(), resolveReplyImage = vi.fn(async () => image);
      if (scenario === 'missing-image') reply.attachments = [];
      if (scenario === 'multiple-images') reply.attachments.push(attachment);
      if (scenario === 'nonempty-reply') reply.reply = '不应发送的正文';
      const f = await fixture({ host: { runMessage: async () => reply, resolveReplyImage } });
      if (scenario === 'unsupported-send') Object.defineProperty(f.adapter, 'sendImageToUser', { value: undefined });
      if (scenario === 'onebot') await f.service.configure({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001' });
      await f.pair();
      let inbound = message('invalid-standalone', 'owner-1', '中午好呀');
      if (scenario === 'group') {
        const pairing = await f.service.startGroupPairing();
        await f.service.handleInbound(groupMessage('pair-sticker-group', 'group-owner', `/pair ${pairing.code}`, 'sticker-group'));
        await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
        inbound = groupMessage('invalid-standalone', 'group-owner', '中午好呀', 'sticker-group');
      }
      const beforeText = f.adapter.sends.length + f.adapter.groupSends.length;
      await f.service.handleInbound(inbound);
      expect(f.store.snapshot().outbox.some(row => row.replyTo === inbound.id)).toBe(false);
      expect(f.adapter.sends.length + f.adapter.groupSends.length).toBe(beforeText);
      expect(f.adapter.imageSends).toEqual([]);
      expect(resolveReplyImage).not.toHaveBeenCalled();
    },
  );

  it('preserves an uncertain standalone send without falling back to text or retrying', async () => {
    const f = await fixture({ host: { runMessage: async () => makeReply(), resolveReplyImage: async () => image } });
    await f.pair();
    const beforeText = f.adapter.sends.length;
    f.adapter.imageResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    await f.service.handleInbound(message('uncertain-standalone', 'owner-1', '中午好呀'));
    f.adapter.imageResult = { ok: true, unknown: false };
    await f.service.retryUnknownDeliveries();
    expect(f.store.snapshot().outbox.filter(row => row.replyTo === 'uncertain-standalone')).toEqual([
      expect.objectContaining({ standaloneImage: true, status: 'unknown', attempts: 1 }),
    ]);
    expect(f.adapter.imageSends).toHaveLength(1);
    expect(f.adapter.sends).toHaveLength(beforeText);
  });

  it('rechecks the admitted inbound after waiting for standalone image bytes', async () => {
    const entered = deferred(), proceed = deferred<QqResolvedReplyImage>();
    const f = await fixture({ host: { runMessage: async () => makeReply(),
      resolveReplyImage: async () => { entered.resolve(); return proceed.promise; } } });
    await f.pair();
    const handling = f.service.handleInbound(message('expired-standalone', 'owner-1', '中午好呀'));
    await entered.promise;
    await f.store.update(state => { state.processedMessageIds = state.processedMessageIds.filter(id => id !== 'expired-standalone'); });
    proceed.resolve(image); await handling;
    expect(f.adapter.imageSends).toEqual([]);
    expect(f.store.snapshot().outbox.filter(row => row.replyTo === 'expired-standalone')).toEqual([
      expect.objectContaining({ standaloneImage: true, status: 'failed', attempts: 1 }),
    ]);
  });
});

describe('explicit private image test', () => {
  const image: QqResolvedReplyImage = { base64: 'SYNTHETIC_MEMORY_ONLY', mime: 'image/png', sha256: '7'.repeat(64) };

  it('requires the exact online official private binding before resolving any image', async () => {
    const f = await fixture();
    const resolve = vi.fn(async () => ({ image, title: '测试表情' }));
    await expect(f.service.sendPrivateImageTest('unbound', resolve)).resolves.toMatchObject({ result: { error: 'qq.authorityRevoked' } });
    await f.pair();
    const { bindingId } = f.service.authority();
    await expect(f.service.sendPrivateImageTest('other-binding', resolve)).resolves.toMatchObject({ result: { error: 'qq.authorityRevoked' } });
    f.adapter.events!.onConnectionChange('offline');
    await expect(f.service.sendPrivateImageTest(bindingId, resolve)).resolves.toMatchObject({ result: { error: 'qq.imageTestOffline' } });
    await f.service.configure({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001' });
    await expect(f.service.sendPrivateImageTest(bindingId, resolve)).resolves.toMatchObject({ result: { error: 'qq.imageTestOfficialOnly' } });
    expect(resolve).not.toHaveBeenCalled();
    expect(f.adapter.imageSends).toEqual([]);
  });

  it('admits one send without a model request or durable outbox write', async () => {
    const f = await fixture(); await f.pair();
    const authority = f.service.authority(), before = await readFile(f.path);
    const entered = deferred(), proceed = deferred();
    const resolve = vi.fn(async () => { entered.resolve(); await proceed.promise; return { image, title: '  测试表情  ' }; });
    const send = vi.spyOn(f.adapter, 'sendImageToUser');
    f.adapter.imageResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    const pending = f.service.sendPrivateImageTest(authority.bindingId, resolve);
    await entered.promise;
    await expect(f.service.sendPrivateImageTest(authority.bindingId, resolve)).resolves.toEqual({
      result: { ok: false, unknown: false, error: 'qq.imageTestBusy' }, title: '',
    });
    proceed.resolve();
    await expect(pending).resolves.toEqual({ result: f.adapter.imageResult, title: '测试表情' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(authority);
    expect(send).toHaveBeenCalledExactlyOnceWith('owner-1', image, undefined, expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect(f.runs).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(before);
  });

  it('never calls the transport when the binding changes during image resolution', async () => {
    const f = await fixture(); await f.pair();
    const entered = deferred(), proceed = deferred();
    const send = vi.spyOn(f.adapter, 'sendImageToUser');
    const pending = f.service.sendPrivateImageTest(f.service.authority().bindingId, async () => {
      entered.resolve(); await proceed.promise; return { image, title: '测试表情' };
    });
    await entered.promise;
    await f.service.configure({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001' });
    proceed.resolve();
    await expect(pending).resolves.toMatchObject({ result: { ok: false, unknown: false, error: 'qq.authorityRevoked' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('revokes the signal and delivery guard if the channel stops during the upload', async () => {
    const f = await fixture(); await f.pair();
    const entered = deferred<QqSendControls | undefined>(), proceed = deferred();
    const send = vi.spyOn(f.adapter, 'sendImageToUser').mockImplementation(async (_target, _image, _replyTo, controls) => {
      entered.resolve(controls); await proceed.promise;
      controls?.assertCurrent();
      return { ok: true, unknown: false };
    });
    const pending = f.service.sendPrivateImageTest(f.service.authority().bindingId, async () => ({ image, title: '测试表情' }));
    const controls = await entered.promise;
    await f.service.emergencyStop();
    expect(controls?.signal.aborted).toBe(true);
    expect(controls?.assertCurrent).toThrow('qq.authorityRevoked');
    proceed.resolve();
    await expect(pending).resolves.toMatchObject({ result: { ok: false, unknown: true, error: 'qq.sendUnknown' } });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('QQ model failure replies', () => {
  it.each([
    ['provider.network', '连接模型服务失败，请检查桌面电脑的网络或代理连接后再试。'],
    ['provider.authentication', '模型服务的身份验证未通过，请在桌面设置中检查 API 密钥和访问权限。'],
    ['private upstream detail https://private.example/SECRET', '这一轮没有完成，请在桌面查看错误详情后重试。'],
  ])('delivers only the fixed private-chat explanation for %s', async (code, content) => {
    const runMessage = vi.fn<QqHostSurface['runMessage']>(async () => ({ ok: false, code }));
    const f = await fixture({ host: { runMessage } }); await f.pair();
    await f.service.handleInbound(message('failed-turn', 'owner-1', 'synthetic request'));
    expect(runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends.at(-1)).toEqual({ openId: 'owner-1', content, replyTo: 'failed-turn' });
    expect(f.store.snapshot().outbox.at(-1)).toMatchObject({ kind: 'system', content, status: 'sent' });
  });

  it('uses the same safe timeout category for a paired group without leaking an internal code', async () => {
    const runMessage = vi.fn<QqHostSurface['runMessage']>(async () => ({ ok: false, code: 'provider.timeout' }));
    const f = await fixture({ host: { runMessage } });
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage('pair-failure-group', 'owner-in-group', `/pair ${pairing.code}`));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    await f.service.handleInbound(groupMessage('failed-group-turn', 'owner-in-group', 'synthetic request'));
    expect(runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.groupSends.at(-1)).toEqual({ groupId: 'group-1', replyTo: 'failed-group-turn',
      content: '等待模型服务响应超时，请稍后再试；如果持续超时，请检查桌面电脑的网络或代理连接。' });
  });
});

describe('owner commands from QQ', () => {
  it('lets the host answer /model and switch without a model run, a reconnect or a new pairing', async () => {
    const provider = randomUUID();
    const chatCommand = vi.fn<NonNullable<QqHostSurface['chatCommand']>>(async (command, target) => {
      if (command.argument) await target.select(provider, command.argument);
      return `${target.key}:${command.name}:${JSON.stringify(target.selection())}`;
    });
    const f = await fixture({ host: { chatCommand } });
    await f.pair();
    const binding = f.store.snapshot().binding;
    await f.service.handleInbound(message('show', 'owner-1', '/model'));
    await f.service.handleInbound(message('switch', 'owner-1', '/model gpt-6.1-sol'));
    await f.service.handleInbound(message('switch', 'owner-1', '/model gpt-6.1-sol'));
    expect(f.adapter.sends.map(item => item.content)).toEqual([
      'qq:model:{"providerId":null,"model":null}', `qq:model:{"providerId":"${provider}","model":"gpt-6.1-sol"}`]);
    expect(f.store.snapshot().config).toMatchObject({ providerId: provider, model: 'gpt-6.1-sol' });
    expect(f.store.snapshot().binding).toEqual(binding);
    expect(f.runs).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled(); expect(f.adapter.starts).toBe(1);
    await f.service.handleInbound(message('chat', 'owner-1', 'hello'));
    expect(f.runs).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', providerId: provider, model: 'gpt-6.1-sol' }));
  });

  it('answers 「体检」 from the doctor as a reply, and lets the doctor report to the owner unprompted', async () => {
    const checkup = vi.fn(async () => '【医生】体检结果');
    const f = await fixture({ host: { checkup } });
    expect(await f.service.notifyOwner('【医生】发现 1 个问题')).toBe(false);
    await f.pair();
    await f.service.handleInbound(message('ask', 'owner-1', ' 体检 '));
    await f.service.handleInbound(message('stranger', 'someone-else', '体检'));
    expect(await f.service.notifyOwner('【医生】发现 1 个问题')).toBe(true);
    f.adapter.nextResult = { ok: false, unknown: false, error: 'qq.proactiveRateLimit' };
    expect(await f.service.notifyOwner('【医生】已恢复：微信。')).toBe(false);
    expect(f.adapter.sends).toEqual([{ openId: 'owner-1', content: '【医生】体检结果', replyTo: 'ask' },
      { openId: 'owner-1', content: '【医生】发现 1 个问题' }, { openId: 'owner-1', content: '【医生】已恢复：微信。' }]);
    expect(checkup).toHaveBeenCalledTimes(1);
    expect(f.runs).not.toHaveBeenCalled();
  });

  it('ignores the command from a group and from anyone but the paired owner', async () => {
    const chatCommand = vi.fn(async () => 'switched');
    const f = await fixture({ host: { chatCommand } });
    await f.pair();
    await f.service.handleInbound(message('stranger', 'someone-else', '/model x'));
    await f.service.handleInbound(groupMessage('group', 'owner-1', '/model x'));
    expect(chatCommand).not.toHaveBeenCalled();
    expect(f.store.snapshot().config).toMatchObject({ providerId: null, model: null });
  });
});

describe('saving QQ settings', () => {
  it('keeps existing private grants and a queued reminder when the desktop saves identical fields', async () => {
    let time = Date.parse('2026-11-04T09:03:00Z');
    const policy = { timezone: 'UTC', revision: 1, permissionRevision: 1, quietStart: '22:00',
      quietEnd: '07:00', dailyLimit: 2, cooldownMinutes: 60, locale: 'en' as const };
    const f = await fixture({ now: () => new Date(time), host: { privateCarePolicy: () => policy } });
    await f.pair();
    const authority = f.service.authority();
    await f.service.setPrivateReminders(authority.bindingId, true);
    await f.service.setPrivateCare(authority.bindingId, true);
    await f.service.handleInbound(message('source', authority.senderId, '/remind 10s 喝水'));
    const starts = f.adapter.starts, stops = f.adapter.stops;
    await f.service.configure({ transport: 'official', appId: 'app-1', providerId: null, model: null, dailyRequestLimit: 50, webCallLimit: 10 });
    expect(f.service.authority()).toEqual(authority);
    expect(f.service.status()).toMatchObject({ privateRemindersEnabled: true, privateCareEnabled: true });
    expect(f.adapter.starts).toBe(starts); expect(f.adapter.stops).toBe(stops); expect(f.stopped).not.toHaveBeenCalled();
    time += 10_000;
    await f.service.tickReminders(); await f.service.offerPrivateCare();
    expect(f.adapter.sends.filter(item => item.replyTo === undefined).map(item => item.content))
      .toEqual(['喝口水吧。', 'Good morning. Is there anything you’d like to make time for today?']);
  });

  it('applies a rapid disable behind an uncommitted enable, and distinguishes resuming an emergency stop from a no-op', async () => {
    const f = await fixture(); await f.pair();
    await f.service.configure({enabled:false});
    const starts = f.adapter.starts;
    const enable = f.service.configure({enabled:true});
    const disable = f.service.configure({enabled:false});
    await Promise.all([enable,disable]);
    expect(f.service.status()).toMatchObject({enabled:false,connection:'disabled'});
    expect(f.adapter.starts).toBe(starts);
    await f.service.configure({enabled:true}); await f.service.emergencyStop();
    expect(f.service.status()).toMatchObject({enabled:true,stopped:true});
    await f.service.configure({ model:null }); // An ordinary save cannot resume a stop.
    expect(f.service.status().stopped).toBe(true);
    await f.service.configure({enabled:true});
    expect(f.service.status()).toMatchObject({enabled:true,stopped:false,connection:'online'});
  });
});

describe('owner-authored one-time QQ reminders', () => {
  it('keeps the receipt conversational and asks which reminder to cancel when names match', async () => {
    const f = await fixture({now: () => new Date(2026, 10, 4, 23, 53)});
    await f.pair();
    await f.service.setPrivateReminders(f.service.authority().bindingId, true);
    const say = async (text: string) => {
      await f.service.handleInbound(message(randomUUID(), 'owner-1', text));
      return f.adapter.sends.at(-1)?.content;
    };
    expect(await say('十分钟后提醒我喝水')).toBe('好，十分钟后我提醒你喝水。');
    expect(await say('明早八点半提醒我喝水')).toBe('好，明天早上八点半我提醒你喝水。');
    const [first, second] = f.store.snapshot().outbox.filter(item => item.reminderDueAt);
    const choice = await say('取消喝水提醒');
    expect(choice).toContain('明天 00:03　/cancel-reminder ' + first!.id.slice(0, 8));
    expect(choice).toContain('明天 08:30　/cancel-reminder ' + second!.id.slice(0, 8));
    expect(f.store.snapshot().outbox.filter(item => item.reminderDueAt).map(item => item.status)).toEqual(['pending', 'pending']);
    expect(await say('取消刚才那条')).toBe('好，「喝水」这条就不提醒了。');
    // Repeating a cancellation must never step back through older reminders.
    expect(await say('取消刚才那条提醒')).toBe('那条已经不在待发提醒里了。');
    expect(f.store.snapshot().outbox.find(item => item.id === first!.id)?.status).toBe('pending');
    expect(await say('取消喝水的提醒')).toBe('好，「喝水」这条就不提醒了。');
    expect(f.runs).not.toHaveBeenCalled();
  });

  it('keeps an uncertain send visible instead of claiming it was cancelled', async () => {
    let now = new Date(2026, 10, 5, 8, 0).getTime();
    const f = await fixture({now: () => new Date(now)});
    await f.pair();
    await f.service.setPrivateReminders(f.service.authority().bindingId, true);
    await f.service.handleInbound(message('source', 'owner-1', '/remind 1s 带上发票'));
    f.adapter.nextResult = {ok:false, unknown:true, error:'qq.sendUnknown'};
    now += 2000;
    await f.service.tickReminders();
    f.adapter.nextResult = {ok:true, unknown:false};
    await f.service.handleInbound(message('cancel', 'owner-1', '取消刚才那条'));
    expect(f.adapter.sends.at(-1)?.content).toBe('那条已经交给 QQ 了，可能已经发出。');
    expect(f.store.snapshot().outbox.find(item => item.reminderDueAt)?.status).toBe('unknown');
  });

  it('restates the actual deadline for a delayed receipt and identifies a late reminder', async () => {
    let now = new Date(2026, 10, 4, 23, 58).getTime();
    const f = await fixture({now: () => new Date(now)});
    await f.pair();
    await f.service.setPrivateReminders(f.service.authority().bindingId, true);
    f.adapter.events!.onConnectionChange('offline');
    await f.service.handleInbound(message('source', 'owner-1', '十分钟后提醒我喝水'));
    expect(f.adapter.sends).toEqual([]);
    now += 15 * 60_000;
    f.adapter.events!.onConnectionChange('online');
    await f.service.tickReminders();
    expect(f.adapter.sends.map(item => item.content)).toEqual([
      '你设的「喝水」提醒，时间是今天 00:08。',
      '这条提醒来晚了，你原本让我今天凌晨零点零八分提醒你喝水。',
    ]);
  });

  it('delivers only once when QQ replays a reminder after its source ID leaves the inbox ring', async () => {
    let now = new Date('2026-11-05T08:00:00Z');
    const f = await fixture({ now: () => now });
    await f.pair();
    await f.service.setPrivateReminders(f.service.authority().bindingId, true);
    const sourceId = 'opaque-'.repeat(120);
    const inbound = message(sourceId, 'owner-1', '十分钟后提醒我喝水');
    await f.service.handleInbound(inbound);
    // Fill the remaining slots in one fixture write. A real subsequent inbound
    // command exercises the same eviction path as 1,024 distinct messages.
    await f.store.update(state => {
      state.processedMessageIds = [sourceId, ...Array.from({ length: 1023 }, (_, i) => 'later-' + i)];
    });
    await f.service.handleInbound(message('last-slot', 'owner-1', '/ping'));
    expect(f.store.snapshot().processedMessageIds).not.toContain(sourceId);
    await f.service.handleInbound(inbound);
    expect(f.store.snapshot().outbox.filter(item => item.reminderDueAt)).toHaveLength(1);
    expect(f.adapter.sends.filter(item => item.replyTo === sourceId)).toHaveLength(1);
    now = new Date('2026-11-05T08:11:00Z');
    await f.service.tickReminders();
    const pushed = f.adapter.sends.filter(item => item.replyTo === undefined);
    expect(pushed).toEqual([{openId:'owner-1',content:expect.stringMatching(/^这条提醒来晚了，.*提醒你喝水。$/u)}]);
  });
  it.each(['official','onebot'] as const)('restores one due reminder on %s and delivers it without an old reply ID', async transport => {
    let time = new Date('2026-11-05T08:00:00Z');
    const f = await fixture({ now: () => time });
    if (transport === 'onebot') await f.service.configure({ transport, onebotUrl:'ws://127.0.0.1:3100', enabled:true });
    await f.pair();
    await f.service.handleInbound(message('off','owner-1','十分钟后提醒我喝水'));
    expect(f.store.snapshot().outbox.filter(item=>item.reminderDueAt)).toHaveLength(0);
    await f.service.setPrivateReminders(f.service.authority().bindingId,true);
    await f.service.handleInbound(message('other','stranger','十分钟后提醒我喝水'));
    await f.service.handleInbound(message('m1','owner-1','十分钟后提醒我喝水'));
    await f.service.handleInbound(message('m1','owner-1','十分钟后提醒我喝水'));
    expect(f.runs).not.toHaveBeenCalled();
    expect(f.store.snapshot().outbox.filter(item=>item.reminderDueAt)).toHaveLength(1);
    expect(f.adapter.sends.at(-1)?.content).toBe('好，十分钟后我提醒你喝水。');
    const scheduled = f.store.snapshot().outbox.find(item=>item.reminderDueAt)!;
    expect(scheduled).toMatchObject({status:'pending',reminderDueAt:'2026-11-05T08:10:00.000Z',replyTo:null});
    await f.service.tickReminders();
    expect(f.adapter.sends.some(item=>item.replyTo===undefined)).toBe(false);
    f.service.dispose();
    const restored = new QqChannelService({...f.deps, store:new QqChannelStore(f.path,f.vault)});
    await restored.initialize();
    time=new Date('2026-11-05T08:10:05Z');
    await restored.tickReminders();
    await restored.tickReminders();
    expect(f.adapter.sends.filter(item=>item.replyTo===undefined)).toEqual([{openId:'owner-1',content:'喝口水吧。'}]);
  });

  it('cancels by receipt, catches up after reconnect, expires stale reminders and revokes queued notices', async () => {
    let now = Date.parse('2026-11-05T09:00:00Z');
    const f = await fixture({ now:()=>new Date(now) }); await f.pair();
    const id=f.service.authority().bindingId;
    await f.service.setPrivateReminders(id,true);
    await f.service.handleInbound(message('create','owner-1','/remind 1s call the library'));
    const first=f.store.snapshot().outbox.find(item=>item.reminderDueAt)!;
    await f.service.handleInbound(message('list','owner-1','/reminders'));
    expect(f.adapter.sends.at(-1)?.content).toContain(first.id.slice(0,8));
    await f.service.handleInbound(message('cancel','owner-1','取消提醒 '+first.id.slice(0,8)));
    await f.service.handleInbound(message('second','owner-1','1秒后提醒我喝茶'));
    f.adapter.events!.onConnectionChange('offline'); now+=2000;await f.service.tickReminders();
    expect(f.adapter.sends.some(item=>item.replyTo===undefined)).toBe(false);
    f.adapter.events!.onConnectionChange('online');await f.service.tickReminders();
    expect(f.adapter.sends.filter(item=>item.replyTo===undefined).map(item=>item.content)).toEqual(['喝口茶吧。']);
    await f.service.handleInbound(message('stale','owner-1','1秒后提醒我出门'));
    now+=25*3_600_000;await f.service.tickReminders();
    expect(f.store.snapshot().outbox.find(item=>item.content==='提醒：出门')).toMatchObject({status:'discarded',errorCode:'qq.reminderExpired'});
    await f.service.handleInbound(message('revoke','owner-1','1秒后提醒我休息'));
    await f.service.setPrivateReminders(id,false); now+=2000;await f.service.tickReminders();
    expect(f.store.snapshot().outbox.find(item=>item.content==='提醒：休息')).toMatchObject({status:'discarded'});
    expect(f.adapter.sends.filter(item=>item.replyTo===undefined)).toHaveLength(1);
  });
});

describe('QQ pairing and authority', () => {
  it('retains an offline long reply until reconnect and binds its mobile preview to the full source', async () => {
    const f = await fixture(); await f.pair();
    const original = '一段长回复。'.repeat(1700);
    f.runs.mockResolvedValueOnce({ ok:true, reply:original, runId:randomUUID(), assistantMessageId:randomUUID() });
    f.adapter.events!.onConnectionChange('offline');
    await f.service.handleInbound(message('long','owner-1','请详细说明'));
    expect(f.adapter.sends).toEqual([]);
    const item = f.store.snapshot().outbox[0]!;
    expect(item.status).toBe('pending');
    expect(item.sourceSHA256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(item.content.length).toBeLessThanOrEqual(8000);
    expect(item.content).toContain('桌面会话');
    f.adapter.events!.onConnectionChange('online');
    await vi.waitFor(() => expect(f.store.snapshot().outbox[0]?.status).toBe('sent'));
    expect(f.adapter.sends).toEqual([{openId:'owner-1', content:item.content, replyTo:'long'}]);
  });
  it('connects BEFORE binding and requires desktop approval of the candidate', async () => {
    const f = await fixture();
    expect(f.adapter.starts).toBe(0);
    const pairing = await f.service.startPairing();
    expect(f.adapter.starts).toBe(1);
    await f.service.handleInbound(message('pair', 'candidate', `/pair ${pairing.code}`));
    expect(f.service.status().bound).toBe(false);
    expect(f.service.status().pairingCandidate?.senderId).toBe('candidate');
    await f.service.handleInbound(message('chat', 'candidate', 'hello'));
    expect(f.runs).not.toHaveBeenCalled(); expect(f.adapter.sends).toEqual([]);
    await expect(f.service.confirmPairing(randomUUID())).rejects.toThrow('qq.pairingUnavailable');
    await f.service.confirmPairing(f.service.status().pairingCandidate!.id);
    expect(f.service.status().bound).toBe(true);
  });

  const pairGroup = async (f: Awaited<ReturnType<typeof fixture>>, groupId = 'group-1') => {
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage(`pair-${groupId}`, 'owner-in-group', `/pair ${pairing.code}`, groupId));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    return f.service.status().groups.find(group => group.groupId === groupId)!;
  };

  it('retains opaque IDs through pairing, session creation and group delivery', async () => {
    const createBindingSession = vi.fn(async () => ({ sessionId: randomUUID() }));
    const f = await fixture({ host: { createBindingSession } });
    const group = 'group'.repeat(160), member = 'member'.repeat(150);
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage(`ROBOT1.0_${'a'.repeat(1600)}`, member, `/pair ${pairing.code}`, group));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    expect(createBindingSession).toHaveBeenCalledWith(expect.any(String), group);
    const id = `ROBOT1.0_${'b'.repeat(1600)}`;
    await f.service.handleInbound(groupMessage(id, member, '/ping', group));
    expect(f.adapter.groupSends.at(-1)).toMatchObject({ groupId: group, content: 'pong', replyTo: id });
  });

  it('says on the desktop why a group pairing message did not work, and stays silent in the group', async () => {
    const f = await fixture(); const pairing = await f.service.startGroupPairing();
    expect(f.service.status().groupPairingIssue).toBeNull();
    await f.service.handleInbound(groupMessage('format', 'member', '配对'));
    expect(f.service.status().groupPairingIssue).toBe('wrong-format');
    const wrong = pairing.code === '000000' ? '000001' : '000000';
    await f.service.handleInbound(groupMessage('code', 'member', `/pair ${wrong}`));
    expect(f.service.status().groupPairingIssue).toBe('wrong-code');
    await f.service.handleInbound(groupMessage('right', 'member', `/pair ${pairing.code}`));
    expect(f.service.status()).toMatchObject({ groupPairingIssue: null, groupCandidate: { groupId: 'group-1' } });
    expect(f.adapter.groupSends).toEqual([]);
  });

  it('replies to a group mention only after the desktop approves that group', async () => {
    const f = await fixture();
    await f.service.handleInbound(groupMessage('early', 'member', '你好'));
    expect(f.runs).not.toHaveBeenCalled(); expect(f.adapter.groupSends).toEqual([]);
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage('pair', 'member', `/pair ${pairing.code}`));
    expect(f.service.status()).toMatchObject({ groups: [], groupCandidate: { groupId: 'group-1' } });
    await f.service.handleInbound(groupMessage('before-approval', 'member', '你好'));
    expect(f.runs).not.toHaveBeenCalled();
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    await f.service.handleInbound(groupMessage('hello', 'memberABCD', '查一下天气'));
    expect(f.runs).toHaveBeenCalledOnce();
    expect(f.runs.mock.calls[0]![0]).toMatchObject({ senderId: 'group:group-1', text: '[群成员 ABCD] 查一下天气' });
    expect(f.adapter.groupSends).toEqual([{ groupId: 'group-1', content: 'echo:[群成员 ABCD] 查一下天气', replyTo: 'hello' }]);
    expect(f.adapter.sends).toEqual([]);
    expect(f.service.status().groupRequests).toBe(1);
  });

  it('keeps a group separate from the private binding, including /stop', async () => {
    const f = await fixture();
    const group = await pairGroup(f);
    const pairing = await f.service.startPairing();
    await f.service.handleInbound(groupMessage('wrong-place', 'attacker', `/pair ${pairing.code}`));
    expect(f.service.status().pairingCandidate).toBeNull();
    await f.service.handleInbound(groupMessage('stop', 'owner-in-group', '/stop'));
    expect(f.service.status().stopped).toBe(false);
    expect(f.service.status().groups).toEqual([expect.objectContaining({ id: group.id })]);
    expect(() => f.service.authority()).toThrow('qq.authorityRevoked');
  });

  it('can limit a group to the member who paired it, and removal ends its authority', async () => {
    const f = await fixture();
    const group = await pairGroup(f);
    await f.service.setGroupOpen(group.id, false);
    await f.service.handleInbound(groupMessage('other', 'someone-else', '你好'));
    expect(f.runs).not.toHaveBeenCalled();
    await f.service.handleInbound(groupMessage('mine', 'owner-in-group', '你好'));
    expect(f.runs).toHaveBeenCalledOnce();
    const authority = f.runs.mock.calls[0]![0];
    await f.service.removeGroup(group.id);
    expect(() => f.service.assertAuthorized(authority)).toThrow('qq.authorityRevoked');
    await f.service.handleInbound(groupMessage('after', 'owner-in-group', '你好'));
    expect(f.runs).toHaveBeenCalledOnce();
  });

  it('stops answering a group at its daily limit and tells the group', async () => {
    const f = await fixture();
    await pairGroup(f);
    for (let n = 0; n < QQ_GROUP_DAILY_LIMIT + 1; n += 1) await f.service.handleInbound(groupMessage(`m-${n}`, 'member', '你好'));
    expect(f.runs).toHaveBeenCalledTimes(QQ_GROUP_DAILY_LIMIT);
    expect(f.adapter.groupSends.at(-1)?.content).toBe('今天群聊的对话次数已用完。');
  });

  it('explains why a message from an unbound sender did not pair, without keeping its text', async () => {
    const f = await fixture();
    await f.service.handleInbound(message('early', 'owner', '/pair 123456'));
    expect(f.service.status().pairingIssue).toBe('no-active-code');
    const pairing = await f.service.startPairing();
    expect(f.service.status().pairingIssue).toBeNull();
    await f.service.handleInbound(message('chat', 'owner', '你好 private text'));
    expect(f.service.status().pairingIssue).toBe('wrong-format');
    await f.service.handleInbound(message('wrong', 'owner', `/pair ${pairing.code === '000000' ? '000001' : '000000'}`));
    expect(f.service.status().pairingIssue).toBe('wrong-code');
    await f.service.handleInbound(message('right', 'owner', `/pair ${pairing.code}`));
    expect(f.service.status()).toMatchObject({ pairingIssue: null, pairingCandidate: { senderId: 'owner' } });
    expect(JSON.stringify(f.service.status())).not.toContain('private text');
  });

  it('locks pairing after five distinct wrong codes and prevents candidate replacement', async () => {
    const f = await fixture(), pairing = await f.service.startPairing();
    const wrong = pairing.code === '000000' ? '000001' : '000000';
    for (let n = 0; n < 5; n += 1) await f.service.handleInbound(message(`wrong-${n}`, 'attacker', `/pair ${wrong}`));
    await f.service.handleInbound(message('late', 'owner', `/pair ${pairing.code}`));
    expect(f.service.status().pairingCandidate).toBeNull();
    const next = await f.service.startPairing();
    await f.service.handleInbound(message('first', 'owner', `/pair ${next.code}`));
    await f.service.handleInbound(message('second', 'attacker', `/pair ${next.code}`));
    expect(f.service.status().pairingCandidate?.senderId).toBe('owner');
  });

  it('expires candidates before desktop confirmation', async () => {
    let now = new Date('2026-11-02T12:00:00.000Z');
    const f = await fixture({ now: () => now }), pairing = await f.service.startPairing();
    await f.service.handleInbound(message('pair', 'owner', `/pair ${pairing.code}`));
    const id = f.service.status().pairingCandidate!.id;
    now = new Date(now.getTime() + 300_001);
    await expect(f.service.confirmPairing(id)).rejects.toThrow('qq.pairingUnavailable');
  });

  it('serves only the owner, deduplicates concurrent deliveries and scopes replyTo', async () => {
    const f = await fixture(); await f.pair();
    await Promise.all([f.service.handleInbound(message('m1', 'owner-1', 'hello')), f.service.handleInbound(message('m1', 'owner-1', 'hello'))]);
    await f.service.handleInbound(message('intruder', 'stranger', 'a'.repeat(8_001)));
    await f.service.handleInbound(message('stranger', 'stranger', 'hello'));
    expect(f.runs).toHaveBeenCalledTimes(1);
    expect(f.adapter.sends).toEqual([{ openId: 'owner-1', content: 'echo:hello', replyTo: 'm1' }]);
    expect(f.store.snapshot().outbox[0]?.authority).toEqual(f.service.authority());
  });

  it('/stop cancels immediately while the model promise is still pending', async () => {
    const started = deferred(), finished = deferred();
    const f = await fixture({ host: { runMessage: async () => {
      started.resolve(); await finished.promise;
      return { ok: true, reply: 'OLD_PRIVATE_REPLY', runId: randomUUID(), assistantMessageId: randomUUID() };
    } } });
    await f.pair(); const authority = f.service.authority();
    const running = f.service.handleInbound(message('run', 'owner-1', 'wait'));
    await started.promise;
    await f.service.handleInbound(message('stop', 'intruder', '/stop'));
    expect(() => f.service.assertAuthorized(authority)).not.toThrow();
    await f.service.handleInbound(message('stop', 'owner-1', '/stop'));
    expect(f.stopped).toHaveBeenCalledTimes(1);
    expect(() => f.service.assertAuthorized(authority)).toThrow('qq.authorityRevoked');
    finished.resolve(); await running;
    expect(f.adapter.sends).toEqual([]);
  });

  it('revokes before a slow disk write, even if the write subsequently fails', async () => {
    const f = await fixture(); await f.pair(); const authority = f.service.authority();
    const write = deferred(), entered = deferred();
    const original = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementationOnce(async () => { entered.resolve(); await write.promise; throw new Error('disk full'); });
    const stop = f.service.emergencyStop();
    expect(() => f.service.assertAuthorized(authority)).toThrow('qq.authorityRevoked');
    await entered.promise; write.resolve(); await expect(stop).rejects.toThrow('disk full');
    expect(() => f.service.assertAuthorized(authority)).toThrow('qq.authorityRevoked');
    await original(draft => { draft.stopped = true; });
  });

  it('cannot commit desktop approval after emergency revocation during session creation', async () => {
    const started = deferred(), finished = deferred();
    const f = await fixture({ host: { createBindingSession: async () => { started.resolve(); await finished.promise; return { sessionId: randomUUID() }; } } });
    const pairing = await f.service.startPairing();
    await f.service.handleInbound(message('pair', 'owner', `/pair ${pairing.code}`));
    const approval = f.service.confirmPairing(f.service.status().pairingCandidate!.id);
    await started.promise; const stop = f.service.emergencyStop(); finished.resolve();
    await expect(approval).rejects.toThrow('qq.authorityRevoked'); await stop;
    expect(f.store.snapshot().binding).toBeNull();
  });
});

describe('QQ delivery and persistence', () => {
  it('never sends an old completed run to a newly paired account', async () => {
    const started = deferred(), finished = deferred();
    const f = await fixture({ host: { runMessage: async () => { started.resolve(); await finished.promise; return { ok: true, reply: 'OLD_REPLY', runId: randomUUID(), assistantMessageId: randomUUID() }; } } });
    await f.pair(); const old = f.service.authority();
    const running = f.service.handleInbound(message('old', 'owner-1', 'hello')); await started.promise;
    await f.service.unbind(); await f.service.configure({ enabled: true }); await f.pair('owner-2');
    finished.resolve(); await running;
    expect(() => f.service.assertAuthorized(old)).toThrow('qq.authorityRevoked');
    expect(f.adapter.sends).toEqual([]);
  });

  it('rechecks authority after transport waits, before issuing a POST', async () => {
    const f = await fixture(); await f.pair();
    const entered = deferred(), ready = deferred();
    f.adapter.beforeSend = async () => { entered.resolve(); await ready.promise; };
    const running = f.service.handleInbound(message('m', 'owner-1', 'hello')); await entered.promise;
    await f.service.unbind(); ready.resolve(); await running;
    expect(f.adapter.sends).toEqual([]);
    expect(f.store.snapshot().outbox[0]?.status).toBe('unknown');
  });

  it('checks disclosure again inside the transport boundary', async () => {
    let allowed = true;
    const f = await fixture({ host: { assertDelivery: () => { if (!allowed) throw new Error('qq.disclosureBlocked'); } } });
    await f.pair();
    f.adapter.beforeSend = async () => { allowed = false; };
    await f.service.handleInbound(message('m', 'owner-1', 'hello'));
    expect(f.adapter.sends).toEqual([]);
  });

  it('single-flights flushing and does not retry uncertain sends', async () => {
    const f = await fixture(); await f.pair();
    f.adapter.nextResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    await f.service.handleInbound(message('m', 'owner-1', 'hello'));
    await Promise.all([f.service.retryUnknownDeliveries(), f.service.retryUnknownDeliveries()]);
    expect(f.adapter.sends).toHaveLength(1);
    expect(f.store.snapshot().outbox[0]?.status).toBe('unknown');
  });

  it('does not automatically loop on explicit platform rejects or retry across re-enable', async () => {
    const f = await fixture(); await f.pair();
    f.adapter.nextResult = { ok: false, unknown: false, error: 'qq.sendHttp_429' };
    await f.service.handleInbound(message('m', 'owner-1', 'hello'));
    expect(f.adapter.sends).toHaveLength(1);
    expect(f.store.snapshot().outbox[0]?.status).toBe('failed');
    await f.service.configure({ enabled: false }); await f.service.configure({ enabled: true });
    await f.service.retryUnknownDeliveries(); expect(f.adapter.sends).toHaveLength(1);
    expect(f.store.snapshot().outbox[0]?.status).toBe('discarded');
  });

  it('enforces a daily request limit and rolls it over on the next day', async () => {
    let now = new Date('2026-11-02T12:00:00Z');
    const f = await fixture({ now: () => now }); await f.service.configure({ dailyRequestLimit: 1 }); await f.pair();
    await f.service.handleInbound(message('first', 'owner-1', 'first'));
    await f.service.handleInbound(message('second', 'owner-1', 'second'));
    expect(f.runs).toHaveBeenCalledTimes(1);
    now = new Date('2026-11-03T12:00:00Z'); expect(f.service.status().dailyRequests).toBe(0);
    await f.service.handleInbound(message('third', 'owner-1', 'third')); expect(f.runs).toHaveBeenCalledTimes(2);
  });

  it('encrypts reply bodies and clears authority after profile changes or restore', async () => {
    const f = await fixture(); await f.pair();
    await f.service.handleInbound(message('m', 'owner-1', 'PRIVATE_MARKER'));
    const disk = await readFile(f.path, 'utf8');
    expect(disk).not.toContain('PRIVATE_MARKER'); expect(disk).not.toContain('owner-1');
    const restored = new QqChannelStore(f.path, f.vault); await restored.initialize();
    expect(restored.snapshot().outbox[0]?.content).toContain('PRIVATE_MARKER');
    f.changeProfile();
    expect(() => f.service.authority()).toThrow('qq.authorityRevoked');
    const restart = new QqChannelService({ ...f.deps, store: restored }); await restart.initialize();
    expect(restart.status().bound).toBe(false); expect(restart.status().enabled).toBe(false);
    expect(restored.snapshot().outbox).toEqual([]);
  });

  it('explicit restore invalidates even the SAME profile identity', async () => {
    const f = await fixture(); await f.pair(); const authority = f.service.authority();
    await f.service.invalidateForRestore();
    expect(() => f.service.assertAuthorized(authority)).toThrow();
    expect(f.service.status()).toMatchObject({ enabled: false, bound: false, stopped: true });
  });

  it('connects OneBot from its own endpoint, and changing transport drops the binding', async () => {
    const f = await fixture(); await f.pair();
    expect(f.service.status().bound).toBe(true);
    const starts = f.adapter.starts;
    await f.service.configure({ transport: 'onebot' });
    expect(f.service.status()).toMatchObject({ transport: 'onebot', bound: false, appIdConfigured: false, connection: 'disabled' });
    await f.service.startPairing(); expect(f.adapter.starts).toBe(starts);
    await f.service.configure({ onebotUrl: 'ws://127.0.0.1:3001' });
    expect(f.service.status().appIdConfigured).toBe(true);
    await f.service.startPairing(); expect(f.adapter.starts).toBe(starts + 1);
    await f.pair();
    await f.service.configure({ onebotUrl: 'ws://127.0.0.1:3002' });
    expect(f.service.status().bound).toBe(false);
  });

  it('marks interrupted sends unknown on restart and never resumes them', async () => {
    const f = await fixture(); await f.pair();
    await f.service.handleInbound(message('m', 'owner-1', 'hello'));
    await f.store.update(draft => { draft.outbox[0]!.status = 'sending'; });
    const restart = new QqChannelService({ ...f.deps, store: new QqChannelStore(f.path, f.vault) });
    await restart.initialize(); await restart.retryUnknownDeliveries();
    expect(f.adapter.sends).toHaveLength(1);
  });

  it('sends just one fixed check-in to the explicitly selected private binding per clock window, including after restart', async () => {
    let time = Date.parse('2026-11-04T09:03:00Z');
    const policy = { timezone: 'UTC', revision: 3, permissionRevision: 7, quietStart: '22:00', quietEnd: '07:00',
      dailyLimit: 2, cooldownMinutes: 60, locale: 'en' as const };
    const f = await fixture({ now: () => new Date(time), host: { privateCarePolicy: () => policy } });
    await f.pair();
    const binding = f.service.authority().bindingId;
    await f.service.offerPrivateCare(); expect(f.adapter.sends).toHaveLength(0);
    await expect(f.service.setPrivateCare(randomUUID(), true)).rejects.toThrow('qq.authorityRevoked');
    await f.service.setPrivateCare(binding, true);
    await Promise.all([f.service.offerPrivateCare(), f.service.offerPrivateCare()]);
    expect(f.adapter.sends).toEqual([{ openId:'owner-1', content:'Good morning. Is there anything you’d like to make time for today?' }]);
    expect(f.adapter.groupSends).toHaveLength(0);
    const restarted = new QqChannelService({ ...f.deps, store:new QqChannelStore(f.path, f.vault) });
    await restarted.initialize();
    await restarted.offerPrivateCare(); expect(f.adapter.sends).toHaveLength(1);
    time = Date.parse('2026-11-04T15:14:59Z');
    await restarted.offerPrivateCare(); expect(f.adapter.sends).toHaveLength(2);
    time = Date.parse('2026-11-04T20:00:00Z');
    expect((await restarted.sendPrivateCareNow(binding)).privateCareResult).toBe('frequency');
    time = Date.parse('2026-11-05T02:00:00Z');
    expect((await restarted.sendPrivateCareNow(binding)).privateCareResult).toBe('quiet');
    time = Date.parse('2026-11-05T15:16:00Z');
    await restarted.offerPrivateCare(); expect(f.adapter.sends).toHaveLength(2);
  });

  it('rechecks immediate opt-out at the transport, and never carries the grant to another private recipient', async () => {
    const f = await fixture({ host:{privateCarePolicy:() => ({ timezone:'UTC', quietStart:'00:00', quietEnd:'00:00',
      revision:1, permissionRevision:0, cooldownMinutes:10, dailyLimit:3, locale:'zh-CN' })} });
    await f.pair(); const binding = f.service.authority().bindingId;
    await f.service.setPrivateCare(binding, true);
    const entering=deferred(), proceed=deferred();
    f.adapter.beforeSend = async () => { entering.resolve(); await proceed.promise; };
    const trying = f.service.sendPrivateCareNow(binding);
    await entering.promise;
    const disable = f.service.setPrivateCare(binding,false);
    proceed.resolve(); await disable; await trying;
    expect(f.adapter.sends).toHaveLength(0);
    f.adapter.beforeSend = null;
    await f.service.unbind(); await f.service.configure({enabled:true}); await f.pair('next-owner');
    expect(f.service.status().privateCareEnabled).toBe(false);
    await expect(f.service.setPrivateCare(binding,true)).rejects.toThrow('qq.authorityRevoked');
    expect(f.adapter.sends).toHaveLength(0);
  });

  it('rejects malformed cron drafts and never passes confirmation commands to the model', async () => {
    const f = await fixture(); await f.pair();
    await expect(f.service.createCronDraft(randomUUID(), { title: 'news' } as never)).rejects.toThrow();
    await f.service.handleInbound(message('confirm', 'owner-1', '/confirm 123456'));
    expect(f.runs).not.toHaveBeenCalled(); expect(f.store.snapshot().confirmations).toEqual([]);
  });
});

describe('live private QQ web-budget decisions', () => {
  const liveServices: QqChannelService[] = [];
  const liveRuns: Promise<void>[] = [];
  afterEach(async () => {
    for (const service of liveServices.splice(0)) service.dispose();
    await Promise.allSettled(liveRuns.splice(0));
    vi.useRealTimers();
  });

  const waitingFixture = async (rounds = 1) => {
    const runId = randomUUID(), signal = new AbortController();
    const decisions: boolean[] = [];
    let service!: QqChannelService;
    const runMessage = vi.fn<QqHostSurface['runMessage']>(async input => {
      for (let round = 0; round < rounds; round += 1) {
        const approved = await service.requestWebBudget(input, {
          runId, usedLimit: 10 + round * 20, additionalCalls: 20, signal: signal.signal,
        });
        decisions.push(approved);
        if (!approved) break;
      }
      return { ok: true, reply: decisions.at(-1) ? 'final:continued' : 'final:partial', runId, assistantMessageId: randomUUID() };
    });
    const f = await fixture({ host: { runMessage } });
    service = f.service; liveServices.push(service);
    await f.pair();
    const start = (): Promise<void> => {
      const run = service.handleInbound(message('research-start', 'owner-1', 'Compare public prices.'));
      liveRuns.push(run); return run;
    };
    const waitForPrompts = async (count = 1): Promise<void> => {
      await vi.waitFor(() => expect(f.store.snapshot().outbox.filter(item => item.webBudgetRunId === runId && item.status === 'sent')).toHaveLength(count));
    };
    return { ...f, runId, signal, decisions, runMessage, start, waitForPrompts };
  };

  it('accepts only exact owner replies, keeps one live run, deduplicates decisions and refreshes each reply window', async () => {
    const f = await waitingFixture(2);
    const pairing = await f.service.startGroupPairing();
    await f.service.handleInbound(groupMessage('pair-budget-group', 'owner-in-group', `/pair ${pairing.code}`));
    await f.service.confirmGroupPairing(f.service.status().groupCandidate!.id);
    const run = f.start();
    await f.waitForPrompts();
    expect(f.adapter.sends.at(-1)).toMatchObject({ openId: 'owner-1', replyTo: 'research-start' });
    expect(f.adapter.sends.at(-1)!.content).toContain('已用完 10 次联网');
    expect(f.adapter.sends.at(-1)!.content).toContain('增加 20 次');
    await f.service.handleInbound(message('intruder-yes', 'intruder', '继续搜索'));
    await f.service.handleInbound(groupMessage('group-yes', 'owner-in-group', '继续搜索'));
    await f.service.handleInbound(message('non-command', 'owner-1', '网页上写着“继续搜索”'));
    expect(f.decisions).toEqual([]);
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.store.snapshot().inboundQueue.find(item => item.messageId === 'non-command')?.status).toBe('queued');
    await f.service.handleInbound(message('cancel-non-command', 'owner-1', '/cancel-queue'));

    const approval = message('owner-yes', 'owner-1', '继续搜索');
    await Promise.all([f.service.handleInbound(approval), f.service.handleInbound(approval)]);
    await f.waitForPrompts(2);
    expect(f.decisions).toEqual([true]);
    expect(f.adapter.sends.at(-1)).toMatchObject({ replyTo: 'owner-yes' });
    expect(f.adapter.sends.at(-1)!.content).toContain('已用完 30 次联网');
    await f.service.handleInbound(approval);
    expect(f.decisions).toEqual([true]);
    await f.service.handleInbound(message('owner-no', 'owner-1', '先给结果'));
    await run;

    expect(f.decisions).toEqual([true, false]);
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends.at(-1)).toEqual({ openId: 'owner-1', content: 'final:partial', replyTo: 'owner-no' });
    expect(f.adapter.sends).toHaveLength(5); // Two prompts, queue/cancel receipts, and the final answer.
    expect(f.store.snapshot().config.webCallLimit).toBe(10);
    expect(f.store.snapshot().dailyUsage.requests).toBe(1);
  });

  it('declines on the owner request and never sends an expired reserved command to the model', async () => {
    const f = await waitingFixture();
    const run = f.start(); await f.waitForPrompts();
    await f.service.handleInbound(message('decline', 'owner-1', '先给结果'));
    await run;
    expect(f.decisions).toEqual([false]);
    expect(f.adapter.sends.at(-1)).toEqual({ openId: 'owner-1', content: 'final:partial', replyTo: 'decline' });
    await f.service.handleInbound(message('late-command', 'owner-1', '/继续搜索'));
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends.at(-1)!.content).toContain('当前没有等待确认');
    await expect(f.service.requestWebBudget(f.service.authority(), {
      runId: randomUUID(), usedLimit: 10, additionalCalls: 20, signal: new AbortController().signal,
    })).resolves.toBe(false);
    expect(f.runMessage).toHaveBeenCalledOnce();
  });

  it('does not approve a prompt that has never reached a send attempt', async () => {
    const f = await waitingFixture();
    f.adapter.events!.onConnectionChange('offline');
    const run = f.start();
    await vi.waitFor(() => expect(f.store.snapshot().outbox.find(item => item.webBudgetRunId === f.runId))
      .toMatchObject({ status: 'pending', attempts: 0 }));
    await f.service.handleInbound(message('too-early', 'owner-1', '继续搜索'));
    expect(f.decisions).toEqual([]);
    expect(f.adapter.sends).toHaveLength(0);
    f.signal.abort(); await run;
    expect(f.decisions).toEqual([false]);
    await vi.waitFor(() => expect(f.store.snapshot().outbox.find(item => item.webBudgetRunId === f.runId)?.status).toBe('discarded'));
  });

  it('declines immediately when sending the prompt is known to have failed', async () => {
    const f = await waitingFixture();
    f.adapter.nextResult = { ok: false, unknown: false, error: 'qq.sendFailed' };
    await f.start();
    expect(f.decisions).toEqual([false]);
    expect(f.runMessage).toHaveBeenCalledOnce();
    const prompt = f.store.snapshot().outbox.find(item => item.webBudgetRunId === f.runId)!;
    expect(prompt.attempts).toBe(1);
    expect(prompt.status).toBe('discarded');
  });

  it('accepts an explicit owner decision after an uncertain prompt send without retrying that prompt', async () => {
    const f = await waitingFixture();
    f.adapter.nextResult = { ok: false, unknown: true, error: 'qq.sendUnknown' };
    const run = f.start();
    await vi.waitFor(() => expect(f.store.snapshot().outbox.find(item => item.webBudgetRunId === f.runId)?.status).toBe('unknown'));
    f.adapter.nextResult = { ok: true, unknown: false };
    await f.service.handleInbound(message('uncertain-prompt-yes', 'owner-1', '继续搜索'));
    await run;
    expect(f.decisions).toEqual([true]);
    expect(f.adapter.sends).toHaveLength(2);
    expect(f.adapter.sends.at(-1)).toEqual({ openId: 'owner-1', content: 'final:continued', replyTo: 'uncertain-prompt-yes' });
  });

  it('times out after five minutes, clears its timer and treats a later owner reply as expired', async () => {
    const f = await waitingFixture();
    vi.useFakeTimers();
    const run = f.start(); await f.waitForPrompts();
    expect(f.decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await run;
    expect(f.decisions).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.handleInbound(message('after-timeout', 'owner-1', '继续搜索'));
    expect(f.runMessage).toHaveBeenCalledOnce();
    expect(f.adapter.sends.at(-1)!.content).toContain('已失效');
  });

  it('releases the pending decision when its runtime signal aborts', async () => {
    const f = await waitingFixture();
    const removeListener = vi.spyOn(f.signal.signal, 'removeEventListener');
    const run = f.start(); await f.waitForPrompts();
    f.signal.abort(); await run;
    expect(f.decisions).toEqual([false]);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(f.runMessage).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'disable', 'dispose'] as const)('revokes the live decision on %s without delivering a stale final answer', async action => {
    const f = await waitingFixture();
    const run = f.start(); await f.waitForPrompts();
    if (action === 'stop') await f.service.handleInbound(message('stop-budget', 'owner-1', '/stop'));
    else if (action === 'disable') await f.service.configure({ enabled: false });
    else f.service.dispose();
    await run;
    expect(f.decisions).toEqual([false]);
    expect(f.adapter.sends).toHaveLength(1);
    expect(f.adapter.sends[0]!.content).toContain('是否再增加');
  });

  it('discards persisted pending and sending budget prompts on restart instead of restoring a waiter', async () => {
    const f = await fixture(); await f.pair();
    liveServices.push(f.service);
    const authority = f.service.authority();
    await f.store.update(draft => {
      for (const status of ['pending', 'sending', 'failed'] as const) draft.outbox.push({
        id: randomUUID(), authority, kind: 'system', runId: null, assistantMessageId: null,
        webBudgetRunId: randomUUID(), content: 'Old continuation prompt.', replyTo: 'old-message', status,
        attempts: status === 'pending' ? 0 : 1, createdAt: '2026-11-02T12:00:00.000Z', lastAttemptAt: null, errorCode: null,
      });
    });
    f.service.dispose();
    const store = new QqChannelStore(f.path, f.vault);
    const restarted = new QqChannelService({ ...f.deps, store });
    liveServices.push(restarted);
    await restarted.initialize();
    expect(store.snapshot().outbox.filter(item => item.webBudgetRunId).map(item => item.status)).toEqual(['discarded', 'discarded', 'discarded']);
    expect(f.adapter.sends).toHaveLength(0);
    await restarted.handleInbound(message('restart-confirmation', 'owner-1', '继续搜索'));
    expect(f.runs).not.toHaveBeenCalled();
    expect(f.adapter.sends.at(-1)!.content).toContain('当前没有等待确认');
  });
});

it('reconnects an offline adapter without revoking authority or resending an uncertain reply', async () => {
  const { service, adapter, pair, store } = await fixture();
  try {
    await pair();
    adapter.nextResult = { ok: false, unknown: true };
    await service.handleInbound(message('repair-test-message', 'owner-1', 'Hello fixture'));
    expect(service.status().uncertainOutbox).toBe(1);
    const sends = adapter.sends.length;
    const starts = adapter.starts;
    const authority = service.authority();
    const outbox = store.snapshot().outbox;
    adapter.lastError = 'qq.gatewayClosed';
    adapter.events!.onConnectionChange('offline');
    expect(service.canReconnect()).toBe(true);
    expect(await service.reconnect(() => true)).toBe(true);
    expect(service.status().connection).toBe('online');
    expect(adapter.starts).toBe(starts + 1);
    expect(service.authority()).toEqual(authority);
    expect(adapter.sends).toHaveLength(sends);
    expect(store.snapshot().outbox).toEqual(outbox);
    await service.emergencyStop();
    expect(await service.reconnect(() => true)).toBe(false);
  } finally { service.dispose(); }
});
