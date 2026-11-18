/** Local OneBot 11 transport for a secondary QQ account (NapCat forward WS).
 *
 * Unofficial protocol: the owner accepted the account risk. The adapter holds no
 * policy authority and only ever talks to a loopback endpoint with a token. Only
 * friend private text is admitted. Model text always remains a text segment;
 * images enter only through the separate host-resolved managed-asset method. */

import { createHash } from 'node:crypto';
import { qqChatBubbles } from './qq-bubbles';
import type { QqResolvedReplyImage, QqSendControls } from './qq-channel-service';
import type { QqAdapterEvents, QqSendResult, QqSocketFactory, QqWebSocketLike } from './qq-official-adapter';
import { isLoopbackOneBotUrl, QQ_MAX_MESSAGE_CHARACTERS } from '../../../shared/qq-channel';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const CHUNK_CHARACTERS = 2_000;
const CHUNK_PAUSE_MS = 800;
const ONEBOT_AUTH_FAILED = 1403;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Accept image bytes only, never a URL, CQ code or arbitrary file path. */
const imageFile = (image: QqResolvedReplyImage): string => {
  if (!/^[a-f0-9]{64}$/u.test(image.sha256) || image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.base64)) throw new Error('qq.invalidImage');
  const bytes = Buffer.from(image.base64, 'base64');
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || image.base64 !== bytes.toString('base64')
    || createHash('sha256').update(bytes).digest('hex') !== image.sha256
    || !(image.mime === 'image/png' && png || image.mime === 'image/jpeg' && jpeg || image.mime === 'image/gif' && gif || image.mime === 'image/webp' && webp)) throw new Error('qq.invalidImage');
  return `base64://${image.base64}`;
};

interface Response { status?: unknown; retcode?: unknown; data?: unknown }
interface Pending { resolve(response: Response | null): void; timer: ReturnType<typeof setTimeout> }

const qqNumber = (value: unknown): string | null => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return /^[1-9]\d*$/u.test(text) ? text : null;
};
// Keep normal OneBot numeric parameters, but never round a larger opaque ID.
const wireNumber = (value: string | null): number | string => {
  const numeric = Number(value);
  return value !== null && Number.isSafeInteger(numeric) ? numeric : value ?? '';
};
const succeeded = (response: Response | null): boolean => response?.status === 'ok' && response.retcode === 0;

/** Prefer line breaks so a long reply reads as whole paragraphs across messages. */
export const splitOneBotMessage = (content: string, limit = CHUNK_CHARACTERS): string[] => {
  const chunks: string[] = [];
  if (!content.trim()) return [];
  if (content.length <= limit) return [content];
  let rest = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(content), item => item.segment);
  while (rest.length > limit) {
    let newline = limit - 1;
    while (newline >= 0 && !/[\r\n]/u.test(rest[newline]!)) newline--;
    const end = newline > limit / 2 ? newline + 1 : limit;
    chunks.push(rest.slice(0, end).join('')); rest = rest.slice(end);
  }
  if (rest.length > 0) chunks.push(rest.join(''));
  // A transport-sized whitespace-only slice cannot stand as a QQ message.
  // Keep it attached to the original text, never silently drop characters.
  return chunks.some(chunk => !chunk.trim()) ? [content] : chunks;
};

export class QqOneBotAdapter {
  readonly #sockets: QqSocketFactory;
  readonly #random: () => number;
  readonly #pending = new Map<string, Pending>();
  #socket: QqWebSocketLike | null = null;
  #events: QqAdapterEvents | null = null;
  #target: string | null = null;
  #selfId: string | null = null;
  #online = false;
  #generation = 0;
  #echo = 0;
  #retryCount = 0;
  #lastError: string | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #probe: ReturnType<typeof setInterval> | null = null;

  constructor(deps: { socketFactory: QqSocketFactory; random?: () => number }) {
    this.#sockets = deps.socketFactory;
    this.#random = deps.random ?? Math.random;
  }

  get lastError(): string | null { return this.#lastError; }

  async start(credentials: { url: string; token: string }, events: QqAdapterEvents): Promise<void> {
    this.stop();
    if (!isLoopbackOneBotUrl(credentials.url) || !credentials.token) { this.#lastError = 'qq.onebotTargetBlocked'; throw new Error('qq.onebotTargetBlocked'); }
    const target = new URL(credentials.url);
    target.searchParams.set('access_token', credentials.token);
    this.#target = target.toString(); this.#events = events; this.#lastError = null;
    this.#connect();
    await Promise.resolve();
  }

  #connect(): void {
    if (this.#target === null || this.#events === null) return;
    this.#events.onConnectionChange('connecting');
    const socket = this.#sockets(this.#target), generation = this.#generation;
    const current = (): boolean => generation === this.#generation && this.#socket === socket;
    this.#socket = socket;
    this.#handshakeTimer = setTimeout(() => { if (current()) this.#reconnect('qq.handshakeTimeout'); }, HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref?.();
    socket.addEventListener('open', () => { if (current()) void this.#identify(socket, generation); });
    socket.addEventListener('message', event => { if (current() && typeof event.data === 'string') this.#frame(event.data); });
    socket.addEventListener('close', () => { if (current()) this.#reconnect('qq.socketClosed'); });
    socket.addEventListener('error', () => { if (current()) this.#reconnect('qq.socketError'); });
  }

  async #identify(socket: QqWebSocketLike, generation: number): Promise<void> {
    const login = await this.#call(socket, 'get_login_info', {});
    if (generation !== this.#generation || this.#socket !== socket) return;
    const selfId = succeeded(login) ? qqNumber((login?.data as { user_id?: unknown } | null)?.user_id) : null;
    if (selfId === null) { this.#reconnect('qq.accountOffline'); return; }
    this.#selfId = selfId; this.#setOnline(true);
    if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null; this.#retryCount = 0;
    // Active probe: it works whatever heartbeat interval NapCat is configured with.
    this.#probe = setInterval(() => { void this.#checkStatus(socket, generation); }, PROBE_INTERVAL_MS);
    this.#probe.unref?.();
  }

  async #checkStatus(socket: QqWebSocketLike, generation: number): Promise<void> {
    const status = await this.#call(socket, 'get_status', {});
    if (generation !== this.#generation || this.#socket !== socket) return;
    if (status === null) { this.#reconnect('qq.heartbeatTimeout'); return; }
    this.#setOnline(succeeded(status) && (status.data as { online?: unknown } | null)?.online === true);
  }

  #setOnline(online: boolean): void {
    this.#lastError = online ? null : 'qq.accountOffline';
    if (online === this.#online) return;
    this.#online = online;
    this.#events?.onConnectionChange(online ? 'online' : 'offline');
  }

  #call(socket: QqWebSocketLike, action: string, params: Record<string, unknown>): Promise<Response | null> {
    return new Promise(resolve => {
      const echo = `deskpet-${++this.#echo}`;
      const timer = setTimeout(() => { this.#pending.delete(echo); resolve(null); }, RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(echo, { resolve, timer });
      try { socket.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); this.#pending.delete(echo); resolve(null); }
    });
  }

  #frame(raw: string): void {
    if (raw === '' || raw.length > 262_144) return;
    let frame: Response & { echo?: unknown; post_type?: unknown };
    try { frame = JSON.parse(raw) as typeof frame; } catch { return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    if (typeof frame.echo === 'string' && this.#pending.has(frame.echo)) {
      const pending = this.#pending.get(frame.echo)!;
      this.#pending.delete(frame.echo); clearTimeout(pending.timer); pending.resolve(frame);
      return;
    }
    // NapCat reports a bad token with this frame, then closes. Retrying cannot help.
    if (frame.retcode === ONEBOT_AUTH_FAILED) { this.#halt('qq.onebotAuthFailed'); return; }
    if (frame.post_type === 'message' && this.#online) this.#message(frame as unknown as Record<string, unknown>);
  }

  #message(event: Record<string, unknown>): void {
    const group = event.message_type === 'group' ? qqNumber(event.group_id) : null;
    if ((event.message_type !== 'private' || event.sub_type !== 'friend') && group === null) return;
    if (!Array.isArray(event.message)) return;
    const sender = qqNumber(event.user_id);
    if (sender === null || sender === this.#selfId) return;
    // In a group, only a message that mentions this account is addressed to it.
    if (group !== null && !(event.message as Array<{ type?: unknown; data?: { qq?: unknown } | null } | null>)
      .some(segment => segment?.type === 'at' && String(segment.data?.qq) === this.#selfId)) return;
    if (!['number', 'string'].includes(typeof event.message_id) || typeof event.time !== 'number') return;
    // raw_message carries CQ codes; only explicit text segments are user text.
    const content = (event.message as Array<{ type?: unknown; data?: { text?: unknown } | null } | null>)
      .map(segment => segment?.type === 'text' && typeof segment.data?.text === 'string' ? segment.data.text : '').join('').trim();
    if (!content || content.length > QQ_MAX_MESSAGE_CHARACTERS) return;
    this.#events?.onMessage({ id: `onebot-${String(event.message_id)}-${event.time}`, senderOpenId: sender, content,
      timestamp: new Date(event.time * 1_000).toISOString(), ...(group === null ? {} : { group: { groupId: group } }) });
  }

  #teardown(): QqWebSocketLike | null {
    const socket = this.#socket;
    if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
    if (this.#probe !== null) clearInterval(this.#probe);
    this.#handshakeTimer = null; this.#probe = null; this.#socket = null; this.#selfId = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    this.#pending.clear();
    if (this.#online) { this.#online = false; this.#events?.onConnectionChange('offline'); }
    try { socket?.close(); } catch { /* already gone */ }
    return socket;
  }

  #halt(error: string): void {
    this.#lastError = error;
    this.#teardown();
    this.#events?.onConnectionChange('offline');
  }

  /** NapCat is local and may start after DeskPet, so this retries without a limit. */
  #reconnect(error: string): void {
    this.#halt(error);
    if (this.#reconnectTimer !== null || this.#target === null) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.#retryCount, 5) * (0.8 + this.#random() * 0.4));
    this.#retryCount++;
    const generation = this.#generation;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (generation === this.#generation) this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  stop(): void {
    this.#generation += 1;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null; this.#target = null; this.#retryCount = 0;
    this.#teardown();
    this.#events?.onConnectionChange('offline');
    this.#events = null;
  }

  sendToUser(openId: string, content: string, _replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const userId = qqNumber(openId);
    return this.#send(userId, 'send_private_msg', { user_id: wireNumber(userId) }, content, controls);
  }

  sendToGroup(groupId: string, content: string, _replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const id = qqNumber(groupId);
    return this.#send(id, 'send_group_msg', { group_id: wireNumber(id) }, content, controls);
  }

  sendImageToUser(openId: string, image: QqResolvedReplyImage, _replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const id = qqNumber(openId);
    return this.#sendImage(id, 'send_private_msg', { user_id: wireNumber(id) }, image, controls);
  }

  sendImageToGroup(groupId: string, image: QqResolvedReplyImage, _replyToMessageId?: string, controls?: QqSendControls): Promise<QqSendResult> {
    const id = qqNumber(groupId);
    return this.#sendImage(id, 'send_group_msg', { group_id: wireNumber(id) }, image, controls);
  }

  async #sendImage(id: string | null, action: string, target: Record<string, number | string>, image: QqResolvedReplyImage, controls?: QqSendControls): Promise<QqSendResult> {
    const generation = this.#generation, socket = this.#socket;
    let file: string;
    try {
      file = imageFile(image);
      controls?.signal.throwIfAborted(); controls?.assertCurrent();
      if (id === null || socket === null || socket !== this.#socket || generation !== this.#generation || !this.#online) throw new Error('qq.sendBlocked');
    } catch { return { ok: false, unknown: false, error: 'qq.imageUnavailable' }; }
    const response = await this.#call(socket, action, { ...target, message: [{ type: 'image', data: { file } }] });
    if (response === null) return { ok: false, unknown: true, error: 'qq.sendUnknown' };
    if (!succeeded(response)) {
      if (response.status !== 'failed' || !Number.isSafeInteger(response.retcode) || response.retcode === 0) return { ok: false, unknown: true, error: 'qq.unconfirmedReceipt' };
      return { ok: false, unknown: false, error: `qq.sendRetcode_${response.retcode}` };
    }
    const receipt = response.data;
    const messageId = receipt && typeof receipt === 'object' && 'message_id' in receipt ? receipt.message_id : null;
    if (!Number.isSafeInteger(messageId) && !(typeof messageId === 'string' && /^-?\d+$/u.test(messageId))) return { ok: false, unknown: true, error: 'qq.unconfirmedReceipt' };
    return { ok: true, unknown: false };
  }

  async #send(userId: string | null, action: string, target: Record<string, number | string>, content: string, controls?: QqSendControls): Promise<QqSendResult> {
    const generation = this.#generation, socket = this.#socket;
    // Each WebSocket action is a distinct QQ bubble. Keep host confirmation
    // notices intact, and retain OneBot's wire-size guard for chat prose.
    const chunks = controls?.singleBubble ? [content] : qqChatBubbles(content, 8).flatMap(bubble => splitOneBotMessage(bubble));
    let sent = 0;
    try {
      if (userId === null || !content.trim() || chunks.length === 0 || content.length > QQ_MAX_MESSAGE_CHARACTERS) throw new Error('qq.invalidMessage');
      for (const chunk of chunks) {
        controls?.signal.throwIfAborted(); controls?.assertCurrent();
        if (socket === null || socket !== this.#socket || generation !== this.#generation || !this.#online) throw new Error('qq.sendBlocked');
        const response = await this.#call(socket, action, { ...target, message: [{ type: 'text', data: { text: chunk } }] });
        // No answer leaves this chunk's delivery unknowable; never retry blindly.
        if (response === null) return { ok: false, unknown: true, error: sent ? 'qq.sendPartial' : 'qq.sendUnknown' };
        if (!succeeded(response)) {
          if (response.status !== 'failed' || !Number.isSafeInteger(response.retcode) || response.retcode === 0) {
            this.#lastError = 'qq.unconfirmedReceipt';
            return { ok: false, unknown: true, error: sent ? 'qq.sendPartial' : 'qq.unconfirmedReceipt' };
          }
          const error = `qq.sendRetcode_${response.retcode}`;
          this.#lastError = error;
          return sent === 0 ? { ok: false, unknown: false, error } : { ok: false, unknown: true, error: 'qq.sendPartial' };
        }
        const receipt = response.data;
        const messageId = receipt && typeof receipt === 'object' && 'message_id' in receipt ? receipt.message_id : null;
        if (!Number.isSafeInteger(messageId) && !(typeof messageId === 'string' && /^-?\d+$/u.test(messageId))) {
          this.#lastError = 'qq.unconfirmedReceipt';
          return { ok: false, unknown: true, error: sent ? 'qq.sendPartial' : 'qq.unconfirmedReceipt' };
        }
        sent++;
        if (sent < chunks.length) await new Promise(resolve => { setTimeout(resolve, CHUNK_PAUSE_MS); });
      }
      return { ok: true, unknown: false };
    } catch {
      return sent === 0 ? { ok: false, unknown: false, error: 'qq.sendBlocked' } : { ok: false, unknown: true, error: 'qq.sendPartial' };
    }
  }
}
