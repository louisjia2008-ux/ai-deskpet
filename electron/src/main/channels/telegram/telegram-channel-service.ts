import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultTelegramState } from '../../../shared/telegram-channel';
import type {
  TelegramAuthority,
  TelegramChannelStatus,
  TelegramConfigureInput,
  TelegramDelivery,
  TelegramOutbox,
  TelegramPendingResult,
  TelegramReply,
  TelegramRunInput,
  TelegramState,
} from '../../../shared/telegram-channel';
import { TelegramApiError, TelegramBotApi, type TelegramApi, type TelegramUpdate } from './telegram-bot-api';
import { parseChatCommand } from '../../domain/chat-commands';
import type { ChatCommand, ChatCommandTarget } from '../../domain/chat-commands';
import type { TelegramChannelStore } from './telegram-channel-store';

export type { TelegramAuthority, TelegramDelivery, TelegramReply, TelegramRunInput } from '../../../shared/telegram-channel';
export const TELEGRAM_BOT_SECRET_ID = 'telegram.bot-token';
export interface TelegramHost {
  createBindingSession(bindingId: string): Promise<{ sessionId: string }>;
  runMessage(input: TelegramRunInput): Promise<TelegramReply>;
  append?(input: TelegramRunInput & { operationId: string }): Promise<boolean>;
  cancel?(runId: string, authority: TelegramAuthority): void;
  assertDelivery(input: TelegramDelivery): void;
  /** Owner commands such as /model, answered by the host without a model run. */
  chatCommand?(command: ChatCommand, target: ChatCommandTarget): Promise<string>;
}
interface Deps {
  store: TelegramChannelStore;
  api?: TelegramApi;
  getSecret(): Promise<string | null>;
  profileId(): string;
  host: TelegramHost;
  onChanged?(): void;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const same = (a: TelegramAuthority | null, b: TelegramAuthority): boolean =>
  !!a && a.bindingId === b.bindingId && a.sessionId === b.sessionId && a.userId === b.userId && a.chatId === b.chatId;
const bare = (a: TelegramAuthority): TelegramAuthority => ({
  bindingId: a.bindingId,
  sessionId: a.sessionId,
  chatId: a.chatId,
  userId: a.userId,
});
const week = 7 * 24 * 3600_000;
const expires = (): number => Date.now() + 5 * 60_000;
const safeError = (error: unknown): string => (error instanceof TelegramApiError ? error.code : 'telegram.processingFailed');
function diagnostic(s: TelegramState, type: string, field: string | null = null): void {
  s.diagnostics.push({ at: new Date().toISOString(), type, outcome: field ? 'rejected' : 'accepted', field });
  s.diagnostics = s.diagnostics.slice(-48);
}
function enqueue(
  s: TelegramState,
  authority: TelegramAuthority,
  content: string,
  kind: TelegramOutbox['kind'] = 'control',
  sourceId: string | null = null,
): TelegramOutbox {
  // Evict terminal receipts only. Live work is never silently replaced.
  if (s.outbox.length >= 256) s.outbox = s.outbox.filter((item) => !['sent', 'discarded'].includes(item.status));
  if (s.outbox.length >= 1024) throw new Error('telegram.outboxFull');
  const item: TelegramOutbox = {
    id: randomUUID(),
    authority: bare(authority),
    content,
    kind,
    sourceId,
    digest: hash(content),
    approved: false,
    approvalId: null,
    status: 'pending',
    sentChars: 0,
    error: null,
    retryAt: null,
    attempts: 0,
    buttons: null,
  };
  s.outbox.push(item);
  return item;
}
function resultReference(item: TelegramOutbox): string {
  const source = item.sourceId ?? '';
  const short = /^[a-f0-9]{8}-/iu.test(source) ? source.slice(0, 8) : hash(source).slice(0, 8);
  return (item.kind === 'cron' ? 'CRON' : 'REPLY') + ' ' + short + ' · SHA-256 ' + item.digest.slice(0, 12);
}
function waitForDisclosure(s: TelegramState, item: TelegramOutbox): void {
  const id = randomUUID();
  item.status = 'approval';
  item.approvalId = id;
  s.approvals.push({
    id,
    authority: item.authority,
    kind: 'disclose',
    runId: null,
    outboxId: item.id,
    digest: item.digest,
    // Offline time is not owner decision time. Start the clock just before the card is posted.
    expiresAt: 0,
  });
  const prompt = enqueue(
    s,
    item.authority,
    '桌宠有一份结果包含受保护资料。请在桌面 Telegram 设置按此编号核对原文：\n' +
      resultReference(item) +
      '\n允许将这一次的完整结果发送到当前私聊吗？',
  );
  prompt.buttons = { id };
}
function discard(s: TelegramState): void {
  if (
    s.inbox.length ||
    s.approvals.length ||
    s.outbox.some((item) => ['pending', 'approval', 'failed', 'sending'].includes(item.status))
  ) {
    diagnostic(s, 'authority', 'work.revoked');
  }
  s.inbox = [];
  s.approvals = [];
  s.pairing = null;
  s.candidate = null;
  for (const item of s.outbox) {
    if (item.status === 'sending') item.status = 'unknown';
    else if (['approval', 'pending', 'failed'].includes(item.status)) item.status = 'discarded';
  }
}
function cronStillRunning(item: TelegramOutbox, error: unknown): boolean {
  return (item.kind === 'cron' || !!item.buttons) && error instanceof Error && error.message === 'telegram.cronPending';
}
function discardCardSource(s: TelegramState, card: TelegramOutbox): void {
  if (!card.buttons) return;
  const grant = s.approvals.find((a) => a.id === card.buttons!.id && a.kind === 'disclose' && a.outboxId !== null);
  if (!grant) return;
  s.approvals = s.approvals.filter((a) => a.id !== grant.id);
  const result = s.outbox.find((o) => o.id === grant.outboxId && o.approvalId === grant.id && o.status === 'approval');
  if (result) {
    result.status = 'discarded';
    result.error = 'telegram.deliveryNotAuthorized';
  }
}
function nextPart(text: string, offset: number): string {
  let end = Math.min(text.length, offset + 4096);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return text.slice(offset, end);
}

export class TelegramChannelService {
  readonly #deps: Deps;
  readonly #store: TelegramChannelStore;
  readonly #api: TelegramApi;
  #connection: TelegramChannelStatus['connection'] = 'disabled';
  #error: string | null = null;
  #secret: string | null = null;
  #storageReady = false;
  #verified = false;
  #epoch = 0;
  #enabled = false;
  #generation = new AbortController();
  #managing: Promise<unknown> = Promise.resolve();
  #managementPending = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #retryPoll: AbortController | null = null;
  #running: { runId: string; controller: AbortController; authority: TelegramAuthority } | null = null;
  #runPump = false;
  #outPump = false;
  #waiters = new Map<string, (approved: boolean) => void>();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#store = deps.store;
    this.#api = deps.api ?? new TelegramBotApi();
  }
  async initialize({ deferConnection = false } = {}): Promise<void> {
    try {
      await this.#store.initialize();
      this.#storageReady = true;
    } catch {
      this.#storageReady = false;
      this.#connection = 'offline';
      this.#error = 'telegram.storageUnavailable';
      return;
    }
    const profileId = this.#deps.profileId();
    if (this.#store.snapshot().profileId === null) return;
    await this.#store.update((s) => {
      if (s.profileId !== profileId) {
        Object.assign(s, defaultTelegramState(), { profileId });
        return;
      }
      s.candidate = null;
      s.pairing = null;
      for (const out of s.outbox)
        if (out.status === 'sending') {
          out.status = 'unknown';
          out.error = 'telegram.sendUnknown';
        }
      for (const entry of s.inbox.filter((i) => i.status !== 'queued')) {
        if (same(s.binding, entry.authority))
          enqueue(s, entry.authority, '上次运行因重启中断，可能已完成部分操作。请先查看桌面记录，再决定是否重新发送。');
      }
      s.inbox = s.inbox.filter((i) => i.status === 'queued');
      // A workspace decision cannot survive the waiting host invocation.
      s.approvals = s.approvals.filter((a) => a.kind === 'disclose' && a.outboxId !== null);
    });
    if (!deferConnection) await this.startConnection();
  }

  async startConnection(): Promise<void> {
    if (this.#storageReady && this.#store.snapshot().profileId !== null) await this.#start(this.#epoch);
  }

  async followModel(expected: { providerId: string; model: string }): Promise<boolean> {
    if (!this.#storageReady) return false;
    const changed = await this.#store.update(draft => {
      if (draft.profileId !== this.#deps.profileId() || draft.providerId !== expected.providerId || draft.model !== expected.model) return false;
      draft.model = null;
      return true;
    });
    if (changed) this.#changed();
    return changed;
  }

  #changed(): void {
    this.#deps.onChanged?.();
  }
  #manage<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#storageReady) return Promise.reject(new Error('telegram.storageUnavailable'));
    this.#managementPending++;
    const task = this.#managing.then(fn, fn).finally(() => {
      this.#managementPending--;
    });
    this.#managing = task.catch(() => undefined);
    return task;
  }
  #invalidate(): number {
    this.#enabled = false;
    this.#verified = false;
    this.#generation.abort();
    this.#generation = new AbortController();
    this.#retryPoll = null;
    this.#secret = null;
    this.#running?.controller.abort();
    this.#connection = 'disabled';
    this.#error = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const resolve of this.#waiters.values()) resolve(false);
    this.#waiters.clear();
    return ++this.#epoch;
  }
  dispose(): void {
    this.#invalidate();
  }
  async #start(epoch: number): Promise<void> {
    const s = this.#store.snapshot();
    if (epoch !== this.#epoch || !s.enabled || !s.tokenConfigured || s.profileId !== this.#deps.profileId()) return;
    let secret: string | null = null;
    try {
      secret = await this.#deps.getSecret();
    } catch {
      if (epoch === this.#epoch) {
        this.#connection = 'offline';
        this.#error = 'telegram.credentialUnavailable';
      }
      return;
    }
    if (epoch !== this.#epoch) return;
    if (!secret) {
      this.#connection = 'offline';
      this.#error = 'telegram.credentialUnavailable';
      return;
    }
    this.#secret = secret;
    this.#enabled = true;
    this.#connection = 'connecting';
    this.#timer = setInterval(() => this.#tick(), 1000);
    this.#timer.unref();
    void this.#pollLoop(epoch, secret, this.#generation.signal);
  }
  #live(epoch: number): boolean {
    return this.#enabled && this.#epoch === epoch && this.#store.snapshot().profileId === this.#deps.profileId();
  }
  currentAuthority(): TelegramAuthority | null {
    if (!this.#storageReady) return null;
    const s = this.#store.snapshot();
    return this.#enabled && s.enabled && s.profileId === this.#deps.profileId() && s.binding ? bare(s.binding) : null;
  }
  assertAuthorized(authority: TelegramAuthority): void {
    if (!same(this.currentAuthority(), authority)) throw new Error('telegram.authorityRevoked');
  }
  status(): TelegramChannelStatus {
    const s = this.#storageReady ? this.#store.snapshot() : defaultTelegramState();
    return {
      enabled: s.enabled,
      bound: !!s.binding,
      bindingId: s.binding?.bindingId ?? null,
      bindingDisplayName: s.binding?.displayName ?? null,
      bindingSessionId: s.binding?.sessionId ?? null,
      secretConfigured: s.tokenConfigured,
      providerId: s.providerId,
      model: s.model,
      memoryAllowed: s.memoryAllowed,
      connection: this.#connection,
      lastError: this.#error,
      pairingCandidate: s.candidate && Date.parse(s.candidate.expiresAt) > Date.now() ? s.candidate : null,
      diagnostics: s.diagnostics,
      pendingInbox: s.inbox.length,
      pendingOutbox: s.outbox.filter((i) => ['pending', 'approval', 'sending', 'failed'].includes(i.status)).length,
      uncertainOutbox: s.outbox.filter((i) => i.status === 'unknown').length,
    };
  }
  async configure(patch: Omit<TelegramConfigureInput, 'token'>): Promise<TelegramChannelStatus> {
    if (!this.#storageReady) throw new Error('telegram.storageUnavailable');
    const current = this.#store.snapshot();
    // Saving the existing form should not discard a pending reply.
    if (
      this.#managementPending === 0 &&
      (Object.keys(patch) as Array<keyof typeof patch>).every((key) => patch[key] === undefined || patch[key] === current[key]) &&
      this.#connection !== 'offline'
    )
      return this.status();
    const epoch = this.#invalidate();
    return this.#manage(async () => {
      await this.#store.update((s) => {
        s.profileId = this.#deps.profileId();
        discard(s);
        if (patch.enabled !== undefined) s.enabled = patch.enabled;
        if (patch.providerId !== undefined && patch.providerId !== s.providerId) {
          s.providerId = patch.providerId;
          if (patch.model === undefined) s.model = null;
        }
        if (patch.model !== undefined) s.model = patch.model;
        if (patch.memoryAllowed !== undefined) s.memoryAllowed = patch.memoryAllowed;
      });
      await this.#start(epoch);
      this.#changed();
      return this.status();
    });
  }
  async credentialsChanged(write: () => Promise<void>): Promise<TelegramChannelStatus> {
    const epoch = this.#invalidate();
    return this.#manage(async () => {
      await this.#store.update((s) => {
        s.profileId = this.#deps.profileId();
        discard(s);
        s.tokenConfigured = false;
        s.enabled = false;
        s.binding = null;
        s.botId = null;
        s.offset = null;
        s.lastUpdateAt = null;
        s.memoryAllowed = false;
      });
      await write();
      const configured = !!(await this.#deps.getSecret());
      await this.#store.update((s) => {
        s.tokenConfigured = configured;
      });
      await this.#start(epoch);
      this.#changed();
      return this.status();
    });
  }
  async unbind(): Promise<TelegramChannelStatus> {
    const epoch = this.#invalidate();
    return this.#manage(async () => {
      await this.#store.update((s) => {
        discard(s);
        s.binding = null;
        s.memoryAllowed = false;
        s.enabled = false;
      });
      await this.#start(epoch);
      this.#changed();
      return this.status();
    });
  }
  startPairing(): Promise<{ code: string; expiresAt: string }> {
    const epoch = this.#epoch;
    return this.#manage(async () => {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0'),
        expiresAt = new Date(expires()).toISOString();
      await this.#store.update((s) => {
        if (!this.#live(epoch) || s.binding) throw new Error('telegram.pairingUnavailable');
        s.candidate = null;
        s.pairing = { hash: hash(code), expiresAt, attempts: 0 };
      });
      this.#changed();
      return { code, expiresAt };
    });
  }
  confirmPairing(candidateId: string): Promise<TelegramChannelStatus> {
    const epoch = this.#epoch;
    return this.#manage(async () => {
      const candidate = this.#store.snapshot().candidate;
      if (!this.#live(epoch) || !candidate || candidate.id !== candidateId || Date.parse(candidate.expiresAt) <= Date.now())
        throw new Error('telegram.pairingExpired');
      const bindingId = randomUUID(),
        session = await this.#deps.host.createBindingSession(bindingId);
      await this.#store.update((s) => {
        if (!this.#live(epoch) || s.binding || s.candidate?.id !== candidateId || Date.parse(candidate.expiresAt) <= Date.now())
          throw new Error('telegram.pairingExpired');
        s.binding = {
          bindingId,
          sessionId: session.sessionId,
          userId: candidate.userId,
          chatId: candidate.chatId,
          displayName: candidate.displayName,
        };
        s.candidate = null;
        s.pairing = null;
        s.memoryAllowed = false;
        enqueue(s, s.binding, '桌面已确认配对。可以发送任务；/stop 只停止当前运行。');
      });
      this.#tick();
      this.#changed();
      return this.status();
    });
  }
  canReconnect(): boolean {
    return this.#managementPending === 0 && this.#connection === 'offline' &&
      this.#live(this.#epoch) && this.#retryPoll !== null;
  }
  reconnect(): boolean {
    if (!this.canReconnect()) return false;
    this.#retryPoll?.abort();
    return true;
  }
  async #pollLoop(epoch: number, token: string, signal: AbortSignal): Promise<void> {
    let verified = false,
      backoff = 300;
    while (this.#live(epoch)) {
      try {
        if (!verified) {
          const botId = await this.#api.getMe(token, signal);
          if (!this.#live(epoch)) return;
          if (this.#store.snapshot().botId !== botId)
            await this.#store.update((s) => {
              if (!this.#live(epoch)) return;
              if (s.botId !== null) {
                discard(s);
                s.binding = null;
                s.memoryAllowed = false;
                s.offset = null;
                s.lastUpdateAt = null;
              }
              s.botId = botId;
            });
          verified = true;
          this.#verified = this.#live(epoch);
        }
        if (!this.#live(epoch)) return;
        const state = this.#store.snapshot(),
          offset = state.lastUpdateAt !== null && Date.now() - state.lastUpdateAt < week ? state.offset : null;
        const batch = await this.#api.poll(token, offset, signal);
        if (!this.#live(epoch)) return;
        this.#connection = 'online';
        this.#error = null;
        backoff = 300;
        for (const update of batch) {
          if (!this.#live(epoch)) return;
          await this.#receive(update, epoch, token, signal);
        }
        this.#tick();
        this.#changed();
        if (!batch.length) await delay(150, undefined, { signal });
      } catch (error) {
        if (!this.#live(epoch)) return;
        this.#connection = 'offline';
        this.#error = safeError(error);
        this.#changed();
        if (error instanceof TelegramApiError && error.code === 'telegram.invalidUpdateId') {
          await this.#store.update((s) => diagnostic(s, 'update', 'update_id')).catch(() => undefined);
        }
        const wait = Math.max(backoff, error instanceof TelegramApiError ? error.retryAfterMs : 0);
        const retry = new AbortController();
        // Do not shorten a server-imposed wait, or retry an authentication, storage or input fault here.
        if (this.#error === 'telegram.network' || this.#error === 'telegram.timeout' || /^telegram\.http5[0-9]{2}$/u.test(this.#error)) {
          if (!(error instanceof TelegramApiError) || error.retryAfterMs === 0) this.#retryPoll = retry;
        }
        await delay(wait, undefined, { signal: AbortSignal.any([signal, retry.signal]) }).catch(() => undefined);
        if (this.#retryPoll === retry) this.#retryPoll = null;
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }
  async #receive(update: TelegramUpdate, epoch: number, token: string, signal: AbortSignal): Promise<void> {
    const after: Array<() => void> = [];
    await this.#store.update((s) => {
      if (!this.#live(epoch)) return;
      if (s.offset !== null && s.lastUpdateAt !== null && Date.now() - s.lastUpdateAt < week && update.updateId < s.offset)
        return;
      s.offset = update.updateId + 1;
      s.lastUpdateAt = Date.now();
      if (update.kind === 'rejected') {
        diagnostic(s, update.type, update.field);
        return;
      }
      if (update.kind === 'callback') {
        after.push(() => {
          void this.#api.answer(token, update.queryId, signal).catch(() => undefined);
        });
        if (!s.binding || s.binding.userId !== update.userId || s.binding.chatId !== update.chatId) {
          diagnostic(s, 'callback_query', 'binding.owner');
          return;
        }
        const match = /^(yes|no):([a-f0-9-]{36})$/u.exec(update.data);
        const approval = match ? s.approvals.find((a) => a.id === match[2]) : undefined;
        if (!approval || !same(s.binding, approval.authority) || approval.expiresAt <= Date.now()) {
          diagnostic(s, 'callback_query', 'approval.id');
          return;
        }
        const allowed = match![1] === 'yes';
        s.approvals = s.approvals.filter((a) => a.id !== approval.id);
        if (approval.outboxId) {
          const out = s.outbox.find((item) => item.id === approval.outboxId);
          if (
            !out ||
            out.status !== 'approval' ||
            out.approvalId !== approval.id ||
            out.digest !== approval.digest ||
            hash(out.content) !== out.digest ||
            !same(s.binding, out.authority)
          ) {
            diagnostic(s, 'callback_query', 'approval.result');
            return;
          }
          out.approved = allowed;
          out.status = allowed ? 'pending' : 'discarded';
        } else {
          const resume = this.#waiters.get(approval.id);
          if (!resume) {
            diagnostic(s, 'callback_query', 'approval.expired');
            return;
          }
          after.push(() => resume(allowed));
        }
        diagnostic(s, 'callback_query');
        return;
      }
      if (!s.binding) {
        if (!s.pairing || Date.parse(s.pairing.expiresAt) <= Date.now()) {
          diagnostic(s, 'message', 'pairing.inactive');
          return;
        }
        const command = /^\/pair\s+(\d{6})$/u.exec(update.text.trim());
        if (!command) {
          diagnostic(s, 'message', 'pairing.format');
          return;
        }
        if (hash(command[1]!) !== s.pairing.hash) {
          if (++s.pairing.attempts >= 5) s.pairing = null;
          diagnostic(s, 'message', 'pairing.code');
          return;
        }
        s.candidate = {
          id: randomUUID(),
          userId: update.userId,
          chatId: update.chatId,
          displayName: update.name,
          expiresAt: s.pairing.expiresAt,
        };
        s.pairing = null;
        diagnostic(s, 'pairing');
        return;
      }
      const authority = bare(s.binding);
      if (s.binding.userId !== update.userId || s.binding.chatId !== update.chatId) {
        diagnostic(s, 'message', 'binding.owner');
        return;
      }
      if (update.text.trim() === '/stop') {
        const active = this.#running;
        const isActive = active && same(authority, active.authority);
        if (isActive)
          after.push(() => {
            active.controller.abort();
            this.#deps.host.cancel?.(active.runId, authority);
          });
        enqueue(s, authority, isActive ? '已请求停止当前运行；排队消息保留。' : '当前没有正在运行的任务。');
        diagnostic(s, 'stop');
        return;
      }
      const command = this.#deps.host.chatCommand ? parseChatCommand(update.text) : null;
      if (command) {
        after.push(() => {
          void this.#command(command, authority, epoch).catch(() => undefined);
        });
        diagnostic(s, 'command');
        return;
      }
      const append = /^\/append(?:\s+([\s\S]+))?$/u.exec(update.text.trim());
      if (append && !append[1]) {
        enqueue(s, authority, '用法：/append 补充内容');
        diagnostic(s, 'append', 'message.text');
        return;
      }
      if (s.inbox.length >= 128) {
        enqueue(s, authority, '待处理消息已满，本条未执行；请稍后重发。');
        diagnostic(s, 'message', 'inbox.full');
        return;
      }
      const entry = { runId: randomUUID(), text: append?.[1] ?? update.text, authority, status: 'queued' as const,
        ...(update.noteIntentAllowed ? { noteIntentAllowed: true as const } : {}) };
      const active = this.#running;
      if (append && active && !active.controller.signal.aborted && this.#deps.host.append && same(authority, active.authority)) {
        s.inbox.push({ ...entry, status: 'appending' });
        after.push(() => {
          void this.#append(entry, active, epoch).catch(() => undefined);
        });
      } else {
        s.inbox.push(entry);
        if (active || s.inbox.length > 1) enqueue(s, authority, '本条已加入队列，当前任务结束后处理。');
      }
      diagnostic(s, append ? 'append' : 'message');
    });
    if (!this.#live(epoch)) return;
    for (const action of after) action();
    this.#tick();
    this.#changed();
  }
  /** A switch from the phone keeps the connection, the pairing and anything queued. */
  async #command(command: ChatCommand, authority: TelegramAuthority, epoch: number): Promise<void> {
    const content = await this.#deps.host.chatCommand!(command, {
      key: 'telegram',
      locale: 'zh-CN',
      selection: () => {
        const { providerId, model } = this.#store.snapshot();
        return { providerId, model };
      },
      select: async (providerId, model) => {
        await this.#store.update((s) => {
          if (!this.#live(epoch) || !same(s.binding, authority)) throw new Error('telegram.authorityRevoked');
          s.providerId = providerId;
          s.model = model;
        });
      },
    });
    await this.#store.update((s) => {
      if (this.#live(epoch) && same(s.binding, authority)) enqueue(s, authority, content);
    });
    this.#tick();
    this.#changed();
  }
  #runInput(entry: TelegramState['inbox'][number], runId: string, signal: AbortSignal): TelegramRunInput {
    const state = this.#store.snapshot();
    return {
      ...entry.authority,
      runId,
      text: entry.text,
      ...(entry.noteIntentAllowed ? { noteIntentAllowed: true as const } : {}),
      signal,
      model: state.model,
      providerId: state.providerId,
      memoryAllowed: state.memoryAllowed,
    };
  }
  async #append(
    entry: TelegramState['inbox'][number],
    active: { runId: string; controller: AbortController },
    epoch: number,
  ): Promise<void> {
    let applied: boolean | null = null;
    try {
      this.assertAuthorized(entry.authority);
      applied = await this.#deps.host.append!({
        ...this.#runInput(entry, active.runId, active.controller.signal),
        operationId: entry.runId,
      });
    } catch {
      /* A thrown operation may already have been applied. */
    }
    await this.#store.update((s) => {
      const item = s.inbox.find((i) => i.runId === entry.runId);
      if (!item || !this.#live(epoch) || !same(s.binding, entry.authority)) return;
      if (applied === false) item.status = 'queued';
      else s.inbox = s.inbox.filter((i) => i.runId !== entry.runId);
      enqueue(
        s,
        entry.authority,
        applied === true
          ? '已追加到当前运行。'
          : applied === false
            ? '当前运行已结束；补充内容已排队。'
            : '追加结果不确定；请查看桌面记录。',
      );
    });
    this.#tick();
  }
  #tick(): void {
    if (!this.#enabled || !this.#verified) return;
    if (!this.#runPump && this.#store.hasInboxWork) {
      this.#runPump = true;
      void this.#drainInbox(this.#epoch)
        .catch(() => {
          this.#error = 'telegram.inboxFailed';
        })
        .finally(() => {
          this.#runPump = false;
        });
    }
    if (!this.#outPump && this.#connection === 'online' && this.#store.hasOutboxWork) {
      this.#outPump = true;
      void this.#drainOutbox(this.#epoch)
        .catch(() => {
          this.#error = 'telegram.outboxFailed';
        })
        .finally(() => {
          this.#outPump = false;
        });
    }
  }
  async #drainInbox(epoch: number): Promise<void> {
    while (this.#live(epoch)) {
      const queued = this.#store.snapshot().inbox.find((i) => i.status === 'queued');
      if (!queued) return;
      this.assertAuthorized(queued.authority);
      const controller = new AbortController(),
        signal = AbortSignal.any([controller.signal, this.#generation.signal]);
      this.#running = { runId: queued.runId, authority: queued.authority, controller };
      try {
        await this.#store.update((s) => {
          const entry = s.inbox.find((i) => i.runId === queued.runId);
          if (!this.#live(epoch) || !entry || entry.status !== 'queued') throw new Error('telegram.cancelled');
          entry.status = 'running';
        });
        this.assertAuthorized(queued.authority);
        signal.throwIfAborted();
        const result = await this.#deps.host.runMessage(this.#runInput(queued, queued.runId, signal));
        await this.#store.update((s) => {
          if (!this.#live(epoch) || !same(s.binding, queued.authority)) return;
          s.inbox = s.inbox.filter((i) => i.runId !== queued.runId);
          if (signal.aborted) return;
          if (!result.content.trim() || !result.sourceId) {
            enqueue(s, queued.authority, '本轮没有可投递的结果，请在桌面查看。');
            return;
          }
          const item = enqueue(s, queued.authority, result.content, 'reply', result.sourceId);
          if (result.requiresApproval) waitForDisclosure(s, item);
        });
      } catch {
        await this.#store.update((s) => {
          if (!this.#live(epoch) || !same(s.binding, queued.authority)) return;
          s.inbox = s.inbox.filter((i) => i.runId !== queued.runId);
          if (!signal.aborted) enqueue(s, queued.authority, '任务未能完成。请在桌面查看运行记录。');
        });
      } finally {
        this.#running = null;
        controller.abort();
      }
      this.#tick();
      this.#changed();
    }
  }
  #checkDelivery(item: TelegramOutbox): void {
    this.assertAuthorized(item.authority);
    if (hash(item.content) !== item.digest) throw new Error('telegram.resultChanged');
    if (item.kind !== 'control') {
      if (!item.sourceId) throw new Error('telegram.missingSource');
      this.#deps.host.assertDelivery({
        ...item.authority,
        kind: item.kind,
        content: item.content,
        sourceId: item.sourceId,
        digest: item.digest,
        approved: item.approved,
      });
    } else if (item.buttons) {
      const snapshot = this.#store.snapshot();
      const grant = snapshot.approvals.find((a) => a.id === item.buttons!.id);
      if (!grant || !same(grant.authority, item.authority) || (grant.expiresAt !== 0 && grant.expiresAt <= Date.now()))
        throw new Error('telegram.approvalExpired');
      if (grant.kind === 'disclose') {
        // The card itself discloses the source and a content fingerprint. A revoked
        // cron subscription or invalid source must suppress the card as well as its subsequent result.
        const result = snapshot.outbox.find((o) => o.id === grant.outboxId);
        if (
          !result ||
          result.kind === 'control' ||
          result.status !== 'approval' ||
          result.approvalId !== grant.id ||
          result.digest !== grant.digest ||
          !same(result.authority, item.authority)
        )
          throw new Error('telegram.disclosureBlocked');
        this.#checkDelivery({ ...result, approved: true });
      }
    }
  }
  async #drainOutbox(epoch: number): Promise<void> {
    const secret = this.#secret;
    if (!secret) return;
    while (this.#live(epoch) && this.#connection === 'online') {
      const snapshot = this.#store.snapshot();
      if (snapshot.approvals.some((a) => a.outboxId !== null && a.expiresAt > 0 && a.expiresAt <= Date.now())) {
        await this.#store.update((s) => {
          const expired = s.approvals.filter((a) => a.outboxId !== null && a.expiresAt > 0 && a.expiresAt <= Date.now());
          const ids = new Set(expired.map((a) => a.id));
          for (const a of expired) {
            const out = s.outbox.find((o) => o.id === a.outboxId);
            if (out?.status === 'approval') {
              out.status = 'discarded';
              out.error = 'telegram.approvalExpired';
            }
            if (same(s.binding, a.authority)) enqueue(s, a.authority, '发送结果的批准已过期。完整结果保留在桌面。');
          }
          s.approvals = s.approvals.filter((a) => !ids.has(a.id));
        });
        continue;
      }
      const item = snapshot.outbox.find((o) => o.status === 'pending' && (o.retryAt ?? 0) <= Date.now());
      if (!item) return;
      let marked = false;
      await this.#store.update((s) => {
        const current = s.outbox.find((i) => i.id === item.id);
        if (!current || current.status !== 'pending' || !this.#live(epoch) || this.#connection !== 'online') return;
        try {
          this.#checkDelivery(current);
        } catch (error) {
          if (cronStillRunning(current, error)) {
            current.retryAt = Date.now() + 1000;
            return;
          }
          current.status = 'discarded';
          current.error = 'telegram.deliveryNotAuthorized';
          discardCardSource(s, current);
          diagnostic(s, 'outbox', 'delivery.authority');
          return;
        }
        if (current.buttons) {
          const request = s.approvals.find((a) => a.id === current.buttons!.id);
          if (request && request.expiresAt === 0) request.expiresAt = expires();
        }
        current.status = 'sending';
        current.attempts++;
        marked = true;
      });
      if (!marked) continue;
      const part = nextPart(item.content, item.sentChars);
      let outcome: 'sent' | 'pending' | 'unknown' | 'failed' | 'discarded' = 'sent',
        retryAt: number | null = null,
        errorCode: string | null = null;
      try {
        this.#checkDelivery(item);
      } catch (error) {
        if (cronStillRunning(item, error)) {
          outcome = 'pending';
          retryAt = Date.now() + 1000;
        } else {
          outcome = 'discarded';
          errorCode = 'telegram.deliveryNotAuthorized';
        }
      }
      if (outcome === 'sent') {
        if (!this.#live(epoch) || this.#connection !== 'online') outcome = 'pending';
        else
          try {
            await this.#api.send(secret, item.authority.chatId, part, item.buttons, this.#generation.signal);
          } catch (error) {
            errorCode = safeError(error);
            if (error instanceof TelegramApiError && error.definitive) {
              if (error.code === 'telegram.http429') {
                outcome = 'pending';
                retryAt = Date.now() + (error.retryAfterMs || 1000);
              } else outcome = 'failed';
            } else outcome = 'unknown';
          }
      }
      await this.#store.update((s) => {
        const current = s.outbox.find((o) => o.id === item.id);
        if (!current || current.status !== 'sending') return;
        if (outcome === 'discarded') discardCardSource(s, current);
        current.status = outcome;
        current.error = errorCode;
        current.retryAt = retryAt;
        if (current.buttons && (outcome === 'pending' || outcome === 'failed')) {
          // A definitive failure left no usable card on the phone.
          const request = s.approvals.find((a) => a.id === current.buttons!.id && a.outboxId !== null);
          if (request) request.expiresAt = 0;
        }
        if (outcome === 'sent') {
          current.sentChars += part.length;
          if (current.sentChars < current.content.length) current.status = 'pending';
        }
        if (outcome === 'unknown') diagnostic(s, 'outbox', 'send.unconfirmed');
      });
      this.#changed();
    }
  }
  pendingResults(): TelegramPendingResult[] {
    const authority = this.currentAuthority();
    if (!authority) return [];
    const s = this.#store.snapshot(),
      now = Date.now();
    const valid = new Map(
      s.approvals
        .filter((a) => a.outboxId && same(authority, a.authority) && (!a.expiresAt || a.expiresAt > now))
        .map((a) => [a.id, a]),
    );
    return s.outbox.flatMap((item) => {
      const approval = item.approvalId ? valid.get(item.approvalId) : null;
      if (
        item.status !== 'approval' ||
        item.kind === 'control' ||
        !same(authority, item.authority) ||
        !item.sourceId ||
        approval?.outboxId !== item.id ||
        approval.digest !== item.digest ||
        hash(item.content) !== item.digest
      )
        return [];
      // Inspect against the exact live source. This projection neither approves
      // nor queues a delivery; only the owner's callback can mutate that state.
      try {
        this.#checkDelivery({ ...item, approved: true });
      } catch {
        return [];
      }
      return [
        {
          id: item.id,
          reference: resultReference(item),
          kind: item.kind,
          sourceId: item.sourceId,
          digest: item.digest,
          content: item.content,
        },
      ];
    });
  }
  async retryDeliveries(): Promise<TelegramChannelStatus> {
    const epoch = this.#epoch;
    await this.#store.update((s) => {
      if (!this.#live(epoch)) return;
      for (const out of s.outbox)
        if (out.status === 'failed' && same(s.binding, out.authority)) {
          out.status = 'pending';
          out.retryAt = null;
        }
    });
    this.#tick();
    return this.status();
  }
  async requestApproval(input: {
    sessionId: string;
    kind: 'workspace';
    preview: string;
    signal: AbortSignal;
    runId?: string;
  }): Promise<boolean> {
    const authority = this.currentAuthority(),
      active = this.#running;
    if (
      !authority ||
      authority.sessionId !== input.sessionId ||
      !active ||
      (input.runId && input.runId !== active.runId) ||
      !same(authority, active.authority) ||
      input.signal.aborted
    )
      return false;
    const epoch = this.#epoch;
    const prompt = '允许这一次工作区操作？\n' + input.preview;
    if (prompt.length > 4096) {
      await this.#store.update((s) => {
        if (!this.#live(epoch) || !same(s.binding, authority)) return;
        enqueue(s, authority, '这项操作的完整参数无法在手机上展示，本次已拒绝。请在桌面检查。');
      });
      this.#tick();
      return false;
    }
    const id = randomUUID(),
      deadline = expires();
    const signal = AbortSignal.any([
      input.signal,
      this.#generation.signal,
      active.controller.signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    let resolve!: (approved: boolean) => void;
    const decision = new Promise<boolean>((done) => {
      resolve = done;
    });
    const abort = () => resolve(false);
    this.#waiters.set(id, resolve);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.#store.update((s) => {
        if (signal.aborted || !this.#live(epoch) || !same(s.binding, authority)) throw new Error('telegram.cancelled');
        s.approvals.push({
          id,
          kind: input.kind,
          authority,
          runId: active.runId,
          outboxId: null,
          digest: null,
          expiresAt: deadline,
        });
        enqueue(s, authority, prompt).buttons = { id };
      });
      this.#tick();
      if (signal.aborted) return false;
      return (await decision) && !signal.aborted && this.#live(epoch) && same(this.currentAuthority(), authority);
    } catch {
      return false;
    } finally {
      signal.removeEventListener('abort', abort);
      this.#waiters.delete(id);
      await this.#store.update((s) => {
        s.approvals = s.approvals.filter((a) => a.id !== id);
      });
    }
  }
  async enqueueCron(input: {
    sessionId: string;
    bindingId: string;
    sourceId: string;
    content: string;
    requiresApproval?: boolean;
  }): Promise<void> {
    const authority = this.currentAuthority();
    if (
      !authority ||
      authority.bindingId !== input.bindingId ||
      authority.sessionId !== input.sessionId ||
      !input.sourceId ||
      !input.content.trim()
    )
      throw new Error('telegram.cronUnbound');
    const epoch = this.#epoch;
    await this.#store.update((s) => {
      if (!this.#live(epoch) || !same(s.binding, authority)) throw new Error('telegram.cronUnbound');
      if (s.outbox.some((i) => i.kind === 'cron' && i.sourceId === input.sourceId && same(i.authority, authority))) return;
      const item = enqueue(s, authority, input.content, 'cron', input.sourceId);
      if (input.requiresApproval) waitForDisclosure(s, item);
    });
    this.#tick();
    this.#changed();
  }
}
