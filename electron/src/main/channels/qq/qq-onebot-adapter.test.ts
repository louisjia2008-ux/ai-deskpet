import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { QqResolvedReplyImage } from './qq-channel-service';

import { isLoopbackOneBotUrl, qqChannelStateSchema, defaultQqChannelState } from '../../../shared/qq-channel';
import { QqOneBotAdapter, splitOneBotMessage } from './qq-onebot-adapter';
import type { QqWebSocketLike } from './qq-official-adapter';
import { QqTransportRouter } from './qq-transport-router';
import type { QqOfficialAdapter } from './qq-official-adapter';

class FakeSocket implements QqWebSocketLike {
  readonly sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  closed = false;
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data) as FakeSocket['sent'][number]); }
  close(): void { this.closed = true; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: 'open' | 'message' | 'close' | 'error', event: { data?: unknown } = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  frame(value: unknown): void { this.dispatch('message', { data: JSON.stringify(value) }); }
  reply(index: number, value: unknown): void { const sent = this.sent[index]!;
    this.frame({ status: 'ok', retcode: 0, data: sent.action.startsWith('send_') ? {message_id:index} : null, echo: sent.echo, ...(value as object) }); }
}
const SELF = 2000000001, OWNER = 1000000001;
const image = (): QqResolvedReplyImage => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
  return { base64: bytes.toString('base64'), mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') };
};
const adapters: QqOneBotAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.stop(); vi.useRealTimers(); });
const fixture = () => {
  const sockets: FakeSocket[] = [];
  const adapter = new QqOneBotAdapter({ socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; }, random: () => 0.5 });
  adapters.push(adapter);
  const onMessage = vi.fn(), onConnectionChange = vi.fn();
  const start = () => adapter.start({ url: 'ws://127.0.0.1:3001', token: 'token/1' }, { onMessage, onConnectionChange });
  const online = async () => {
    await start(); const socket = sockets.at(-1)!;
    socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } }); await vi.waitFor(() => expect(onConnectionChange).toHaveBeenCalledWith('online'));
    return socket;
  };
  return { sockets, adapter, start, online, onMessage, onConnectionChange };
};
const friend = (patch: Record<string, unknown> = {}) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: OWNER,
  message_id: 77, time: 1_793_000_000, message: [{ type: 'text', data: { text: ' hello ' } }], raw_message: 'hello', ...patch });

describe('OneBot endpoint', () => {
  it.each(['ws://127.0.0.1:3001', 'ws://localhost:3001/', 'ws://[::1]:3001'])('accepts loopback %s', url => { expect(isLoopbackOneBotUrl(url)).toBe(true); });
  it.each(['ws://192.168.1.2:3001', 'wss://127.0.0.1:3001', 'http://127.0.0.1:3001', 'ws://127.0.0.1', 'ws://evil.example:3001', 'ws://127.0.0.1.evil.example:3001',
    'ws://user:pass@127.0.0.1:3001', 'ws://127.0.0.1:3001/?access_token=x', 'ws://127.0.0.1:3001/api', 'not a url'])('rejects %s', url => { expect(isLoopbackOneBotUrl(url)).toBe(false); });

  it('refuses to connect off-machine or without a token, even if a caller bypasses the schema', async () => {
    const f = fixture();
    await expect(f.adapter.start({ url: 'ws://10.0.0.5:3001', token: 't' }, { onMessage: f.onMessage, onConnectionChange: f.onConnectionChange })).rejects.toThrow('qq.onebotTargetBlocked');
    await expect(f.adapter.start({ url: 'ws://127.0.0.1:3001', token: '' }, { onMessage: f.onMessage, onConnectionChange: f.onConnectionChange })).rejects.toThrow('qq.onebotTargetBlocked');
    expect(f.sockets).toHaveLength(0);
  });

  it('keeps stored state from before this transport existed loadable, defaulting to official', () => {
    const legacy = Object.fromEntries(Object.entries(defaultQqChannelState().config).filter(([key]) => !['transport', 'onebotUrl'].includes(key)));
    expect(qqChannelStateSchema.parse({ ...defaultQqChannelState(), config: legacy }).config).toMatchObject({ transport: 'official', onebotUrl: '' });
  });
});

describe('QqOneBotAdapter', () => {
  it.each(['private', 'group'] as const)('sends a host-resolved managed image to %s using a structured image segment', async destination => {
    const f = fixture(), socket = await f.online(), asset = image(), current = vi.fn();
    const sending = destination === 'private' ? f.adapter.sendImageToUser(String(OWNER), asset, undefined, { signal: new AbortController().signal, assertCurrent: current })
      : f.adapter.sendImageToGroup('77777', asset, undefined, { signal: new AbortController().signal, assertCurrent: current });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ action: destination === 'private' ? 'send_private_msg' : 'send_group_msg', params: {
      ...(destination === 'private' ? { user_id: OWNER } : { group_id: 77777 }), message: [{ type: 'image', data: { file: `base64://${asset.base64}` } }],
    } });
    expect(current).toHaveBeenCalledOnce(); socket.reply(1, {});
    await expect(sending).resolves.toEqual({ ok: true, unknown: false });
  });

  it('rejects image paths, URLs, mismatched hashes and MIME without dispatching', async () => {
    const f = fixture(), socket = await f.online(), asset = image();
    for (const invalid of [{ ...asset, base64: 'file:///private/example.png' }, { ...asset, base64: 'https://example.com/image.png' },
      { ...asset, sha256: '0'.repeat(64) }, { ...asset, mime: 'image/jpeg' as const }]) {
      await expect(f.adapter.sendImageToUser(String(OWNER), invalid)).resolves.toMatchObject({ ok: false, unknown: false, error: 'qq.imageUnavailable' });
    }
    await expect(f.adapter.sendImageToUser(String(OWNER), asset, undefined, { signal: new AbortController().signal, assertCurrent: () => { throw Error('revoked'); } })).resolves.toMatchObject({ ok: false, unknown: false });
    expect(socket.sent).toHaveLength(1);
  });

  it('marks image receipts unknown on disconnect or malformed acknowledgement and never retries', async () => {
    const f = fixture(), socket = await f.online();
    const first = f.adapter.sendImageToUser(String(OWNER), image());
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2)); socket.reply(1, { data: {} });
    await expect(first).resolves.toEqual({ ok: false, unknown: true, error: 'qq.unconfirmedReceipt' });
    const second = f.adapter.sendImageToUser(String(OWNER), image());
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3)); socket.dispatch('close');
    await expect(second).resolves.toEqual({ ok: false, unknown: true, error: 'qq.sendUnknown' });
    expect(socket.sent).toHaveLength(3);
  });

  it('authenticates with an encoded token and is online only after the account answers', async () => {
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    expect(new URL(socket.url).searchParams.get('access_token')).toBe('token/1');
    expect(f.onConnectionChange).not.toHaveBeenCalledWith('online');
    socket.dispatch('open'); expect(socket.sent[0]!.action).toBe('get_login_info');
    socket.reply(0, { data: { user_id: SELF } });
    await vi.waitFor(() => expect(f.onConnectionChange).toHaveBeenCalledWith('online'));
  });

  it('admits a group message only when it mentions this account', async () => {
    const f = fixture(); await f.start(); const socket = await f.online();
    socket.frame(friend({ message_type: 'group', sub_type: 'normal', group_id: 77777, message: [{ type: 'text', data: { text: 'no mention' } }] }));
    socket.frame(friend({ message_type: 'group', sub_type: 'normal', group_id: 77777, message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: 'someone else' } }] }));
    expect(f.onMessage).not.toHaveBeenCalled();
    socket.frame(friend({ message_type: 'group', sub_type: 'normal', group_id: 77777, message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' 查天气 ' } }] }));
    expect(f.onMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '查天气', senderOpenId: String(OWNER), group: { groupId: '77777' } }));
  });

  it('admits friend private text only, from explicit text segments', async () => {
    const f = fixture(), socket = await f.online();
    socket.frame(friend());
    expect(f.onMessage).toHaveBeenCalledTimes(1);
    expect(f.onMessage.mock.calls[0]![0]).toMatchObject({ senderOpenId: String(OWNER), content: 'hello' });
    f.onMessage.mockClear();
    socket.frame(friend({ message_type: 'group', group_id: 1 }));
    socket.frame(friend({ sub_type: 'group' }));
    socket.frame(friend({ user_id: SELF }));
    socket.frame(friend({ post_type: 'message_sent' }));
    socket.frame(friend({ message: [{ type: 'image', data: { url: 'http://x' } }], raw_message: '[CQ:image,url=http://x]' }));
    socket.frame(friend({ message: 'plain [CQ:at,qq=all]' }));
    socket.frame(friend({ user_id: 'not-a-number' }));
    expect(f.onMessage).not.toHaveBeenCalled();
    socket.frame(friend({ message: [{ type: 'text', data: { text: 'a' } }, { type: 'image', data: {} }, { type: 'text', data: { text: 'b' } }] }));
    expect(f.onMessage.mock.calls[0]![0].content).toBe('ab');
  });

  it('ignores messages before the account has identified', async () => {
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.dispatch('open'); socket.frame(friend());
    expect(f.onMessage).not.toHaveBeenCalled();
  });

  it('sends model text as one text segment so CQ codes stay literal', async () => {
    const f = fixture(), socket = await f.online();
    const sending = f.adapter.sendToUser(String(OWNER), '[CQ:at,qq=all] hi');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ action: 'send_private_msg', params: { user_id: OWNER, message: [{ type: 'text', data: { text: '[CQ:at,qq=all] hi' } }] } });
    socket.reply(1, {});
    await expect(sending).resolves.toEqual({ ok: true, unknown: false });
  });

  it('keeps long string IDs distinct when receiving and sending', async () => {
    const f = fixture(), socket = await f.online();
    const id = '9'.repeat(160), user = '8'.repeat(50);
    socket.frame(friend({ message_id: id, user_id: user }));
    socket.frame(friend({ message_id: id + '1', user_id: user }));
    expect(f.onMessage.mock.calls.map(call => call[0].id)).toEqual([`onebot-${id}-1793000000`, `onebot-${id}1-1793000000`]);
    const result = f.adapter.sendToUser(user, 'ack');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]!.params.user_id).toBe(user);
    socket.reply(1, {}); await expect(result).resolves.toMatchObject({ ok: true });
  });

  it('reports a refused send as failed, and a lost connection as unknown', async () => {
    const f = fixture(), socket = await f.online();
    const refused = f.adapter.sendToUser(String(OWNER), 'one');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.frame({ status: 'failed', retcode: 1404, data: null, echo: socket.sent[1]!.echo });
    await expect(refused).resolves.toEqual({ ok: false, unknown: false, error: 'qq.sendRetcode_1404' });
    const lost = f.adapter.sendToUser(String(OWNER), 'two');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    socket.dispatch('close');
    await expect(lost).resolves.toEqual({ ok: false, unknown: true, error: 'qq.sendUnknown' });
  });

  it('treats a success envelope with no send message_id as unknown', async () => {
    const f = fixture(), socket=await f.online();
    const send=f.adapter.sendToUser(String(OWNER),'notice');
    socket.reply(1,{data:{}});
    await expect(send).resolves.toEqual({ok:false,unknown:true,error:'qq.unconfirmedReceipt'});
  });

  it('blocks sends while offline, to an invalid recipient and after revocation', async () => {
    const f = fixture(); await f.start();
    await expect(f.adapter.sendToUser(String(OWNER), 'x')).resolves.toMatchObject({ ok: false, unknown: false });
    const socket = f.sockets[0]!; socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } });
    await vi.waitFor(() => expect(f.onConnectionChange).toHaveBeenCalledWith('online'));
    await expect(f.adapter.sendToUser('openid-abc', 'x')).resolves.toMatchObject({ ok: false, unknown: false });
    await expect(f.adapter.sendToUser(String(OWNER), 'x', undefined, { signal: AbortSignal.abort(), assertCurrent: () => undefined })).resolves.toMatchObject({ ok: false, unknown: false });
    expect(socket.sent).toHaveLength(1);
  });

  it('sends ordinary short paragraphs as distinct text actions and preserves a host notice as one action', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } }); await vi.advanceTimersByTimeAsync(0);
    const text = '先帮你看了。\n\n明天下午记得带伞。';
    const sending = f.adapter.sendToGroup(String(OWNER), text, 'source');
    expect(socket.sent[1]?.params.message).toEqual([{type:'text', data:{text:'先帮你看了。\n\n'}}]);
    socket.reply(1, {}); await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sent[2]?.params.message).toEqual([{type:'text', data:{text:'明天下午记得带伞。'}}]);
    socket.reply(2, {}); await expect(sending).resolves.toEqual({ok:true,unknown:false});
    const single = f.adapter.sendToUser(String(OWNER), text, undefined, {
      signal:new AbortController().signal, assertCurrent:()=>undefined, singleBubble:true,
    });
    expect(socket.sent[3]?.params.message).toEqual([{type:'text', data:{text}}]);
    socket.reply(3, {}); await expect(single).resolves.toEqual({ok:true,unknown:false});
  });

  it('splits long replies in order, and a partial failure is never retried', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } }); await vi.advanceTimersByTimeAsync(0);
    const sending = f.adapter.sendToUser(String(OWNER), 'x'.repeat(4_500));
    await vi.advanceTimersByTimeAsync(0); socket.reply(1, {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sent).toHaveLength(3);
    socket.frame({ status: 'failed', retcode: 1200, data: null, echo: socket.sent[2]!.echo });
    await expect(sending).resolves.toEqual({ ok: false, unknown: true, error: 'qq.sendPartial' });
    expect(splitOneBotMessage('a\n'.repeat(1_500)).every(chunk => chunk.endsWith('\n') && chunk.length <= 2_000)).toBe(true);
    expect(splitOneBotMessage('😀'.repeat(2_001))).toEqual(['😀'.repeat(2_000), '😀']);
    expect(splitOneBotMessage('a'.repeat(2_000) + 'b'.repeat(10)).join('')).toBe('a'.repeat(2_000) + 'b'.repeat(10));
  });

  it('stops on a rejected token, and keeps retrying a missing NapCat without a limit', async () => {
    vi.useFakeTimers();
    const rejected = fixture(); await rejected.start();
    rejected.sockets[0]!.frame({ status: 'failed', retcode: 1403, data: null, message: 'token验证失败' });
    expect(rejected.adapter.lastError).toBe('qq.onebotAuthFailed');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(rejected.sockets).toHaveLength(1);

    const missing = fixture(); await missing.start();
    for (let attempt = 0; attempt < 20; attempt++) { missing.sockets.at(-1)!.dispatch('error'); await vi.advanceTimersByTimeAsync(40_000); }
    expect(missing.sockets.length).toBeGreaterThan(20);
    expect(missing.adapter.lastError).toBe('qq.socketError');
  });

  it('follows account status from the probe, and reconnects when the probe goes unanswered', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    socket.reply(1, { data: { online: false, good: true } }); await vi.advanceTimersByTimeAsync(0);
    expect(f.adapter.lastError).toBe('qq.accountOffline');
    await expect(f.adapter.sendToUser(String(OWNER), 'x')).resolves.toMatchObject({ ok: false, unknown: false });
    socket.frame(friend()); expect(f.onMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    socket.reply(2, { data: { online: true, good: true } }); await vi.advanceTimersByTimeAsync(0);
    expect(f.adapter.lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000 + 20_000);
    expect(socket.closed).toBe(true); expect(f.adapter.lastError).toBe('qq.heartbeatTimeout');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.sockets).toHaveLength(2);
  });

  it('stop closes the socket, cancels reconnects and silences late frames', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.dispatch('open'); socket.reply(0, { data: { user_id: SELF } }); await vi.advanceTimersByTimeAsync(0);
    f.adapter.stop(); f.onConnectionChange.mockClear();
    expect(socket.closed).toBe(true);
    socket.frame(friend()); socket.dispatch('close');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.onMessage).not.toHaveBeenCalled(); expect(f.sockets).toHaveLength(1); expect(f.onConnectionChange).not.toHaveBeenCalled();
  });
});

describe('QqTransportRouter', () => {
  const official = () => ({ start: vi.fn(async () => undefined), stop: vi.fn(), sendToUser: vi.fn(async () => ({ ok: true, unknown: false })),
    sendImageToUser: vi.fn(async () => ({ ok: true, unknown: false })), sendImageToGroup: vi.fn(async () => ({ ok: true, unknown: false })), lastError: 'qq.authFailed' });
  const events = { onMessage: vi.fn(), onConnectionChange: vi.fn() };
  const credentials = { appId: 'app', onebotUrl: 'ws://127.0.0.1:3001', secret: 's' };

  it('gives the official adapter only its own credentials and revokes both transports', async () => {
    const live = official(), f = fixture(), router = new QqTransportRouter(live as unknown as QqOfficialAdapter, f.adapter);
    await router.start({ transport: 'official', ...credentials }, events);
    expect(live.start).toHaveBeenCalledWith({ appId: 'app', secret: 's' }, events);
    expect(f.sockets).toHaveLength(0); expect(router.lastError).toBe('qq.authFailed');
    const asset = image(), controls = { signal: new AbortController().signal, assertCurrent: vi.fn() };
    await expect(router.sendImageToUser('openid', asset, 'private-reply', controls)).resolves.toEqual({ ok: true, unknown: false });
    await expect(router.sendImageToGroup('group-openid', asset, 'group-reply', controls)).resolves.toEqual({ ok: true, unknown: false });
    expect(live.sendImageToUser).toHaveBeenCalledExactlyOnceWith('openid', asset, 'private-reply', controls);
    expect(live.sendImageToGroup).toHaveBeenCalledExactlyOnceWith('group-openid', asset, 'group-reply', controls);
    await router.sendToUser('openid', 'x'); expect(live.sendToUser).toHaveBeenCalledOnce();
    router.stop();
    await expect(router.sendToUser('openid', 'x')).resolves.toEqual({ ok: false, unknown: false, error: 'qq.sendBlocked' });
    await expect(router.sendImageToUser('openid', asset)).resolves.toEqual({ ok: false, unknown: false, error: 'qq.sendBlocked' });
    expect(live.sendToUser).toHaveBeenCalledOnce();
  });

  it('switching to OneBot stops the official adapter and never hands it the token', async () => {
    const live = official(), f = fixture(), router = new QqTransportRouter(live as unknown as QqOfficialAdapter, f.adapter);
    await router.start({ transport: 'onebot', ...credentials }, events);
    expect(live.start).not.toHaveBeenCalled(); expect(live.stop).toHaveBeenCalled();
    expect(f.sockets).toHaveLength(1);
    router.stop(); expect(f.sockets[0]!.closed).toBe(true);
  });
});
