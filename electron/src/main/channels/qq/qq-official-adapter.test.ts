import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QqResolvedReplyImage } from './qq-channel-service';
import { OFFICIAL_QQ_MAX_IMAGE_BYTES, QQ_INTENT_C2C_GROUP_AT_MESSAGES, QqOfficialAdapter, supportsOfficialQqImage } from './qq-official-adapter';
import type { QqHttpJson, QqWebSocketLike } from './qq-official-adapter';

class FakeSocket implements QqWebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: 'open' | 'message' | 'close' | 'error', event: { data?: unknown } = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  frame(value: unknown): void { this.dispatch('message', { data: JSON.stringify(value) }); }
}
const ok = (json: unknown) => ({ status: 200, json });
const adapters: QqOfficialAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.stop(); vi.useRealTimers(); });
const fixture = (http?: QqHttpJson) => {
  const sockets: FakeSocket[] = [];
  const posts: string[] = [], urls: string[] = [];
  const transport: QqHttpJson = http ?? (async (url, init) => {
    if (url === 'https://bots.qq.com/app/getAppAccessToken') return ok({ access_token: 'token-1', expires_in: '7200' });
    if (url.endsWith('/gateway')) return ok({ url: 'wss://api.bot.qq.com/websocket/' });
    urls.push(url); posts.push(init.body!); return ok({ id: String(posts.length) });
  });
  const adapter = new QqOfficialAdapter({ socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; }, http: transport, random: () => 0.5 });
  adapters.push(adapter);
  const onMessage = vi.fn(), onConnectionChange = vi.fn();
  const start = () => adapter.start({ appId: 'app-1', secret: 'secret-1' }, { onMessage, onConnectionChange });
  const hello = async (socket = sockets.at(-1)!) => {
    socket.frame({ op: 10, d: { heartbeat_interval: 45_000 } }); await Promise.resolve(); await Promise.resolve();
  };
  const ready = async () => { await hello(); sockets.at(-1)!.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }); };
  return { sockets, posts, urls, adapter, start, hello, ready, onMessage, onConnectionChange };
};

const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGOw6bnznxLMMGrAqAGjBgwXAwAf1qMf4q4HQgAAAABJRU5ErkJggg==', 'base64');
const imageFixture = (bytes = pngBytes, mime: QqResolvedReplyImage['mime'] = 'image/png'): QqResolvedReplyImage => ({
  base64: bytes.toString('base64'), mime, sha256: createHash('sha256').update(bytes).digest('hex'),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const mediaFixture = (reply?: QqHttpJson) => {
  const requests: Array<{ url: string; init: Parameters<QqHttpJson>[1]; body: unknown }> = [];
  const f = fixture(async (url, init) => {
    if (url.endsWith('/app/getAppAccessToken')) {
      const { appId } = JSON.parse(init.body!) as { appId: string };
      return ok({ access_token: `token-${appId}`, expires_in: 7200 });
    }
    if (url.endsWith('/gateway')) return ok({ url: 'wss://api.bot.qq.com/ws' });
    requests.push({ url, init, body: JSON.parse(init.body!) });
    return reply ? reply(url, init) : ok(url.endsWith('/files') ? { file_info: 'opaque-media-reference', ttl: 300 } : { id: 'outbound-message' });
  });
  return { ...f, requests };
};

describe('QQ official adapter', () => {
  it('uses the official v2 Identify format and reviewed C2C intent', async () => {
    const f = fixture(); await f.start();
    f.sockets[0]!.frame({ op: 10, d: { heartbeat_interval: 45_000 } });
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.parse(f.sockets[0]!.sent[0]!)).toMatchObject({ op: 2, d: { token: 'QQBot token-1', intents: QQ_INTENT_C2C_GROUP_AT_MESSAGES } });
    f.sockets[0]!.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } });
    expect(f.onConnectionChange).toHaveBeenLastCalledWith('online');
  });

  it('reads the sender from user_openid and reports a private message it cannot read', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'real', content: '/pair 123456', author: { user_openid: 'real-sender' } } });
    expect(f.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'real', senderOpenId: 'real-sender', content: '/pair 123456' }));
    expect(f.adapter.lastError).toBeNull();
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'other', content: 'hi', author: { openid: 'not-the-documented-field' } } });
    expect(f.onMessage).toHaveBeenCalledOnce();
    expect(f.adapter.lastError).toBe('qq.messageUnreadable');
  });

  it('reads a group mention, removes mention markers, and replies to the group endpoint', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: { id: 'g1', content: ' <@!123> 查天气 ', group_openid: 'GROUP', author: { member_openid: 'MEMBER' } } });
    expect(f.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'g1', senderOpenId: 'MEMBER', content: '查天气', group: { groupId: 'GROUP' } }));
    await f.adapter.sendToGroup('GROUP', '晴', 'g1');
    expect(f.urls.at(-1)).toContain('/v2/groups/GROUP/messages');
    expect(JSON.parse(f.posts.at(-1)!)).toMatchObject({ content: '晴', msg_id: 'g1' });
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: { id: 'g2', content: 'hi', group_openid: 'GROUP', author: { user_openid: 'wrong-field' } } });
    expect(f.onMessage).toHaveBeenCalledOnce();
    expect(f.adapter.lastError).toBe('qq.messageUnreadable');
  });

  it('accepts a long message id and names the field when a message cannot be read', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    const message = { content: '/pair 123456', group_openid: 'G', author: { member_openid: 'M' } };
    const id = `ROBOT1.0_${'x'.repeat(1200)}`;
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: { ...message, id } });
    expect(f.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id, content: '/pair 123456' }));
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: { ...message, id: '' } });
    expect(f.adapter.gatewayEvents.find(event => event.type === 'GROUP_AT_MESSAGE_CREATE')?.lastDrop).toBe('unreadable id:len0');
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 4, d: { ...message, id: 'z', author: { id: 'not-the-field' } } });
    expect(f.adapter.gatewayEvents.find(event => event.type === 'GROUP_AT_MESSAGE_CREATE')?.lastDrop).toBe('unreadable member_openid:undefined');
    expect(f.onMessage).toHaveBeenCalledOnce();
  });

  it('delivers a message with a lower sequence, and catches a replay by its id', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 9, d: { id: 'private', content: '你好', author: { user_openid: 'owner' } } });
    const group = { id: 'group', content: '/pair 123456', group_openid: 'G', author: { member_openid: 'M' } };
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: group });
    expect(f.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'group', group: { groupId: 'G' } }));
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: group });
    expect(f.onMessage).toHaveBeenCalledTimes(2);
    expect(f.adapter.gatewayEvents.find(event => event.type === 'GROUP_AT_MESSAGE_CREATE')).toMatchObject({ count: 2, delivered: 1, lowSequence: 2, lastDrop: 'duplicate' });
    socket.frame({ op: 1 }); expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: 9 });
  });

  it('lists event names and counts for diagnosis, without message content', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    socket.frame({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'a', content: 'private words', group_openid: 'G', author: { member_openid: 'M' } } });
    socket.frame({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 3, d: { id: 'b', content: 'private words', group_openid: 'G', author: { member_openid: 'M' } } });
    socket.frame({ op: 0, t: 'not a name', s: 4, d: {} });
    expect(f.adapter.gatewayEvents.find(event => event.type === 'GROUP_MESSAGE_CREATE')?.count).toBe(2);
    expect(f.adapter.gatewayEvents.some(event => event.type === 'not a name')).toBe(false);
    expect(JSON.stringify(f.adapter.gatewayEvents)).not.toContain('private words');
  });

  it('reads only mentions of this bot when QQ sends all group messages', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    const message = { group_openid: 'GROUP', author: { member_openid: 'MEMBER' } };
    socket.frame({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { ...message, id: 'plain', content: '大家好' } });
    socket.frame({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 3, d: { ...message, id: 'other', content: '<@someone> 你好', mentions: [{ is_you: false }] } });
    expect(f.onMessage).not.toHaveBeenCalled(); expect(f.adapter.lastError).toBeNull();
    socket.frame({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 4, d: { ...message, id: 'mine', content: '<@bot>\u200B /pair 123456', mentions: [{ is_you: true }] } });
    expect(f.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'mine', content: '/pair 123456', group: { groupId: 'GROUP' } }));
  });

  it('accepts bounded private messages, rejects group events, nulls and oversized payloads', async () => {
    const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    const data = { id: 'm1', content: '  你好  ', author: { user_openid: 'owner' }, timestamp: '2026-11-02T09:00:00+08:00' };
    socket.frame(null); socket.frame([]); socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE' });
    socket.dispatch('message', { data: 'not json' });
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: data });
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { ...data, content: 'x'.repeat(8_001) } });
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { ...data, id: 'x'.repeat(129) } });
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', d: null });
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: data });
    expect(f.onMessage).toHaveBeenCalledExactlyOnceWith({ id: 'm1', senderOpenId: 'owner', content: '你好', timestamp: data.timestamp });
  });

  it.each(['ws://api.bot.qq.com/ws', 'wss://evil.test/ws', 'wss://api.bot.qq.com.evil.test/ws', 'wss://user:secret@api.bot.qq.com/ws', 'wss://api.bot.qq.com:8443/ws'])('blocks unreviewed gateway target %s', async target => {
    const f = fixture(async url => url.endsWith('/gateway') ? ok({ url: target }) : ok({ access_token: 't', expires_in: '7200' }));
    await expect(f.start()).rejects.toThrow('qq.gatewayTargetBlocked'); expect(f.sockets).toEqual([]);
  });

  it('does not reconnect after stop while gateway discovery is in flight', async () => {
    let finish!: (value: { status: number; json: unknown }) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<{ status: number; json: unknown }>(resolve => { finish = resolve; });
    const f = fixture(async url => {
      if (url.endsWith('/gateway')) { entered(); return waiting; }
      return ok({ access_token: 't', expires_in: '7200' });
    });
    const start = f.start(); await started; f.adapter.stop();
    finish(ok({ url: 'wss://api.bot.qq.com/ws' })); await start;
    expect(f.sockets).toEqual([]);
  });

  it('ignores old socket callbacks after credential rotation', async () => {
    const tokens: string[] = [];
    const f = fixture(async (url, init) => {
      if (url.endsWith('/gateway')) return ok({ url: 'wss://api.bot.qq.com/ws' });
      const appId = (JSON.parse(init.body!) as { appId: string }).appId; tokens.push(appId);
      return ok({ access_token: `token-${appId}`, expires_in: 7200 });
    });
    await f.start(); const old = f.sockets[0]!;
    await f.adapter.start({ appId: 'app-2', secret: 'secret-2' }, { onMessage: f.onMessage, onConnectionChange: f.onConnectionChange });
    old.frame({ op: 0, t: 'READY' }); old.dispatch('close');
    f.sockets[1]!.frame({ op: 10, d: { heartbeat_interval: 45_000 } });
    await Promise.resolve(); await Promise.resolve();
    expect(tokens).toEqual(['app-1', 'app-2']);
    expect(f.adapter.connection).toBe('connecting');
    expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({ d: { token: 'QQBot token-app-2' } });
  });

  it('rechecks host disclosure after token acquisition and before POST', async () => {
    const f = fixture(); await f.start(); let checks = 0;
    const result = await f.adapter.sendToUser('owner', 'hello', 'm1', { signal: new AbortController().signal, assertCurrent: () => { if (++checks > 1) throw new Error('privacy changed'); } });
    expect(result).toMatchObject({ ok: false, unknown: false }); expect(f.posts).toEqual([]);
  });

  it('sends separate bubbles with the same msg_id, including earlier control replies in the private quota', async () => {
    const f = fixture();
    await f.start();
    const source = ['第一段。', '第二段。', '第三段。', '第四段。', '第五段。'].join('\n\n');
    const controls = { signal: new AbortController().signal, assertCurrent: () => undefined, singleBubble: true };
    await f.adapter.sendToUser('owner', '确认摘要\n\n请核对', 'incoming', controls);
    expect(await f.adapter.sendToUser('owner', source, 'incoming')).toEqual({ ok: true, unknown: false });
    const posts = f.posts.map(body => JSON.parse(body) as {content: string; msg_seq: number; msg_id: string});
    expect(posts.map(p => p.msg_id)).toEqual(Array(4).fill('incoming'));
    expect(posts.map(p => p.msg_seq)).toEqual([1, 2, 3, 4]);
    expect(posts[0]!.content).toBe('确认摘要\n\n请核对');
    expect(posts.slice(1).map(p => p.content).join('')).toBe(source);
    expect(await f.adapter.sendToUser('owner', '额外', 'incoming')).toEqual({ok:false, unknown:false, error:'qq.replyLimit'});
    expect(f.posts).toHaveLength(4);
    await f.adapter.sendToGroup('group', source, 'incoming');
    const group = f.posts.slice(4).map(body => JSON.parse(body) as {content:string});
    expect(group).toHaveLength(5);
    expect(group.map(p => p.content).join('')).toBe(source);
  });

  it('rechecks authority for every bubble and never marks a partially posted reply safe to replay', async () => {
    const f = fixture();
    await f.start();
    const controls = { signal: new AbortController().signal, assertCurrent: () => {
      if (f.posts.length) throw Error('revoked after the first POST');
    }};
    const result = await f.adapter.sendToUser('owner','第一段。\n\n第二段。','source',controls);
    expect(f.posts).toHaveLength(1);
    expect(result).toEqual({ok:false,unknown:true,error:'qq.sendPartial'});
  });

  it('requires an official message receipt and classifies proactive permission errors without exposing their body', async () => {
    let response = ok({});
    const f = fixture(async url => {
      if (url.endsWith('/gateway')) return ok({url:'wss://api.bot.qq.com/ws'});
      if (url.endsWith('/app/getAppAccessToken')) return ok({access_token:'fixture',expires_in:7200});
      return response;
    });
    await f.start();
    expect(await f.adapter.sendToUser('owner','notice')).toEqual({ok:false,unknown:true,error:'qq.unconfirmedReceipt'});
    response = {status:403, json:{code:40034105,message:'untrusted upstream text'}};
    expect(await f.adapter.sendToUser('owner','notice')).toEqual({ok:false,unknown:false,error:'qq.proactivePermission'});
    response = ok({id:'message-id'.repeat(100)});
    expect(await f.adapter.sendToUser('owner','notice')).toEqual({ok:true,unknown:false});
  });

  it('distinguishes platform rejects from unknown POST outcomes and pre-send auth errors', async () => {
    let fail = false;
    const f = fixture(async url => {
      if (url.endsWith('/gateway')) return ok({ url: 'wss://api.bot.qq.com/ws' });
      if (url === 'https://bots.qq.com/app/getAppAccessToken') return ok({ access_token: 't', expires_in: '7200' });
      if (fail) throw new Error('connection lost'); return { status: 429, json: {} };
    });
    await f.start(); expect(await f.adapter.sendToUser('owner', 'hello')).toMatchObject({ ok: false, unknown: false });
    fail = true; expect(await f.adapter.sendToUser('owner', 'hello')).toMatchObject({ ok: false, unknown: true });
    f.adapter.stop(); expect(await f.adapter.sendToUser('owner', 'hello')).toMatchObject({ ok: false, unknown: false });
  });

  it('uses the last sequence for heartbeat and reconnects if ACK is missing', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.frame({ op: 10, d: { heartbeat_interval: 1_000 } });
    await Promise.resolve(); await Promise.resolve();
    socket.frame({ op: 0, t: 'READY', s: 42, d: { session_id: 'session-1' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: 42 });
    await vi.advanceTimersByTimeAsync(1_000); expect(socket.closed).toBe(true);
  });

  it('resumes the captured session/sequence and accepts replay dispatches before RESUMED', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); await f.ready();
    const first = f.sockets[0]!;
    first.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'live', content: 'live', author: { user_openid: 'owner' } } });
    first.dispatch('close'); expect(f.adapter.connection).toBe('offline');
    await vi.advanceTimersByTimeAsync(999); expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.sockets).toHaveLength(2);
    const resumed = f.sockets[1]!; await f.hello(resumed);
    expect(JSON.parse(resumed.sent[0]!)).toEqual({ op: 6, d: { token: 'QQBot token-1', session_id: 'session-1', seq: 3 } });
    const data = { id: 'replay', content: 'replay', author: { user_openid: 'owner' } };
    resumed.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: data }); // consumed sequence
    resumed.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 4, d: data });
    expect(f.onMessage).toHaveBeenCalledTimes(2); expect(f.adapter.connection).toBe('connecting');
    resumed.frame({ op: 0, t: 'RESUMED', s: 4, d: '' }); expect(f.adapter.connection).toBe('online');
    resumed.frame({ op: 1 }); expect(JSON.parse(resumed.sent.at(-1)!)).toEqual({ op: 1, d: 4 });
    first.frame({ op: 9 }); first.dispatch('close'); expect(resumed.closed).toBe(false);
  });

  it('discards an invalid session and identifies afresh without reusing the old sequence', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); await f.ready();
    f.sockets[0]!.frame({ op: 9, d: false }); await vi.advanceTimersByTimeAsync(1_000);
    const socket = f.sockets[1]!; await f.hello(socket);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ op: 2, d: { token: 'QQBot token-1' } });
    socket.frame({ op: 1 }); expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: null });
  });

  it('bounds exponential backoff and stops after eight consecutive retries instead of spinning', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start();
    for (let n = 0; n < 8; n++) {
      const socket = f.sockets.at(-1)!; socket.dispatch('error'); socket.dispatch('close');
      const delay = Math.min(30_000, 1000 * 2 ** n);
      await vi.advanceTimersByTimeAsync(delay - 1); expect(f.sockets).toHaveLength(n + 1);
      await vi.advanceTimersByTimeAsync(1); expect(f.sockets).toHaveLength(n + 2);
    }
    f.sockets.at(-1)!.dispatch('close'); expect(f.adapter.lastError).toBe('qq.reconnectExhausted');
    await vi.advanceTimersByTimeAsync(120_000); expect(f.sockets).toHaveLength(9); expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transient gateway discovery failures but does not retry rejected credentials or targets', async () => {
    vi.useFakeTimers(); let gateways = 0;
    const f = fixture(async url => url.endsWith('/gateway') ? (++gateways === 1 ? { status: 503, json: {} } : ok({ url: 'wss://api.bot.qq.com/ws' }))
      : ok({ access_token: 'token', expires_in: 7200 }));
    await expect(f.start()).rejects.toThrow('qq.gatewayUnavailable'); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.sockets).toHaveLength(1); f.adapter.stop();
    const rejected = fixture(async () => ({ status: 401, json: {} }));
    await expect(rejected.start()).rejects.toThrow('qq.authFailed'); await vi.advanceTimersByTimeAsync(120_000);
    expect(rejected.sockets).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('times out missing handshakes, rejects unauthenticated/invalid dispatches and cancels pending reconnect on stop', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); const socket = f.sockets[0]!;
    socket.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'unsolicited' } });
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'early', content: 'early', author: { user_openid: 'owner' } } });
    socket.frame({ op: 10, d: { heartbeat_interval: 1 } });
    expect(f.onMessage).not.toHaveBeenCalled(); expect(f.adapter.connection).toBe('connecting');
    await vi.advanceTimersByTimeAsync(15_000); expect(socket.closed).toBe(true); expect(f.adapter.lastError).toBe('qq.handshakeTimeout');
    f.adapter.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(f.sockets).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps ACKs and stable connections alive without reconnecting', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); await f.ready(); const socket = f.sockets[0]!;
    for (let n = 0; n < 3; n++) { await vi.advanceTimersByTimeAsync(45_000); socket.frame({ op: 11 }); }
    expect(socket.closed).toBe(false); expect(f.sockets).toHaveLength(1); expect(f.adapter.connection).toBe('online');
    socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: -1, d: { id: 'invalid', content: 'bad', author: { user_openid: 'owner' } } });
    expect(f.onMessage).not.toHaveBeenCalled();
  });
});

describe('QQ official image transport', () => {
  it.each(['users', 'groups'] as const)('uploads and then sends a typed passive image reply to %s using the text sequence', async scope => {
    const f = mediaFixture(); await f.start();
    const recipient = 'target/opaque?#id', source = 'inbound-message', image = imageFixture();
    const sendText = scope === 'users' ? f.adapter.sendToUser.bind(f.adapter) : f.adapter.sendToGroup.bind(f.adapter);
    const sendImage = scope === 'users' ? f.adapter.sendImageToUser.bind(f.adapter) : f.adapter.sendImageToGroup.bind(f.adapter);
    const controls = { signal: new AbortController().signal, assertCurrent: vi.fn() };
    await expect(sendText(recipient, '收到。', source)).resolves.toEqual({ ok: true, unknown: false });
    await expect(sendImage(recipient, image, source, controls)).resolves.toEqual({ ok: true, unknown: false });
    const base = `https://api.sgroup.qq.com/v2/${scope}/${encodeURIComponent(recipient)}`;
    expect(f.requests.map(request => request.url)).toEqual([`${base}/messages`, `${base}/files`, `${base}/messages`]);
    expect(f.requests.every(request => request.init.method === 'POST' && request.init.headers.authorization === 'QQBot token-app-1')).toBe(true);
    expect(f.requests.map(request => request.body)).toEqual([
      { content: '收到。', msg_type: 0, msg_seq: 1, msg_id: source },
      { file_type: 1, file_name: 'deskpet-image.png', file_data: image.base64, srv_send_msg: false },
      { msg_type: 7, media: { file_info: 'opaque-media-reference' }, msg_seq: 2, msg_id: source },
    ]);
    expect(f.requests[1]!.init.signal).toBe(f.requests[2]!.init.signal);
    expect(controls.assertCurrent).toHaveBeenCalled();
  });

  it('sends a single proactive private image without fabricating an inbound message ID', async () => {
    const f = mediaFixture(); await f.start();
    await expect(f.adapter.sendImageToUser('owner', imageFixture())).resolves.toEqual({ ok: true, unknown: false });
    expect(f.requests.map(request => request.url)).toEqual([
      'https://api.sgroup.qq.com/v2/users/owner/files', 'https://api.sgroup.qq.com/v2/users/owner/messages',
    ]);
    expect(f.requests[1]!.body).toEqual({ msg_type: 7, media: { file_info: 'opaque-media-reference' }, msg_seq: 1 });
  });

  it('rejects unsupported format, bad digest, invalid or noncanonical Base64, oversized bytes and path identities before upload', async () => {
    const f = mediaFixture(); await f.start();
    const image = imageFixture();
    const large = Buffer.alloc(OFFICIAL_QQ_MAX_IMAGE_BYTES + 1); pngBytes.copy(large);
    const noncanonical = 'iVBORw0KGgp=';
    const bad = [
      { ...image, mime: 'image/jpeg' as const }, imageFixture(Buffer.from('GIF89a'), 'image/gif'),
      { ...image, sha256: 'f'.repeat(64) }, { ...image, base64: 'file:///tmp/image.png' },
      { ...imageFixture(Buffer.from(noncanonical, 'base64')), base64: noncanonical }, imageFixture(large),
    ];
    for (const asset of bad) {
      await expect(f.adapter.sendImageToUser('owner', asset)).resolves.toEqual({ ok: false, unknown: false, error: 'qq.imageUnavailable' });
    }
    await expect(f.adapter.sendImageToUser('..', image)).resolves.toMatchObject({ ok: false, unknown: false });
    await expect(f.adapter.sendImageToUser('owner', image, '')).resolves.toMatchObject({ ok: false, unknown: false });
    expect(supportsOfficialQqImage('image/jpeg', OFFICIAL_QQ_MAX_IMAGE_BYTES)).toBe(true);
    expect(supportsOfficialQqImage('image/png', OFFICIAL_QQ_MAX_IMAGE_BYTES + 1)).toBe(false);
    expect(supportsOfficialQqImage('image/png', 0)).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it.each(['authority', 'abort', 'credential rotation'] as const)('blocks the message POST if %s changes during upload', async mode => {
    const entered = deferred<void>(), upload = deferred<Awaited<ReturnType<QqHttpJson>>>();
    const f = mediaFixture(async () => { entered.resolve(); return upload.promise; });
    await f.start();
    let allowed = true;
    const controller = new AbortController();
    const pending = f.adapter.sendImageToUser('owner', imageFixture(), 'incoming', {
      signal: controller.signal, assertCurrent: () => { if (!allowed) throw Error('permission changed'); },
    });
    await entered.promise;
    if (mode === 'authority') allowed = false;
    if (mode === 'abort') controller.abort();
    if (mode === 'credential rotation') await f.adapter.start({ appId: 'app-2', secret: 'secret-2' }, f);
    upload.resolve(ok({ file_info: 'uploaded-but-not-sent' }));
    await expect(pending).resolves.toEqual({ ok: false, unknown: false, error: 'qq.sendBlocked' });
    expect(f.requests.map(request => request.url)).toEqual(['https://api.sgroup.qq.com/v2/users/owner/files']);
    expect(f.requests[0]!.init.headers.authorization).toBe('QQBot token-app-1');
  });

  it('treats malformed, rejected and lost upload replies as failures without any message attempt', async () => {
    const failures = [ok(null), ok({ file_info: ' ' }), ok({ file_info: 'contradictory', err_code: 850019 }), { status: 503, json: {} }];
    const f = mediaFixture(async () => {
      const response = failures.shift(); if (!response) throw Error('upload connection lost');
      return response;
    });
    await f.start();
    for (let i = 0; i < 5; i++) {
      await expect(f.adapter.sendImageToGroup('group', imageFixture(), 'incoming')).resolves.toEqual({ ok: false, unknown: false, error: 'qq.imageUploadFailed' });
    }
    expect(f.requests.map(request => request.url)).toEqual(Array(5).fill('https://api.sgroup.qq.com/v2/groups/group/files'));
  });

  it('marks ambiguous final sends unknown and classifies explicit official refusal without exposing its body', async () => {
    const responses = [ok({}), ok({ id: 42 }), ok({ id: 'contradictory', err_code: 12345 }),
      { status: 503, json: {} }, { status: 408, json: {} }, ok({ err_code: 40034105, message: 'not for local logs' })];
    const f = mediaFixture(async url => {
      if (url.endsWith('/files')) return ok({ file_info: 'media' });
      const response = responses.shift(); if (!response) throw Error('send connection lost');
      return response;
    });
    await f.start();
    for (const error of ['qq.unconfirmedReceipt', 'qq.unconfirmedReceipt', 'qq.unconfirmedReceipt', 'qq.sendHttp_503', 'qq.sendHttp_408']) {
      await expect(f.adapter.sendImageToUser('owner', imageFixture())).resolves.toEqual({ ok: false, unknown: true, error });
    }
    await expect(f.adapter.sendImageToUser('owner', imageFixture())).resolves.toEqual({ ok: false, unknown: false, error: 'qq.proactivePermission' });
    await expect(f.adapter.sendImageToUser('owner', imageFixture())).resolves.toEqual({ ok: false, unknown: true, error: 'qq.sendUnknown' });
    expect(f.requests.filter(request => request.url.endsWith('/messages'))).toHaveLength(7);
    expect(f.requests.filter(request => request.url.endsWith('/files'))).toHaveLength(7);
  });

  it('rechecks the shared private reply quota after upload while text is being sent', async () => {
    const entered = deferred<void>(), upload = deferred<Awaited<ReturnType<QqHttpJson>>>();
    const f = mediaFixture(async url => {
      if (!url.endsWith('/files')) return ok({ id: 'text-receipt' });
      entered.resolve(); return upload.promise;
    });
    await f.start();
    const sending = f.adapter.sendImageToUser('owner', imageFixture(), 'incoming');
    await entered.promise;
    await expect(f.adapter.sendToUser('owner', '一。\n\n二。\n\n三。\n\n四。', 'incoming')).resolves.toEqual({ ok: true, unknown: false });
    upload.resolve(ok({ file_info: 'image-uploaded-after-quota-spent' }));
    await expect(sending).resolves.toEqual({ ok: false, unknown: false, error: 'qq.replyLimit' });
    expect(f.requests).toHaveLength(5);
    expect(f.requests.slice(1).map(request => request.body)).toEqual(['一。\n\n', '二。\n\n', '三。\n\n', '四。'].map((content, index) => ({
      content, msg_type: 0, msg_seq: index + 1, msg_id: 'incoming',
    })));
  });

  it('preserves the full multi-paragraph text and one reply slot for a linked image', async () => {
    const f = mediaFixture(); await f.start();
    const source = '一。\n\n二。\n\n三。\n\n四。\n\n五。';
    const controls = { signal: new AbortController().signal, assertCurrent: () => undefined, reserveImageReply: true };
    await expect(f.adapter.sendToUser('owner', source, 'incoming', controls)).resolves.toEqual({ ok: true, unknown: false });
    expect(f.requests).toHaveLength(3);
    expect(f.requests.map(request => (request.body as { content: string }).content).join('')).toBe(source);
    await expect(f.adapter.sendImageToUser('owner', imageFixture(), 'incoming')).resolves.toEqual({ ok: true, unknown: false });
    expect(f.requests.at(-1)?.body).toMatchObject({ msg_type: 7, msg_seq: 4, msg_id: 'incoming' });

    await f.adapter.sendToUser('owner', '一。\n\n二。\n\n三。', 'last-slot');
    await expect(f.adapter.sendToUser('owner', source, 'last-slot', controls)).resolves.toEqual({ ok: true, unknown: false });
    expect(f.requests.at(-1)?.body).toMatchObject({ content: source, msg_type: 0, msg_id: 'last-slot' });
    const count = f.requests.length;
    await expect(f.adapter.sendImageToUser('owner', imageFixture(), 'last-slot')).resolves.toEqual({ ok: false, unknown: false, error: 'qq.replyLimit' });
    expect(f.requests).toHaveLength(count);
  });
});
