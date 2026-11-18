/** Official QQ Open Platform transport adapter.
 *
 * The adapter owns only the wire protocol: OAuth token fetch, WebSocket
 * gateway framing, and message send calls. It holds no policy authority — the
 * channel service decides what may be sent and to whom. Transport pieces are
 * injected (socket factory + http json) so tests run against fakes and the
 * production path can use Node's built-in WebSocket. */

import { createHash } from 'node:crypto';
import type { QqGatewayEvent } from '../../../shared/qq-channel';
import { qqChatBubbles } from './qq-bubbles';
import type { QqResolvedReplyImage, QqSendControls } from './qq-channel-service';

export const QQ_INTENT_C2C_GROUP_AT_MESSAGES = 1 << 25;
// Keep both the decoded bytes and the Base64 JSON request below QQ's 5M limit.
export const OFFICIAL_QQ_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

export function supportsOfficialQqImage(mime: string, byteLength: number): boolean {
  return (mime === 'image/png' || mime === 'image/jpeg') && Number.isSafeInteger(byteLength)
    && byteLength > 0 && byteLength <= OFFICIAL_QQ_MAX_IMAGE_BYTES;
}

function officialImageFileName(image: QqResolvedReplyImage): string | null {
  const { base64, mime, sha256 } = image;
  if (base64.length > Math.ceil(OFFICIAL_QQ_MAX_IMAGE_BYTES / 3) * 4 || base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || !/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (!supportsOfficialQqImage(mime, bytes.length) || bytes.toString('base64') !== base64
    || createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
  if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'deskpet-image.png';
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'deskpet-image.jpg';
  return null;
}

const replyData = (body: unknown): Record<string, unknown> | null =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;

// Both spellings are used by official QQ endpoints. Never surface the body.
const hasReplyError = (data: Record<string, unknown> | null): boolean =>
  (data?.err_code !== undefined && data.err_code !== 0) || (data?.code !== undefined && data.code !== 0);

/** Which field failed, by name, type and length: never its value. */
const unreadableField = (data: { id?: unknown; content?: unknown; group_openid?: unknown; author?: Record<string, unknown> | null } | null, sender: string): string => {
  if (data === null || typeof data !== 'object') return 'payload';
  const describe = (name: string, value: unknown, max = Infinity): string | null => typeof value !== 'string' ? `${name}:${typeof value}`
    : value.length === 0 || value.length > max ? `${name}:len${value.length}` : null;
  return describe('id', data.id) ?? (typeof data.content === 'string' && data.content.length <= 8_000 ? null : describe('content', data.content, 8_000))
    ?? ('group_openid' in data ? describe('group_openid', data.group_openid) : null) ?? describe(sender, data.author?.[sender]) ?? 'unknown';
};

export interface QqInboundMessage {
  id: string;
  senderOpenId: string;
  content: string;
  timestamp: string | null;
  /** Present for a group message that mentioned the bot; senderOpenId is then scoped to it. */
  group?: { groupId: string };
}

export interface QqAdapterEvents {
  onMessage(message: QqInboundMessage): void;
  onConnectionChange(state: 'connecting' | 'online' | 'offline'): void;
}

export interface QqSendResult {
  ok: boolean;
  /** True when the outcome of the send is unknown (timeout/network), so the
   * caller must not blindly retry and must surface an uncertain state. */
  unknown: boolean;
  error?: string;
}

export interface QqWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export type QqSocketFactory = (url: string) => QqWebSocketLike;

export interface QqHttpJson {
  (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; json: unknown }>;
}

// Only expose known QQ error classes, never server-supplied error messages.
const sendErrors = new Map<number, string>([
  [40034105, 'qq.proactivePermission'], [40054013, 'qq.recipientDeclined'],
  [40034100, 'qq.proactiveRateLimit'], [40054004, 'qq.friendRequired'], [40034128, 'qq.replyLimit'],
  [304103, 'qq.replyExpired'], [40034005, 'qq.replyExpired'],
]);

interface TokenCache { value: string; expiresAt: number }
const RECONNECT_LIMIT = 8;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export class QqOfficialAdapter {
  readonly #sockets: QqSocketFactory;
  readonly #http: QqHttpJson;
  readonly #apiBase: string;
  readonly #now: () => number;
  readonly #random: () => number;
  #socket: QqWebSocketLike | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #events: QqAdapterEvents | null = null;
  #credentials: { appId: string; secret: string } | null = null;
  #token: TokenCache | null = null;
  #closedByHost = false;
  #msgSeq = 0;
  readonly #replyWindows = new Map<string, { used: number; expires: number }>();
  #lastError: string | null = null;
  #gatewayEvents = new Map<string, QqGatewayEvent>();
  #seenMessageIds = new Set<string>();
  #generation = 0;
  #controller = new AbortController();
  #heartbeatPending = false;
  #tokenRequest: Promise<string> | null = null;
  #sessionId: string | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #retryCount = 0;
  #handshake: 'identify' | 'resume' | null = null;
  #helloReceived = false;

  constructor(deps: { socketFactory: QqSocketFactory; http: QqHttpJson; apiBase?: string; now?: () => number; random?: () => number }) {
    this.#sockets = deps.socketFactory;
    this.#http = deps.http;
    this.#apiBase = deps.apiBase ?? 'https://api.sgroup.qq.com';
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
  }

  get connection(): 'offline' | 'connecting' | 'online' { return this.#socket === null ? 'offline' : this.#online ? 'online' : 'connecting'; }
  #online = false;
  get lastError(): string | null { return this.#lastError; }
  get gatewayEvents(): QqGatewayEvent[] { return [...this.#gatewayEvents.values()].map(event => ({ ...event })); }

  async #authorization(): Promise<Record<string, string>> {
    const headers = await this.#rawAuthorization();
    return { authorization: `QQBot ${headers}` };
  }

  /** Official v2 Identify uses `QQBot <AccessToken>`, without the AppID. */
  async #rawAuthorization(): Promise<string> {
    const generation = this.#generation;
    const credentials = this.#credentials;
    if (credentials === null) throw new Error('qq.credentialsMissing');
    if (this.#token !== null && this.#token.expiresAt > this.#now() + 30_000) return this.#token.value;
    if (this.#tokenRequest) return this.#tokenRequest;
    const request = this.#fetchToken(credentials, generation);
    this.#tokenRequest = request;
    void request.then(() => { if (this.#tokenRequest === request) this.#tokenRequest = null; },
      () => { if (this.#tokenRequest === request) this.#tokenRequest = null; });
    return request;
  }

  async #fetchToken(credentials: { appId: string; secret: string }, generation: number): Promise<string> {
    const response = await this.#http('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.secret }),
      signal: this.#controller.signal,
    });
    if (generation !== this.#generation || this.#closedByHost) throw new Error('qq.authorityRevoked');
    const body = response.json as { access_token?: unknown; expires_in?: unknown } | null;
    const expires = Number(body?.expires_in);
    if (response.status !== 200 || body === null || typeof body.access_token !== 'string' || body.access_token.length < 1 || body.access_token.length > 8_192
      || !Number.isFinite(expires) || expires < 60 || expires > 86_400) {
      this.#lastError = 'qq.authFailed';
      throw new Error('qq.authFailed');
    }
    this.#token = { value: body.access_token, expiresAt: this.#now() + expires * 1_000 };
    return this.#token.value;
  }

  async start(credentials: { appId: string; secret: string }, events: QqAdapterEvents): Promise<void> {
    this.stop();
    const generation = this.#generation;
    this.#credentials = { ...credentials };
    this.#events = events;
    this.#closedByHost = false;
    try { await this.#openGateway(generation); }
    catch (error) {
      if (generation === this.#generation && !this.#closedByHost) this.#scheduleReconnect(this.#connectionError(error));
      throw error;
    }
  }

  #connectionError(error: unknown): string {
    return error instanceof Error && ['qq.authFailed', 'qq.gatewayTargetBlocked'].includes(error.message) ? error.message : 'qq.gatewayUnavailable';
  }

  async #openGateway(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#closedByHost) return;
    this.#events?.onConnectionChange('connecting');
    const headers = await this.#authorization();
    if (generation !== this.#generation || this.#closedByHost) return;
    const gateway = await this.#http(`${this.#apiBase}/gateway`, { method: 'GET', headers, signal: this.#controller.signal });
    if (generation !== this.#generation || this.#closedByHost) return;
    const url = (gateway.json as { url?: unknown } | null)?.url;
    if (gateway.status !== 200 || typeof url !== 'string') {
      this.#lastError = 'qq.gatewayUnavailable';
      throw new Error('qq.gatewayUnavailable');
    }
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('qq.gatewayTargetBlocked'); }
    if (url.length > 2_048 || target.protocol !== 'wss:' || target.username || target.password || target.hash
      || target.port && target.port !== '443' || !['api.bot.qq.com', 'sandbox.api.bot.qq.com', 'api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com'].includes(target.hostname)) throw new Error('qq.gatewayTargetBlocked');
    this.#connect(url);
  }

  #connect(url: string): void {
    const events = this.#events;
    if (events === null) return;
    events.onConnectionChange('connecting');
    const socket = this.#sockets(url);
    const generation = this.#generation;
    const current = (): boolean => generation === this.#generation && this.#socket === socket && !this.#closedByHost;
    this.#socket = socket;
    this.#handshakeTimer = setTimeout(() => { if (current()) this.#scheduleReconnect('qq.handshakeTimeout'); }, HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref?.();
    socket.addEventListener('open', () => undefined);
    socket.addEventListener('message', (event) => { if (current() && typeof event.data === 'string') this.#frame(event.data); });
    socket.addEventListener('close', () => {
      if (!current()) return;
      this.#scheduleReconnect('qq.socketClosed');
    });
    socket.addEventListener('error', () => { if (current()) this.#scheduleReconnect('qq.socketError'); });
  }

  #teardownSocket(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
    if (this.#stableTimer !== null) clearTimeout(this.#stableTimer);
    this.#handshakeTimer = null; this.#stableTimer = null;
    this.#socket = null;
    this.#online = false;
    this.#heartbeatPending = false;
    this.#handshake = null; this.#helloReceived = false;
  }

  #frame(raw: string): void {
    const events = this.#events;
    if (events === null || raw === '' || raw.length > 131_072) return;
    let payload: { op?: unknown; s?: unknown; t?: unknown; d?: unknown };
    try { payload = JSON.parse(raw) as typeof payload; } catch { return; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.op !== 'number') return;
    if (payload.op === 10) {
      const interval = (payload.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval;
      const socket = this.#socket;
      if (socket === null || this.#helloReceived || typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1_000 || interval > 120_000) return;
      this.#helloReceived = true;
      const generation = this.#generation;
      void this.#rawAuthorization().then((token) => {
        if (generation !== this.#generation || this.#socket !== socket || this.#closedByHost) return;
        this.#handshake = this.#sessionId !== null && this.#lastSeq !== null ? 'resume' : 'identify';
        socket.send(JSON.stringify(this.#handshake === 'resume' ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#lastSeq } }
          : { op: 2, d: { token: `QQBot ${token}`, intents: QQ_INTENT_C2C_GROUP_AT_MESSAGES, shard: [0, 1], properties: { $os: process.platform, $browser: 'deskpet', $device: 'deskpet' } } }));
      }).catch(error => { if (generation === this.#generation && this.#socket === socket) this.#scheduleReconnect(this.#connectionError(error)); });
      this.#heartbeat = setInterval(() => {
        if (generation !== this.#generation || this.#socket !== socket) return;
        if (this.#heartbeatPending) { this.#scheduleReconnect('qq.heartbeatTimeout'); return; }
        this.#sendHeartbeat();
      }, interval);
      this.#heartbeat.unref?.();
      return;
    }
    if (payload.op === 11) { this.#heartbeatPending = false; return; }
    if (payload.op === 1) { if (this.#helloReceived) this.#sendHeartbeat(); return; }
    if (payload.op === 7) { this.#scheduleReconnect('qq.serverReconnect'); return; }
    if (payload.op === 9) { this.#scheduleReconnect('qq.invalidSession', true); return; }
    if (payload.op === 0) {
      if (typeof payload.s !== 'number' || !Number.isSafeInteger(payload.s) || payload.s < 0) return;
      const lowSequence = this.#lastSeq !== null && payload.s <= this.#lastSeq && payload.t !== 'READY' && payload.t !== 'RESUMED';
      this.#recordGatewayEvent(payload.t, lowSequence);
      if (payload.t === 'READY') {
        const id = (payload.d as { session_id?: unknown } | null)?.session_id;
        if (this.#handshake !== 'identify' || typeof id !== 'string' || !id) return;
        this.#sessionId = id; this.#lastSeq = payload.s; this.#markOnline(); return;
      }
      if (payload.t === 'RESUMED') {
        if (this.#handshake !== 'resume' || this.#lastSeq === null || payload.s < this.#lastSeq) return;
        this.#lastSeq = payload.s; this.#markOnline(); return;
      }
      // QQ replays missed dispatches BEFORE RESUMED. Accept that backlog only
      // after this socket sent a resume for our captured session and sequence.
      if (!this.#online && this.#handshake !== 'resume') return;
      // The sequence is only the resume point. A lower one must not lose a message,
      // so replays are caught by message id instead.
      if (!lowSequence) this.#lastSeq = payload.s;
      const accept = (id: string): boolean => {
        if (this.#seenMessageIds.has(id)) { this.#noteGatewayDrop(payload.t, 'duplicate'); return false; }
        this.#seenMessageIds.add(id);
        if (this.#seenMessageIds.size > 512) this.#seenMessageIds.delete(this.#seenMessageIds.values().next().value!);
        this.#noteGatewayDelivered(payload.t); return true;
      };
      if (payload.t === 'C2C_MESSAGE_CREATE') {
        const data = payload.d as { id?: unknown; content?: unknown; author?: { user_openid?: unknown } | null; timestamp?: unknown } | null;
        if (data != null && typeof data.id === 'string' && data.id.length > 0
          && typeof data.content === 'string' && data.content.length > 0 && data.content.length <= 8_000
          && typeof data.author?.user_openid === 'string' && data.author.user_openid.length > 0) {
          if (accept(data.id)) events.onMessage({
            id: data.id,
            senderOpenId: data.author.user_openid,
            content: data.content.trim(),
            timestamp: typeof data.timestamp === 'string' ? data.timestamp : null,
          });
        } else { this.#lastError = 'qq.messageUnreadable'; this.#noteGatewayDrop(payload.t, `unreadable ${unreadableField(data, 'user_openid')}`); }
      }
      if (payload.t === 'GROUP_AT_MESSAGE_CREATE' || payload.t === 'GROUP_MESSAGE_CREATE') {
        const data = payload.d as { id?: unknown; content?: unknown; group_openid?: unknown; mentions?: unknown; author?: { member_openid?: unknown } | null; timestamp?: unknown } | null;
        // With "receive all group messages" on, QQ sends mentions here too. Anything that
        // does not mention this bot is not addressed to it and is never read.
        if (payload.t === 'GROUP_MESSAGE_CREATE' && !(Array.isArray(data?.mentions)
          && data.mentions.some((mention: { is_you?: unknown } | null) => mention?.is_you === true))) { this.#noteGatewayDrop(payload.t, 'not-mentioned'); return; }
        if (data != null && typeof data.id === 'string' && data.id.length > 0
          && typeof data.content === 'string' && data.content.length <= 8_000
          && typeof data.group_openid === 'string' && data.group_openid.length > 0
          && typeof data.author?.member_openid === 'string' && data.author.member_openid.length > 0) {
          const content = data.content.replace(/<@!?[^>]*>/gu, '').replace(/[\u200B-\u200D\uFEFF]/gu, '').trim();
          if (!content) this.#noteGatewayDrop(payload.t, 'empty');
          else if (accept(data.id)) events.onMessage({ id: data.id, senderOpenId: data.author.member_openid, content, group: { groupId: data.group_openid },
            timestamp: typeof data.timestamp === 'string' ? data.timestamp : null });
        } else { this.#lastError = 'qq.messageUnreadable'; this.#noteGatewayDrop(payload.t, `unreadable ${unreadableField(data, 'member_openid')}`); }
      }
    }
  }

  #recordGatewayEvent(type: unknown, lowSequence: boolean): void {
    if (typeof type !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(type)) return;
    const known = this.#gatewayEvents.get(type);
    if (!known && this.#gatewayEvents.size >= 20) return;
    this.#gatewayEvents.set(type, { type, count: (known?.count ?? 0) + 1, lastAt: new Date().toISOString(),
      delivered: known?.delivered ?? 0, lowSequence: (known?.lowSequence ?? 0) + (lowSequence ? 1 : 0), lastDrop: known?.lastDrop ?? null });
  }
  #noteGatewayDelivered(type: unknown): void {
    const known = typeof type === 'string' ? this.#gatewayEvents.get(type) : undefined;
    if (known) known.delivered += 1;
  }
  #noteGatewayDrop(type: unknown, reason: string): void {
    const known = typeof type === 'string' ? this.#gatewayEvents.get(type) : undefined;
    if (known) known.lastDrop = reason;
  }

  #lastSeq: number | null = null;
  #sendHeartbeat(): void {
    try { this.#socket?.send(JSON.stringify({ op: 1, d: this.#lastSeq })); this.#heartbeatPending = true; }
    catch { this.#scheduleReconnect('qq.socketError'); }
  }
  #markOnline(): void {
    this.#online = true; this.#handshake = null; this.#lastError = null;
    if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
    // A flapping connection cannot reset its backoff by briefly saying READY.
    this.#stableTimer = setTimeout(() => { this.#retryCount = 0; }, 60_000); this.#stableTimer.unref?.();
    this.#events?.onConnectionChange('online');
  }
  #scheduleReconnect(error: string, fresh = false): void {
    if (this.#closedByHost || this.#credentials === null || this.#events === null) return;
    this.#lastError = error;
    if (fresh) { this.#sessionId = null; this.#lastSeq = null; }
    const socket = this.#socket;
    this.#teardownSocket();
    try { socket?.close(); } catch { /* already gone */ }
    this.#events.onConnectionChange('offline');
    if (this.#reconnectTimer !== null || ['qq.authFailed', 'qq.gatewayTargetBlocked'].includes(error)) return;
    if (this.#retryCount >= RECONNECT_LIMIT) { this.#lastError = 'qq.reconnectExhausted'; return; }
    const delay = Math.min(30_000, 1_000 * 2 ** this.#retryCount * (0.8 + this.#random() * 0.4));
    this.#retryCount++;
    const generation = this.#generation;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (generation !== this.#generation || this.#closedByHost) return;
      void this.#openGateway(generation).catch(error => {
        if (generation === this.#generation && !this.#closedByHost) this.#scheduleReconnect(this.#connectionError(error));
      });
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  stop(): void {
    this.#generation += 1;
    this.#closedByHost = true;
    this.#controller.abort(); this.#controller = new AbortController();
    this.#credentials = null; this.#token = null; this.#tokenRequest = null; this.#lastSeq = null; this.#sessionId = null; this.#retryCount = 0;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#teardownSocket();
    try { socket?.close(); } catch { /* already gone */ }
    this.#events?.onConnectionChange('offline');
    this.#events = null;
  }

  sendToUser(openId: string, content: string, replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#send(`/v2/users/${encodeURIComponent(openId)}/messages`, openId, content, 4, replyToMessageId, controls);
  }

  sendToGroup(groupId: string, content: string, replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#send(`/v2/groups/${encodeURIComponent(groupId)}/messages`, groupId, content, 5, replyToMessageId, controls);
  }

  sendImageToUser(openId: string, image: QqResolvedReplyImage, replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#sendImage('users', openId, image, 4, replyToMessageId, controls);
  }

  sendImageToGroup(groupId: string, image: QqResolvedReplyImage, replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#sendImage('groups', groupId, image, 5, replyToMessageId, controls);
  }

  #nextMessageSequence(): number {
    this.#msgSeq = (this.#msgSeq + 1) % 1_000_000;
    return this.#msgSeq;
  }

  #replyWindow(path: string, messageId: string, lifetimeMs: number): {used: number; expires: number} {
    const now = this.#now();
    for (const [key, entry] of this.#replyWindows) {
      if (entry.expires <= now) this.#replyWindows.delete(key);
    }
    const key = JSON.stringify([this.#credentials?.appId, path, messageId]);
    let entry = this.#replyWindows.get(key);
    if (!entry) {
      entry = { used: 0, expires: now + lifetimeMs };
      this.#replyWindows.set(key, entry);
    }
    return entry;
  }

  async #sendImage(scope: 'users' | 'groups', openId: string, image: QqResolvedReplyImage, replyLimit: 4 | 5,
    replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const generation = this.#generation;
    const signal = controls ? AbortSignal.any([controls.signal, this.#controller.signal]) : this.#controller.signal;
    let stage: 'prepare' | 'upload' | 'send' = 'prepare';
    const failure = (error: string, unknown = false): QqSendResult => {
      if (generation === this.#generation) this.#lastError = error;
      return { ok: false, unknown, error };
    };
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      controls?.assertCurrent();
      if (generation !== this.#generation || this.#closedByHost || this.#credentials === null) throw new Error('qq.authorityRevoked');
      signal.throwIfAborted();
    };
    try {
      assertCurrent();
      if (!openId.trim() || openId.length > 256 || openId === '.' || openId === '..'
        || (replyToMessageId !== undefined && !replyToMessageId.trim())) return failure('qq.imageUnavailable');
      const fileName = officialImageFileName(image);
      if (!fileName) return failure('qq.imageUnavailable');
      const target = `/v2/${scope}/${encodeURIComponent(openId)}`;
      const path = `${target}/messages`;
      const budget = replyToMessageId === undefined ? null
        : this.#replyWindow(path, replyToMessageId, replyLimit === 4 ? 60 * 60_000 : 5 * 60_000);
      if (budget && budget.used >= replyLimit) return failure('qq.replyLimit');

      const uploadBody = JSON.stringify({ file_type: 1, file_name: fileName, file_data: image.base64, srv_send_msg: false });
      const uploadHeaders = await this.#authorization();
      assertCurrent();
      stage = 'upload';
      const upload = await this.#http(`${this.#apiBase}${target}/files`, {
        method: 'POST', headers: { ...uploadHeaders, 'content-type': 'application/json' }, body: uploadBody, signal,
      });
      stage = 'prepare';
      assertCurrent();
      const uploadData = replyData(upload.json);
      const fileInfo = uploadData?.file_info;
      if (upload.status < 200 || upload.status >= 300 || hasReplyError(uploadData) || typeof fileInfo !== 'string'
        || !fileInfo.trim() || fileInfo.length > 65_536) return failure('qq.imageUploadFailed');

      const sendHeaders = await this.#authorization();
      assertCurrent();
      if (budget && budget.expires <= this.#now()) return failure('qq.replyExpired');
      if (budget && budget.used >= replyLimit) return failure('qq.replyLimit');
      // Uploading alone cannot consume a reply or send a message. Reserve the
      // shared text/image slot immediately before the irreversible request.
      const sendBody = JSON.stringify({ msg_type: 7, media: { file_info: fileInfo }, msg_seq: this.#nextMessageSequence(),
        ...(replyToMessageId === undefined ? {} : { msg_id: replyToMessageId }) });
      if (budget) budget.used++;
      stage = 'send';
      const response = await this.#http(`${this.#apiBase}${path}`, {
        method: 'POST', headers: { ...sendHeaders, 'content-type': 'application/json' }, body: sendBody, signal,
      });
      const data = replyData(response.json);
      const code = typeof data?.err_code === 'number' && data.err_code !== 0 ? data.err_code : data?.code;
      const knownError = typeof code === 'number' ? sendErrors.get(code) : undefined;
      if (knownError || response.status < 200 || response.status >= 300) {
        const definitive = knownError !== undefined || (response.status >= 400 && response.status < 500 && response.status !== 408);
        if (definitive && budget) budget.used--;
        return failure(knownError ?? `qq.sendHttp_${response.status}`, !definitive);
      }
      if (hasReplyError(data) || typeof data?.id !== 'string' || !data.id.trim() || data.id.length > 8_192) {
        return failure('qq.unconfirmedReceipt', true);
      }
      return { ok: true, unknown: false };
    } catch {
      if (stage === 'send') return failure('qq.sendUnknown', true);
      return failure(stage === 'upload' ? 'qq.imageUploadFailed' : 'qq.sendBlocked');
    }
  }

  async #send(path: string, openId: string, content: string, replyLimit: number, replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const generation = this.#generation;
    const signal = controls ? AbortSignal.any([controls.signal, this.#controller.signal]) : this.#controller.signal;
    let dispatched = false, sent = 0;
    const failure = (error: string, unknown: boolean): QqSendResult => {
      this.#lastError = error;
      return { ok: false, unknown: sent > 0 || unknown, error: sent > 0 ? 'qq.sendPartial' : error };
    };
    try {
      if (!openId || !content.trim() || content.length > 8_000) throw new Error('qq.invalidMessage');
      signal.throwIfAborted(); controls?.assertCurrent();
      const headers = await this.#authorization();
      const budget = replyToMessageId === undefined ? null : this.#replyWindow(path, replyToMessageId, replyLimit === 4 ? 60 * 60_000 : 5 * 60_000);
      const remaining = budget ? replyLimit - budget.used : 1;
      if (remaining <= 0) return failure('qq.replyLimit', false);
      // Preserve one slot for a linked picture when there is room for both.
      // When only one slot remains the text is still the primary reply.
      const reserved = controls?.reserveImageReply && remaining > 1 ? 1 : 0;
      const bubbles = controls?.singleBubble || !budget ? [content] : qqChatBubbles(content, remaining - reserved);
      for (const bubble of bubbles) {
        if (generation !== this.#generation || this.#closedByHost) throw new Error('qq.authorityRevoked');
        signal.throwIfAborted(); controls?.assertCurrent();
        // Reserve synchronously: independent sends sharing a source msg_id
        // cannot spend the same last reply or reuse a message sequence.
        if (budget && budget.used >= replyLimit - reserved) return failure('qq.replyLimit', false);
        if (budget) budget.used++;
        dispatched = true;
        const response = await this.#http(`${this.#apiBase}${path}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ content: bubble, msg_type: 0, msg_seq: this.#nextMessageSequence(), ...(replyToMessageId === undefined ? {} : { msg_id: replyToMessageId }) }),
          signal,
        });
        const data = response.json && typeof response.json === 'object' ? response.json as Record<string, unknown> : null;
        const qqError = typeof data?.code === 'number' ? sendErrors.get(data.code) : undefined;
        if (qqError || response.status < 200 || response.status >= 300) {
          const definitive = qqError !== undefined || response.status >= 400 && response.status < 500 && response.status !== 408;
          if (definitive && budget) budget.used--;
          return failure(qqError ?? `qq.sendHttp_${response.status}`, !definitive);
        }
        // QQ documents the accepted Message.id as a string for both endpoints.
        if (typeof data?.id !== 'string' || !data.id.trim() || data.code !== undefined && data.code !== 0) {
          return failure('qq.unconfirmedReceipt', true);
        }
        sent++;
        dispatched = false;
      }
      return { ok: true, unknown: false };
    } catch {
      return failure(dispatched ? 'qq.sendUnknown' : 'qq.sendBlocked', dispatched);
    }
  }
}
