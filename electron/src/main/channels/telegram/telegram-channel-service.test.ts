import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultTelegramState } from '../../../shared/telegram-channel';
import { TelegramChannelService, type TelegramHost } from './telegram-channel-service';
import { TelegramChannelStore } from './telegram-channel-store';
import { parseTelegramUpdate, TelegramApiError, type TelegramApi } from './telegram-bot-api';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const profileId = randomUUID();
const owner = { bindingId: randomUUID(), sessionId: randomUUID(), userId: '11', chatId: '11' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'deskpet-telegram-test-')),
    path = join(dir, 'state.enc');
  const key = randomBytes(32),
    vault = { getVaultKey: vi.fn(async () => key) };
  const getSecret = vi.fn(async () => randomUUID());
  const store = new TelegramChannelStore(path, vault);
  const api = {
    getMe: vi.fn(async () => '42'),
    poll: vi.fn<TelegramApi['poll']>(async () => []),
    send: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
  } satisfies TelegramApi;
  const host: TelegramHost = {
    runMessage: vi.fn(async () => ({ content: 'result', sourceId: randomUUID() })),
    createBindingSession: async () => ({ sessionId: randomUUID() }),
    assertDelivery: vi.fn(),
  };
  const service = new TelegramChannelService({ store, api, profileId: () => profileId, getSecret, host });
  cleanups.push(async () => {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { service, store, api, host, vault, getSecret, dir };
}

it('does not touch credentials or create channel files before first desktop configuration', async () => {
  const f = await fixture();
  await f.service.initialize();
  expect(f.service.status()).toMatchObject({ enabled: false, secretConfigured: false, bound: false });
  expect(await readdir(f.dir)).toEqual([]);
  expect(f.vault.getVaultKey).not.toHaveBeenCalled();
  expect(f.getSecret).not.toHaveBeenCalled();
  expect(f.api.poll).not.toHaveBeenCalled();
});

it('preserves opaque platform identifiers and reports only the invalid field', () => {
  const id = 'private-user-' + 'x'.repeat(800);
  const message = { text: 'private-content', chat: { type: 'private', id }, from: { id, is_bot: false } };
  expect(parseTelegramUpdate({ update_id: 5, message })).toMatchObject({ kind: 'message', chatId: id, userId: id });
  const rejected = parseTelegramUpdate({ update_id: 6, message: { ...message, from: { ...message.from, id: 'another' } } });
  expect(rejected).toEqual({ updateId: 6, kind: 'rejected', type: 'message', field: 'chat.id' });
  expect(
    parseTelegramUpdate({
      update_id: 7,
      callback_query: { from: message.from, message: { chat: { type: 'group', id } }, id, data: 'private-content' },
    }),
  ).toEqual({ updateId: 7, kind: 'rejected', type: 'callback_query', field: 'chat.type' });
});

it('carries note intent proof only for the owner’s text and never for forwards or blockquotes', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const runMessage = vi.fn<TelegramHost['runMessage']>(async ({ text }) => {
    if (text === '开始测试') await pending;
    return { content: 'result', sourceId: randomUUID() };
  });
  const append = vi.fn<NonNullable<TelegramHost['append']>>(async () => true);
  f.host.runMessage = runMessage;
  f.host.append = append;
  const update = (updateId: number, text: string, extra: Record<string, unknown> = {}) => parseTelegramUpdate({
    update_id: updateId,
    message: { text, chat: { type: 'private', id: owner.chatId }, from: { id: owner.userId, is_bot: false }, ...extra },
  });

  await f.store.initialize();
  await f.store.update(s => Object.assign(s, defaultTelegramState(), {
    profileId, tokenConfigured: true, enabled: true, botId: '42', binding: { ...owner, displayName: 'Owner' },
  }));
  f.api.poll.mockResolvedValueOnce([update(1, '开始测试')]);
  await f.service.initialize();
  try {
    await vi.waitFor(() => expect(runMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '开始测试', noteIntentAllowed: true })));
    f.api.poll.mockResolvedValueOnce([
      update(2, '/append 记一下明天的任务', { forward_origin: { type: 'hidden_user' } }),
      update(3, '/append 把这个存起来', { reply_to_message: { text: '被引用的合成内容' }, quote: { text: '被引用的合成内容' } }),
      update(4, '存一下明天的日程', { forward_date: 1 }),
      update(5, '帮我新建一篇笔记', { entities: [{ type: 'expandable_blockquote', offset: 0, length: 8 }] }),
    ]);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
    expect(append.mock.calls.map(([input]) => [input.text, input.noteIntentAllowed])).toEqual([
      ['记一下明天的任务', undefined], ['把这个存起来', true],
    ]);
    await vi.waitFor(() => expect(f.store.snapshot().inbox.filter(entry => entry.status === 'queued')).toHaveLength(2));
  } finally {
    release?.();
    // A host call happens before its reply and delivery are persisted. Wait for
    // both queues to drain before the fixture removes the encrypted store.
    await vi.waitFor(() => expect(f.service.status()).toMatchObject({ pendingInbox: 0, pendingOutbox: 0 }), { timeout: 4000 });
  }
  expect(runMessage).toHaveBeenCalledTimes(3);
  expect(runMessage.mock.calls.slice(1).map(([input]) => [input.text, input.noteIntentAllowed])).toEqual([
    ['存一下明天的日程', undefined], ['帮我新建一篇笔记', undefined],
  ]);
});

it('strips internal controls before hashing a scheduled delivery and rejects a controls-only result', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update(s => Object.assign(s, defaultTelegramState(), {
    profileId, tokenConfigured: true, enabled: true, botId: '42', binding: { ...owner, displayName: 'Owner' },
  }));
  await f.service.initialize();
  const scheduled = { sessionId: owner.sessionId, bindingId: owner.bindingId, sourceId: randomUUID() };
  await expect(f.service.enqueueCron({ ...scheduled, content: '[mood:happy][sticker:none]' })).rejects.toThrow('telegram.cronUnbound');
  await f.service.enqueueCron({ ...scheduled, content: '[sticker:none] [mood:happy] 正文[sticker:only:noon]。' });
  await vi.waitFor(() => expect(f.api.send).toHaveBeenCalledExactlyOnceWith(
    expect.any(String), owner.chatId, '正文。', null, expect.any(AbortSignal),
  ));
  await vi.waitFor(() => expect(f.store.snapshot().outbox[0]).toMatchObject({ content: '正文。', status: 'sent' }));
});

it('never resends an ambiguous POST even when desktop retries definite failures', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update((s) =>
    Object.assign(s, defaultTelegramState(), {
      profileId,
      tokenConfigured: true,
      enabled: true,
      botId: '42',
      binding: { ...owner, displayName: 'Owner' },
    }),
  );
  f.api.send.mockRejectedValueOnce(new TelegramApiError('telegram.network'));
  await f.service.initialize();
  await vi.waitFor(() => expect(f.service.status().connection).toBe('online'));
  await f.service.enqueueCron({
    sessionId: owner.sessionId,
    bindingId: owner.bindingId,
    sourceId: randomUUID(),
    content: 'result',
  });
  await vi.waitFor(() => expect(f.service.status().uncertainOutbox).toBe(1), { timeout: 4000 });
  await f.service.retryDeliveries();
  expect(f.store.snapshot().outbox.map((item) => item.status)).toEqual(['unknown']);
  expect(f.api.send).toHaveBeenCalledTimes(1);
});

it('lets the host answer /model from the paired owner and switch without a model run', async () => {
  const f = await fixture();
  const provider = randomUUID();
  f.host.chatCommand = vi.fn(async (command, target) => {
    await target.select(provider, command.argument);
    return 'switched:' + JSON.stringify(target.selection());
  });
  await f.store.initialize();
  await f.store.update((s) =>
    Object.assign(s, defaultTelegramState(), { profileId, tokenConfigured: true, enabled: true, botId: '42', binding: { ...owner, displayName: 'Owner' } }),
  );
  f.api.poll.mockResolvedValueOnce([
    { updateId: 1, kind: 'message', userId: '99', chatId: '99', name: 'Stranger', text: '/model other' },
    { updateId: 2, kind: 'message', userId: owner.userId, chatId: owner.chatId, name: 'Owner', text: '/model gpt-6.1-sol' },
  ] as never);
  await f.service.initialize();
  await vi.waitFor(() => expect(f.api.send).toHaveBeenCalledTimes(1), { timeout: 4000 });
  expect(f.api.send.mock.calls[0]?.slice(1, 3)).toEqual([owner.chatId, `switched:{"providerId":"${provider}","model":"gpt-6.1-sol"}`]);
  expect(f.host.chatCommand).toHaveBeenCalledTimes(1);
  expect(f.store.snapshot()).toMatchObject({ providerId: provider, model: 'gpt-6.1-sol' });
  expect(f.host.runMessage).not.toHaveBeenCalled();
});

it('rechecks desktop binding before accepting a cron delivery, including after token replacement', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update((s) =>
    Object.assign(s, {
      profileId,
      tokenConfigured: true,
      enabled: true,
      botId: '42',
      binding: { ...owner, displayName: 'Owner' },
    }),
  );
  await f.service.initialize();
  expect(f.service.currentAuthority()).toEqual(owner);
  const original = { sessionId: owner.sessionId, bindingId: owner.bindingId, sourceId: randomUUID(), content: 'content' };
  await expect(f.service.enqueueCron({ ...original, bindingId: randomUUID() })).rejects.toThrow('telegram.cronUnbound');
  await f.service.credentialsChanged(async () => undefined);
  expect(f.service.currentAuthority()).toBeNull();
  expect(f.service.status()).toMatchObject({ enabled: false, bound: false, memoryAllowed: false });
  await expect(f.service.enqueueCron(original)).rejects.toThrow('telegram.cronUnbound');
});

it('gives simultaneous result approvals distinct references and reveals their exact content only via desktop review', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update((s) =>
    Object.assign(s, {
      enabled: true,
      profileId,
      botId: '42',
      tokenConfigured: true,
      binding: { ...owner, displayName: 'Owner' },
    }),
  );
  await f.service.initialize();
  const entries = ['PRIVATE_RESULT_A', 'PRIVATE_RESULT_B'];
  for (const content of entries)
    await f.service.enqueueCron({
      sessionId: owner.sessionId,
      bindingId: owner.bindingId,
      sourceId: randomUUID(),
      content,
      requiresApproval: true,
    });
  const review = f.service.pendingResults();
  expect(review.map((r) => r.content)).toEqual(entries);
  expect(new Set(review.map((r) => r.reference)).size).toBe(2);
  await vi.waitFor(() => expect(f.api.send).toHaveBeenCalledTimes(2), { timeout: 4000 });
  const phone = JSON.stringify(f.api.send.mock.calls);
  for (const item of review) {
    expect(phone).toContain(item.reference);
    expect(phone).not.toContain(item.content);
    expect(JSON.stringify(f.service.status())).not.toContain(item.content);
  }
  await f.service.unbind();
  expect(f.service.pendingResults()).toEqual([]);
});

it('applies a rapid disable and memory revocation after an enable that has not reached disk', async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.service.credentialsChanged(async () => undefined);
  const first = f.service.configure({ enabled: true, memoryAllowed: true });
  const second = f.service.configure({ enabled: false, memoryAllowed: false });
  await Promise.all([first, second]);
  expect(f.service.status()).toMatchObject({ enabled: false, memoryAllowed: false, connection: 'disabled' });
  expect(f.store.snapshot()).toMatchObject({ enabled: false, memoryAllowed: false });
  expect(f.api.poll).not.toHaveBeenCalled();
});

it('revoking a private scheduled delivery while offline suppresses the result approval card and its fingerprint', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update((s) =>
    Object.assign(s, {
      enabled: true,
      profileId,
      botId: '42',
      tokenConfigured: true,
      binding: { ...owner, displayName: 'Owner' },
    }),
  );
  let offline = true;
  f.api.poll.mockImplementation(async () => {
    if (offline) throw new TelegramApiError('telegram.http503');
    return [];
  });
  await f.service.initialize();
  await vi.waitFor(() => expect(f.service.status().connection).toBe('offline'));
  await f.service.enqueueCron({
    sessionId: owner.sessionId,
    bindingId: owner.bindingId,
    sourceId: randomUUID(),
    content: 'PROTECTED RESULT',
    requiresApproval: true,
  });
  expect(f.service.pendingResults()).toHaveLength(1);
  vi.mocked(f.host.assertDelivery).mockImplementation(() => {
    throw new Error('telegram.cronDeliveryRevoked');
  });
  offline = false;
  await vi.waitFor(() => expect(f.service.status()).toMatchObject({ connection: 'online', pendingOutbox: 0 }), {
    timeout: 4_000,
  });
  expect(f.store.snapshot().approvals).toEqual([]);
  expect(f.store.snapshot().outbox.map((o) => o.status)).toEqual(['discarded', 'discarded']);
  expect(f.api.send).not.toHaveBeenCalled();
});

it('wakes a disconnected poller without changing its token, cursor or binding', async () => {
  const f = await fixture();
  await f.store.initialize();
  await f.store.update(s => Object.assign(s, {
    ...defaultTelegramState(), profileId, tokenConfigured: true, enabled: true, botId: '42',
    binding: { ...owner, displayName: 'Owner' }, offset: 12, lastUpdateAt: Date.now(),
  }));
  let disconnected = true;
  f.api.poll.mockImplementation(async () => {
    if (disconnected) throw new TelegramApiError('telegram.network');
    return [];
  });
  await f.service.initialize();
  await vi.waitFor(() => expect(f.service.canReconnect()).toBe(true));
  disconnected = false;
  expect(f.service.reconnect()).toBe(true);
  await vi.waitFor(() => expect(f.service.status().connection).toBe('online'));
  expect(f.getSecret).toHaveBeenCalledOnce();
  expect(f.service.currentAuthority()).toEqual(owner);
  expect(f.api.send).not.toHaveBeenCalled();
  expect(f.store.snapshot().offset).toBe(12);
});
